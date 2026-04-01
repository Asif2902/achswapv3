import { Contract, type Provider } from "ethers";
import { Token } from "@shared/schema";
import { parseAmount } from "./decimal-utils";
import { QUOTER_V2_ABI, V3_FEE_TIERS } from "./abis/v3";
import { RWA_VAULT_ABI } from "./abis/rwa";
import type { RouteHop } from "@/components/PathVisualizer";

// V2 Router ABI
const V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
];

// Native token address (zero address)
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Check if token is native (zero address)
 */
function isNativeToken(address: string): boolean {
  return address === NATIVE_TOKEN_ADDRESS;
}

/**
 * Get ERC20 address for a token (wraps native to wrapped)
 */
function getERC20Address(tokenAddress: string, wrappedTokenAddress: string): string {
  return isNativeToken(tokenAddress) ? wrappedTokenAddress : tokenAddress;
}

export interface QuoteResult {
  protocol: "V2" | "V3";
  outputAmount: bigint;
  route: RouteHop[];
  priceImpact: number | undefined;
  gasEstimate?: bigint;
}

export interface SmartRoutingResult {
  bestQuote: QuoteResult;
  v2Quote?: QuoteResult;
  v3Quote?: QuoteResult;
  alternativeQuotes?: QuoteResult[]; // For fallback when best quote fails
  timestamp: number; // For freshness check
  inputAmount: bigint; // To verify quote matches current input
}

/**
 * Get V2 quote for a swap - tries direct path first, then fallback to wrapped token route
 */
export async function getV2Quote(
  provider: Provider,
  routerAddress: string,
  fromToken: Token,
  toToken: Token,
  amountIn: bigint,
  wrappedTokenAddress: string
): Promise<QuoteResult | null> {
  try {
    const router = new Contract(routerAddress, V2_ROUTER_ABI, provider);

    const directPath = buildV2Path(fromToken, toToken, wrappedTokenAddress);
    const hopPath = buildV2PathWithHop(fromToken, toToken, wrappedTokenAddress);

    const DECIMALS_SCALE_IN = 10n ** BigInt(fromToken.decimals);
    const DECIMALS_SCALE_OUT = 10n ** BigInt(toToken.decimals);
    const MIN = 10_000n;
    const MAX = 10_000_000_000n;
    const testIn = amountIn > 0n
      ? (() => {
          const probeCandidate = amountIn / 1000n;
          const bounded = probeCandidate < MIN ? MIN : probeCandidate > MAX ? MAX : probeCandidate;
          return bounded > amountIn ? amountIn : bounded;
        })()
      : MIN;

    const calcV2Impact = (spotOut: bigint, outputAmount: bigint): number => {
      if (spotOut === 0n) return Number.NaN;
      // Scale output amounts to same decimal base as input
      const scaledOutputAmount = outputAmount * DECIMALS_SCALE_IN / DECIMALS_SCALE_OUT;
      const scaledSpotOut = spotOut * DECIMALS_SCALE_IN / DECIMALS_SCALE_OUT;
      const num = scaledSpotOut * amountIn - scaledOutputAmount * testIn;
      if (num <= 0n) return 0;
      return Number((num * 10000n) / (scaledSpotOut * amountIn)) / 100;
    };

    const [directResult, hopResult] = await Promise.allSettled([
      (async () => {
        const amounts = await router.getAmountsOut(amountIn, directPath);
        const outputAmount = amounts[amounts.length - 1];
        if (outputAmount === 0n) throw new Error("zero output");
        let priceImpact: number | undefined;
        try {
          const spotAmounts = await router.getAmountsOut(testIn, directPath);
          priceImpact = calcV2Impact(spotAmounts[spotAmounts.length - 1], outputAmount);
        } catch { /* probe failed — impact unavailable */ }
        return { outputAmount, path: directPath, priceImpact };
      })(),
      hopPath.length !== directPath.length
        ? (async () => {
            const amounts = await router.getAmountsOut(amountIn, hopPath);
            const outputAmount = amounts[amounts.length - 1];
            if (outputAmount === 0n) throw new Error("zero output");
            let priceImpact: number | undefined;
            try {
              const spotAmounts = await router.getAmountsOut(testIn, hopPath);
              priceImpact = calcV2Impact(spotAmounts[spotAmounts.length - 1], outputAmount);
            } catch { /* probe failed — impact unavailable */ }
            return { outputAmount, path: hopPath, priceImpact };
          })()
        : Promise.resolve(null),
    ]);

    const direct = directResult.status === "fulfilled" ? directResult.value : null;
    const hop = hopResult.status === "fulfilled" ? hopResult.value : null;

    let bestOutputAmount: bigint | null = null;
    let bestPath: string[] = [];
    let bestPriceImpact: number | undefined;

    if (direct && (!bestOutputAmount || direct.outputAmount > bestOutputAmount)) {
      bestOutputAmount = direct.outputAmount;
      bestPath = direct.path;
      bestPriceImpact = direct.priceImpact;
    }
    if (hop && (!bestOutputAmount || hop.outputAmount > bestOutputAmount)) {
      bestOutputAmount = hop.outputAmount;
      bestPath = hop.path;
      bestPriceImpact = hop.priceImpact;
    }

    if (!bestOutputAmount || bestPath.length === 0) return null;

    const route: RouteHop[] = [];
    for (let i = 0; i < bestPath.length - 1; i++) {
      route.push({
        tokenIn: i === 0 ? fromToken : getTokenForAddress(bestPath[i], fromToken, toToken, wrappedTokenAddress),
        tokenOut: i === bestPath.length - 2 ? toToken : getTokenForAddress(bestPath[i + 1], fromToken, toToken, wrappedTokenAddress),
        protocol: "V2",
      });
    }

    return {
      protocol: "V2",
      outputAmount: bestOutputAmount,
      route,
      priceImpact: bestPriceImpact,
    };
  } catch (error) {
    console.error("V2 quote failed:", error);
    return null;
  }
}

