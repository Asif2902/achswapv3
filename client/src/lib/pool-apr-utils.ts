const SUBGRAPH_URL  = "https://api.studio.thegraph.com/query/1742338/arcswaptvl/version/latest";
const WUSDC_ADDRESS = "0xde5db9049a8dd344dc1b7bbb098f9da60930a6da";
const Q96           = 2n ** 96n;

// VOLUME_CORRECTION = 10
// The subgraph indexes volume AND fees at 1/10th actual value due to a decimal
// precision issue in the indexer. Multiply BOTH volumeUSD and feesUSD by 10
// immediately after reading from the subgraph.
const VOLUME_CORRECTION = 10;

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
  sqrtPrice: string

  aprConservative: number
  aprActive: number
  dailyFeeRate: number
}

interface PoolMetaResponse {
  pool: {
    id: string;
    feeTier: number;
    liquidity: string;
    sqrtPrice: string;
    tick: number;
    token0Price: string;
    token1Price: string;
    totalValueLockedUSD: string;
    volumeUSD: string;
    feesUSD: string;
    token0: { id: string; symbol: string; decimals: string };
    token1: { id: string; symbol: string; decimals: string };
  } | null;
}

interface PoolDayDataResponse {
  poolDayDatas: Array<{
    date: number;
    volumeUSD: string;
    feesUSD: string;
    txCount: string;
    liquidity: string;
    token0Price: string;
    token1Price: string;
  }>;
}

interface TopPoolsResponse {
  pools: Array<{ id: string }>;
}

function getApiKey(): string {
  const API_KEY = import.meta.env.VITE_SUBGRAPH_KEY;
  if (!API_KEY) {
    throw new Error("Missing VITE_SUBGRAPH_KEY environment variable");
  }
  return API_KEY;
}

async function subgraphFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const API_KEY = getApiKey();
  
  const response = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Subgraph HTTP error: ${response.status}`);
  }

  const json = await response.json();
  
  if (json.errors?.length > 0) {
    throw new Error(`Subgraph error: ${json.errors?.[0]?.message ?? JSON.stringify(json.errors)}`);
  }

  return json.data;
}

function getActiveTVLUSD(
  pool: {
    sqrtPrice: string;
    liquidity: string;
    token0Price: string;
    token1Price: string;
    totalValueLockedUSD: string;
    token0: { id: string; decimals: string };
    token1: { id: string; decimals: string };
  },
  debug = false
): number {
  const sqrtPriceBI = BigInt(pool.sqrtPrice);
  const liquidityBI = BigInt(pool.liquidity);
  const tvlUSD      = parseFloat(pool.totalValueLockedUSD);

  if (liquidityBI === 0n || sqrtPriceBI === 0n) return 0;

  // Use BigInt division to preserve fractional precision
  const sqrtP = Number(sqrtPriceBI / Q96) + Number(sqrtPriceBI % Q96) / Number(Q96);
  const dec0  = parseInt(pool.token0.decimals);
  const dec1  = parseInt(pool.token1.decimals);

  const amount0Active = (Number(liquidityBI) / sqrtP)  / Math.pow(10, dec0);
  const amount1Active = (Number(liquidityBI) * sqrtP)  / Math.pow(10, dec1);

  let token0USD: number;
  let token1USD: number;

  if (pool.token0.id === WUSDC_ADDRESS) {
    token0USD = 1;
    token1USD = parseFloat(pool.token1Price);
  } else if (pool.token1.id === WUSDC_ADDRESS) {
    token0USD = parseFloat(pool.token0Price);
    token1USD = 1;
  } else {
    return 0;
  }

  const activeTVLUSD = (amount0Active * token0USD) + (amount1Active * token1USD);
  const result = Math.min(activeTVLUSD, tvlUSD);

  if (debug) {
    console.debug({
      sqrtP,
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
        sqrtPrice
        tick
        token0Price
        token1Price
        totalValueLockedUSD
        volumeUSD
        feesUSD
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
        volumeUSD
        feesUSD
        txCount
        liquidity
        token0Price
        token1Price
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
    rawVolume7dUSD += parseFloat(d.volumeUSD);
  }
  const volume7dUSD = rawVolume7dUSD * VOLUME_CORRECTION;

  const rawFees7dUSD = days.reduce((s, d) => s + parseFloat(d.feesUSD), 0);
  const fees7dUSD = rawFees7dUSD * VOLUME_CORRECTION;
  const txCount7d = days.reduce((s, d) => s + parseInt(d.txCount), 0);

  const avgDailyFees = daysWithData > 0 ? fees7dUSD / daysWithData : 0;

  const tvlUSD = parseFloat(pool.totalValueLockedUSD);
  const activeTVL = getActiveTVLUSD(pool, debug);

  // Calculate APR
  // When TVL data is unavailable (0), estimate from volume using fee tier
  const feeTierNum = typeof pool.feeTier === 'string' ? parseInt(pool.feeTier) : pool.feeTier;
  const feeTier = feeTierNum / 1_000_000; // e.g., 3000 -> 0.003
  const estimatedTVLFromVolume = volume7dUSD * 30 * feeTier; // Monthly volume proxy for TVL

  // Use actual TVL if available, otherwise estimate from volume
  const useTVL = tvlUSD >= 1 ? tvlUSD : estimatedTVLFromVolume;
  const useActiveTVL = activeTVL >= 1 ? activeTVL : estimatedTVLFromVolume;

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
    feeTier: pool.feeTier,
    volume7dUSD,
    fees7dUSD,
    txCount7d,
    daysWithData,
    tvlUSD,
    activeTVLUSD: activeTVL,
    currentTick: pool.tick,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
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
        orderBy: totalValueLockedUSD,
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
