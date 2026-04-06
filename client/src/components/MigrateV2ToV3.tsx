import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider } from "ethers";
import { fetchTokensWithCommunity, getTokensByChainId, getUnwrappedAddress } from "@/data/tokens";
import { formatAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getErrorForToast } from "@/lib/error-utils";
import { createAlchemyProvider } from "@/lib/config";
import { discoverV2PositionsFromExplorer, explorerApiBaseFromTxUrl } from "@/lib/v2-position-discovery";
import { V3_MIGRATOR_ABI, V3_FACTORY_ABI, V3_POOL_ABI, V3_FEE_TIERS, FEE_TIER_LABELS } from "@/lib/abis/v3";
import { sqrtPriceX96ToPrice, getPriceFromAmounts, getFullRangeTicks } from "@/lib/v3-utils";
import {
  ArrowDown,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Wallet,
  Zap,
  TrendingUp,
} from "lucide-react";

const MIGRATOR_EXTRA_ABI = [
  "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
];

const V2_PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

const MIGRATION_SLIPPAGE_BPS = 100n; // 1%
const MIGRATION_SLIPPAGE_BPS_RETRY = 300n; // 3% fallback for volatile pools
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

function getDisplaySymbol(symbol: string): string {
  return symbol.toLowerCase() === "wusdc" ? "USDC" : symbol;
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) < 0.000001) return value.toExponential(4);
  return value.toFixed(6);
}

function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("Cannot sqrt negative bigint");
  if (value < 2n) return value;

  let x0 = value;
  let x1 = (x0 + 1n) >> 1n;

  while (x1 < x0) {
    x0 = x1;
    x1 = (x1 + value / x1) >> 1n;
  }

  return x0;
}

function sqrtPriceX96FromV2Reserves(reserve0: bigint, reserve1: bigint): bigint {
  if (reserve0 <= 0n || reserve1 <= 0n) {
    throw new Error("Invalid V2 reserves for pool initialization");
  }

  const ratioX192 = (reserve1 << 192n) / reserve0;
  const sqrtPrice = bigintSqrt(ratioX192);
  if (sqrtPrice < MIN_SQRT_RATIO) return MIN_SQRT_RATIO;
  if (sqrtPrice > MAX_SQRT_RATIO) return MAX_SQRT_RATIO;
  return sqrtPrice;
}

function applySlippageMin(amount: bigint, bps: bigint = MIGRATION_SLIPPAGE_BPS): bigint {
  if (amount <= 0n) return 0n;
  return (amount * (10_000n - bps)) / 10_000n;
}

function isPriceSlippageCheckError(error: unknown): boolean {
  if (!error) return false;

  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error);

  const reason = typeof error === "object" && error !== null && "reason" in error
    ? String((error as { reason?: unknown }).reason ?? "")
    : "";

  return message.includes("Price slippage check") || reason.includes("Price slippage check");
}

interface V2Position {
  pairAddress: string;
  token0: Token;
  token1: Token;
  lpBalance: bigint;
  totalSupply: bigint;
  reserve0: bigint;
  reserve1: bigint;
  sharePercent: number;
}

interface V3PoolInfo {
  exists: boolean;
  address: string | null;
  currentPrice: number | null;
  currentTick: number | null;
  sqrtPriceX96: bigint | null;
}

// ─── Fee option config ────────────────────────────────────────────────────────
const FEE_OPTIONS = [
  { value: V3_FEE_TIERS.LOWEST,    label: "0.01%", desc: "Very stable" },
  { value: V3_FEE_TIERS.LOW,       label: "0.05%", desc: "Stable"      },
  { value: V3_FEE_TIERS.MEDIUM,    label: "0.3%",  desc: "Most pairs"  },
  { value: V3_FEE_TIERS.HIGH,      label: "1%",    desc: "Exotic"      },
  { value: V3_FEE_TIERS.ULTRA_HIGH,label: "10%",   desc: "Very exotic" },
];

