import { Contract } from "ethers";
import type { JsonRpcProvider } from "ethers";
import type { Token } from "@shared/schema";
import { safeTokenInfo } from "./v3-pool-utils";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
];

const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
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

function createLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
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
const tokenBalancesCache = new Map<string, TokenBalancesCacheEntry>();
const tokenBalancesInFlight = new Map<string, Promise<ExplorerTokenBalanceItem[]>>();

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
      const response = await fetch(endpoint, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Explorer API ${response.status} while fetching token balances`);
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error("Explorer token-balances returned an unexpected response shape");
      }

      return data as ExplorerTokenBalanceItem[];
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
  const cached = tokenBalancesCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const inFlight = tokenBalancesInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const request = fetchTokenBalancesFromExplorerNetwork(ownerAddress, apiBaseUrl)
    .then((rows) => {
      tokenBalancesCache.set(key, {
        expiresAt: Date.now() + TOKEN_BALANCES_CACHE_TTL_MS,
        data: rows,
      });
      return rows;
    })
    .finally(() => {
      tokenBalancesInFlight.delete(key);
    });

  tokenBalancesInFlight.set(key, request);
  return request;
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
}): Promise<V2DiscoveredPosition[]> {
  const {
    ownerAddress,
    factoryAddress,
    provider,
    knownTokens,
    apiBaseUrl,
    maxConcurrent = 10,
  } = params;

  const balances = await fetchTokenBalancesFromExplorer(ownerAddress, apiBaseUrl);

  const uniqueCandidates = new Map<string, bigint>();
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

  if (uniqueCandidates.size === 0) {
    return [];
  }

  const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
  const limit = createLimiter(maxConcurrent);

  const candidateEntries = Array.from(uniqueCandidates.entries());
  const discovered = await Promise.all(
    candidateEntries.map(([pairAddressLower, liquidity]) =>
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

          const [reserves, totalSupply, token0Info, token1Info] = await Promise.all([
            pair.getReserves(),
            pair.totalSupply(),
            safeTokenInfo(token0Address, provider, knownTokens),
            safeTokenInfo(token1Address, provider, knownTokens),
          ]);

          if (totalSupply <= 0n || liquidity <= 0n) {
            return null;
          }

          const reserve0Raw = reserves.reserve0 ?? reserves[0] ?? 0n;
          const reserve1Raw = reserves.reserve1 ?? reserves[1] ?? 0n;
          const reserve0 = typeof reserve0Raw === "bigint" ? reserve0Raw : BigInt(reserve0Raw.toString());
          const reserve1 = typeof reserve1Raw === "bigint" ? reserve1Raw : BigInt(reserve1Raw.toString());

          const amount0 = (liquidity * reserve0) / totalSupply;
          const amount1 = (liquidity * reserve1) / totalSupply;

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
            liquidity,
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

  return discovered
    .filter((position): position is V2DiscoveredPosition => position !== null)
    .sort((a, b) => {
      if (a.liquidity === b.liquidity) return 0;
      return a.liquidity > b.liquidity ? -1 : 1;
    });
}
