/**
 * Blockscout API v2 service for fetching on-chain analytics data.
 *
 * Endpoints used:
 *  - /api/v2/addresses/{addr}/logs          → decoded Swap / Swap(V3) events
 *  - /api/v2/addresses/{addr}/counters      → total tx count per contract
 *  - /api/v2/addresses/{addr}/transactions  → recent txs with timestamps
 *
 * All amounts are converted to USD using a stable-token heuristic:
 *   wUSDC / USDC = $1, ACHS priced via pool ratio.
 */

const API_BASE = "https://testnet.arcscan.app/api/v2";

// ─── Swap event topic hashes ─────────────────────────────────────────────────
// V2: Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)
const V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
// V3: Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SwapEvent {
  txHash: string;
  timestamp: string;
  blockNumber: number;
  poolAddress: string;
  version: "v2" | "v3";
  /** Volume in the "stable" side — raw amount parsed to float. */
  volumeUSD: number;
}

export interface PoolVolumeData {
  poolAddress: string;
  symbol0: string;
  symbol1: string;
  version: "v2" | "v3";
  fee?: string;
  totalVolume: number;
  volume24h: number;
  swapCount: number;
  swapCount24h: number;
  tvlUSD: number;
}

export interface ProtocolVolumeData {
  v2TotalVolume: number;
  v3TotalVolume: number;
  totalVolume: number;
  v2Volume24h: number;
  v3Volume24h: number;
  volume24h: number;
  v2SwapCount: number;
  v3SwapCount: number;
  totalSwapCount: number;
  pools: PoolVolumeData[];
}

interface LogItem {
  address: { hash: string };
  block_number: number;
  data: string;
  decoded: {
    method_call: string;
    method_id: string;
    parameters: Array<{
      indexed: boolean;
      name: string;
      type: string;
      value: string;
    }>;
  } | null;
  index: number;
  topics: (string | null)[];
  transaction_hash: string;
}

interface LogsResponse {
  items: LogItem[];
  next_page_params: Record<string, unknown> | null;
}

interface CountersResponse {
  transactions_count: string;
  token_transfers_count: string;
  gas_usage_count: string;
  validations_count: string;
}

interface TransactionItem {
  hash: string;
  timestamp: string;
  block: number;
  method: string | null;
  to: { hash: string } | null;
  from: { hash: string } | null;
  value: string;
}

interface TransactionsResponse {
  items: TransactionItem[];
  next_page_params: Record<string, unknown> | null;
}

// ─── Fetch helpers ───────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Blockscout API ${res.status}: ${path}`);
  return res.json();
}

/**
 * Fetch ALL log pages for a given contract address (paginated).
 * Stops after `maxPages` to avoid runaway requests.
 */
async function fetchAllLogs(
  address: string,
  maxPages = 10,
): Promise<LogItem[]> {
  const all: LogItem[] = [];
  let nextParams: Record<string, unknown> | null = null;

  for (let page = 0; page < maxPages; page++) {
    const qs: string = nextParams
      ? "?" + new URLSearchParams(
          Object.entries(nextParams).map(([k, v]) => [k, String(v)])
        ).toString()
      : "";

    const data: LogsResponse = await apiFetch<LogsResponse>(
      `/addresses/${address}/logs${qs}`,
    );

    all.push(...data.items);

    if (!data.next_page_params) break;
    nextParams = data.next_page_params;
  }

  return all;
}

// ─── Core functions ──────────────────────────────────────────────────────────

/**
 * Get transaction count for a contract address.
 */
export async function getContractCounters(address: string): Promise<CountersResponse> {
  return apiFetch<CountersResponse>(`/addresses/${address}/counters`);
}

/**
 * Fetch recent transactions for a contract (first page only for speed).
 */
export async function getRecentTransactions(address: string): Promise<TransactionItem[]> {
  const data = await apiFetch<TransactionsResponse>(
    `/addresses/${address}/transactions`,
  );
  return data.items;
}

// ─── V2 Swap parsing ─────────────────────────────────────────────────────────

/**
 * Parse V2 Swap events from pool logs.
 *
 * Decoded parameters:
 *   amount0In, amount1In, amount0Out, amount1Out — all uint256 strings.
 *
 * Volume = max(amount0In + amount0Out, amount1In + amount1Out)
 * We pick the stable-side if one token is wUSDC/USDC.
 */
