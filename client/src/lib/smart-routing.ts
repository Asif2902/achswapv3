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
    
    // Try direct path first (most efficient if direct pair exists)
    const directPath = buildV2Path(fromToken, toToken, wrappedTokenAddress);
    
    let bestOutputAmount: bigint | null = null;
    let bestPath: string[] = [];
    let bestPriceImpact = 0;
    
    // Try direct path
    try {
      const amounts = await router.getAmountsOut(amountIn, directPath);
      const outputAmount = amounts[amounts.length - 1];
      
      if (outputAmount > 0n) {
        bestOutputAmount = outputAmount;
        bestPath = directPath;
        bestPriceImpact = await calculateV2PriceImpact(router, amountIn, outputAmount, directPath);
      }
    } catch (directError) {
      // Direct path doesn't exist, will try multi-hop
      console.log("Direct V2 path not available, trying multi-hop through wrapped token");
    }
    
    // Try multi-hop through wrapped token (if different from direct path)
    const hopPath = buildV2PathWithHop(fromToken, toToken, wrappedTokenAddress);
    if (hopPath.length !== directPath.length) {
      try {
        const amounts = await router.getAmountsOut(amountIn, hopPath);
        const outputAmount = amounts[amounts.length - 1];
        
        // Use this route if it's better than direct path or if direct path failed
        if (outputAmount > 0n && (bestOutputAmount === null || outputAmount > bestOutputAmount)) {
          bestOutputAmount = outputAmount;
          bestPath = hopPath;
          bestPriceImpact = await calculateV2PriceImpact(router, amountIn, outputAmount, hopPath);
        }
      } catch (hopError) {
        // Multi-hop also failed
        console.log("Multi-hop V2 path also not available");
      }
    }
    
    // If no route found, return null
    if (bestOutputAmount === null || bestPath.length === 0) {
      return null;
    }
    
    // Build route hops for visualization
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
    // Check if quoter contract exists
    try {
      const code = await provider.getCode(quoterAddress);
      if (!code || code === "0x" || code === "0x0") {
        console.warn("V3 Quoter contract not found at", quoterAddress);
        return null;
      }
    } catch (codeError) {
      console.warn("Could not verify V3 Quoter contract:", codeError);
      // Continue anyway - the contract call will fail if it doesn't exist
    }

    if (!wrappedTokenAddress) {
      console.warn("Wrapped token address required for V3 quotes");
      return null;
    }

    // Don't try V3 for the same token swap
    if (fromToken.address.toLowerCase() === toToken.address.toLowerCase()) {
      console.warn("Cannot quote same token swap");
      return null;
    }

    const quoter = new Contract(quoterAddress, QUOTER_V2_ABI, provider);
    
    const feeTiers = [
  V3_FEE_TIERS.LOWEST,     // 100
  V3_FEE_TIERS.LOW,        // 500
  V3_FEE_TIERS.MEDIUM,     // 3000
  V3_FEE_TIERS.HIGH,       // 10000
  V3_FEE_TIERS.ULTRA_HIGH, // 100000
];
    
    let bestQuote: QuoteResult | null = null;
    
    // V3 only works with ERC20 tokens - use wrapped address for native tokens
    const fromTokenERC20 = getERC20Address(fromToken.address, wrappedTokenAddress);
    const toTokenERC20 = getERC20Address(toToken.address, wrappedTokenAddress);
    
    // Try single-hop routes for all fee tiers
    for (const fee of feeTiers) {
      try {
        const params = {
          tokenIn: fromTokenERC20,
          tokenOut: toTokenERC20,
          amountIn: amountIn,
          fee: fee,
          sqrtPriceLimitX96: 0n,
        };
        
        const result = await quoter.quoteExactInputSingle.staticCall(params);
        const outputAmount = result[0];
        const gasEstimate = result[3];
        
        if (!bestQuote || outputAmount > bestQuote.outputAmount) {
          const priceImpact = await calculateV3PriceImpact(
            quoter,
            fromTokenERC20,
            toTokenERC20,
            amountIn,
            outputAmount,
            fee
          );
          
          bestQuote = {
            protocol: "V3",
            outputAmount,
            route: [{
              tokenIn: fromToken, // Keep original token for display
              tokenOut: toToken, // Keep original token for display
              protocol: "V3",
              fee,
            }],
            priceImpact,
            gasEstimate,
          };
        }
      } catch (error) {
        // Pool doesn't exist for this fee tier or other error
        continue;
      }
    }
    
    // Try multi-hop routes if needed (through wrapped token)
    // Only if both tokens are not the wrapped token itself
    if (wrappedTokenAddress.toLowerCase() !== fromTokenERC20.toLowerCase() && 
        wrappedTokenAddress.toLowerCase() !== toTokenERC20.toLowerCase()) {
      for (const fee1 of feeTiers) {
        for (const fee2 of feeTiers) {
          try {
            const { encodePath } = await import("./v3-utils");
            const path = encodePath(
              [fromTokenERC20, wrappedTokenAddress, toTokenERC20],
              [fee1, fee2]
            );
            
            const result = await quoter.quoteExactInput.staticCall(path, amountIn);
            const outputAmount = result[0];
            const gasEstimate = result[3];
            
            if (!bestQuote || outputAmount > bestQuote.outputAmount) {
              // Calculate price impact for multi-hop route
              const priceImpact = await calculateV3MultiHopPriceImpact(
                quoter,
                path,
                amountIn,
                outputAmount
              );
              
              bestQuote = {
                protocol: "V3",
                outputAmount,
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
                      chainId: fromToken.chainId
                    } as Token,
                    protocol: "V3",
                    fee: fee1,
                  },
                  {
                    tokenIn: { 
                      address: wrappedTokenAddress, 
                      symbol: "wUSDC", 
                      name: "Wrapped USDC", 
                      decimals: 18,
                      logoURI: "/img/logos/wusdc.png",
                      verified: true,
                      chainId: fromToken.chainId
                    } as Token,
                    tokenOut: toToken,
                    protocol: "V3",
                    fee: fee2,
                  },
                ],
                priceImpact,
                gasEstimate,
              };
            }
          } catch (error) {
            continue;
          }
        }
      }
    }
    
    return bestQuote;
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
      timestamp: Date.now(), // Add timestamp for freshness check
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
 * Calculate V2 price impact using midpoint method
 */
