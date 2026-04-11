const SUBGRAPH_PROXY_URL = "/api/subgraph";
const SUBGRAPH_PROXY_APP_TOKEN = (import.meta.env.VITE_SUBGRAPH_PROXY_TOKEN as string | undefined)?.trim();
const WUSDC_ADDRESS = "0xde5db9049a8dd344dc1b7bbb098f9da60930a6da";
const USDC_ERC20_INTERFACE = "0x3600000000000000000000000000000000000000";
const NATIVE_USDC = "0x0000000000000000000000000000000000000000";
const Q96 = 2n ** 96n;

export interface PoolStats {
  poolId: string
  token0Symbol: string
  token1Symbol: string
  token0Id: string
  token1Id: string
  feeTier: number

  volume7dUSD: number
  fees7dUSD: number
  txCount7d: number
  daysWithData: number

  tvlUSD: number
  activeTVLUSD: number
  currentTick: number
  liquidity: string
  sqrtPriceX96: string

  aprConservative: number
  aprActive: number
  dailyFeeRate: number
}

interface PoolMetaResponse {
  pool: {
    id: string;
    feeTier: string;
    liquidity: string;
    sqrtPriceX96: string;
    tick: number;
    token0Price: string;
    token1Price: string;
    tvlUsd: string;
    volumeUsd: string;
    feesUsd: string;
    token0: { id: string; symbol: string; decimals: string };
    token1: { id: string; symbol: string; decimals: string };
  } | null;
}

interface PoolDayDataResponse {
  poolDayDatas: Array<{
    date: number;
    dailyVolumeUsd: string;
    dailyFeesUsd: string;
    txCount: string;
  }>;
}

interface TopPoolsResponse {
  pools: Array<{ id: string }>;
}

async function subgraphFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (SUBGRAPH_PROXY_APP_TOKEN) {
    headers["X-App-Token"] = SUBGRAPH_PROXY_APP_TOKEN;
  }

  const response = await fetch(SUBGRAPH_PROXY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    let proxyErrorDetail = "";
    try {
      const errorJson = await response.json();
      if (errorJson?.error) {
        proxyErrorDetail = String(errorJson.error);
      } else if (errorJson?.message) {
        proxyErrorDetail = String(errorJson.message);
      } else {
        proxyErrorDetail = JSON.stringify(errorJson);
      }
    } catch {
      try {
        proxyErrorDetail = await response.text();
      } catch {
        proxyErrorDetail = "";
      }
    }

    const suffix = proxyErrorDetail ? `: ${proxyErrorDetail}` : "";
    throw new Error(`Subgraph HTTP error ${response.status}${suffix}`);
  }

  const json = await response.json();
  
  if (json.errors?.length > 0) {
    throw new Error(`Subgraph error: ${json.errors?.[0]?.message ?? JSON.stringify(json.errors)}`);
  }

  return json.data;
}

function getActiveTVLUSD(
  pool: {
    sqrtPriceX96: string;
    liquidity: string;
    token0Price: string;
    token1Price: string;
    tvlUsd: string;
    token0: { id: string; decimals: string };
    token1: { id: string; decimals: string };
  },
  debug = false
): number {
  const sqrtPriceBI = BigInt(pool.sqrtPriceX96);
  const liquidityBI = BigInt(pool.liquidity);
  const tvlUSD      = parseFloat(pool.tvlUsd);

  if (liquidityBI === 0n || sqrtPriceBI === 0n) return 0;

  const dec0  = parseInt(pool.token0.decimals);
  const dec1  = parseInt(pool.token1.decimals);

  // Keep intermediate V3 math in bigint fixed-point form to avoid precision loss.
  const amount0RawBI = (liquidityBI * Q96) / sqrtPriceBI;
  const amount1RawBI = (liquidityBI * sqrtPriceBI) / Q96;

  const dec0Scale = 10n ** BigInt(dec0);
  const dec1Scale = 10n ** BigInt(dec1);

  const amount0WholeBI = amount0RawBI / dec0Scale;
  const amount1WholeBI = amount1RawBI / dec1Scale;
  const amount0FracBI = amount0RawBI % dec0Scale;
  const amount1FracBI = amount1RawBI % dec1Scale;

  const amount0Active = Number(amount0WholeBI) + Number(amount0FracBI) / Number(dec0Scale);
  const amount1Active = Number(amount1WholeBI) + Number(amount1FracBI) / Number(dec1Scale);

  let token0USD: number;
  let token1USD: number;

  const token0Addr = pool.token0.id.toLowerCase();
  const token1Addr = pool.token1.id.toLowerCase();
  const token0Stable = token0Addr === WUSDC_ADDRESS || token0Addr === USDC_ERC20_INTERFACE || token0Addr === NATIVE_USDC;
  const token1Stable = token1Addr === WUSDC_ADDRESS || token1Addr === USDC_ERC20_INTERFACE || token1Addr === NATIVE_USDC;

  if (token0Stable) {
    token0USD = 1;
    token1USD = parseFloat(pool.token1Price);
  } else if (token1Stable) {
    token0USD = parseFloat(pool.token0Price);
    token1USD = 1;
  } else {
    return 0;
  }

  const activeTVLUSD = (amount0Active * token0USD) + (amount1Active * token1USD);
  const result = Math.min(activeTVLUSD, tvlUSD);

  if (debug) {
    console.debug({
      sqrtPriceX96: sqrtPriceBI.toString(),
      amount0Active,
      amount1Active,
      activeTVLUSD: result,
      token0USD,
      token1USD,
    });
  }

  return result;
}

