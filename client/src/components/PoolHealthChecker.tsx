import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Contract, BrowserProvider } from "ethers";
import { getContractsForChain } from "@/lib/contracts";
import { NONFUNGIBLE_POSITION_MANAGER_ABI } from "@/lib/abis/v3";
import { priceToSqrtPriceX96, sortTokens } from "@/lib/v3-utils";
import { isNativeToken, getWrappedAddress } from "@/data/tokens";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import {
  CheckCircle2,
  XCircle,
  Wrench,
  RefreshCw,
  ExternalLink,
  Zap,
  TriangleAlert,
} from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TICK = 887272;
// Flag ticks beyond 50% of max as extreme – catches broken 10% fee pools too
const TICK_EXTREME_THRESHOLD = Math.floor(MAX_TICK * 0.5); // 443,636
// Flag price mismatch when pool vs expected differs by more than 50×
const PRICE_MISMATCH_FACTOR = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PoolIssueKind =
  | "HEALTHY"
  | "POOL_NOT_EXIST"
  | "UNINITIALIZED"
  | "PRICE_EXTREME"
  | "PRICE_MISMATCH"
  | "NO_ACTIVE_LIQUIDITY";

export interface PoolHealthResult {
  issue: PoolIssueKind;
  severity: "ok" | "warn" | "error";
  description: string;
  suggestedFix: string | null;
  canAutoFix: boolean;
}

// ─── Props ────────────────────────────────────────────────────────────────────
// The parent already fetches all pool state – we accept it here to avoid
// duplicate lookups and the address-resolution bugs that came with them.

interface PoolHealthCheckerProps {
  poolAddress: string | null;
  poolExists: boolean;
  sqrtPriceX96: bigint | null;
  currentTick: number | null;
  currentPrice: number | null;
  activeLiquidity: bigint | null;
  token0Symbol: string;
  token1Symbol: string;
  // User-entered price ratio (token1/token0, sorted order) for mismatch detection
  expectedPriceRatio?: number | null;
  // Needed only for the Initialize Pool fix button
  tokenA: Token | null;
  tokenB: Token | null;
  fee: number;
  chainId: number;
  onHealthChange?: (result: PoolHealthResult) => void;
  /** Called after a successful on-chain fix so the parent can re-fetch */
  onFixed?: () => void;
}

// ─── Pure diagnosis function ──────────────────────────────────────────────────

