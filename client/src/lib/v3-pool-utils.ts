import { Contract, BrowserProvider } from "ethers";
import { formatUnits } from "ethers";
import type { Token } from "@shared/schema";
import { V3_FACTORY_ABI, V3_POOL_ABI, FEE_TIER_LABELS } from "./abis/v3";

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function name() external view returns (string)",
  "function balanceOf(address) external view returns (uint256)",
];

export interface V3PoolData {
  poolAddress: string;
  token0: {
    address: string;
    symbol: string;
    decimals: number;
    name: string;
  };
  token1: {
    address: string;
    symbol: string;
    decimals: number;
    name: string;
  };
  fee: number;
  feeLabel: string;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  tvlUSD: number;
  token0Balance: bigint;
  token1Balance: bigint;
  token0Formatted: string;
  token1Formatted: string;
}

/**
 * Fetch all V3 pools by checking all token pairs and fee tiers
 */
export async function fetchAllV3Pools(
  factoryAddress: string,
  chainId: number,
  knownTokens: Token[]
): Promise<V3PoolData[]> {
  try {
    const rpcUrl = 'https://rpc.testnet.arc.network';

    const provider = new BrowserProvider({
      request: async ({ method, params }: any) => {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params,
          }),
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);
        return data.result;
      },
    });

    const factory = new Contract(factoryAddress, V3_FACTORY_ABI, provider);
    const feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%
    
    const pools: V3PoolData[] = [];
    const checkedPools = new Set<string>();

    // Check all token pair combinations with all fee tiers
    for (let i = 0; i < knownTokens.length; i++) {
      for (let j = i + 1; j < knownTokens.length; j++) {
        const token0 = knownTokens[i];
        const token1 = knownTokens[j];

        for (const fee of feeTiers) {
          try {
            const poolAddress = await factory.getPool(token0.address, token1.address, fee);
            
            // Check if pool exists and not already added
            if (poolAddress === "0x0000000000000000000000000000000000000000" || checkedPools.has(poolAddress)) {
              continue;
            }

            checkedPools.add(poolAddress);

            // Get pool data
            const poolContract = new Contract(poolAddress, V3_POOL_ABI, provider);
            
            const [slot0, liquidity, poolToken0, poolToken1] = await Promise.all([
              poolContract.slot0(),
              poolContract.liquidity(),
              poolContract.token0(),
              poolContract.token1(),
            ]);

            // Get token info
            const token0Contract = new Contract(poolToken0, ERC20_ABI, provider);
            const token1Contract = new Contract(poolToken1, ERC20_ABI, provider);

            const [
              token0Symbol,
              token0Decimals,
              token0Name,
              token0Balance,
              token1Symbol,
              token1Decimals,
              token1Name,
              token1Balance,
            ] = await Promise.all([
              token0Contract.symbol(),
              token0Contract.decimals(),
              token0Contract.name(),
              token0Contract.balanceOf(poolAddress),
              token1Contract.symbol(),
              token1Contract.decimals(),
              token1Contract.name(),
              token1Contract.balanceOf(poolAddress),
            ]);

            const token0Formatted = formatUnits(token0Balance, token0Decimals);
            const token1Formatted = formatUnits(token1Balance, token1Decimals);

            // Simple TVL calculation (assuming 1:1 USD for testnet tokens)
            const tvlUSD = parseFloat(token0Formatted) + parseFloat(token1Formatted);

            pools.push({
              poolAddress,
              token0: {
                address: poolToken0,
                symbol: token0Symbol,
                decimals: Number(token0Decimals),
                name: token0Name,
              },
              token1: {
                address: poolToken1,
                symbol: token1Symbol,
                decimals: Number(token1Decimals),
                name: token1Name,
              },
              fee,
              feeLabel: FEE_TIER_LABELS[fee as keyof typeof FEE_TIER_LABELS] || `${fee / 10000}%`,
              liquidity,
              sqrtPriceX96: slot0[0],
              tick: Number(slot0[1]),
              tvlUSD,
              token0Balance,
              token1Balance,
              token0Formatted,
              token1Formatted,
            });
          } catch (error) {
            // Pool doesn't exist or error fetching, continue
            continue;
          }
        }
      }
    }

    console.log(`Found ${pools.length} V3 pools on chain ${chainId}`);
    return pools;
  } catch (error) {
    console.error("Error fetching V3 pools:", error);
    return [];
  }
}

/**
 * Calculate total TVL for V3 pools
 */
export function calculateV3TotalTVL(pools: V3PoolData[]): number {
  return pools.reduce((total, pool) => total + pool.tvlUSD, 0);
}
