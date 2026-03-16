// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  AchSwapGasless v4
 *
 * What's new vs v3
 * ────────────────
 * - WETH address added as immutable constructor arg.
 * - V3 single-hop + multi-hop: if tokenOut == WETH, contract receives WETH,
 *   calls WETH.withdraw(), pushes native to user automatically.
 *   Frontend passes nothing extra — just use WETH address as tokenOut.
 * - V2 native output: swapV2 detects tokenOut == WETH and calls
 *   swapExactTokensForETH instead of swapExactTokensForTokens.
 *   V2 router unwraps natively so no manual withdraw needed.
 * - receive() now accepts ETH (needed for WETH.withdraw() callback).
 *
 * Constructor args
 * ────────────────
 * _v2Router  — AchSwap V2 router address
 * _v3Router  — AchSwap V3 router address
 * _weth      — Wrapped native token address on Arc Testnet
 *
 * Frontend behaviour
 * ──────────────────
 * User selects native token as output → frontend maps to WETH address.
 * Pass WETH address as tokenOut. Contract handles unwrap automatically.
 * No extra params, no extra signatures.
 *
 * One-time user setup per token (pays gas once, all swaps gasless after)
 * ───────────────────────────────────────────────────────────────────────
 * 1. token.approve(PERMIT2_ADDRESS, MaxUint256)
 * 2. permit2.approve(token, THIS_CONTRACT, MaxUint256, uint48(expiry))
 */

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

// ── Interfaces ────────────────────────────────────────────────────────────────

