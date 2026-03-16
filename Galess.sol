// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  AchSwapGasless v3
 *
 * Fixes vs v2
 * ───────────
 * 1. REENTRANCY FIX — nonReentrant removed from all swap functions.
 *    execute() holds the lock at the top level. Swap functions are only
 *    reachable through execute() so the guard is still fully effective.
 *    Root cause of 0x3ee5aeb5 (ReentrancyGuardReentrantCall) failures.
 *
 * 2. ONE SIGNATURE PER SWAP — switched from Permit2 permitTransferFrom
 *    (required a fresh Permit2 sig + ForwardRequest sig = 2 sigs every swap)
 *    to Permit2 allowanceTransfer (user approves once, then only the
 *    ForwardRequest sig is needed per swap = 1 sig forever after).
 *
 * 3. SIMPLIFIED INTERNALS — removed the abi.encode → abi.decode chain
 *    in internal swap helpers. Params are passed directly. Eliminates
 *    silent decode failures that caused unpredictable reverts.
 *
 * One-time user setup per token (user pays gas once, never again)
 * ───────────────────────────────────────────────────────────────
 * Step 1: token.approve(PERMIT2_ADDRESS, MaxUint256)
 * Step 2: permit2.approve(token, THIS_CONTRACT, MaxUint256, expiry)
 *         where expiry is uint48 — e.g. block.timestamp + 365 days
 * After that: every swap needs only 1 signature (ForwardRequest).
 *
 * Security model
 * ──────────────
 * - execute() / executeBatch() hold nonReentrant — outer guard is sufficient.
 * - Swap functions block direct calls (must go through execute).
 * - Both routers immutable — set at deploy, never changeable.
 * - Permit2 address hardcoded constant.
 * - SafeERC20 forceApprove used for all router approvals.
 * - Router approval reset to 0 after every swap.
 * - Pausable emergency stop.
 */

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

// ── Permit2 AllowanceTransfer interface ───────────────────────────────────────
// Used for 1-sig-per-swap flow. User approves once via permit2.approve(),
// contract calls transferFrom() with no signature argument.

interface IPermit2 {
    /// @notice Transfer tokens using stored allowance — no sig required at call time
    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external;

    /// @notice Called by user once per token to set allowance (replaces ERC20 approve)
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48  expiration
    ) external;
}

// ── Uniswap V2 ────────────────────────────────────────────────────────────────

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256          amountIn,
        uint256          amountOutMin,
        address[] calldata path,
        address          to,
        uint256          deadline
    ) external returns (uint256[] memory amounts);
}

// ── Uniswap V3 — original SwapRouter ─────────────────────────────────────────
// deadline is INSIDE ExactInputSingleParams (original SwapRouter behaviour).
// SwapRouter02 removes deadline from the struct — this contract targets original.

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
        bytes   path;       // abi.encodePacked(tokenA, fee, tokenB, fee, tokenC ...)
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

