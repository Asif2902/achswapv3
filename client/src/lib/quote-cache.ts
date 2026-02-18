import type { SmartRoutingResult } from "./smart-routing";

interface CachedQuote {
  result: SmartRoutingResult;
  timestamp: number;
  blockNumber?: number; // Track block for invalidation
}

const quoteCache = new Map<string, CachedQuote>();
const CACHE_DURATION = 5000; // 5 seconds - reduced from 10s for volatile markets

// Track latest seen block number
let latestBlockNumber: number | undefined;

/**
 * Update the latest block number and invalidate stale cache entries
 * Call this when a new block is detected
 */
export function updateBlockNumber(blockNumber: number): void {
  if (latestBlockNumber !== undefined && blockNumber > latestBlockNumber) {
    // Invalidate all cache entries from older blocks
    // Prices may have changed in new blocks
    for (const [key, cached] of quoteCache.entries()) {
      if (cached.blockNumber !== undefined && cached.blockNumber < blockNumber) {
        quoteCache.delete(key);
      }
    }
  }
  latestBlockNumber = blockNumber;
}

/**
 * Generate cache key from swap parameters
 */
function getCacheKey(
  fromTokenAddress: string,
  toTokenAddress: string,
  amountIn: string,
  v2Enabled: boolean,
  v3Enabled: boolean
): string {
  return `${fromTokenAddress}-${toTokenAddress}-${amountIn}-${v2Enabled}-${v3Enabled}`;
}

/**
 * Get cached quote if available and fresh
 */
export function getCachedQuote(
  fromTokenAddress: string,
  toTokenAddress: string,
  amountIn: string,
  v2Enabled: boolean,
  v3Enabled: boolean
): SmartRoutingResult | null {
  const key = getCacheKey(fromTokenAddress, toTokenAddress, amountIn, v2Enabled, v3Enabled);
  const cached = quoteCache.get(key);
  
  if (!cached) return null;
  
  const now = Date.now();
  if (now - cached.timestamp > CACHE_DURATION) {
    quoteCache.delete(key);
    return null;
  }
  
  // Also invalidate if block number has advanced
  if (cached.blockNumber !== undefined && latestBlockNumber !== undefined && 
      cached.blockNumber < latestBlockNumber) {
    quoteCache.delete(key);
    return null;
  }
  
  return cached.result;
}

/**
 * Store quote in cache
 */
export function setCachedQuote(
  fromTokenAddress: string,
  toTokenAddress: string,
  amountIn: string,
  v2Enabled: boolean,
  v3Enabled: boolean,
  result: SmartRoutingResult,
  blockNumber?: number
): void {
  const key = getCacheKey(fromTokenAddress, toTokenAddress, amountIn, v2Enabled, v3Enabled);
  quoteCache.set(key, {
    result,
    timestamp: Date.now(),
    blockNumber,
  });
}

/**
 * Clear all cached quotes
 */
export function clearQuoteCache(): void {
  quoteCache.clear();
}

/**
 * Clean up expired cache entries
 */
export function cleanupExpiredCache(): void {
  const now = Date.now();
  for (const [key, cached] of quoteCache.entries()) {
    if (now - cached.timestamp > CACHE_DURATION) {
      quoteCache.delete(key);
    }
  }
}

// Run cleanup every 30 seconds
setInterval(cleanupExpiredCache, 30000);
