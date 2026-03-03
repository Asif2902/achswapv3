import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw, Search, TrendingUp, TrendingDown, Droplets, Layers,
  Clock, BarChart3, Activity, ArrowUpRight, ArrowDownRight, Minus,
} from "lucide-react";
import { useChainId } from "wagmi";
import { fetchAllPools, type PoolData } from "@/lib/pool-utils";
import { fetchAllV3Pools, type V3PoolData } from "@/lib/v3-pool-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getTokensByChainId, isWrappedToken } from "@/data/tokens";
import {
  fetchRouterCounters,
  fetchProtocolVolume,
  fetch24hSwapCounts,
  type ProtocolVolumeData,
  type PoolVolumeData,
} from "@/lib/blocksout-api";
import { recordTvlSnapshot, getTvlGrowth, type TvlGrowth } from "@/lib/tvl-history";

// ─── Types ───────────────────────────────────────────────────────────────────

type PoolVersion = "v2" | "v3";

interface DisplayPool {
  key: string;
  version: PoolVersion;
  address: string;
  symbol0: string;
  symbol1: string;
  name0: string;
  name1: string;
  logo0: string;
  logo1: string;
  tvlUSD: number;
  reserve0: string;
  reserve1: string;
  fee?: string;
  decimals0: number;
  decimals1: number;
}

