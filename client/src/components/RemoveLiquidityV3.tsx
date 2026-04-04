import { useState, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import { Contract, BrowserProvider } from "ethers";
import { getContractsForChain } from "@/lib/contracts";
import { getErrorForToast } from "@/lib/error-utils";
import { createAlchemyProvider } from "@/lib/config";
import { safeTokenInfo } from "@/lib/v3-pool-utils";
import { NONFUNGIBLE_POSITION_MANAGER_ABI, V3_POOL_ABI, V3_FACTORY_ABI, FEE_TIER_LABELS } from "@/lib/abis/v3";
import { formatAmount } from "@/lib/decimal-utils";
import { getTokensFromLiquidity } from "@/lib/v3-liquidity-math";
import { getTokensByChainId, fetchTokensWithCommunity, isWrappedToken } from "@/data/tokens";
import type { Token } from "@shared/schema";
import { ExternalLink, Trash2, Coins, RefreshCw, DollarSign, Wallet, ChevronRight, Zap, ArrowDown } from "lucide-react";

const MAX_UINT128 = 2n ** 128n - 1n;
const Q128 = 2n ** 128n;
const MASK256 = (1n << 256n) - 1n;
const SLIPPAGE_BPS = 100n; // 1%

function applySlippageMin(amount: bigint, bps: bigint = SLIPPAGE_BPS): bigint {
  if (amount <= 0n) return 0n;
  return (amount * (10_000n - bps)) / 10_000n;
}

// ─── Position cache ──────────────────────────────────────────────────────────
// Cache V3 positions in localStorage so the page shows data instantly on mount
// and refreshes in the background.

const POSITION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedPosition {
  tokenId: string;
  token0Address: string;
  token0Symbol: string;
  token0Decimals: number;
  token1Address: string;
  token1Symbol: string;
  token1Decimals: number;
  fee: number;
  liquidity: string;
  tickLower: number;
  tickUpper: number;
  tokensOwed0: string;
  tokensOwed1: string;
  unclaimedFees0: string;
  unclaimedFees1: string;
  amount0: string;
  amount1: string;
  currentTick?: number;
}

interface PositionCache {
  positions: CachedPosition[];
  timestamp: number;
}

function positionCacheKey(chainId: number, address: string): string {
  return `v3_positions_${chainId}_${address.toLowerCase()}`;
}

function readPositionCache(chainId: number, address: string): V3Position[] | null {
  try {
    const raw = localStorage.getItem(positionCacheKey(chainId, address));
    if (!raw) return null;
    const entry: PositionCache = JSON.parse(raw);
    if (Date.now() - entry.timestamp > POSITION_CACHE_TTL_MS) return null;
    return entry.positions.map((p) => ({
      ...p,
      tokenId: BigInt(p.tokenId),
      liquidity: BigInt(p.liquidity),
      tokensOwed0: BigInt(p.tokensOwed0),
      tokensOwed1: BigInt(p.tokensOwed1),
      unclaimedFees0: BigInt(p.unclaimedFees0),
      unclaimedFees1: BigInt(p.unclaimedFees1),
      amount0: BigInt(p.amount0),
      amount1: BigInt(p.amount1),
    }));
  } catch {
    return null;
  }
}

function writePositionCache(chainId: number, address: string, positions: V3Position[]): void {
  try {
    const entry: PositionCache = {
      positions: positions.map((p) => ({
        ...p,
        tokenId: p.tokenId.toString(),
        liquidity: p.liquidity.toString(),
        tokensOwed0: p.tokensOwed0.toString(),
        tokensOwed1: p.tokensOwed1.toString(),
        unclaimedFees0: p.unclaimedFees0.toString(),
        unclaimedFees1: p.unclaimedFees1.toString(),
        amount0: p.amount0.toString(),
        amount1: p.amount1.toString(),
      })),
      timestamp: Date.now(),
    };
    localStorage.setItem(positionCacheKey(chainId, address), JSON.stringify(entry));
  } catch {
    // storage quota exceeded — non-fatal
  }
}

function subU256(a: bigint, b: bigint): bigint {
  return (a - b) & MASK256;
}

// Retry helper for flaky RPC calls
async function rpcWithRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 500): Promise<T> {
  let lastError: Error | unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// Concurrency limiter to prevent overwhelming Alchemy RPC
function createLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
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
  unclaimedFees0: bigint;
  unclaimedFees1: bigint;
  amount0: bigint;
  amount1: bigint;
  currentTick?: number;
}

function getPositionStatus(currentTick: number | undefined, tickLower: number, tickUpper: number): "in-range" | "out-of-range" {
  if (currentTick === undefined) return "out-of-range";
  return currentTick >= tickLower && currentTick < tickUpper ? "in-range" : "out-of-range";
}

