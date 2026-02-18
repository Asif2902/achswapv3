import { tickToSqrtPriceX96 } from "./v3-utils";

const Q96 = 2n ** 96n;

// ─────────────────────────────────────────────────────────────────────────────
// Uniswap V3 liquidity math — corrected formulas
//
// All sqrt-prices are in Q96 fixed-point (i.e. sqrtP * 2^96).
// Variables:
//   sqrtP  = current pool sqrt-price  (sqrtPriceX96)
//   sqrtPa = lower bound sqrt-price   (sqrtPriceLowerX96)
//   sqrtPb = upper bound sqrt-price   (sqrtPriceUpperX96)
//   L      = liquidity
//
// Core V3 identities when price is IN range [Pa, Pb]:
//   amount0 = L × Q96 × (sqrtPb − sqrtP)  /  (sqrtP  × sqrtPb)
//   amount1 = L × (sqrtP − sqrtPa)  /  Q96
//
// Solving for L from amount0 (in-range):
//   L = amount0 × sqrtP × sqrtPb  /  (Q96 × (sqrtPb − sqrtP))
//
// Solving for L from amount1 (in-range):
//   L = amount1 × Q96  /  (sqrtP − sqrtPa)
//
// Previous bugs in this file:
//   getAmount1ForAmount0 — used sqrtPa in the L formula instead of sqrtPb
//   getAmount0ForAmount1 — used sqrtPa in the amount0 denominator instead of sqrtPb
//   Both bugs caused the computed "other-side" amount to be wrong, making the
//   pool's actual deposit ratio differ from our minimums → "Price slippage check"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given the amount of token0 and the price bounds, return the matching amount1.
 */
export function getAmount1ForAmount0(
  amount0: bigint,
  sqrtPriceX96: bigint,      // sqrtP  — current price
  sqrtPriceLowerX96: bigint, // sqrtPa — lower bound
  sqrtPriceUpperX96: bigint, // sqrtPb — upper bound
): bigint {
  // Below range → 100% token0, no token1 needed
  if (sqrtPriceX96 <= sqrtPriceLowerX96) return 0n;
  // Above range → 100% token1, token0 cannot be deposited
  if (sqrtPriceX96 >= sqrtPriceUpperX96) return 0n;

  // In range.
  //
  // Step 1 — derive L from amount0:
  //   L = amount0 × sqrtP × sqrtPb / (Q96 × (sqrtPb − sqrtP))
  //
  // Step 2 — derive amount1 from L:
  //   amount1 = L × (sqrtP − sqrtPa) / Q96
  //
  // Combined (avoids a lossy intermediate BigInt division):
  //   amount1 = amount0 × sqrtP × sqrtPb × (sqrtP − sqrtPa)
  //             ────────────────────────────────────────────
  //             Q96² × (sqrtPb − sqrtP)
  //
  const num = amount0 * sqrtPriceX96 * sqrtPriceUpperX96 * (sqrtPriceX96 - sqrtPriceLowerX96);
  const den = Q96 * Q96 * (sqrtPriceUpperX96 - sqrtPriceX96);
  return num / den;
}

/**
 * Given the amount of token1 and the price bounds, return the matching amount0.
 */
export function getAmount0ForAmount1(
  amount1: bigint,
  sqrtPriceX96: bigint,
  sqrtPriceLowerX96: bigint,
  sqrtPriceUpperX96: bigint,
): bigint {
  // Above range → 100% token1, no token0 needed
  if (sqrtPriceX96 >= sqrtPriceUpperX96) return 0n;
  // Below range → 100% token0, token1 cannot be deposited
  if (sqrtPriceX96 <= sqrtPriceLowerX96) return 0n;

  // In range.
  //
  // Step 1 — derive L from amount1:
  //   L = amount1 × Q96 / (sqrtP − sqrtPa)
  //
  // Step 2 — derive amount0 from L:
  //   amount0 = L × Q96 × (sqrtPb − sqrtP) / (sqrtP × sqrtPb)
  //
  // Combined:
  //   amount0 = amount1 × Q96² × (sqrtPb − sqrtP)
  //             ──────────────────────────────────────────────
  //             (sqrtP − sqrtPa) × sqrtP × sqrtPb
  //
  const num = amount1 * Q96 * Q96 * (sqrtPriceUpperX96 - sqrtPriceX96);
  const den = (sqrtPriceX96 - sqrtPriceLowerX96) * sqrtPriceX96 * sqrtPriceUpperX96;
  return num / den;
}

