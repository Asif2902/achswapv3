import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import { Contract, BrowserProvider } from "ethers";
import { getContractsForChain } from "@/lib/contracts";
import { NONFUNGIBLE_POSITION_MANAGER_ABI, V3_POOL_ABI, V3_FACTORY_ABI, FEE_TIER_LABELS } from "@/lib/abis/v3";
import { formatAmount } from "@/lib/decimal-utils";
import { getTokensFromLiquidity } from "@/lib/v3-liquidity-math";
import { ExternalLink, Trash2, Coins, RefreshCw, DollarSign } from "lucide-react";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

// uint128 max — used as a sentinel for "collect everything"
const MAX_UINT128 = 2n ** 128n - 1n;

// uint256 wrap-around modulus for fee subtraction
const Q128 = 2n ** 128n;

interface V3Position {
  tokenId: bigint;
  token0Address: string;
  token0Symbol: string;
  token0Decimals: number;
  token1Address: string;
  token1Symbol: string;
  token1Decimals: number;
  fee: number;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  // tokensOwed from the NFT contract (already snapshotted fees)
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  // Uncollected fees calculated from feeGrowth (the accurate number)
  unclaimedFees0: bigint;
  unclaimedFees1: bigint;
  // Calculated actual token amounts from liquidity math
  amount0: bigint;
  amount1: bigint;
}

/**
 * Calculate feeGrowthInside for a tick range given the pool's global fee growth
 * and each boundary tick's feeGrowthOutside values.
 *
 * Uniswap V3 spec (section 6.3):
 *   feeGrowthBelow(i) = feeGrowthOutside(i)              if currentTick >= i
 *                     = feeGrowthGlobal − feeGrowthOutside(i)  otherwise
 *
 *   feeGrowthAbove(i) = feeGrowthOutside(i)              if currentTick < i
 *                     = feeGrowthGlobal − feeGrowthOutside(i)  otherwise
 *
 *   feeGrowthInside = feeGrowthGlobal − feeGrowthBelow(lower) − feeGrowthAbove(upper)
 *
 * All arithmetic is done in uint256 with intentional overflow (mod 2^256).
 * We emulate this in BigInt by masking to 256 bits after every subtraction.
 */
const MASK256 = (1n << 256n) - 1n;

function subU256(a: bigint, b: bigint): bigint {
  return ((a - b) & MASK256);
}

function calculateFeeGrowthInside(
  feeGrowthGlobal: bigint,
  feeGrowthOutsideLower: bigint,
  feeGrowthOutsideUpper: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): bigint {
  const feeGrowthBelow =
    currentTick >= tickLower
      ? feeGrowthOutsideLower
      : subU256(feeGrowthGlobal, feeGrowthOutsideLower);

  const feeGrowthAbove =
    currentTick < tickUpper
      ? feeGrowthOutsideUpper
      : subU256(feeGrowthGlobal, feeGrowthOutsideUpper);

  return subU256(subU256(feeGrowthGlobal, feeGrowthBelow), feeGrowthAbove);
}

/**
 * tokens owed = tokensOwedSnapshot + floor(liquidity × ΔfeeGrowthInside / 2^128)
 *
 * ΔfeeGrowthInside is computed mod 2^256 (same as the Solidity contract).
 */
function calculateUnclaimedFees(
  liquidity: bigint,
  feeGrowthInsideCurrent: bigint,
  feeGrowthInsideLast: bigint,
  tokensOwedSnapshot: bigint,
): bigint {
  const delta = subU256(feeGrowthInsideCurrent, feeGrowthInsideLast);
  const earned = (liquidity * delta) / Q128;
  return tokensOwedSnapshot + earned;
}

