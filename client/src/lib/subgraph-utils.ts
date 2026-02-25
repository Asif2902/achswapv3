import { SUBGRAPH_CONFIG } from "./config";

const SEVEN_DAYS_AGO = 7;
const VOLUME_ADJUSTMENT = 10;
const CACHE_DURATION = 5 * 60 * 1000;

const volumeCache = new Map<string, { data: PoolVolumeData; timestamp: number }>();

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
  } | null;
  poolDayDatas: Array<{
    date: number;
    volumeUSD: string;
  }>;
}

export interface PoolVolumeData {
  weeklyVolumeUSD: number;
  annualizedVolumeUSD: number;
  token0Decimals: number;
  token1Decimals: number;
  token0Symbol: string;
  token1Symbol: string;
}

function getCachedVolume(poolAddress: string): PoolVolumeData | null {
  const cached = volumeCache.get(poolAddress.toLowerCase());
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log("Using cached volume for:", poolAddress);
    return cached.data;
  }
  volumeCache.delete(poolAddress.toLowerCase());
  return null;
}

function setCachedVolume(poolAddress: string, data: PoolVolumeData): void {
  volumeCache.set(poolAddress.toLowerCase(), { data, timestamp: Date.now() });
}

export async function fetchPoolVolume(poolAddress: string): Promise<PoolVolumeData | null> {
  const cached = getCachedVolume(poolAddress);
  if (cached) return cached;

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

    const volumeData: PoolVolumeData = {
      weeklyVolumeUSD,
      annualizedVolumeUSD,
      token0Decimals: parseInt(pool.token0.decimals),
      token1Decimals: parseInt(pool.token1.decimals),
      token0Symbol: pool.token0.symbol,
      token1Symbol: pool.token1.symbol
    };

    setCachedVolume(poolAddress, volumeData);
    
    console.log("Fetched fresh volume:", { pool: pool.id, weeklyVolumeUSD, annualizedVolumeUSD });

    return volumeData;
  } catch (error) {
    console.error("Error fetching pool volume:", error);
    return null;
  }
}

export function clearVolumeCache(): void {
  volumeCache.clear();
}

export interface PositionParams {
  token0Amount: number;
  token1Amount: number;
  token0Price: number;
  token1Price: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  fee: number;
}

export function calculateAPR(params: PositionParams, annualizedVolumeUSD: number): number {
  const { token0Amount, token1Amount, token0Price, token1Price, tickLower, tickUpper, currentTick, fee } = params;
  
  if (token0Amount <= 0 && token1Amount <= 0) return 0;
  if (annualizedVolumeUSD <= 0) return 0;
  if (tickUpper <= tickLower) return 0;
  
  const positionValueUSD = (token0Amount * token0Price) + (token1Amount * token1Price);
  if (positionValueUSD < 0.01) return 0;

  const feeDecimal = fee / 10000;
  
  const inRange = currentTick >= tickLower && currentTick <= tickUpper;
  if (!inRange) return 0;
  
  const expectedAnnualFees = annualizedVolumeUSD * feeDecimal;
  const apr = (expectedAnnualFees / positionValueUSD) * 100;

  if (!isFinite(apr) || isNaN(apr)) return 0;
  
  return Math.max(0, Math.min(apr, 500));
}
