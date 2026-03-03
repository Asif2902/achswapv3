/**
 * TVL History — stores daily TVL snapshots in localStorage and
 * computes daily / weekly / monthly growth rates.
 *
 * Each snapshot is { date: "YYYY-MM-DD", tvlUSD: number }.
 * We keep the last 90 days of history.
 */

const STORAGE_KEY = "achswap_tvl_history";
const MAX_DAYS = 90;

export interface TvlSnapshot {
  date: string;      // "YYYY-MM-DD"
  tvlUSD: number;
  v2TvlUSD: number;
  v3TvlUSD: number;
}

export interface TvlGrowth {
  daily: { change: number; pct: number } | null;
  weekly: { change: number; pct: number } | null;
  monthly: { change: number; pct: number } | null;
  history: TvlSnapshot[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function readSnapshots(): TvlSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as TvlSnapshot[];
  } catch {
    return [];
  }
}

function writeSnapshots(snaps: TvlSnapshot[]): void {
  try {
    // Keep only the last MAX_DAYS entries
    const trimmed = snaps.slice(-MAX_DAYS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // storage quota exceeded — non-fatal
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Record today's TVL snapshot. Replaces any existing entry for today.
 */
export function recordTvlSnapshot(
  tvlUSD: number,
  v2TvlUSD: number,
  v3TvlUSD: number,
): void {
  const snaps = readSnapshots();
  const todayStr = today();

  // Remove existing entry for today if any
  const filtered = snaps.filter(s => s.date !== todayStr);
  filtered.push({ date: todayStr, tvlUSD, v2TvlUSD, v3TvlUSD });

  // Sort by date ascending
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  writeSnapshots(filtered);
}

/**
 * Compute TVL growth compared to previous snapshots.
 */
export function getTvlGrowth(currentTvl: number): TvlGrowth {
  const snaps = readSnapshots();

  const findSnap = (dateStr: string): TvlSnapshot | undefined =>
    snaps.find(s => s.date === dateStr);

  // Find closest snapshot to n days ago
  const findClosest = (targetDays: number): TvlSnapshot | undefined => {
    const target = daysAgo(targetDays);
    // Exact match first
    const exact = findSnap(target);
    if (exact) return exact;
    
    // Search within +/- 2 days
    for (let offset = 1; offset <= 2; offset++) {
      const before = findSnap(daysAgo(targetDays + offset));
      if (before) return before;
      const after = findSnap(daysAgo(targetDays - offset));
      if (after) return after;
    }
    return undefined;
  };

  const calcGrowth = (prev: TvlSnapshot | undefined): { change: number; pct: number } | null => {
    if (!prev || prev.tvlUSD === 0) return null;
    const change = currentTvl - prev.tvlUSD;
    const pct = (change / prev.tvlUSD) * 100;
    return { change, pct };
  };

  return {
    daily: calcGrowth(findClosest(1)),
    weekly: calcGrowth(findClosest(7)),
    monthly: calcGrowth(findClosest(30)),
    history: snaps,
  };
}

/**
 * Get all stored history snapshots (sorted ascending by date).
 */
export function getTvlHistory(): TvlSnapshot[] {
  return readSnapshots();
}
