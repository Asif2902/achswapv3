import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Search, TrendingUp, Droplets, Layers, Clock } from "lucide-react";
import { useChainId } from "wagmi";
import { fetchAllPools, type PoolData } from "@/lib/pool-utils";
import { fetchAllV3Pools, type V3PoolData } from "@/lib/v3-pool-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getTokensByChainId } from "@/data/tokens";

// ─── Types ───────────────────────────────────────────────────────────────────

type PoolVersion = "v2" | "v3";

/**
 * Display-only shape — contains NO BigInt fields.
 * This is what gets cached in localStorage so JSON serialization always works.
 */
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
  reserve0: string; // pre-formatted string, e.g. "100,000.0000"
  reserve1: string;
  fee?: string;
}

interface PoolCache {
  pools: DisplayPool[];
  timestamp: number;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────
// We cache DisplayPool[] directly — it contains only primitives (strings &
// numbers) so JSON.stringify/parse work without any BigInt issues.

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cacheKey(chainId: number) {
  return `display_pools_${chainId}`;
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
  } catch {
    // storage quota exceeded — non-fatal
  }
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
    logo0: bestLogo(tokens, p.token0.symbol, p.token0.displaySymbol),
    logo1: bestLogo(tokens, p.token1.symbol, p.token1.displaySymbol),
    tvlUSD: p.tvlUSD,
    reserve0: fmtReserve(p.reserve0Formatted),
    reserve1: fmtReserve(p.reserve1Formatted),
  }));
}

function normaliseV3(
  raw: V3PoolData[],
  tokens: ReturnType<typeof getTokensByChainId>,
): DisplayPool[] {
  return raw.map((p) => ({
    key: p.poolAddress,
    version: "v3" as const,
    address: p.poolAddress,
    symbol0: p.token0.symbol,
    symbol1: p.token1.symbol,
    name0: p.token0.name || p.token0.symbol,
    name1: p.token1.name || p.token1.symbol,
    logo0: bestLogo(tokens, p.token0.symbol),
    logo1: bestLogo(tokens, p.token1.symbol),
    tvlUSD: p.tvlUSD,
    reserve0: fmtReserve(p.token0Formatted),
    reserve1: fmtReserve(p.token1Formatted),
    fee: p.feeLabel,
  }));
}

function combine(v2: DisplayPool[], v3: DisplayPool[]): DisplayPool[] {
  return [...v2, ...v3].sort((a, b) => b.tvlUSD - a.tvlUSD);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Pools() {
  const chainId = useChainId();

  // Restore from cache synchronously on first render so there's no flicker.
  const [pools, setPools] = useState<DisplayPool[]>(() => {
    if (typeof window === "undefined" || !chainId) return [];
    return readCache(chainId)?.pools ?? [];
  });

  const [cacheTimestamp, setCacheTimestamp] = useState<number | null>(() => {
    if (typeof window === "undefined" || !chainId) return null;
    return readCache(chainId)?.timestamp ?? null;
  });

  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "v2" | "v3">("all");

  // Prevent double-fetch on StrictMode double-invoke
  const fetchingRef = useRef(false);

  let contracts: ReturnType<typeof getContractsForChain> | null = null;
  try { contracts = chainId ? getContractsForChain(chainId) : null; } catch { /* unknown chain */ }
  const tokens = chainId ? getTokensByChainId(chainId) : [];

  const loadPools = useCallback(
    async (forceRefresh = false) => {
      if (!contracts || !chainId || fetchingRef.current) return;

      // If cache is still fresh and not force-refreshing, nothing to do.
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
        // Fetch V2 and V3 fully in parallel — UI only updates once both are done.
        const [rawV2, rawV3] = await Promise.all([
          fetchAllPools(contracts.v2.factory, chainId, tokens),
          fetchAllV3Pools(contracts.v3.factory, chainId, tokens),
        ]);

        const display = combine(normaliseV2(rawV2, tokens), normaliseV3(rawV3, tokens));

        writeCache(chainId, display);
        setPools(display);
        setCacheTimestamp(Date.now());
      } catch (err) {
        console.error("[Pools] Failed to load:", err);
      } finally {
        setIsLoading(false);
        fetchingRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chainId],
  );

  useEffect(() => {
    if (!chainId || !contracts) return;

    // If we already have fresh cached pools, skip the network fetch entirely.
    const cached = readCache(chainId);
    if (cached) {
      setPools(cached.pools);
      setCacheTimestamp(cached.timestamp);
      return;
    }

    loadPools();
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
    const matchesFilter =
      activeFilter === "all" || p.version === activeFilter;
    return matchesSearch && matchesFilter;
  });

  const totalTVL = pools.reduce((s, p) => s + p.tvlUSD, 0);
  const v2Count = pools.filter((p) => p.version === "v2").length;
  const v3Count = pools.filter((p) => p.version === "v3").length;

  const fmt = (n: number) =>
    n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
      ? `$${(n / 1_000).toFixed(2)}K`
      : `$${n.toFixed(2)}`;

  const fmtAge = (ms: number) => {
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    return `${mins}m ago`;
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="container max-w-6xl mx-auto px-4 py-6 md:py-10 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Liquidity Pools</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All available trading pairs across V2 &amp; V3
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
            onClick={() => loadPools(true)}
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

      {/* ── Stats Row ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: "Total Pools",
            value: isLoading ? "—" : String(v2Count + v3Count),
            icon: <Droplets className="h-4 w-4 text-blue-400" />,
          },
          {
            label: "Total TVL",
            value: isLoading ? "—" : fmt(totalTVL),
            icon: <TrendingUp className="h-4 w-4 text-emerald-400" />,
          },
          {
            label: "V2 Pools",
            value: isLoading ? "—" : String(v2Count),
            icon: <Layers className="h-4 w-4 text-violet-400" />,
          },
          {
            label: "V3 Pools",
            value: isLoading ? "—" : String(v3Count),
            icon: <Layers className="h-4 w-4 text-amber-400" />,
          },
        ].map(({ label, value, icon }) => (
          <Card key={label} className="border-border/40 bg-card/60 backdrop-blur">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">{label}</span>
                {icon}
              </div>
              <p className="text-xl font-bold tabular-nums">{value}</p>
            </CardContent>
          </Card>
        ))}
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
            placeholder="Search by token name or symbol…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-card/60"
          />
        </div>
      </div>

      {/* ── Pool Table ── */}
      <Card className="border-border/40 shadow-xl overflow-hidden">
        {/* Table header */}
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
                      onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                    />
                    <img
                      src={pool.logo1}
                      alt={pool.symbol1}
                      className="w-8 h-8 rounded-full border-2 border-background object-cover absolute -right-3 top-0"
                      onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
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
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 h-4 font-mono border-border/50 text-muted-foreground"
                        >
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
                    onClick={() =>
                      window.location.href = pool.version === "v3" ? "/add-liquidity-v3" : "/add-liquidity"
                    }
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
    </div>
  );
}
