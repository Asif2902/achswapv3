import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Coins,
  DollarSign,
  Flame,
  Layers,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { useAccount } from "wagmi";

const SUBGRAPH_PROXY_URL = "/api/subgraph";

type Maybe<T> = T | null;

type Protocol = {
  id: string;
  txCount: string;
  uniqueUsers: string;
  v2PoolCount: string;
  v3PoolCount: string;
  rwaPairCount: string;
  totalTvlUsd: string;
  v2TvlUsd: string;
  v3TvlUsd: string;
  rwaTvlUsd: string;
  totalVolumeUsd: string;
  dexTotalVolumeUsd: string;
  v2VolumeUsd: string;
  v3VolumeUsd: string;
  rwaVolumeUsd: string;
  totalFeesUsd: string;
  v2FeesUsd: string;
  v3FeesUsd: string;
  rwaFeesUsd: string;
  totalSwapCount: string;
  v2SwapCount: string;
  v3SwapCount: string;
  rwaBuyCount: string;
  rwaRedeemCount: string;
};

type ProtocolDayData = {
  id: string;
  date: number;
  dailyTotalVolumeUsd: string;
  dailyV2VolumeUsd: string;
  dailyV3VolumeUsd: string;
  dailyRwaVolumeUsd: string;
  dailyTotalFeesUsd: string;
  dailySwapCount: string;
  activeUsers: string;
  totalTvlUsd: string;
};

type Pool = {
  id: string;
  version: "V2" | "V3";
  feeTier: string;
  tvlUsd: string;
  volumeUsd: string;
  feesUsd: string;
  swapCount: string;
  uniqueSwapperCount: string;
  flaggedLowLiquidityOutlier: boolean;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
};

type User = {
  id: string;
  txCount: string;
  swapCount: string;
  totalVolumeUsd: string;
  dexEffectiveVolumeUsd: string;
  totalEffectiveVolumeUsd: string;
  v2VolumeUsd: string;
  v3VolumeUsd: string;
  rwaVolumeUsd: string;
  totalFeesPaidUsd: string;
  v2FeesPaidUsd: string;
  v3FeesPaidUsd: string;
  rwaFeesPaidUsd: string;
  rwaBuyCount: string;
  rwaRedeemCount: string;
  liquidityProvidedUsd: string;
  liquidityRemovedUsd: string;
  firstSeenTimestamp: string;
  lastSeenTimestamp: string;
};

type DexSwap = {
  id: string;
  timestamp: string;
  amountUsd: string;
  effectiveAmountUsd: string;
  feeUsd: string;
  sender: string;
  recipient: Maybe<string>;
  version: "V2" | "V3";
  pool: {
    id: string;
    flaggedLowLiquidityOutlier: boolean;
    token0: { symbol: string };
    token1: { symbol: string };
  };
};

type RwaTrade = {
  id: string;
  timestamp: string;
  side: "BUY" | "REDEEM";
  symbol: string;
  amountUsd: string;
  feeUsd: string;
  pair: { id: string; symbol: string };
};

type RwaPair = {
  id: string;
  symbol: string;
  volumeUsd: string;
  buyVolumeUsd: string;
  redeemVolumeUsd: string;
  feesUsd: string;
  reserveUsd: string;
  txCount: string;
  active: boolean;
  frozen: boolean;
};

type AnalyticsData = {
  meta: {
    deployment: string;
    hasIndexingErrors: boolean;
    blockNumber: number;
    blockTimestamp: number;
  };
  protocol: Maybe<Protocol>;
  protocolDayData: ProtocolDayData[];
  topPoolsByTvl: Pool[];
  topPoolsByVolume: Pool[];
  topUsersByEffectiveVolume: User[];
  totalUsersCount: number;
  swapUsersCount: number;
  rwaUsersCount: number;
  outlierPoolsCount: number;
  targetUser: Maybe<User>;
  targetUserRank: number | null;
  targetUserDexSwaps: DexSwap[];
  targetUserRwaTrades: RwaTrade[];
  topRwaPairs: RwaPair[];
};

const protocolChartConfig = {
  total: {
    label: "Total Volume",
    color: "#14b8a6",
  },
  v2: {
    label: "V2",
    color: "#2563eb",
  },
  v3: {
    label: "V3",
    color: "#f97316",
  },
  rwa: {
    label: "RWA",
    color: "#8b5cf6",
  },
  fees: {
    label: "Fees",
    color: "#eab308",
  },
} satisfies ChartConfig;

const compositionChartConfig = {
  v2: {
    label: "V2",
    color: "#2563eb",
  },
  v3: {
    label: "V3",
    color: "#f97316",
  },
  rwa: {
    label: "RWA",
    color: "#8b5cf6",
  },
} satisfies ChartConfig;

const userWalletChartConfig = {
  effective: {
    label: "Effective DEX",
    color: "hsl(var(--chart-1))",
  },
  raw: {
    label: "Raw DEX",
    color: "hsl(var(--chart-2))",
  },
  rwa: {
    label: "RWA",
    color: "hsl(var(--chart-4))",
  },
} satisfies ChartConfig;

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  if (Math.abs(value) >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(0);
}

