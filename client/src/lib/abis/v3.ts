// Uniswap V3 Contract ABIs (SwapRouter02 / QuoterV2 compatible)

export const QUOTER_V2_ABI = [
  // Exact input quotes
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  // Exact output quotes
  "function quoteExactOutputSingle(tuple(address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutput(bytes path, uint256 amountOut) external returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
];

export const SWAP_ROUTER_V3_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
  "function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) external payable returns (uint256 amountOut)",
  "function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountIn)",
  "function exactOutput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params) external payable returns (uint256 amountIn)",
  "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
  "function refundETH() external payable",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) external payable",
];

export const NONFUNGIBLE_POSITION_MANAGER_ABI = [
  // Position management
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
  "function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint256 amount0, uint256 amount1)",
  "function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) external payable",
  // ERC721 functions
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  "function approve(address to, uint256 tokenId) external",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 tokenId) external",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external",
  "function transferFrom(address from, address to, uint256 tokenId) external",
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address owner, address operator) external view returns (bool)",
  "function getApproved(uint256 tokenId) external view returns (address)",
  "function totalSupply() external view returns (uint256)",
  "function tokenByIndex(uint256 index) external view returns (uint256)",
  // Multicall for batching operations
  "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
  // Refund unused ETH/native token
  "function refundETH() external payable",
  // Unwrap WETH to ETH
  "function unwrapWETH9(uint256 amountMinimum, address recipient) external payable",
  // Permit
  "function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external payable",
  // Events
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

export const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
  "function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool)",
  "function owner() external view returns (address)",
  "function feeAmountTickSpacing(uint24 fee) external view returns (int24)",
  "function enableFeeAmount(uint24 fee, int24 tickSpacing) external",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];

export const V3_POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function tickSpacing() external view returns (int24)",
  "function liquidity() external view returns (uint128)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  // Fee growth globals — needed for accurate uncollected fee calculation
  "function feeGrowthGlobal0X128() external view returns (uint256)",
  "function feeGrowthGlobal1X128() external view returns (uint256)",
  "function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)",
  "function initialize(uint160 sqrtPriceX96) external",
  "function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
  "function positions(bytes32 key) external view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1)",
  "function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external",
  "function maxLiquidityPerTick() external view returns (uint128)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
];

export const V3_MIGRATOR_ABI = [
  "function migrate(tuple(address pair, uint256 liquidityToMigrate, uint8 percentageToMigrate, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, bool refundAsETH) params) external",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
  "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
  "function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external payable",
];

export const TICK_LENS_ABI = [
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, uint128 liquidityGross)[] populatedTicks)",
];

// Common V3 Fee Tiers
export const V3_FEE_TIERS = {
  LOWEST: 100,    // 0.01%
  LOW: 500,       // 0.05%
  MEDIUM: 3000,   // 0.3%
  HIGH: 10000,    // 1%
  ULTRA_HIGH: 100000, // 10% - for exotic pairs
} as const;

export const FEE_TIER_LABELS = {
  [V3_FEE_TIERS.LOWEST]: "0.01%",
  [V3_FEE_TIERS.LOW]: "0.05%",
  [V3_FEE_TIERS.MEDIUM]: "0.3%",
  [V3_FEE_TIERS.HIGH]: "1%",
  [V3_FEE_TIERS.ULTRA_HIGH]: "10%",
} as const;

export type FeeTier = typeof V3_FEE_TIERS[keyof typeof V3_FEE_TIERS];