interface IPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IWETH {
    function withdraw(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    // used when tokenOut is native (last token in path must be WETH)
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    struct ExactInputParams {
        bytes   path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params)
        external payable returns (uint256 amountOut);
}

// ── Contract ──────────────────────────────────────────────────────────────────

contract AchSwapGasless is EIP712, Ownable, ReentrancyGuard, Pausable {
    using ECDSA     for bytes32;
    using SafeERC20 for IERC20;

    // ── ForwardRequest ─────────────────────────────────────────────────────────

    struct ForwardRequest {
        address from;
        uint256 nonce;
        uint256 gas;
        bytes   data;
    }

    bytes32 private constant _TYPEHASH = keccak256(
        "ForwardRequest(address from,uint256 nonce,uint256 gas,bytes data)"
    );

    mapping(address => uint256) private _nonces;

    // ── Immutables ─────────────────────────────────────────────────────────────

    IPermit2 public constant PERMIT2 =
        IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    IUniswapV2Router public immutable V2_ROUTER;
    IUniswapV3Router public immutable V3_ROUTER;
    address          public immutable WETH;

    // ── Batch types ────────────────────────────────────────────────────────────

    enum SwapKind { V2, V3Single, V3Multi }

    struct SwapCall {
        SwapKind kind;
        bytes    data;
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    event SwapV2Executed(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event SwapV3Executed(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event MetaTxExecuted(address indexed from, uint256 nonce);
    event BatchResult(uint256 indexed index, address indexed from, bool success, bytes reason);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error InvalidSignature();
    error InvalidNonce();
    error InvalidPath();
    error ZeroAmount();
    error DeadlineExpired();
    error InsufficientGas();
    error DirectCallNotAllowed();
    error ExecutionFailed(bytes reason);
    error BatchLengthMismatch();
    error InvalidSwapKind();
    error InvalidFeeTier();
    error NativeTransferFailed();

    // ── Constructor ────────────────────────────────────────────────────────────

    /// @param _v2Router  AchSwap V2 router
    /// @param _v3Router  AchSwap V3 router
    /// @param _weth      Wrapped native token on Arc Testnet
    constructor(address _v2Router, address _v3Router, address _weth)
        EIP712("AchSwapGasless", "1")
        Ownable(msg.sender)
    {
        require(
            _v2Router != address(0) &&
            _v3Router != address(0) &&
            _weth     != address(0),
            "zero address"
        );
        V2_ROUTER = IUniswapV2Router(_v2Router);
        V3_ROUTER = IUniswapV3Router(_v3Router);
        WETH      = _weth;
    }

    // ── ERC-2771 ───────────────────────────────────────────────────────────────

    function _msgSender() internal view override returns (address sender) {
        if (msg.sender == address(this) && msg.data.length >= 20) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    // ── Nonce ──────────────────────────────────────────────────────────────────

    function getNonce(address from) external view returns (uint256) {
        return _nonces[from];
    }

    // ── execute() ─────────────────────────────────────────────────────────────

    /// @notice Relayer entry point — single meta-tx.
    ///         nonReentrant is here only. Swap functions intentionally omit it
    ///         because they are only reachable through this self-call.
    function execute(
        ForwardRequest calldata req,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (bytes memory returndata) {
        _verifyAndIncrement(req, signature);

        bool success;
        (success, returndata) = address(this).call{gas: req.gas}(
            abi.encodePacked(req.data, req.from)
        );

        if (!success) revert ExecutionFailed(returndata);
        emit MetaTxExecuted(req.from, req.nonce);
    }

    // ── executeBatch() ────────────────────────────────────────────────────────

    function executeBatch(
        ForwardRequest[] calldata reqs,
        bytes[]          calldata signatures,
        bool             continueOnFailure
    ) external nonReentrant whenNotPaused {
        if (reqs.length != signatures.length) revert BatchLengthMismatch();

        for (uint256 i = 0; i < reqs.length; i++) {
            ForwardRequest calldata req = reqs[i];

            if (gasleft() < req.gas + 40_000) {
                if (continueOnFailure) {
                    emit BatchResult(i, req.from, false, bytes("InsufficientGas"));
                    continue;
                }
                revert InsufficientGas();
            }

            bool verified = _tryVerifyAndIncrement(req, signatures[i]);
            if (!verified) {
                if (continueOnFailure) {
                    emit BatchResult(i, req.from, false, bytes("InvalidSigOrNonce"));
                    continue;
                }
                revert InvalidSignature();
            }

            (bool success, bytes memory reason) = address(this).call{gas: req.gas}(
                abi.encodePacked(req.data, req.from)
            );

            emit BatchResult(i, req.from, success, success ? bytes("") : reason);
            if (!success && !continueOnFailure) revert ExecutionFailed(reason);
            if (success) emit MetaTxExecuted(req.from, req.nonce - 1);
        }
    }

    // ── swapV2() ──────────────────────────────────────────────────────────────

    /// @notice Gasless V2 swap.
    ///         If path[last] == WETH, automatically calls swapExactTokensForETH
    ///         so user receives native. Frontend passes WETH as tokenOut — no
    ///         extra params needed.
    function swapV2(
        uint256            amountIn,
        uint256            amountOutMin,
        address[] calldata path,
        uint256            deadline
    ) external whenNotPaused {
        if (msg.sender != address(this)) revert DirectCallNotAllowed();
        if (amountIn == 0)               revert ZeroAmount();
        if (path.length < 2)             revert InvalidPath();
        if (deadline < block.timestamp)  revert DeadlineExpired();

        address user    = _msgSender();
        bool nativeOut  = path[path.length - 1] == WETH;

        PERMIT2.transferFrom(user, address(this), uint160(amountIn), path[0]);
        IERC20(path[0]).forceApprove(address(V2_ROUTER), amountIn);

        uint256[] memory amounts;

        if (nativeOut) {
            // router unwraps WETH → native and sends to user directly
            amounts = V2_ROUTER.swapExactTokensForETH(
                amountIn, amountOutMin, path, user, deadline
            );
        } else {
            amounts = V2_ROUTER.swapExactTokensForTokens(
                amountIn, amountOutMin, path, user, deadline
            );
        }

        IERC20(path[0]).forceApprove(address(V2_ROUTER), 0);

        emit SwapV2Executed(
            user,
            path[0],
            path[path.length - 1],
            amountIn,
            amounts[amounts.length - 1]
        );
    }

    // ── swapV3() single-hop ───────────────────────────────────────────────────

    /// @notice Gasless V3 single-hop swap.
    ///         If tokenOut == WETH, contract receives WETH, withdraws,
    ///         and pushes native to user. Frontend passes WETH as tokenOut.
    function swapV3(
        address tokenIn,
        address tokenOut,
        uint24  fee,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external whenNotPaused {
        if (msg.sender != address(this))         revert DirectCallNotAllowed();
        if (amountIn == 0)                       revert ZeroAmount();
        if (tokenIn == address(0) ||
            tokenOut == address(0))              revert InvalidPath();
        if (tokenIn == tokenOut)                 revert InvalidPath();
        if (deadline < block.timestamp)          revert DeadlineExpired();
        if (fee != 500 && fee != 3000
            && fee != 10000)                     revert InvalidFeeTier();

        address user   = _msgSender();
        bool nativeOut = tokenOut == WETH;

        PERMIT2.transferFrom(user, address(this), uint160(amountIn), tokenIn);
        IERC20(tokenIn).forceApprove(address(V3_ROUTER), amountIn);

        uint256 amountOut = V3_ROUTER.exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               fee,
                // if unwrapping: receive WETH here, then withdraw below
                recipient:         nativeOut ? address(this) : user,
                deadline:          deadline,
                amountIn:          amountIn,
                amountOutMinimum:  amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);

        if (nativeOut) {
            IWETH(WETH).withdraw(amountOut);
            (bool sent,) = user.call{value: amountOut}("");
            if (!sent) revert NativeTransferFailed();
        }

        emit SwapV3Executed(user, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ── swapV3MultiHop() ──────────────────────────────────────────────────────

    /// @notice Gasless V3 multi-hop swap.
    ///         path = abi.encodePacked(tokenA, fee, tokenB, fee, tokenC ...)
    ///         If last token in path == WETH, auto-unwraps to native.
    function swapV3MultiHop(
        bytes   calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external whenNotPaused {
        if (msg.sender != address(this)) revert DirectCallNotAllowed();
        if (path.length < 43)            revert InvalidPath();
        if (amountIn == 0)               revert ZeroAmount();
        if (deadline < block.timestamp)  revert DeadlineExpired();

        address user = _msgSender();

        // tokenIn = first 20 bytes of path
        address tokenIn;
        assembly { tokenIn := shr(96, calldataload(path.offset)) }

        // tokenOut = last 20 bytes of path
        address tokenOut;
        assembly {
            tokenOut := shr(96, calldataload(add(path.offset, sub(path.length, 20))))
        }

        bool nativeOut = tokenOut == WETH;

        PERMIT2.transferFrom(user, address(this), uint160(amountIn), tokenIn);
        IERC20(tokenIn).forceApprove(address(V3_ROUTER), amountIn);

        uint256 amountOut = V3_ROUTER.exactInput(
            IUniswapV3Router.ExactInputParams({
                path:             path,
                recipient:        nativeOut ? address(this) : user,
                deadline:         deadline,
                amountIn:         amountIn,
                amountOutMinimum: amountOutMin
            })
        );

        IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);

        if (nativeOut) {
            IWETH(WETH).withdraw(amountOut);
            (bool sent,) = user.call{value: amountOut}("");
            if (!sent) revert NativeTransferFailed();
        }

        emit SwapV3Executed(user, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ── swapBatch() ───────────────────────────────────────────────────────────

    /// @notice Multiple swaps in one ForwardRequest. All or nothing.
    function swapBatch(SwapCall[] calldata calls) external whenNotPaused {
        if (msg.sender != address(this)) revert DirectCallNotAllowed();

        address user = _msgSender();

        for (uint256 i = 0; i < calls.length; i++) {
            SwapCall calldata c = calls[i];

            if (c.kind == SwapKind.V2) {
                (
                    uint256 amountIn,
                    uint256 amountOutMin,
                    address[] memory path,
                    uint256 deadline
                ) = abi.decode(c.data, (uint256, uint256, address[], uint256));

                if (amountIn == 0)              revert ZeroAmount();
                if (path.length < 2)            revert InvalidPath();
                if (deadline < block.timestamp) revert DeadlineExpired();

                bool nativeOut = path[path.length - 1] == WETH;

                PERMIT2.transferFrom(user, address(this), uint160(amountIn), path[0]);
                IERC20(path[0]).forceApprove(address(V2_ROUTER), amountIn);

                uint256[] memory amounts;
                if (nativeOut) {
                    amounts = V2_ROUTER.swapExactTokensForETH(
                        amountIn, amountOutMin, path, user, deadline
                    );
                } else {
                    amounts = V2_ROUTER.swapExactTokensForTokens(
                        amountIn, amountOutMin, path, user, deadline
                    );
                }
                IERC20(path[0]).forceApprove(address(V2_ROUTER), 0);
                emit SwapV2Executed(user, path[0], path[path.length-1], amountIn, amounts[amounts.length-1]);

            } else if (c.kind == SwapKind.V3Single) {
                (
                    address tokenIn,
                    address tokenOut,
                    uint24  fee,
                    uint256 amountIn,
                    uint256 amountOutMin,
                    uint256 deadline
                ) = abi.decode(c.data, (address, address, uint24, uint256, uint256, uint256));

                if (amountIn == 0)              revert ZeroAmount();
                if (tokenIn == tokenOut)        revert InvalidPath();
                if (deadline < block.timestamp) revert DeadlineExpired();
                if (fee != 500 && fee != 3000 && fee != 10000) revert InvalidFeeTier();

                bool nativeOut = tokenOut == WETH;

                PERMIT2.transferFrom(user, address(this), uint160(amountIn), tokenIn);
                IERC20(tokenIn).forceApprove(address(V3_ROUTER), amountIn);
                uint256 amountOut = V3_ROUTER.exactInputSingle(
                    IUniswapV3Router.ExactInputSingleParams({
                        tokenIn: tokenIn, tokenOut: tokenOut, fee: fee,
                        recipient: nativeOut ? address(this) : user,
                        deadline: deadline, amountIn: amountIn,
                        amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0
                    })
                );
                IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);

                if (nativeOut) {
                    IWETH(WETH).withdraw(amountOut);
                    (bool sent,) = user.call{value: amountOut}("");
                    if (!sent) revert NativeTransferFailed();
                }
                emit SwapV3Executed(user, tokenIn, tokenOut, amountIn, amountOut);

            } else if (c.kind == SwapKind.V3Multi) {
                (
                    bytes   memory path,
                    uint256 amountIn,
                    uint256 amountOutMin,
                    uint256 deadline
                ) = abi.decode(c.data, (bytes, uint256, uint256, uint256));

                if (path.length < 43)           revert InvalidPath();
                if (amountIn == 0)              revert ZeroAmount();
                if (deadline < block.timestamp) revert DeadlineExpired();

                address tokenIn;
                address tokenOut;
                assembly {
                    tokenIn  := shr(96, mload(add(path, 32)))
                    tokenOut := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
                }

                bool nativeOut = tokenOut == WETH;

                PERMIT2.transferFrom(user, address(this), uint160(amountIn), tokenIn);
                IERC20(tokenIn).forceApprove(address(V3_ROUTER), amountIn);
                uint256 amountOut = V3_ROUTER.exactInput(
                    IUniswapV3Router.ExactInputParams({
                        path: path, recipient: nativeOut ? address(this) : user,
                        deadline: deadline, amountIn: amountIn,
                        amountOutMinimum: amountOutMin
                    })
                );
                IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);

                if (nativeOut) {
                    IWETH(WETH).withdraw(amountOut);
                    (bool sent,) = user.call{value: amountOut}("");
                    if (!sent) revert NativeTransferFailed();
                }
                emit SwapV3Executed(user, tokenIn, tokenOut, amountIn, amountOut);

            } else {
                revert InvalidSwapKind();
            }
        }
    }

    // ── Signature helpers ──────────────────────────────────────────────────────

    function _buildDigest(ForwardRequest calldata req) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            _TYPEHASH,
            req.from,
            req.nonce,
            req.gas,
            keccak256(req.data)
        )));
    }

    function _verifyAndIncrement(ForwardRequest calldata req, bytes calldata sig) internal {
        if (_nonces[req.from] != req.nonce)             revert InvalidNonce();
        if (gasleft() < req.gas + 40_000)               revert InsufficientGas();
        if (_buildDigest(req).recover(sig) != req.from) revert InvalidSignature();
        _nonces[req.from]++;
    }

    function _tryVerifyAndIncrement(
        ForwardRequest calldata req,
        bytes calldata sig
    ) internal returns (bool) {
        if (_nonces[req.from] != req.nonce)              return false;
        if (_buildDigest(req).recover(sig) != req.from)  return false;
        _nonces[req.from]++;
        return true;
    }

    // ── Owner ──────────────────────────────────────────────────────────────────

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    function rescueETH() external onlyOwner {
        (bool sent,) = owner().call{value: address(this).balance}("");
        require(sent, "failed");
    }

    // accepts ETH from WETH.withdraw() only
    receive() external payable {}
}
