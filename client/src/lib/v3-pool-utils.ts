import { Contract, BrowserProvider, ZeroAddress } from "ethers";
import { formatUnits } from "ethers";
import type { Token } from "@shared/schema";
import { V3_FACTORY_ABI, V3_POOL_ABI, FEE_TIER_LABELS } from "./abis/v3";

// ─── ABI ────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function name() external view returns (string)",
  "function balanceOf(address) external view returns (uint256)",
];

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Every fee tier that can exist on Uniswap V3 / forks.
 * We check all of them so no pool is silently missed.
 */
const ALL_FEE_TIERS = [100, 500, 2500, 3000, 10000, 100000] as const;

/**
 * Stable tokens per chain — pegged to $1 USD.
 * Keys are lower-cased symbols for comparison safety.
 */
/**
 * Stable token symbols pegged to $1 USD on ARC testnet (chainId 5042002).
 * Compared lowercase for safety.
 */
const STABLE_SYMBOLS = new Set(["usdc", "wusdc", "usdt", "wusdt", "usd"]);

function getStableSet(_chainId: number): Set<string> {
  return STABLE_SYMBOLS;
}

// ─── TVL calculation ──────────────────────────────────────────────────────────

/**
 * Mirrors the V2 logic exactly:
 *  - Both stable?   → reserve0 + reserve1
 *  - One stable?    → 2× that side
 *  - None stable?   → 0  (no price oracle available on testnet)
 */
function calculateV3TVL(
  symbol0: string,
  symbol1: string,
  amount0: number,
  amount1: number,
  chainId: number,
): number {
  const stables = getStableSet(chainId);
  const is0 = stables.has(symbol0.toLowerCase());
  const is1 = stables.has(symbol1.toLowerCase());

  if (is0 && is1) return amount0 + amount1;
  if (is0) return 2 * amount0;
  if (is1) return 2 * amount1;
  return 0;
}

// ─── Safe token info fetch ────────────────────────────────────────────────────

interface TokenInfo {
  symbol: string;
  decimals: number;
  name: string;
}

/**
 * Fetch ERC-20 metadata for a single address.
 * Every field has a safe fallback — a bad token can never crash the whole
 * pool discovery loop.
 */
async function safeTokenInfo(
  address: string,
  poolAddress: string,
  provider: BrowserProvider,
  knownTokens: Token[],
): Promise<TokenInfo> {
  // Fast path: if we already know this token, skip the RPC calls.
  const known = knownTokens.find(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  );
  if (known) {
    return {
      symbol: known.symbol,
      decimals: known.decimals ?? 18,
      name: known.name ?? known.symbol,
    };
  }

  const contract = new Contract(address, ERC20_ABI, provider);
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;

  const [symbol, decimals, name] = await Promise.all([
    contract.symbol().catch(() => shortAddr),
    contract.decimals().catch(() => 18),
    contract.name().catch(() => `Token ${shortAddr}`),
  ]);

  return {
    symbol: typeof symbol === "string" && symbol.length > 0 ? symbol : shortAddr,
    decimals: Number(decimals) || 18,
    name: typeof name === "string" && name.length > 0 ? name : `Token ${shortAddr}`,
  };
}

// ─── Provider factory ─────────────────────────────────────────────────────────

