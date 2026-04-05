import { Contract, type Provider } from "ethers";
import { Token } from "@shared/schema";
import { QUOTER_V2_ABI, V3_FEE_TIERS } from "./abis/v3";
import { RWA_VAULT_ABI } from "./abis/rwa";
import type { RouteHop } from "@/components/PathVisualizer";
import { encodePath } from "./v3-utils";

// V2 Router ABI
const V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
];

// Native token address (zero address)
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

async function quoteWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 80,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

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
      const num = spotOut * amountIn - outputAmount * testIn;
      if (num <= 0n) return 0;
      return Number((num * 10000n) / (spotOut * amountIn)) / 100;
    };

    const [directResult, hopResult] = await Promise.allSettled([
      quoteWithRetry(() => router.getAmountsOut(amountIn, directPath)),
      hopPath.length !== directPath.length
        ? quoteWithRetry(() => router.getAmountsOut(amountIn, hopPath))
        : Promise.resolve(null),
    ]);

    let bestOutputAmount: bigint | null = null;
    let bestPath: string[] = [];

    if (directResult.status === "fulfilled" && directResult.value) {
      const outputAmount = directResult.value[directResult.value.length - 1];
      if (outputAmount > 0n) {
        bestOutputAmount = outputAmount;
        bestPath = directPath;
      }
    }

    if (hopResult.status === "fulfilled" && hopResult.value) {
      const outputAmount = hopResult.value[hopResult.value.length - 1];
      if (outputAmount > 0n && (!bestOutputAmount || outputAmount > bestOutputAmount)) {
        bestOutputAmount = outputAmount;
        bestPath = hopPath;
      }
    }

    let bestPriceImpact: number | undefined;
    if (bestOutputAmount && bestPath.length > 0) {
      try {
        const spotAmounts = await quoteWithRetry(() => router.getAmountsOut(testIn, bestPath));
        bestPriceImpact = calcV2Impact(spotAmounts[spotAmounts.length - 1], bestOutputAmount);
      } catch {
        // probe failed — impact unavailable
      }
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

    const feeTiers = [
      V3_FEE_TIERS.LOWEST,
      V3_FEE_TIERS.LOW,
      V3_FEE_TIERS.MEDIUM,
      V3_FEE_TIERS.HIGH,
      V3_FEE_TIERS.ULTRA_HIGH,
    ];

    const fromERC20 = getERC20Address(fromToken.address, wrappedTokenAddress);
    const toERC20 = getERC20Address(toToken.address, wrappedTokenAddress);

    const MIN = 10_000n;
    const MAX = 10_000_000_000n;
    const testIn = amountIn > 0n
      ? (() => {
          const probeCandidate = amountIn / 1000n;
          const bounded = probeCandidate < MIN ? MIN : probeCandidate > MAX ? MAX : probeCandidate;
          return bounded > amountIn ? amountIn : bounded;
        })()
      : MIN;

    const calcV3Impact = (spotOut: bigint, outputAmount: bigint): number => {
      if (spotOut === 0n) return Number.NaN;
      const num = spotOut * amountIn - outputAmount * testIn;
      if (num <= 0n) return 0;
      return Number((num * 10000n) / (spotOut * amountIn)) / 100;
    };

    // ── Single-hop: all 5 fee tiers in parallel ────────────────────────────────
    const singleHopPromises = feeTiers.map(async (fee) => {
      try {
        const actualResult = await quoteWithRetry(() =>
          quoter.quoteExactInputSingle.staticCall({
            tokenIn: fromERC20,
            tokenOut: toERC20,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          })
        );
        return {
          fee,
          outputAmount: actualResult[0] as bigint,
          gasEstimate: actualResult[3] as bigint,
        };
      } catch {
        return null;
      }
    });

    const canUseMultiHop =
      fromERC20.toLowerCase() !== wrappedTokenAddress.toLowerCase() &&
      toERC20.toLowerCase() !== wrappedTokenAddress.toLowerCase();

    // ── Multi-hop: all 25 (fee1 × fee2) combos in parallel ────────────────────
    const multiHopCandidates = canUseMultiHop
      ? feeTiers.flatMap((fee1) =>
          feeTiers.map((fee2) => ({
            fee1,
            fee2,
            path: encodePath([fromERC20, wrappedTokenAddress, toERC20], [fee1, fee2]),
          }))
        )
      : [];

    const multiHopPromises = multiHopCandidates.map(async ({ fee1, fee2, path }) => {
      try {
        const actualResult = await quoteWithRetry(() => quoter.quoteExactInput.staticCall(path, amountIn));
        return {
          fee1,
          fee2,
          path,
          outputAmount: actualResult[0] as bigint,
          gasEstimate: actualResult[3] as bigint,
        };
      } catch {
        return null;
      }
    });

    // Run both in parallel
    const [singleHopResults, multiHopResults] = await Promise.all([
      Promise.all(singleHopPromises),
      Promise.all(multiHopPromises),
    ]);

    // Find best single-hop
    let bestSingle: {
      outputAmount: bigint;
      gasEstimate: bigint;
      fee: number;
    } | null = null;

    for (const r of singleHopResults) {
      if (r && r.outputAmount > 0n && (!bestSingle || r.outputAmount > bestSingle.outputAmount)) {
        bestSingle = r;
      }
    }

    // Find best multi-hop
    let bestMultiHop: {
      outputAmount: bigint;
      gasEstimate: bigint;
      fee1: number;
      fee2: number;
      path: string;
    } | null = null;

    for (const r of multiHopResults) {
      if (r && r.outputAmount > 0n && (!bestMultiHop || r.outputAmount > bestMultiHop.outputAmount)) {
        bestMultiHop = r;
      }
    }

    if (!bestSingle && !bestMultiHop) {
      return null;
    }

    const useMultiHop = !!(
      bestMultiHop && (!bestSingle || bestMultiHop.outputAmount > bestSingle.outputAmount)
    );

    let priceImpact: number | undefined;
    try {
      if (useMultiHop && bestMultiHop) {
        const spotResult = await quoteWithRetry(() => quoter.quoteExactInput.staticCall(bestMultiHop.path, testIn));
        priceImpact = calcV3Impact(spotResult[0], bestMultiHop.outputAmount);
      } else if (bestSingle) {
        const spotResult = await quoteWithRetry(() =>
          quoter.quoteExactInputSingle.staticCall({
            tokenIn: fromERC20,
            tokenOut: toERC20,
            amountIn: testIn,
            fee: bestSingle.fee,
            sqrtPriceLimitX96: 0n,
          })
        );
        priceImpact = calcV3Impact(spotResult[0], bestSingle.outputAmount);
      }
    } catch {
      // probe failed — impact unavailable
    }

    if (useMultiHop && bestMultiHop) {
      const wrappedToken = getTokenForAddress(wrappedTokenAddress, fromToken, toToken, wrappedTokenAddress);
      return {
        protocol: "V3",
        outputAmount: bestMultiHop.outputAmount,
        gasEstimate: bestMultiHop.gasEstimate,
        priceImpact,
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

    if (bestSingle) {
      return {
        protocol: "V3",
        outputAmount: bestSingle.outputAmount,
        gasEstimate: bestSingle.gasEstimate,
        priceImpact,
        route: [{
          tokenIn: fromToken,
          tokenOut: toToken,
          protocol: "V3",
          fee: bestSingle.fee,
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
  inputAmount: bigint;
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
    const fromIsRWA = !!fromToken.rwa;
    const toIsRWA = !!toToken.rwa;
    if (fromIsRWA === toIsRWA) {
      console.warn("Invalid RWA quote direction:", fromToken.symbol, "->", toToken.symbol);
      return null;
    }
    const isBuy = !fromToken.rwa && !!toToken.rwa; // USDC→RWA
    const rwaToken = isBuy ? toToken : fromToken;
    const pairId = rwaToken.rwaPairId;

    if (pairId == null) {
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

      // Price impact is 0 for vault swaps (no slippage from pool depth, only fee)
      // But we show fee impact for transparency
      const priceImpact = amountIn > 0n ? Number((fee * 10000n) / amountIn) / 100 : 0;

      return {
        protocol: "RWA",
        inputAmount: amountIn,
        outputAmount: synthOut,
        route: [{
          tokenIn: fromToken,
          tokenOut: toToken,
          protocol: "RWA",
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
        inputAmount: amountIn,
        outputAmount: usdcOut,
        route: [{
          tokenIn: fromToken,
          tokenOut: toToken,
          protocol: "RWA",
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