// ── Main contract ─────────────────────────────────────────────────────────────

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

    // ── Batch swap types ───────────────────────────────────────────────────────

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

    event BatchResult(
        uint256 indexed index,
        address indexed from,
        bool    success,
        bytes   reason
    );

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

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _v2Router, address _v3Router)
        EIP712("AchSwapGasless", "1")
        Ownable(msg.sender)
    {
        require(_v2Router != address(0) && _v3Router != address(0), "zero address");
        V2_ROUTER = IUniswapV2Router(_v2Router);
        V3_ROUTER = IUniswapV3Router(_v3Router);
    }

    // ── ERC-2771 sender resolution ─────────────────────────────────────────────

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

    /// @notice Relayer calls this with a signed ForwardRequest.
    ///         nonReentrant lives here — swap functions do NOT have it.
    ///         Swap functions are only reachable through this call so the
    ///         reentrancy guard is still fully effective.
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

    /// @notice Relayer batches N users into one tx.
    /// @param continueOnFailure  true = skip failures, false = revert on first
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

    /// @notice Gasless V2 swap. Requires prior Permit2 allowance setup.
    ///         No permitSig param — 1 signature total (ForwardRequest only).
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

        address user = _msgSender();

        // pull tokens — no sig needed, uses stored Permit2 allowance
        PERMIT2.transferFrom(user, address(this), uint160(amountIn), path[0]);

        IERC20(path[0]).forceApprove(address(V2_ROUTER), amountIn);
        uint256[] memory amounts = V2_ROUTER.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            user,
            deadline
        );
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

    /// @notice Gasless V3 single-hop swap. No permitSig — 1 signature total.
    /// @param fee  Pool fee tier: 500 / 3000 / 10000
    function swapV3(
        address tokenIn,
        address tokenOut,
        uint24  fee,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external whenNotPaused {
        if (msg.sender != address(this))        revert DirectCallNotAllowed();
        if (amountIn == 0)                      revert ZeroAmount();
        if (tokenIn == address(0) ||
            tokenOut == address(0))             revert InvalidPath();
        if (tokenIn == tokenOut)                revert InvalidPath();
        if (deadline < block.timestamp)         revert DeadlineExpired();
        if (fee != 500 && fee != 3000
            && fee != 10000)                    revert InvalidFeeTier();

        address user = _msgSender();

        PERMIT2.transferFrom(user, address(this), uint160(amountIn), tokenIn);

        IERC20(tokenIn).forceApprove(address(V3_ROUTER), amountIn);
        uint256 amountOut = V3_ROUTER.exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               fee,
                recipient:         user,
                deadline:          deadline,
                amountIn:          amountIn,
                amountOutMinimum:  amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);

        emit SwapV3Executed(user, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ── swapV3MultiHop() ──────────────────────────────────────────────────────

    /// @notice Gasless V3 multi-hop swap via exactInput.
    ///         path = abi.encodePacked(tokenA, fee, tokenB, fee, tokenC ...)
    ///         tokenIn  = first 20 bytes of path
    ///         tokenOut = last  20 bytes of path
    function swapV3MultiHop(
        bytes   calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external whenNotPaused {
        if (msg.sender != address(this)) revert DirectCallNotAllowed();
        if (path.length < 43)            revert InvalidPath(); // min: 20 + 3 + 20
        if (amountIn == 0)               revert ZeroAmount();
        if (deadline < block.timestamp)  revert DeadlineExpired();

        address user = _msgSender();

        // extract tokenIn from first 20 bytes of path
        address tokenIn;
        assembly { tokenIn := shr(96, calldataload(path.offset)) }

        // extract tokenOut from last 20 bytes of path
        address tokenOut;
        assembly {
            tokenOut := shr(96, calldataload(add(path.offset, sub(path.length, 20))))
        }

        PERMIT2.transferFrom(user, address(this), uint160(amountIn), tokenIn);

        IERC20(tokenIn).forceApprove(address(V3_ROUTER), amountIn);
        uint256 amountOut = V3_ROUTER.exactInput(
            IUniswapV3Router.ExactInputParams({
                path:             path,
                recipient:        user,
                deadline:         deadline,
                amountIn:         amountIn,
                amountOutMinimum: amountOutMin
            })
        );
        IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);

        emit SwapV3Executed(user, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ── swapBatch() ───────────────────────────────────────────────────────────

    /// @notice Multiple swaps in one ForwardRequest. All or nothing.
    ///         Encode as req.data: iface.encodeFunctionData("swapBatch", [calls])
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

                PERMIT2.transferFrom(user, address(this), uint160(amountIn), path[0]);
                IERC20(path[0]).forceApprove(address(V2_ROUTER), amountIn);
                uint256[] memory amounts = V2_ROUTER.swapExactTokensForTokens(
                    amountIn, amountOutMin, path, user, deadline
                );
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

                PERMIT2.transferFrom(user, address(this), uint160(amountIn), tokenIn);
                IERC20(tokenIn).forceApprove(address(V3_ROUTER), amountIn);
                uint256 amountOut = V3_ROUTER.exactInputSingle(
                    IUniswapV3Router.ExactInputSingleParams({
                        tokenIn: tokenIn, tokenOut: tokenOut, fee: fee,
                        recipient: user, deadline: deadline,
                        amountIn: amountIn, amountOutMinimum: amountOutMin,
                        sqrtPriceLimitX96: 0
                    })
                );
                IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);
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

                PERMIT2.transferFrom(user, address(this), uint160(amountIn), tokenIn);
                IERC20(tokenIn).forceApprove(address(V3_ROUTER), amountIn);
                uint256 amountOut = V3_ROUTER.exactInput(
                    IUniswapV3Router.ExactInputParams({
                        path: path, recipient: user, deadline: deadline,
                        amountIn: amountIn, amountOutMinimum: amountOutMin
                    })
                );
                IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);
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

    receive() external payable { revert("no ETH accepted"); }
}