export function MigrateV2ToV3() {
  const [positions, setPositions] = useState<V2Position[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<V2Position | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [selectedFee, setSelectedFee] = useState<number>(V3_FEE_TIERS.MEDIUM);
  const [percentToMigrate, setPercentToMigrate] = useState(100);
  const [migratorExists, setMigratorExists] = useState<boolean | null>(null);
  const [v3PoolInfo, setV3PoolInfo] = useState<V3PoolInfo | null>(null);
  const [isCheckingPool, setIsCheckingPool] = useState(false);
  const [priceWarningConfirmed, setPriceWarningConfirmed] = useState(false);
  const [zeroMinConfirmed, setZeroMinConfirmed] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;

  useEffect(() => {
    if (!chainId) {
      setTokens([]);
      return;
    }

    let cancelled = false;
    const loadTokens = async () => {
      try {
        const chainTokens = await fetchTokensWithCommunity(chainId);

        const importedKey = `importedTokens:${chainId}`;
        let importedTokens: Token[] = [];
        try {
          const raw = localStorage.getItem(importedKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            importedTokens = Array.isArray(parsed) ? parsed : [];
          }
        } catch {
          importedTokens = [];
        }

        const deduped = new Map<string, Token>();
        for (const token of [...chainTokens, ...importedTokens]) {
          deduped.set(token.address.toLowerCase(), token);
        }

        if (!cancelled) {
          setTokens(Array.from(deduped.values()));
        }
      } catch {
        if (!cancelled) {
          setTokens(getTokensByChainId(chainId));
        }
      }
    };

    loadTokens();
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  const getDisplayTokenMeta = useCallback((token: Token) => {
    const fallbackLogo = token.logoURI || "/img/logos/unknown-token.png";
    if (!chainId) {
      return {
        symbol: getDisplaySymbol(token.symbol),
        logoURI: fallbackLogo,
      };
    }

    const unwrappedAddress = getUnwrappedAddress(chainId, token.address);
    if (unwrappedAddress) {
      const unwrappedToken = tokens.find(
        (t) => t.address.toLowerCase() === unwrappedAddress.toLowerCase(),
      );
      if (unwrappedToken) {
        return {
          symbol: getDisplaySymbol(unwrappedToken.symbol),
          logoURI: unwrappedToken.logoURI || fallbackLogo,
        };
      }
    }

    return {
      symbol: getDisplaySymbol(token.symbol),
      logoURI: fallbackLogo,
    };
  }, [chainId, tokens]);

  // ── Check migrator ──────────────────────────────────────────────────────────
  useEffect(() => {
    const checkMigrator = async () => {
      if (!contracts || !chainId) return;
      try {
        const provider = createAlchemyProvider(chainId);
        const code = await provider.getCode(contracts.v3.migrator);
        setMigratorExists(code !== "0x" && code !== "0x0");
      } catch { setMigratorExists(false); }
    };
    checkMigrator();
  }, [contracts, chainId]);

  // ── Check V3 pool ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const checkV3Pool = async () => {
      if (!selectedPosition || !contracts || !chainId) { setV3PoolInfo(null); return; }
      setIsCheckingPool(true);
      setV3PoolInfo(null);
      try {
        const provider = createAlchemyProvider(chainId);
        const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
        const poolAddress = await factory.getPool(
          selectedPosition.token0.address,
          selectedPosition.token1.address,
          selectedFee,
        );
        if (cancelled) return;
        if (poolAddress && poolAddress !== "0x0000000000000000000000000000000000000000") {
          const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
          const slot0 = await pool.slot0();
          if (cancelled) return;
          const sqrtPriceX96 = slot0[0];
          const tick = Number(slot0[1]);
          if (sqrtPriceX96 === 0n) {
            setV3PoolInfo({ exists: false, address: null, currentPrice: null, currentTick: null, sqrtPriceX96: null });
            return;
          }
          const currentPrice = sqrtPriceX96ToPrice(sqrtPriceX96, selectedPosition.token0.decimals, selectedPosition.token1.decimals);
          setV3PoolInfo({ exists: true, address: poolAddress, currentPrice, currentTick: tick, sqrtPriceX96 });
        } else {
          setV3PoolInfo({ exists: false, address: null, currentPrice: null, currentTick: null, sqrtPriceX96: null });
        }
      } catch (error) {
        console.error("Error checking V3 pool:", error);
        if (cancelled) return;
        setV3PoolInfo({ exists: false, address: null, currentPrice: null, currentTick: null, sqrtPriceX96: null });
      } finally {
        if (!cancelled) {
          setIsCheckingPool(false);
        }
      }
    };

    checkV3Pool();
    setPriceWarningConfirmed(false);
    setZeroMinConfirmed(false);
    return () => {
      cancelled = true;
    };
  }, [selectedPosition, selectedFee, contracts, chainId]);

  const getV2Price = (): number | null => {
    if (!selectedPosition) return null;
    return getPriceFromAmounts(selectedPosition.reserve0, selectedPosition.reserve1, selectedPosition.token0.decimals, selectedPosition.token1.decimals);
  };

  const getPriceDifference = () => {
    const v2Price = getV2Price();
    if (!v2Price || !v3PoolInfo?.currentPrice) return null;
    const diff = Math.abs((v3PoolInfo.currentPrice - v2Price) / v2Price) * 100;
    return { diff, v2Price, v3Price: v3PoolInfo.currentPrice };
  };

  const priceDiff = getPriceDifference();
  const showPriceWarning = Boolean(v3PoolInfo?.exists && priceDiff && priceDiff.diff > 2 && !priceWarningConfirmed);
  const showZeroMinWarning = Boolean(v3PoolInfo && !v3PoolInfo.exists && !zeroMinConfirmed);

  // ── Load V2 positions ───────────────────────────────────────────────────────
  const loadPositions = useCallback(async () => {
    if (!address || !contracts || !chainId) return;
    setIsLoading(true);
    try {
      const provider = createAlchemyProvider(chainId);
      const explorerApiBase = explorerApiBaseFromTxUrl(contracts.explorer);
      if (!explorerApiBase) throw new Error("Could not derive explorer API base URL");

      const discovered = await discoverV2PositionsFromExplorer({
        ownerAddress: address,
        factoryAddress: contracts.v2.factory,
        provider,
        knownTokens: tokens,
        apiBaseUrl: explorerApiBase,
        maxConcurrent: 10,
      });

      const userPositions: V2Position[] = discovered.map((pos) => {
        const token0Known = tokens.find((t) => t.address.toLowerCase() === pos.token0Address.toLowerCase());
        const token1Known = tokens.find((t) => t.address.toLowerCase() === pos.token1Address.toLowerCase());

        const token0: Token = {
          address: pos.token0Address,
          name: token0Known?.name || pos.token0Name,
          symbol: token0Known?.symbol || pos.token0Symbol,
          decimals: pos.token0Decimals,
          logoURI: token0Known?.logoURI || "/img/logos/unknown-token.png",
          verified: false,
          chainId,
        };

        const token1: Token = {
          address: pos.token1Address,
          name: token1Known?.name || pos.token1Name,
          symbol: token1Known?.symbol || pos.token1Symbol,
          decimals: pos.token1Decimals,
          logoURI: token1Known?.logoURI || "/img/logos/unknown-token.png",
          verified: false,
          chainId,
        };

        return {
          pairAddress: pos.pairAddress,
          token0,
          token1,
          lpBalance: pos.liquidity,
          totalSupply: pos.totalSupply,
          reserve0: pos.reserve0,
          reserve1: pos.reserve1,
          sharePercent: Number((pos.liquidity * 10000n) / pos.totalSupply) / 100,
        };
      });

      setPositions(userPositions);
      setSelectedPosition((current) => {
        if (!current) return null;
        const matchedPosition = userPositions.find(
          (position) =>
            position.pairAddress.toLowerCase() === current.pairAddress.toLowerCase(),
        );
        return matchedPosition ?? null;
      });
      if (userPositions.length === 0) {
        setSelectedPosition(null);
      }
      if (userPositions.length === 0) toast({ title: "No V2 positions found", description: "You don't have any V2 liquidity positions to migrate" });
    } catch (error) {
      console.error("Error loading positions:", error);
      toast({ title: "Failed to load positions", description: "Could not fetch your V2 liquidity positions from explorer API", variant: "destructive" });
    } finally { setIsLoading(false); }
  }, [address, contracts, chainId, toast, tokens]);

  useEffect(() => {
    if (isConnected && address) loadPositions();
  }, [isConnected, address, chainId, loadPositions]);

  // ── Migrate ─────────────────────────────────────────────────────────────────
  const handleMigrate = async () => {
    if (!selectedPosition || !address || !contracts || !window.ethereum || !migratorExists) return;
    if (showPriceWarning) { toast({ title: "Confirmation required", description: "Please confirm the price difference before migrating", variant: "destructive" }); return; }

    setIsMigrating(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const migrator = new Contract(contracts.v3.migrator, [...V3_MIGRATOR_ABI, ...MIGRATOR_EXTRA_ABI], signer);
      const pairContract = new Contract(selectedPosition.pairAddress, V2_PAIR_ABI, signer);
      const liquidityToMigrate = (selectedPosition.lpBalance * BigInt(percentToMigrate)) / 100n;

      if (percentToMigrate < 1 || percentToMigrate > 100) {
        throw new Error("Invalid migration percentage");
      }

      if (liquidityToMigrate <= 0n) {
        throw new Error("Selected migration percentage is too small for current LP balance");
      }

      if (percentToMigrate < 100 && liquidityToMigrate >= selectedPosition.lpBalance) {
        throw new Error("Migration amount safety check failed");
      }

      toast({ title: "Approving LP tokens…", description: "Please approve LP token spending" });
      const allowance = await pairContract.allowance(address, contracts.v3.migrator);
      if (allowance !== liquidityToMigrate) {
        try {
          const approveTx = await pairContract.approve(contracts.v3.migrator, liquidityToMigrate);
          await approveTx.wait();
        } catch (approveError) {
          if (allowance > 0n && liquidityToMigrate > 0n) {
            const resetTx = await pairContract.approve(contracts.v3.migrator, 0n);
            await resetTx.wait();
            const approveTx = await pairContract.approve(contracts.v3.migrator, liquidityToMigrate);
            await approveTx.wait();
          } else {
            throw approveError;
          }
        }
      }

      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);

      const readProvider = createAlchemyProvider(chainId);
      const latestPair = new Contract(selectedPosition.pairAddress, V2_PAIR_ABI, readProvider);
      const latestFactory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, readProvider);

      const [latestReserves, latestTotalSupply, latestPoolAddress] = await Promise.all([
        latestPair.getReserves(),
        latestPair.totalSupply(),
        latestFactory.getPool(selectedPosition.token0.address, selectedPosition.token1.address, selectedFee),
      ]);

      const reserve0Raw = latestReserves.reserve0 ?? latestReserves[0] ?? 0n;
      const reserve1Raw = latestReserves.reserve1 ?? latestReserves[1] ?? 0n;
      const latestReserve0 = typeof reserve0Raw === "bigint" ? reserve0Raw : BigInt(reserve0Raw.toString());
      const latestReserve1 = typeof reserve1Raw === "bigint" ? reserve1Raw : BigInt(reserve1Raw.toString());
      const latestSupply = typeof latestTotalSupply === "bigint" ? latestTotalSupply : BigInt(latestTotalSupply.toString());

      if (latestSupply <= 0n) {
        throw new Error("Latest V2 pool supply is zero");
      }

      const expectedAmount0 = (latestReserve0 * liquidityToMigrate) / latestSupply;
      const expectedAmount1 = (latestReserve1 * liquidityToMigrate) / latestSupply;
      const freshPoolExists = !!latestPoolAddress && latestPoolAddress !== "0x0000000000000000000000000000000000000000";

      const baseMigrateParams = {
        pair: selectedPosition.pairAddress,
        liquidityToMigrate,
        percentageToMigrate: percentToMigrate,
        token0: selectedPosition.token0.address,
        token1: selectedPosition.token1.address,
        fee: selectedFee,
        tickLower,
        tickUpper,
        recipient: address,
        deadline: Math.floor(Date.now() / 1000) + 1200,
        refundAsETH: false,
      };

      const strictParams = {
        ...baseMigrateParams,
        amount0Min: applySlippageMin(expectedAmount0),
        amount1Min: applySlippageMin(expectedAmount1),
      };

      const mediumParams = {
        ...baseMigrateParams,
        amount0Min: applySlippageMin(expectedAmount0, MIGRATION_SLIPPAGE_BPS_RETRY),
        amount1Min: applySlippageMin(expectedAmount1, MIGRATION_SLIPPAGE_BPS_RETRY),
      };

      const relaxedParams = {
        ...baseMigrateParams,
        amount0Min: 0n,
        amount1Min: 0n,
      };

      const executeMigration = async (params: typeof strictParams) => {
        if (freshPoolExists) {
          toast({ title: "Migrating…", description: "Removing V2 liquidity and adding to V3" });
          const gasEstimate = await migrator.migrate.estimateGas(params);
          const tx = await migrator.migrate(params, { gasLimit: (gasEstimate * 150n) / 100n });
          return tx.wait();
        }

        const sqrtPriceX96 = sqrtPriceX96FromV2Reserves(latestReserve0, latestReserve1);
        toast({ title: "Creating pool & migrating…", description: "Initializing V3 pool and migrating in one transaction" });
        const createData = migrator.interface.encodeFunctionData("createAndInitializePoolIfNecessary", [selectedPosition.token0.address, selectedPosition.token1.address, selectedFee, sqrtPriceX96]);
        const migrateData = migrator.interface.encodeFunctionData("migrate", [params]);
        const gasEstimate = await migrator.multicall.estimateGas([createData, migrateData]);
        const tx = await migrator.multicall([createData, migrateData], { gasLimit: (gasEstimate * 150n) / 100n });
        return tx.wait();
      };

      const allowZeroMinFallback = priceWarningConfirmed || (!freshPoolExists && zeroMinConfirmed);
      const useFlexibleFromStart = Boolean(allowZeroMinFallback);
      let receipt;
      try {
        receipt = await executeMigration(useFlexibleFromStart ? relaxedParams : strictParams);
      } catch (error) {
        if (!isPriceSlippageCheckError(error) || useFlexibleFromStart) {
          throw error;
        }

        toast({
          title: "Retrying migration",
          description: "Price moved; retrying with wider slippage window",
        });

        try {
          receipt = await executeMigration(mediumParams);
        } catch (mediumError) {
          if (!isPriceSlippageCheckError(mediumError) || !allowZeroMinFallback) {
            throw mediumError;
          }

          toast({
            title: "Retrying migration",
            description: "Final retry with flexible min amounts",
          });

          receipt = await executeMigration(relaxedParams);
        }
      }

      setSelectedPosition(null);
      setV3PoolInfo(null);
      setPriceWarningConfirmed(false);
      setZeroMinConfirmed(false);
      await loadPositions();

      toast({
        title: "Migration successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully migrated from V2 to V3</span>
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}>
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error("Migration error:", error);
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
    } finally { setIsMigrating(false); }
  };

  // ── Token amount helpers ────────────────────────────────────────────────────
  const getTokenAmount = (reserve: bigint, decimals: number) =>
    formatAmount((reserve * ((selectedPosition!.lpBalance * BigInt(percentToMigrate)) / 100n)) / selectedPosition!.totalSupply, decimals);

  // ── Not connected ───────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="w-full max-w-md mx-auto px-3 py-4 sm:px-4 sm:py-8">
        <Card className="border-border/40 bg-card/95 backdrop-blur-sm">
          <CardContent className="flex flex-col items-center justify-center py-14 px-6 gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-muted/60 flex items-center justify-center">
              <Wallet className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="font-semibold text-base">Wallet not connected</p>
            <p className="text-sm text-muted-foreground">Connect your wallet to view and migrate V2 positions</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto px-3 py-4 sm:px-4 sm:py-6 space-y-3">

      {/* ── Info banner ── */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
        style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)" }}
      >
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "rgba(99,102,241,0.15)" }}
        >
          <Zap className="w-4 h-4 text-indigo-400" />
        </div>
        <div>
          <p className="text-xs font-semibold text-indigo-300">Migrate V2 → V3</p>
          <p className="text-[11px] text-indigo-400/60 mt-0.5">Better capital efficiency with concentrated liquidity</p>
        </div>

        {/* Migrator status dot */}
        {migratorExists !== null && (
          <div className="ml-auto flex-shrink-0">
            <div className={`w-2 h-2 rounded-full ${migratorExists ? "bg-green-400" : "bg-red-400"}`}
              title={migratorExists ? "Migrator verified" : "Migrator not found"}
            />
          </div>
        )}
      </div>

      {/* ── Migrator error ── */}
      {migratorExists === false && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl"
          style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
        >
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-red-400">Migrator contract not found</p>
            <p className="text-[11px] text-red-400/60 mt-0.5 font-mono break-all">{contracts?.v3.migrator}</p>
          </div>
        </div>
      )}

      {/* ── Loading ── */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-border/40 bg-card/60 animate-pulse">
              <CardContent className="p-4 h-20" />
            </Card>
          ))}
        </div>
      ) : positions.length === 0 ? (
        /* ── Empty ── */
        <Card className="border-border/40 bg-card/95 backdrop-blur-sm">
          <CardContent className="flex flex-col items-center justify-center py-12 px-6 gap-4 text-center">
            <div className="w-12 h-12 rounded-2xl bg-muted/60 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-muted-foreground" />
            </div>
            <p className="font-semibold text-sm">No V2 positions to migrate</p>
            <Button variant="outline" size="sm" onClick={loadPositions} className="gap-2">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
          </CardContent>
        </Card>
      ) : (
        /* ── Position cards ── */
        <div className="space-y-2">
          {positions.map((position, index) => {
            const isSelected = selectedPosition?.pairAddress === position.pairAddress;
            const token0Amount = formatAmount((position.reserve0 * position.lpBalance) / position.totalSupply, position.token0.decimals);
            const token1Amount = formatAmount((position.reserve1 * position.lpBalance) / position.totalSupply, position.token1.decimals);
            const token0Display = getDisplayTokenMeta(position.token0);
            const token1Display = getDisplayTokenMeta(position.token1);
            const v2Price = isSelected ? getV2Price() : null;

            return (
              <Card
                key={index}
                onClick={() => setSelectedPosition(isSelected ? null : position)}
                className={`border transition-all cursor-pointer overflow-hidden ${
                  isSelected
                    ? "border-indigo-500/50 bg-card/95 shadow-lg shadow-indigo-500/10"
                    : "border-border/40 bg-card/60 hover:border-border/70 hover:bg-card/80"
                }`}
              >
                <CardContent className="p-0">
                  {/* Row */}
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    {/* Overlapping logos */}
                    <div className="relative w-10 h-7 flex-shrink-0">
                      <img src={token0Display.logoURI} alt={token0Display.symbol}
                        className="w-7 h-7 rounded-full border-2 border-background object-cover absolute left-0 top-0 z-10"
                        onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                      />
                      <img src={token1Display.logoURI} alt={token1Display.symbol}
                        className="w-7 h-7 rounded-full border-2 border-background object-cover absolute left-4 top-0"
                        onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                      />
                    </div>

                    <div className="flex-1 min-w-0 pl-1">
                      <p className="font-bold text-sm">{token0Display.symbol}/{token1Display.symbol}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {parseFloat(token0Amount).toFixed(4)} {token0Display.symbol} + {parseFloat(token1Amount).toFixed(4)} {token1Display.symbol}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="text-right">
                        <p className="text-xs font-semibold tabular-nums">{position.sharePercent.toFixed(4)}%</p>
                        <p className="text-[10px] text-muted-foreground">V2 share</p>
                      </div>
                      <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${isSelected ? "rotate-90" : ""}`} />
                    </div>
                  </div>

                  {/* ── Expanded migration panel ── */}
                  {isSelected && (
                    <div className="border-t border-border/30" onClick={(e) => e.stopPropagation()}>

                      {/* Fee tier selector */}
                      <div className="px-4 py-3 space-y-2.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          V3 Fee Tier
                        </p>
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1">
                          {FEE_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              onClick={() => setSelectedFee(opt.value)}
                              className={`flex flex-col items-center py-2 px-1 rounded-lg min-h-[44px] text-center transition-all ${
                                selectedFee === opt.value
                                  ? "bg-indigo-500/20 border border-indigo-500/50 text-indigo-300"
                                  : "bg-muted/30 border border-transparent text-muted-foreground hover:bg-muted/50"
                              }`}
                            >
                              <span className="text-[11px] font-bold leading-tight">{opt.label}</span>
                              <span className="text-[9px] opacity-60 mt-0.5 leading-tight hidden sm:block">{opt.desc}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Divider */}
                      <div className="mx-4 h-px bg-border/30" />

                      {/* Percentage slider */}
                      <div className="px-4 py-3 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Amount to Migrate
                          </p>
                          <span className="text-sm font-bold text-indigo-300 tabular-nums">{percentToMigrate}%</span>
                        </div>

                        <input
                          type="range"
                          min="1"
                          max="100"
                          value={percentToMigrate}
                          onChange={(e) => setPercentToMigrate(parseInt(e.target.value))}
                          className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                          style={{
                            background: `linear-gradient(to right, rgb(99,102,241) ${percentToMigrate}%, rgba(255,255,255,0.1) ${percentToMigrate}%)`,
                          }}
                        />

                        <div className="grid grid-cols-4 gap-1">
                          {[25, 50, 75, 100].map((v) => (
                            <button
                              key={v}
                              onClick={() => setPercentToMigrate(v)}
                              className={`py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                percentToMigrate === v
                                  ? "bg-indigo-500/20 border border-indigo-500/40 text-indigo-300"
                                  : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                              }`}
                            >
                              {v === 100 ? "MAX" : `${v}%`}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Divider */}
                      <div className="mx-4 h-px bg-border/30" />

                      {/* Pool status */}
                      {isCheckingPool ? (
                        <div className="px-4 py-3 flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="w-3 h-3 border border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
                          Checking V3 pool…
                        </div>
                      ) : v3PoolInfo && (
                        <div className="px-4 py-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">V3 Pool</p>
                            {v3PoolInfo.exists ? (
                              <span className="flex items-center gap-1 text-[11px] font-semibold text-green-400">
                                <CheckCircle2 className="w-3 h-3" /> Exists
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-400">
                                <AlertTriangle className="w-3 h-3" /> Will be created
                              </span>
                            )}
                          </div>

                          {v3PoolInfo.exists && v3PoolInfo.currentPrice && (
                            <div className="rounded-lg overflow-hidden"
                              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                            >
                              <div className="flex items-center justify-between px-3 py-2">
                                <span className="text-[11px] text-muted-foreground">V2 Price</span>
                                <span className="text-xs font-mono font-medium">{formatPrice(v2Price)}</span>
                              </div>
                              <div className="h-px mx-3 bg-border/30" />
                              <div className="flex items-center justify-between px-3 py-2">
                                <span className="text-[11px] text-muted-foreground">V3 Price</span>
                                <span className="text-xs font-mono font-medium">{formatPrice(v3PoolInfo.currentPrice)}</span>
                              </div>
                              {priceDiff && (
                                <>
                                  <div className="h-px mx-3 bg-border/30" />
                                  <div className="flex items-center justify-between px-3 py-2">
                                    <span className="text-[11px] text-muted-foreground">Difference</span>
                                    <span className={`text-xs font-semibold ${priceDiff.diff > 2 ? "text-amber-400" : "text-green-400"}`}>
                                      {priceDiff.diff.toFixed(2)}%
                                    </span>
                                  </div>
                                </>
                              )}
                            </div>
                          )}

                          {!v3PoolInfo.exists && (
                            <div className="rounded-lg overflow-hidden"
                              style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.24)" }}
                            >
                              <div className="flex items-center justify-between px-3 py-2">
                                <span className="text-[11px] text-indigo-200/70">V2 Price</span>
                                <span className="text-xs font-mono font-medium text-indigo-100">{formatPrice(v2Price)}</span>
                              </div>
                              <div className="h-px mx-3 bg-indigo-300/20" />
                              <div className="flex items-center justify-between px-3 py-2">
                                <span className="text-[11px] text-indigo-200/70">Initial V3 Price</span>
                                <span className="text-xs font-mono font-medium text-indigo-100">{formatPrice(v2Price)}</span>
                              </div>
                              <div className="h-px mx-3 bg-indigo-300/20" />
                              <div className="flex items-center justify-between px-3 py-2">
                                <span className="text-[11px] text-indigo-200/70">Difference</span>
                                <span className="text-xs font-semibold text-emerald-300">0.00%</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Price warning */}
                      {showPriceWarning && (
                        <>
                          <div className="mx-4 h-px bg-border/30" />
                          <div className="px-4 py-3 space-y-2.5">
                            <div className="flex items-start gap-2.5 p-3 rounded-xl"
                              style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}
                            >
                              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                              <div className="flex-1">
                                <p className="text-xs font-semibold text-amber-300">Price differs by {priceDiff?.diff.toFixed(2)}%</p>
                                <p className="text-[11px] text-amber-400/60 mt-1 leading-relaxed">
                                  You may receive fewer tokens than expected. Excess tokens are refunded to your wallet.
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => setPriceWarningConfirmed(true)}
                              className="w-full py-2.5 rounded-lg text-xs font-semibold transition-all"
                              style={{
                                background: "rgba(245,158,11,0.12)",
                                border: "1px solid rgba(245,158,11,0.3)",
                                color: "#fde68a",
                              }}
                            >
                              I understand, proceed anyway
                            </button>
                          </div>
                        </>
                      )}

                      {showZeroMinWarning && (
                        <>
                          <div className="mx-4 h-px bg-border/30" />
                          <div className="px-4 py-3 space-y-2.5">
                            <div
                              className="flex items-start gap-2.5 p-3 rounded-xl"
                              style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}
                            >
                              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                              <div className="flex-1">
                                <p className="text-xs font-semibold text-amber-300">New pool uses flexible minimums</p>
                                <p className="text-[11px] text-amber-400/60 mt-1 leading-relaxed">
                                  This migration initializes a new V3 pool. By default, strict minimums are used.
                                  Confirm only if you want to allow a zero-min fallback.
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => setZeroMinConfirmed(true)}
                              className="w-full py-2.5 rounded-lg text-xs font-semibold transition-all"
                              style={{
                                background: "rgba(245,158,11,0.12)",
                                border: "1px solid rgba(245,158,11,0.3)",
                                color: "#fde68a",
                              }}
                            >
                              I understand, allow flexible minimums
                            </button>
                          </div>
                        </>
                      )}

                      {/* Migration preview + action */}
                      <div className="mx-4 h-px bg-border/30" />
                      <div className="px-4 py-3 space-y-3">
                        {/* From → To summary */}
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-xl"
                          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                        >
                          {/* V2 side */}
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] text-muted-foreground mb-1">From V2</p>
                            <p className="text-xs font-semibold">{token0Display.symbol}/{token1Display.symbol}</p>
                            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                              {getTokenAmount(position.reserve0, position.token0.decimals)} {token0Display.symbol}
                            </p>
                            <p className="text-[10px] text-muted-foreground truncate">
                              {getTokenAmount(position.reserve1, position.token1.decimals)} {token1Display.symbol}
                            </p>
                          </div>

                          {/* Arrow */}
                          <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center self-center"
                            style={{ background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)" }}
                          >
                            <ArrowDown className="w-3.5 h-3.5 text-indigo-400 sm:-rotate-90" />
                          </div>

                          {/* V3 side */}
                          <div className="flex-1 min-w-0 text-left sm:text-right">
                            <p className="text-[10px] text-muted-foreground mb-1">To V3</p>
                            <p className="text-xs font-semibold">{token0Display.symbol}/{token1Display.symbol}</p>
                            <p className="text-[10px] text-indigo-400 mt-0.5">
                              {FEE_TIER_LABELS[selectedFee as keyof typeof FEE_TIER_LABELS]} fee
                            </p>
                            <p className="text-[10px] text-muted-foreground">Full range</p>
                          </div>
                        </div>

                        <p className="text-[10px] text-muted-foreground leading-relaxed">
                          Tokens not deposited due to price ratio differences are refunded to your wallet.
                        </p>

                        <Button
                          onClick={handleMigrate}
                          disabled={!migratorExists || isMigrating || !!showPriceWarning || isCheckingPool}
                          className="w-full h-11 text-sm font-semibold disabled:opacity-40 transition-all"
                          style={migratorExists && !isMigrating && !showPriceWarning
                            ? { background: "linear-gradient(135deg, #6366f1, #8b5cf6)", border: "none" }
                            : {}
                          }
                        >
                          {isMigrating ? (
                            <span className="flex items-center gap-2">
                              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              {v3PoolInfo?.exists ? "Migrating…" : "Creating pool & migrating…"}
                            </span>
                          ) : showPriceWarning ? (
                            "Confirm price warning above"
                          ) : (
                            <span className="flex items-center gap-2">
                              <Zap className="w-4 h-4" />
                              Migrate to V3
                            </span>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Refresh */}
      {positions.length > 0 && (
        <Button
          onClick={loadPositions}
          disabled={isLoading}
          variant="ghost"
          className="w-full h-10 text-sm text-muted-foreground hover:text-foreground gap-2"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          {isLoading ? "Refreshing…" : "Refresh Positions"}
        </Button>
      )}
    </div>
  );
}
