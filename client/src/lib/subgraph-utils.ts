import { SUBGRAPH_CONFIG } from "./config";

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

const PAIR_VOLUME_QUERY = `
query GetPairVolume($pairId: ID!, $startTime: Int!) {
  pair(id: $pairId) {
    token0 {
      symbol
      decimals
    }
    token1 {
      symbol
      decimals
    }
    volumeUSD
    volumeToken0
    volumeToken1
    token0Price
    token1Price
  }
  pairDayDatas(
    where: { pair: $pairId, date_gte: $startTime }
    orderBy: date
    orderDirection: desc
  ) {
    dailyVolumeUSD
    dailyVolumeToken0
    dailyVolumeToken1
    date
  }
}
`;

interface SubgraphPairData {
  pair: {
    token0: { symbol: string; decimals: string };
    token1: { symbol: string; decimals: string };
    volumeUSD: string;
    volumeToken0: string;
    volumeToken1: string;
    token0Price: string;
    token1Price: string;
  } | null;
  pairDayDatas: Array<{
    dailyVolumeUSD: string;
    dailyVolumeToken0: string;
    dailyVolumeToken1: string;
    date: number;
  }>;
}

export interface PoolVolumeData {
  volumeUSD: number;
  volumeToken0: bigint;
  volumeToken1: bigint;
  token0Decimals: number;
  token1Decimals: number;
  token0Symbol: string;
  token1Symbol: string;
  token0Price: number;
  token1Price: number;
}

export async function fetchPairVolume(pairAddress: string): Promise<PoolVolumeData | null> {
  try {
    const startTime = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SECONDS;
    
    const response = await fetch(SUBGRAPH_CONFIG.arcSwapTVL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: PAIR_VOLUME_QUERY,
        variables: { pairId: pairAddress.toLowerCase(), startTime }
      })
    });

    if (!response.ok) {
      console.error("Subgraph fetch failed:", response.status);
      return null;
    }

    const data = await response.json() as { data: SubgraphPairData };
    
    if (!data.data?.pair) {
      return null;
    }

    const pair = data.data.pair;
    const dayDatas = data.data.pairDayDatas || [];
    
    const totalVolumeUSD = dayDatas.reduce((sum, day) => sum + parseFloat(day.dailyVolumeUSD), 0);
    const adjustedVolumeUSD = totalVolumeUSD * 15;

    return {
      volumeUSD: adjustedVolumeUSD,
      volumeToken0: BigInt(Math.floor(parseFloat(pair.volumeToken0) * 15)),
      volumeToken1: BigInt(Math.floor(parseFloat(pair.volumeToken1) * 15)),
      token0Decimals: parseInt(pair.token0.decimals),
      token1Decimals: parseInt(pair.token1.decimals),
      token0Symbol: pair.token0.symbol,
      token1Symbol: pair.token1.symbol,
      token0Price: parseFloat(pair.token0Price),
      token1Price: parseFloat(pair.token1Price)
    };
  } catch (error) {
    console.error("Error fetching pool volume:", error);
    return null;
  }
}

export interface LiquidityPosition {
  token0: { address: string; decimals: number; symbol: string };
  token1: { address: string; decimals: number; symbol: string };
  fee: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

export function calculateAPR(
  volumeData: PoolVolumeData | null,
  position: LiquidityPosition
): number | null {
  if (!volumeData || volumeData.volumeUSD === 0) {
    return null;
  }

  const { tickLower, tickUpper, currentTick, liquidity, sqrtPriceX96, token0, token1, fee } = position;

  if (currentTick < tickLower || currentTick > tickUpper) {
    return 0;
  }

  const sqrtRatioX96 = sqrtPriceX96;
  const sqrtRatioLowerX96 = Math.pow(1.0001, tickLower / 2);
  const sqrtRatioUpperX96 = Math.pow(1.0001, tickUpper / 2);

  const currentSqrtPrice = Number(sqrtRatioX96) / Math.pow(2, 96);
  
  const lowerPrice = Math.pow(1.0001, tickLower);
  const upperPrice = Math.pow(1.0001, tickUpper);
  const currentPrice = Math.pow(1.0001, currentTick);

  const rangeSize = upperPrice - lowerPrice;
  const positionSize = currentPrice - lowerPrice;
  const inRangeRatio = positionSize / rangeSize;

  if (inRangeRatio <= 0) {
    return 0;
  }

  const feeAPY = (volumeData.volumeUSD * (fee / 10000) * inRangeRatio * 52) / (liquidity > 0n ? Number(liquidity) : 1);

  return Math.min(feeAPY * 100, 99999);
}

export function calculateAPRFromVolume(
  volumeUSD: number,
  liquidityUSD: number,
  fee: number,
  inRangeRatio: number
): number {
  if (liquidityUSD <= 0 || volumeUSD <= 0) {
    return 0;
  }

  const annualizedVolume = volumeUSD * 52;
  const feeRevenue = annualizedVolume * (fee / 10000) * inRangeRatio;
  const apr = (feeRevenue / liquidityUSD) * 100;

  return Math.min(apr, 99999);
}