/**
 * Get V3 quote for a swap (single-hop and multi-hop)
 * V3 only works with ERC20 tokens, so native tokens must use wrapped address
 * All fee tier queries run in parallel for maximum speed.
 */
export async function getV3Quote(
  provider: Provider,
  quoterAddress: string,
  fromToken: Token,
  toToken: Token,
  amountIn: bigint,
  wrappedTokenAddress: string
): Promise<QuoteResult | null> {
  try {
    if (!wrappedTokenAddress) {
      console.warn("Wrapped token address required for V3 quotes");
      return null;
    }

    if (fromToken.address.toLowerCase() === toToken.address.toLowerCase()) {
      return null;
    }

    const quoter = new Contract(quoterAddress, QUOTER_V2_ABI, provider);
    const { encodePath } = await import("./v3-utils");

    const feeTiers = [
      V3_FEE_TIERS.LOWEST,
      V3_FEE_TIERS.LOW,
      V3_FEE_TIERS.MEDIUM,
      V3_FEE_TIERS.HIGH,
      V3_FEE_TIERS.ULTRA_HIGH,
    ];

    const fromERC20 = getERC20Address(fromToken.address, wrappedTokenAddress);
    const toERC20 = getERC20Address(toToken.address, wrappedTokenAddress);

    const DECIMALS_SCALE_IN = 10n ** BigInt(fromToken.decimals);
    const DECIMALS_SCALE_OUT = 10n ** BigInt(toToken.decimals);
    const MIN = 10_000n;
    const MAX = 10_000_000_000n;
    const testIn = amountIn > 0n
      ? (() => {
          const probeCandidate = amountIn / 1000n;
          return probeCandidate < MIN ? MIN : probeCandidate > MAX ? MAX : probeCandidate;
        })()
      : MIN;

    const calcV3Impact = (spotOut: bigint, outputAmount: bigint): number => {
      if (spotOut === 0n) return Number.NaN;
      // Scale output amounts to same decimal base as input
      const scaledOutputAmount = outputAmount * DECIMALS_SCALE_IN / DECIMALS_SCALE_OUT;
      const scaledSpotOut = spotOut * DECIMALS_SCALE_IN / DECIMALS_SCALE_OUT;
      const num = scaledSpotOut * amountIn - scaledOutputAmount * testIn;
      if (num <= 0n) return 0;
      return Number((num * 10000n) / (scaledSpotOut * amountIn)) / 100;
    };

    // ── Single-hop: all 5 fee tiers in parallel ────────────────────────────────
    const singleHopPromises = feeTiers.map(async (fee) => {
      try {
        const actualResult = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: fromERC20,
          tokenOut: toERC20,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        const outputAmount = actualResult[0];
        const gasEstimate = actualResult[3];

        let priceImpact: number | undefined;
        try {
          const spotResult = await quoter.quoteExactInputSingle.staticCall({
            tokenIn: fromERC20,
            tokenOut: toERC20,
            amountIn: testIn,
            fee,
            sqrtPriceLimitX96: 0n,
          });
          priceImpact = calcV3Impact(spotResult[0], outputAmount);
        } catch { /* probe failed — impact unavailable */ }

        return { fee, outputAmount, gasEstimate, priceImpact, isMultiHop: false };
      } catch {
        return null;
      }
    });

    // ── Multi-hop: all 25 (fee1 × fee2) combos in parallel ────────────────────
    const multiHopPromises = feeTiers.flatMap((fee1) =>
      feeTiers.map(async (fee2) => {
        try {
          const path = encodePath([fromERC20, wrappedTokenAddress, toERC20], [fee1, fee2]);
          const actualResult = await quoter.quoteExactInput.staticCall(path, amountIn);
          const outputAmount = actualResult[0];
          const gasEstimate = actualResult[3];

          let priceImpact: number | undefined;
          try {
            const spotResult = await quoter.quoteExactInput.staticCall(path, testIn);
            priceImpact = calcV3Impact(spotResult[0], outputAmount);
          } catch { /* probe failed — impact unavailable */ }

          return { fee1, fee2, path, outputAmount, gasEstimate, priceImpact };
        } catch {
          return null;
        }
      })
    );

    // Run both in parallel
    const [singleHopResults, multiHopResults] = await Promise.all([
      Promise.all(singleHopPromises),
      Promise.all(multiHopPromises),
    ]);

    // Find best single-hop
    let best: {
      outputAmount: bigint;
      gasEstimate: bigint;
      priceImpact: number | undefined;
      fee: number;
      isMultiHop: false;
    } | null = null;

    for (const r of singleHopResults) {
      if (r && (!best || r.outputAmount > best.outputAmount)) {
        best = { ...r, isMultiHop: false };
      }
    }

    // Find best multi-hop
    let bestMultiHop: {
      outputAmount: bigint;
      gasEstimate: bigint;
      priceImpact: number | undefined;
      fee1: number;
      fee2: number;
      path: string;
    } | null = null;

    for (const r of multiHopResults) {
      if (r && (!bestMultiHop || r.outputAmount > bestMultiHop.outputAmount)) {
        bestMultiHop = r;
      }
    }

    // Choose overall best (single-hop vs multi-hop)
    if (best && bestMultiHop && bestMultiHop.outputAmount > best.outputAmount) {
      const wrappedToken = getTokenForAddress(wrappedTokenAddress, fromToken, toToken, wrappedTokenAddress);
      return {
        protocol: "V3",
        outputAmount: bestMultiHop.outputAmount,
        gasEstimate: bestMultiHop.gasEstimate,
        priceImpact: bestMultiHop.priceImpact,
        route: [
          {
            tokenIn: fromToken,
            tokenOut: wrappedToken,
            protocol: "V3",
            fee: bestMultiHop.fee1,
          },
          {
            tokenIn: wrappedToken,
            tokenOut: toToken,
            protocol: "V3",
            fee: bestMultiHop.fee2,
          },
        ],
      };
    }

    if (best) {
      return {
        protocol: "V3",
        outputAmount: best.outputAmount,
        gasEstimate: best.gasEstimate,
        priceImpact: best.priceImpact,
        route: [{
          tokenIn: fromToken,
          tokenOut: toToken,
          protocol: "V3",
          fee: best.fee,
        }],
      };
    }

    return null;
  } catch (error) {
    console.error("V3 quote failed:", error);
    return null;
  }
}

