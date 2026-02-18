import { Contract, BrowserProvider } from "ethers";
import { TICK_LENS_ABI } from "./abis/v3";

export interface PopulatedTick {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
}

/**
 * Fetch populated ticks from a pool using TickLens
 * This helps visualize liquidity distribution and find optimal price ranges
 */
export async function getPopulatedTicks(
  tickLensAddress: string,
  poolAddress: string,
  provider: BrowserProvider
): Promise<PopulatedTick[]> {
  try {
    const tickLens = new Contract(tickLensAddress, TICK_LENS_ABI, provider);
    
    // Get ticks around current price (bitmap index 0)
    // In production, you'd want to query multiple bitmap indices
    const populatedTicks = await tickLens.getPopulatedTicksInWord(poolAddress, 0);
    
    return populatedTicks.map((tick: any) => ({
      tick: Number(tick.tick),
      liquidityNet: tick.liquidityNet,
      liquidityGross: tick.liquidityGross,
    }));
  } catch (error) {
    console.error("Error fetching populated ticks:", error);
    return [];
  }
}

/**
 * Get liquidity distribution data for visualization
 */
export async function getLiquidityDistribution(
  tickLensAddress: string,
  poolAddress: string,
  provider: BrowserProvider,
  currentTick: number
): Promise<{
  ticks: PopulatedTick[];
  totalLiquidity: bigint;
  ticksAbove: number;
  ticksBelow: number;
}> {
  const ticks = await getPopulatedTicks(tickLensAddress, poolAddress, provider);
  
  const totalLiquidity = ticks.reduce((sum, tick) => sum + tick.liquidityGross, 0n);
  const ticksAbove = ticks.filter(t => t.tick > currentTick).length;
  const ticksBelow = ticks.filter(t => t.tick < currentTick).length;
  
  return {
    ticks,
    totalLiquidity,
    ticksAbove,
    ticksBelow,
  };
}

/**
 * Find optimal tick range based on liquidity distribution
 * Returns ticks where most liquidity is concentrated
 */
export function findOptimalTickRange(
  ticks: PopulatedTick[],
  currentTick: number,
  tickSpacing: number
): { tickLower: number; tickUpper: number } | null {
  if (ticks.length === 0) return null;
  
  // Sort ticks by liquidity
  const sortedByLiquidity = [...ticks].sort((a, b) => 
    Number(b.liquidityGross - a.liquidityGross)
  );
  
  // Find ticks with highest liquidity around current price
  const relevantTicks = sortedByLiquidity.filter(t => 
    Math.abs(t.tick - currentTick) < 10000 // Within reasonable range
  );
  
  if (relevantTicks.length === 0) return null;
  
  // Get min and max ticks from high liquidity areas
  const minTick = Math.min(...relevantTicks.map(t => t.tick));
  const maxTick = Math.max(...relevantTicks.map(t => t.tick));
  
  // Round to tick spacing
  const tickLower = Math.floor(minTick / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil(maxTick / tickSpacing) * tickSpacing;
  
  return { tickLower, tickUpper };
}
