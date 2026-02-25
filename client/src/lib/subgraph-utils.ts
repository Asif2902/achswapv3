import { SUBGRAPH_CONFIG } from "./config";

const SEVEN_DAYS_AGO = 7;
const VOLUME_ADJUSTMENT = 10;

const POOL_VOLUME_QUERY = `
query GetPoolVolume($poolId: ID!, $daysAgo: Int!) {
  pool(id: $poolId) {
    id
    token0 {
      symbol
      decimals
    }
    token1 {
      symbol
      decimals
    }
    volumeUSD
    liquidity
  }
  poolDayDatas(
    first: $daysAgo
    where: { pool: $poolId }
    orderBy: date
    orderDirection: desc
  ) {
    date
    volumeUSD
  }
}
`;

interface SubgraphPoolData {
  pool: {
    id: string;
    token0: { symbol: string; decimals: string };
    token1: { symbol: string; decimals: string };
    volumeUSD: string;
    liquidity: string;
  } | null;
  poolDayDatas: Array<{
    date: number;
    volumeUSD: string;
  }>;
}

export interface PoolVolumeData {
  weeklyVolumeUSD: number;
  annualizedVolumeUSD: number;
  liquidity: string;
  token0Decimals: number;
  token1Decimals: number;
  token0Symbol: string;
  token1Symbol: string;
}

export async function fetchPoolVolume(poolAddress: string): Promise<PoolVolumeData | null> {
  try {
    const response = await fetch(SUBGRAPH_CONFIG.arcSwapTVL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: POOL_VOLUME_QUERY,
        variables: { poolId: poolAddress.toLowerCase(), daysAgo: SEVEN_DAYS_AGO }
      })
    });

    if (!response.ok) {
      console.error("Subgraph fetch failed:", response.status);
      return null;
    }

    const result = await response.json() as { data: SubgraphPoolData; errors?: Array<{ message: string }> };
    
    if (result.errors) {
      console.error("Subgraph errors:", result.errors);
      return null;
    }
    
    if (!result.data?.pool) {
      console.log("No pool found for address:", poolAddress);
      return null;
    }

    const pool = result.data.pool;
    const dayDatas = result.data.poolDayDatas || [];
    
    const weeklyVolumeUSD = dayDatas.reduce((sum, day) => sum + parseFloat(day.volumeUSD || "0"), 0);
    const annualizedVolumeUSD = weeklyVolumeUSD * VOLUME_ADJUSTMENT * 52;

    console.log("Pool volume data:", { 
      pool: pool.id, 
      dayCount: dayDatas.length, 
      weeklyVolumeUSD, 
      annualizedVolumeUSD 
    });

    return {
      weeklyVolumeUSD,
      annualizedVolumeUSD,
      liquidity: pool.liquidity,
      token0Decimals: parseInt(pool.token0.decimals),
      token1Decimals: parseInt(pool.token1.decimals),
      token0Symbol: pool.token0.symbol,
      token1Symbol: pool.token1.symbol
    };
  } catch (error) {
    console.error("Error fetching pool volume:", error);
    return null;
  }
}

export function calculateAPRFromVolume(
  annualizedVolumeUSD: number,
  liquidityUSD: number,
  fee: number,
  inRangeRatio: number
): number {
  if (liquidityUSD <= 0 || annualizedVolumeUSD <= 0) {
    return 0;
  }

  const feeRevenue = annualizedVolumeUSD * (fee / 10000) * inRangeRatio;
  const apr = (feeRevenue / liquidityUSD) * 100;

  return Math.min(apr, 99999);
}