/**
 * Get best quote from V2 and V3
 */
export async function getSmartRouteQuote(
  provider: Provider,
  v2RouterAddress: string,
  v3QuoterAddress: string,
  fromToken: Token,
  toToken: Token,
  amountIn: bigint,
  wrappedToken: Token,
  v2Enabled: boolean,
  v3Enabled: boolean
): Promise<SmartRoutingResult | null> {
  try {
    const wrappedTokenAddress = wrappedToken.address;
    const quotes = await Promise.allSettled([
      v2Enabled ? getV2Quote(provider, v2RouterAddress, fromToken, toToken, amountIn, wrappedTokenAddress) : Promise.resolve(null),
      v3Enabled ? getV3Quote(provider, v3QuoterAddress, fromToken, toToken, amountIn, wrappedTokenAddress) : Promise.resolve(null),
    ]);
    
    const v2Quote = quotes[0].status === "fulfilled" ? quotes[0].value : null;
    const v3Quote = quotes[1].status === "fulfilled" ? quotes[1].value : null;
    
    // Choose best quote
    let bestQuote: QuoteResult | null = null;
    const alternativeQuotes: QuoteResult[] = [];
    
    if (v2Quote && v3Quote) {
      if (v2Quote.outputAmount > v3Quote.outputAmount) {
        bestQuote = v2Quote;
        alternativeQuotes.push(v3Quote);
      } else {
        bestQuote = v3Quote;
        alternativeQuotes.push(v2Quote);
      }
    } else if (v2Quote) {
      bestQuote = v2Quote;
    } else if (v3Quote) {
      bestQuote = v3Quote;
    }
    
    if (!bestQuote) {
      return null;
    }
    
    return {
      bestQuote,
      v2Quote: v2Quote || undefined,
      v3Quote: v3Quote || undefined,
      alternativeQuotes,
      timestamp: Date.now(),
      inputAmount: amountIn,
    };
  } catch (error) {
    console.error("Smart routing failed:", error);
    return null;
  }
}

