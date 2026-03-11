import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw, Search, TrendingUp, Droplets, Layers,
  Clock, BarChart3, Activity,
} from "lucide-react";
import { useChainId } from "wagmi";
import { fetchAllPools, type PoolData } from "@/lib/pool-utils";
import { fetchAllV3Pools, type V3PoolData } from "@/lib/v3-pool-utils";
import { getContractsForChain } from "@/lib/contracts";
import type { Token } from "@shared/schema";
import { fetchTokensWithCommunity, getTokensByChainId, isWrappedToken } from "@/data/tokens";
import {
  fetchTimeRangeSwapCounts,
  TIME_RANGE_LABELS,
  type TimeRange,
  type TimeRangeSwapCounts,
} from "@/lib/blocksout-api";
import { getGatewayUrlFromCid } from "@/pages/LaunchToken";

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
  tokens: Token[],
  ...symbols: string[]
): string {
  for (const sym of symbols) {
    const found = tokens.find((t) => t.symbol === sym)?.logoURI;
    if (found) return getGatewayUrlFromCid(found);
  }
  return FALLBACK_LOGO;
}

function normaliseV2(
  raw: PoolData[],
  tokens: Token[],
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
  }));
}

function normaliseV3(
  raw: V3PoolData[],
  tokens: Token[],
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

function fmtNum(n: number): string {
  return n.toLocaleString();
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Analytics() {
  const chainId = useChainId();

  // Pool data
  const [pools, setPools] = useState<DisplayPool[]>(() => {
    if (typeof window === "undefined" || !chainId) return [];
    return readCache(chainId)?.pools ?? [];
  });
  const [cacheTimestamp, setCacheTimestamp] = useState<number | null>(() => {
    if (typeof window === "undefined" || !chainId) return null;
    return readCache(chainId)?.timestamp ?? null;
  });

  // Analytics data
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  const [swapCounts, setSwapCounts] = useState<TimeRangeSwapCounts | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isSwapLoading, setIsSwapLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "v2" | "v3">("all");
  const [activeTab, setActiveTab] = useState<"overview" | "pools">("overview");

  const fetchingRef = useRef(false);
  const swapFetchingRef = useRef(false);

  let contracts: ReturnType<typeof getContractsForChain> | null = null;
  try { contracts = chainId ? getContractsForChain(chainId) : null; } catch { /* unknown chain */ }

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
        const tokens = await fetchTokensWithCommunity(chainId);
        console.log("[Pools] Tokens loaded:", tokens.length);
        const [rawV2, rawV3] = await Promise.all([
          fetchAllPools(contracts.v2.factory, chainId, tokens),
          fetchAllV3Pools(contracts.v3.factory, chainId, tokens),
        ]);

        console.log("[Pools] Raw V2 pools:", rawV2.length);
        console.log("[Pools] Raw V3 pools:", rawV3.length);

        const display = combine(normaliseV2(rawV2, tokens), normaliseV3(rawV3, tokens, chainId));
        console.log("[Pools] Display pools:", display.length, "V2:", display.filter(p => p.version === "v2").length, "V3:", display.filter(p => p.version === "v3").length);
        
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

  // ── Load swap counts from Blockscout ────────────────────────────────────
  const loadSwapCounts = useCallback(
    async () => {
      if (!contracts || !chainId || swapFetchingRef.current) return;

      swapFetchingRef.current = true;
      setIsSwapLoading(true);

      try {
        const counts = await fetchTimeRangeSwapCounts(
          contracts.v2.router,
          contracts.v3.swapRouter,
        );
        setSwapCounts(counts);
      } catch (err) {
        console.error("[Analytics] Failed to load swap counts:", err);
      } finally {
        setIsSwapLoading(false);
        swapFetchingRef.current = false;
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
    } else {
      loadPools();
    }
    loadSwapCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

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

  // Current time-range data
  const currentData = swapCounts?.[timeRange] ?? null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="container max-w-7xl mx-auto px-4 py-6 md:py-10 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Protocol activity &amp; TVL across V2 &amp; V3
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
            onClick={() => {
              loadPools(true);
              // Clear swap cache to force re-fetch
              try { localStorage.removeItem("achswap_swap_counts"); } catch {}
              loadSwapCounts();
            }}
            disabled={isLoading || isSwapLoading}
            variant="outline"
            size="sm"
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading || isSwapLoading ? "animate-spin" : ""}`} />
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

          {/* ── Time Range Selector ── */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-muted-foreground">Period:</span>
            <div className="flex gap-1 p-1 bg-muted/40 rounded-lg border border-border/40">
              {(Object.keys(TIME_RANGE_LABELS) as TimeRange[]).map((range) => (
                <button
                  key={range}
                  onClick={() => setTimeRange(range)}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                    timeRange === range
                      ? "bg-primary text-primary-foreground shadow"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  }`}
                >
                  {TIME_RANGE_LABELS[range]}
                </button>
              ))}
            </div>
          </div>

          {/* ── Swap Activity Row ── */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <StatCard
              label={`Total Swaps (${TIME_RANGE_LABELS[timeRange]})`}
              value={isSwapLoading ? "..." : currentData ? fmtNum(currentData.totalSwaps) : "—"}
              icon={<Activity className="h-4 w-4 text-blue-400" />}
              sub={
                swapCounts?.all
                  ? `${fmtNum(swapCounts.all.totalSwaps)} all-time`
                  : undefined
              }
            />
            <StatCard
              label={`V2 Swaps (${TIME_RANGE_LABELS[timeRange]})`}
              value={isSwapLoading ? "..." : currentData ? fmtNum(currentData.v2Swaps) : "—"}
              icon={<BarChart3 className="h-4 w-4 text-violet-400" />}
              sub={
                swapCounts?.all
                  ? `${fmtNum(swapCounts.all.v2Swaps)} all-time`
                  : undefined
              }
            />
            <StatCard
              label={`V3 Swaps (${TIME_RANGE_LABELS[timeRange]})`}
              value={isSwapLoading ? "..." : currentData ? fmtNum(currentData.v3Swaps) : "—"}
              icon={<BarChart3 className="h-4 w-4 text-amber-400" />}
              sub={
                swapCounts?.all
                  ? `${fmtNum(swapCounts.all.v3Swaps)} all-time`
                  : undefined
              }
            />
          </div>

          {/* ── TVL Row ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              label="Total TVL"
              value={isLoading ? "—" : fmt(totalTVL)}
              icon={<TrendingUp className="h-4 w-4 text-emerald-400" />}
              sub={`${v2Count + v3Count} pools`}
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
            <StatCard
              label="Total Pools"
              value={isLoading ? "—" : String(v2Count + v3Count)}
              icon={<Layers className="h-4 w-4 text-blue-400" />}
              sub={`${v2Count} V2 + ${v3Count} V3`}
            />
          </div>

          {/* ── Swap Breakdown Table ── */}
          {swapCounts && (
            <Card className="border-border/40 shadow-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-border/40">
                <div className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-blue-400" />
                  <h2 className="text-lg font-bold">Swap Activity by Period</h2>
                </div>
              </div>

              {/* Table header */}
              <div className="hidden sm:grid grid-cols-4 gap-4 px-5 py-3 border-b border-border/40 bg-muted/20">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Period</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Total</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">V2</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">V3</span>
              </div>

              <div className="divide-y divide-border/30">
                {(Object.keys(TIME_RANGE_LABELS) as TimeRange[]).map((range) => {
                  const data = swapCounts[range];
                  const isSelected = range === timeRange;
                  return (
                    <button
                      key={range}
                      onClick={() => setTimeRange(range)}
                      className={`w-full grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 items-center px-5 py-3.5 transition-colors text-left ${
                        isSelected
                          ? "bg-primary/10 border-l-2 border-l-primary"
                          : "hover:bg-accent/5"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-semibold ${isSelected ? "text-primary" : ""}`}>
                          {TIME_RANGE_LABELS[range]}
                        </span>
                        {range === "all" && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono border-border/50 text-muted-foreground">
                            Lifetime
                          </Badge>
                        )}
                      </div>
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">Total: </span>
                        <span className="font-bold text-sm tabular-nums">{fmtNum(data.totalSwaps)}</span>
                      </div>
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">V2: </span>
                        <span className="font-mono text-sm tabular-nums text-violet-400">{fmtNum(data.v2Swaps)}</span>
                      </div>
                      <div className="sm:text-right">
                        <span className="text-xs text-muted-foreground sm:hidden">V3: </span>
                        <span className="font-mono text-sm tabular-nums text-amber-400">{fmtNum(data.v3Swaps)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Card>
          )}
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
            <div className="hidden sm:grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-border/40 bg-muted/20">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pool</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">TVL</span>
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
                filtered.map((pool) => (
                  <div
                    key={pool.key}
                    className="group grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] gap-3 sm:gap-4 items-center px-5 py-4 hover:bg-accent/5 transition-colors"
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
                ))
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
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  sub?: string;
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
          <p className="text-xs mt-1 text-muted-foreground">{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}