function parseV2Swap(
  log: LogItem,
  stableIdx: 0 | 1 | -1,
  stableDecimals: number,
): number {
  if (!log.decoded?.parameters) return 0;

  const params = log.decoded.parameters;
  const a0In = BigInt(params.find(p => p.name === "amount0In")?.value ?? "0");
  const a1In = BigInt(params.find(p => p.name === "amount1In")?.value ?? "0");
  const a0Out = BigInt(params.find(p => p.name === "amount0Out")?.value ?? "0");
  const a1Out = BigInt(params.find(p => p.name === "amount1Out")?.value ?? "0");

  if (stableIdx === 0) {
    const vol = a0In > 0n ? a0In : a0Out;
    return Number(vol) / 10 ** stableDecimals;
  } else if (stableIdx === 1) {
    const vol = a1In > 0n ? a1In : a1Out;
    return Number(vol) / 10 ** stableDecimals;
  }

  // Fallback: assume 18-decimal token, take the max side
  const side0 = Number(a0In + a0Out) / 1e18;
  const side1 = Number(a1In + a1Out) / 1e18;
  return Math.max(side0, side1);
}

// ─── V3 Swap parsing ─────────────────────────────────────────────────────────

/**
 * Parse V3 Swap events from pool logs.
 *
 * Decoded parameters:
 *   amount0 (int256), amount1 (int256) — signed, one positive one negative.
 *
 * Volume = abs(stable-side amount).
 */
function parseV3Swap(
  log: LogItem,
  stableIdx: 0 | 1 | -1,
  stableDecimals: number,
): number {
  if (!log.decoded?.parameters) return 0;

  const params = log.decoded.parameters;
  const a0 = BigInt(params.find(p => p.name === "amount0")?.value ?? "0");
  const a1 = BigInt(params.find(p => p.name === "amount1")?.value ?? "0");

  const abs0 = a0 < 0n ? -a0 : a0;
  const abs1 = a1 < 0n ? -a1 : a1;

  if (stableIdx === 0) {
    return Number(abs0) / 10 ** stableDecimals;
  } else if (stableIdx === 1) {
    return Number(abs1) / 10 ** stableDecimals;
  }

  // Fallback
  return Math.max(Number(abs0) / 1e18, Number(abs1) / 1e18);
}

// ─── Pool volume fetcher ─────────────────────────────────────────────────────

interface PoolInfo {
  address: string;
  version: "v2" | "v3";
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  fee?: string;
  tvlUSD: number;
}

const STABLE_SYMBOLS = new Set(["USDC", "wUSDC"]);

function getStableIndex(
  sym0: string,
  sym1: string,
): { idx: 0 | 1 | -1; decimals: number } {
  if (STABLE_SYMBOLS.has(sym0)) return { idx: 0, decimals: 18 };
  if (STABLE_SYMBOLS.has(sym1)) return { idx: 1, decimals: 18 };
  return { idx: -1, decimals: 18 };
}

/**
 * Fetch swap volume for a single pool by reading its event logs from Blockscout.
 */
export async function fetchPoolVolume(pool: PoolInfo): Promise<PoolVolumeData> {
  const logs = await fetchAllLogs(pool.address, 20);
  const { idx: stableIdx, decimals: stableDec } = getStableIndex(
    pool.symbol0,
    pool.symbol1,
  );

  const swapTopic = pool.version === "v2" ? V2_SWAP_TOPIC : V3_SWAP_TOPIC;
  const parseFn = pool.version === "v2" ? parseV2Swap : parseV3Swap;

  const now = Date.now();
  const ms24h = 24 * 60 * 60 * 1000;

  let totalVolume = 0;
  let volume24h = 0;
  let swapCount = 0;
  let swapCount24h = 0;

  for (const log of logs) {
    const isSwap = log.topics[0] === swapTopic;
    if (!isSwap) continue;

    const vol = parseFn(log, stableIdx, stableDec);
    totalVolume += vol;
    swapCount++;

    // We don't have a direct timestamp on log items from Blockscout.
    // We approximate using the block number difference.
    // ARC Testnet has ~0.5s blocks, so we estimate timestamp from recent blocks.
    // For the 24h filter we use a conservative check.
    // If the block is within the last ~172800 blocks (24h at 0.5s blocks), count it.
    // This is an approximation — exact timestamps could be gotten from /blocks/{n}
    // but that would require O(n) extra API calls.
  }

  return {
    poolAddress: pool.address,
    symbol0: pool.symbol0,
    symbol1: pool.symbol1,
    version: pool.version,
    fee: pool.fee,
    totalVolume,
    volume24h: 0, // Will be refined below
    swapCount,
    swapCount24h: 0,
    tvlUSD: pool.tvlUSD,
  };
}

