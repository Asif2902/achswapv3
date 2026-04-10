import { Contract, type Provider } from "ethers";
import { Token } from "@shared/schema";
import { QUOTER_V2_ABI, V3_FEE_TIERS } from "./abis/v3";
import { RWA_VAULT_ABI } from "./abis/rwa";
import type { RouteHop } from "@/components/PathVisualizer";
import { isCanonicalUSDC } from "@/data/tokens";
import { encodePath } from "./v3-utils";

// V2 Router ABI
const V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
];

// Native token address (zero address)
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
const V3_QUOTE_CONCURRENCY = 6;

function getProbeAmount(amountIn: bigint): bigint {
  if (amountIn <= 0n) return 1n;

  const candidate = amountIn / 1000n; // 0.1%
  const minProbe = amountIn / 10_000n; // 0.01%
  const maxProbe = amountIn / 10n; // 10%

  const lowerBound = minProbe > 0n ? minProbe : 1n;
  const upperBound = maxProbe > 0n ? maxProbe : amountIn;

  let probe = candidate;
  if (probe < lowerBound) probe = lowerBound;
  if (probe > upperBound) probe = upperBound;
  if (probe > amountIn) probe = amountIn;

  return probe > 0n ? probe : 1n;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (items.length === 0) return [];

  const normalizedConcurrency = Number.isFinite(concurrency)
    ? Math.max(1, Math.floor(concurrency))
    : 1;

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from(
    { length: Math.min(normalizedConcurrency, items.length) },
    async () => {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          return;
        }
        results[currentIndex] = await worker(items[currentIndex]);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

function hasAdjacentDuplicateAddresses(path: string[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    if (path[i].toLowerCase() === path[i + 1].toLowerCase()) {
      return true;
    }
  }
  return false;
}

function isSameAssetPath(path: string[]): boolean {
  if (path.length < 2) return false;
  return path[0].toLowerCase() === path[path.length - 1].toLowerCase();
}

function isTransientError(error: unknown): boolean {
  if (!error) return false;

  const maybeError = error as {
    code?: unknown;
    message?: unknown;
    reason?: unknown;
    shortMessage?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    error?: { code?: unknown; message?: unknown; status?: unknown };
    info?: { error?: { message?: unknown } };
  };

  const rawCode = maybeError.code ?? maybeError.error?.code;
  const code = typeof rawCode === "string" ? rawCode.toUpperCase() : "";

  const statusRaw =
    maybeError.status ??
    maybeError.statusCode ??
    maybeError.response?.status ??
    maybeError.error?.status;
  const status = typeof statusRaw === "number" ? statusRaw : Number.NaN;

  const message = [
    maybeError.message,
    maybeError.reason,
    maybeError.shortMessage,
    maybeError.error?.message,
    maybeError.info?.error?.message,
  ]
    .map((part) => (typeof part === "string" ? part.toLowerCase() : ""))
    .join(" ");

  if (
    message.includes("execution reverted") ||
    message.includes("revert") ||
    message.includes("pool-missing") ||
    message.includes("unsupported-fee") ||
    code === "CALL_EXCEPTION"
  ) {
    return false;
  }

  if ([408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "SERVER_ERROR" ||
    code === "TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }

  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("service unavailable") ||
    message.includes("temporarily unavailable") ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("connection reset") ||
    message.includes("socket hang up") ||
    message.includes("503") ||
    message.includes("429") ||
    message.includes("408")
  );
}

async function quoteWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 80,
  signal?: AbortSignal,
): Promise<T> {
  let lastTransientError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const transient = isTransientError(err);
      if (!transient) {
        throw err;
      }

      lastTransientError = err;
      if (attempt === maxRetries) {
        break;
      }

      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(undefined);
        }, baseDelayMs * (attempt + 1));
        const onAbort = () => {
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", onAbort);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  throw lastTransientError;
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
  wrappedToken: Token,
  signal?: AbortSignal,
): Promise<QuoteResult | null> {
  try {
    const router = new Contract(routerAddress, V2_ROUTER_ABI, provider);
    const wrappedTokenAddress = wrappedToken.address;

    const directPath = buildV2Path(fromToken, toToken, wrappedTokenAddress);
    const hopPath = buildV2PathWithHop(fromToken, toToken, wrappedTokenAddress);

    const testIn = getProbeAmount(amountIn);

    const calcV2Impact = (spotOut: bigint, outputAmount: bigint): number => {
      if (spotOut === 0n) return Number.NaN;
      const num = spotOut * amountIn - outputAmount * testIn;
      if (num <= 0n) return 0;
      return Number((num * 10000n) / (spotOut * amountIn)) / 100;
    };

    const isSameAssetDirectPath = isSameAssetPath(directPath);
    const shouldProbeHopPath =
      !isSameAssetDirectPath &&
      hopPath.length !== directPath.length &&
      !hasAdjacentDuplicateAddresses(hopPath);

    const [directResult, hopResult] = await Promise.allSettled([
      quoteWithRetry(() => router.getAmountsOut(amountIn, directPath), 2, 80, signal),
      shouldProbeHopPath
        ? quoteWithRetry(() => router.getAmountsOut(amountIn, hopPath), 2, 80, signal)
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
        const spotAmounts = await quoteWithRetry(() => router.getAmountsOut(testIn, bestPath), 2, 80, signal);
        const probeImpact = calcV2Impact(spotAmounts[spotAmounts.length - 1], bestOutputAmount);
        bestPriceImpact = Number.isFinite(probeImpact) ? probeImpact : undefined;
      } catch {
        // probe failed — impact unavailable
      }
    }

    if (!bestOutputAmount || bestPath.length === 0) return null;

    const route: RouteHop[] = [];
    for (let i = 0; i < bestPath.length - 1; i++) {
      route.push({
        tokenIn: i === 0 ? fromToken : getTokenForAddress(bestPath[i], fromToken, toToken, wrappedToken),
        tokenOut: i === bestPath.length - 2 ? toToken : getTokenForAddress(bestPath[i + 1], fromToken, toToken, wrappedToken),
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
  wrappedToken: Token,
  signal?: AbortSignal,
): Promise<QuoteResult | null> {
  try {
    const wrappedTokenAddress = wrappedToken.address;
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

    const testIn = getProbeAmount(amountIn);

    const calcV3Impact = (spotOut: bigint, outputAmount: bigint): number => {
      if (spotOut === 0n) return Number.NaN;
      const num = spotOut * amountIn - outputAmount * testIn;
      if (num <= 0n) return 0;
      return Number((num * 10000n) / (spotOut * amountIn)) / 100;
    };

    // ── Single-hop: capped concurrency across fee tiers ────────────────────────
    const singleHopResults = await mapWithConcurrency(feeTiers, V3_QUOTE_CONCURRENCY, async (fee) => {
      try {
        const actualResult = await quoteWithRetry(() =>
          quoter.quoteExactInputSingle.staticCall({
            tokenIn: fromERC20,
            tokenOut: toERC20,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          }),
          2,
          80,
          signal,
        );
        return {
          fee,
          outputAmount: actualResult[0] as bigint,
          gasEstimate: actualResult[3] as bigint,
        };
      } catch {
        return null;
      }
    }, signal);

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

    const multiHopResults = await mapWithConcurrency(
      multiHopCandidates,
      V3_QUOTE_CONCURRENCY,
      async ({ fee1, fee2, path }) => {
      try {
        const actualResult = await quoteWithRetry(() => quoter.quoteExactInput.staticCall(path, amountIn), 2, 80, signal);
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
      },
      signal,
    );

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
        const spotResult = await quoteWithRetry(() => quoter.quoteExactInput.staticCall(bestMultiHop.path, testIn), 2, 80, signal);
        const probeImpact = calcV3Impact(spotResult[0], bestMultiHop.outputAmount);
        priceImpact = Number.isFinite(probeImpact) ? probeImpact : undefined;
      } else if (bestSingle) {
        const spotResult = await quoteWithRetry(() =>
          quoter.quoteExactInputSingle.staticCall({
            tokenIn: fromERC20,
            tokenOut: toERC20,
            amountIn: testIn,
            fee: bestSingle.fee,
            sqrtPriceLimitX96: 0n,
          }),
          2,
          80,
          signal,
        );
        const probeImpact = calcV3Impact(spotResult[0], bestSingle.outputAmount);
        priceImpact = Number.isFinite(probeImpact) ? probeImpact : undefined;
      }
    } catch {
      // probe failed — impact unavailable
    }

    if (useMultiHop && bestMultiHop) {
      const wrappedIntermediateToken = getTokenForAddress(
        wrappedTokenAddress,
        fromToken,
        toToken,
        wrappedToken,
      );
      return {
        protocol: "V3",
        outputAmount: bestMultiHop.outputAmount,
        gasEstimate: bestMultiHop.gasEstimate,
        priceImpact,
        route: [
          {
            tokenIn: fromToken,
            tokenOut: wrappedIntermediateToken,
            protocol: "V3",
            fee: bestMultiHop.fee1,
          },
          {
            tokenIn: wrappedIntermediateToken,
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
  v3Enabled: boolean,
  signal?: AbortSignal,
): Promise<SmartRoutingResult | null> {
  try {
    const quotes = await Promise.allSettled([
      v2Enabled ? getV2Quote(provider, v2RouterAddress, fromToken, toToken, amountIn, wrappedToken, signal) : Promise.resolve(null),
      v3Enabled ? getV3Quote(provider, v3QuoterAddress, fromToken, toToken, amountIn, wrappedToken, signal) : Promise.resolve(null),
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
  wrappedToken: Token,
): Token {
  if (address.toLowerCase() === fromToken.address.toLowerCase()) return fromToken;
  if (address.toLowerCase() === toToken.address.toLowerCase()) return toToken;

  return wrappedToken;
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
  amountIn: bigint,
  signal?: AbortSignal,
): Promise<RWAQuoteResult | null> {
  try {
    const vault = new Contract(vaultAddress, RWA_VAULT_ABI, provider);
    const fromIsRWA = !!fromToken.rwa;
    const toIsRWA = !!toToken.rwa;
    if (fromIsRWA === toIsRWA) {
      console.warn("Invalid RWA quote direction:", fromToken.symbol, "->", toToken.symbol);
      return null;
    }
    const settlementToken = fromIsRWA ? toToken : fromToken;
    if (!isCanonicalUSDC(settlementToken)) {
      console.warn(
        "Invalid RWA settlement token:",
        settlementToken.symbol,
        settlementToken.address,
      );
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
      const result = await quoteWithRetry(() => vault.quoteBuy(pairId, amountIn), 2, 80, signal);
      const synthOut = result[0];
      if (synthOut <= 0n) {
        return null;
      }
      const fee = result[1];
      const netUsdc = result[2];
      const price = result[3];
      const isStale = result[4];

      // Price impact is 0 for vault swaps (no slippage from pool depth, only fee)
      // But we show fee impact for transparency
      const grossUsdc = netUsdc + fee;
      const priceImpact = netUsdc > 0n ? Number((fee * 10000n) / grossUsdc) / 100 : 0;

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
      const result = await quoteWithRetry(() => vault.quoteRedeem(pairId, amountIn), 2, 80, signal);
      const usdcOut = result[0];
      if (usdcOut <= 0n) {
        return null;
      }
      const fee = result[1];
      const grossUsdc = result[2];
      const price = result[3];
      const isStale = result[4];
      const reserveOk = result[5];

      const priceImpact = grossUsdc > 0n ? Number((fee * 10000n) / grossUsdc) / 100 : 0;

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