async function calculateV2PriceImpact(
  router: Contract,
  amountIn: bigint,
  outputAmount: bigint,
  path: string[]
): Promise<number> {
  try {
    const halfAmountBigInt = amountIn / 2n;
    
    if (halfAmountBigInt > 0n) {
      const halfAmountQuotes = await router.getAmountsOut(halfAmountBigInt, path);
      const halfAmountOutput = halfAmountQuotes[halfAmountQuotes.length - 1];
      
      const expectedOutput = halfAmountOutput * 2n;
      
      if (expectedOutput > 0n && outputAmount > 0n) {
        const impactBasisPoints = expectedOutput > outputAmount
          ? ((expectedOutput - outputAmount) * 10000n) / expectedOutput
          : ((outputAmount - expectedOutput) * 10000n) / expectedOutput;
        
        return Math.max(0, Math.abs(Number(impactBasisPoints) / 100));
      }
    }
    
    return 0;
  } catch (error) {
    console.error("V2 price impact calculation failed:", error);
    return 0;
  }
}

/**
 * Calculate V3 price impact for single-hop
 */
async function calculateV3PriceImpact(
  quoter: Contract,
  tokenInAddress: string,
  tokenOutAddress: string,
  amountIn: bigint,
  outputAmount: bigint,
  fee: number
): Promise<number> {
  try {
    const halfAmountBigInt = amountIn / 2n;
    
    if (halfAmountBigInt > 0n) {
      const params = {
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        amountIn: halfAmountBigInt,
        fee: fee,
        sqrtPriceLimitX96: 0n,
      };
      
      const result = await quoter.quoteExactInputSingle.staticCall(params);
      const halfAmountOutput = result[0];
      
      const expectedOutput = halfAmountOutput * 2n;
      
      if (expectedOutput > 0n && outputAmount > 0n) {
        const impactBasisPoints = expectedOutput > outputAmount
          ? ((expectedOutput - outputAmount) * 10000n) / expectedOutput
          : ((outputAmount - expectedOutput) * 10000n) / expectedOutput;
        
        return Math.max(0, Math.abs(Number(impactBasisPoints) / 100));
      }
    }
    
    return 0;
  } catch (error) {
    console.error("V3 price impact calculation failed:", error);
    return 0;
  }
}

/**
 * Calculate V3 price impact for multi-hop routes
 */
async function calculateV3MultiHopPriceImpact(
  quoter: Contract,
  encodedPath: string,
  amountIn: bigint,
  outputAmount: bigint
): Promise<number> {
  try {
    const halfAmountBigInt = amountIn / 2n;
    
    if (halfAmountBigInt > 0n) {
      
      const result = await quoter.quoteExactInput.staticCall(encodedPath, halfAmountBigInt);
      const halfAmountOutput = result[0];
      
      const expectedOutput = halfAmountOutput * 2n;
      
      if (expectedOutput > 0n && outputAmount > 0n) {
        const impactBasisPoints = expectedOutput > outputAmount
          ? ((expectedOutput - outputAmount) * 10000n) / expectedOutput
          : ((outputAmount - expectedOutput) * 10000n) / expectedOutput;
        
        return Math.max(0, Math.abs(Number(impactBasisPoints) / 100));
      }
    }
    
    return 0;
  } catch (error) {
    console.error("V3 multi-hop price impact calculation failed:", error);
    return 0;
  }
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
