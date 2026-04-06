import { Contract } from "ethers";
import type { JsonRpcProvider } from "ethers";
import type { Token } from "@shared/schema";
import { safeTokenInfo } from "./v3-pool-utils";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
  "function allPairsLength() external view returns (uint256)",
  "function allPairs(uint256) external view returns (address pair)",
];

const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() external view returns (uint256)",
];

interface ExplorerTokenBalanceItem {
  token: {
    address_hash?: string;
    type?: string;
  } | null;
  value?: string;
}

interface TokenBalancesCacheEntry {
  expiresAt: number;
  data: ExplorerTokenBalanceItem[];
}

export interface V2DiscoveredPosition {
  pairAddress: string;
  token0Address: string;
  token1Address: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Name: string;
  token1Name: string;
  token0Decimals: number;
  token1Decimals: number;
  liquidity: bigint;
  totalSupply: bigint;
  reserve0: bigint;
  reserve1: bigint;
  amount0: bigint;
  amount1: bigint;
}

interface FallbackScanResult {
  pairAddress: string;
  liquidity: bigint;
}

function createLimiter(maxConcurrent: number) {
  const normalizedMaxConcurrent = Number.isFinite(maxConcurrent)
    ? Math.max(1, Math.floor(maxConcurrent))
    : 1;
  let active = 0;
  const queue: (() => void)[] = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= normalizedMaxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

function parsePositiveBigInt(value: string | undefined): bigint | null {
  if (!value) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

const TOKEN_BALANCES_CACHE_TTL_MS = 15_000;
const EXPLORER_FETCH_TIMEOUT_MS = 5_000;
const TOKEN_BALANCES_CACHE_MAX_ENTRIES = 100;
const TOKEN_BALANCES_IN_FLIGHT_MAX_ENTRIES = 32;
const tokenBalancesCache = new Map<string, TokenBalancesCacheEntry>();
const tokenBalancesInFlight = new Map<string, Promise<ExplorerTokenBalanceItem[]>>();

function pruneTokenBalancesCache(now: number) {
  for (const [cacheKey, entry] of tokenBalancesCache.entries()) {
    if (entry.expiresAt <= now) {
      tokenBalancesCache.delete(cacheKey);
    }
  }

  while (tokenBalancesCache.size > TOKEN_BALANCES_CACHE_MAX_ENTRIES) {
    const oldestKey = tokenBalancesCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    tokenBalancesCache.delete(oldestKey);
  }
}

function touchTokenBalancesCacheEntry(key: string, entry: TokenBalancesCacheEntry) {
  tokenBalancesCache.delete(key);
  tokenBalancesCache.set(key, entry);
}

function capInFlightEntries() {
  while (tokenBalancesInFlight.size > TOKEN_BALANCES_IN_FLIGHT_MAX_ENTRIES) {
    const oldestKey = tokenBalancesInFlight.keys().next().value as string | undefined;
    if (!oldestKey) break;
    tokenBalancesInFlight.delete(oldestKey);
  }
}

function balancesCacheKey(ownerAddress: string, apiBaseUrl: string): string {
  return `${apiBaseUrl.toLowerCase()}::${ownerAddress.toLowerCase()}`;
}

async function fetchTokenBalancesFromExplorerNetwork(
  ownerAddress: string,
  apiBaseUrl: string,
): Promise<ExplorerTokenBalanceItem[]> {
  const endpoint = `${apiBaseUrl}/addresses/${ownerAddress}/token-balances`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXPLORER_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          headers: {
            Accept: "application/json",
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Explorer API ${response.status} while fetching token balances`);
        }

        const data = await response.json();
        if (!Array.isArray(data)) {
          throw new Error("Explorer token-balances returned an unexpected response shape");
        }

        return data as ExplorerTokenBalanceItem[];
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 350));
    }
  }

  throw lastError ?? new Error("Failed to fetch token balances from explorer API");
}

async function fetchTokenBalancesFromExplorer(
  ownerAddress: string,
  apiBaseUrl: string,
): Promise<ExplorerTokenBalanceItem[]> {
  const key = balancesCacheKey(ownerAddress, apiBaseUrl);
  const now = Date.now();
  pruneTokenBalancesCache(now);

  const cached = tokenBalancesCache.get(key);
  if (cached && cached.expiresAt > now) {
    touchTokenBalancesCacheEntry(key, cached);
    return cached.data;
  }
  if (cached && cached.expiresAt <= now) {
    tokenBalancesCache.delete(key);
  }

  const inFlight = tokenBalancesInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const request = fetchTokenBalancesFromExplorerNetwork(ownerAddress, apiBaseUrl)
    .then((rows) => {
      const entry = {
        expiresAt: Date.now() + TOKEN_BALANCES_CACHE_TTL_MS,
        data: rows,
      };
      touchTokenBalancesCacheEntry(key, entry);
      pruneTokenBalancesCache(Date.now());
      return rows;
    })
    .finally(() => {
      tokenBalancesInFlight.delete(key);
    });

  if (tokenBalancesInFlight.has(key)) {
    tokenBalancesInFlight.delete(key);
  }
  tokenBalancesInFlight.set(key, request);
  capInFlightEntries();
  return request;
}

async function collectV2CandidatesWithRpcScan(
  ownerAddress: string,
  factoryAddress: string,
  provider: JsonRpcProvider,
  maxConcurrent = 10,
): Promise<Map<string, bigint>> {
  const uniqueCandidates = new Map<string, bigint>();
  const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
  const limit = createLimiter(maxConcurrent);

  const pairsLength = await factory.allPairsLength();
  if (pairsLength < 0n) {
    throw new Error("Factory allPairsLength returned a negative value");
  }
  if (pairsLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Factory pair count exceeds safe integer limit for indexed scan");
  }
  const totalPairs = Number(pairsLength);

  if (totalPairs <= 0) {
    return uniqueCandidates;
  }

  const batchSize = 60;
  const pairAddressSet = new Set<string>();

  for (let start = 0; start < totalPairs; start += batchSize) {
    const end = Math.min(start + batchSize, totalPairs);
    const indices = Array.from({ length: end - start }, (_, i) => start + i);

    const chunkResults = await Promise.allSettled(
      indices.map((index) => limit(() => factory.allPairs(index))),
    );

    const failedIndices: number[] = [];
    chunkResults.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        pairAddressSet.add(String(result.value).toLowerCase());
      } else {
        failedIndices.push(indices[idx]);
      }
    });

    for (const index of failedIndices) {
      try {
        const addr = await limit(() => factory.allPairs(index));
        pairAddressSet.add(String(addr).toLowerCase());
      } catch {
        continue;
      }
    }
  }

  const pairAddresses = Array.from(pairAddressSet);

  if (pairAddresses.length === 0) {
    return uniqueCandidates;
  }

  for (let start = 0; start < pairAddresses.length; start += batchSize) {
    const chunk = pairAddresses.slice(start, start + batchSize);
    const fallbackResults = await Promise.all(
      chunk.map((pairAddressLower) =>
        limit(async (): Promise<FallbackScanResult | null> => {
          try {
            const pair = new Contract(pairAddressLower, PAIR_ABI, provider);
            const liquidity = await pair.balanceOf(ownerAddress);
            if (liquidity <= 0n) return null;
            return { pairAddress: pairAddressLower, liquidity };
          } catch {
            return null;
          }
        }),
      ),
    );

    for (const row of fallbackResults) {
      if (!row) continue;
      const prev = uniqueCandidates.get(row.pairAddress) ?? 0n;
      if (row.liquidity > prev) {
        uniqueCandidates.set(row.pairAddress, row.liquidity);
      }
    }
  }

  return uniqueCandidates;
}

export function explorerApiBaseFromTxUrl(explorerTxUrl: string): string | null {
  try {
    const origin = new URL(explorerTxUrl).origin;
    return `${origin}/api/v2`;
  } catch {
    return null;
  }
}

export async function discoverV2PositionsFromExplorer(params: {
  ownerAddress: string;
  factoryAddress: string;
  provider: JsonRpcProvider;
  knownTokens: Token[];
  apiBaseUrl: string;
  maxConcurrent?: number;
  retryWithFallbackScan?: boolean;
}): Promise<V2DiscoveredPosition[]> {
  const {
    ownerAddress,
    factoryAddress,
    provider,
    knownTokens,
    apiBaseUrl,
    maxConcurrent = 10,
    retryWithFallbackScan = true,
  } = params;
  const uniqueCandidates = new Map<string, bigint>();

  let explorerErr: Error | null = null;
  try {
    const balances = await fetchTokenBalancesFromExplorer(ownerAddress, apiBaseUrl);
    for (const row of balances) {
      const tokenAddress = row.token?.address_hash;
      if (!tokenAddress) continue;

      const tokenType = row.token?.type;
      if (tokenType && tokenType !== "ERC-20") continue;

      const liquidity = parsePositiveBigInt(row.value);
      if (!liquidity) continue;

      const key = tokenAddress.toLowerCase();
      const existing = uniqueCandidates.get(key) ?? 0n;
      if (liquidity > existing) {
        uniqueCandidates.set(key, liquidity);
      }
    }
  } catch (err) {
    explorerErr = err instanceof Error ? err : new Error(String(err));
  }

  const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
  const limit = createLimiter(maxConcurrent);

  const discoverValidatedPositions = async (
    candidates: Map<string, bigint>,
  ): Promise<V2DiscoveredPosition[]> => {
    if (candidates.size === 0) {
      return [];
    }

    const candidateEntries = Array.from(candidates.entries());
    const discovered = await Promise.all(
      candidateEntries.map(([pairAddressLower]) =>
        limit(async (): Promise<V2DiscoveredPosition | null> => {
          try {
            const pairAddress = pairAddressLower;
            const pair = new Contract(pairAddress, PAIR_ABI, provider);

            const [token0Address, token1Address] = await Promise.all([
              pair.token0(),
              pair.token1(),
            ]);

            const factoryPairAddress = await factory.getPair(token0Address, token1Address);
            if (!factoryPairAddress || factoryPairAddress.toLowerCase() === ZERO_ADDRESS) {
              return null;
            }

            if (factoryPairAddress.toLowerCase() !== pairAddressLower) {
              return null;
            }

            const [reserves, totalSupply, liveLiquidity, token0Info, token1Info] = await Promise.all([
              pair.getReserves(),
              pair.totalSupply(),
              pair.balanceOf(ownerAddress),
              safeTokenInfo(token0Address, provider, knownTokens),
              safeTokenInfo(token1Address, provider, knownTokens),
            ]);

            if (totalSupply <= 0n || liveLiquidity <= 0n) {
              return null;
            }

            const reserve0Raw = reserves.reserve0 ?? reserves[0] ?? 0n;
            const reserve1Raw = reserves.reserve1 ?? reserves[1] ?? 0n;
            const reserve0 = typeof reserve0Raw === "bigint" ? reserve0Raw : BigInt(reserve0Raw.toString());
            const reserve1 = typeof reserve1Raw === "bigint" ? reserve1Raw : BigInt(reserve1Raw.toString());

            const amount0 = (liveLiquidity * reserve0) / totalSupply;
            const amount1 = (liveLiquidity * reserve1) / totalSupply;

            return {
              pairAddress,
              token0Address,
              token1Address,
              token0Symbol: token0Info.symbol,
              token1Symbol: token1Info.symbol,
              token0Name: token0Info.name,
              token1Name: token1Info.name,
              token0Decimals: token0Info.decimals,
              token1Decimals: token1Info.decimals,
              liquidity: liveLiquidity,
              totalSupply,
              reserve0,
              reserve1,
              amount0,
              amount1,
            };
          } catch {
            return null;
          }
        }),
      ),
    );

    return discovered.filter((position): position is V2DiscoveredPosition => position !== null);
  };

  const discoveredByPair = new Map<string, V2DiscoveredPosition>();
  const addDiscovered = (positions: V2DiscoveredPosition[]) => {
    for (const position of positions) {
      const key = position.pairAddress.toLowerCase();
      const existing = discoveredByPair.get(key);
      if (!existing || position.liquidity > existing.liquidity) {
        discoveredByPair.set(key, position);
      }
    }
  };

  const explorerDiscovered = await discoverValidatedPositions(uniqueCandidates);
  addDiscovered(explorerDiscovered);

  if (explorerDiscovered.length === 0 && retryWithFallbackScan) {
    if (explorerErr) {
      console.warn("[V2 discovery] Explorer API failed, retrying with RPC fallback scan", explorerErr);
    }
    try {
      const fallbackCandidates = await collectV2CandidatesWithRpcScan(
        ownerAddress,
        factoryAddress,
        provider,
        maxConcurrent,
      );
      const fallbackDiscovered = await discoverValidatedPositions(fallbackCandidates);
      addDiscovered(fallbackDiscovered);
    } catch (fallbackErr) {
      if (discoveredByPair.size === 0) {
        const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        const explorerMessage = explorerErr?.message ?? String(explorerErr);
        throw new Error(
          `V2 discovery failed (token-balances + RPC fallback scan). Explorer: ${explorerMessage}; Fallback: ${fallbackMessage}`,
        );
      }
    }
  }

  return Array.from(discoveredByPair.values()).sort((a, b) => {
    if (a.liquidity === b.liquidity) return 0;
    return a.liquidity > b.liquidity ? -1 : 1;
  });
}
