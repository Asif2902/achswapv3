
import { Contract, BrowserProvider } from "ethers";
import { formatUnits } from "ethers";
import type { Token } from "@shared/schema";

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

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function name() external view returns (string)",
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
    const rpcUrl = chainId === 2201 
      ? 'https://rpc.testnet.stable.xyz/' 
      : 'https://rpc.testnet.arc.network';

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

    const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
    const pairsLength = await factory.allPairsLength();
    const length = Number(pairsLength);

    console.log(`Found ${length} pools on chain ${chainId}`);

    // Fetch all pair addresses
    const pairAddresses: string[] = [];
    for (let i = 0; i < length; i++) {
      const pairAddress = await factory.allPairs(i);
      pairAddresses.push(pairAddress);
    }

    // Fetch pool data for each pair
    const pools: PoolData[] = [];
    
    for (const pairAddress of pairAddresses) {
      try {
        const pairContract = new Contract(pairAddress, PAIR_ABI, provider);
        
        // Get basic pair info
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
          continue;
        }

        // Fetch token info with fallbacks
        const token0Contract = new Contract(token0Address, ERC20_ABI, provider);
        const token1Contract = new Contract(token1Address, ERC20_ABI, provider);

        let token0Symbol = "UNKNOWN";
        let token0Decimals = 18;
        let token0Name = "Unknown Token";
        let token1Symbol = "UNKNOWN";
        let token1Decimals = 18;
        let token1Name = "Unknown Token";

        try {
          token0Symbol = await token0Contract.symbol().catch(() => "UNKNOWN");
        } catch (error) {
          token0Symbol = "UNKNOWN";
        }

        try {
          token0Decimals = await token0Contract.decimals().catch(() => 18);
        } catch (error) {
          token0Decimals = 18;
        }

        try {
          token0Name = await token0Contract.name().catch(() => `Token ${token0Address.substring(0, 6)}`);
        } catch (error) {
          token0Name = `Token ${token0Address.substring(0, 6)}`;
        }

        try {
          token1Symbol = await token1Contract.symbol().catch(() => "UNKNOWN");
        } catch (error) {
          token1Symbol = "UNKNOWN";
        }

        try {
          token1Decimals = await token1Contract.decimals().catch(() => 18);
        } catch (error) {
          token1Decimals = 18;
        }

        try {
          token1Name = await token1Contract.name().catch(() => `Token ${token1Address.substring(0, 6)}`);
        } catch (error) {
          token1Name = `Token ${token1Address.substring(0, 6)}`;
        }

        // Skip wrapped token pairs (wUSDC/USDC, wUSDT/gUSDT) - these are wrap tokens, not trading pairs
        if (isWrappedTokenPair(token0Symbol, token1Symbol, chainId)) {
          console.log(`Skipping wrapped token pair: ${token0Symbol}/${token1Symbol}`);
          continue;
        }

        const reserve0 = reserves[0];
        const reserve1 = reserves[1];

        // Format reserves
        const reserve0Formatted = formatUnits(reserve0, Number(token0Decimals));
        const reserve1Formatted = formatUnits(reserve1, Number(token1Decimals));

        // Calculate TVL in USD using chain-specific logic
        const tvlUSD = calculateTVL(
          token0Symbol,
          token1Symbol,
          parseFloat(reserve0Formatted),
          parseFloat(reserve1Formatted),
          chainId
        );

        pools.push({
          pairAddress,
          token0: {
            address: token0Address,
            symbol: token0Symbol,
            displaySymbol: getDisplaySymbol(token0Symbol, chainId),
            decimals: Number(token0Decimals),
            name: token0Name,
          },
          token1: {
            address: token1Address,
            symbol: token1Symbol,
            displaySymbol: getDisplaySymbol(token1Symbol, chainId),
            decimals: Number(token1Decimals),
            name: token1Name,
          },
          reserve0,
          reserve1,
          reserve0Formatted,
          reserve1Formatted,
          tvlUSD,
          totalSupply,
        });

        console.log(`Successfully loaded pool: ${token0Symbol}/${token1Symbol}`);
      } catch (error) {
        console.error(`Failed to fetch data for pair ${pairAddress}:`, error);
        // Continue to next pool instead of breaking
      }
    }

    return pools;
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
  // wUSDT, gUSDT, USDT = $1 USD on Stable Testnet
  // wUSDC, USDC = $1 USD on ARC Testnet
  const stableTokens = chainId === 2201 
    ? ['gUSDT', 'wUSDT', 'USDT']
    : ['USDC', 'wUSDC'];

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
  const wrappedPairs = chainId === 2201
    ? [['gUSDT', 'wUSDT'], ['wUSDT', 'gUSDT']]
    : [['USDC', 'wUSDC'], ['wUSDC', 'USDC']];
  
  return wrappedPairs.some(
    ([t0, t1]) => token0Symbol === t0 && token1Symbol === t1
  );
}

function getDisplaySymbol(symbol: string, chainId: number): string {
  // Convert wrapped tokens to their unwrapped display names
  if (chainId === 2201) {
    if (symbol === 'wUSDT') return 'USDT';
    if (symbol === 'gUSDT') return 'USDT';
  } else {
    if (symbol === 'wUSDC') return 'USDC';
  }
  return symbol;
}

export function calculateTotalTVL(pools: PoolData[]): number {
  return pools.reduce((sum, pool) => sum + pool.tvlUSD, 0);
}
