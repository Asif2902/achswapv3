import { Token } from "@shared/schema";

// Constants from Uniswap V3
const Q96 = 2n ** 96n;
const Q192 = Q96 * Q96;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/**
 * Convert price to sqrtPriceX96
 * Price is token1/token0 in human-readable format
 * 
 * IMPORTANT: This function uses split-precision math to avoid JavaScript Number
 * precision loss when multiplying by 2^96. We split 2^96 into 2^48 * 2^48 to
 * stay within Number's 53-bit mantissa precision.
 */
export function priceToSqrtPriceX96(price: number, token0Decimals: number, token1Decimals: number): bigint {
  // Adjust price for decimals: divide by 10^(token0Decimals - token1Decimals)
  // This converts from human-readable price to raw price
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  const adjustedPrice = price / decimalAdjustment;
  
  if (adjustedPrice <= 0) return MIN_SQRT_RATIO;
  
  // Calculate sqrt(price)
  const sqrtPrice = Math.sqrt(adjustedPrice);
  
  // KEY FIX: Avoid precision loss by splitting 2^96 into 2^48 * 2^48
  // 2^48 ≈ 2.8e14 which times a typical sqrt value stays well within
  // Number's 53-bit mantissa precision
  const TWO_48 = 2 ** 48; // This fits in Number precisely (281474976710656)
  const sqrtPriceScaled = sqrtPrice * TWO_48;
  
  // Convert to BigInt and shift left by 48 bits (equivalent to multiplying by 2^48 again)
  const sqrtPriceX96 = BigInt(Math.round(sqrtPriceScaled)) * (1n << 48n);
  
  // Ensure within valid range
  if (sqrtPriceX96 < MIN_SQRT_RATIO) return MIN_SQRT_RATIO;
  if (sqrtPriceX96 > MAX_SQRT_RATIO) return MAX_SQRT_RATIO;
  
  return sqrtPriceX96;
}

/**
 * Convert sqrtPriceX96 to human-readable price
 * Returns price as token1/token0 (how many token1 per token0)
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, token0Decimals: number, token1Decimals: number): number {
  const price = (Number(sqrtPriceX96) / Number(Q96)) ** 2;
  // Adjust for decimals: multiply by 10^(token0Decimals - token1Decimals)
  // This converts from raw price to human-readable price
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  const adjustedPrice = price * decimalAdjustment;
  return adjustedPrice;
}

/**
 * Calculate price from token amounts
 */
export function getPriceFromAmounts(
  amount0: bigint,
  amount1: bigint,
  token0Decimals: number,
  token1Decimals: number
): number {
  if (amount0 === 0n) return 0;
  
  const amount0Float = Number(amount0) / (10 ** token0Decimals);
  const amount1Float = Number(amount1) / (10 ** token1Decimals);
  
  return amount1Float / amount0Float;
}

/**
 * Get nearest usable tick for a given tick and tick spacing
 * The returned tick must be divisible by tickSpacing and within valid range
 */
export function getNearestUsableTick(tick: number, tickSpacing: number): number {
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  
  // Ensure the tick is within bounds AND divisible by tickSpacing
  if (rounded < MIN_TICK) {
    // Find the smallest valid tick that's >= MIN_TICK and divisible by tickSpacing
    return Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  }
  if (rounded > MAX_TICK) {
    // Find the largest valid tick that's <= MAX_TICK and divisible by tickSpacing
    return Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  }
  
  return rounded;
}

/**
 * Calculate tick from price
 * Price is token1/token0 in human-readable format
 */
export function priceToTick(price: number, token0Decimals: number, token1Decimals: number): number {
  // Convert human-readable price to raw price
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  const adjustedPrice = price / decimalAdjustment;
  const tick = Math.floor(Math.log(adjustedPrice) / Math.log(1.0001));
  
  if (tick < MIN_TICK) return MIN_TICK;
  if (tick > MAX_TICK) return MAX_TICK;
  
  return tick;
}

/**
 * Calculate price from tick
 * Returns human-readable price (token1/token0)
 */
export function tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
  const rawPrice = 1.0001 ** tick;
  // Convert raw price to human-readable price
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  return rawPrice * decimalAdjustment;
}

/**
 * Get tick spacing for a fee tier
 */
export function getTickSpacing(fee: number): number {
  switch (fee) {
    case 100: return 1;      // 0.01%
    case 500: return 10;     // 0.05%
    case 3000: return 60;    // 0.3%
    case 10000: return 200;  // 1%
    case 100000: return 2000; // 10%
    default: return 60;
  }
}

