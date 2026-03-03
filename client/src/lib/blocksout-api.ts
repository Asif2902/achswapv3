/**
 * Blockscout API v2 service — swap activity analytics.
 *
 * Fetches router transactions (which have timestamps) and groups them
 * by time range for fast swap-count analytics. No per-pool log parsing.
 *
 * Endpoints used:
 *  - /api/v2/addresses/{addr}/counters      → total tx count (all-time)
 *  - /api/v2/addresses/{addr}/transactions  → paginated txs with timestamps
 */

const API_BASE = "https://testnet.arcscan.app/api/v2";

// ─── Public types ────────────────────────────────────────────────────────────

export type TimeRange = "1h" | "6h" | "12h" | "24h" | "7d" | "30d" | "all";

export interface TimeRangeData {
  v2Swaps: number;
  v3Swaps: number;
  totalSwaps: number;
}

export type TimeRangeSwapCounts = Record<TimeRange, TimeRangeData>;

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "1h": "1H",
  "6h": "6H",
  "12h": "12H",
  "24h": "24H",
  "7d": "7D",
  "30d": "30D",
  "all": "All",
};

// ─── Internal types ──────────────────────────────────────────────────────────

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

// ─── Constants ───────────────────────────────────────────────────────────────

const TIME_RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// Cache: 5-minute TTL
const SWAP_CACHE_KEY = "achswap_swap_counts";
const SWAP_CACHE_TTL = 5 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Blockscout API ${res.status}: ${path}`);
  return res.json();
}

async function getContractCounters(address: string): Promise<CountersResponse> {
  return apiFetch<CountersResponse>(`/addresses/${address}/counters`);
}

/**
 * Fetch paginated transactions from a router address.
 * Stops when we go beyond `maxAgeMs` or hit `maxPages`.
 */
async function fetchRouterTxs(
  routerAddress: string,
  maxPages = 20,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
): Promise<TransactionItem[]> {
  const all: TransactionItem[] = [];
  let nextParams: Record<string, unknown> | null = null;
  const cutoff = Date.now() - maxAgeMs;

  for (let page = 0; page < maxPages; page++) {
    const qs: string = nextParams
      ? "?" +
        new URLSearchParams(
          Object.entries(nextParams).map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";

    const data = await apiFetch<TransactionsResponse>(
      `/addresses/${routerAddress}/transactions${qs}`,
    );

    all.push(...data.items);

    // Stop if the oldest tx in this page is beyond our time window
    if (data.items.length > 0) {
      const oldest = new Date(
        data.items[data.items.length - 1].timestamp,
      ).getTime();
      if (oldest < cutoff) break;
    }

    if (!data.next_page_params) break;
    nextParams = data.next_page_params;
  }

  return all;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

interface SwapCountCache {
  data: TimeRangeSwapCounts;
  timestamp: number;
}

function readSwapCache(): SwapCountCache | null {
  try {
    const raw = localStorage.getItem(SWAP_CACHE_KEY);
    if (!raw) return null;
    const entry: SwapCountCache = JSON.parse(raw);
    if (Date.now() - entry.timestamp > SWAP_CACHE_TTL) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeSwapCache(data: TimeRangeSwapCounts): void {
  try {
    localStorage.setItem(
      SWAP_CACHE_KEY,
      JSON.stringify({ data, timestamp: Date.now() }),
    );
  } catch {}
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch swap counts grouped by time range for both V2 and V3 routers.
 *
 * - For 1h..30d: fetches paginated transactions with timestamps
 * - For "all": uses the fast /counters endpoint
 * - Results are cached in localStorage for 5 minutes
 */
export async function fetchTimeRangeSwapCounts(
  v2Router: string,
  v3Router: string,
): Promise<TimeRangeSwapCounts> {
  // Check cache first
  const cached = readSwapCache();
  if (cached) return cached.data;

  // Fetch transactions and counters in parallel
  const [v2Txs, v3Txs, v2Counters, v3Counters] = await Promise.all([
    fetchRouterTxs(v2Router),
    fetchRouterTxs(v3Router),
    getContractCounters(v2Router),
    getContractCounters(v3Router),
  ]);

  const now = Date.now();
  const result = {} as TimeRangeSwapCounts;

  // Time-ranged counts
  for (const range of Object.keys(TIME_RANGE_MS) as Exclude<
    TimeRange,
    "all"
  >[]) {
    const cutoff = now - TIME_RANGE_MS[range];
    const v2Count = v2Txs.filter(
      (tx) => new Date(tx.timestamp).getTime() >= cutoff,
    ).length;
    const v3Count = v3Txs.filter(
      (tx) => new Date(tx.timestamp).getTime() >= cutoff,
    ).length;
    result[range] = {
      v2Swaps: v2Count,
      v3Swaps: v3Count,
      totalSwaps: v2Count + v3Count,
    };
  }

  // All-time from counters (fast, no pagination needed)
  const v2All = parseInt(v2Counters.transactions_count, 10) || 0;
  const v3All = parseInt(v3Counters.transactions_count, 10) || 0;
  result.all = { v2Swaps: v2All, v3Swaps: v3All, totalSwaps: v2All + v3All };

  writeSwapCache(result);
  return result;
}