export async function getPoolStats(
  poolId: string,
  debug = false
): Promise<PoolStats> {
  const normalizedPoolId = poolId.toLowerCase();

  const META_QUERY = `
    query PoolMeta($poolId: ID!) {
      pool(id: $poolId) {
        id
        feeTier
        liquidity
        sqrtPriceX96
        tick
        token0Price
        token1Price
        tvlUsd
        volumeUsd
        feesUsd
        token0 {
          id
          symbol
          decimals
        }
        token1 {
          id
          symbol
          decimals
        }
      }
    }
  `;

  const metaData = await subgraphFetch<PoolMetaResponse>(META_QUERY, { poolId: normalizedPoolId });

  if (!metaData.pool) {
    throw new Error(`Pool not found: ${normalizedPoolId}`);
  }

  const pool = metaData.pool;
  // Subgraph uses days since epoch (e.g., 20511), not Unix timestamp
  const date7dAgo = Math.floor(Date.now() / 86400000) - 7;

  const DAYDATA_QUERY = `
    query Pool7DayData($poolId: String!, $date7dAgo: Int!) {
      poolDayDatas(
        where: { pool: $poolId, date_gte: $date7dAgo }
        orderBy: date
        orderDirection: desc
        first: 7
      ) {
        date
        dailyVolumeUsd
        dailyFeesUsd
        txCount
      }
    }
  `;

  const dayData = await subgraphFetch<PoolDayDataResponse>(DAYDATA_QUERY, {
    poolId: normalizedPoolId,
    date7dAgo,
  });

  const days = dayData.poolDayDatas;
  const daysWithData = days.length;

  let rawVolume7dUSD = 0;
  for (const d of days) {
    rawVolume7dUSD += parseFloat(d.dailyVolumeUsd);
  }
  const volume7dUSD = rawVolume7dUSD;

  const rawFees7dUSD = days.reduce((s, d) => s + parseFloat(d.dailyFeesUsd), 0);
  const fees7dUSD = rawFees7dUSD;
  const txCount7d = days.reduce((s, d) => s + parseInt(d.txCount), 0);

  const avgDailyFees = daysWithData > 0 ? fees7dUSD / daysWithData : 0;

  const tvlUSD = parseFloat(pool.tvlUsd);
  const activeTVL = getActiveTVLUSD(pool, debug);

  // Calculate APR from observed fees and indexed TVL only.
  // Do not synthesize TVL from fee tier/volume proxies, as that can produce misleading APR.
  const useTVL = tvlUSD;
  const useActiveTVL = activeTVL >= 1 ? activeTVL : tvlUSD;

  const aprConservative = useTVL >= 1
    ? (avgDailyFees / useTVL) * 365 * 100
    : 0;

  const aprActive = useActiveTVL >= 1
    ? (avgDailyFees / useActiveTVL) * 365 * 100
    : 0;

  const dailyFeeRate = useActiveTVL >= 1
    ? avgDailyFees / useActiveTVL
    : 0;

  if (debug) {
    console.debug({
      poolId: normalizedPoolId,
      rawVolume: rawVolume7dUSD,
      correctedVolume: volume7dUSD,
      rawFees: rawFees7dUSD,
      correctedFees: fees7dUSD,
      avgDailyFees,
      tvlUSD,
      activeTVL,
      useActiveTVL,
      aprConservative,
      aprActive,
    });
  }

  // pool.liquidity === "0" means the current price is outside every LP's range.
  // Nobody earns fees. aprActive = 0 is correct, not a bug.

  return {
    poolId: pool.id,
    token0Symbol: pool.token0.symbol,
    token1Symbol: pool.token1.symbol,
    token0Id: pool.token0.id,
    token1Id: pool.token1.id,
    feeTier: parseInt(pool.feeTier),
    volume7dUSD,
    fees7dUSD,
    txCount7d,
    daysWithData,
    tvlUSD,
    activeTVLUSD: useActiveTVL,
    currentTick: pool.tick,
    liquidity: pool.liquidity,
    sqrtPriceX96: pool.sqrtPriceX96,
    aprConservative,
    aprActive,
    dailyFeeRate,
  };
}

export async function getTopPoolsByAPR(
  n = 10,
  debug = false
): Promise<PoolStats[]> {
  const TOP_POOLS_QUERY = `
    query TopPools($n: Int!) {
      pools(
        first: $n,
        orderBy: tvlUsd,
        orderDirection: desc
      ) {
        id
      }
    }
  `;

  const topPoolsData = await subgraphFetch<TopPoolsResponse>(TOP_POOLS_QUERY, { n });
  const poolIds = topPoolsData.pools.map(p => p.id);

  const statsPromises = poolIds.map(id => 
    getPoolStats(id, debug).catch(err => {
      console.warn(`Failed to fetch stats for pool ${id}:`, err);
      return null;
    })
  );

  const results = await Promise.all(statsPromises);
  const validResults = results.filter((r): r is PoolStats => r !== null);

  validResults.sort((a, b) => b.aprActive - a.aprActive);

  return validResults;
}