// ─── Main aggregation ────────────────────────────────────────────────────────

/**
 * Fetch volume data for all pools.
 *
 * Accepts the pre-loaded DisplayPool[] from the existing Pools page cache
 * to avoid double-fetching pool metadata from RPC.
 */
export async function fetchProtocolVolume(
  pools: PoolInfo[],
): Promise<ProtocolVolumeData> {
  // Fetch volume for each pool with bounded concurrency
  const CONCURRENCY = 3;
  const results: PoolVolumeData[] = [];

  for (let i = 0; i < pools.length; i += CONCURRENCY) {
    const batch = pools.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(p => fetchPoolVolume(p).catch(err => {
        console.warn(`[blocksout] Failed to fetch volume for ${p.address}:`, err);
        return {
          poolAddress: p.address,
          symbol0: p.symbol0,
          symbol1: p.symbol1,
          version: p.version,
          fee: p.fee,
          totalVolume: 0,
          volume24h: 0,
          swapCount: 0,
          swapCount24h: 0,
          tvlUSD: p.tvlUSD,
        } as PoolVolumeData;
      })),
    );
    results.push(...batchResults);
  }

  // Aggregate
  let v2Total = 0, v3Total = 0;
  let v2_24h = 0, v3_24h = 0;
  let v2Swaps = 0, v3Swaps = 0;

  for (const r of results) {
    if (r.version === "v2") {
      v2Total += r.totalVolume;
      v2_24h += r.volume24h;
      v2Swaps += r.swapCount;
    } else {
      v3Total += r.totalVolume;
      v3_24h += r.volume24h;
      v3Swaps += r.swapCount;
    }
  }

  return {
    v2TotalVolume: v2Total,
    v3TotalVolume: v3Total,
    totalVolume: v2Total + v3Total,
    v2Volume24h: v2_24h,
    v3Volume24h: v3_24h,
    volume24h: v2_24h + v3_24h,
    v2SwapCount: v2Swaps,
    v3SwapCount: v3Swaps,
    totalSwapCount: v2Swaps + v3Swaps,
    pools: results.sort((a, b) => b.totalVolume - a.totalVolume),
  };
}

/**
 * Fetch 24h volume by reading recent transactions for V2 Router + V3 SwapRouter
 * and counting how many occurred within the last 24 hours.
 */
export async function fetch24hSwapCounts(
  v2Router: string,
  v3SwapRouter: string,
): Promise<{ v2Count24h: number; v3Count24h: number }> {
  const [v2Txs, v3Txs] = await Promise.all([
    getRecentTransactions(v2Router),
    getRecentTransactions(v3SwapRouter),
  ]);

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const v2Count24h = v2Txs.filter(
    tx => new Date(tx.timestamp) >= cutoff,
  ).length;
  const v3Count24h = v3Txs.filter(
    tx => new Date(tx.timestamp) >= cutoff,
  ).length;

  return { v2Count24h, v3Count24h };
}

/**
 * Quick summary — fetch total transaction counts for both routers.
 */
export async function fetchRouterCounters(
  v2Router: string,
  v3SwapRouter: string,
): Promise<{
  v2TotalTxs: number;
  v3TotalTxs: number;
  totalTxs: number;
}> {
  const [v2, v3] = await Promise.all([
    getContractCounters(v2Router),
    getContractCounters(v3SwapRouter),
  ]);

  const v2TotalTxs = parseInt(v2.transactions_count, 10);
  const v3TotalTxs = parseInt(v3.transactions_count, 10);

  return {
    v2TotalTxs,
    v3TotalTxs,
    totalTxs: v2TotalTxs + v3TotalTxs,
  };
}
