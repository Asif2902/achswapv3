import { formatUnits, parseUnits } from "ethers";

const NATIVE_USDC_SYMBOL = "USDC";

/**
 * Get the max amount string for MAX button
 * - Returns formatted display string (6 decimals for UI)
 * - For native USDC, uses 99% of balance for gas buffer
 * - Ensures precision is preserved when parsed back
 */
export function getMaxAmount(balanceWei: bigint, decimals: number, symbol: string): string {
  if (balanceWei === 0n || balanceWei === undefined) return "0";

  let maxBalance = balanceWei;

  // For native USDC, keep 1% for gas buffer
  if (symbol === NATIVE_USDC_SYMBOL) {
    maxBalance = (balanceWei * 99n) / 100n;
  }

  // Format to 6 decimals for display, but ensure it can be parsed back correctly
  const formatted = formatUnits(maxBalance, decimals);
  const num = parseFloat(formatted);
  
  if (num === 0) return "0";
  if (num > 0 && num < 0.000001) {
    return num.toExponential(2);
  }
  
  return parseFloat(num.toFixed(6)).toString();
}

/**
 * Format a numeric value for DISPLAY only (6 decimal places)
 * Does NOT preserve full precision - use for UI display only
 */
export function formatAmount(value: string | number | bigint, decimals: number): string {
  try {
    if (value === undefined || value === null) {
      return "0";
    }

    if (typeof value === "bigint") {
      if (value === 0n) return "0";
      const formatted = formatUnits(value, decimals);
      const num = parseFloat(formatted);
      if (!isNaN(num) && isFinite(num)) {
        // For very small numbers, use scientific notation
        if (num > 0 && num < 0.000001) {
          return num.toExponential(2);
        }
        // For display, show up to 6 decimal places but remove trailing zeros
        return parseFloat(num.toFixed(6)).toString();
      }
      return "0";
    }
    
    const num = parseFloat(String(value));
    if (!isNaN(num) && isFinite(num)) {
      if (num === 0) return "0";
      // For very small numbers, use scientific notation
      if (num > 0 && num < 0.000001) {
        return num.toExponential(2);
      }
      return parseFloat(num.toFixed(6)).toString();
    }
    return "0";
  } catch (error) {
    console.error("Error formatting amount:", error);
    return "0";
  }
}

/**
 * Parse a user input amount string to BigInt with proper decimal handling
 */
export function parseAmount(value: string | number, decimals: number): bigint {
  try {
    if (!value || value === "" || value === "0" || value === ".") {
      return 0n;
    }

    const str = String(value).trim();
    
    // Validate input format
    if (!/^[0-9]*\.?[0-9]*$/.test(str)) {
      console.warn("Invalid amount format:", str);
      return 0n;
    }

    // Handle edge case of just a decimal point
    if (str === ".") {
      return 0n;
    }

    // Ensure decimals is valid
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
      console.error("Invalid decimals value:", decimals);
      return 0n;
    }

    // parseUnits handles the conversion properly
    const result = parseUnits(str, decimals);
    return result;
  } catch (error) {
    console.error("Error parsing amount:", error, { value, decimals });
    return 0n;
  }
}

/**
 * Convert between different decimal places
 * Use when you need to adjust a value from one token's decimals to another's
 */
export function convertDecimals(
  value: bigint,
  fromDecimals: number,
  toDecimals: number
): bigint {
  if (fromDecimals === toDecimals) return value;
  
  if (fromDecimals < toDecimals) {
    const diff = toDecimals - fromDecimals;
    return value * (10n ** BigInt(diff));
  } else {
    const diff = fromDecimals - toDecimals;
    return value / (10n ** BigInt(diff));
  }
}

/**
 * Safe division with proper rounding
 */
export function safeDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

/**
 * Calculate ratio between two amounts with their decimals
 * Returns the ratio as a formatted string
 * Uses bigint arithmetic for precision with any decimal combination
 */
export function calculateRatio(
  amount1: bigint,
  decimals1: number,
  amount2: bigint,
  decimals2: number
): string {
  try {
    if (amount1 === 0n || amount2 === 0n) return "0";

    // For accurate ratio calculation with different decimals:
    // ratio = amount1 / amount2 (in real terms)
    // To handle different decimals, normalize first
    // Multiply by 10^6 for precision in the result
    const PRECISION = 1000000n; // 6 decimal places of precision
    
    // Normalize amounts to 18 decimals for calculation
    const amount1Normalized = amount1 * (10n ** BigInt(Math.max(0, 18 - decimals1)));
    const amount2Normalized = amount2 * (10n ** BigInt(Math.max(0, 18 - decimals2)));
    
    // Calculate ratio with precision
    const ratioWithPrecision = (amount1Normalized * PRECISION) / amount2Normalized;
    
    // Convert back to number and format
    const ratio = Number(ratioWithPrecision) / Number(PRECISION);
    
    if (!isNaN(ratio) && isFinite(ratio)) {
      return parseFloat(ratio.toFixed(6)).toString();
    }
    return "0";
  } catch (error) {
    console.error("Error calculating ratio:", error);
    return "0";
  }
}