/**
 * Sort tokens by address (required by Uniswap V3)
 */
export function sortTokens(tokenA: Token, tokenB: Token): [Token, Token] {
  const addressA = tokenA.address.toLowerCase();
  const addressB = tokenB.address.toLowerCase();
  
  return addressA < addressB ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Get full-range ticks for a fee tier
 */
export function getFullRangeTicks(fee: number): { tickLower: number; tickUpper: number } {
  const tickSpacing = getTickSpacing(fee);
  
  return {
    tickLower: getNearestUsableTick(MIN_TICK, tickSpacing),
    tickUpper: getNearestUsableTick(MAX_TICK, tickSpacing),
  };
}

/**
 * Get safe wide-range ticks around current price (for Basic mode)
 * Returns ticks that cover roughly 10x price range on each side
 */
export function getWideRangeTicks(
  currentPrice: number,
  token0Decimals: number,
  token1Decimals: number,
  fee: number
): { tickLower: number; tickUpper: number } {
  const tickSpacing = getTickSpacing(fee);
  const currentTick = priceToTick(currentPrice, token0Decimals, token1Decimals);
  
  // 10x range on each side (approximately)
  const tickRange = Math.floor(Math.log(10) / Math.log(1.0001)); // ~23028 ticks for 10x
  
  const tickLower = getNearestUsableTick(currentTick - tickRange, tickSpacing);
  const tickUpper = getNearestUsableTick(currentTick + tickRange, tickSpacing);
  
  return { tickLower, tickUpper };
}

/**
 * Check if position is in range
 */
export function isPositionInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tick >= tickLower && tick <= tickUpper;
}

/**
 * Encode path for multi-hop swaps
 * Path format: token0 | fee | token1 | fee | token2 | ...
 */
export function encodePath(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) {
    throw new Error("Invalid path: tokens length must be fees length + 1");
  }
  
  let encoded = "0x";
  
  for (let i = 0; i < fees.length; i++) {
    // Add token address (remove 0x prefix)
    encoded += tokens[i].slice(2).toLowerCase();
    
    // Add fee as 3 bytes (24 bits)
    const feeHex = fees[i].toString(16).padStart(6, "0");
    encoded += feeHex;
  }
  
  // Add final token
  encoded += tokens[tokens.length - 1].slice(2).toLowerCase();
  
  return encoded;
}

/**
 * Decode path from bytes
 */
export function decodePath(path: string): { tokens: string[]; fees: number[] } {
  // Remove 0x prefix
  const pathHex = path.startsWith("0x") ? path.slice(2) : path;
  
  const tokens: string[] = [];
  const fees: number[] = [];
  
  let offset = 0;
  
  while (offset < pathHex.length) {
    // Read token (20 bytes = 40 hex chars)
    const token = "0x" + pathHex.slice(offset, offset + 40);
    tokens.push(token);
    offset += 40;
    
    // If there's more data, read fee (3 bytes = 6 hex chars)
    if (offset < pathHex.length) {
      const fee = parseInt(pathHex.slice(offset, offset + 6), 16);
      fees.push(fee);
      offset += 6;
    }
  }
  
  return { tokens, fees };
}

/**
 * Calculate minimum amounts with slippage
 */
export function calculateMinAmountsWithSlippage(
  amount0: bigint,
  amount1: bigint,
  slippagePercent: number
): { amount0Min: bigint; amount1Min: bigint } {
  const slippageFactor = BigInt(Math.floor((100 - slippagePercent) * 100));
  
  return {
    amount0Min: (amount0 * slippageFactor) / 10000n,
    amount1Min: (amount1 * slippageFactor) / 10000n,
  };
}

/**
 * Convert tick to sqrtPriceX96 using TickMath formula
 * This avoids precision loss from JavaScript Number operations
 */
export function tickToSqrtPriceX96(tick: number): bigint {
  const absTick = Math.abs(tick);
  
  // Start with Q96
  let ratio = absTick & 0x1 
    ? 0xfffcb933bd6fad37aa2d162d1a594001n 
    : 0x100000000000000000000000000000000n;
  
  if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  
  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  
  // Convert from Q128.128 to Q96
  return (ratio >> 32n) + (ratio % (1n << 32n) > 0n ? 1n : 0n);
}
