import { Contract, BrowserProvider, ZeroAddress } from "ethers";
import { formatUnits } from "ethers";
import type { Token } from "@shared/schema";
import { V3_FACTORY_ABI, V3_POOL_ABI, FEE_TIER_LABELS } from "./abis/v3";
import { getRpcUrl } from "./config";

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
  2201:    new Set(["gusdt", "wusdt", "usdt", "usd"]),
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

// ─── Safe ERC-20 info ────────────────────────────────────────────────────────

interface TokenInfo {
  symbol: string;
  decimals: number;
  name: string;
}

/**
 * Return token metadata, using knownTokens list first to skip RPC calls.
 * Every field falls back gracefully so a broken token contract can never
 * crash pool discovery.
 */
async function safeTokenInfo(
  address: string,
  provider: BrowserProvider,
  knownTokens: Token[],
): Promise<TokenInfo> {
  const known = knownTokens.find(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  );
  if (known) {
    return {
      symbol:   known.symbol   ?? address.slice(0, 8),
      decimals: known.decimals ?? 18,
      name:     known.name     ?? known.symbol ?? address.slice(0, 8),
    };
  }

  const contract  = new Contract(address, ERC20_ABI, provider);
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;

  // Each field fetched independently — one failure does not kill the rest.
  const symbol   = await contract.symbol().catch(()   => shortAddr);
  const decimals = await contract.decimals().catch(()  => 18);
  const name     = await contract.name().catch(()     => `Token ${shortAddr}`);

  return {
    symbol:   typeof symbol === "string"   && symbol.length   > 0 ? symbol   : shortAddr,
    decimals: Number(decimals) || 18,
    name:     typeof name   === "string"   && name.length     > 0 ? name     : `Token ${shortAddr}`,
  };
}

// ─── Provider ────────────────────────────────────────────────────────────────

function makeProvider(chainId: number): BrowserProvider {
  const rpcUrl = getRpcUrl(chainId);

  return new BrowserProvider({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const res = await fetch(rpcUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message ?? "RPC error");
      return json.result;
    },
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Two-phase serial pool discovery.
 *
 * WHY SERIAL and not Promise.all?
 *   Testnet RPC nodes have very low rate limits. The previous version used
 *   Promise.all batches of 10, which fired 10 concurrent eth_calls at once.
 *   Under that load the node started dropping / rate-limiting requests and
 *   the silent catch{} swallowed every error — making it look like only
 *   1–2 pools existed. Serial calls avoid this entirely. Each getPool
 *   eth_call takes ~50ms; even 60 combinations finishes in ~3 seconds.
 *
 * Phase 1 — pool address discovery (serial):
 *   Call factory.getPool(tokenA, tokenB, fee) for every combination.
 *   Collect non-zero, unique addresses into a Map.
 *
 * Phase 2 — pool detail fetch (serial per pool):
 *   For each discovered address: fetch slot0, liquidity, token info, balances.
 *   Uses Promise.all only within a single pool (4 fields from the same pool
 *   at once is fine and doesn't overload the node).
 */
export async function fetchAllV3Pools(
  factoryAddress: string,
  chainId: number,
  knownTokens: Token[],
): Promise<V3PoolData[]> {
  console.log('[V3] Starting fetch, chainId:', chainId, 'factory:', factoryAddress, 'tokens:', knownTokens.length);
  const provider = makeProvider(chainId);
  const factory  = new Contract(factoryAddress, V3_FACTORY_ABI, provider);

  // ── Phase 1: collect unique pool addresses ────────────────────────────────
  // Map: lowercase pool address → fee tier it was found at
  const discovered = new Map<string, number>();

  for (let i = 0; i < knownTokens.length; i++) {
    for (let j = i + 1; j < knownTokens.length; j++) {
      for (const fee of ALL_FEE_TIERS) {
        try {
          const poolAddress: string = await factory.getPool(
            knownTokens[i].address,
            knownTokens[j].address,
            fee,
          );

          if (
            !poolAddress ||
            poolAddress === ZeroAddress ||
            discovered.has(poolAddress.toLowerCase())
          ) {
            continue;
          }

          discovered.set(poolAddress.toLowerCase(), fee);
          console.log(
            `[V3] Discovered pool ${poolAddress} ` +
            `(${knownTokens[i].symbol}/${knownTokens[j].symbol} fee=${fee})`,
          );
        } catch (err) {
          // No pool for this combination — completely expected.
          console.debug(
            `[V3] No pool: ${knownTokens[i].symbol}/${knownTokens[j].symbol} fee=${fee}`,
          );
        }
      }
    }
  }

  console.log(`[V3] Phase 1 done — ${discovered.size} unique pool(s) found`);

  // ── Phase 2: fetch data for each discovered pool ──────────────────────────
  const pools: V3PoolData[] = [];

  for (const [poolAddrLower, fee] of discovered.entries()) {
    try {
      const poolContract = new Contract(poolAddrLower, V3_POOL_ABI, provider);

      // Fetch pool-level state. These 4 calls go to the same contract so
      // batching them with Promise.all is safe (single pool, low concurrency).
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
        continue;
      }

      const sqrtPriceX96: bigint = slot0Raw[0];
      const tick = Number(slot0Raw[1]);

      // Skip uninitialised pools (price not set yet).
      if (!sqrtPriceX96 || sqrtPriceX96 === 0n) {
        console.debug(`[V3] Pool ${poolAddrLower} uninitialised, skipping`);
        continue;
      }

      // Token metadata — uses knownTokens fast path wherever possible.
      const [info0, info1] = await Promise.all([
        safeTokenInfo(poolToken0Addr, provider, knownTokens),
        safeTokenInfo(poolToken1Addr, provider, knownTokens),
      ]);

      // Actual token balances held by the pool contract.
      const erc0 = new Contract(poolToken0Addr, ERC20_ABI, provider);
      const erc1 = new Contract(poolToken1Addr, ERC20_ABI, provider);

      const [raw0, raw1] = await Promise.all([
        erc0.balanceOf(poolAddrLower).catch(() => 0n) as Promise<bigint>,
        erc1.balanceOf(poolAddrLower).catch(() => 0n) as Promise<bigint>,
      ]);

      // ethers v6 returns bigint natively; coerce defensively.
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

      pools.push({
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
      });

      console.log(
        `[V3] Loaded: ${info0.symbol}/${info1.symbol} @ ${feeLabel} — TVL $${tvlUSD.toFixed(2)}`,
      );
    } catch (err) {
      // Log so we can diagnose — never silently drop.
      console.warn(`[V3] Failed to load pool ${poolAddrLower}:`, err);
    }
  }

  console.log(
    `[V3] Phase 2 done — ${pools.length} pool(s) fully loaded on chain ${chainId}`,
  );
  return pools;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

export function calculateV3TotalTVL(pools: V3PoolData[]): number {
  return pools.reduce((sum, p) => sum + p.tvlUSD, 0);
}
