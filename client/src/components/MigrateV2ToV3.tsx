import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider } from "ethers";
import { getTokensByChainId } from "@/data/tokens";
import { formatAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { V3_MIGRATOR_ABI, V3_FACTORY_ABI, V3_POOL_ABI, V3_FEE_TIERS, FEE_TIER_LABELS } from "@/lib/abis/v3";
import { priceToSqrtPriceX96, sqrtPriceX96ToPrice, getPriceFromAmounts, getFullRangeTicks } from "@/lib/v3-utils";
import { ArrowRight, AlertCircle, ExternalLink, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";

// Ensure the migrator ABI has the functions needed for the multicall path.
// The V3 Migrator inherits Multicall and PeripheryImmutableState — both are
// always present on-chain, but older ABI files may omit them.
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

const V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
  "function allPairsLength() external view returns (uint256)",
  "function allPairs(uint256) external view returns (address pair)",
];

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

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

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;
  const tokens = chainId ? getTokensByChainId(chainId) : [];

  const feeOptions = [
    { value: V3_FEE_TIERS.LOWEST, label: "0.01%", description: "Very stable pairs" },
    { value: V3_FEE_TIERS.LOW, label: "0.05%", description: "Stable pairs" },
    { value: V3_FEE_TIERS.MEDIUM, label: "0.3%", description: "Most pairs" },
    { value: V3_FEE_TIERS.HIGH, label: "1%", description: "Exotic pairs" },
    { value: V3_FEE_TIERS.ULTRA_HIGH, label: "10%", description: "Very exotic pairs" },
  ];

  // Check if migrator contract exists
  useEffect(() => {
    const checkMigrator = async () => {
      if (!contracts || !window.ethereum) return;
      try {
        const provider = new BrowserProvider(window.ethereum);
        const code = await provider.getCode(contracts.v3.migrator);
        setMigratorExists(code !== "0x" && code !== "0x0");
      } catch {
        setMigratorExists(false);
      }
    };
    checkMigrator();
  }, [contracts]);

  // Check V3 pool status when position or fee tier changes
  useEffect(() => {
    const checkV3Pool = async () => {
      if (!selectedPosition || !contracts || !window.ethereum) {
        setV3PoolInfo(null);
        return;
      }

      setIsCheckingPool(true);
      try {
        const provider = new BrowserProvider(window.ethereum);
        const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);

        const poolAddress = await factory.getPool(
          selectedPosition.token0.address,
          selectedPosition.token1.address,
          selectedFee
        );

        if (poolAddress && poolAddress !== "0x0000000000000000000000000000000000000000") {
          // Pool exists - get current price
          const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
          const slot0 = await pool.slot0();
          const sqrtPriceX96 = slot0[0];
          const tick = Number(slot0[1]);

          // Check if pool has any liquidity
          const liquidity = await pool.liquidity();

          if (sqrtPriceX96 === 0n) {
            // Pool address exists but was never initialized — treat as non-existent
            setV3PoolInfo({
              exists: false,
              address: null,
              currentPrice: null,
              currentTick: null,
              sqrtPriceX96: null,
            });
            return;
          }

          const currentPrice = sqrtPriceX96ToPrice(
            sqrtPriceX96,
            selectedPosition.token0.decimals,
            selectedPosition.token1.decimals
          );

          setV3PoolInfo({
            exists: true,
            address: poolAddress,
            currentPrice,
            currentTick: tick,
            sqrtPriceX96,
            // @ts-ignore — extend if needed
            hasLiquidity: liquidity > 0n,
          });
        } else {
          setV3PoolInfo({
            exists: false,
            address: null,
            currentPrice: null,
            currentTick: null,
            sqrtPriceX96: null,
          });
        }
      } catch (error) {
        console.error("Error checking V3 pool:", error);
        setV3PoolInfo({
          exists: false,
          address: null,
          currentPrice: null,
          currentTick: null,
          sqrtPriceX96: null,
        });
      } finally {
        setIsCheckingPool(false);
      }
    };

    checkV3Pool();
    setPriceWarningConfirmed(false);
  }, [selectedPosition, selectedFee, contracts]);

  // Calculate V2 price
  const getV2Price = (): number | null => {
    if (!selectedPosition) return null;
    return getPriceFromAmounts(
      selectedPosition.reserve0,
      selectedPosition.reserve1,
      selectedPosition.token0.decimals,
      selectedPosition.token1.decimals
    );
  };

  // Check if prices differ significantly (more than 2%)
  const getPriceDifference = (): { diff: number; v2Price: number; v3Price: number } | null => {
    const v2Price = getV2Price();
    if (!v2Price || !v3PoolInfo?.currentPrice) return null;

    const diff = Math.abs((v3PoolInfo.currentPrice - v2Price) / v2Price) * 100;
    return { diff, v2Price, v3Price: v3PoolInfo.currentPrice };
  };

  const priceDiff = getPriceDifference();
  const showPriceWarning = priceDiff && priceDiff.diff > 2 && !priceWarningConfirmed;

  // Load user's V2 positions
  const loadPositions = async () => {
    if (!address || !contracts || !window.ethereum) return;

    setIsLoading(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const factory = new Contract(contracts.v2.factory, V2_FACTORY_ABI, provider);

      const pairsLength = await factory.allPairsLength();
      const userPositions: V2Position[] = [];

      const maxPairs = Math.min(Number(pairsLength), 50);

      for (let i = 0; i < maxPairs; i++) {
        try {
          const pairAddress = await factory.allPairs(i);
          const pairContract = new Contract(pairAddress, V2_PAIR_ABI, provider);

          const lpBalance = await pairContract.balanceOf(address);

          if (lpBalance > 0n) {
            const token0Address = await pairContract.token0();
            const token1Address = await pairContract.token1();
            const reserves = await pairContract.getReserves();
            const totalSupply = await pairContract.totalSupply();

            const token0Contract = new Contract(token0Address, ERC20_ABI, provider);
            const token1Contract = new Contract(token1Address, ERC20_ABI, provider);

            const [name0, symbol0, decimals0] = await Promise.all([
              token0Contract.name(),
              token0Contract.symbol(),
              token0Contract.decimals(),
            ]);

            const [name1, symbol1, decimals1] = await Promise.all([
              token1Contract.name(),
              token1Contract.symbol(),
              token1Contract.decimals(),
            ]);

            const token0: Token = {
              address: token0Address,
              name: name0,
              symbol: symbol0,
              decimals: Number(decimals0),
              logoURI: tokens.find(t => t.address.toLowerCase() === token0Address.toLowerCase())?.logoURI || "/img/logos/unknown-token.png",
              verified: false,
              chainId: chainId!,
            };

            const token1: Token = {
              address: token1Address,
              name: name1,
              symbol: symbol1,
              decimals: Number(decimals1),
              logoURI: tokens.find(t => t.address.toLowerCase() === token1Address.toLowerCase())?.logoURI || "/img/logos/unknown-token.png",
              verified: false,
              chainId: chainId!,
            };

            const sharePercent = Number((lpBalance * 10000n) / totalSupply) / 100;

            userPositions.push({
              pairAddress,
              token0,
              token1,
              lpBalance,
              totalSupply,
              reserve0: reserves[0],
              reserve1: reserves[1],
              sharePercent,
            });
          }
        } catch (error) {
          continue;
        }
      }

      setPositions(userPositions);

      if (userPositions.length === 0) {
        toast({
          title: "No V2 positions found",
          description: "You don't have any V2 liquidity positions to migrate",
        });
      }
    } catch (error) {
      console.error("Error loading positions:", error);
      toast({
        title: "Failed to load positions",
        description: "Could not fetch your V2 liquidity positions",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isConnected && address) {
      loadPositions();
    }
  }, [isConnected, address, chainId]);

  const handleMigrate = async () => {
    if (!selectedPosition || !address || !contracts || !window.ethereum || !migratorExists) return;

    if (showPriceWarning) {
      toast({
        title: "Confirmation required",
        description: "Please confirm the price difference before migrating",
        variant: "destructive",
      });
      return;
    }

    setIsMigrating(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const migrator = new Contract(contracts.v3.migrator, [...V3_MIGRATOR_ABI, ...MIGRATOR_EXTRA_ABI], signer);
      const pairContract = new Contract(selectedPosition.pairAddress, V2_PAIR_ABI, signer);

      const liquidityToMigrate = (selectedPosition.lpBalance * BigInt(percentToMigrate)) / 100n;

      // ─── Approve LP tokens first (separate tx is fine — approval can't break the pool) ──
      toast({
        title: "Approving LP tokens...",
        description: "Please approve LP token spending",
      });

      const allowance = await pairContract.allowance(address, contracts.v3.migrator);
      if (allowance < liquidityToMigrate) {
        const approveTx = await pairContract.approve(contracts.v3.migrator, liquidityToMigrate);
        await approveTx.wait();
      }

      // ─── Full-range ticks ────────────────────────────────────────────────────
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);

      // ─── CRITICAL: amount0Min / amount1Min must be 0 ─────────────────────────
      // V2 withdraws tokens at the V2 price ratio; V3 deposits at the V3 ratio.
      // Any excess token is automatically refunded by the migrator — not lost.
      // A non-zero min based on V2 amounts will always fail the slippage check.
      const amount0Min = 0n;
      const amount1Min = 0n;
      const deadline = Math.floor(Date.now() / 1000) + 1200;

      // ─── MigrateParams (standard struct — no sqrtPriceX96 field) ────────────
      const migrateParams = {
        pair: selectedPosition.pairAddress,
        liquidityToMigrate,
        percentageToMigrate: percentToMigrate,
        token0: selectedPosition.token0.address,
        token1: selectedPosition.token1.address,
        fee: selectedFee,
        tickLower,
        tickUpper,
        amount0Min,
        amount1Min,
        recipient: address,
        deadline,
        refundAsETH: false,
      };

      let receipt;

      if (v3PoolInfo?.exists) {
        // ── Pool already exists: call migrate directly ───────────────────────
        toast({ title: "Migrating...", description: "Removing V2 liquidity and adding to V3" });

        const gasEstimate = await migrator.migrate.estimateGas(migrateParams);
        const gasLimit = (gasEstimate * 150n) / 100n;
        const tx = await migrator.migrate(migrateParams, { gasLimit });
        receipt = await tx.wait();
      } else {
        // ── Pool does NOT exist: use multicall to atomically create + migrate ──
        //
        // Why multicall?  If we call createAndInitializePoolIfNecessary in one tx
        // and migrate in a second tx, a failed migrate leaves an initialized-but-
        // empty pool that is permanently broken and cannot receive liquidity.
        //
        // With multicall both calls share one transaction: if migrate reverts,
        // the pool creation also reverts — nothing is left in a broken state.
        const v2Price = getV2Price();
        if (!v2Price) throw new Error("Could not calculate V2 price");

        const sqrtPriceX96 = priceToSqrtPriceX96(
          v2Price,
          selectedPosition.token0.decimals,
          selectedPosition.token1.decimals
        );

        toast({
          title: "Creating pool & migrating...",
          description: "Initializing V3 pool and migrating liquidity in one transaction",
        });

        const createData = migrator.interface.encodeFunctionData(
          "createAndInitializePoolIfNecessary",
          [
            selectedPosition.token0.address,
            selectedPosition.token1.address,
            selectedFee,
            sqrtPriceX96,
          ]
        );

        const migrateData = migrator.interface.encodeFunctionData("migrate", [migrateParams]);

        const gasEstimate = await migrator.multicall.estimateGas([createData, migrateData]);
        const gasLimit = (gasEstimate * 150n) / 100n;
        const tx = await migrator.multicall([createData, migrateData], { gasLimit });
        receipt = await tx.wait();
      }

      setSelectedPosition(null);
      setV3PoolInfo(null);
      setPriceWarningConfirmed(false);
      await loadPositions();

      toast({
        title: "Migration successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully migrated from V2 to V3</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, '_blank')}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error("Migration error:", error);
      toast({
        title: "Migration failed",
        description: error.reason || error.message || "Transaction failed",
        variant: "destructive",
      });
    } finally {
      setIsMigrating(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Info Banner */}
      <div className="flex items-start gap-3 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
        <RefreshCw className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-semibold text-blue-400 text-sm">Migrate V2 → V3</h3>
          <p className="text-xs text-slate-300">
            Move your V2 liquidity to V3 for better capital efficiency and concentrated liquidity
          </p>
        </div>
      </div>

      {/* Migrator Contract Status */}
      {migratorExists === false && (
        <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
          <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="font-semibold text-red-400 text-sm">V3 Migrator Not Found</h3>
            <p className="text-xs text-slate-300">
              The V3 Migrator contract is not deployed at the configured address ({contracts?.v3.migrator}).
              Migration will not work until the contract is deployed.
            </p>
          </div>
        </div>
      )}

      {migratorExists === true && (
        <div className="flex items-start gap-3 p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
          <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0 mt-0.5" />
          <p className="text-xs text-green-400">V3 Migrator contract verified</p>
        </div>
      )}

      {/* V2 Positions List */}
      {isLoading ? (
        <Card className="bg-slate-900 border-slate-700">
          <CardContent className="p-6 text-center text-slate-400">
            Loading your V2 positions...
          </CardContent>
        </Card>
      ) : positions.length === 0 ? (
        <Card className="bg-slate-900 border-slate-700">
          <CardContent className="p-6 text-center space-y-3">
            <AlertCircle className="h-12 w-12 text-slate-600 mx-auto" />
            <p className="text-slate-400">No V2 liquidity positions found</p>
            <Button variant="outline" size="sm" onClick={loadPositions} className="mt-2">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {positions.map((position, index) => (
            <Card
              key={index}
              className={`bg-slate-900 border-slate-700 cursor-pointer transition-all ${
                selectedPosition?.pairAddress === position.pairAddress
                  ? "ring-2 ring-blue-500"
                  : "hover:border-slate-600"
              }`}
              onClick={() => setSelectedPosition(position)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center">
                      <img src={position.token0.logoURI} alt={position.token0.symbol} className="w-8 h-8 rounded-full" />
                      <img src={position.token1.logoURI} alt={position.token1.symbol} className="w-8 h-8 rounded-full -ml-2" />
                    </div>
                    <div>
                      <div className="font-semibold text-white">
                        {position.token0.symbol} / {position.token1.symbol}
                      </div>
                      <div className="text-xs text-slate-400">
                        {formatAmount((position.reserve0 * position.lpBalance) / position.totalSupply, position.token0.decimals)} {position.token0.symbol} +{" "}
                        {formatAmount((position.reserve1 * position.lpBalance) / position.totalSupply, position.token1.decimals)} {position.token1.symbol}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-slate-300">{position.sharePercent.toFixed(4)}%</div>
                    <div className="text-xs text-slate-500">Pool Share</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Migration Settings */}
      {selectedPosition && (
        <>
          <Card className="bg-slate-900 border-slate-700">
            <CardContent className="p-6 space-y-4">
              <Label className="text-sm text-slate-400">Select V3 Fee Tier</Label>
              <div className="flex gap-2">
                {feeOptions.map((option) => (
                  <Button
                    key={option.value}
                    variant={selectedFee === option.value ? "default" : "outline"}
                    onClick={() => setSelectedFee(option.value)}
                    className="flex-1"
                  >
                    {option.label}
                  </Button>
                ))}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm text-slate-400">Amount to Migrate</Label>
                  <span className="text-sm text-slate-300">{percentToMigrate}%</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={percentToMigrate}
                  onChange={(e) => setPercentToMigrate(parseInt(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-slate-500">
                  <span>1%</span>
                  <span>100%</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* V3 Pool Status */}
          {isCheckingPool ? (
            <Card className="bg-slate-900 border-slate-700">
              <CardContent className="p-4 text-center text-slate-400">
                Checking V3 pool status...
              </CardContent>
            </Card>
          ) : v3PoolInfo && (
            <Card className="bg-slate-900 border-slate-700">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">V3 Pool Status</span>
                  {v3PoolInfo.exists ? (
                    <span className="text-sm text-green-400 flex items-center gap-1">
                      <CheckCircle2 className="h-4 w-4" />
                      Exists
                    </span>
                  ) : (
                    <span className="text-sm text-yellow-400 flex items-center gap-1">
                      <AlertTriangle className="h-4 w-4" />
                      Will be created
                    </span>
                  )}
                </div>

                {v3PoolInfo.exists && v3PoolInfo.currentPrice && (
                  <div className="space-y-2 pt-2 border-t border-slate-700">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400">V2 Price ({selectedPosition.token1.symbol}/{selectedPosition.token0.symbol})</span>
                      <span className="text-white">{getV2Price()?.toFixed(6)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400">V3 Price ({selectedPosition.token1.symbol}/{selectedPosition.token0.symbol})</span>
                      <span className="text-white">{v3PoolInfo.currentPrice.toFixed(6)}</span>
                    </div>
                    {priceDiff && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-400">Price Difference</span>
                        <span className={priceDiff.diff > 2 ? "text-yellow-400" : "text-green-400"}>
                          {priceDiff.diff.toFixed(2)}%
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Price Warning */}
          {showPriceWarning && (
            <Card className="bg-yellow-500/10 border-yellow-500/20">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-yellow-400 shrink-0 mt-0.5" />
                  <div className="space-y-2">
                    <h4 className="font-semibold text-yellow-400 text-sm">Price Difference Warning</h4>
                    <p className="text-xs text-slate-300">
                      The V3 pool price differs from V2 by {priceDiff?.diff.toFixed(2)}%. This could result in:
                    </p>
                    <ul className="text-xs text-slate-400 list-disc list-inside space-y-1">
                      <li>Impermanent loss when adding liquidity</li>
                      <li>Receiving fewer tokens than expected</li>
                      <li>Excess tokens refunded to your wallet rather than deposited</li>
                    </ul>
                    <div className="flex items-center gap-2 pt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/20"
                        onClick={() => setPriceWarningConfirmed(true)}
                      >
                        I understand, proceed anyway
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Migration Preview */}
          <Card className="bg-slate-900 border-slate-700">
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold text-white">Migration Preview</h3>

              <div className="flex items-center justify-between py-3 border-b border-slate-700">
                <span className="text-slate-400 text-sm">From V2</span>
                <span className="text-white font-medium">
                  {selectedPosition.token0.symbol} / {selectedPosition.token1.symbol}
                </span>
              </div>

              <div className="flex items-center justify-center py-2">
                <ArrowRight className="h-6 w-6 text-blue-400" />
              </div>

              <div className="flex items-center justify-between py-3 border-t border-slate-700">
                <span className="text-slate-400 text-sm">To V3</span>
                <span className="text-white font-medium">
                  {FEE_TIER_LABELS[selectedFee as keyof typeof FEE_TIER_LABELS]} Fee Tier
                </span>
              </div>

              <div className="space-y-2 py-3 border-t border-slate-700">
                <span className="text-slate-400 text-xs">Expected tokens to migrate ({percentToMigrate}%)</span>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-300">{selectedPosition.token0.symbol}</span>
                  <span className="text-white font-medium">
                    {formatAmount(
                      (selectedPosition.reserve0 * ((selectedPosition.lpBalance * BigInt(percentToMigrate)) / 100n)) / selectedPosition.totalSupply,
                      selectedPosition.token0.decimals
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-300">{selectedPosition.token1.symbol}</span>
                  <span className="text-white font-medium">
                    {formatAmount(
                      (selectedPosition.reserve1 * ((selectedPosition.lpBalance * BigInt(percentToMigrate)) / 100n)) / selectedPosition.totalSupply,
                      selectedPosition.token1.decimals
                    )}
                  </span>
                </div>
                <p className="text-xs text-slate-500 pt-1">
                  Note: any tokens not deposited into V3 (due to price ratio differences) are refunded to your wallet.
                </p>
              </div>

              <Button
                onClick={handleMigrate}
                disabled={
                  !migratorExists ||
                  isMigrating ||
                  showPriceWarning ||
                  isCheckingPool
                }
                className="w-full h-12 text-base font-semibold"
              >
                {isMigrating
                  ? "Migrating..."
                  : showPriceWarning
                    ? "Confirm Price Warning Above"
                    : "Migrate to V3"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
