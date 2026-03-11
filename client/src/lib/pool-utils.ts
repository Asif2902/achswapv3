
import { Contract } from "ethers";
import { formatUnits } from "ethers";
import type { Token } from "@shared/schema";
import { createAlchemyProvider } from "./config";
import { safeTokenInfo } from "./v3-pool-utils";

const FACTORY_ABI = [
  "function allPairsLength() external view returns (uint)",
  "function allPairs(uint) external view returns (address)",
];

const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() external view returns (uint256)",
];

export interface PoolData {
  pairAddress: string;
  token0: {
    address: string;
    symbol: string;
    displaySymbol: string; // Unwrapped symbol for display
    decimals: number;
    name: string;
  };
  token1: {
    address: string;
    symbol: string;
    displaySymbol: string; // Unwrapped symbol for display
    decimals: number;
    name: string;
  };
  reserve0: bigint;
  reserve1: bigint;
  reserve0Formatted: string;
  reserve1Formatted: string;
  tvlUSD: number;
  totalSupply: bigint;
}

export async function fetchAllPools(
  factoryAddress: string,
  chainId: number,
  knownTokens: Token[]
): Promise<PoolData[]> {
  try {
    const provider = createAlchemyProvider(chainId);
    const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
    const pairsLength = await factory.allPairsLength();
    const length = Number(pairsLength);

    console.log(`Found ${length} pools on chain ${chainId}`);

    // Fetch all pair addresses in parallel (batch provider packs into ~1 HTTP request)
    const pairAddresses: string[] = await Promise.all(
      Array.from({ length }, (_, i) => factory.allPairs(i)),
    );

    // Fetch pool data for each pair in parallel (the batch provider limits concurrency under the hood)
    const poolResults = await Promise.all(
      pairAddresses.map(async (pairAddress): Promise<PoolData | null> => {
        try {
          const pairContract = new Contract(pairAddress, PAIR_ABI, provider);

          // Get basic pair info — all 4 calls batched into one HTTP request
          let token0Address: string;
          let token1Address: string;
          let reserves: any;
          let totalSupply: bigint;

          try {
            [token0Address, token1Address, reserves, totalSupply] = await Promise.all([
              pairContract.token0(),
              pairContract.token1(),
              pairContract.getReserves(),
              pairContract.totalSupply(),
            ]);
          } catch (error) {
            console.error(`Failed to fetch basic pair info for ${pairAddress}:`, error);
            return null;
          }

          // Fetch token info in parallel (uses cached metadata when available)
          const [info0, info1] = await Promise.all([
            safeTokenInfo(token0Address, provider, knownTokens),
            safeTokenInfo(token1Address, provider, knownTokens),
          ]);

          const reserve0 = reserves[0];
          const reserve1 = reserves[1];

          // Format reserves
          const reserve0Formatted = formatUnits(reserve0, info0.decimals);
          const reserve1Formatted = formatUnits(reserve1, info1.decimals);

          // Calculate TVL in USD using chain-specific logic
          const tvlUSD = calculateTVL(
            info0.symbol,
            info1.symbol,
            parseFloat(reserve0Formatted),
            parseFloat(reserve1Formatted),
            chainId
          );

          return {
            pairAddress,
            token0: {
              address: token0Address,
              symbol: info0.symbol,
              displaySymbol: getDisplaySymbol(info0.symbol, chainId),
              decimals: info0.decimals,
              name: info0.name,
            },
            token1: {
              address: token1Address,
              symbol: info1.symbol,
              displaySymbol: getDisplaySymbol(info1.symbol, chainId),
              decimals: info1.decimals,
              name: info1.name,
            },
            reserve0,
            reserve1,
            reserve0Formatted,
            reserve1Formatted,
            tvlUSD,
            totalSupply,
          };
        } catch (error) {
          console.error(`Failed to fetch data for pair ${pairAddress}:`, error);
          return null;
        }
      }),
    );

    return poolResults.filter((p): p is PoolData => p !== null);
  } catch (error) {
    console.error('Failed to fetch pools:', error);
    throw error;
  }
}

function calculateTVL(
  token0Symbol: string,
  token1Symbol: string,
  reserve0: number,
  reserve1: number,
  chainId: number
): number {
  // All stable tokens are pegged to $1 USD
  // wUSDC, USDC = $1 USD on ARC Testnet
  // Extend this list per chain as needed
  const stableTokens = ['USDC', 'wUSDC'];

  const isToken0Stable = stableTokens.includes(token0Symbol);
  const isToken1Stable = stableTokens.includes(token1Symbol);

  if (isToken0Stable && isToken1Stable) {
    // Both stable tokens = direct sum in USD (each token = $1)
    return reserve0 + reserve1;
  } else if (isToken0Stable) {
    // Token0 is $1 stable, so TVL in USD = 2 * reserve0
    return 2 * reserve0;
  } else if (isToken1Stable) {
    // Token1 is $1 stable, so TVL in USD = 2 * reserve1
    return 2 * reserve1;
  } else {
    // Neither is stable - we can't calculate USD value without price data
    return 0;
  }
}

function isWrappedTokenPair(token0Symbol: string, token1Symbol: string, chainId: number): boolean {
  // Wrapped tokens are not trading pairs, they're 1:1 wrappers
  // Extend per chain as needed
  const wrappedPairs = [['USDC', 'wUSDC'], ['wUSDC', 'USDC']];
  
  return wrappedPairs.some(
    ([t0, t1]) => token0Symbol === t0 && token1Symbol === t1
  );
}

function getDisplaySymbol(symbol: string, chainId: number): string {
  // Convert wrapped tokens to their unwrapped display names
  // Extend per chain as needed
  if (symbol === 'wUSDC') return 'USDC';
  return symbol;
}

export function calculateTotalTVL(pools: PoolData[]): number {
  return pools.reduce((sum, pool) => sum + pool.tvlUSD, 0);
}