export function RemoveLiquidityV3() {
  const [positions, setPositions] = useState<V3Position[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<V3Position | null>(null);
  const [percentage, setPercentage] = useState([50]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isCollecting, setIsCollecting] = useState(false);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const [tokens, setTokens] = useState<Token[]>([]);

  const contracts = chainId ? getContractsForChain(chainId) : null;

  useEffect(() => {
    if (!chainId) return;
    fetchTokensWithCommunity(chainId).then(setTokens);
  }, [chainId]);

  const getTokenLogo = (symbol: string): string =>
    tokens.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase())?.logoURI ??
    "/img/logos/unknown-token.png";

  // Display helpers: show wUSDC as "USDC" in the UI since we auto-unwrap
  const getDisplaySymbol = (address: string, onChainSymbol: string): string =>
    isWrappedToken(chainId, address) ? "USDC" : onChainSymbol;

  const getDisplayLogo = (address: string, onChainSymbol: string): string =>
    isWrappedToken(chainId, address) ? getTokenLogo("USDC") : getTokenLogo(onChainSymbol);

  // ── Single-position loader ─────────────────────────────────────────────────
  // Re-fetches only one NFT position by tokenId. Used after collect/partial-remove
  // to avoid re-enumerating the entire list (saves N-1 positions worth of RPC calls).
  const refreshSinglePosition = async (tokenId: bigint): Promise<void> => {
    if (!address || !contracts || !chainId) return;
    try {
      const provider = createAlchemyProvider(chainId);
      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        provider,
      );
      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
      const knownTokenList = await fetchTokensWithCommunity(chainId);

      const position = await rpcWithRetry(() => positionManager.positions(tokenId));

      const token0Address: string = position[2];
      const token1Address: string = position[3];
      const fee = Number(position[4]);
      const tickLower = Number(position[5]);
      const tickUpper = Number(position[6]);
      const liquidity: bigint = position[7];
      const feeGrowthInside0LastX128: bigint = position[8];
      const feeGrowthInside1LastX128: bigint = position[9];
      const tokensOwed0: bigint = position[10];
      const tokensOwed1: bigint = position[11];

      const [info0, info1] = await Promise.all([
        safeTokenInfo(token0Address, provider, knownTokenList),
        safeTokenInfo(token1Address, provider, knownTokenList),
      ]);

      let amount0 = 0n;
      let amount1 = 0n;
      let unclaimedFees0 = tokensOwed0;
      let unclaimedFees1 = tokensOwed1;
      let currentTick: number | undefined = undefined;

      try {
        const [tokenA, tokenB] =
          token0Address.toLowerCase() < token1Address.toLowerCase()
            ? [token0Address, token1Address]
            : [token1Address, token0Address];

        const poolAddress = await rpcWithRetry(() => factory.getPool(tokenA, tokenB, fee));

        if (poolAddress && poolAddress !== "0x0000000000000000000000000000000000000000") {
          const pool = new Contract(poolAddress, V3_POOL_ABI, provider);

          const [slot0, feeGrowthGlobal0X128, feeGrowthGlobal1X128, tickLowerData, tickUpperData] =
            await Promise.all([
              rpcWithRetry(() => pool.slot0()),
              rpcWithRetry(() => pool.feeGrowthGlobal0X128()),
              rpcWithRetry(() => pool.feeGrowthGlobal1X128()),
              rpcWithRetry(() => pool.ticks(tickLower)),
              rpcWithRetry(() => pool.ticks(tickUpper)),
            ]);

          let currentSqrtPriceX96: bigint = slot0[0];
          currentTick = Number(slot0[1]);
          if (currentSqrtPriceX96 === 0n) currentSqrtPriceX96 = 2n ** 96n;

          const feeGrowthOutsideLower0: bigint = tickLowerData[2];
          const feeGrowthOutsideLower1: bigint = tickLowerData[3];
          const feeGrowthOutsideUpper0: bigint = tickUpperData[2];
          const feeGrowthOutsideUpper1: bigint = tickUpperData[3];

          if (liquidity > 0n) {
            unclaimedFees0 = calculateUnclaimedFees(
              liquidity,
              calculateFeeGrowthInside(feeGrowthGlobal0X128, feeGrowthOutsideLower0, feeGrowthOutsideUpper0, currentTick, tickLower, tickUpper),
              feeGrowthInside0LastX128,
              tokensOwed0,
            );
            unclaimedFees1 = calculateUnclaimedFees(
              liquidity,
              calculateFeeGrowthInside(feeGrowthGlobal1X128, feeGrowthOutsideLower1, feeGrowthOutsideUpper1, currentTick, tickLower, tickUpper),
              feeGrowthInside1LastX128,
              tokensOwed1,
            );
          }

          const tokenAmounts = getTokensFromLiquidity(liquidity, currentSqrtPriceX96, tickLower, tickUpper);
          if (token0Address.toLowerCase() === tokenB.toLowerCase()) {
            amount0 = tokenAmounts.amount1;
            amount1 = tokenAmounts.amount0;
          } else {
            amount0 = tokenAmounts.amount0;
            amount1 = tokenAmounts.amount1;
          }
        }
      } catch (poolError) {
        console.error("Error fetching pool data for single position:", poolError);
      }

      const updated: V3Position = {
        tokenId,
        token0Address,
        token0Symbol: info0.symbol,
        token0Decimals: info0.decimals,
        token1Address,
        token1Symbol: info1.symbol,
        token1Decimals: info1.decimals,
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
        currentTick,
      };

      setPositions((prev) => {
        const next = prev.map((p) => (p.tokenId === tokenId ? updated : p));
        if (address && chainId) writePositionCache(chainId, address, next);
        return next;
      });
      setSelectedPosition(updated);
    } catch (err) {
      console.error("Failed to refresh single position:", err);
    }
  };

  const loadPositions = async () => {
    if (!address || !contracts || !chainId) return;

    const cached = readPositionCache(chainId, address);
    if (cached && cached.length > 0 && positions.length === 0) {
      setPositions(cached);
    }

    setIsLoading(true);
    try {
      const provider = createAlchemyProvider(chainId);
      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        provider,
      );
      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
      const knownTokenList = await fetchTokensWithCommunity(chainId);

      // Concurrency limiter: max 6 simultaneous RPC calls (Alchemy free tier handles ~10/sec)
      const run = createLimiter(6);

      const balance = await run(() => rpcWithRetry(() => positionManager.balanceOf(address)));
      const count = Number(balance);

      if (count === 0) {
        setPositions([]);
        writePositionCache(chainId, address, []);
        toast({
          title: "No V3 positions found",
          description: "You don't have any V3 liquidity positions",
        });
        return;
      }

      // Phase 1: Fetch ALL tokenIds with concurrency limit
      const indices = Array.from({ length: count }, (_, i) => i);
      const tokenIds = await Promise.all(
        indices.map((i) => run(() => rpcWithRetry(() => positionManager.tokenOfOwnerByIndex(address, i))))
      );

      // Phase 2: Fetch ALL raw position structs with concurrency limit
      const rawPositions = await Promise.all(
        tokenIds.map((id) => run(() => rpcWithRetry(() => positionManager.positions(id))))
      );

      // Phase 3: Fetch ALL position details with concurrency limit
      const fetchPosition = async (absoluteIdx: number): Promise<V3Position | null> => {
        const position = rawPositions[absoluteIdx];
        const tokenId = tokenIds[absoluteIdx];
        const token0Address: string = position[2];
        const token1Address: string = position[3];
        const fee = Number(position[4]);
        const tickLower = Number(position[5]);
        const tickUpper = Number(position[6]);
        const liquidity: bigint = position[7];
        const feeGrowthInside0LastX128: bigint = position[8];
        const feeGrowthInside1LastX128: bigint = position[9];
        const tokensOwed0: bigint = position[10];
        const tokensOwed1: bigint = position[11];

        const [info0, info1] = await Promise.all([
          run(() => safeTokenInfo(token0Address, provider, knownTokenList)),
          run(() => safeTokenInfo(token1Address, provider, knownTokenList)),
        ]);

        let amount0 = 0n;
        let amount1 = 0n;
        let unclaimedFees0 = tokensOwed0;
        let unclaimedFees1 = tokensOwed1;
        let currentTick: number | undefined = undefined;

        try {
          const [tokenA, tokenB] =
            token0Address.toLowerCase() < token1Address.toLowerCase()
              ? [token0Address, token1Address]
              : [token1Address, token0Address];

          const poolAddress = await run(() => rpcWithRetry(() => factory.getPool(tokenA, tokenB, fee)));

          if (poolAddress && poolAddress !== "0x0000000000000000000000000000000000000000") {
            const pool = new Contract(poolAddress, V3_POOL_ABI, provider);

            const [
              slot0,
              feeGrowthGlobal0X128,
              feeGrowthGlobal1X128,
              tickLowerData,
              tickUpperData,
            ] = await Promise.all([
              run(() => rpcWithRetry(() => pool.slot0())),
              run(() => rpcWithRetry(() => pool.feeGrowthGlobal0X128())),
              run(() => rpcWithRetry(() => pool.feeGrowthGlobal1X128())),
              run(() => rpcWithRetry(() => pool.ticks(tickLower))),
              run(() => rpcWithRetry(() => pool.ticks(tickUpper))),
            ]);

            let currentSqrtPriceX96: bigint = slot0[0];
            currentTick = Number(slot0[1]);
            if (currentSqrtPriceX96 === 0n) currentSqrtPriceX96 = 2n ** 96n;

            const feeGrowthOutsideLower0: bigint = tickLowerData[2];
            const feeGrowthOutsideLower1: bigint = tickLowerData[3];
            const feeGrowthOutsideUpper0: bigint = tickUpperData[2];
            const feeGrowthOutsideUpper1: bigint = tickUpperData[3];

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

            const tokenAmounts = getTokensFromLiquidity(
              liquidity,
              currentSqrtPriceX96,
              tickLower,
              tickUpper,
            );

            if (token0Address.toLowerCase() === tokenB.toLowerCase()) {
              amount0 = tokenAmounts.amount1;
              amount1 = tokenAmounts.amount0;
            } else {
              amount0 = tokenAmounts.amount0;
              amount1 = tokenAmounts.amount1;
            }
          }
        } catch (poolError) {
          console.error(`Error fetching pool data for position ${tokenId}:`, poolError);
        }

        return {
          tokenId,
          token0Address,
          token0Symbol: info0.symbol,
          token0Decimals: info0.decimals,
          token1Address,
          token1Symbol: info1.symbol,
          token1Decimals: info1.decimals,
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
          currentTick,
        };
      };

      const userPositions = await Promise.all(
        Array.from({ length: rawPositions.length }, (_, i) => i).map((idx) => run(() => fetchPosition(idx)))
      );

      // Auto-retry incomplete positions (currentTick undefined + liquidity > 0)
      const incompleteIndices = userPositions
        .map((p, i) => (p && p.currentTick === undefined && p.liquidity > 0n ? i : -1))
        .filter((i) => i !== -1);

      let finalPositions = [...userPositions];
      if (incompleteIndices.length > 0) {
        console.log(`Retrying ${incompleteIndices.length} incomplete positions...`);
        const retryResults = await Promise.all(
          incompleteIndices.map((idx) => run(() => fetchPosition(idx)))
        );
        for (let i = 0; i < incompleteIndices.length; i++) {
          finalPositions[incompleteIndices[i]] = retryResults[i];
        }
      }

      const validPositions = finalPositions.filter((p): p is V3Position => p !== null);
      setPositions(validPositions);
      writePositionCache(chainId, address, validPositions);

      if (validPositions.length === 0) {
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

  const handleCollectFees = async () => {
    if (!selectedPosition || !address || !contracts || !window.ethereum) return;
    setIsCollecting(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer,
      );

      toast({ title: "Collecting fees…", description: "Claiming your trading fees" });

      // Detect if either token is wUSDC so we can auto-unwrap to native USDC
      const token0IsWrapped = isWrappedToken(chainId, selectedPosition.token0Address);
      const token1IsWrapped = isWrappedToken(chainId, selectedPosition.token1Address);
      const hasWrappedToken = token0IsWrapped || token1IsWrapped;

      let receipt;

      if (hasWrappedToken) {
        // Collect to position manager, then unwrap wUSDC and sweep other token
        const collectRecipient = contracts.v3.nonfungiblePositionManager;

        const collectData = positionManager.interface.encodeFunctionData("collect", [
          {
            tokenId: selectedPosition.tokenId,
            recipient: collectRecipient,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ]);

        const unwrapData = positionManager.interface.encodeFunctionData("unwrapWETH9", [
          0n,
          address,
        ]);

        const otherToken = token0IsWrapped
          ? selectedPosition.token1Address
          : selectedPosition.token0Address;
        const sweepData = positionManager.interface.encodeFunctionData("sweepToken", [
          otherToken,
          0n,
          address,
        ]);

        const multicallTx = await positionManager.multicall([collectData, unwrapData, sweepData]);
        receipt = await multicallTx.wait();
      } else {
        // No wrapped token — collect directly to user
        const collectTx = await positionManager.collect({
          tokenId: selectedPosition.tokenId,
          recipient: address,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        });
        receipt = await collectTx.wait();
      }

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
        } catch {}
      }

      await refreshSinglePosition(selectedPosition.tokenId);

      const display0 = getDisplaySymbol(selectedPosition.token0Address, selectedPosition.token0Symbol);
      const display1 = getDisplaySymbol(selectedPosition.token1Address, selectedPosition.token1Symbol);

      toast({
        title: "Fees collected!",
        description: (
          <div className="flex flex-col gap-1">
            <span>
              Collected: {formatAmount(amount0Collected, selectedPosition.token0Decimals)}{" "}
              {display0} +{" "}
              {formatAmount(amount1Collected, selectedPosition.token1Decimals)}{" "}
              {display1}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 w-fit"
              onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}
            >
              <ExternalLink className="h-3 w-3 mr-1" /> View Transaction
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error("Collect fees error:", error);
      const errorInfo = getErrorForToast(error);
      toast({
        title: errorInfo.title,
        description: errorInfo.description,
        rawError: errorInfo.rawError,
        variant: "destructive",
      });
    } finally {
      setIsCollecting(false);
    }
  };

  const handleRemove = async () => {
    if (!selectedPosition || !address || !contracts || !window.ethereum) return;
    setIsRemoving(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer,
      );

      // Re-fetch latest on-chain position/pool state before deriving mins
      const readProvider = createAlchemyProvider(chainId);
      const readPositionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        readProvider,
      );
      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, readProvider);
      const latestPositionRaw = await readPositionManager.positions(selectedPosition.tokenId);
      const latestToken0Address: string = latestPositionRaw[2];
      const latestToken1Address: string = latestPositionRaw[3];
      const latestFee = Number(latestPositionRaw[4]);
      const latestTickLower = Number(latestPositionRaw[5]);
      const latestTickUpper = Number(latestPositionRaw[6]);
      const latestLiquidity: bigint = latestPositionRaw[7];

      if (latestLiquidity === 0n) {
        throw new Error("Position has no liquidity to remove");
      }

      const [tokenA, tokenB] =
        latestToken0Address.toLowerCase() < latestToken1Address.toLowerCase()
          ? [latestToken0Address, latestToken1Address]
          : [latestToken1Address, latestToken0Address];
      const poolAddress = await factory.getPool(tokenA, tokenB, latestFee);
      if (!poolAddress || poolAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("Pool not found for position");
      }

      const pool = new Contract(poolAddress, V3_POOL_ABI, readProvider);
      const slot0 = await pool.slot0();
      let currentSqrtPriceX96: bigint = slot0[0];
      if (currentSqrtPriceX96 === 0n) currentSqrtPriceX96 = 2n ** 96n;

      const tokenAmounts = getTokensFromLiquidity(
        latestLiquidity,
        currentSqrtPriceX96,
        latestTickLower,
        latestTickUpper,
      );
      const latestAmount0 = latestToken0Address.toLowerCase() === tokenB.toLowerCase()
        ? tokenAmounts.amount1
        : tokenAmounts.amount0;
      const latestAmount1 = latestToken0Address.toLowerCase() === tokenB.toLowerCase()
        ? tokenAmounts.amount0
        : tokenAmounts.amount1;

      const liquidityToRemove = latestLiquidity * BigInt(percentage[0]) / 100n;
      const isFullRemove = percentage[0] === 100;
      const expectedAmount0Out = (latestAmount0 * BigInt(percentage[0])) / 100n;
      const expectedAmount1Out = (latestAmount1 * BigInt(percentage[0])) / 100n;
      const amount0Min = applySlippageMin(expectedAmount0Out);
      const amount1Min = applySlippageMin(expectedAmount1Out);

      toast({
        title: isFullRemove ? "Removing liquidity…" : `Removing ${percentage[0]}% of liquidity…`,
        description: isFullRemove 
          ? "Decreasing liquidity, collecting tokens, and burning NFT"
          : "Decreasing liquidity and collecting tokens",
      });

      const decreaseData = positionManager.interface.encodeFunctionData("decreaseLiquidity", [
        {
          tokenId: selectedPosition.tokenId,
          liquidity: liquidityToRemove,
          amount0Min,
          amount1Min,
          deadline: Math.floor(Date.now() / 1000) + 1200,
        },
      ]);

      // Detect if either token is wUSDC so we can auto-unwrap to native USDC
      const token0IsWrapped = isWrappedToken(chainId, latestToken0Address);
      const token1IsWrapped = isWrappedToken(chainId, latestToken1Address);
      const hasWrappedToken = token0IsWrapped || token1IsWrapped;

      // If a wrapped token is involved, collect to the position manager (so it can unwrap),
      // otherwise collect directly to the user
      const collectRecipient = hasWrappedToken
        ? contracts.v3.nonfungiblePositionManager
        : address;

      const collectData = positionManager.interface.encodeFunctionData("collect", [
        {
          tokenId: selectedPosition.tokenId,
          recipient: collectRecipient,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ]);

      let calls = [decreaseData, collectData];

      // When we collected to the position manager, unwrap wUSDC and sweep the other token
      if (hasWrappedToken) {
        // unwrapWETH9 converts wUSDC held by the contract to native USDC and sends to user
        const unwrapData = positionManager.interface.encodeFunctionData("unwrapWETH9", [
          0n,
          address,
        ]);
        calls.push(unwrapData);

        // sweepToken sends the non-wUSDC token held by the contract back to user
        const otherToken = token0IsWrapped
          ? latestToken1Address
          : latestToken0Address;
        const sweepData = positionManager.interface.encodeFunctionData("sweepToken", [
          otherToken,
          0n,
          address,
        ]);
        calls.push(sweepData);
      }

      if (isFullRemove) {
        const burnData = positionManager.interface.encodeFunctionData("burn", [
          selectedPosition.tokenId,
        ]);
        calls.push(burnData);
      }

      const multicallTx = await positionManager.multicall(calls);
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
        } catch {}
      }

      const display0 = getDisplaySymbol(selectedPosition.token0Address, selectedPosition.token0Symbol);
      const display1 = getDisplaySymbol(selectedPosition.token1Address, selectedPosition.token1Symbol);

      toast({
        title: isFullRemove ? "Liquidity removed!" : `Removed ${percentage[0]}% of liquidity!`,
        description: (
          <div className="flex flex-col gap-1">
            <span>
              Removed: {formatAmount(amount0Collected, selectedPosition.token0Decimals)}{" "}
              {display0} +{" "}
              {formatAmount(amount1Collected, selectedPosition.token1Decimals)}{" "}
              {display1}
            </span>
            {isFullRemove && <span className="text-xs opacity-60">NFT position burned</span>}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 w-fit"
              onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}
            >
              <ExternalLink className="h-3 w-3 mr-1" /> View Transaction
            </Button>
          </div>
        ),
      });

      if (isFullRemove) {
        // NFT was burned on-chain — remove from state without any RPC call
        setPositions((prev) => {
          const next = prev.filter((p) => p.tokenId !== selectedPosition.tokenId);
          if (address && chainId) writePositionCache(chainId, address, next);
          return next;
        });
        setSelectedPosition(null);
      } else {
        // Partial remove — only re-fetch this one position
        await refreshSinglePosition(selectedPosition.tokenId);
      }
      setPercentage([50]);
    } catch (error: any) {
      console.error("Remove liquidity error:", error);
      const errorInfo = getErrorForToast(error);
      toast({
        title: errorInfo.title,
        description: errorInfo.description,
        rawError: errorInfo.rawError,
        variant: "destructive",
      });
    } finally {
      setIsRemoving(false);
    }
  };

  useEffect(() => {
    if (isConnected && address) loadPositions();
  }, [isConnected, address, chainId]);

  const fmt = (amount: bigint, decimals: number): string =>
    amount === 0n ? "0" : formatAmount(amount, decimals);

  const fmtCompact = (amount: bigint, decimals: number): string => {
    const num = parseFloat(formatAmount(amount, decimals));
    if (num === 0) return "0";
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + "B";
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(2) + "K";
    return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  };

  const hasFees = (p: V3Position) =>
    p.unclaimedFees0 > 0n || p.unclaimedFees1 > 0n;

  const previewAmounts = useMemo(() => {
    if (!selectedPosition) return null;
    const percent = BigInt(percentage[0]);
    if (percent === 0n) return { amount0: 0n, amount1: 0n };

    const amount0 = selectedPosition.amount0 * percent / 100n;
    const amount1 = selectedPosition.amount1 * percent / 100n;

    return { amount0, amount1 };
  }, [selectedPosition, percentage]);

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="w-full max-w-md mx-auto px-3 py-4 sm:px-4 sm:py-8">
        <Card className="border-border/40 bg-card/95 backdrop-blur-sm">
          <CardContent className="flex flex-col items-center justify-center py-14 px-6 gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-muted/60 flex items-center justify-center">
              <Wallet className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="font-semibold text-base">Wallet not connected</p>
            <p className="text-sm text-muted-foreground">
              Connect your wallet to view and manage your V3 positions
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="w-full max-w-md mx-auto px-3 py-4 sm:px-4 sm:py-8 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="border-border/40 bg-card/60 animate-pulse">
            <CardContent className="p-4">
              <div className="h-4 w-1/3 rounded bg-muted/60 mb-3" />
              <div className="h-3 w-1/2 rounded bg-muted/40 mb-2" />
              <div className="h-12 rounded-lg bg-muted/30" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // ── Empty ──────────────────────────────────────────────────────────────────
  if (positions.length === 0) {
    return (
      <div className="w-full max-w-md mx-auto px-3 py-4 sm:px-4 sm:py-8">
        <Card className="border-border/40 bg-card/95 backdrop-blur-sm">
          <CardContent className="flex flex-col items-center justify-center py-14 px-6 gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-muted/60 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="font-semibold text-base">No positions found</p>
            <p className="text-sm text-muted-foreground">
              You don't have any V3 liquidity positions yet
            </p>
            <Button variant="outline" size="sm" onClick={loadPositions} className="gap-2 mt-1">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Main ───────────────────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-md mx-auto px-3 py-4 sm:px-4 sm:py-8 space-y-3">

      {positions.map((position, index) => {
        const isSelected = selectedPosition?.tokenId === position.tokenId;
        const feesAvailable = hasFees(position);
        const feeTierLabel =
          FEE_TIER_LABELS[position.fee as keyof typeof FEE_TIER_LABELS] ??
          `${(position.fee / 10_000).toFixed(2)}%`;

        // Resolve display names: wUSDC -> USDC since we auto-unwrap
        const display0Symbol = getDisplaySymbol(position.token0Address, position.token0Symbol);
        const display1Symbol = getDisplaySymbol(position.token1Address, position.token1Symbol);
        const display0Logo = getDisplayLogo(position.token0Address, position.token0Symbol);
        const display1Logo = getDisplayLogo(position.token1Address, position.token1Symbol);

        return (
          <Card
            key={index}
            onClick={() => setSelectedPosition(isSelected ? null : position)}
            className={`border transition-all cursor-pointer overflow-hidden ${
              isSelected
                ? "border-primary/50 bg-card/95 shadow-lg shadow-primary/10"
                : "border-border/40 bg-card/60 hover:border-border/70 hover:bg-card/80"
            }`}
          >
            <CardContent className="p-0">

              {/* ── Header row ── */}
              <div className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3 min-w-0">

                  {/* Overlapping token logos */}
                  <div className="relative w-10 h-7 flex-shrink-0">
                    <img
                      src={display0Logo}
                      alt={display0Symbol}
                      className="w-7 h-7 rounded-full border-2 border-background object-cover absolute left-0 top-0 z-10"
                      onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                    />
                    <img
                      src={display1Logo}
                      alt={display1Symbol}
                      className="w-7 h-7 rounded-full border-2 border-background object-cover absolute left-4 top-0"
                      onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                    />
                  </div>

                  <div className="min-w-0 pl-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-bold text-sm">
                        {display0Symbol}/{display1Symbol}
                      </span>
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20">
                        {feeTierLabel}
                      </span>
                      {position.liquidity > 0n && (
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                          getPositionStatus(position.currentTick, position.tickLower, position.tickUpper) === "in-range"
                            ? "bg-orange-500/15 text-orange-400 border border-orange-500/20"
                            : "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                        }`}>
                          {getPositionStatus(position.currentTick, position.tickLower, position.tickUpper) === "in-range" ? "In Range" : "Out of Range"}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      #{position.tokenId.toString()} · V3 Position
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {feesAvailable && (
                    <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">
                      <Zap className="w-2.5 h-2.5" />
                      Fees
                    </span>
                  )}
                  <ChevronRight
                    className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${
                      isSelected ? "rotate-90" : ""
                    }`}
                  />
                </div>
              </div>

              {/* ── Expanded detail ── */}
              {isSelected && (
                <div className="border-t border-border/30 divide-y divide-border/20">

                  {/* Liquidity value */}
                  {(position.amount0 > 0n || position.amount1 > 0n) && (
                    <div className="px-4 py-3 bg-muted/10">
                      <div className="flex items-center gap-1.5 mb-2.5">
                        <Coins className="w-3 h-3 text-primary/70" />
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Liquidity Value
                        </span>
                      </div>
                      <div className="flex gap-6">
                        <div className="flex items-center gap-2">
                          <img
                            src={display0Logo}
                            alt={display0Symbol}
                            className="w-5 h-5 rounded-full flex-shrink-0"
                            onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                          />
                          <div>
                            <p className="text-sm font-semibold tabular-nums">
                              {fmtCompact(position.amount0, position.token0Decimals)}
                            </p>
                            <p className="text-[11px] text-muted-foreground">{display0Symbol}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <img
                            src={display1Logo}
                            alt={display1Symbol}
                            className="w-5 h-5 rounded-full flex-shrink-0"
                            onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                          />
                          <div>
                            <p className="text-sm font-semibold tabular-nums">
                              {fmtCompact(position.amount1, position.token1Decimals)}
                            </p>
                            <p className="text-[11px] text-muted-foreground">{display1Symbol}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Uncollected fees */}
                  <div className="px-4 py-3 bg-muted/10">
                    <div className="flex items-center gap-1.5 mb-2.5">
                      <DollarSign className="w-3 h-3 text-green-400/70" />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Uncollected Fees
                      </span>
                    </div>
                    <div className="flex gap-6">
                      <div className="flex items-center gap-2">
                        <img
                          src={display0Logo}
                          alt={display0Symbol}
                          className="w-5 h-5 rounded-full flex-shrink-0"
                          onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                        />
                        <div>
                          <p className={`text-sm font-semibold tabular-nums ${feesAvailable ? "text-green-400" : "text-muted-foreground"}`}>
                            {fmt(position.unclaimedFees0, position.token0Decimals)}
                          </p>
                          <p className="text-[11px] text-muted-foreground">{display0Symbol}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <img
                          src={display1Logo}
                          alt={display1Symbol}
                          className="w-5 h-5 rounded-full flex-shrink-0"
                          onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                        />
                        <div>
                          <p className={`text-sm font-semibold tabular-nums ${feesAvailable ? "text-green-400" : "text-muted-foreground"}`}>
                            {fmt(position.unclaimedFees1, position.token1Decimals)}
                          </p>
                          <p className="text-[11px] text-muted-foreground">{display1Symbol}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Percentage selector */}
                  <div className="px-4 py-3 bg-muted/10">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-medium text-muted-foreground">Remove amount</span>
                      <span className="text-2xl font-bold text-primary tabular-nums">
                        {percentage[0]}%
                      </span>
                    </div>

                    <div 
                      className="relative py-2 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      <Slider
                        value={percentage}
                        onValueChange={setPercentage}
                        max={100}
                        step={1}
                        className="py-1"
                      />
                    </div>

                    <div className="grid grid-cols-4 gap-1.5 mt-3">
                      {[25, 50, 75, 100].map((value) => (
                        <button
                          key={value}
                          onClick={(e) => { e.stopPropagation(); setPercentage([value]); }}
                          className={`py-2.5 rounded-lg text-xs font-semibold transition-all min-h-[44px] flex items-center justify-center touch-manipulation ${
                            percentage[0] === value
                              ? "bg-primary text-primary-foreground shadow-sm"
                              : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                          }`}
                        >
                          {value === 100 ? "MAX" : `${value}%`}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Preview amount to receive */}
                  {previewAmounts && (previewAmounts.amount0 > 0n || previewAmounts.amount1 > 0n) && (
                    <div className="px-4 py-3 bg-muted/10">
                      <div className="flex items-center gap-1.5 mb-2.5">
                        <ArrowDown className="w-3 h-3 text-primary/70" />
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Liquidity to receive
                        </span>
                      </div>
                      <div className="flex gap-6">
                        <div className="flex items-center gap-2">
                          <img
                            src={display0Logo}
                            alt={display0Symbol}
                            className="w-5 h-5 rounded-full flex-shrink-0"
                            onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                          />
                          <div>
                            <p className="text-sm font-semibold tabular-nums">
                              {fmtCompact(previewAmounts.amount0, position.token0Decimals)}
                            </p>
                            <p className="text-[11px] text-muted-foreground">{display0Symbol}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <img
                            src={display1Logo}
                            alt={display1Symbol}
                            className="w-5 h-5 rounded-full flex-shrink-0"
                            onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                          />
                          <div>
                            <p className="text-sm font-semibold tabular-nums">
                              {fmtCompact(previewAmounts.amount1, position.token1Decimals)}
                            </p>
                            <p className="text-[11px] text-muted-foreground">{display1Symbol}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="px-4 py-3 space-y-2 bg-muted/5">
                    <Button
                      onClick={(e) => { e.stopPropagation(); handleCollectFees(); }}
                      disabled={isCollecting || !feesAvailable}
                      variant="outline"
                      className="w-full h-11 text-sm font-semibold bg-green-600/20 border border-green-500/40 hover:bg-green-600/30 text-green-400 hover:text-green-300 transition-all"
                    >
                      {isCollecting ? (
                        <span className="flex items-center gap-2">
                          <span className="w-3.5 h-3.5 border-2 border-green-400/30 border-t-green-400 rounded-full animate-spin" />
                          Collecting…
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Coins className="w-4 h-4" />
                          Collect Fees
                          {feesAvailable && (
                            <span className="text-xs opacity-70">
                              ({fmt(position.unclaimedFees0, position.token0Decimals)} +{" "}
                              {fmt(position.unclaimedFees1, position.token1Decimals)})
                            </span>
                          )}
                        </span>
                      )}
                    </Button>

                    <Button
                      onClick={(e) => { e.stopPropagation(); handleRemove(); }}
                      disabled={isRemoving || position.liquidity === 0n}
                      variant="destructive"
                      className="w-full h-11 text-sm font-semibold disabled:opacity-40"
                    >
                      {isRemoving ? (
                        <span className="flex items-center gap-2">
                          <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Removing…
                        </span>
                      ) : percentage[0] === 100 ? (
                        <span className="flex items-center gap-2">
                          <Trash2 className="w-4 h-4" />
                          Remove 100% & Burn NFT
                        </span>
                      ) : (
                        `Remove ${percentage[0]}% Liquidity`
                      )}
                    </Button>
                  </div>

                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* ── Refresh ── */}
      <Button
        onClick={loadPositions}
        disabled={isLoading}
        variant="ghost"
        className="w-full h-10 text-sm text-muted-foreground hover:text-foreground gap-2"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
        {isLoading ? "Refreshing…" : "Refresh Positions"}
      </Button>

    </div>
  );
}