function parseNum(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function shortenAddress(value: string): string {
  if (!value || value.length < 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts * 1000).toLocaleString();
}

function toDayLabel(unixDay: number): string {
  const date = new Date(unixDay * 86400 * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function normalizeAddressInput(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : "";
}

async function fetchSubgraph<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const payload = { query, variables };

  let res: Response;
  try {
    res = await fetch(SUBGRAPH_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    res = new Response(null, { status: 599 });
  }

  if (!res.ok) throw new Error(`Subgraph request failed with ${res.status}`);

  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Unknown subgraph error");
  return json.data as T;
}

async function countEntity(entity: string, where?: string): Promise<number> {
  let total = 0;
  let skip = 0;

  while (true) {
    const filter = where ? `, where: ${where}` : "";
    const query = `query Count${entity}${skip} { ${entity}(first: 1000, skip: ${skip}${filter}) { id } }`;
    const data = await fetchSubgraph<Record<string, Array<{ id: string }>>>(query);
    const rows = data[entity] ?? [];
    total += rows.length;
    if (rows.length < 1000) break;
    skip += 1000;
  }

  return total;
}

async function userRankByEffectiveVolume(targetUserId: string): Promise<number | null> {
  if (!targetUserId) return null;
  let rank = 1;
  let skip = 0;

  while (true) {
    const query = `
      query RankChunk {
        users(first: 1000, skip: ${skip}, orderBy: totalEffectiveVolumeUsd, orderDirection: desc) {
          id
        }
      }
    `;
    const data = await fetchSubgraph<{ users: Array<{ id: string }> }>(query);
    if (!data.users.length) return null;

    const foundIndex = data.users.findIndex((u) => u.id.toLowerCase() === targetUserId.toLowerCase());
    if (foundIndex >= 0) return rank + foundIndex;

    rank += data.users.length;
    if (data.users.length < 1000) return null;
    skip += 1000;
  }
}

async function loadAnalytics(targetWallet: string): Promise<AnalyticsData> {
  const normalizedWallet = normalizeAddressInput(targetWallet);
  const nowDay = Math.floor(Date.now() / 86400000);
  const dateCutoff = nowDay - 29;

  const query = `
    query AnalyticsSnapshot($wallet: String!, $dateCutoff: Int!) {
      _meta {
        deployment
        hasIndexingErrors
        block {
          number
          timestamp
        }
      }

      protocols(first: 1) {
        id
        txCount
        uniqueUsers
        v2PoolCount
        v3PoolCount
        rwaPairCount
        totalTvlUsd
        v2TvlUsd
        v3TvlUsd
        rwaTvlUsd
        totalVolumeUsd
        dexTotalVolumeUsd
        v2VolumeUsd
        v3VolumeUsd
        rwaVolumeUsd
        totalFeesUsd
        v2FeesUsd
        v3FeesUsd
        rwaFeesUsd
        totalSwapCount
        v2SwapCount
        v3SwapCount
        rwaBuyCount
        rwaRedeemCount
      }

      protocolDayDatas(
        first: 30
        where: { date_gte: $dateCutoff }
        orderBy: date
        orderDirection: asc
      ) {
        id
        date
        dailyTotalVolumeUsd
        dailyV2VolumeUsd
        dailyV3VolumeUsd
        dailyRwaVolumeUsd
        dailyTotalFeesUsd
        dailySwapCount
        activeUsers
        totalTvlUsd
      }

      topPoolsByTvl: pools(first: 12, orderBy: tvlUsd, orderDirection: desc) {
        id
        version
        feeTier
        tvlUsd
        volumeUsd
        feesUsd
        swapCount
        uniqueSwapperCount
        flaggedLowLiquidityOutlier
        token0 { id symbol }
        token1 { id symbol }
      }

      topPoolsByVolume: pools(first: 12, orderBy: volumeUsd, orderDirection: desc) {
        id
        version
        feeTier
        tvlUsd
        volumeUsd
        feesUsd
        swapCount
        uniqueSwapperCount
        flaggedLowLiquidityOutlier
        token0 { id symbol }
        token1 { id symbol }
      }

      topUsersByEffectiveVolume: users(first: 12, orderBy: totalEffectiveVolumeUsd, orderDirection: desc) {
        id
        txCount
        swapCount
        totalVolumeUsd
        dexEffectiveVolumeUsd
        totalEffectiveVolumeUsd
        v2VolumeUsd
        v3VolumeUsd
        rwaVolumeUsd
        totalFeesPaidUsd
        rwaBuyCount
        rwaRedeemCount
        liquidityProvidedUsd
        liquidityRemovedUsd
        firstSeenTimestamp
        lastSeenTimestamp
      }

      targetUser: user(id: $wallet) {
        id
        txCount
        swapCount
        totalVolumeUsd
        v2VolumeUsd
        v3VolumeUsd
        rwaVolumeUsd
        dexEffectiveVolumeUsd
        totalEffectiveVolumeUsd
        totalFeesPaidUsd
        v2FeesPaidUsd
        v3FeesPaidUsd
        rwaFeesPaidUsd
        rwaBuyCount
        rwaRedeemCount
        liquidityProvidedUsd
        liquidityRemovedUsd
        firstSeenTimestamp
        lastSeenTimestamp
      }

      targetUserDexSwaps: dexSwaps(first: 50, where: { user: $wallet }, orderBy: timestamp, orderDirection: desc) {
        id
        timestamp
        amountUsd
        effectiveAmountUsd
        feeUsd
        sender
        recipient
        version
        pool {
          id
          flaggedLowLiquidityOutlier
          token0 { symbol }
          token1 { symbol }
        }
      }

      targetUserRwaTrades: rwaTrades(first: 50, where: { user: $wallet }, orderBy: timestamp, orderDirection: desc) {
        id
        timestamp
        side
        symbol
        amountUsd
        feeUsd
        pair { id symbol }
      }

      topRwaPairs: rwaPairs(first: 12, orderBy: volumeUsd, orderDirection: desc) {
        id
        symbol
        volumeUsd
        buyVolumeUsd
        redeemVolumeUsd
        feesUsd
        reserveUsd
        txCount
        active
        frozen
      }
    }
  `;

  const snapshot = await fetchSubgraph<{
    _meta: {
      deployment: string;
      hasIndexingErrors: boolean;
      block: { number: number; timestamp: number };
    };
    protocols: Protocol[];
    protocolDayDatas: ProtocolDayData[];
    topPoolsByTvl: Pool[];
    topPoolsByVolume: Pool[];
    topUsersByEffectiveVolume: User[];
    targetUser: Maybe<User>;
    targetUserDexSwaps: DexSwap[];
    targetUserRwaTrades: RwaTrade[];
    topRwaPairs: RwaPair[];
  }>(query, {
    wallet: normalizedWallet || "0x0000000000000000000000000000000000000000",
    dateCutoff,
  });

  const [totalUsersCount, swapUsersCount, rwaUsersCount, targetUserRank] = await Promise.all([
    countEntity("users"),
    countEntity("users", "{ swapCount_gt: 0 }"),
    countEntity("users", "{ rwaBuyCount_gt: 0 }"),
    normalizedWallet ? userRankByEffectiveVolume(normalizedWallet) : Promise.resolve(null),
  ]);

  const outlierPoolsCount = await countEntity("pools", "{ flaggedLowLiquidityOutlier: true }");

  return {
    meta: {
      deployment: snapshot._meta.deployment,
      hasIndexingErrors: snapshot._meta.hasIndexingErrors,
      blockNumber: snapshot._meta.block.number,
      blockTimestamp: snapshot._meta.block.timestamp,
    },
    protocol: snapshot.protocols[0] ?? null,
    protocolDayData: snapshot.protocolDayDatas,
    topPoolsByTvl: snapshot.topPoolsByTvl,
    topPoolsByVolume: snapshot.topPoolsByVolume,
    topUsersByEffectiveVolume: snapshot.topUsersByEffectiveVolume,
    totalUsersCount,
    swapUsersCount,
    rwaUsersCount,
    outlierPoolsCount,
    targetUser: snapshot.targetUser,
    targetUserRank,
    targetUserDexSwaps: snapshot.targetUserDexSwaps,
    targetUserRwaTrades: snapshot.targetUserRwaTrades,
    topRwaPairs: snapshot.topRwaPairs,
  };
}

type StatTileProps = {
  title: string;
  value: string;
  subValue?: string;
  icon: ReactNode;
  tone?: "neutral" | "good" | "warn";
};

function StatTile({ title, value, subValue, icon, tone = "neutral" }: StatTileProps) {
  const toneClass =
    tone === "good"
      ? "from-emerald-500/20 to-emerald-600/10 border-emerald-400/30"
      : tone === "warn"
        ? "from-amber-500/20 to-amber-600/10 border-amber-400/30"
        : "from-primary/20 to-primary/5 border-primary/30";

  return (
    <Card className={`relative overflow-hidden border bg-gradient-to-br ${toneClass} shadow-lg`}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
            <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
            {subValue ? <p className="mt-1 text-xs text-muted-foreground">{subValue}</p> : null}
          </div>
          <div className="rounded-lg border border-white/10 bg-background/40 p-2 text-primary">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-border/70 bg-card/40 p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

export default function Pools() {
  const { address } = useAccount();
  const [walletInput, setWalletInput] = useState("");
  const [appliedWallet, setAppliedWallet] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const preferred = normalizeAddressInput(address ?? "");
    if (!walletInput && preferred) {
      setWalletInput(preferred);
      setAppliedWallet(preferred);
    }
  }, [address, walletInput]);

  useEffect(() => {
    const normalized = normalizeAddressInput(walletInput);
    if (!walletInput.trim()) {
      setError(null);
      return;
    }
    if (!normalized) {
      return;
    }
    setError(null);
    setAppliedWallet(normalized);
  }, [walletInput]);

  useEffect(() => {
    let disposed = false;
    async function run(initial: boolean) {
      if (initial) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const loaded = await loadAnalytics(appliedWallet);
        if (disposed) return;
        setData(loaded);
      } catch (e) {
        if (disposed) return;
        setError(e instanceof Error ? e.message : "Failed to load analytics data");
      } finally {
        if (disposed) return;
        if (initial) setLoading(false);
        else setRefreshing(false);
      }
    }

    run(refreshNonce === 0);
    return () => {
      disposed = true;
    };
  }, [appliedWallet, refreshNonce]);

  const protocol = data?.protocol;

  const volumeSeries = useMemo(() => {
    if (!data) return [] as Array<Record<string, number | string>>;
    return data.protocolDayData.map((d) => ({
      label: toDayLabel(d.date),
      rawDay: d.date,
      total: parseNum(d.dailyTotalVolumeUsd),
      v2: parseNum(d.dailyV2VolumeUsd),
      v3: parseNum(d.dailyV3VolumeUsd),
      rwa: parseNum(d.dailyRwaVolumeUsd),
      fees: parseNum(d.dailyTotalFeesUsd),
      swaps: parseNum(d.dailySwapCount),
      activeUsers: parseNum(d.activeUsers),
      tvl: parseNum(d.totalTvlUsd),
    }));
  }, [data]);

  const compositionSeries = useMemo(() => {
    if (!protocol) return [] as Array<{ key: "v2" | "v3" | "rwa"; label: string; value: number; fill: string }>;
    return [
      { key: "v2", label: "V2", value: parseNum(protocol.v2VolumeUsd), fill: "#2563eb" },
      { key: "v3", label: "V3", value: parseNum(protocol.v3VolumeUsd), fill: "#f97316" },
      { key: "rwa", label: "RWA", value: parseNum(protocol.rwaVolumeUsd), fill: "#8b5cf6" },
    ];
  }, [protocol]);

  const userVolumeBars = useMemo(() => {
    const user = data?.targetUser;
    if (!user) return [] as Array<{ key: string; value: number }>;
    return [
      { key: "effective", value: parseNum(user.dexEffectiveVolumeUsd) },
      { key: "raw", value: parseNum(user.totalVolumeUsd) - parseNum(user.rwaVolumeUsd) },
      { key: "rwa", value: parseNum(user.rwaVolumeUsd) },
    ];
  }, [data?.targetUser]);

  const totalPools = protocol ? parseNum(protocol.v2PoolCount) + parseNum(protocol.v3PoolCount) : 0;

  return (
    <div className="container mx-auto max-w-7xl px-3 pb-16 pt-4 sm:px-4 sm:pt-8">
      <div className="relative overflow-hidden rounded-[28px] border border-border/50 bg-[radial-gradient(circle_at_top_left,_rgba(20,184,166,0.16),_transparent_34%),radial-gradient(circle_at_top_right,_rgba(59,130,246,0.12),_transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))] p-4 shadow-2xl shadow-primary/5 sm:p-6">
        <div className="absolute -left-12 top-0 h-40 w-40 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute right-0 top-0 h-48 w-48 rounded-full bg-sky-400/10 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Achswap Intelligence Console
            </div>
            <h1 className="text-3xl font-black tracking-tight text-foreground sm:text-4xl">Analytics</h1>
            <p className="mt-3 text-sm text-muted-foreground sm:text-base">
              Platform-wide TVL, volume, swaps, fees, outlier diagnostics, user leaderboard, and wallet-level behavior
              (raw vs effective) powered by Arc analytics index data.
            </p>
            {data ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="bg-background/60">Block {formatCompact(data.meta.blockNumber)}</Badge>
                <Badge variant={data.meta.hasIndexingErrors ? "destructive" : "secondary"}>
                  {data.meta.hasIndexingErrors ? "Indexing Errors" : "Healthy"}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRefreshNonce((n) => n + 1)}
                  disabled={refreshing || loading}
                  className="ml-auto"
                >
                  {refreshing ? "Refreshing..." : "Refresh Data"}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="w-full max-w-xl rounded-2xl border border-border/50 bg-background/75 p-3 shadow-lg shadow-black/5 backdrop-blur sm:p-4">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              User analytics wallet
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={walletInput}
                  onChange={(e) => setWalletInput(e.target.value)}
                  placeholder="0x..."
                  className="pl-9"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <Card className="mt-6 border-destructive/40 bg-destructive/10">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      {loading || !data || !protocol ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              title="Total TVL"
              value={formatUsd(parseNum(protocol.totalTvlUsd))}
              subValue={`V2 ${formatUsd(parseNum(protocol.v2TvlUsd))} · V3 ${formatUsd(parseNum(protocol.v3TvlUsd))}`}
              icon={<DollarSign className="h-4 w-4" />}
              tone="good"
            />
            <StatTile
              title="Total Volume"
              value={formatUsd(parseNum(protocol.totalVolumeUsd))}
              subValue={`DEX ${formatUsd(parseNum(protocol.dexTotalVolumeUsd))} · RWA ${formatUsd(parseNum(protocol.rwaVolumeUsd))}`}
              icon={<BarChart3 className="h-4 w-4" />}
            />
            <StatTile
              title="Total Fees"
              value={formatUsd(parseNum(protocol.totalFeesUsd))}
              subValue={`V2 ${formatUsd(parseNum(protocol.v2FeesUsd))} · V3 ${formatUsd(parseNum(protocol.v3FeesUsd))}`}
              icon={<Flame className="h-4 w-4" />}
            />
            <StatTile
              title="Swaps"
              value={formatCompact(parseNum(protocol.totalSwapCount))}
              subValue={`V2 ${formatCompact(parseNum(protocol.v2SwapCount))} · V3 ${formatCompact(parseNum(protocol.v3SwapCount))}`}
              icon={<Activity className="h-4 w-4" />}
            />
            <StatTile
              title="Indexed Users"
              value={formatCompact(data.totalUsersCount)}
              subValue={`${formatCompact(data.swapUsersCount)} swap users · ${formatCompact(data.rwaUsersCount)} RWA users`}
              icon={<Users className="h-4 w-4" />}
            />
            <StatTile
              title="Pools"
              value={formatCompact(totalPools)}
              subValue={`V2 ${formatCompact(parseNum(protocol.v2PoolCount))} · V3 ${formatCompact(parseNum(protocol.v3PoolCount))}`}
              icon={<Layers className="h-4 w-4" />}
            />
            <StatTile
              title="RWA Pairs"
              value={formatCompact(parseNum(protocol.rwaPairCount))}
              subValue={`${formatCompact(parseNum(protocol.rwaBuyCount))} buys · ${formatCompact(parseNum(protocol.rwaRedeemCount))} redeems`}
              icon={<Coins className="h-4 w-4" />}
            />
            <StatTile
              title="Outlier Pools"
              value={formatCompact(data.outlierPoolsCount)}
              subValue="Low-liquidity pools with abnormal swap behavior"
              icon={<Sparkles className="h-4 w-4" />}
              tone={data.outlierPoolsCount > 0 ? "warn" : "neutral"}
            />
          </section>

          <Tabs defaultValue="platform" className="mt-8">
            <TabsList className="grid w-full grid-cols-2 bg-card/70 p-1 sm:w-[420px]">
              <TabsTrigger value="platform">Platform Analytics</TabsTrigger>
              <TabsTrigger value="user">User Analytics</TabsTrigger>
            </TabsList>

            <TabsContent value="platform" className="mt-4 space-y-6">
              <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                  <CardHeader>
                    <CardTitle className="text-lg">30D Volume & Fee Pulse</CardTitle>
                    <CardDescription>
                      Daily movement of total volume, V2/V3/RWA split, and fee generation.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 px-3 pb-4 sm:px-6">
                    {volumeSeries.length ? (
                      <ChartContainer config={protocolChartConfig} className="h-[220px] w-full sm:h-[320px]">
                        <AreaChart data={volumeSeries} margin={{ left: 0, right: 8, top: 8 }}>
                          <CartesianGrid vertical={false} strokeDasharray="3 3" />
                          <XAxis
                            dataKey="label"
                            tickMargin={8}
                            axisLine={false}
                            tickLine={false}
                            interval="preserveStartEnd"
                            minTickGap={26}
                          />
                          <YAxis
                            tickFormatter={(v) => formatCompact(Number(v))}
                            axisLine={false}
                            tickLine={false}
                            width={62}
                          />
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                labelFormatter={(label, payload) => {
                                  const item = payload?.[0];
                                  const rawDay = item?.payload?.rawDay as number | undefined;
                                  if (typeof rawDay === "number") {
                                    const fullDate = new Date(rawDay * 86400 * 1000).toLocaleDateString(undefined, {
                                      year: "numeric",
                                      month: "short",
                                      day: "numeric",
                                    });
                                    return `${label} (${fullDate})`;
                                  }
                                  return String(label ?? "");
                                }}
                                formatter={(value, name) => {
                                  const key = String(name ?? "");
                                  const isCount = key === "swaps" || key === "activeUsers";
                                  const rendered = isCount ? formatCompact(Number(value)) : formatUsd(Number(value));
                                  const label =
                                    protocolChartConfig[key as keyof typeof protocolChartConfig]?.label ?? key;
                                  return (
                                    <div className="flex min-w-[10rem] items-center justify-between gap-3">
                                      <span className="text-muted-foreground">{label}</span>
                                      <span className="font-mono font-medium text-foreground">{rendered}</span>
                                    </div>
                                  );
                                }}
                              />
                            }
                          />
                          <ChartLegend content={<ChartLegendContent />} />
                          <Area type="monotone" dataKey="total" stroke="var(--color-total)" fill="var(--color-total)" fillOpacity={0.15} strokeWidth={2.2} />
                          <Area type="monotone" dataKey="fees" stroke="var(--color-fees)" fill="var(--color-fees)" fillOpacity={0.08} strokeWidth={1.8} />
                          <Area type="monotone" dataKey="v2" stroke="var(--color-v2)" fill="none" strokeWidth={1.4} />
                          <Area type="monotone" dataKey="v3" stroke="var(--color-v3)" fill="none" strokeWidth={1.4} />
                          <Area type="monotone" dataKey="rwa" stroke="var(--color-rwa)" fill="none" strokeWidth={1.4} />
                        </AreaChart>
                      </ChartContainer>
                    ) : (
                      <EmptyState text="No historical protocol day data indexed yet." />
                    )}
                  </CardContent>
                </Card>

                <Card className="min-w-0 overflow-hidden border-border/50 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.03))] shadow-lg shadow-black/5">
                  <CardHeader>
                    <CardTitle className="text-lg">Volume Composition</CardTitle>
                    <CardDescription>Share of cumulative volume by execution stack.</CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 px-3 pb-4 sm:px-6">
                    {compositionSeries.length ? (
                      <ChartContainer config={compositionChartConfig} className="h-[220px] w-full sm:h-[320px]">
                        <PieChart>
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                nameKey="key"
                                formatter={(value, name) => {
                                  const key = String(name ?? "") as keyof typeof compositionChartConfig;
                                  const label = compositionChartConfig[key]?.label ?? key.toUpperCase();
                                  return (
                                    <div className="flex min-w-[9rem] items-center justify-between gap-3">
                                      <span className="text-muted-foreground">{label}</span>
                                      <span className="font-mono font-medium text-foreground">
                                        {formatUsd(Number(value))}
                                      </span>
                                    </div>
                                  );
                                }}
                              />
                            }
                          />
                          <Pie
                            data={compositionSeries}
                            dataKey="value"
                            nameKey="key"
                            cx="50%"
                            cy="50%"
                            innerRadius={65}
                            outerRadius={108}
                            stroke="none"
                          >
                            {compositionSeries.map((entry) => (
                              <Cell key={entry.key} fill={entry.fill} />
                            ))}
                          </Pie>
                          <ChartLegend content={<ChartLegendContent />} />
                        </PieChart>
                      </ChartContainer>
                    ) : (
                      <EmptyState text="No protocol composition data available." />
                    )}
                  </CardContent>
                </Card>

                <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5 lg:col-span-2">
                  <CardHeader>
                    <CardTitle className="text-lg">Top RWA Pairs</CardTitle>
                    <CardDescription>Buy/redeem flow and reserve health by pair.</CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 px-3 pb-4 sm:px-6">
                    {data.topRwaPairs.length ? (
                      <ChartContainer config={protocolChartConfig} className="h-[230px] w-full sm:h-[300px]">
                        <BarChart
                          data={data.topRwaPairs.slice(0, 8).map((p) => ({
                            symbol: p.symbol,
                            volume: parseNum(p.volumeUsd),
                            reserve: parseNum(p.reserveUsd),
                          }))}
                          margin={{ left: 0, right: 8 }}
                        >
                          <CartesianGrid vertical={false} strokeDasharray="3 3" />
                          <XAxis dataKey="symbol" axisLine={false} tickLine={false} />
                          <YAxis axisLine={false} tickLine={false} tickFormatter={(v) => formatCompact(Number(v))} width={62} />
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                labelFormatter={(label) => `Pair ${String(label ?? "")}`}
                                formatter={(value) => (
                                  <div className="flex min-w-[9rem] items-center justify-between gap-3">
                                    <span className="text-muted-foreground">Volume</span>
                                    <span className="font-mono font-medium text-foreground">
                                      {formatUsd(Number(value))}
                                    </span>
                                  </div>
                                )}
                              />
                            }
                          />
                          <Bar dataKey="volume" fill="var(--color-total)" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ChartContainer>
                    ) : (
                      <EmptyState text="No RWA pair activity found yet." />
                    )}
                  </CardContent>
                </Card>

                <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5 lg:col-span-2">
                  <CardHeader>
                    <CardTitle className="text-base">30D Breakdown Snapshot</CardTitle>
                    <CardDescription>
                      Current last-day values to quickly compare Volume, Fees, V2, V3 and RWA.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="px-3 pb-4 sm:px-6">
                    {volumeSeries.length ? (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        {[
                          { key: "total", label: "Volume", color: "#14b8a6" },
                          { key: "fees", label: "Fees", color: "#eab308" },
                          { key: "v2", label: "V2", color: "#2563eb" },
                          { key: "v3", label: "V3", color: "#f97316" },
                          { key: "rwa", label: "RWA", color: "#8b5cf6" },
                        ].map((row) => {
                          const latest = volumeSeries[volumeSeries.length - 1] as Record<string, number | string>;
                          const val = Number(latest[row.key] ?? 0);
                          return (
                            <div key={row.key} className="rounded-lg border border-border/60 bg-background/40 p-3">
                              <div className="mb-2 flex items-center gap-2">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                                <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">{row.label}</span>
                              </div>
                              <div className="text-lg font-bold">{formatUsd(val)}</div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <EmptyState text="No daily data available for breakdown." />
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-6 xl:grid-cols-2">
                <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                  <CardHeader>
                    <CardTitle className="text-lg">Top Pools by TVL</CardTitle>
                    <CardDescription>Most capital-dense pools across V2 and V3.</CardDescription>
                  </CardHeader>
                  <CardContent className="px-3 pb-4 sm:px-6">
                    <div className="overflow-x-auto rounded-xl border border-border/50">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Pool</TableHead>
                            <TableHead>Version</TableHead>
                            <TableHead className="text-right">TVL</TableHead>
                            <TableHead className="text-right">Volume</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.topPoolsByTvl.map((pool) => (
                            <TableRow key={`tvl-${pool.id}`}>
                              <TableCell className="font-medium">
                                {pool.token0.symbol}/{pool.token1.symbol}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline">{pool.version}</Badge>
                              </TableCell>
                              <TableCell className="text-right font-semibold">{formatUsd(parseNum(pool.tvlUsd))}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatUsd(parseNum(pool.volumeUsd))}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>

                <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                  <CardHeader>
                    <CardTitle className="text-lg">Top Pools by Volume</CardTitle>
                    <CardDescription>
                      High-turnover pools, with outlier and unique swapper diagnostics.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="px-3 pb-4 sm:px-6">
                    <div className="overflow-x-auto rounded-xl border border-border/50">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Pool</TableHead>
                            <TableHead className="text-right">Volume</TableHead>
                            <TableHead className="text-right">TVL</TableHead>
                            <TableHead className="text-right">Swappers</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.topPoolsByVolume.map((pool) => (
                            <TableRow key={`vol-${pool.id}`}>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{pool.token0.symbol}/{pool.token1.symbol}</span>
                                  {pool.flaggedLowLiquidityOutlier ? (
                                    <Badge variant="destructive" className="text-[10px]">Outlier</Badge>
                                  ) : null}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-semibold">{formatUsd(parseNum(pool.volumeUsd))}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatUsd(parseNum(pool.tvlUsd))}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatCompact(parseNum(pool.uniqueSwapperCount))}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-6 xl:grid-cols-2">
                <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                  <CardHeader>
                    <CardTitle className="text-lg">Top Users (Effective Volume)</CardTitle>
                    <CardDescription>Leaderboard with anti-route-inflation effective accounting.</CardDescription>
                  </CardHeader>
                  <CardContent className="px-3 pb-4 sm:px-6">
                    <div className="overflow-x-auto rounded-xl border border-border/50">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>User</TableHead>
                            <TableHead className="text-right">Effective Vol</TableHead>
                            <TableHead className="text-right">Raw Vol</TableHead>
                            <TableHead className="text-right">Swaps</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.topUsersByEffectiveVolume.map((u) => (
                            <TableRow key={u.id}>
                              <TableCell className="font-medium">{shortenAddress(u.id)}</TableCell>
                              <TableCell className="text-right font-semibold">{formatUsd(parseNum(u.totalEffectiveVolumeUsd))}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatUsd(parseNum(u.totalVolumeUsd))}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatCompact(parseNum(u.swapCount))}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>

              </div>
            </TabsContent>

            <TabsContent value="user" className="mt-4 space-y-6">
              {data.targetUser ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <StatTile
                      title="Effective Total"
                      value={formatUsd(parseNum(data.targetUser.totalEffectiveVolumeUsd))}
                      subValue="De-duplicated across multi-hop tx routes"
                      icon={<ArrowUpRight className="h-4 w-4" />}
                      tone="good"
                    />
                    <StatTile
                      title="Raw Total"
                      value={formatUsd(parseNum(data.targetUser.totalVolumeUsd))}
                      subValue="Includes all indexed swap-hop events"
                      icon={<ArrowDownRight className="h-4 w-4" />}
                    />
                    <StatTile
                      title="Swaps"
                      value={formatCompact(parseNum(data.targetUser.swapCount))}
                      subValue={`Tx tracked ${formatCompact(parseNum(data.targetUser.txCount))}`}
                      icon={<Activity className="h-4 w-4" />}
                    />
                    <StatTile
                      title="Wallet Rank"
                      value={data.targetUserRank ? `#${formatCompact(data.targetUserRank)}` : "Unranked"}
                      subValue="Ranked by total effective volume"
                      icon={<Users className="h-4 w-4" />}
                    />
                    <StatTile
                      title="Fees Paid"
                      value={formatUsd(parseNum(data.targetUser.totalFeesPaidUsd))}
                      subValue={`RWA ${formatUsd(parseNum(data.targetUser.rwaFeesPaidUsd))}`}
                      icon={<Flame className="h-4 w-4" />}
                    />
                  </div>

                  <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
                    <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                      <CardHeader>
                        <CardTitle className="text-lg">Wallet Volume Lens</CardTitle>
                        <CardDescription>Raw vs effective DEX accounting plus RWA contribution.</CardDescription>
                      </CardHeader>
                      <CardContent className="min-w-0 px-3 pb-4 sm:px-6">
                        <ChartContainer config={userWalletChartConfig} className="h-[220px] w-full sm:h-[300px]">
                          <BarChart data={userVolumeBars} margin={{ left: 0, right: 8 }}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="key" axisLine={false} tickLine={false} />
                            <YAxis axisLine={false} tickLine={false} tickFormatter={(v) => formatCompact(Number(v))} width={62} />
                            <ChartTooltip content={<ChartTooltipContent formatter={(v) => formatUsd(Number(v))} />} />
                            <Bar dataKey="value" fill="var(--color-effective)" radius={[8, 8, 0, 0]} />
                          </BarChart>
                        </ChartContainer>
                      </CardContent>
                    </Card>

                    <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                      <CardHeader>
                        <CardTitle className="text-lg">Wallet Profile</CardTitle>
                        <CardDescription>Lifecycle and behavior stats for this address.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3 px-3 pb-4 text-sm sm:px-6">
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Address</span>
                          <span className="font-semibold text-foreground">{shortenAddress(data.targetUser.id)}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Wallet Rank</span>
                          <span className="font-semibold text-foreground">
                            {data.targetUserRank ? `#${formatCompact(data.targetUserRank)}` : "Unranked"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Liquidity Provided</span>
                          <span className="font-semibold">{formatUsd(parseNum(data.targetUser.liquidityProvidedUsd))}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Liquidity Removed</span>
                          <span className="font-semibold">{formatUsd(parseNum(data.targetUser.liquidityRemovedUsd))}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">RWA Trades</span>
                          <span className="font-semibold">{formatCompact(parseNum(data.targetUser.rwaBuyCount) + parseNum(data.targetUser.rwaRedeemCount))}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">First Seen</span>
                          <span className="font-semibold">{formatDate(parseNum(data.targetUser.firstSeenTimestamp))}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Last Seen</span>
                          <span className="font-semibold">{formatDate(parseNum(data.targetUser.lastSeenTimestamp))}</span>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="grid gap-6 xl:grid-cols-2">
                    <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                      <CardHeader>
                        <CardTitle className="text-lg">Latest DEX Swaps</CardTitle>
                        <CardDescription>
                          Effective amount is the per-tx de-duplicated value used for anti-hop inflation.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="px-3 pb-4 sm:px-6">
                        {data.targetUserDexSwaps.length ? (
                          <div className="overflow-x-auto rounded-xl border border-border/50">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Pool</TableHead>
                                  <TableHead className="text-right">Raw</TableHead>
                                  <TableHead className="text-right">Effective</TableHead>
                                  <TableHead className="text-right">Time</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {data.targetUserDexSwaps.slice(0, 14).map((swap) => (
                                  <TableRow key={swap.id}>
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        <span className="font-medium">{swap.pool.token0.symbol}/{swap.pool.token1.symbol}</span>
                                        {swap.pool.flaggedLowLiquidityOutlier ? (
                                          <Badge variant="destructive" className="text-[10px]">Outlier</Badge>
                                        ) : null}
                                      </div>
                                    </TableCell>
                                    <TableCell className="text-right">{formatUsd(parseNum(swap.amountUsd))}</TableCell>
                                    <TableCell className="text-right font-semibold">{formatUsd(parseNum(swap.effectiveAmountUsd))}</TableCell>
                                    <TableCell className="text-right text-xs text-muted-foreground">{formatDate(parseNum(swap.timestamp))}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        ) : (
                          <EmptyState text="No DEX swaps found for this wallet." />
                        )}
                      </CardContent>
                    </Card>

                    <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                      <CardHeader>
                        <CardTitle className="text-lg">Latest RWA Trades</CardTitle>
                        <CardDescription>Pair-level synthetic buy/redeem activity.</CardDescription>
                      </CardHeader>
                      <CardContent className="px-3 pb-4 sm:px-6">
                        {data.targetUserRwaTrades.length ? (
                          <div className="overflow-x-auto rounded-xl border border-border/50">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Pair</TableHead>
                                  <TableHead>Side</TableHead>
                                  <TableHead className="text-right">Amount</TableHead>
                                  <TableHead className="text-right">Fee</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {data.targetUserRwaTrades.slice(0, 14).map((trade) => (
                                  <TableRow key={trade.id}>
                                    <TableCell className="font-medium">{trade.symbol}</TableCell>
                                    <TableCell>
                                      <Badge variant={trade.side === "BUY" ? "secondary" : "outline"}>{trade.side}</Badge>
                                    </TableCell>
                                    <TableCell className="text-right font-semibold">{formatUsd(parseNum(trade.amountUsd))}</TableCell>
                                    <TableCell className="text-right text-muted-foreground">{formatUsd(parseNum(trade.feeUsd))}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        ) : (
                          <EmptyState text="No RWA trades found for this wallet." />
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </>
              ) : (
                <EmptyState text="No user record found. Enter a wallet that has swap or RWA activity on this subgraph." />
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
