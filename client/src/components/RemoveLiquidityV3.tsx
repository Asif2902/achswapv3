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
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  // Calculated actual token amounts from liquidity
  amount0: bigint;
  amount1: bigint;
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

  // Load user's V3 positions with fee information
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

          // position returns: nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1
          const token0Address = position[2];
          const token1Address = position[3];
          const fee = Number(position[4]);
          const tickLower = Number(position[5]);
          const tickUpper = Number(position[6]);
          const liquidity = position[7];
          const tokensOwed0 = position[10];
          const tokensOwed1 = position[11];

          // Get token symbols and decimals
          const token0Contract = new Contract(token0Address, ERC20_ABI, provider);
          const token1Contract = new Contract(token1Address, ERC20_ABI, provider);

          const [token0Symbol, token0Decimals, token1Symbol, token1Decimals] = await Promise.all([
            token0Contract.symbol(),
            token0Contract.decimals(),
            token1Contract.symbol(),
            token1Contract.decimals(),
          ]);

          // Get pool address and current price
          let amount0 = 0n;
          let amount1 = 0n;

          try {
            const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
            
            // Sort tokens for pool lookup (Uniswap V3 requires token0 < token1 by address)
            const [tokenA, tokenB] = token0Address.toLowerCase() < token1Address.toLowerCase()
              ? [token0Address, token1Address]
              : [token1Address, token0Address];
            
            const poolAddress = await factory.getPool(tokenA, tokenB, fee);

            if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
              const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
              const slot0 = await pool.slot0();
              let currentSqrtPriceX96 = slot0[0];
              
              // If pool not initialized (sqrtPriceX96 = 0), use a default or skip
              if (currentSqrtPriceX96 === 0n) {
                console.warn("Pool not initialized, using default sqrtPriceX96");
                // Use a default price of 1:1 (sqrtPriceX96 = 2^96)
                currentSqrtPriceX96 = 2n ** 96n;
              }

              // Calculate actual token amounts from liquidity using Uniswap V3 math
              const tokenAmounts = getTokensFromLiquidity(
                liquidity,
                currentSqrtPriceX96,
                tickLower,
                tickUpper
              );
              
              // The pool stores token0/token1 in sorted order, but position might have them reversed
              // We need to swap amounts if token order is reversed
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
            // If we can't get pool data, use 0 for amounts
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

  // Collect fees without removing liquidity
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

      // Collect all available fees
      const collectParams = {
        tokenId: selectedPosition.tokenId,
        recipient: address,
        amount0Max: 2n ** 128n - 1n, // Max uint128
        amount1Max: 2n ** 128n - 1n,
      };

      const collectTx = await positionManager.collect(collectParams);
      const receipt = await collectTx.wait();

      // Parse the Collect event to get amounts
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

      // Reload positions
      await loadPositions();

      const formatted0 = formatAmount(amount0Collected, selectedPosition.token0Decimals);
      const formatted1 = formatAmount(amount1Collected, selectedPosition.token1Decimals);

      toast({
        title: "Fees collected!",
        description: (
          <div className="flex flex-col gap-1">
            <span>Collected: {formatted0} {selectedPosition.token0Symbol} + {formatted1} {selectedPosition.token1Symbol}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 w-fit"
              onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, '_blank')}
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
        description: "Decreasing liquidity, collecting tokens, and burning NFT in one transaction",
      });

      // Prepare the calls for multicall
      // Order matters: decreaseLiquidity first, then collect, then burn
      // This ensures we get the correct token amounts before collecting
      
      // decreaseLiquidity call
      const decreaseData = positionManager.interface.encodeFunctionData("decreaseLiquidity", [{
        tokenId: selectedPosition.tokenId,
        liquidity: selectedPosition.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: Math.floor(Date.now() / 1000) + 1200,
      }]);

      // collect call - collect both liquidity tokens and any pending fees
      const collectData = positionManager.interface.encodeFunctionData("collect", [{
        tokenId: selectedPosition.tokenId,
        recipient: address,
        amount0Max: 2n ** 128n - 1n,
        amount1Max: 2n ** 128n - 1n,
      }]);

      // burn call - close and delete the position NFT
      const burnData = positionManager.interface.encodeFunctionData("burn", [selectedPosition.tokenId]);

      // Execute all calls in a single transaction using multicall
      const multicallTx = await positionManager.multicall([
        decreaseData,
        collectData,
        burnData
      ]);

      const receipt = await multicallTx.wait();

      // Parse the receipts to get amounts
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
            <span>Removed: {formatted0} {selectedPosition.token0Symbol} + {formatted1} {selectedPosition.token1Symbol}</span>
            <span className="text-xs text-slate-400">NFT position burned</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 w-fit"
              onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, '_blank')}
            >
              <ExternalLink className="h-3 w-3 mr-1" /> View Transaction
            </Button>
          </div>
        ),
      });

      // Reload positions to reflect the removed position
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

  // Format fee amounts for display
  const formatFeeAmount = (amount: bigint, decimals: number): string => {
    if (amount === 0n) return "0";
    return formatAmount(amount, decimals);
  };

  // Format liquidity for human-readable display
  const formatLiquidity = (liquidity: bigint): string => {
    const liquidityNum = Number(liquidity);
    
    if (liquidityNum === 0) return "0";
    
    // For very large numbers, use scientific notation or abbreviations
    if (liquidityNum >= 1e15) {
      return `${(liquidityNum / 1e15).toFixed(2)}Q`;
    } else if (liquidityNum >= 1e12) {
      return `${(liquidityNum / 1e12).toFixed(2)}T`;
    } else if (liquidityNum >= 1e9) {
      return `${(liquidityNum / 1e9).toFixed(2)}B`;
    } else if (liquidityNum >= 1e6) {
      return `${(liquidityNum / 1e6).toFixed(2)}M`;
    } else if (liquidityNum >= 1e3) {
      return `${(liquidityNum / 1e3).toFixed(2)}K`;
    }
    
    // For smaller numbers, show with up to 4 decimal places
    return liquidityNum.toLocaleString(undefined, { maximumFractionDigits: 4 });
  };

  // Check if position has collectable fees
  const hasFees = (position: V3Position): boolean => {
    return position.tokensOwed0 > 0n || position.tokensOwed1 > 0n;
  };

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
                    Fee: {FEE_TIER_LABELS[position.fee as keyof typeof FEE_TIER_LABELS]} | 
                    Token ID: #{position.tokenId.toString()}
                  </div>
                  
                  {/* Fee Display */}
                  <div className="mt-2 p-2 bg-slate-800/50 rounded-md">
                    <div className="flex items-center gap-2 text-xs">
                      <DollarSign className="h-3 w-3 text-green-400" />
                      <span className="text-slate-400">Pending Fees:</span>
                    </div>
                    <div className="flex gap-4 mt-1">
                      <div className="text-sm">
                        <span className="text-green-400 font-medium">
                          {formatFeeAmount(position.tokensOwed0, position.token0Decimals)}
                        </span>
                        <span className="text-slate-500 ml-1">{position.token0Symbol}</span>
                      </div>
                      <div className="text-sm">
                        <span className="text-green-400 font-medium">
                          {formatFeeAmount(position.tokensOwed1, position.token1Decimals)}
                        </span>
                        <span className="text-slate-500 ml-1">{position.token1Symbol}</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Liquidity Display - Actual token amounts from V3 math */}
                  {(position.amount0 > 0n || position.amount1 > 0n) && (
                    <div className="mt-2 p-2 bg-slate-800/50 rounded-md">
                      <div className="flex items-center gap-2 text-xs">
                        <Coins className="h-3 w-3 text-purple-400" />
                        <span className="text-slate-400">Liquidity Value:</span>
                      </div>
                      <div className="flex gap-4 mt-1">
                        <div className="text-sm">
                          <span className="text-purple-400 font-medium">
                            {formatFeeAmount(position.amount0, position.token0Decimals)}
                          </span>
                          <span className="text-slate-500 ml-1">{position.token0Symbol}</span>
                        </div>
                        <div className="text-sm">
                          <span className="text-purple-400 font-medium">
                            {formatFeeAmount(position.amount1, position.token1Decimals)}
                          </span>
                          <span className="text-slate-500 ml-1">{position.token1Symbol}</span>
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
            disabled={isCollecting || (!hasFees(selectedPosition) && selectedPosition.liquidity > 0n)}
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
                    ({formatFeeAmount(selectedPosition.tokensOwed0, selectedPosition.token0Decimals)} {selectedPosition.token0Symbol} + {formatFeeAmount(selectedPosition.tokensOwed1, selectedPosition.token1Decimals)} {selectedPosition.token1Symbol})
                  </span>
                )}
              </>
            )}
          </Button>

          {/* Refresh Button - Just reloads positions to get updated fees */}
          <Button
            onClick={loadPositions}
            disabled={isLoading}
            variant="ghost"
            className="w-full h-10 text-sm"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
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
            {selectedPosition.amount0 > 0n || selectedPosition.amount1 > 0n ? (
              <span className="ml-2 text-xs">
                ({formatFeeAmount(selectedPosition.amount0, selectedPosition.token0Decimals)} {selectedPosition.token0Symbol} + {formatFeeAmount(selectedPosition.amount1, selectedPosition.token1Decimals)} {selectedPosition.token1Symbol})
              </span>
            ) : null}
          </Button>
        </div>
      )}
    </div>
  );
}