function diagnose(
  poolExists: boolean,
  sqrtPriceX96: bigint | null,
  currentTick: number | null,
  currentPrice: number | null,
  activeLiquidity: bigint | null,
  token0Symbol: string,
  token1Symbol: string,
  expectedPriceRatio?: number | null
): PoolHealthResult {

  if (!poolExists) {
    return {
      issue: "POOL_NOT_EXIST",
      severity: "ok",
      description: "No pool exists yet for this pair and fee tier. It will be created when you add liquidity.",
      suggestedFix: null,
      canAutoFix: false,
    };
  }

  // Can't read state (RPC error or truly broken contract)
  if (sqrtPriceX96 === null || currentTick === null) {
    return {
      issue: "UNINITIALIZED",
      severity: "error",
      description: "Pool contract exists but its state could not be read. It may be uninitialized or the RPC failed.",
      suggestedFix: "Try refreshing. If the issue persists the pool may need to be re-initialized.",
      canAutoFix: false,
    };
  }

  // sqrtPriceX96 === 0 → contract deployed but initialize() never called
  if (sqrtPriceX96 === 0n) {
    return {
      issue: "UNINITIALIZED",
      severity: "error",
      description:
        "The pool contract exists but was never initialized (sqrtPriceX96 = 0). " +
        "Neither liquidity additions nor swaps are possible until it is initialized.",
      suggestedFix:
        "Enter your desired token amounts above, then click Initialize Pool. " +
        "The initial price will be derived from your entered amounts.",
      canAutoFix: true,
    };
  }

  // Tick near absolute limits → price is effectively at 0 or ∞
  if (Math.abs(currentTick) >= TICK_EXTREME_THRESHOLD) {
    const direction =
      currentTick > 0
        ? `${token0Symbol} is massively undervalued vs ${token1Symbol}`
        : `${token1Symbol} is massively undervalued vs ${token0Symbol}`;
    return {
      issue: "PRICE_EXTREME",
      severity: "error",
      description:
        `Pool tick is ${currentTick.toLocaleString()} (absolute limit: ±${MAX_TICK.toLocaleString()}). ` +
        `${direction}. This usually means the pool was initialized with a wildly wrong price. ` +
        "You cannot add liquidity or swap until the price is corrected.",
      suggestedFix:
        activeLiquidity === 0n
          ? "1) Add a tiny full-range position (0.001 of each token, Basic Mode). " +
            "2) Swap from the overvalued token to the undervalued one until price nears market rate. " +
            "3) Remove the bootstrap position. 4) Add your real amounts."
          : "Use the Swap tab: swap from the overvalued token into the undervalued one repeatedly " +
            "until the pool price reaches the correct market rate.",
      canAutoFix: false,
    };
  }

  // Price mismatch – pool price vs user ratio differ significantly
  if (expectedPriceRatio != null && expectedPriceRatio > 0 && currentPrice != null && currentPrice > 0) {
    const ratio = currentPrice / expectedPriceRatio;
    const deviation = Math.max(ratio, 1 / ratio);
    if (deviation > PRICE_MISMATCH_FACTOR) {
      return {
        issue: "PRICE_MISMATCH",
        severity: "warn",
        description:
          `Pool price (${currentPrice.toExponential(3)} ${token1Symbol}/${token0Symbol}) ` +
          `is ${Math.round(deviation)}× different from your entered ratio ` +
          `(${expectedPriceRatio.toExponential(3)}). ` +
          "You will likely provide all liquidity as one token at a very unfavourable rate.",
        suggestedFix:
          "Double-check your token amounts. If the pool price itself is wrong, " +
          "a corrective swap is needed before adding liquidity.",
        canAutoFix: false,
      };
    }
  }

  // Initialized but no active liquidity at current tick
  if (activeLiquidity === 0n) {
    return {
      issue: "NO_ACTIVE_LIQUIDITY",
      severity: "warn",
      description:
        `Pool is initialized at tick ${currentTick.toLocaleString()} but has zero active liquidity here. ` +
        "Swaps will fail until someone adds a position covering this tick.",
      suggestedFix: "You can still add liquidity – Basic Mode automatically covers the current tick.",
      canAutoFix: false,
    };
  }

  return {
    issue: "HEALTHY",
    severity: "ok",
    description:
      currentPrice != null
        ? `Pool healthy. Price: ${currentPrice.toFixed(6)} ${token1Symbol} per ${token0Symbol}.`
        : "Pool is healthy.",
    suggestedFix: null,
    canAutoFix: false,
  };
}

// ─── Style helpers ────────────────────────────────────────────────────────────

function severityColor(s: PoolHealthResult["severity"]) {
  if (s === "ok")   return "text-green-400";
  if (s === "warn") return "text-yellow-400";
  return "text-red-400";
}

function severityBg(s: PoolHealthResult["severity"]) {
  if (s === "ok")   return "bg-green-500/10 border-green-500/20";
  if (s === "warn") return "bg-yellow-500/10 border-yellow-500/20";
  return "bg-red-500/10 border-red-500/20";
}

function SeverityIcon({ s }: { s: PoolHealthResult["severity"] }) {
  if (s === "ok")   return <CheckCircle2 className="h-5 w-5 text-green-400 shrink-0 mt-0.5" />;
  if (s === "warn") return <TriangleAlert className="h-5 w-5 text-yellow-400 shrink-0 mt-0.5" />;
  return <XCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />;
}