export function RemoveLiquidityV3() {
  const [positions, setPositions] = useState<V3Position[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<V3Position | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isCollecting, setIsCollecting] = useState(false);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;

  // ─────────────────────────────────────────────────────────────────────────
  // Load user's V3 positions with accurate fee & liquidity information
  // ─────────────────────────────────────────────────────────────────────────
  const loadPositions = async () => {
    if (!address || !contracts || !window.ethereum) return;

    setIsLoading(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        provider
      );

      const balance = await positionManager.balanceOf(address);
      const userPositions: V3Position[] = [];

      for (let i = 0; i < Number(balance); i++) {
        try {
          const tokenId = await positionManager.tokenOfOwnerByIndex(address, i);
          const position = await positionManager.positions(tokenId);

          // positions() tuple:
          // [0] nonce  [1] operator  [2] token0  [3] token1  [4] fee
          // [5] tickLower  [6] tickUpper  [7] liquidity
          // [8] feeGrowthInside0LastX128  [9] feeGrowthInside1LastX128
          // [10] tokensOwed0  [11] tokensOwed1
          const token0Address = position[2];
          const token1Address = position[3];
          const fee = Number(position[4]);
          const tickLower = Number(position[5]);
          const tickUpper = Number(position[6]);
          const liquidity = position[7];
          const feeGrowthInside0LastX128 = position[8];
          const feeGrowthInside1LastX128 = position[9];
          const tokensOwed0 = position[10];
          const tokensOwed1 = position[11];

          // Token metadata
          const token0Contract = new Contract(token0Address, ERC20_ABI, provider);
          const token1Contract = new Contract(token1Address, ERC20_ABI, provider);

          const [token0Symbol, token0Decimals, token1Symbol, token1Decimals] =
            await Promise.all([
              token0Contract.symbol(),
              token0Contract.decimals(),
              token1Contract.symbol(),
              token1Contract.decimals(),
            ]);

          // Default values
          let amount0 = 0n;
          let amount1 = 0n;
          let unclaimedFees0 = tokensOwed0;
          let unclaimedFees1 = tokensOwed1;

          try {
            const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);

            // Sort tokens for pool lookup (Uniswap V3: token0 < token1 by address)
            const [tokenA, tokenB] =
              token0Address.toLowerCase() < token1Address.toLowerCase()
                ? [token0Address, token1Address]
                : [token1Address, token0Address];

            const poolAddress = await factory.getPool(tokenA, tokenB, fee);

            if (
              poolAddress &&
              poolAddress !== "0x0000000000000000000000000000000000000000"
            ) {
              const pool = new Contract(poolAddress, V3_POOL_ABI, provider);

              // Fetch everything we need in one round-trip
              const [
                slot0,
                feeGrowthGlobal0X128,
                feeGrowthGlobal1X128,
                tickLowerData,
                tickUpperData,
              ] = await Promise.all([
                pool.slot0(),
                pool.feeGrowthGlobal0X128(),
                pool.feeGrowthGlobal1X128(),
                pool.ticks(tickLower),
                pool.ticks(tickUpper),
              ]);

              let currentSqrtPriceX96: bigint = slot0[0];
              const currentTick: number = Number(slot0[1]);

              if (currentSqrtPriceX96 === 0n) {
                // Pool not initialised — use 1:1 as a safe default
                currentSqrtPriceX96 = 2n ** 96n;
              }

              // ticks() returns:
              // [0] liquidityGross  [1] liquidityNet
              // [2] feeGrowthOutside0X128  [3] feeGrowthOutside1X128
              // [4..7] other fields we don't need here
              const feeGrowthOutsideLower0: bigint = tickLowerData[2];
              const feeGrowthOutsideLower1: bigint = tickLowerData[3];
              const feeGrowthOutsideUpper0: bigint = tickUpperData[2];
              const feeGrowthOutsideUpper1: bigint = tickUpperData[3];

              // ── Accurate uncollected fee calculation ──────────────────────
              // Only positions with liquidity > 0 can accumulate fees.
              if (liquidity > 0n) {
                const feeGrowthInside0 = calculateFeeGrowthInside(
                  feeGrowthGlobal0X128,
                  feeGrowthOutsideLower0,
                  feeGrowthOutsideUpper0,
                  currentTick,
                  tickLower,
                  tickUpper,
                );

                const feeGrowthInside1 = calculateFeeGrowthInside(
                  feeGrowthGlobal1X128,
                  feeGrowthOutsideLower1,
                  feeGrowthOutsideUpper1,
                  currentTick,
                  tickLower,
                  tickUpper,
                );

                unclaimedFees0 = calculateUnclaimedFees(
                  liquidity,
                  feeGrowthInside0,
                  feeGrowthInside0LastX128,
                  tokensOwed0,
                );

                unclaimedFees1 = calculateUnclaimedFees(
                  liquidity,
                  feeGrowthInside1,
                  feeGrowthInside1LastX128,
                  tokensOwed1,
                );
              }

              // ── Liquidity → token amounts ─────────────────────────────────
              const tokenAmounts = getTokensFromLiquidity(
                liquidity,
                currentSqrtPriceX96,
                tickLower,
                tickUpper,
              );

              // The pool stores tokens in sorted order; position may have them reversed
              if (token0Address.toLowerCase() === tokenB.toLowerCase()) {
                amount0 = tokenAmounts.amount1;
                amount1 = tokenAmounts.amount0;
              } else {
                amount0 = tokenAmounts.amount0;
                amount1 = tokenAmounts.amount1;
              }
            } else {
              console.warn("Pool not found for token pair");
            }
          } catch (poolError) {
            console.error("Error fetching pool data:", poolError);
          }

          userPositions.push({
            tokenId,
            token0Address,
            token0Symbol,
            token0Decimals: Number(token0Decimals),
            token1Address,
            token1Symbol,
            token1Decimals: Number(token1Decimals),
            fee,
            liquidity,
            tickLower,
            tickUpper,
            tokensOwed0,
            tokensOwed1,
            unclaimedFees0,
            unclaimedFees1,
            amount0,
            amount1,
          });
        } catch (error) {
          console.error(`Error loading position ${i}:`, error);
          continue;
        }
      }

      setPositions(userPositions);

      if (userPositions.length === 0) {
        toast({
          title: "No V3 positions found",
          description: "You don't have any V3 liquidity positions",
        });
      }
    } catch (error) {
      console.error("Error loading V3 positions:", error);
      toast({
        title: "Failed to load positions",
        description: "Could not fetch your V3 liquidity positions",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Collect fees without removing liquidity
  // ─────────────────────────────────────────────────────────────────────────
  const handleCollectFees = async () => {
    if (!selectedPosition || !address || !contracts || !window.ethereum) return;

    setIsCollecting(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer
      );

      toast({
        title: "Collecting fees...",
        description: "Claiming your trading fees",
      });

      const collectParams = {
        tokenId: selectedPosition.tokenId,
        recipient: address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      };

      const collectTx = await positionManager.collect(collectParams);
      const receipt = await collectTx.wait();

      let amount0Collected = 0n;
      let amount1Collected = 0n;

      for (const log of receipt.logs) {
        try {
          const parsed = positionManager.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === "Collect") {
            amount0Collected = parsed.args.amount0;
            amount1Collected = parsed.args.amount1;
          }
        } catch {
          // Not a Collect event
        }
      }

      await loadPositions();

      const formatted0 = formatAmount(amount0Collected, selectedPosition.token0Decimals);
      const formatted1 = formatAmount(amount1Collected, selectedPosition.token1Decimals);

      toast({
        title: "Fees collected!",
        description: (
          <div className="flex flex-col gap-1">
            <span>
              Collected: {formatted0} {selectedPosition.token0Symbol} +{" "}
              {formatted1} {selectedPosition.token1Symbol}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 w-fit"
              onClick={() =>
                window.open(`${contracts.explorer}${receipt.hash}`, "_blank")
              }
            >
              <ExternalLink className="h-3 w-3 mr-1" /> View Transaction
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error("Collect fees error:", error);
      toast({
        title: "Failed to collect fees",
        description: error.reason || error.message || "Transaction failed",
        variant: "destructive",
      });
    } finally {
      setIsCollecting(false);
    }
  };

  useEffect(() => {
    if (isConnected && address) {
      loadPositions();
    }
  }, [isConnected, address, chainId]);

  // ─────────────────────────────────────────────────────────────────────────
  // Remove all liquidity (decreaseLiquidity → collect → burn) via multicall
  // ─────────────────────────────────────────────────────────────────────────
  const handleRemove = async () => {
    if (!selectedPosition || !address || !contracts || !window.ethereum) return;

    setIsRemoving(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer
      );

      toast({
        title: "Removing liquidity...",
        description:
          "Decreasing liquidity, collecting tokens, and burning NFT in one transaction",
      });

      const decreaseData = positionManager.interface.encodeFunctionData(
        "decreaseLiquidity",
        [
          {
            tokenId: selectedPosition.tokenId,
            liquidity: selectedPosition.liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline: Math.floor(Date.now() / 1000) + 1200,
          },
        ]
      );

      const collectData = positionManager.interface.encodeFunctionData("collect", [
        {
          tokenId: selectedPosition.tokenId,
          recipient: address,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ]);

      const burnData = positionManager.interface.encodeFunctionData("burn", [
        selectedPosition.tokenId,
      ]);

      const multicallTx = await positionManager.multicall([
        decreaseData,
        collectData,
        burnData,
      ]);

      const receipt = await multicallTx.wait();

      let amount0Collected = 0n;
      let amount1Collected = 0n;

      for (const log of receipt.logs) {
        try {
          const parsed = positionManager.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === "Collect") {
            amount0Collected = parsed.args.amount0;
            amount1Collected = parsed.args.amount1;
          }
        } catch {
          // Not a Collect event
        }
      }

      const formatted0 = formatAmount(amount0Collected, selectedPosition.token0Decimals);
      const formatted1 = formatAmount(amount1Collected, selectedPosition.token1Decimals);

      toast({
        title: "Liquidity removed successfully!",
        description: (
          <div className="flex flex-col gap-1">
            <span>
              Removed: {formatted0} {selectedPosition.token0Symbol} +{" "}
              {formatted1} {selectedPosition.token1Symbol}
            </span>
            <span className="text-xs text-slate-400">NFT position burned</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 w-fit"
              onClick={() =>
                window.open(`${contracts.explorer}${receipt.hash}`, "_blank")
              }
            >
              <ExternalLink className="h-3 w-3 mr-1" /> View Transaction
            </Button>
          </div>
        ),
      });

      await loadPositions();
      setSelectedPosition(null);
    } catch (error: any) {
      console.error("Remove liquidity error:", error);
      toast({
        title: "Failed to remove liquidity",
        description: error.reason || error.message || "Transaction failed",
        variant: "destructive",
      });
    } finally {
      setIsRemoving(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Display helpers
  // ─────────────────────────────────────────────────────────────────────────
  const formatFeeAmount = (amount: bigint, decimals: number): string => {
    if (amount === 0n) return "0";
    return formatAmount(amount, decimals);
  };

  const formatLiquidity = (liquidity: bigint): string => {
    const n = Number(liquidity);
    if (n === 0) return "0";
    if (n >= 1e15) return `${(n / 1e15).toFixed(2)}Q`;
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3)  return `${(n / 1e3).toFixed(2)}K`;
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  };

  // A position "has fees" when the accurate unclaimed total is > 0
  const hasFees = (position: V3Position): boolean =>
    position.unclaimedFees0 > 0n || position.unclaimedFees1 > 0n;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 text-center">
          <p className="text-slate-400">Connect your wallet to view V3 positions</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 text-center text-slate-400">
          Loading your V3 positions...
        </CardContent>
      </Card>
    );
  }

  if (positions.length === 0) {
    return (
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 text-center space-y-3">
          <Trash2 className="h-12 w-12 text-slate-600 mx-auto" />
          <p className="text-slate-400">No V3 liquidity positions found</p>
          <Button variant="outline" size="sm" onClick={loadPositions}>
            Refresh
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Positions List */}
      <div className="space-y-3">
        {positions.map((position, index) => (
          <Card
            key={index}
            className={`bg-slate-900 border-slate-700 cursor-pointer transition-all ${
              selectedPosition?.tokenId === position.tokenId
                ? "ring-2 ring-purple-500"
                : "hover:border-slate-600"
            }`}
            onClick={() => setSelectedPosition(position)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="font-semibold text-white">
                    {position.token0Symbol} / {position.token1Symbol}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    Fee:{" "}
                    {FEE_TIER_LABELS[position.fee as keyof typeof FEE_TIER_LABELS]} |
                    Token ID: #{position.tokenId.toString()}
                  </div>

                  {/* Accurate Uncollected Fees */}
                  <div className="mt-2 p-2 bg-slate-800/50 rounded-md">
                    <div className="flex items-center gap-2 text-xs">
                      <DollarSign className="h-3 w-3 text-green-400" />
                      <span className="text-slate-400">Uncollected Fees:</span>
                    </div>
                    <div className="flex gap-4 mt-1">
                      <div className="text-sm">
                        <span className="text-green-400 font-medium">
                          {formatFeeAmount(
                            position.unclaimedFees0,
                            position.token0Decimals
                          )}
                        </span>
                        <span className="text-slate-500 ml-1">
                          {position.token0Symbol}
                        </span>
                      </div>
                      <div className="text-sm">
                        <span className="text-green-400 font-medium">
                          {formatFeeAmount(
                            position.unclaimedFees1,
                            position.token1Decimals
                          )}
                        </span>
                        <span className="text-slate-500 ml-1">
                          {position.token1Symbol}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Liquidity Value (token amounts) */}
                  {(position.amount0 > 0n || position.amount1 > 0n) && (
                    <div className="mt-2 p-2 bg-slate-800/50 rounded-md">
                      <div className="flex items-center gap-2 text-xs">
                        <Coins className="h-3 w-3 text-purple-400" />
                        <span className="text-slate-400">Liquidity Value:</span>
                      </div>
                      <div className="flex gap-4 mt-1">
                        <div className="text-sm">
                          <span className="text-purple-400 font-medium">
                            {formatFeeAmount(
                              position.amount0,
                              position.token0Decimals
                            )}
                          </span>
                          <span className="text-slate-500 ml-1">
                            {position.token0Symbol}
                          </span>
                        </div>
                        <div className="text-sm">
                          <span className="text-purple-400 font-medium">
                            {formatFeeAmount(
                              position.amount1,
                              position.token1Decimals
                            )}
                          </span>
                          <span className="text-slate-500 ml-1">
                            {position.token1Symbol}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="text-right">
                  <div className="text-sm font-medium text-purple-400">
                    V3 Position
                  </div>
                  {hasFees(position) && (
                    <div className="mt-1">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-green-500/20 text-green-400">
                        <Coins className="h-3 w-3 mr-1" />
                        Fees Ready
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Action Buttons */}
      {selectedPosition && (
        <div className="space-y-3">
          {/* Collect Fees Button */}
          <Button
            onClick={handleCollectFees}
            disabled={isCollecting || !hasFees(selectedPosition)}
            variant="outline"
            className="w-full h-12 text-base font-semibold bg-green-600/20 border-green-500/50 hover:bg-green-600/30 text-green-400"
          >
            {isCollecting ? (
              "Collecting..."
            ) : (
              <>
                <Coins className="h-4 w-4 mr-2" />
                Collect Fees
                {hasFees(selectedPosition) && (
                  <span className="ml-2 text-xs">
                    (
                    {formatFeeAmount(
                      selectedPosition.unclaimedFees0,
                      selectedPosition.token0Decimals
                    )}{" "}
                    {selectedPosition.token0Symbol} +{" "}
                    {formatFeeAmount(
                      selectedPosition.unclaimedFees1,
                      selectedPosition.token1Decimals
                    )}{" "}
                    {selectedPosition.token1Symbol})
                  </span>
                )}
              </>
            )}
          </Button>

          {/* Refresh Button */}
          <Button
            onClick={loadPositions}
            disabled={isLoading}
            variant="ghost"
            className="w-full h-10 text-sm"
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`}
            />
            {isLoading ? "Refreshing..." : "Refresh Positions"}
          </Button>

          {/* Remove Liquidity Button */}
          <Button
            onClick={handleRemove}
            disabled={isRemoving || selectedPosition.liquidity === 0n}
            variant="destructive"
            className="w-full h-12 text-base font-semibold"
          >
            {isRemoving ? "Removing..." : "Remove V3 Liquidity"}
            {(selectedPosition.amount0 > 0n || selectedPosition.amount1 > 0n) && (
              <span className="ml-2 text-xs">
                (
                {formatFeeAmount(
                  selectedPosition.amount0,
                  selectedPosition.token0Decimals
                )}{" "}
                {selectedPosition.token0Symbol} +{" "}
                {formatFeeAmount(
                  selectedPosition.amount1,
                  selectedPosition.token1Decimals
                )}{" "}
                {selectedPosition.token1Symbol})
              </span>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
