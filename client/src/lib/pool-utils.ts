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
    displaySymbol: string;
    decimals: number;
    name: string;
  };
  token1: {
    address: string;
    symbol: string;
    displaySymbol: string;
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

// ─── Stable token set ─────────────────────────────────────────────────────────
// ARC testnet only — Stable Testnet (2201) has been decommissioned.
const STABLE_SYMBOLS = new Set(["usdc", "wusdc", "usdt", "wusdt", "usd"]);

function isStable(symbol: string): boolean {
  return STABLE_SYMBOLS.has(symbol.toLowerCase());
}

// ─── Provider ────────────────────────────────────────────────────────────────
function makeProvider(): BrowserProvider {
  return new BrowserProvider({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const res = await fetch("https://rpc.testnet.arc.network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message ?? "RPC error");
      return json.result;
    },
  });
}

// ─── Main fetch ───────────────────────────────────────────────────────────────
export async function fetchAllPools(
  factoryAddress: string,
  chainId: number,
  knownTokens: Token[]
): Promise<PoolData[]> {
  try {
    const provider = makeProvider();
    const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
    const pairsLength = await factory.allPairsLength();
    const length = Number(pairsLength);

    console.log(`[V2] Found ${length} pools on chain ${chainId}`);

    const pairAddresses: string[] = await Promise.all(
      Array.from({ length }, (_, i) => factory.allPairs(i))
    );

    const pools: PoolData[] = [];

    for (const pairAddress of pairAddresses) {
      try {
        const pair = new Contract(pairAddress, PAIR_ABI, provider);

        const [token0Address, token1Address, reserves, totalSupply] =
          await Promise.all([
            pair.token0(),
            pair.token1(),
            pair.getReserves(),
            pair.totalSupply(),
          ]);

        const token0 = new Contract(token0Address, ERC20_ABI, provider);
        const token1 = new Contract(token1Address, ERC20_ABI, provider);
        const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

        const [
          token0Symbol,
          token0Decimals,
          token0Name,
          token1Symbol,
          token1Decimals,
          token1Name,
        ] = await Promise.all([
          token0.symbol().catch(() => shortAddr(token0Address)),
          token0.decimals().catch(() => 18),
          token0.name().catch(() => `Token ${shortAddr(token0Address)}`),
          token1.symbol().catch(() => shortAddr(token1Address)),
          token1.decimals().catch(() => 18),
          token1.name().catch(() => `Token ${shortAddr(token1Address)}`),
        ]);

        // Skip 1:1 wrap pairs — not real trading pairs
        if (isWrappedTokenPair(token0Symbol, token1Symbol)) {
          console.log(`[V2] Skipping wrap pair: ${token0Symbol}/${token1Symbol}`);
          continue;
        }

        const reserve0 = reserves[0];
        const reserve1 = reserves[1];
        const reserve0Formatted = formatUnits(reserve0, Number(token0Decimals));
        const reserve1Formatted = formatUnits(reserve1, Number(token1Decimals));

        const tvlUSD = calculateTVL(
          token0Symbol,
          token1Symbol,
          parseFloat(reserve0Formatted),
          parseFloat(reserve1Formatted),
        );

        pools.push({
          pairAddress,
          token0: {
            address: token0Address,
            symbol: token0Symbol,
            displaySymbol: getDisplaySymbol(token0Symbol),
            decimals: Number(token0Decimals),
            name: token0Name,
          },
          token1: {
            address: token1Address,
            symbol: token1Symbol,
            displaySymbol: getDisplaySymbol(token1Symbol),
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

        console.log(`[V2] Loaded: ${token0Symbol}/${token1Symbol}  TVL=$${tvlUSD.toFixed(2)}`);
      } catch (error) {
        console.error(`[V2] Failed to load pair ${pairAddress}:`, error);
      }
    }

    return pools;
  } catch (error) {
    console.error("[V2] Failed to fetch pools:", error);
    throw error;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calculateTVL(
  symbol0: string,
  symbol1: string,
  reserve0: number,
  reserve1: number,
): number {
  const is0 = isStable(symbol0);
  const is1 = isStable(symbol1);

  if (is0 && is1) return reserve0 + reserve1;
  if (is0) return 2 * reserve0;
  if (is1) return 2 * reserve1;
  return 0;
}

/**
 * 1:1 wrapped-token pairs that should be hidden (e.g. USDC/wUSDC).
 * Only relevant for ARC testnet now.
 */
function isWrappedTokenPair(sym0: string, sym1: string): boolean {
  const pairs: [string, string][] = [
    ["usdc", "wusdc"],
    ["wusdc", "usdc"],
    ["usdt", "wusdt"],
    ["wusdt", "usdt"],
  ];
  return pairs.some(
    ([a, b]) =>
      sym0.toLowerCase() === a && sym1.toLowerCase() === b,
  );
}

function getDisplaySymbol(symbol: string): string {
  if (symbol.toLowerCase() === "wusdc") return "USDC";
  if (symbol.toLowerCase() === "wusdt") return "USDT";
  return symbol;
}

export function calculateTotalTVL(pools: PoolData[]): number {
  return pools.reduce((sum, p) => sum + p.tvlUSD, 0);
}
