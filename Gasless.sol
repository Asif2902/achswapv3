// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }
    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }
    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }
    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

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

contract AchSwapGasless is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    enum RouteKind { V2, V3Single, V3Multi }

    struct RouteSegment {
        RouteKind kind;
        uint256   amountIn;
        uint256   amountOutMin;
        uint256   deadline;
        bytes     params;
    }

    IPermit2 public constant PERMIT2 =
        IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address public constant USDC_NATIVE =
        0x3600000000000000000000000000000000000000;

    IUniswapV2Router public immutable V2_ROUTER;
    IUniswapV3Router public immutable V3_ROUTER;
    address          public immutable WUSDC;

    event SwapExecuted(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 totalAmountIn,
        uint256 totalAmountOut
    );

    event SplitSwapExecuted(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 totalAmountIn,
        uint256 totalAmountOut,
        uint256 legs
    );

    error ZeroAmount();
    error InvalidPath();
    error DeadlineExpired();
    error InvalidFeeTier();
    error NativeTransferFailed();
    error InvalidWrappedToken();
    error InvalidRouteKind();
    error EmptyRoute();
    error AmountMismatch();

    constructor(
        address _v2Router,
        address _v3Router,
        address _wusdc
    ) Ownable(msg.sender) {
        require(
            _v2Router != address(0) &&
            _v3Router != address(0) &&
            _wusdc    != address(0),
            "zero address"
        );
        V2_ROUTER = IUniswapV2Router(_v2Router);
        V3_ROUTER = IUniswapV3Router(_v3Router);
        WUSDC     = _wusdc;
    }

    function execute(
        address              user,
        address              tokenIn,
        uint256              totalAmountIn,
        uint256              permitNonce,
        uint256              permitDeadline,
        bytes       calldata permitSig,
        RouteSegment calldata segment
    ) external nonReentrant whenNotPaused {
        if (totalAmountIn == 0)              revert ZeroAmount();
        if (permitDeadline < block.timestamp) revert DeadlineExpired();

        _pullViaPermit2(tokenIn, totalAmountIn, permitNonce, permitDeadline, user, permitSig);
        address actualTokenIn = _normalizeTokenIn(tokenIn, totalAmountIn);

        address tokenOut  = _getTokenOut(segment, actualTokenIn);
        uint256 amountOut = _executeSegment(segment, actualTokenIn, user);

        emit SwapExecuted(user, tokenIn, tokenOut, totalAmountIn, amountOut);
    }

    function executeSplit(
        address                user,
        address                tokenIn,
        uint256                totalAmountIn,
        uint256                permitNonce,
        uint256                permitDeadline,
        bytes         calldata permitSig,
        RouteSegment[] calldata segments
    ) external nonReentrant whenNotPaused {
        if (segments.length == 0)             revert EmptyRoute();
        if (totalAmountIn == 0)               revert ZeroAmount();
        if (permitDeadline < block.timestamp)  revert DeadlineExpired();

        uint256 segmentSum;
        for (uint256 i = 0; i < segments.length; i++) {
            segmentSum += segments[i].amountIn;
        }
        if (segmentSum != totalAmountIn) revert AmountMismatch();

        _pullViaPermit2(tokenIn, totalAmountIn, permitNonce, permitDeadline, user, permitSig);
        address actualTokenIn = _normalizeTokenIn(tokenIn, totalAmountIn);

        address tokenOut = _getTokenOut(segments[0], actualTokenIn);
        uint256 totalAmountOut;

        for (uint256 i = 0; i < segments.length; i++) {
            totalAmountOut += _executeSegment(segments[i], actualTokenIn, user);
        }

        emit SplitSwapExecuted(user, tokenIn, tokenOut, totalAmountIn, totalAmountOut, segments.length);
    }

    function _normalizeTokenIn(address tokenIn, uint256 amount) internal returns (address) {
        if (tokenIn == USDC_NATIVE) {
            IWrappedNative(WUSDC).deposit{value: amount}();
            return WUSDC;
        }
        return tokenIn;
    }

    function _executeSegment(
        RouteSegment calldata seg,
        address tokenIn,
        address user
    ) internal returns (uint256 amountOut) {
        if (seg.deadline < block.timestamp) revert DeadlineExpired();
        if (seg.amountIn == 0)              revert ZeroAmount();

        if      (seg.kind == RouteKind.V2)       amountOut = _swapV2(seg, tokenIn, user);
        else if (seg.kind == RouteKind.V3Single)  amountOut = _swapV3Single(seg, tokenIn, user);
        else if (seg.kind == RouteKind.V3Multi)   amountOut = _swapV3Multi(seg, user);
        else revert InvalidRouteKind();
    }

    function _swapV2(
        RouteSegment calldata seg,
        address tokenIn,
        address user
    ) internal returns (uint256) {
        address[] memory path = abi.decode(seg.params, (address[]));
        if (path.length < 2) revert InvalidPath();

        path[0] = tokenIn;

        address outToken = path[path.length - 1];
        bool nativeOut   = outToken == WUSDC;

        IERC20(tokenIn).forceApprove(address(V2_ROUTER), seg.amountIn);

        uint256[] memory amounts;
        if (nativeOut) {
            amounts = V2_ROUTER.swapExactTokensForETH(
                seg.amountIn, seg.amountOutMin, path, user, seg.deadline
            );
        } else {
            amounts = V2_ROUTER.swapExactTokensForTokens(
                seg.amountIn, seg.amountOutMin, path, user, seg.deadline
            );
        }

        IERC20(tokenIn).forceApprove(address(V2_ROUTER), 0);
        return amounts[amounts.length - 1];
    }

    function _swapV3Single(
        RouteSegment calldata seg,
        address tokenIn,
        address user
    ) internal returns (uint256) {
        (address tokenOut, uint24 fee) = abi.decode(seg.params, (address, uint24));

        if (tokenOut == address(0))                     revert InvalidPath();
        if (tokenIn  == tokenOut)                       revert InvalidPath();
        if (fee != 500 && fee != 3000 && fee != 10000)  revert InvalidFeeTier();

        bool nativeOut = tokenOut == WUSDC;

        IERC20(tokenIn).forceApprove(address(V3_ROUTER), seg.amountIn);

        uint256 amountOut = V3_ROUTER.exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               fee,
                recipient:         nativeOut ? address(this) : user,
                deadline:          seg.deadline,
                amountIn:          seg.amountIn,
                amountOutMinimum:  seg.amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);

        if (nativeOut) {
            IWrappedNative(WUSDC).withdraw(amountOut);
            (bool sent,) = user.call{value: amountOut}("");
            if (!sent) revert NativeTransferFailed();
        }

        return amountOut;
    }

    function _swapV3Multi(
        RouteSegment calldata seg,
        address user
    ) internal returns (uint256) {
        bytes memory path = abi.decode(seg.params, (bytes));
        if (path.length < 43) revert InvalidPath();

        address tokenIn;
        address tokenOut;
        assembly {
            tokenIn  := shr(96, mload(add(path, 32)))
            tokenOut := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
        }

        bool nativeOut = tokenOut == WUSDC;

        IERC20(tokenIn).forceApprove(address(V3_ROUTER), seg.amountIn);

        uint256 amountOut = V3_ROUTER.exactInput(
            IUniswapV3Router.ExactInputParams({
                path:             path,
                recipient:        nativeOut ? address(this) : user,
                deadline:         seg.deadline,
                amountIn:         seg.amountIn,
                amountOutMinimum: seg.amountOutMin
            })
        );

        IERC20(tokenIn).forceApprove(address(V3_ROUTER), 0);

        if (nativeOut) {
            IWrappedNative(WUSDC).withdraw(amountOut);
            (bool sent,) = user.call{value: amountOut}("");
            if (!sent) revert NativeTransferFailed();
        }

        return amountOut;
    }

    function _pullViaPermit2(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        address owner,
        bytes calldata sig
    ) internal {
        PERMIT2.permitTransferFrom(
            IPermit2.PermitTransferFrom({
                permitted: IPermit2.TokenPermissions({ token: token, amount: amount }),
                nonce:     nonce,
                deadline:  deadline
            }),
            IPermit2.SignatureTransferDetails({ to: address(this), requestedAmount: amount }),
            owner,
            sig
        );
    }

    function _getTokenOut(
        RouteSegment calldata seg,
        address tokenIn
    ) internal pure returns (address tokenOut) {
        if (seg.kind == RouteKind.V2) {
            address[] memory path = abi.decode(seg.params, (address[]));
            tokenOut = path[path.length - 1];
        } else if (seg.kind == RouteKind.V3Single) {
            (tokenOut,) = abi.decode(seg.params, (address, uint24));
        } else if (seg.kind == RouteKind.V3Multi) {
            bytes memory path = abi.decode(seg.params, (bytes));
            assembly {
                tokenOut := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
            }
        }
    }

    function depositNative() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        IWrappedNative(WUSDC).deposit{value: msg.value}();
        IERC20(WUSDC).safeTransfer(msg.sender, msg.value);
    }

    function withdrawNative(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(WUSDC).safeTransferFrom(msg.sender, address(this), amount);
        IWrappedNative(WUSDC).withdraw(amount);
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert NativeTransferFailed();
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    function rescueETH() external onlyOwner {
        (bool sent,) = owner().call{value: address(this).balance}("");
        require(sent, "failed");
    }

    receive() external payable {}
}