function issueLabel(issue: PoolIssueKind) {
  switch (issue) {
    case "POOL_NOT_EXIST":      return "Pool will be created";
    case "UNINITIALIZED":       return "⚠ Pool Not Initialized";
    case "PRICE_EXTREME":       return "🚨 Pool Price is Broken";
    case "PRICE_MISMATCH":      return "⚠ Pool Price Mismatch";
    case "NO_ACTIVE_LIQUIDITY": return "ℹ No Active Liquidity";
    default:                    return "✓ Pool Healthy";
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PoolHealthChecker({
  poolAddress,
  poolExists,
  sqrtPriceX96,
  currentTick,
  currentPrice,
  activeLiquidity,
  token0Symbol,
  token1Symbol,
  expectedPriceRatio,
  tokenA,
  tokenB,
  fee,
  chainId,
  onHealthChange,
  onFixed,
}: PoolHealthCheckerProps) {
  const [isFixing, setIsFixing] = useState(false);
  const { toast } = useToast();

  const health = diagnose(
    poolExists,
    sqrtPriceX96,
    currentTick,
    currentPrice,
    activeLiquidity,
    token0Symbol,
    token1Symbol,
    expectedPriceRatio
  );

  useEffect(() => {
    onHealthChange?.(health);
  // Intentionally depend on primitive fields to avoid infinite loops
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health.issue, health.severity]);

  // ── Initialize broken / uninitialized pool ────────────────────────────────
  const handleInitialize = async () => {
    if (!tokenA || !tokenB || !window.ethereum) return;
    if (!expectedPriceRatio || expectedPriceRatio <= 0) {
      toast({
        title: "Enter token amounts first",
        description: "Fill in both amounts above so we can derive the initial price.",
        variant: "destructive",
      });
      return;
    }

    setIsFixing(true);
    try {
      const contracts = getContractsForChain(chainId);
      if (!contracts) throw new Error("No contracts for this chain");

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const getERC20 = (t: Token) => {
        if (isNativeToken(t.address)) return getWrappedAddress(chainId, t.address) ?? t.address;
        return t.address;
      };

      const [tok0, tok1] = sortTokens(
        { ...tokenA, address: getERC20(tokenA) },
        { ...tokenB, address: getERC20(tokenB) }
      );

      const sqrtP = priceToSqrtPriceX96(expectedPriceRatio, tok0.decimals, tok1.decimals);

      const posManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer
      );

      toast({ title: "Initializing pool…", description: "Sending initialization transaction" });
      const tx = await posManager.createAndInitializePoolIfNecessary(
        tok0.address, tok1.address, fee, sqrtP
      );
      const receipt = await tx.wait();

      toast({
        title: "Pool initialized!",
        description: (
          <div className="flex items-center gap-2">
            <span>Pool is ready – you can now add liquidity.</span>
            <a
              href={`${contracts.explorer}${receipt.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline text-xs"
            >
              <ExternalLink className="h-3 w-3" /> Tx
            </a>
          </div>
        ),
      });

      onFixed?.();
    } catch (err: any) {
      console.error("Initialize failed:", err);
      toast({
        title: "Initialization failed",
        description: err.reason ?? err.message ?? "Transaction failed",
        variant: "destructive",
      });
    } finally {
      setIsFixing(false);
    }
  };

  const handleShowExtremeGuide = () => {
    toast({
      title: "How to fix a broken pool price",
      description: (
        <div className="space-y-1.5 text-xs leading-relaxed">
          <p><strong>Step 1:</strong> Add a tiny full-range position (0.001 of each token) in Basic Mode – this gives the pool some liquidity to work with.</p>
          <p><strong>Step 2:</strong> Go to the Swap tab and swap the overvalued token for the undervalued one. Repeat until price is near market rate.</p>
          <p><strong>Step 3:</strong> Remove the bootstrap position from Remove Liquidity tab.</p>
          <p><strong>Step 4:</strong> Add your real liquidity normally.</p>
        </div>
      ),
      duration: 20000,
    });
  };

  // ── Compact OK banner ─────────────────────────────────────────────────────
  if (health.severity === "ok") {
    return (
      <div className={`flex items-center gap-2 p-3 rounded-lg border text-sm ${severityBg("ok")}`}>
        <SeverityIcon s="ok" />
        <span className="text-slate-300">{health.description}</span>
      </div>
    );
  }

  // ── Full diagnostic card ──────────────────────────────────────────────────
  return (
    <div className={`rounded-lg border p-4 space-y-3 ${severityBg(health.severity)}`}>
      <div className="flex items-start gap-3">
        <SeverityIcon s={health.severity} />
        <div className="flex-1 min-w-0">
          <div className={`font-semibold text-sm ${severityColor(health.severity)}`}>
            {issueLabel(health.issue)}
          </div>
          <p className="text-xs text-slate-300 mt-1 leading-relaxed">
            {health.description}
          </p>
        </div>
      </div>

      {/* Debug grid for error states */}
      {health.severity === "error" && (
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          {currentTick !== null && (
            <div className="bg-slate-900/50 rounded p-1.5">
              <div className="text-slate-500">Current tick</div>
              <div className={Math.abs(currentTick) >= TICK_EXTREME_THRESHOLD ? "text-red-400" : "text-slate-200"}>
                {currentTick.toLocaleString()}
              </div>
            </div>
          )}
          {sqrtPriceX96 !== null && (
            <div className="bg-slate-900/50 rounded p-1.5">
              <div className="text-slate-500">sqrtPriceX96</div>
              <div className={sqrtPriceX96 === 0n ? "text-red-400" : "text-slate-200"}>
                {sqrtPriceX96 === 0n
                  ? "0 ← uninitialized"
                  : `${sqrtPriceX96.toString().slice(0, 8)}… (${sqrtPriceX96.toString().length}d)`}
              </div>
            </div>
          )}
          {activeLiquidity !== null && (
            <div className="bg-slate-900/50 rounded p-1.5">
              <div className="text-slate-500">Active liquidity</div>
              <div className={activeLiquidity === 0n ? "text-yellow-400" : "text-slate-200"}>
                {activeLiquidity === 0n ? "0 (none)" : activeLiquidity.toString().slice(0, 10) + "…"}
              </div>
            </div>
          )}
          {poolAddress && (
            <div className="bg-slate-900/50 rounded p-1.5">
              <div className="text-slate-500">Pool</div>
              <div className="text-slate-200">{poolAddress.slice(0, 6)}…{poolAddress.slice(-4)}</div>
            </div>
          )}
        </div>
      )}

      {/* Suggested fix */}
      {health.suggestedFix && (
        <div className="flex items-start gap-2 text-xs text-slate-400 bg-slate-900/60 rounded p-2">
          <Wrench className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-500" />
          <span>{health.suggestedFix}</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        {health.issue === "UNINITIALIZED" && (
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            disabled={isFixing || !expectedPriceRatio}
            onClick={handleInitialize}
          >
            {isFixing
              ? <><RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />Initializing…</>
              : <><Zap className="h-3.5 w-3.5 mr-1.5" />Initialize Pool</>
            }
          </Button>
        )}

        {health.issue === "PRICE_EXTREME" && (
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/50 text-red-400 hover:bg-red-500/10"
            onClick={handleShowExtremeGuide}
          >
            <Wrench className="h-3.5 w-3.5 mr-1.5" />Show Fix Steps
          </Button>
        )}

        {poolAddress && (
          <a
            href={`https://testnet.arcscan.app/address/${poolAddress}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button size="sm" variant="ghost" className="text-slate-400">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />View Pool
            </Button>
          </a>
        )}
      </div>

      {health.issue === "UNINITIALIZED" && !expectedPriceRatio && (
        <p className="text-xs text-yellow-400/80">
          ↑ Enter amounts in both token fields above to enable the Initialize button.
        </p>
      )}
    </div>
  );
}
