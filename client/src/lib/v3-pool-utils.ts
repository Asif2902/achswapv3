import { Contract, ZeroAddress } from "ethers";
import type { JsonRpcProvider } from "ethers";
import { formatUnits } from "ethers";
import type { Token } from "@shared/schema";
import { V3_FACTORY_ABI, V3_POOL_ABI, FEE_TIER_LABELS } from "./abis/v3";
import { createAlchemyProvider } from "./config";

// ─── ABIs ────────────────────────────────────────────────────────────────────

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

// ─── Fee tiers to check ───────────────────────────────────────────────────────
// Every known Uniswap V3 fee tier — checked exhaustively so no pool is missed.
const ALL_FEE_TIERS = [100, 500, 2500, 3000, 10000, 100000] as const;

// ─── Stable token sets per chain ─────────────────────────────────────────────

const STABLE_BY_CHAIN: Record<number, Set<string>> = {
  5042002: new Set(["usdc", "wusdc", "usdt", "wusdt", "usd"]),
  // Add more chains here, e.g.:
  // 1: new Set(["usdc", "usdt", "dai"]),
};

function stableSet(chainId: number): Set<string> {
  return STABLE_BY_CHAIN[chainId] ?? new Set(["usdc", "usdt", "dai", "usd", "busd"]);
}

// ─── TVL ─────────────────────────────────────────────────────────────────────

function calcTVL(
  sym0: string,
  sym1: string,
  amt0: number,
  amt1: number,
  chainId: number,
): number {
  const stables = stableSet(chainId);
  const is0 = stables.has(sym0.toLowerCase());
  const is1 = stables.has(sym1.toLowerCase());
  if (is0 && is1) return amt0 + amt1;
  if (is0) return 2 * amt0;
  if (is1) return 2 * amt1;
  return 0;
}

// ─── Token metadata cache ────────────────────────────────────────────────────
// Caches ERC-20 metadata (symbol, decimals, name) so repeated calls across
// different pools/positions don't re-fetch from RPC.  Known tokens are
// resolved instantly from the knownTokens list (no RPC at all).

interface TokenInfo {
  symbol: string;
  decimals: number;
  name: string;
}

const tokenInfoCache = new Map<string, TokenInfo>();

/**
 * Return token metadata, using in-memory cache → knownTokens → RPC (last resort).
 * Every field falls back gracefully so a broken token contract can never
 * crash pool discovery.
 */
export async function safeTokenInfo(
  address: string,
  provider: JsonRpcProvider,
  knownTokens: Token[],
): Promise<TokenInfo> {
  const key = address.toLowerCase();

  // 1. In-memory cache hit (fastest)
  const cached = tokenInfoCache.get(key);
  if (cached) return cached;

  // 2. Known token list (no RPC call)
  const known = knownTokens.find(
    (t) => t.address.toLowerCase() === key,
  );
  if (known) {
    const info: TokenInfo = {
      symbol:   known.symbol   ?? address.slice(0, 8),
      decimals: known.decimals ?? 18,
      name:     known.name     ?? known.symbol ?? address.slice(0, 8),
    };
    tokenInfoCache.set(key, info);
    return info;
  }

  // 3. RPC fallback — fetch each field independently so one failure
  //    does not kill the rest.
  const contract  = new Contract(address, ERC20_ABI, provider);
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;

  const [symbol, decimals, name] = await Promise.all([
    contract.symbol().catch(() => shortAddr),
    contract.decimals().catch(() => 18),
    contract.name().catch(() => `Token ${shortAddr}`),
  ]);

  const info: TokenInfo = {
    symbol:   typeof symbol === "string" && symbol.length > 0 ? symbol   : shortAddr,
    decimals: Number(decimals) || 18,
    name:     typeof name   === "string" && name.length   > 0 ? name     : `Token ${shortAddr}`,
  };
  tokenInfoCache.set(key, info);
  return info;
}

// ─── Concurrency helper ──────────────────────────────────────────────────────

/**
 * Run async tasks with bounded concurrency.
 * Like Promise.all but limits how many are in-flight simultaneously.
 */
async function pAll<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );
  return results;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Two-phase pool discovery with batch RPC and throttled parallelism.
 *
 * Phase 1 — pool address discovery:
 *   Call factory.getPool(tokenA, tokenB, fee) for every combination.
 *   Uses throttled parallelism (5 concurrent) instead of fully serial.
 *   The batch provider packs concurrent calls into a single HTTP request,
 *   so 5 concurrent calls ≈ 1 HTTP round-trip.
 *
 * Phase 2 — pool detail fetch:
 *   For each discovered pool, fetch slot0, liquidity, token info, balances.
 *   Pools are loaded in parallel (3 concurrent) — within each pool, all
 *   reads are batched into a single HTTP request by the batch provider.
 */
