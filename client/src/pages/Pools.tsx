import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Copy,
  DollarSign,
  Flame,
  Layers,
  Search,
  Sparkles,
  Users,
  Wallet,
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
const ANALYTICS_SUMMARY_URL = "/api/analytics-summary";
const SUBGRAPH_PROXY_APP_TOKEN = (import.meta.env.VITE_SUBGRAPH_PROXY_TOKEN as string | undefined)?.trim();

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
  dailyRwaFeesUsd?: string;
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
    color: "#06b6d4",
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
    label: "RWA Volume",
    color: "#a855f7",
  },
  fees: {
    label: "Fees",
    color: "#facc15",
  },
  rwaFees: {
    label: "RWA Fees",
    color: "#ef4444",
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
    color: "#a855f7",
  },
} satisfies ChartConfig;

const rwaPairsChartConfig = {
  volume: {
    label: "Volume",
    color: "#06b6d4",
  },
  reserve: {
    label: "Reserve",
    color: "#22c55e",
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

type VolumeSeriesPoint = {
  label: string;
  rawDay: number;
  total: number;
  v2: number;
  v3: number;
  rwa: number;
  fees: number;
  rwaFees: number;
  swaps: number;
  activeUsers: number;
  tvl: number;
};

type CompositionSeriesPoint = {
  key: "v2" | "v3" | "rwa";
  value: number;
};

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

function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(digits)}%`;
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (SUBGRAPH_PROXY_APP_TOKEN) {
    headers["X-App-Token"] = SUBGRAPH_PROXY_APP_TOKEN;
  }

  let res: Response;
  try {
    res = await fetch(SUBGRAPH_PROXY_URL, {
      method: "POST",
      headers,
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

async function fetchAnalyticsSummary(wallet: string): Promise<{
  totalUsersCount: number;
  swapUsersCount: number;
  rwaUsersCount: number;
  outlierPoolsCount: number;
  targetUserRank: number | null;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (SUBGRAPH_PROXY_APP_TOKEN) {
    headers["X-App-Token"] = SUBGRAPH_PROXY_APP_TOKEN;
  }

  const response = await fetch(ANALYTICS_SUMMARY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ wallet }),
  });

  if (!response.ok) {
    throw new Error(`Analytics summary request failed with ${response.status}`);
  }

  const json = await response.json();
  return {
    totalUsersCount: parseNum(json.totalUsersCount),
    swapUsersCount: parseNum(json.swapUsersCount),
    rwaUsersCount: parseNum(json.rwaUsersCount),
    outlierPoolsCount: parseNum(json.outlierPoolsCount),
    targetUserRank: typeof json.targetUserRank === "number" ? json.targetUserRank : null,
  };
}

async function loadAnalytics(targetWallet: string): Promise<AnalyticsData> {
  const normalizedWallet = normalizeAddressInput(targetWallet);
  const nowDay = Math.floor(Date.now() / 86400000);
  const dateCutoff = nowDay - 29;

  const query = `
    query AnalyticsSnapshot($wallet: String!, $dateCutoff: Int!, $hasWallet: Boolean!) {
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
        dailyRwaFeesUsd
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

      targetUser: user(id: $wallet) @include(if: $hasWallet) {
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

      targetUserDexSwaps: dexSwaps(first: 50, where: { user: $wallet }, orderBy: timestamp, orderDirection: desc) @include(if: $hasWallet) {
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

      targetUserRwaTrades: rwaTrades(first: 50, where: { user: $wallet }, orderBy: timestamp, orderDirection: desc) @include(if: $hasWallet) {
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

  const [snapshot, summary] = await Promise.all([
    fetchSubgraph<{
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
      targetUser?: Maybe<User>;
      targetUserDexSwaps?: DexSwap[];
      targetUserRwaTrades?: RwaTrade[];
      topRwaPairs: RwaPair[];
    }>(query, {
      wallet: normalizedWallet,
      hasWallet: Boolean(normalizedWallet),
      dateCutoff,
    }),
    fetchAnalyticsSummary(normalizedWallet),
  ]);

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
    totalUsersCount: summary.totalUsersCount,
    swapUsersCount: summary.swapUsersCount,
    rwaUsersCount: summary.rwaUsersCount,
    outlierPoolsCount: summary.outlierPoolsCount,
    targetUser: snapshot.targetUser ?? null,
    targetUserRank: summary.targetUserRank,
    targetUserDexSwaps: snapshot.targetUserDexSwaps ?? [],
    targetUserRwaTrades: snapshot.targetUserRwaTrades ?? [],
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

function InsightRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border/60 bg-background/45 px-3 py-2.5">
      <div>
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
        {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      <p className="text-right font-mono text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

export default function Pools() {
  const { address } = useAccount();
  const lastAutoAppliedAddressRef = useRef("");
  const [walletInput, setWalletInput] = useState("");
  const [appliedWallet, setAppliedWallet] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [selectedVolumeDay, setSelectedVolumeDay] = useState<number | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const preferred = normalizeAddressInput(address ?? "");

    if (!preferred) {
      lastAutoAppliedAddressRef.current = "";
      if (!walletInput) {
        setAppliedWallet("");
      }
      return;
    }

    if (!walletInput && preferred !== lastAutoAppliedAddressRef.current) {
      setWalletInput(preferred);
      setAppliedWallet(preferred);
      lastAutoAppliedAddressRef.current = preferred;
      return;
    }
  }, [address, walletInput]);

  useEffect(() => {
    const normalized = normalizeAddressInput(walletInput);
    if (!walletInput.trim()) {
      setError(null);
      setAppliedWallet("");
      return;
    }
    if (!normalized) {
      return;
    }
    setError(null);
    setAppliedWallet(normalized);
  }, [walletInput]);

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(true);
    setRefreshing(false);
  }, [appliedWallet]);

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
        if (!disposed) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    run(refreshNonce === 0);
    return () => {
      disposed = true;
    };
  }, [appliedWallet, refreshNonce]);

  const protocol = data?.protocol;

  const volumeSeries = useMemo<VolumeSeriesPoint[]>(() => {
    if (!data) return [];
    return data.protocolDayData.map((d) => ({
      label: toDayLabel(d.date),
      rawDay: d.date,
      total: parseNum(d.dailyTotalVolumeUsd),
      v2: parseNum(d.dailyV2VolumeUsd),
      v3: parseNum(d.dailyV3VolumeUsd),
      rwa: parseNum(d.dailyRwaVolumeUsd),
      fees: parseNum(d.dailyTotalFeesUsd),
      rwaFees: parseNum(d.dailyRwaFeesUsd),
      swaps: parseNum(d.dailySwapCount),
      activeUsers: parseNum(d.activeUsers),
      tvl: parseNum(d.totalTvlUsd),
    }));
  }, [data]);

  const compositionSeries = useMemo<CompositionSeriesPoint[]>(() => {
    if (!protocol) return [];
    return [
      { key: "v2", value: parseNum(protocol.v2VolumeUsd) },
      { key: "v3", value: parseNum(protocol.v3VolumeUsd) },
      { key: "rwa", value: parseNum(protocol.rwaVolumeUsd) },
    ];
  }, [protocol]);

  const userVolumeBars = useMemo<Array<{ key: "effective" | "raw" | "rwa"; value: number }>>(() => {
    const user = data?.targetUser;
    if (!user) return [];
    return [
      { key: "effective", value: parseNum(user.dexEffectiveVolumeUsd) },
      { key: "raw", value: parseNum(user.totalVolumeUsd) - parseNum(user.rwaVolumeUsd) },
      { key: "rwa", value: parseNum(user.rwaVolumeUsd) },
    ];
  }, [data?.targetUser]);

  const totalPools = protocol ? parseNum(protocol.v2PoolCount) + parseNum(protocol.v3PoolCount) : 0;

  useEffect(() => {
    if (!volumeSeries.length) {
      if (selectedVolumeDay !== null) setSelectedVolumeDay(null);
      return;
    }

    const hasSelection = selectedVolumeDay !== null && volumeSeries.some((row) => row.rawDay === selectedVolumeDay);
    if (!hasSelection) {
      setSelectedVolumeDay(volumeSeries[volumeSeries.length - 1].rawDay);
    }
  }, [volumeSeries, selectedVolumeDay]);

  const selectedVolumePoint = useMemo(() => {
    if (!volumeSeries.length) return null;
    if (selectedVolumeDay === null) return volumeSeries[volumeSeries.length - 1];
    return volumeSeries.find((row) => row.rawDay === selectedVolumeDay) ?? volumeSeries[volumeSeries.length - 1];
  }, [volumeSeries, selectedVolumeDay]);

  const compositionLegendRows = useMemo(() => {
    const total = compositionSeries.reduce((sum, row) => sum + row.value, 0);
    return compositionSeries.map((row) => {
      const config = compositionChartConfig[row.key];
      const color = typeof config.color === "string" ? config.color : "hsl(var(--muted-foreground))";
      const share = total > 0 ? (row.value / total) * 100 : 0;
      return {
        key: row.key,
        label: config.label,
        value: row.value,
        color,
        share,
      };
    });
  }, [compositionSeries]);

  const userVolumeColorMap: Record<"effective" | "raw" | "rwa", string> = {
    effective: "var(--color-effective)",
    raw: "var(--color-raw)",
    rwa: "var(--color-rwa)",
  };

  const latestVolumePoint = volumeSeries[volumeSeries.length - 1] ?? null;
  const previousVolumePoint = volumeSeries[volumeSeries.length - 2] ?? null;
  const averageDailyVolume =
    volumeSeries.length > 0 ? volumeSeries.reduce((sum, row) => sum + row.total, 0) / volumeSeries.length : 0;
  const averageDailyFees =
    volumeSeries.length > 0 ? volumeSeries.reduce((sum, row) => sum + row.fees, 0) / volumeSeries.length : 0;
  const volumeDeltaPct =
    latestVolumePoint && previousVolumePoint && previousVolumePoint.total > 0
      ? ((latestVolumePoint.total - previousVolumePoint.total) / previousVolumePoint.total) * 100
      : 0;
  const activeUsersDeltaPct =
    latestVolumePoint && previousVolumePoint && previousVolumePoint.activeUsers > 0
      ? ((latestVolumePoint.activeUsers - previousVolumePoint.activeUsers) / previousVolumePoint.activeUsers) * 100
      : 0;
  const totalVolumeValue = parseNum(protocol?.totalVolumeUsd);
  const totalFeesValue = parseNum(protocol?.totalFeesUsd);
  const totalTvlValue = parseNum(protocol?.totalTvlUsd);
  const dexVolumeValue = parseNum(protocol?.dexTotalVolumeUsd);
  const rwaVolumeValue = parseNum(protocol?.rwaVolumeUsd);
  const feeRatePct = totalVolumeValue > 0 ? (totalFeesValue / totalVolumeValue) * 100 : 0;
  const rwaVolumeSharePct = totalVolumeValue > 0 ? (rwaVolumeValue / totalVolumeValue) * 100 : 0;
  const dexVolumeSharePct = totalVolumeValue > 0 ? (dexVolumeValue / totalVolumeValue) * 100 : 0;
  const averageTvlPerPool = totalPools > 0 ? totalTvlValue / totalPools : 0;
  const outlierPoolSharePct = totalPools > 0 ? (data?.outlierPoolsCount ?? 0) / totalPools * 100 : 0;
  const topPoolByTvl = data?.topPoolsByTvl[0] ?? null;
  const topPoolByVolume = data?.topPoolsByVolume[0] ?? null;
  const targetUser = data?.targetUser ?? null;
  const targetUserRawDexVolume = targetUser ? parseNum(targetUser.totalVolumeUsd) - parseNum(targetUser.rwaVolumeUsd) : 0;
  const targetUserEffectiveRatioPct =
    targetUser && targetUserRawDexVolume > 0
      ? (parseNum(targetUser.dexEffectiveVolumeUsd) / targetUserRawDexVolume) * 100
      : 0;
  const targetUserAverageSwapSize =
    targetUser && parseNum(targetUser.swapCount) > 0
      ? parseNum(targetUser.totalEffectiveVolumeUsd) / parseNum(targetUser.swapCount)
      : 0;
  const targetUserAverageFeePerSwap =
    targetUser && parseNum(targetUser.swapCount) > 0
      ? parseNum(targetUser.totalFeesPaidUsd) / parseNum(targetUser.swapCount)
      : 0;
  const targetUserNetLiquidity =
    targetUser ? parseNum(targetUser.liquidityProvidedUsd) - parseNum(targetUser.liquidityRemovedUsd) : 0;
  const selectedWalletLabel = appliedWallet || normalizeAddressInput(address ?? "");
  const walletLooksValid = !walletInput.trim() || Boolean(normalizeAddressInput(walletInput));

  const applyConnectedWallet = () => {
    const normalized = normalizeAddressInput(address ?? "");
    if (!normalized) return;
    setWalletInput(normalized);
    setAppliedWallet(normalized);
    setError(null);
  };

  const clearWallet = () => {
    setWalletInput("");
    setAppliedWallet("");
    setError(null);
  };

  const copyWallet = async () => {
    if (!selectedWalletLabel || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(selectedWalletLabel);
    } catch {
      // Silent no-op. Copy is convenience-only.
    }
  };

  return (
    <div className="container mx-auto max-w-7xl px-3 pb-16 pt-4 sm:px-4 sm:pt-8">
      <div className="relative overflow-hidden rounded-[32px] border border-border/50 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.14),_transparent_28%),radial-gradient(circle_at_80%_20%,_rgba(14,165,233,0.18),_transparent_24%),linear-gradient(135deg,rgba(8,15,32,0.94),rgba(17,24,39,0.9)_42%,rgba(7,12,24,0.95))] p-4 shadow-2xl shadow-primary/10 sm:p-6 lg:p-7">
        <div className="absolute -left-12 top-0 h-40 w-40 rounded-full bg-emerald-400/20 blur-3xl" />
        <div className="absolute right-0 top-0 h-48 w-48 rounded-full bg-sky-400/15 blur-3xl" />
        <div className="absolute bottom-0 right-1/4 h-36 w-36 rounded-full bg-cyan-300/10 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-300/40 to-transparent" />

        <div className="relative grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.9fr)]">
          <div className="max-w-4xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">
              <Sparkles className="h-3.5 w-3.5" />
              Achswap Intelligence Console
            </div>
            <h1 className="text-3xl font-black tracking-tight text-white sm:text-5xl">Analytics That Actually Explains the Flow</h1>
            <p className="mt-3 max-w-3xl text-sm text-slate-300 sm:text-base">
              Platform-wide TVL, volume, swaps, fees, outlier diagnostics, leaderboard context, and wallet-level behavior
              (raw vs effective) powered by Arc analytics index data.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Latest Daily Volume</p>
                <p className="mt-2 text-2xl font-bold text-white">
                  {latestVolumePoint ? formatUsd(latestVolumePoint.total) : "--"}
                </p>
                <p className="mt-1 text-xs text-slate-300">
                  {previousVolumePoint ? `${formatPercent(volumeDeltaPct)} vs previous day` : "Waiting for historical delta"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">30D Avg Daily Fees</p>
                <p className="mt-2 text-2xl font-bold text-white">{formatUsd(averageDailyFees)}</p>
                <p className="mt-1 text-xs text-slate-300">Fee rate {formatPercent(feeRatePct, 2)} on cumulative volume</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Latest Active Users</p>
                <p className="mt-2 text-2xl font-bold text-white">
                  {latestVolumePoint ? formatCompact(latestVolumePoint.activeUsers) : "--"}
                </p>
                <p className="mt-1 text-xs text-slate-300">
                  {previousVolumePoint ? `${formatPercent(activeUsersDeltaPct)} vs previous day` : "Waiting for historical delta"}
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-300">
              {data ? (
                <>
                  <Badge variant="outline" className="border-white/15 bg-white/5 text-slate-100">
                    Block {formatCompact(data.meta.blockNumber)}
                  </Badge>
                  <Badge className={data.meta.hasIndexingErrors ? "" : "border-emerald-400/20 bg-emerald-400/15 text-emerald-100"} variant={data.meta.hasIndexingErrors ? "destructive" : "outline"}>
                    {data.meta.hasIndexingErrors ? "Indexing Errors" : "Indexer Healthy"}
                  </Badge>
                  <Badge variant="outline" className="border-white/15 bg-white/5 text-slate-200">
                    30D avg volume {formatUsd(averageDailyVolume)}
                  </Badge>
                </>
              ) : null}
            </div>
          </div>

          <div className="w-full rounded-[28px] border border-white/10 bg-black/20 p-3 shadow-lg shadow-black/20 backdrop-blur sm:p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Wallet Lens</p>
                <h2 className="mt-1 text-lg font-semibold text-white">Focus a specific trader</h2>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRefreshNonce((n) => n + 1)}
                disabled={refreshing || loading}
                className="border-white/15 bg-white/5 text-slate-100 hover:bg-white/10"
              >
                {refreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </div>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
              User analytics wallet
            </label>
            <div className="mt-2 flex flex-col gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input
                  value={walletInput}
                  onChange={(e) => setWalletInput(e.target.value)}
                  placeholder="0x..."
                  className="border-white/10 bg-white/5 pl-9 text-white placeholder:text-slate-500"
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={applyConnectedWallet}
                  disabled={!normalizeAddressInput(address ?? "")}
                  className="border-white/15 bg-white/5 text-slate-100 hover:bg-white/10"
                >
                  <Wallet className="mr-2 h-4 w-4" />
                  Use Connected
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={copyWallet}
                  disabled={!selectedWalletLabel}
                  className="border-white/15 bg-white/5 text-slate-100 hover:bg-white/10"
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Copy
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={clearWallet}
                  className="border-white/15 bg-white/5 text-slate-100 hover:bg-white/10"
                >
                  Clear
                </Button>
              </div>
            </div>
            <div className="mt-4 grid gap-2">
              <InsightRow
                label="Selection"
                value={selectedWalletLabel ? shortenAddress(selectedWalletLabel) : "Platform View"}
                detail={selectedWalletLabel ? "Wallet-specific charts and tables are active" : "No wallet filter applied"}
              />
              <InsightRow
                label="Input State"
                value={walletLooksValid ? "Ready" : "Invalid"}
                detail={walletLooksValid ? "Valid addresses auto-apply to user analytics" : "Wallet must match a 42-char EVM address"}
              />
              <InsightRow
                label="Connected Wallet"
                value={address ? shortenAddress(address) : "Not connected"}
                detail="Use this shortcut to inspect the active account immediately"
              />
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
              subValue={`V2 ${formatUsd(parseNum(protocol.v2TvlUsd))} · V3 ${formatUsd(parseNum(protocol.v3TvlUsd))} · RWA ${formatUsd(parseNum(protocol.rwaTvlUsd))}`}
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

          <section className="mt-6 grid gap-4 xl:grid-cols-3">
            <Card className="overflow-hidden border-border/50 bg-[linear-gradient(135deg,rgba(20,184,166,0.12),rgba(15,23,42,0.8))] shadow-lg shadow-black/5">
              <CardHeader>
                <CardTitle className="text-lg text-white">Flow Momentum</CardTitle>
                <CardDescription>Latest-day movement versus the prior daily snapshot.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 px-3 pb-4 sm:px-6">
                <InsightRow label="Daily Volume" value={latestVolumePoint ? formatUsd(latestVolumePoint.total) : "--"} detail={previousVolumePoint ? `${formatPercent(volumeDeltaPct)} day-over-day` : "Need at least two indexed days"} />
                <InsightRow label="Daily Fees" value={latestVolumePoint ? formatUsd(latestVolumePoint.fees) : "--"} detail={`30D average ${formatUsd(averageDailyFees)}`} />
                <InsightRow label="Active Users" value={latestVolumePoint ? formatCompact(latestVolumePoint.activeUsers) : "--"} detail={previousVolumePoint ? `${formatPercent(activeUsersDeltaPct)} day-over-day` : "Need at least two indexed days"} />
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
              <CardHeader>
                <CardTitle className="text-lg">Protocol Efficiency</CardTitle>
                <CardDescription>How the current liquidity base is converting into flow.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 px-3 pb-4 sm:px-6">
                <InsightRow label="Fee Capture" value={formatPercent(feeRatePct, 2)} detail={`${formatUsd(totalFeesValue)} fees on ${formatUsd(totalVolumeValue)} volume`} />
                <InsightRow label="Avg TVL / Pool" value={formatUsd(averageTvlPerPool)} detail={`${formatCompact(totalPools)} total V2 and V3 pools`} />
                <InsightRow label="Latest TVL" value={latestVolumePoint ? formatUsd(latestVolumePoint.tvl) : formatUsd(totalTvlValue)} detail="Historical daily close from protocol day data" />
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
              <CardHeader>
                <CardTitle className="text-lg">Coverage Split</CardTitle>
                <CardDescription>Execution mix across DEX and RWA rails plus anomaly density.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 px-3 pb-4 sm:px-6">
                <InsightRow label="DEX Share" value={formatPercent(dexVolumeSharePct)} detail={formatUsd(dexVolumeValue)} />
                <InsightRow label="RWA Share" value={formatPercent(rwaVolumeSharePct)} detail={formatUsd(rwaVolumeValue)} />
                <InsightRow label="Outlier Density" value={formatPercent(outlierPoolSharePct, 2)} detail={`${formatCompact(data.outlierPoolsCount)} pools flagged`} />
              </CardContent>
            </Card>
          </section>

          <Tabs defaultValue="platform" className="mt-8">
            <TabsList className="grid w-full grid-cols-2 bg-card/70 p-1 sm:w-[420px]">
              <TabsTrigger value="platform">Platform Analytics</TabsTrigger>
              <TabsTrigger value="user">User Analytics</TabsTrigger>
            </TabsList>

            <TabsContent value="platform" className="mt-4 space-y-6">
              <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="space-y-6">
                  <Card className="min-w-0 overflow-hidden border-border/50 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] shadow-lg shadow-black/5">
                    <CardHeader>
                      <CardTitle className="text-lg">30D Volume & Fee Pulse</CardTitle>
                      <CardDescription>
                        Daily movement of total volume, V2/V3/RWA split, and fee generation.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="min-w-0 space-y-4 px-3 pb-4 sm:px-6">
                      {volumeSeries.length ? (
                        <>
                          <ChartContainer config={protocolChartConfig} className="h-[220px] w-full sm:h-[320px]">
                            <AreaChart
                              data={volumeSeries}
                              margin={{ left: 0, right: 8, top: 8 }}
                              onClick={(state) => {
                                const rawDay = state?.activePayload?.[0]?.payload?.rawDay;
                                if (typeof rawDay === "number") setSelectedVolumeDay(rawDay);
                              }}
                            >
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
                              <Area type="monotone" dataKey="total" stroke="var(--color-total)" fill="var(--color-total)" fillOpacity={0.15} strokeWidth={2.2} activeDot={{ r: 4 }} />
                              <Area type="monotone" dataKey="fees" stroke="var(--color-fees)" fill="var(--color-fees)" fillOpacity={0.08} strokeWidth={1.8} activeDot={{ r: 4 }} />
                              <Area type="monotone" dataKey="rwaFees" stroke="var(--color-rwaFees)" fill="none" strokeWidth={1.6} strokeDasharray="4 4" activeDot={{ r: 4 }} />
                              <Area type="monotone" dataKey="v2" stroke="var(--color-v2)" fill="none" strokeWidth={1.4} activeDot={{ r: 4 }} />
                              <Area type="monotone" dataKey="v3" stroke="var(--color-v3)" fill="none" strokeWidth={1.4} activeDot={{ r: 4 }} />
                              <Area type="monotone" dataKey="rwa" stroke="var(--color-rwa)" fill="none" strokeWidth={1.4} activeDot={{ r: 4 }} />
                            </AreaChart>
                          </ChartContainer>

                          {selectedVolumePoint ? (
                            <div className="rounded-xl border border-border/60 bg-background/55 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Selected Day Snapshot</p>
                                  <p className="mt-1 text-sm font-semibold text-foreground">
                                    {new Date(selectedVolumePoint.rawDay * 86400 * 1000).toLocaleDateString(undefined, {
                                      weekday: "short",
                                      year: "numeric",
                                      month: "short",
                                      day: "numeric",
                                    })}
                                  </p>
                                </div>
                                <Badge variant="outline" className="bg-background/70">Click chart points to update</Badge>
                              </div>
                              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                {[
                                  { key: "total", label: protocolChartConfig.total.label, value: selectedVolumePoint.total, color: "var(--color-total)" },
                                  { key: "fees", label: protocolChartConfig.fees.label, value: selectedVolumePoint.fees, color: "var(--color-fees)" },
                                  { key: "rwaFees", label: protocolChartConfig.rwaFees.label, value: selectedVolumePoint.rwaFees, color: "var(--color-rwaFees)" },
                                  { key: "rwa", label: protocolChartConfig.rwa.label, value: selectedVolumePoint.rwa, color: "var(--color-rwa)" },
                                  { key: "v2", label: protocolChartConfig.v2.label, value: selectedVolumePoint.v2, color: "var(--color-v2)" },
                                  { key: "v3", label: protocolChartConfig.v3.label, value: selectedVolumePoint.v3, color: "var(--color-v3)" },
                                ].map((row) => (
                                  <div key={row.key} className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
                                    <div className="mb-1 flex items-center gap-2">
                                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
                                      <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{row.label}</span>
                                    </div>
                                    <div className="font-mono text-sm font-semibold text-foreground">{formatUsd(row.value)}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <EmptyState text="No historical protocol day data indexed yet." />
                      )}
                    </CardContent>
                  </Card>

                  <Card className="min-w-0 overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                    <CardHeader>
                      <CardTitle className="text-lg">Top RWA Pairs</CardTitle>
                      <CardDescription>Buy/redeem flow and reserve health by pair.</CardDescription>
                    </CardHeader>
                    <CardContent className="min-w-0 px-3 pb-4 sm:px-6">
                      {data.topRwaPairs.length ? (
                        <ChartContainer config={rwaPairsChartConfig} className="h-[230px] w-full sm:h-[300px]">
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
                                  formatter={(value, name) => {
                                    const key = String(name ?? "") as keyof typeof rwaPairsChartConfig;
                                    const label = rwaPairsChartConfig[key]?.label ?? key;
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
                            <ChartLegend content={<ChartLegendContent />} />
                            <Bar dataKey="volume" fill="var(--color-volume)" radius={[6, 6, 0, 0]} />
                            <Bar dataKey="reserve" fill="var(--color-reserve)" radius={[6, 6, 0, 0]} />
                          </BarChart>
                        </ChartContainer>
                      ) : (
                        <EmptyState text="No RWA pair activity found yet." />
                      )}
                    </CardContent>
                  </Card>
                </div>

                <Card className="min-w-0 max-w-[680px] overflow-hidden border-border/50 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] shadow-lg shadow-black/5">
                  <CardHeader>
                    <CardTitle className="text-lg">Volume Composition</CardTitle>
                    <CardDescription>Share of cumulative volume by execution stack.</CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 px-3 pb-4 sm:px-6">
                    {compositionSeries.length ? (
                      <div className="grid gap-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] sm:items-center">
                        <ChartContainer config={compositionChartConfig} className="h-[185px] w-full sm:h-[240px]">
                          <PieChart margin={{ left: 14, right: 14, top: 8, bottom: 8 }}>
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
                                        <span className="font-mono font-medium text-foreground">{formatUsd(Number(value))}</span>
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
                              innerRadius={48}
                              outerRadius={78}
                              stroke="none"
                            >
                              {compositionSeries.map((entry) => (
                                <Cell key={entry.key} fill={`var(--color-${entry.key})`} />
                              ))}
                            </Pie>
                          </PieChart>
                        </ChartContainer>

                        <div className="grid gap-2">
                          {compositionLegendRows.map((row) => (
                            <div key={row.key} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                                <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">{row.label}</span>
                              </div>
                              <div className="text-right">
                                <p className="font-mono text-sm font-semibold text-foreground">{formatUsd(row.value)}</p>
                                <p className="text-[11px] text-muted-foreground">{row.share.toFixed(1)}%</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <EmptyState text="No protocol composition data available." />
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-6 xl:grid-cols-2">
                <Card className="overflow-hidden border-border/50 bg-[linear-gradient(135deg,rgba(14,165,233,0.14),rgba(2,6,23,0.82))] shadow-lg shadow-black/10">
                  <CardHeader>
                    <CardTitle className="text-lg text-white">Pool Spotlight</CardTitle>
                    <CardDescription>Immediate read on the deepest and busiest pool right now.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 px-3 pb-4 sm:px-6 sm:grid-cols-2">
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Deepest Pool</p>
                      <p className="mt-2 text-xl font-bold text-white">
                        {topPoolByTvl ? `${topPoolByTvl.token0.symbol}/${topPoolByTvl.token1.symbol}` : "--"}
                      </p>
                      <div className="mt-3 space-y-2">
                        <InsightRow label="TVL" value={topPoolByTvl ? formatUsd(parseNum(topPoolByTvl.tvlUsd)) : "--"} />
                        <InsightRow label="Volume" value={topPoolByTvl ? formatUsd(parseNum(topPoolByTvl.volumeUsd)) : "--"} />
                        <InsightRow label="Fee Tier" value={topPoolByTvl?.version === "V3" ? `${parseNum(topPoolByTvl.feeTier) / 10000}%` : "V2 Standard"} />
                      </div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Highest Turnover</p>
                      <p className="mt-2 text-xl font-bold text-white">
                        {topPoolByVolume ? `${topPoolByVolume.token0.symbol}/${topPoolByVolume.token1.symbol}` : "--"}
                      </p>
                      <div className="mt-3 space-y-2">
                        <InsightRow label="Volume" value={topPoolByVolume ? formatUsd(parseNum(topPoolByVolume.volumeUsd)) : "--"} />
                        <InsightRow label="Unique Swappers" value={topPoolByVolume ? formatCompact(parseNum(topPoolByVolume.uniqueSwapperCount)) : "--"} />
                        <InsightRow label="Outlier Flag" value={topPoolByVolume?.flaggedLowLiquidityOutlier ? "Flagged" : "Clean"} detail="Low-liquidity abnormal-flow heuristic" />
                      </div>
                    </div>
                  </CardContent>
                </Card>

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
              {targetUser ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <StatTile
                      title="Effective Total"
                      value={formatUsd(parseNum(targetUser.totalEffectiveVolumeUsd))}
                      subValue="De-duplicated across multi-hop tx routes"
                      icon={<ArrowUpRight className="h-4 w-4" />}
                      tone="good"
                    />
                    <StatTile
                      title="Raw Total"
                      value={formatUsd(parseNum(targetUser.totalVolumeUsd))}
                      subValue="Includes all indexed swap-hop events"
                      icon={<ArrowDownRight className="h-4 w-4" />}
                    />
                    <StatTile
                      title="Swaps"
                      value={formatCompact(parseNum(targetUser.swapCount))}
                      subValue={`Tx tracked ${formatCompact(parseNum(targetUser.txCount))}`}
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
                      value={formatUsd(parseNum(targetUser.totalFeesPaidUsd))}
                      subValue={`RWA ${formatUsd(parseNum(targetUser.rwaFeesPaidUsd))}`}
                      icon={<Flame className="h-4 w-4" />}
                    />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-3">
                    <Card className="overflow-hidden border-border/50 bg-[linear-gradient(135deg,rgba(34,197,94,0.12),rgba(2,6,23,0.84))] shadow-lg shadow-black/10">
                      <CardHeader>
                        <CardTitle className="text-lg text-white">Wallet Quality</CardTitle>
                        <CardDescription>How much raw routed flow survives effective accounting.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2 px-3 pb-4 sm:px-6">
                        <InsightRow label="Effective / Raw DEX" value={formatPercent(targetUserEffectiveRatioPct, 1)} detail={`${formatUsd(parseNum(targetUser.dexEffectiveVolumeUsd))} on ${formatUsd(targetUserRawDexVolume)}`} />
                        <InsightRow label="Avg Effective Swap" value={formatUsd(targetUserAverageSwapSize)} detail={`${formatCompact(parseNum(targetUser.swapCount))} swaps indexed`} />
                        <InsightRow label="Avg Fee / Swap" value={formatUsd(targetUserAverageFeePerSwap)} detail="Across DEX plus RWA fees paid" />
                      </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                      <CardHeader>
                        <CardTitle className="text-lg">Wallet Allocation</CardTitle>
                        <CardDescription>Capital usage split between trading and liquidity movement.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2 px-3 pb-4 sm:px-6">
                        <InsightRow label="RWA Volume" value={formatUsd(parseNum(targetUser.rwaVolumeUsd))} detail={`${formatCompact(parseNum(targetUser.rwaBuyCount) + parseNum(targetUser.rwaRedeemCount))} trades`} />
                        <InsightRow label="Liquidity Added" value={formatUsd(parseNum(targetUser.liquidityProvidedUsd))} />
                        <InsightRow label="Net Liquidity" value={formatUsd(targetUserNetLiquidity)} detail={targetUserNetLiquidity >= 0 ? "Net provider" : "Net remover"} />
                      </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-border/50 bg-card/70 shadow-lg shadow-black/5">
                      <CardHeader>
                        <CardTitle className="text-lg">Wallet Lifecycle</CardTitle>
                        <CardDescription>Recency and ranking context for this address.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2 px-3 pb-4 sm:px-6">
                        <InsightRow label="Leaderboard Rank" value={data.targetUserRank ? `#${formatCompact(data.targetUserRank)}` : "Unranked"} />
                        <InsightRow label="First Seen" value={formatDate(parseNum(targetUser.firstSeenTimestamp))} />
                        <InsightRow label="Last Seen" value={formatDate(parseNum(targetUser.lastSeenTimestamp))} />
                      </CardContent>
                    </Card>
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
                            <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                              {userVolumeBars.map((entry, index) => (
                                <Cell key={`${entry.key}-${index}`} fill={userVolumeColorMap[entry.key]} />
                              ))}
                            </Bar>
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
                          <span className="font-semibold text-foreground">{shortenAddress(targetUser.id)}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Wallet Rank</span>
                          <span className="font-semibold text-foreground">
                            {data.targetUserRank ? `#${formatCompact(data.targetUserRank)}` : "Unranked"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Liquidity Provided</span>
                          <span className="font-semibold">{formatUsd(parseNum(targetUser.liquidityProvidedUsd))}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Liquidity Removed</span>
                          <span className="font-semibold">{formatUsd(parseNum(targetUser.liquidityRemovedUsd))}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">RWA Trades</span>
                          <span className="font-semibold">{formatCompact(parseNum(targetUser.rwaBuyCount) + parseNum(targetUser.rwaRedeemCount))}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">First Seen</span>
                          <span className="font-semibold">{formatDate(parseNum(targetUser.firstSeenTimestamp))}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                          <span className="text-muted-foreground">Last Seen</span>
                          <span className="font-semibold">{formatDate(parseNum(targetUser.lastSeenTimestamp))}</span>
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