interface PoolCache {
  pools: DisplayPool[];
  timestamp: number;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheKey(chainId: number) {
  return `display_pools3_${chainId}`;
}

function readCache(chainId: number): PoolCache | null {
  try {
    const raw = localStorage.getItem(cacheKey(chainId));
    if (!raw) return null;
    const entry: PoolCache = JSON.parse(raw);
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(chainId: number, pools: DisplayPool[]): void {
  try {
    const entry: PoolCache = { pools, timestamp: Date.now() };
    localStorage.setItem(cacheKey(chainId), JSON.stringify(entry));
  } catch {}
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

const FALLBACK_LOGO = "/img/logos/unknown-token.png";

function fmtReserve(value: string): string {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function bestLogo(
  tokens: ReturnType<typeof getTokensByChainId>,
  ...symbols: string[]
): string {
  for (const sym of symbols) {
    const found = tokens.find((t) => t.symbol === sym)?.logoURI;
    if (found) return found;
  }
  return FALLBACK_LOGO;
}

function normaliseV2(
  raw: PoolData[],
  tokens: ReturnType<typeof getTokensByChainId>,
): DisplayPool[] {
  return raw.map((p) => ({
    key: p.pairAddress,
    version: "v2" as const,
    address: p.pairAddress,
    symbol0: p.token0.displaySymbol,
    symbol1: p.token1.displaySymbol,
    name0: p.token0.name || p.token0.displaySymbol,
    name1: p.token1.name || p.token1.displaySymbol,
    logo0: bestLogo(tokens, p.token0.displaySymbol, p.token0.symbol),
    logo1: bestLogo(tokens, p.token1.displaySymbol, p.token1.symbol),
    tvlUSD: p.tvlUSD,
    reserve0: fmtReserve(p.reserve0Formatted),
    reserve1: fmtReserve(p.reserve1Formatted),
    decimals0: p.token0.decimals,
    decimals1: p.token1.decimals,
  }));
}

function normaliseV3(
  raw: V3PoolData[],
  tokens: ReturnType<typeof getTokensByChainId>,
  chainId: number,
): DisplayPool[] {
  const disp = (addr: string, sym: string) =>
    isWrappedToken(chainId, addr) ? "USDC" : sym;

  return raw.map((p) => {
    const sym0 = disp(p.token0.address, p.token0.symbol);
    const sym1 = disp(p.token1.address, p.token1.symbol);
    return {
      key: p.poolAddress,
      version: "v3" as const,
      address: p.poolAddress,
      symbol0: sym0,
      symbol1: sym1,
      name0: p.token0.name || sym0,
      name1: p.token1.name || sym1,
      logo0: bestLogo(tokens, sym0, p.token0.symbol),
      logo1: bestLogo(tokens, sym1, p.token1.symbol),
      tvlUSD: p.tvlUSD,
      reserve0: fmtReserve(p.token0Formatted),
      reserve1: fmtReserve(p.token1Formatted),
      fee: p.feeLabel,
      decimals0: p.token0.decimals,
      decimals1: p.token1.decimals,
    };
  });
}

function combine(v2: DisplayPool[], v3: DisplayPool[]): DisplayPool[] {
  return [...v2, ...v3].sort((a, b) => b.tvlUSD - a.tvlUSD);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  return `${mins}m ago`;
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function fmtChange(change: number | null | undefined): string {
  if (change == null) return "—";
  const prefix = change >= 0 ? "+$" : "-$";
  return `${prefix}${Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Analytics() {
  const chainId = useChainId();

  // Pool data (same as old Pools page)
  const [pools, setPools] = useState<DisplayPool[]>(() => {
    if (typeof window === "undefined" || !chainId) return [];
    return readCache(chainId)?.pools ?? [];
  });
  const [cacheTimestamp, setCacheTimestamp] = useState<number | null>(() => {
    if (typeof window === "undefined" || !chainId) return null;
    return readCache(chainId)?.timestamp ?? null;
  });

  // Analytics data
  const [volumeData, setVolumeData] = useState<ProtocolVolumeData | null>(null);
  const [routerCounts, setRouterCounts] = useState<{ v2TotalTxs: number; v3TotalTxs: number; totalTxs: number } | null>(null);
  const [swapCounts24h, setSwapCounts24h] = useState<{ v2Count24h: number; v3Count24h: number } | null>(null);
  const [tvlGrowth, setTvlGrowth] = useState<TvlGrowth | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isVolumeLoading, setIsVolumeLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "v2" | "v3">("all");
  const [activeTab, setActiveTab] = useState<"overview" | "pools">("overview");

  const fetchingRef = useRef(false);
  const volumeFetchingRef = useRef(false);

  let contracts: ReturnType<typeof getContractsForChain> | null = null;
  try { contracts = chainId ? getContractsForChain(chainId) : null; } catch { /* unknown chain */ }
  const tokens = chainId ? getTokensByChainId(chainId) : [];

  // ── Load pool data ───────────────────────────────────────────────────────
  const loadPools = useCallback(
    async (forceRefresh = false) => {
      if (!contracts || !chainId || fetchingRef.current) return;

      if (!forceRefresh) {
        const cached = readCache(chainId);
        if (cached) {
          setPools(cached.pools);
          setCacheTimestamp(cached.timestamp);
          return;
        }
      }

      fetchingRef.current = true;
      setIsLoading(true);

      try {
        const [rawV2, rawV3] = await Promise.all([
          fetchAllPools(contracts.v2.factory, chainId, tokens),
          fetchAllV3Pools(contracts.v3.factory, chainId, tokens),
        ]);

        const display = combine(normaliseV2(rawV2, tokens), normaliseV3(rawV3, tokens, chainId));
        writeCache(chainId, display);
        setPools(display);
        setCacheTimestamp(Date.now());
      } catch (err) {
        console.error("[Analytics] Failed to load pools:", err);
      } finally {
        setIsLoading(false);
        fetchingRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chainId],
  );

  // ── Load analytics data from Blockscout ──────────────────────────────────
  const loadAnalytics = useCallback(
    async (currentPools: DisplayPool[]) => {
      if (!contracts || !chainId || volumeFetchingRef.current || currentPools.length === 0) return;

      volumeFetchingRef.current = true;
      setIsVolumeLoading(true);

      try {
        // Fetch router counters and 24h swap counts in parallel
        const [counters, counts24h] = await Promise.all([
          fetchRouterCounters(contracts.v2.router, contracts.v3.swapRouter).catch(err => {
            console.warn("[Analytics] Router counters failed:", err);
            return null;
          }),
          fetch24hSwapCounts(contracts.v2.router, contracts.v3.swapRouter).catch(err => {
            console.warn("[Analytics] 24h swap counts failed:", err);
            return null;
          }),
        ]);

        if (counters) setRouterCounts(counters);
        if (counts24h) setSwapCounts24h(counts24h);

        // Fetch volume data for each pool
        const poolInfos = currentPools.map(p => ({
          address: p.address,
          version: p.version,
          symbol0: p.symbol0,
          symbol1: p.symbol1,
          decimals0: p.decimals0,
          decimals1: p.decimals1,
          fee: p.fee,
          tvlUSD: p.tvlUSD,
        }));

        const volData = await fetchProtocolVolume(poolInfos).catch(err => {
          console.warn("[Analytics] Protocol volume failed:", err);
          return null;
        });

        if (volData) setVolumeData(volData);

        // Record TVL snapshot and compute growth
        const totalTvl = currentPools.reduce((s, p) => s + p.tvlUSD, 0);
        const v2Tvl = currentPools.filter(p => p.version === "v2").reduce((s, p) => s + p.tvlUSD, 0);
        const v3Tvl = currentPools.filter(p => p.version === "v3").reduce((s, p) => s + p.tvlUSD, 0);
        recordTvlSnapshot(totalTvl, v2Tvl, v3Tvl);
        setTvlGrowth(getTvlGrowth(totalTvl));
      } catch (err) {
        console.error("[Analytics] Failed to load analytics:", err);
      } finally {
        setIsVolumeLoading(false);
        volumeFetchingRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chainId],
  );

  // ── Initial load ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chainId || !contracts) return;
    const cached = readCache(chainId);
    if (cached) {
      setPools(cached.pools);
      setCacheTimestamp(cached.timestamp);
      return;
    }
    loadPools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

  // Load analytics when pools are available
  useEffect(() => {
    if (pools.length > 0) {
      loadAnalytics(pools);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pools.length > 0 ? pools[0].key : ""]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const filtered = pools.filter((p) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      p.symbol0.toLowerCase().includes(q) ||
      p.symbol1.toLowerCase().includes(q) ||
      p.name0.toLowerCase().includes(q) ||
      p.name1.toLowerCase().includes(q);
    const matchesFilter = activeFilter === "all" || p.version === activeFilter;
    return matchesSearch && matchesFilter;
  });

  const totalTVL = pools.reduce((s, p) => s + p.tvlUSD, 0);
  const v2TVL = pools.filter(p => p.version === "v2").reduce((s, p) => s + p.tvlUSD, 0);
  const v3TVL = pools.filter(p => p.version === "v3").reduce((s, p) => s + p.tvlUSD, 0);
  const v2Count = pools.filter((p) => p.version === "v2").length;
  const v3Count = pools.filter((p) => p.version === "v3").length;

  // Merge volume data into pools for the table
  const poolVolMap = new Map<string, PoolVolumeData>();
  if (volumeData) {
    for (const pv of volumeData.pools) {
      poolVolMap.set(pv.poolAddress.toLowerCase(), pv);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="container max-w-7xl mx-auto px-4 py-6 md:py-10 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Protocol metrics, volume &amp; TVL across V2 &amp; V3
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {cacheTimestamp && (
            <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {fmtAge(Date.now() - cacheTimestamp)}
            </span>
          )}
          <Button
            onClick={() => { loadPools(true); }}
            disabled={isLoading}
            variant="outline"
            size="sm"
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* ── Tab Switcher ── */}
      <div className="flex gap-1 p-1 bg-muted/40 rounded-lg border border-border/40 w-fit">
        {(["overview", "pools"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-md text-sm font-semibold transition-all ${
              activeTab === tab
                ? "bg-background shadow text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "overview" ? "Overview" : "All Pools"}
          </button>
        ))}
      </div>

      {activeTab === "overview" ? (
        <>
          {/* ══════════════════ OVERVIEW TAB ══════════════════ */}

          {/* ── Protocol Stats Row ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              label="Total TVL"
              value={isLoading ? "—" : fmt(totalTVL)}
              icon={<TrendingUp className="h-4 w-4 text-emerald-400" />}
              sub={tvlGrowth?.daily ? `${fmtPct(tvlGrowth.daily.pct)} today` : undefined}
              subColor={tvlGrowth?.daily && tvlGrowth.daily.pct >= 0 ? "text-emerald-400" : "text-red-400"}
            />
            <StatCard
              label="Total Volume"
              value={isVolumeLoading ? "—" : fmt(volumeData?.totalVolume ?? 0)}
              icon={<BarChart3 className="h-4 w-4 text-blue-400" />}
              sub={`${routerCounts?.totalTxs ?? "—"} total swaps`}
            />
            <StatCard
              label="V2 Volume"
              value={isVolumeLoading ? "—" : fmt(volumeData?.v2TotalVolume ?? 0)}
              icon={<Layers className="h-4 w-4 text-violet-400" />}
              sub={`${routerCounts?.v2TotalTxs ?? "—"} txs`}
            />
            <StatCard
              label="V3 Volume"
              value={isVolumeLoading ? "—" : fmt(volumeData?.v3TotalVolume ?? 0)}
              icon={<Layers className="h-4 w-4 text-amber-400" />}
              sub={`${routerCounts?.v3TotalTxs ?? "—"} txs`}
            />
          </div>

          {/* ── 24h Activity Row ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              label="24h Swaps (V2)"
              value={swapCounts24h ? String(swapCounts24h.v2Count24h) : "—"}
              icon={<Activity className="h-4 w-4 text-violet-400" />}
              sub="Last 24 hours"
            />
            <StatCard
              label="24h Swaps (V3)"
              value={swapCounts24h ? String(swapCounts24h.v3Count24h) : "—"}
              icon={<Activity className="h-4 w-4 text-amber-400" />}
              sub="Last 24 hours"
            />
            <StatCard
              label="V2 TVL"
              value={isLoading ? "—" : fmt(v2TVL)}
              icon={<Droplets className="h-4 w-4 text-violet-400" />}
              sub={`${v2Count} pools`}
            />
            <StatCard
              label="V3 TVL"
              value={isLoading ? "—" : fmt(v3TVL)}
              icon={<Droplets className="h-4 w-4 text-amber-400" />}
              sub={`${v3Count} pools`}
            />
          </div>

          {/* ── TVL Growth Section ── */}
          <Card className="border-border/40 shadow-xl">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp className="h-5 w-5 text-emerald-400" />
                <h2 className="text-lg font-bold">TVL Growth</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <GrowthCard
                  period="Daily"
                  change={tvlGrowth?.daily?.change ?? null}
                  pct={tvlGrowth?.daily?.pct ?? null}
                />
                <GrowthCard
                  period="Weekly"
                  change={tvlGrowth?.weekly?.change ?? null}
                  pct={tvlGrowth?.weekly?.pct ?? null}
                />
                <GrowthCard
                  period="Monthly"
                  change={tvlGrowth?.monthly?.change ?? null}
                  pct={tvlGrowth?.monthly?.pct ?? null}
                />
              </div>

              {tvlGrowth && tvlGrowth.history.length > 1 && (
                <div className="mt-4 pt-4 border-t border-border/30">
                  <p className="text-xs text-muted-foreground mb-3">
                    TVL History ({tvlGrowth.history.length} snapshots)
                  </p>
                  <div className="flex items-end gap-1 h-16">
                    {tvlGrowth.history.slice(-30).map((snap, i) => {
                      const max = Math.max(...tvlGrowth.history.slice(-30).map(s => s.tvlUSD));
                      const heightPct = max > 0 ? (snap.tvlUSD / max) * 100 : 0;
                      return (
                        <div
                          key={snap.date}
                          className="flex-1 bg-emerald-500/30 hover:bg-emerald-500/60 rounded-t transition-colors cursor-default"
                          style={{ height: `${Math.max(heightPct, 2)}%` }}
                          title={`${snap.date}: ${fmt(snap.tvlUSD)}`}
                        />
                      );
                    })}
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-[10px] text-muted-foreground">
                      {tvlGrowth.history[Math.max(0, tvlGrowth.history.length - 30)]?.date}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {tvlGrowth.history[tvlGrowth.history.length - 1]?.date}
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Per-Pool Volume Table ── */}
          <Card className="border-border/40 shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border/40">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-blue-400" />
                <h2 className="text-lg font-bold">Pool Volume</h2>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Swap volume per pool from on-chain event logs
              </p>
            </div>

            {/* Table header */}
            <div className="hidden sm:grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-border/40 bg-muted/20">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pool</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">TVL</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Total Volume</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Swaps</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Action</span>
            </div>

            <div className="divide-y divide-border/30">
              {isVolumeLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="px-5 py-4">
                    <Skeleton className="h-12 w-full rounded-lg" />
                  </div>
                ))
              ) : !volumeData || volumeData.pools.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <BarChart3 className="h-10 w-10 text-muted-foreground/30" />
                  <p className="text-muted-foreground text-sm">
                    {isLoading ? "Loading pools..." : "No volume data available yet"}
                  </p>
                </div>
              ) : (
                volumeData.pools.map((pv) => {
                  const dp = pools.find(p => p.address.toLowerCase() === pv.poolAddress.toLowerCase());
                  return (
                    <div
                      key={pv.poolAddress}
                      className="group grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] gap-3 sm:gap-4 items-center px-5 py-4 hover:bg-accent/5 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative flex-shrink-0">
                          <img
                            src={dp?.logo0 ?? FALLBACK_LOGO}
                            alt={pv.symbol0}
                            className="w-7 h-7 rounded-full border-2 border-background object-cover"
                            onError={(e) => { e.currentTarget.src = FALLBACK_LOGO; }}
                          />
                          <img
                            src={dp?.logo1 ?? FALLBACK_LOGO}
                            alt={pv.symbol1}
                            className="w-7 h-7 rounded-full border-2 border-background object-cover absolute -right-3 top-0"
                            onError={(e) => { e.currentTarget.src = FALLBACK_LOGO; }}
                          />
                        </div>
                        <div className="pl-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm">
                              {pv.symbol0}/{pv.symbol1}
                            </span>
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 h-4 font-mono ${
                                pv.version === "v3"
                                  ? "border-amber-500/40 text-amber-400 bg-amber-500/10"
                                  : "border-violet-500/40 text-violet-400 bg-violet-500/10"
                              }`}
                            >
                              {pv.version.toUpperCase()}
                            </Badge>
                            {pv.fee && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono border-border/50 text-muted-foreground">
                                {pv.fee}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">TVL: </span>
                        <span className="font-semibold text-sm tabular-nums">{fmt(pv.tvlUSD)}</span>
                      </div>
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">Volume: </span>
                        <span className="font-semibold text-sm tabular-nums text-blue-400">{fmt(pv.totalVolume)}</span>
                      </div>
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">Swaps: </span>
                        <span className="font-mono text-sm tabular-nums">{pv.swapCount}</span>
                      </div>
                      <div className="sm:text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs h-7 px-3 opacity-70 group-hover:opacity-100 transition-opacity"
                          onClick={() => window.location.href = "/add-liquidity"}
                        >
                          + Add
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </>
      ) : (
        <>
          {/* ══════════════════ ALL POOLS TAB ══════════════════ */}

          {/* ── Stats Row ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Total Pools"
              value={isLoading ? "—" : String(v2Count + v3Count)}
              icon={<Droplets className="h-4 w-4 text-blue-400" />}
            />
            <StatCard
              label="Total TVL"
              value={isLoading ? "—" : fmt(totalTVL)}
              icon={<TrendingUp className="h-4 w-4 text-emerald-400" />}
            />
            <StatCard
              label="V2 Pools"
              value={isLoading ? "—" : String(v2Count)}
              icon={<Layers className="h-4 w-4 text-violet-400" />}
            />
            <StatCard
              label="V3 Pools"
              value={isLoading ? "—" : String(v3Count)}
              icon={<Layers className="h-4 w-4 text-amber-400" />}
            />
          </div>

          {/* ── Filters + Search ── */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex gap-1 p-1 bg-muted/40 rounded-lg border border-border/40 w-fit">
              {(["all", "v2", "v3"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setActiveFilter(f)}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                    activeFilter === f
                      ? "bg-background shadow text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search by token name or symbol..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-card/60"
              />
            </div>
          </div>

          {/* ── Pool Table ── */}
          <Card className="border-border/40 shadow-xl overflow-hidden">
            <div className="hidden sm:grid grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-border/40 bg-muted/20">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pool</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">TVL</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Volume</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Reserve 0</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Reserve 1</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Action</span>
            </div>

            <div className="divide-y divide-border/30">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="px-5 py-4">
                    <Skeleton className="h-12 w-full rounded-lg" />
                  </div>
                ))
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
                  <Droplets className="h-10 w-10 text-muted-foreground/30" />
                  <p className="text-muted-foreground text-sm">
                    {searchQuery ? "No pools match your search" : "No pools available"}
                  </p>
                </div>
              ) : (
                filtered.map((pool) => {
                  const pv = poolVolMap.get(pool.address.toLowerCase());
                  return (
                    <div
                      key={pool.key}
                      className="group grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] gap-3 sm:gap-4 items-center px-5 py-4 hover:bg-accent/5 transition-colors"
                    >
                      {/* Pool identity */}
                      <div className="flex items-center gap-3">
                        <div className="relative flex-shrink-0">
                          <img
                            src={pool.logo0}
                            alt={pool.symbol0}
                            className="w-8 h-8 rounded-full border-2 border-background object-cover"
                            onError={(e) => { e.currentTarget.src = FALLBACK_LOGO; }}
                          />
                          <img
                            src={pool.logo1}
                            alt={pool.symbol1}
                            className="w-8 h-8 rounded-full border-2 border-background object-cover absolute -right-3 top-0"
                            onError={(e) => { e.currentTarget.src = FALLBACK_LOGO; }}
                          />
                        </div>
                        <div className="pl-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm">
                              {pool.symbol0}/{pool.symbol1}
                            </span>
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 h-4 font-mono ${
                                pool.version === "v3"
                                  ? "border-amber-500/40 text-amber-400 bg-amber-500/10"
                                  : "border-violet-500/40 text-violet-400 bg-violet-500/10"
                              }`}
                            >
                              {pool.version.toUpperCase()}
                            </Badge>
                            {pool.fee && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono border-border/50 text-muted-foreground">
                                {pool.fee}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">
                            {pool.name0} / {pool.name1}
                          </p>
                        </div>
                      </div>

                      {/* TVL */}
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">TVL: </span>
                        <span className="font-semibold text-sm tabular-nums">{fmt(pool.tvlUSD)}</span>
                      </div>

                      {/* Volume */}
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">Vol: </span>
                        <span className="font-semibold text-sm tabular-nums text-blue-400">
                          {pv ? fmt(pv.totalVolume) : "—"}
                        </span>
                        {pv && pv.swapCount > 0 && (
                          <p className="text-[10px] text-muted-foreground">{pv.swapCount} swaps</p>
                        )}
                      </div>

                      {/* Reserve 0 */}
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">{pool.symbol0}: </span>
                        <span className="font-mono text-xs text-foreground/80 tabular-nums">
                          {pool.reserve0}
                          <span className="text-muted-foreground ml-1">{pool.symbol0}</span>
                        </span>
                      </div>

                      {/* Reserve 1 */}
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">{pool.symbol1}: </span>
                        <span className="font-mono text-xs text-foreground/80 tabular-nums">
                          {pool.reserve1}
                          <span className="text-muted-foreground ml-1">{pool.symbol1}</span>
                        </span>
                      </div>

                      {/* Action */}
                      <div className="sm:text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs h-7 px-3 opacity-70 group-hover:opacity-100 transition-opacity"
                          onClick={() => window.location.href = "/add-liquidity"}
                        >
                          + Add
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            {!isLoading && filtered.length > 0 && (
              <div className="px-5 py-3 border-t border-border/30 bg-muted/10 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Showing <span className="font-semibold text-foreground">{filtered.length}</span> of{" "}
                  <span className="font-semibold text-foreground">{pools.length}</span> pools
                </span>
                {cacheTimestamp && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Cached · refreshes in{" "}
                    {Math.max(0, Math.round((CACHE_TTL_MS - (Date.now() - cacheTimestamp)) / 60000))}m
                  </span>
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  sub,
  subColor,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  sub?: string;
  subColor?: string;
}) {
  return (
    <Card className="border-border/40 bg-card/60 backdrop-blur">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          {icon}
        </div>
        <p className="text-xl font-bold tabular-nums">{value}</p>
        {sub && (
          <p className={`text-xs mt-1 ${subColor ?? "text-muted-foreground"}`}>{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}

function GrowthCard({
  period,
  change,
  pct,
}: {
  period: string;
  change: number | null;
  pct: number | null;
}) {
  const isPositive = pct != null && pct >= 0;
  const isNeutral = pct == null;

  return (
    <div className="p-4 rounded-xl border border-border/40 bg-card/40">
      <p className="text-xs text-muted-foreground mb-2">{period}</p>
      <div className="flex items-center gap-2">
        {isNeutral ? (
          <Minus className="h-4 w-4 text-muted-foreground" />
        ) : isPositive ? (
          <ArrowUpRight className="h-4 w-4 text-emerald-400" />
        ) : (
          <ArrowDownRight className="h-4 w-4 text-red-400" />
        )}
        <span className={`text-lg font-bold tabular-nums ${
          isNeutral ? "text-muted-foreground" : isPositive ? "text-emerald-400" : "text-red-400"
        }`}>
          {fmtPct(pct)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">{fmtChange(change)}</p>
    </div>
  );
}