export async function fetchAllV3Pools(
  factoryAddress: string,
  chainId: number,
  knownTokens: Token[],
): Promise<V3PoolData[]> {
  console.log("[V3] Starting pool discovery with", knownTokens.length, "tokens");
  
  const provider = createAlchemyProvider(chainId);
  const factory  = new Contract(factoryAddress, V3_FACTORY_ABI, provider);

  // ── Phase 1: discover pool addresses (throttled parallel) ─────────────────
  const discovered = new Map<string, number>();

  console.log("[V3] Known tokens:", knownTokens.map(t => t.symbol));

  // Build all (tokenA, tokenB, fee) combinations to check
  const discoveryTasks: (() => Promise<void>)[] = [];
  for (let i = 0; i < knownTokens.length; i++) {
    for (let j = i + 1; j < knownTokens.length; j++) {
      for (const fee of ALL_FEE_TIERS) {
        const tokenI = knownTokens[i];
        const tokenJ = knownTokens[j];

        // Check ALL pairs - the batch provider handles the load efficiently
        discoveryTasks.push(async () => {
          try {
            const poolAddress: string = await factory.getPool(
              tokenI.address,
              tokenJ.address,
              fee,
            );
            if (
              !poolAddress ||
              poolAddress === ZeroAddress ||
              discovered.has(poolAddress.toLowerCase())
            ) {
              return;
            }
            discovered.set(poolAddress.toLowerCase(), fee);
            console.log(
              `[V3] Discovered pool ${poolAddress} ` +
              `(${tokenI.symbol}/${tokenJ.symbol} fee=${fee})`,
            );
          } catch {
            // No pool for this combination — completely expected.
          }
        });
      }
    }
  }

  // Run discovery with higher concurrency for faster results.
  // The batch provider packs concurrent eth_calls into single HTTP requests.
  try {
    await pAll(discoveryTasks, 10);
  } catch (err) {
    console.error("[V3] Phase 1 discovery error:", err);
  }

  console.log(`[V3] Phase 1 done — ${discovered.size} unique pool(s) found`);

  // ── Phase 2: fetch data for each discovered pool (parallel) ───────────────
  const poolTasks = Array.from(discovered.entries()).map(
    ([poolAddrLower, fee]) => async (): Promise<V3PoolData | null> => {
      try {
        const poolContract = new Contract(poolAddrLower, V3_POOL_ABI, provider);

        // All 4 reads hit the same pool contract — the batch provider packs
        // them + the token info + balances into a single HTTP request.
        let slot0Raw: any;
        let liquidity: bigint;
        let poolToken0Addr: string;
        let poolToken1Addr: string;

        try {
          [slot0Raw, liquidity, poolToken0Addr, poolToken1Addr] = await Promise.all([
            poolContract.slot0(),
            poolContract.liquidity(),
            poolContract.token0(),
            poolContract.token1(),
          ]);
        } catch (err) {
          console.warn(`[V3] Cannot read state for pool ${poolAddrLower}:`, err);
          return null;
        }

        const sqrtPriceX96: bigint = slot0Raw[0];
        const tick = Number(slot0Raw[1]);

        if (!sqrtPriceX96 || sqrtPriceX96 === 0n) {
          console.debug(`[V3] Pool ${poolAddrLower} uninitialised, skipping`);
          return null;
        }

        // Token metadata + balances — all in one batch thanks to the provider.
        const erc0 = new Contract(poolToken0Addr, ERC20_ABI, provider);
        const erc1 = new Contract(poolToken1Addr, ERC20_ABI, provider);

        const [info0, info1, raw0, raw1] = await Promise.all([
          safeTokenInfo(poolToken0Addr, provider, knownTokens),
          safeTokenInfo(poolToken1Addr, provider, knownTokens),
          erc0.balanceOf(poolAddrLower).catch(() => 0n) as Promise<bigint>,
          erc1.balanceOf(poolAddrLower).catch(() => 0n) as Promise<bigint>,
        ]);

        const balance0: bigint =
          typeof raw0 === "bigint" ? raw0 : BigInt(String(raw0 ?? 0));
        const balance1: bigint =
          typeof raw1 === "bigint" ? raw1 : BigInt(String(raw1 ?? 0));

        const token0Formatted = formatUnits(balance0, info0.decimals);
        const token1Formatted = formatUnits(balance1, info1.decimals);

        const tvlUSD = calcTVL(
          info0.symbol,
          info1.symbol,
          parseFloat(token0Formatted),
          parseFloat(token1Formatted),
          chainId,
        );

        const feeLabel =
          FEE_TIER_LABELS[fee as keyof typeof FEE_TIER_LABELS] ??
          `${(fee / 10_000).toFixed(2)}%`;

        console.log(
          `[V3] Loaded: ${info0.symbol}/${info1.symbol} @ ${feeLabel} — TVL $${tvlUSD.toFixed(2)}`,
        );

        return {
          poolAddress:     poolAddrLower,
          token0:          { address: poolToken0Addr, symbol: info0.symbol, decimals: info0.decimals, name: info0.name },
          token1:          { address: poolToken1Addr, symbol: info1.symbol, decimals: info1.decimals, name: info1.name },
          fee,
          feeLabel,
          liquidity,
          sqrtPriceX96,
          tick,
          tvlUSD,
          token0Balance:   balance0,
          token1Balance:   balance1,
          token0Formatted,
          token1Formatted,
        };
      } catch (err) {
        console.warn(`[V3] Failed to load pool ${poolAddrLower}:`, err);
        return null;
      }
    },
  );

  // Load pools with bounded concurrency (3 pools at a time).
  const results = await pAll(poolTasks, 3);
  const pools = results.filter((p): p is V3PoolData => p !== null);

  console.log(
    `[V3] Phase 2 done — ${pools.length} pool(s) fully loaded on chain ${chainId}`,
  );
  return pools;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

export function calculateV3TotalTVL(pools: V3PoolData[]): number {
  return pools.reduce((sum, p) => sum + p.tvlUSD, 0);
}