/**
 * Build V2 path (try direct path first, then through wrapped token as fallback)
 */
function buildV2Path(
  fromToken: Token,
  toToken: Token,
  wrappedTokenAddress: string
): string[] {
  const isFromNative = fromToken.address === "0x0000000000000000000000000000000000000000";
  const isToNative = toToken.address === "0x0000000000000000000000000000000000000000";
  
  const fromAddress = isFromNative ? wrappedTokenAddress : fromToken.address;
  const toAddress = isToNative ? wrappedTokenAddress : toToken.address;
  
  // If one is wrapped token, use direct path
  if (fromAddress === wrappedTokenAddress || toAddress === wrappedTokenAddress) {
    return [fromAddress, toAddress];
  }
  
  // Try direct path first (most efficient if direct pair exists)
  // Return direct path - the caller should try this first, then fallback to multi-hop
  return [fromAddress, toAddress];
}

/**
 * Build V2 path with intermediate hop through wrapped token
 */
function buildV2PathWithHop(
  fromToken: Token,
  toToken: Token,
  wrappedTokenAddress: string
): string[] {
  const isFromNative = fromToken.address === "0x0000000000000000000000000000000000000000";
  const isToNative = toToken.address === "0x0000000000000000000000000000000000000000";
  
  const fromAddress = isFromNative ? wrappedTokenAddress : fromToken.address;
  const toAddress = isToNative ? wrappedTokenAddress : toToken.address;
  
  // Route through wrapped token
  return [fromAddress, wrappedTokenAddress, toAddress];
}