function makeProvider(chainId: number): BrowserProvider {
  const rpcUrl = "https://rpc.testnet.arc.network";

  return new BrowserProvider({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const res = await fetch(rpcUrl, {
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

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Discover all V3 pools by iterating every (tokenA, tokenB, fee) combination
 * for every fee tier, including less-common ones (2500, 100000).
 *
 * Design goals:
 *  1. Miss as few pools as possible — checks ALL 6 fee tiers.
 *  2. Never crash on bad token data — every field has a safe fallback.
 *  3. Correct TVL — same stable-token logic as V2.
 *  4. Deduplicated — a pool address is only processed once.
 */
export async function fetchAllV3Pools(
  factoryAddress: string,
  chainId: number,
  knownTokens: Token[],
): Promise<V3PoolData[]> {
  const provider = makeProvider(chainId);
  const factory = new Contract(factoryAddress, V3_FACTORY_ABI, provider);

  const pools: V3PoolData[] = [];
  const seen = new Set<string>(); // pool addresses already processed

  // Build a flat list of all (tokenA, tokenB, fee) triples to check.
  // We also include reversed pairs as a safety net — the factory normalises
  // them internally, so duplicates are caught by the `seen` set.
  const tasks: Array<[string, string, number]> = [];

  for (let i = 0; i < knownTokens.length; i++) {
    for (let j = i + 1; j < knownTokens.length; j++) {
      for (const fee of ALL_FEE_TIERS) {
        tasks.push([knownTokens[i].address, knownTokens[j].address, fee]);
      }
    }
  }

  // Process tasks in parallel batches to avoid flooding the RPC node.
  const BATCH = 10;

  for (let start = 0; start < tasks.length; start += BATCH) {
    const batch = tasks.slice(start, start + BATCH);

    await Promise.all(
      batch.map(async ([addrA, addrB, fee]) => {
        try {
          const poolAddress: string = await factory.getPool(addrA, addrB, fee);

          if (
            !poolAddress ||
            poolAddress === ZeroAddress ||
            seen.has(poolAddress.toLowerCase())
          ) {
            return;
          }
          seen.add(poolAddress.toLowerCase());

          const pool = new Contract(poolAddress, V3_POOL_ABI, provider);

          // Fetch pool state — if this fails the pool is uninitialised; skip.
          const [slot0Raw, liquidity, poolToken0Addr, poolToken1Addr] =
            await Promise.all([
              pool.slot0(),
              pool.liquidity(),
              pool.token0(),
              pool.token1(),
            ]);

          const sqrtPriceX96: bigint = slot0Raw[0];
          const tick = Number(slot0Raw[1]);

          // Pool is deployed but not initialised (sqrtPrice = 0) — skip.
          if (sqrtPriceX96 === 0n) return;

          // Fetch token metadata with full per-field fallbacks.
          const [info0, info1] = await Promise.all([
            safeTokenInfo(poolToken0Addr, poolAddress, provider, knownTokens),
            safeTokenInfo(poolToken1Addr, poolAddress, provider, knownTokens),
          ]);

          // Fetch pool token balances (actual liquidity held in the contract).
          const erc0 = new Contract(poolToken0Addr, ERC20_ABI, provider);
          const erc1 = new Contract(poolToken1Addr, ERC20_ABI, provider);

          const [raw0, raw1] = await Promise.all([
            erc0.balanceOf(poolAddress).catch(() => 0n),
            erc1.balanceOf(poolAddress).catch(() => 0n),
          ]);

          const balance0 = typeof raw0 === "bigint" ? raw0 : BigInt(String(raw0));
          const balance1 = typeof raw1 === "bigint" ? raw1 : BigInt(String(raw1));

          const formatted0 = formatUnits(balance0, info0.decimals);
          const formatted1 = formatUnits(balance1, info1.decimals);

          const tvlUSD = calculateV3TVL(
            info0.symbol,
            info1.symbol,
            parseFloat(formatted0),
            parseFloat(formatted1),
            chainId,
          );

          const feeLabel =
            FEE_TIER_LABELS[fee as keyof typeof FEE_TIER_LABELS] ??
            `${(fee / 10_000).toFixed(2)}%`;

          pools.push({
            poolAddress,
            token0: {
              address: poolToken0Addr,
              symbol: info0.symbol,
              decimals: info0.decimals,
              name: info0.name,
            },
            token1: {
              address: poolToken1Addr,
              symbol: info1.symbol,
              decimals: info1.decimals,
              name: info1.name,
            },
            fee,
            feeLabel,
            liquidity,
            sqrtPriceX96,
            tick,
            tvlUSD,
            token0Balance: balance0,
            token1Balance: balance1,
            token0Formatted: formatted0,
            token1Formatted: formatted1,
          });

          console.log(
            `[V3] Found pool: ${info0.symbol}/${info1.symbol} @ ${feeLabel}  TVL=$${tvlUSD.toFixed(2)}`,
          );
        } catch {
          // Silently skip — pool doesn't exist for this combination.
        }
      }),
    );
  }

  console.log(`[V3] Total pools discovered on chain ${chainId}: ${pools.length}`);
  return pools;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function calculateV3TotalTVL(pools: V3PoolData[]): number {
  return pools.reduce((sum, p) => sum + p.tvlUSD, 0);
}
