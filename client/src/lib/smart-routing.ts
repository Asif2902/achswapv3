import { Contract, type Provider } from "ethers";
import { Token } from "@shared/schema";
import { parseAmount } from "./decimal-utils";
import { QUOTER_V2_ABI, V3_FEE_TIERS } from "./abis/v3";
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
  priceImpact: number;
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

    const testIn = 10_000_000_000n; // 1e10

    // Try both paths in parallel
    const [directResult, hopResult] = await Promise.allSettled([
      (async () => {
        const amounts = await router.getAmountsOut(amountIn, directPath);
        const outputAmount = amounts[amounts.length - 1];
        if (outputAmount === 0n) throw new Error("zero output");
        const spotAmounts = await router.getAmountsOut(testIn, directPath);
        const spotOut = spotAmounts[spotAmounts.length - 1];
        let priceImpact = 0;
        if (spotOut > 0n) {
          const num = spotOut * amountIn - outputAmount * testIn;
          if (num > 0n) priceImpact = Number((num * 10000n) / (spotOut * amountIn)) / 100;
        }
        return { outputAmount, path: directPath, priceImpact };
      })(),
      hopPath.length !== directPath.length
        ? (async () => {
            const amounts = await router.getAmountsOut(amountIn, hopPath);
            const outputAmount = amounts[amounts.length - 1];
            if (outputAmount === 0n) throw new Error("zero output");
            const spotAmounts = await router.getAmountsOut(testIn, hopPath);
            const spotOut = spotAmounts[spotAmounts.length - 1];
            let priceImpact = 0;
            if (spotOut > 0n) {
              const num = spotOut * amountIn - outputAmount * testIn;
              if (num > 0n) priceImpact = Number((num * 10000n) / (spotOut * amountIn)) / 100;
            }
            return { outputAmount, path: hopPath, priceImpact };
          })()
        : Promise.reject(),
    ]);

    const direct = directResult.status === "fulfilled" ? directResult.value : null;
    const hop = hopResult.status === "fulfilled" ? hopResult.value : null;

    let bestOutputAmount: bigint | null = null;
    let bestPath: string[] = [];
    let bestPriceImpact = 0;

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
  wrappedTokenAddress?: string
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

    const testIn = 10_000_000_000n; // 1e10 — used for price impact

    // ── Single-hop: all 5 fee tiers in parallel ────────────────────────────────
    const singleHopPromises = feeTiers.map(async (fee) => {
      try {
        const [actualResult, spotResult] = await Promise.all([
          quoter.quoteExactInputSingle.staticCall({
            tokenIn: fromERC20,
            tokenOut: toERC20,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          }),
          quoter.quoteExactInputSingle.staticCall({
            tokenIn: fromERC20,
            tokenOut: toERC20,
            amountIn: testIn,
            fee,
            sqrtPriceLimitX96: 0n,
          }),
        ]);
        const outputAmount = actualResult[0];
        const gasEstimate = actualResult[3];
        const spotOut = spotResult[0];

        let priceImpact = 0;
        if (spotOut > 0n) {
          const num = spotOut * amountIn - outputAmount * testIn;
          if (num > 0n) {
            priceImpact = Number((num * 10000n) / (spotOut * amountIn)) / 100;
          }
        }

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
          const [actualResult, spotResult] = await Promise.all([
            quoter.quoteExactInput.staticCall(path, amountIn),
            quoter.quoteExactInput.staticCall(path, testIn),
          ]);
          const outputAmount = actualResult[0];
          const gasEstimate = actualResult[3];
          const spotOut = spotResult[0];

          let priceImpact = 0;
          if (spotOut > 0n) {
            const num = spotOut * amountIn - outputAmount * testIn;
            if (num > 0n) {
              priceImpact = Number((num * 10000n) / (spotOut * amountIn)) / 100;
            }
          }

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
      priceImpact: number;
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
      priceImpact: number;
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
      return {
        protocol: "V3",
        outputAmount: bestMultiHop.outputAmount,
        gasEstimate: bestMultiHop.gasEstimate,
        priceImpact: bestMultiHop.priceImpact,
        route: [
          {
            tokenIn: fromToken,
            tokenOut: {
              address: wrappedTokenAddress,
              symbol: "wUSDC",
              name: "Wrapped USDC",
              decimals: 18,
              logoURI: "/img/logos/wusdc.png",
              verified: true,
              chainId: fromToken.chainId,
            } as Token,
            protocol: "V3",
            fee: bestMultiHop.fee1,
          },
          {
            tokenIn: {
              address: wrappedTokenAddress,
              symbol: "wUSDC",
              name: "Wrapped USDC",
              decimals: 18,
              logoURI: "/img/logos/wusdc.png",
              verified: true,
              chainId: fromToken.chainId,
            } as Token,
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
  wrappedTokenAddress: string,
  v2Enabled: boolean,
  v3Enabled: boolean
): Promise<SmartRoutingResult | null> {
  try {
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
 * Sort tokens by address (required for V3)
 */
function sortTokensByAddress(tokenA: Token, tokenB: Token): [Token, Token] {
  const addressA = tokenA.address.toLowerCase();
  const addressB = tokenB.address.toLowerCase();
  return addressA < addressB ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Helper to get token object for an address in the path
 */
function getTokenForAddress(
  address: string,
  fromToken: Token,
  toToken: Token,
  wrappedTokenAddress: string
): Token {
  if (address.toLowerCase() === fromToken.address.toLowerCase()) return fromToken;
  if (address.toLowerCase() === toToken.address.toLowerCase()) return toToken;
  
  // Return wrapped token placeholder
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