/**
 * Calculate both token amounts for a V3 position given one input amount.
 *
 * Pass the user's input token amount (isToken0 = true → user entered token0).
 * Returns { amount0, amount1 } in raw BigInt units matching each token's decimals.
 */
export function calculateAmountsForLiquidity(
  inputAmount: bigint,
  isToken0: boolean,
  currentSqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  token0Decimals: number,
  token1Decimals: number,
): { amount0: bigint; amount1: bigint } {
  const sqrtPriceLowerX96 = tickToSqrtPriceX96(tickLower);
  const sqrtPriceUpperX96 = tickToSqrtPriceX96(tickUpper);

  if (isToken0) {
    const amount1 = getAmount1ForAmount0(
      inputAmount, currentSqrtPriceX96, sqrtPriceLowerX96, sqrtPriceUpperX96,
    );
    return { amount0: inputAmount, amount1 };
  } else {
    const amount0 = getAmount0ForAmount1(
      inputAmount, currentSqrtPriceX96, sqrtPriceLowerX96, sqrtPriceUpperX96,
    );
    return { amount0, amount1: inputAmount };
  }
}

/**
 * Calculate total liquidity from both amounts (returns the binding constraint).
 */
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtPriceLowerX96: bigint,
  sqrtPriceUpperX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtPriceX96 <= sqrtPriceLowerX96) {
    // Price below range — only token0
    if (sqrtPriceUpperX96 === sqrtPriceLowerX96) return 0n;
    return (amount0 * Q96 * sqrtPriceUpperX96 * sqrtPriceLowerX96) /
           ((sqrtPriceUpperX96 - sqrtPriceLowerX96) * Q96);
  }
  if (sqrtPriceX96 >= sqrtPriceUpperX96) {
    // Price above range — only token1
    return (amount1 * Q96) / (sqrtPriceUpperX96 - sqrtPriceLowerX96);
  }
  // Both tokens
  const l0num = amount0 * sqrtPriceX96 * sqrtPriceUpperX96;
  const l0den = Q96 * (sqrtPriceUpperX96 - sqrtPriceX96);
  const liq0  = l0den > 0n ? l0num / l0den : 0n;

  const l1den = sqrtPriceX96 - sqrtPriceLowerX96;
  const liq1  = l1den > 0n ? (amount1 * Q96) / l1den : 0n;

  return liq0 < liq1 ? liq0 : liq1;
}

/**
 * Convert raw V3 liquidity back to token amounts.
 */
export function getTokensFromLiquidity(
  liquidity: bigint,
  currentSqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
): { amount0: bigint; amount1: bigint } {
  const sqrtPriceLowerX96 = tickToSqrtPriceX96(tickLower);
  const sqrtPriceUpperX96 = tickToSqrtPriceX96(tickUpper);

  if (currentSqrtPriceX96 <= sqrtPriceLowerX96) {
    const amount0 =
      sqrtPriceLowerX96 > 0n && sqrtPriceUpperX96 > 0n
        ? (liquidity * (sqrtPriceUpperX96 - sqrtPriceLowerX96) * Q96) /
          (sqrtPriceLowerX96 * sqrtPriceUpperX96)
        : 0n;
    return { amount0, amount1: 0n };
  }
  if (currentSqrtPriceX96 >= sqrtPriceUpperX96) {
    const amount1 = (liquidity * (sqrtPriceUpperX96 - sqrtPriceLowerX96)) / Q96;
    return { amount0: 0n, amount1 };
  }
  const amount0 =
    currentSqrtPriceX96 > 0n && sqrtPriceUpperX96 > 0n
      ? (liquidity * Q96 * (sqrtPriceUpperX96 - currentSqrtPriceX96)) /
        (currentSqrtPriceX96 * sqrtPriceUpperX96)
      : 0n;
  const amount1 = (liquidity * (currentSqrtPriceX96 - sqrtPriceLowerX96)) / Q96;
  return { amount0, amount1 };
}

// Simple display helpers
export function calculateAmount1FromAmount0(amount0: number, currentPrice: number): number {
  return amount0 * currentPrice;
}
export function calculateAmount0FromAmount1(amount1: number, currentPrice: number): number {
  return currentPrice > 0 ? amount1 / currentPrice : 0;
}