/**
 */
function getTokenForAddress(
  address: string,
  fromToken: Token,
  toToken: Token,
  wrappedTokenAddress: string
): Token {
  if (address.toLowerCase() === fromToken.address.toLowerCase()) return fromToken;
  if (address.toLowerCase() === toToken.address.toLowerCase()) return toToken;
  
  return {
    address: wrappedTokenAddress,
    symbol: "wUSDC",
    name: "Wrapped USDC",
    decimals: 18,
    logoURI: "/img/logos/wusdc.png",
    verified: true,
    chainId: fromToken.chainId,
  };
}

// ── RWA Vault Routing ─────────────────────────────────────────────────────────

export interface RWAQuoteResult {
  protocol: "RWA";
  outputAmount: bigint;
  route: RouteHop[];
  priceImpact: number;
  fee: bigint;
  price: bigint;
  isStale: boolean;
  reserveOk: boolean;
  pairId: number;
  isBuy: boolean; // true = USDC→RWA, false = RWA→USDC
}

/**
 * Get RWA quote for USDC→RWA (buy) or RWA→USDC (redeem)
 */
export async function getRWAQuote(
  provider: Provider,
  vaultAddress: string,
  fromToken: Token,
  toToken: Token,
  amountIn: bigint
): Promise<RWAQuoteResult | null> {
  try {
    const vault = new Contract(vaultAddress, RWA_VAULT_ABI, provider);
    const isBuy = !fromToken.rwa && !!toToken.rwa; // USDC→RWA
    const rwaToken = isBuy ? toToken : fromToken;
    const pairId = rwaToken.rwaPairId;

    if (!pairId) {
      console.warn("RWA token missing pairId:", rwaToken.symbol);
      return null;
    }

    if (isBuy) {
      // quoteBuy(pairId, usdcIn) returns (synthOut, fee, netUsdc, price, isStale)
      const result = await vault.quoteBuy(pairId, amountIn);
      const synthOut = result[0];
      const fee = result[1];
      const price = result[3];
      const isStale = result[4];

      const netUsdc = amountIn - fee;
      // Price impact is 0 for vault swaps (no slippage from pool depth, only fee)
      // But we show fee impact for transparency
      const priceImpact = amountIn > 0n ? Number((fee * 10000n) / amountIn) / 100 : 0;

      return {
        protocol: "RWA",
        outputAmount: synthOut,
        route: [{
          tokenIn: fromToken,
          tokenOut: toToken,
          protocol: "RWA" as any,
        }],
        priceImpact,
        fee,
        price,
        isStale,
        reserveOk: true,
        pairId,
        isBuy: true,
      };
    } else {
      // Redeem: quoteRedeem(pairId, synthAmount) returns (usdcOut, fee, grossUsdc, price, isStale, reserveOk)
      const result = await vault.quoteRedeem(pairId, amountIn);
      const usdcOut = result[0];
      const fee = result[1];
      const price = result[3];
      const isStale = result[4];
      const reserveOk = result[5];

      const priceImpact = usdcOut > 0n ? Number((fee * 10000n) / (usdcOut + fee)) / 100 : 0;

      return {
        protocol: "RWA",
        outputAmount: usdcOut,
        route: [{
          tokenIn: fromToken,
          tokenOut: toToken,
          protocol: "RWA" as any,
        }],
        priceImpact,
        fee,
        price,
        isStale,
        reserveOk,
        pairId,
        isBuy: false,
      };
    }
  } catch (error) {
    console.error("RWA quote failed:", error);
    return null;
  }
}
