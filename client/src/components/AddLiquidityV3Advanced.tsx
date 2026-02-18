import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, formatUnits } from "ethers";
import { getTokensByChainId, isNativeToken, getWrappedAddress } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI, V3_FACTORY_ABI, V3_POOL_ABI, V3_FEE_TIERS,
} from "@/lib/abis/v3";
import {
  priceToSqrtPriceX96, sqrtPriceX96ToPrice, priceToTick, tickToPrice,
  getNearestUsableTick, getTickSpacing, sortTokens, isPositionInRange, getFullRangeTicks,
} from "@/lib/v3-utils";
import { calculateAmountsForLiquidity } from "@/lib/v3-liquidity-math";
import {
  AlertTriangle, Zap, ExternalLink, TrendingUp, TrendingDown,
  Info, Settings, BarChart3, Shield, Layers, Target, Activity,
} from "lucide-react";
import { PriceRangeChart } from "./PriceRangeChart";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

function getERC20Address(token: Token, chainId: number): string {
  if (isNativeToken(token.address)) {
    const wrapped = getWrappedAddress(chainId, token.address);
    return wrapped || token.address;
  }
  return token.address;
}

type DepositMode = "dual" | "token0-only" | "token1-only" | "unknown";

/**
 * Format a counterpart amount for display.
 * Uses full formatUnits precision to avoid rounding very small values to "0.000000".
 * Shows up to 8 significant decimal places for reasonable UX, but never loses precision
 * that would cause amount to display as zero.
 */
function formatCounterpartAmount(raw: bigint, decimals: number): string {
  const full = formatUnits(raw, decimals); // e.g. "0.000000000123456789"
  const num = parseFloat(full);
  if (num === 0 && raw > 0n) {
    // Too small for float representation — return raw string so parseAmount can recover it
    return full;
  }
  if (num !== 0 && Math.abs(num) < 0.00000001) {
    // Very small but representable — show enough sig figs
    return num.toPrecision(6);
  }
  // Normal range — 8 decimal places, strip trailing zeros
  return parseFloat(num.toFixed(8)).toString();
}

export function AddLiquidityV3Advanced() {
  const [tokenA, setTokenA] = useState<Token | null>(null);
  const [tokenB, setTokenB] = useState<Token | null>(null);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [showTokenASelector, setShowTokenASelector] = useState(false);
  const [showTokenBSelector, setShowTokenBSelector] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selectedFee, setSelectedFee] = useState<number>(V3_FEE_TIERS.MEDIUM);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minTick, setMinTick] = useState("");
  const [maxTick, setMaxTick] = useState("");
  const [useTickMode, setUseTickMode] = useState(false);
  const [slippage, setSlippage] = useState("2");
  const [poolExists, setPoolExists] = useState(false);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [currentSqrtPriceX96, setCurrentSqrtPriceX96] = useState<bigint | null>(null);
  const [currentTick, setCurrentTick] = useState<number | null>(null);
  const [poolLiquidity, setPoolLiquidity] = useState<bigint>(0n);
  const [token0Symbol, setToken0Symbol] = useState("");
  const [token1Symbol, setToken1Symbol] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [balanceA, setBalanceA] = useState<bigint | null>(null);
  const [balanceB, setBalanceB] = useState<bigint | null>(null);
  const [amountBIsAuto, setAmountBIsAuto] = useState(false);

  // ─── Store raw bigint amounts calculated by V3 math so handleAddLiquidity
  // can use them directly without re-parsing the (possibly-rounded) display string.
  // Keyed to the current amountA value so they stay in sync.
  const [autoCalcAmounts, setAutoCalcAmounts] = useState<{
    amount0: bigint;
    amount1: bigint;
    forAmountA: string; // the amountA these were calculated from
  } | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  const contracts = chainId ? getContractsForChain(chainId) : null;

  const feeOptions = [
    { value: V3_FEE_TIERS.LOWEST,     label: "0.01%", description: "Very stable pairs" },
    { value: V3_FEE_TIERS.LOW,        label: "0.05%", description: "Stable pairs" },
    { value: V3_FEE_TIERS.MEDIUM,     label: "0.3%",  description: "Most pairs" },
    { value: V3_FEE_TIERS.HIGH,       label: "1%",    description: "Exotic/volatile pairs" },
    { value: V3_FEE_TIERS.ULTRA_HIGH, label: "10%",   description: "Very exotic pairs" },
  ];

  const getSortedTokens = useCallback(() => {
    if (!tokenA || !tokenB || !chainId) return null;
    const erc20A = getERC20Address(tokenA, chainId);
    const erc20B = getERC20Address(tokenB, chainId);
    const [tok0, tok1] = sortTokens({ ...tokenA, address: erc20A }, { ...tokenB, address: erc20B });
    const isToken0A = erc20A.toLowerCase() === tok0.address.toLowerCase();
    return { tok0, tok1, isToken0A };
  }, [tokenA, tokenB, chainId]);

  // What the pool will accept given current price vs selected range
  const depositMode = useMemo((): DepositMode => {
    if (currentTick === null || !minTick || !maxTick) return "unknown";
    const tl = parseInt(minTick), tu = parseInt(maxTick);
    if (isNaN(tl) || isNaN(tu) || tl >= tu) return "unknown";
    if (currentTick < tl) return "token0-only";   // price below range
    if (currentTick >= tu) return "token1-only";  // price above range
    return "dual";
  }, [currentTick, minTick, maxTick]);

  const capitalEfficiency = useMemo(() => {
    if (!currentPrice || !minPrice || !maxPrice || depositMode !== "dual") return null;
    const minP = parseFloat(minPrice), maxP = parseFloat(maxPrice);
    if (!minP || !maxP || minP <= 0 || maxP <= minP) return null;
    try {
      const sqrtC = Math.sqrt(currentPrice), sqrtMin = Math.sqrt(minP), sqrtMax = Math.sqrt(maxP);
      if (sqrtC <= sqrtMin || sqrtC >= sqrtMax) return null;
      return Math.min(Math.round((sqrtC / (sqrtC - sqrtMin)) * (sqrtMax / (sqrtMax - sqrtC))), 9999);
    } catch { return null; }
  }, [currentPrice, minPrice, maxPrice, depositMode]);

  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    const imported: Token[] = JSON.parse(localStorage.getItem("importedTokens") || "[]");
    setTokens([...chainTokens, ...imported.filter((t) => t.chainId === chainId)]);
  }, [chainId]);

  useEffect(() => {
    if (tokens.length === 0) return;
    if (!tokenA) { const t = tokens.find((t) => t.symbol === "USDC"); if (t) setTokenA(t); }
    if (!tokenB) { const t = tokens.find((t) => t.symbol === "ACHS"); if (t) setTokenB(t); }
  }, [tokens, tokenA, tokenB]);

  const handleImportToken = async (addr: string): Promise<Token | null> => {
    try {
      if (!addr || addr.length !== 42 || !addr.startsWith("0x")) throw new Error("Invalid token address format");
      const exists = tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());
      if (exists) { toast({ title: "Token already added", description: `${exists.symbol} is in your list` }); return exists; }
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const res = await fetch("https://rpc.testnet.arc.network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          const data = await res.json(); if (data.error) throw new Error(data.error.message); return data.result;
        },
      });
      const META_ABI = ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
      const contract = new Contract(addr, META_ABI, provider);
      const timeout = new Promise<never>((_, r) => setTimeout(() => r(new Error("Request timed out")), 10000));
      const [name, symbol, decimals] = (await Promise.race([Promise.all([contract.name(), contract.symbol(), contract.decimals()]), timeout])) as [string, string, bigint];
      if (!chainId) throw new Error("Chain ID not available");
      const newToken: Token = { address: addr, name, symbol, decimals: Number(decimals), logoURI: "/img/logos/unknown-token.png", verified: false, chainId };
      const imported: Token[] = JSON.parse(localStorage.getItem("importedTokens") || "[]");
      if (!imported.find((t) => t.address.toLowerCase() === addr.toLowerCase())) { imported.push(newToken); localStorage.setItem("importedTokens", JSON.stringify(imported)); }
      setTokens((prev) => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} added` });
      return newToken;
    } catch (error: any) {
      toast({ title: "Import failed", description: error.message.includes("timeout") ? "Request timed out." : "Unable to fetch token data.", variant: "destructive" });
      return null;
    }
  };

  useEffect(() => {
    if (!address || !window.ethereum || !tokenA || !tokenB || !chainId) return;
    (async () => {
      try {
        const provider = new BrowserProvider(window.ethereum);
        if (isNativeToken(tokenA.address)) setBalanceA(await provider.getBalance(address));
        else { const c = new Contract(getERC20Address(tokenA, chainId), ERC20_ABI, provider); setBalanceA(await c.balanceOf(address)); }
        if (isNativeToken(tokenB.address)) setBalanceB(await provider.getBalance(address));
        else { const c = new Contract(getERC20Address(tokenB, chainId), ERC20_ABI, provider); setBalanceB(await c.balanceOf(address)); }
      } catch (err) { console.error("Balance error:", err); }
    })();
  }, [address, tokenA, tokenB, chainId]);

  useEffect(() => {
    if (!tokenA || !tokenB || !contracts || !window.ethereum || !chainId) return;
    (async () => {
      try {
        const provider = new BrowserProvider(window.ethereum);
        const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
        const s = getSortedTokens(); if (!s) return;
        const { tok0, tok1 } = s;
        setToken0Symbol(tok0.symbol); setToken1Symbol(tok1.symbol);
        const poolAddr = await factory.getPool(tok0.address, tok1.address, selectedFee);
        const ZERO = "0x0000000000000000000000000000000000000000";
        if (!poolAddr || poolAddr === ZERO) {
          setPoolExists(false); setCurrentPrice(null); setCurrentSqrtPriceX96(null); setCurrentTick(null); setPoolLiquidity(0n); return;
        }
        setPoolExists(true);
        const pool = new Contract(poolAddr, V3_POOL_ABI, provider);
        const [slot0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
        const sqrtPX96: bigint = slot0[0];
        const tick = Number(slot0[1]);
        const price = sqrtPriceX96ToPrice(sqrtPX96, tok0.decimals, tok1.decimals);
        setCurrentSqrtPriceX96(sqrtPX96); setCurrentPrice(price); setCurrentTick(tick); setPoolLiquidity(liq);
        if (!minPrice && !maxPrice) applyRangePresetValues("wide", price, tick, tok0 as any, tok1 as any);
      } catch (err) { console.error("Pool check error:", err); setPoolExists(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenA, tokenB, selectedFee, contracts, chainId]);

  // Auto-calculate amountB using V3 liquidity math.
  // IMPORTANT: also stores the raw bigint amounts in `autoCalcAmounts` so
  // handleAddLiquidity can use them without re-parsing the display string.
  useEffect(() => {
    if (!amountA || !tokenA || !tokenB || !chainId) return;
    const aFloat = parseFloat(amountA);
    if (isNaN(aFloat) || aFloat <= 0) {
      setAmountB(""); setAmountBIsAuto(false); setAutoCalcAmounts(null); return;
    }
    const s = getSortedTokens(); if (!s) return;
    const { tok0, tok1, isToken0A } = s;
    const tl = minTick ? parseInt(minTick) : null;
    const tu = maxTick ? parseInt(maxTick) : null;
    const validTicks = tl !== null && tu !== null && !isNaN(tl) && !isNaN(tu) && tl < tu;

    // Out-of-range: single-sided
    if (validTicks && currentTick !== null) {
      if (currentTick < tl!) {
        // price below range → only token0
        const amount0 = parseAmount(amountA, isToken0A ? tok0.decimals : tok1.decimals);
        setAmountB("0"); setAmountBIsAuto(true);
        setAutoCalcAmounts({ amount0: isToken0A ? amount0 : 0n, amount1: isToken0A ? 0n : amount0, forAmountA: amountA });
        return;
      }
      if (currentTick >= tu!) {
        // price above range → only token1
        const amount1 = parseAmount(amountA, isToken0A ? tok0.decimals : tok1.decimals);
        setAmountB("0"); setAmountBIsAuto(true);
        setAutoCalcAmounts({ amount0: isToken0A ? 0n : amount1, amount1: isToken0A ? amount1 : 0n, forAmountA: amountA });
        return;
      }
    }

    // In-range: use corrected V3 math
    if (validTicks && currentSqrtPriceX96) {
      try {
        const inputBig = parseAmount(amountA, isToken0A ? tok0.decimals : tok1.decimals);
        const { amount0, amount1 } = calculateAmountsForLiquidity(
          inputBig, isToken0A, currentSqrtPriceX96, tl!, tu!, tok0.decimals, tok1.decimals,
        );
        const counterpart = isToken0A ? amount1 : amount0;
        const counterpartDec = isToken0A ? tok1.decimals : tok0.decimals;

        // Store raw bigints so tx can use them directly (avoids display-rounding loss)
        setAutoCalcAmounts({ amount0, amount1, forAmountA: amountA });

        if (counterpart > 0n) {
          // Use formatCounterpartAmount to preserve precision in display
          setAmountB(formatCounterpartAmount(counterpart, counterpartDec));
          setAmountBIsAuto(true);
          return;
        } else {
          // Math returned 0 for counterpart (e.g. price exactly at boundary)
          setAmountB("0");
          setAmountBIsAuto(true);
          return;
        }
      } catch (err) {
        console.warn("V3 math fallback:", err);
        setAutoCalcAmounts(null);
      }
    }

    // Fallback: spot price
    if (currentPrice) {
      const calc = isToken0A ? aFloat * currentPrice : aFloat / currentPrice;
      setAmountB(calc.toFixed(8)); setAmountBIsAuto(true);
      setAutoCalcAmounts(null); // can't store precise bigints for this path
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountA, minTick, maxTick, currentSqrtPriceX96, currentPrice, currentTick, tokenA, tokenB, chainId]);

  // One-way price<->tick handlers — no feedback loops
  const handleMinPriceChange = (v: string) => { setMinPrice(v); const p = parseFloat(v); if (isNaN(p) || p <= 0) return; const s = getSortedTokens(); if (!s) return; setMinTick(getNearestUsableTick(priceToTick(p, s.tok0.decimals, s.tok1.decimals), getTickSpacing(selectedFee)).toString()); };
  const handleMaxPriceChange = (v: string) => { setMaxPrice(v); const p = parseFloat(v); if (isNaN(p) || p <= 0) return; const s = getSortedTokens(); if (!s) return; setMaxTick(getNearestUsableTick(priceToTick(p, s.tok0.decimals, s.tok1.decimals), getTickSpacing(selectedFee)).toString()); };
  const handleMinTickChange  = (v: string) => { setMinTick(v); const t = parseInt(v); if (isNaN(t)) return; const s = getSortedTokens(); if (!s) return; setMinPrice(tickToPrice(t, s.tok0.decimals, s.tok1.decimals).toFixed(6)); };
  const handleMaxTickChange  = (v: string) => { setMaxTick(v); const t = parseInt(v); if (isNaN(t)) return; const s = getSortedTokens(); if (!s) return; setMaxPrice(tickToPrice(t, s.tok0.decimals, s.tok1.decimals).toFixed(6)); };

  const applyRangePresetValues = useCallback((preset: "full" | "wide" | "narrow" | "current", price: number, tick: number, tok0: any, tok1: any) => {
    const ts = getTickSpacing(selectedFee);
    if (preset === "full") {
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);
      setMinTick(tickLower.toString()); setMaxTick(tickUpper.toString());
      // Use tick→price (not price→tick) so the displayed prices exactly match the ticks
      setMinPrice(tickToPrice(tickLower, tok0.decimals, tok1.decimals).toFixed(10));
      setMaxPrice(tickToPrice(tickUpper, tok0.decimals, tok1.decimals).toFixed(10));
    } else if (preset === "wide") {
      const lp = price * 0.5, up = price * 2;
      const tl = getNearestUsableTick(priceToTick(lp, tok0.decimals, tok1.decimals), ts);
      const tu = getNearestUsableTick(priceToTick(up, tok0.decimals, tok1.decimals), ts);
      setMinTick(tl.toString()); setMaxTick(tu.toString()); setMinPrice(lp.toFixed(6)); setMaxPrice(up.toFixed(6));
    } else if (preset === "narrow") {
      const lp = price * 0.9, up = price * 1.1;
      let tl = getNearestUsableTick(priceToTick(lp, tok0.decimals, tok1.decimals), ts);
      let tu = getNearestUsableTick(priceToTick(up, tok0.decimals, tok1.decimals), ts);
      // Guard: if spacing too large for ±10%, force 1-spacing separation
      if (tl >= tu) { const c = getNearestUsableTick(tick, ts); tl = c - ts; tu = c + ts; }
      setMinTick(tl.toString()); setMaxTick(tu.toString());
      setMinPrice(tickToPrice(tl, tok0.decimals, tok1.decimals).toFixed(6));
      setMaxPrice(tickToPrice(tu, tok0.decimals, tok1.decimals).toFixed(6));
    } else if (preset === "current") {
      const c = getNearestUsableTick(tick, ts);
      setMinTick(c.toString()); setMaxTick((c + ts).toString());
      setMinPrice(tickToPrice(c, tok0.decimals, tok1.decimals).toFixed(6));
      setMaxPrice(tickToPrice(c + ts, tok0.decimals, tok1.decimals).toFixed(6));
    }
  }, [selectedFee]);

  const applyRangePreset = (preset: "full" | "wide" | "narrow" | "current") => {
    if (!currentPrice || currentTick === null) return;
    const s = getSortedTokens(); if (!s) return;
    applyRangePresetValues(preset, currentPrice, currentTick, s.tok0, s.tok1);
  };

  const isInRange = currentTick !== null && minTick && maxTick ? isPositionInRange(currentTick, parseInt(minTick), parseInt(maxTick)) : null;
  const ticksValid = !!(minTick && maxTick && !isNaN(parseInt(minTick)) && !isNaN(parseInt(maxTick)) && parseInt(minTick) < parseInt(maxTick));
  const priceLabel = token0Symbol && token1Symbol ? `${token1Symbol} per ${token0Symbol}` : tokenA && tokenB ? `${tokenB.symbol} / ${tokenA.symbol}` : "Price";

  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !address || !contracts || !window.ethereum || !chainId) return;
    const tickLowerRaw = parseInt(minTick), tickUpperRaw = parseInt(maxTick);
    if (isNaN(tickLowerRaw) || isNaN(tickUpperRaw) || tickLowerRaw >= tickUpperRaw) {
      toast({ title: "Invalid price range", description: "Min price must be less than max price", variant: "destructive" }); return;
    }

    const aVal = parseFloat(amountA), bVal = parseFloat(amountB);
    if ((depositMode === "dual" || depositMode === "unknown") && (!amountA || aVal <= 0)) { toast({ title: "Enter amount", description: "Enter Token A amount", variant: "destructive" }); return; }
    if ((depositMode === "dual" || depositMode === "unknown") && (!amountB || bVal < 0)) { toast({ title: "Enter amount", description: "Enter Token B amount", variant: "destructive" }); return; }
    if (depositMode === "token0-only" && (!amountA || aVal <= 0)) { toast({ title: "Enter amount", description: `Enter ${token0Symbol} amount`, variant: "destructive" }); return; }
    if (depositMode === "token1-only" && (!amountB || bVal <= 0)) { toast({ title: "Enter amount", description: `Enter ${token1Symbol} amount`, variant: "destructive" }); return; }

    setIsAdding(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer   = await provider.getSigner();
      const pm = new Contract(contracts.v3.nonfungiblePositionManager, NONFUNGIBLE_POSITION_MANAGER_ABI, signer);

      const tokenAIsNative = isNativeToken(tokenA.address), tokenBIsNative = isNativeToken(tokenB.address);
      const tokenAERC20 = getERC20Address(tokenA, chainId), tokenBERC20 = getERC20Address(tokenB, chainId);
      const [token0, token1] = sortTokens({ ...tokenA, address: tokenAERC20 }, { ...tokenB, address: tokenBERC20 });
      const isToken0A = tokenAERC20.toLowerCase() === token0.address.toLowerCase();

      const ts = getTickSpacing(selectedFee);
      const tickLower = getNearestUsableTick(tickLowerRaw, ts);
      const tickUpper = getNearestUsableTick(tickUpperRaw, ts);
      if (tickLower >= tickUpper) {
        toast({ title: "Invalid tick range", description: `Ticks must differ by at least ${ts}`, variant: "destructive" }); return;
      }

      // ─── Compute amounts ────────────────────────────────────────────────────
      //
      // PREFERRED PATH: if amountB was auto-calculated from V3 math AND the
      // autoCalcAmounts are still in sync with the current amountA, use the
      // stored bigints directly.  This avoids re-parsing the display string which
      // may have been rounded (e.g. "0.000000" for a very small counterpart).
      //
      // FALLBACK: re-compute from V3 math fresh at tx time.
      // LAST RESORT: parse the display strings (manual entry / spot-price fallback).
      //
      let amount0Desired: bigint, amount1Desired: bigint;

      if (depositMode === "token0-only") {
        // Only token0; token1 side must be 0
        amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
        amount1Desired = 0n;

      } else if (depositMode === "token1-only") {
        // Only token1; token0 side must be 0
        amount0Desired = 0n;
        amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);

      } else {
        // Dual mode — try to get precision-safe amounts

        const useStoredAmounts =
          amountBIsAuto &&
          autoCalcAmounts !== null &&
          autoCalcAmounts.forAmountA === amountA;

        if (useStoredAmounts && autoCalcAmounts) {
          // Best path: use the exact bigints from the last auto-calc run
          amount0Desired = autoCalcAmounts.amount0;
          amount1Desired = autoCalcAmounts.amount1;
        } else if (currentSqrtPriceX96 && ticksValid) {
          // Re-compute fresh V3 math (handles cases where state drifted)
          try {
            const inputBig = parseAmount(amountA, isToken0A ? token0.decimals : token1.decimals);
            const { amount0, amount1 } = calculateAmountsForLiquidity(
              inputBig, isToken0A, currentSqrtPriceX96, tickLower, tickUpper,
              token0.decimals, token1.decimals,
            );
            amount0Desired = amount0;
            amount1Desired = amount1;
          } catch (mathErr) {
            console.warn("V3 math recompute failed, falling back to display strings:", mathErr);
            amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
            amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
          }
        } else {
          // Manual entry or spot-price fallback — parse display strings
          amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
          amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
        }
      }

      // Guard: if both desired amounts are 0 something went wrong
      if (amount0Desired === 0n && amount1Desired === 0n) {
        toast({ title: "Amount error", description: "Could not compute valid token amounts. Please enter amounts manually.", variant: "destructive" });
        return;
      }

      let nativeAmount = 0n;
      if (tokenAIsNative) nativeAmount = isToken0A ? amount0Desired : amount1Desired;
      else if (tokenBIsNative) nativeAmount = isToken0A ? amount1Desired : amount0Desired;

      if (!poolExists) {
        const midPrice = (parseFloat(minPrice) + parseFloat(maxPrice)) / 2;
        const sqrtPX96 = priceToSqrtPriceX96(midPrice, token0.decimals, token1.decimals);
        toast({ title: "Creating pool…", description: "Initializing new V3 pool" });
        if (nativeAmount > 0n) {
          const cd = pm.interface.encodeFunctionData("createAndInitializePoolIfNecessary", [token0.address, token1.address, selectedFee, sqrtPX96]);
          const rd = pm.interface.encodeFunctionData("refundETH", []);
          await (await pm.multicall([cd, rd], { value: nativeAmount })).wait();
        } else {
          await (await pm.createAndInitializePoolIfNecessary(token0.address, token1.address, selectedFee, sqrtPX96)).wait();
        }
      }

      toast({ title: "Approving tokens…" });
      const pmAddr = contracts.v3.nonfungiblePositionManager;
      if (amount0Desired > 0n && !(tokenAIsNative && isToken0A) && !(tokenBIsNative && !isToken0A)) {
        const c = new Contract(token0.address, ERC20_ABI, signer);
        if (await c.allowance(address, pmAddr) < amount0Desired) await (await c.approve(pmAddr, amount0Desired)).wait();
      }
      if (amount1Desired > 0n && !(tokenAIsNative && !isToken0A) && !(tokenBIsNative && isToken0A)) {
        const c = new Contract(token1.address, ERC20_ABI, signer);
        if (await c.allowance(address, pmAddr) < amount1Desired) await (await c.approve(pmAddr, amount1Desired)).wait();
      }

      // ─── Minimums MUST be 0n ────────────────────────────────────────────────
      //
      // The NonfungiblePositionManager always takes AT MOST the desired amounts,
      // adjusting one side down to match the exact pool ratio.  Any non-zero
      // minimum derived from off-chain math will trigger "Price slippage check"
      // whenever our computed ratio differs even slightly from the on-chain ratio.
      // This is the root cause of all "Price slippage check" failures for narrow,
      // at-current, and full-range positions.
      //
      // The desired amounts already cap the maximum spend — 0n minimums are safe.
      //
      const amount0Min = 0n;
      const amount1Min = 0n;
      const deadline   = Math.floor(Date.now() / 1000) + 1200;

      toast({ title: "Adding liquidity…", description: "Creating your V3 position" });

      const params = {
        token0: token0.address, token1: token1.address, fee: selectedFee,
        tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min,
        recipient: address, deadline,
      };

      let receipt;
      if (nativeAmount > 0n) {
        const md  = pm.interface.encodeFunctionData("mint", [params]);
        const rd  = pm.interface.encodeFunctionData("refundETH", []);
        const gas = await pm.multicall.estimateGas([md, rd], { value: nativeAmount });
        receipt   = await (await pm.multicall([md, rd], { value: nativeAmount, gasLimit: (gas * 150n) / 100n })).wait();
      } else {
        const gas = await pm.mint.estimateGas(params);
        receipt   = await (await pm.mint(params, { gasLimit: (gas * 150n) / 100n })).wait();
      }

      setAmountA(""); setAmountB(""); setAmountBIsAuto(false); setAutoCalcAmounts(null);
      toast({
        title: "Liquidity added!",
        description: (
          <div className="flex items-center gap-2">
            <span>V3 position created</span>
            <Button size="sm" variant="ghost" className="h-6 px-2"
              onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}>
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error("Add liquidity error:", error);
      toast({ title: "Failed to add liquidity", description: error.reason || error.message || "Transaction failed", variant: "destructive" });
    } finally {
      setIsAdding(false);
    }
  };

  const addButtonLabel = () => {
    if (isAdding) return "Adding Liquidity…";
    if (depositMode === "token0-only") return `Deposit ${token0Symbol || tokenA?.symbol} Only (Price Below Range)`;
    if (depositMode === "token1-only") return `Deposit ${token1Symbol || tokenB?.symbol} Only (Price Above Range)`;
    return "Add V3 Liquidity (Advanced)";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg">
        <AlertTriangle className="h-5 w-5 text-orange-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-semibold text-orange-400 text-sm">Advanced Mode – Full Control</h3>
          <p className="text-xs text-slate-300">Out-of-range positions deposit only one token and earn no fees until the price re-enters the range.</p>
        </div>
      </div>

      {/* Token Inputs */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-slate-400">Token A{token0Symbol && tokenA ? ` (${tokenA.symbol === token0Symbol ? "token0" : "token1"})` : ""}</Label>
              {balanceA !== null && tokenA && (
                <button className="text-xs text-blue-400 hover:text-blue-300" onClick={() => setAmountA(formatAmount(balanceA, tokenA.decimals))}>Balance: {formatAmount(balanceA, tokenA.decimals)} MAX</button>
              )}
            </div>
            <div className="flex gap-2">
              <Input type="number" placeholder="0.00" value={amountA} onChange={(e) => setAmountA(e.target.value)} className="flex-1 bg-slate-800 border-slate-600" disabled={depositMode === "token1-only"} />
              <Button variant="outline" onClick={() => setShowTokenASelector(true)} className="min-w-[120px]">
                {tokenA ? <div className="flex items-center gap-2">{tokenA.logoURI && <img src={tokenA.logoURI} alt={tokenA.symbol} className="w-5 h-5 rounded-full" />}<span>{tokenA.symbol}</span></div> : "Select Token"}
              </Button>
            </div>
            {depositMode === "token1-only" && <p className="text-xs text-amber-400">⚠ Price above range — only {token1Symbol || tokenB?.symbol} can be deposited</p>}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-slate-400">Token B{token1Symbol && tokenB ? ` (${tokenB.symbol === token1Symbol ? "token1" : "token0"})` : ""}</Label>
              {balanceB !== null && tokenB && (
                <button className="text-xs text-blue-400 hover:text-blue-300" onClick={() => setAmountB(formatAmount(balanceB, tokenB.decimals))}>Balance: {formatAmount(balanceB, tokenB.decimals)} MAX</button>
              )}
            </div>
            <div className="flex gap-2">
              <Input type="number" placeholder="0.00" value={amountB} onChange={(e) => { setAmountB(e.target.value); setAmountBIsAuto(false); setAutoCalcAmounts(null); }} className="flex-1 bg-slate-800 border-slate-600" disabled={depositMode === "token0-only"} />
              <Button variant="outline" onClick={() => setShowTokenBSelector(true)} className="min-w-[120px]">
                {tokenB ? <div className="flex items-center gap-2">{tokenB.logoURI && <img src={tokenB.logoURI} alt={tokenB.symbol} className="w-5 h-5 rounded-full" />}<span>{tokenB.symbol}</span></div> : "Select Token"}
              </Button>
            </div>
            {depositMode === "token0-only" && <p className="text-xs text-amber-400">⚠ Price below range — only {token0Symbol || tokenA?.symbol} can be deposited</p>}
            {amountBIsAuto && depositMode === "dual" && <p className="text-xs text-slate-500">Auto-calculated via V3 math — you can override</p>}
          </div>
        </CardContent>
      </Card>

      {/* Fee Tier */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><Label className="text-sm text-slate-400">Fee Tier</Label><Info className="h-4 w-4 text-slate-500" /></div>
            {poolExists && <div className="flex items-center gap-2 text-xs text-slate-400"><BarChart3 className="h-3 w-3" /><span>Pool liquidity: {formatAmount(poolLiquidity, 18)}</span></div>}
          </div>
          <div className="flex gap-2 flex-wrap">
            {feeOptions.map((opt) => (
              <Button key={opt.value} variant={selectedFee === opt.value ? "default" : "outline"} onClick={() => setSelectedFee(opt.value)} title={opt.description} className="flex-1 min-w-[72px] flex-col h-auto py-2">
                <span className="font-semibold text-sm">{opt.label}</span>
                <span className="opacity-60 text-[10px]">{opt.description}</span>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Price Range */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button variant={!useTickMode ? "default" : "outline"} size="sm" onClick={() => setUseTickMode(false)}>Price</Button>
              <Button variant={useTickMode ? "default" : "outline"} size="sm" onClick={() => setUseTickMode(true)}>Ticks</Button>
            </div>
            {poolExists && currentPrice !== null && (
              <div className="text-right">
                <p className="text-xs text-slate-400">Current: <span className="text-white font-mono">{currentPrice.toFixed(6)}</span></p>
                <p className="text-xs text-slate-500">{priceLabel} · tick {currentTick}</p>
              </div>
            )}
          </div>

          {poolExists && currentPrice !== null && (
            <div className="space-y-2">
              <Label className="text-xs text-slate-500">Quick Range Presets</Label>
              <div className="grid grid-cols-4 gap-2">
                {([
                  { key: "full",    label: "Full Range",  Icon: Layers,    tip: "Min/max ticks" },
                  { key: "wide",    label: "Wide ±50%",   Icon: TrendingUp, tip: "0.5x–2x price" },
                  { key: "narrow",  label: "Narrow ±10%", Icon: Target,    tip: "90%–110%" },
                  { key: "current", label: "At Current",  Icon: Activity,  tip: `${getTickSpacing(selectedFee)}-tick range` },
                ] as const).map(({ key, label, Icon, tip }) => (
                  <Button key={key} variant="outline" size="sm" title={tip} onClick={() => applyRangePreset(key as any)} className="flex flex-col h-auto py-2 gap-1">
                    <Icon className="h-3 w-3" /><span className="text-xs">{label}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {!useTickMode ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Min Price ({priceLabel})</Label>
                <div className="relative">
                  <Input type="number" placeholder="0.00" value={minPrice} onChange={(e) => handleMinPriceChange(e.target.value)} className="bg-slate-800 border-slate-600 pr-8" />
                  <TrendingDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
                </div>
                {minTick && <p className="text-xs text-slate-600 font-mono">tick: {minTick}</p>}
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Max Price ({priceLabel})</Label>
                <div className="relative">
                  <Input type="number" placeholder="0.00" value={maxPrice} onChange={(e) => handleMaxPriceChange(e.target.value)} className="bg-slate-800 border-slate-600 pr-8" />
                  <TrendingUp className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
                </div>
                {maxTick && <p className="text-xs text-slate-600 font-mono">tick: {maxTick}</p>}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Tick Lower <span className="text-slate-600">(spacing: {getTickSpacing(selectedFee)})</span></Label>
                <Input type="number" placeholder="-887272" value={minTick} onChange={(e) => handleMinTickChange(e.target.value)} className="bg-slate-800 border-slate-600" />
                {minPrice && <p className="text-xs text-slate-600">≈ {parseFloat(minPrice).toFixed(6)}</p>}
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Tick Upper <span className="text-slate-600">(spacing: {getTickSpacing(selectedFee)})</span></Label>
                <Input type="number" placeholder="887272" value={maxTick} onChange={(e) => handleMaxTickChange(e.target.value)} className="bg-slate-800 border-slate-600" />
                {maxPrice && <p className="text-xs text-slate-600">≈ {parseFloat(maxPrice).toFixed(6)}</p>}
              </div>
            </div>
          )}

          {minTick && maxTick && (() => {
            const ts = getTickSpacing(selectedFee);
            const tlOk = parseInt(minTick) % ts === 0, tuOk = parseInt(maxTick) % ts === 0;
            return (!tlOk || !tuOk) ? (
              <div className="flex items-start gap-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-400">
                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                <span>Ticks will be snapped to spacing {ts} on submit.{!tlOk && ` Lower: ${minTick} → ${getNearestUsableTick(parseInt(minTick), ts)}.`}{!tuOk && ` Upper: ${maxTick} → ${getNearestUsableTick(parseInt(maxTick), ts)}.`}</span>
              </div>
            ) : null;
          })()}

          {tokenA && tokenB && minPrice && maxPrice && parseFloat(minPrice) > 0 && parseFloat(maxPrice) > 0 && (
            <PriceRangeChart minPrice={parseFloat(minPrice)} maxPrice={parseFloat(maxPrice)} currentPrice={currentPrice || undefined} token0Symbol={token0Symbol || tokenA.symbol} token1Symbol={token1Symbol || tokenB.symbol} />
          )}

          {capitalEfficiency !== null && (
            <div className="flex items-center justify-between p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-sm text-blue-400"><Zap className="h-4 w-4" /><span>Capital Efficiency</span></div>
              <div className="text-right"><span className="text-lg font-bold text-blue-300">{capitalEfficiency}x</span><p className="text-xs text-slate-500">vs full range</p></div>
            </div>
          )}

          {poolExists && isInRange !== null && ticksValid && (
            <div className={`p-3 rounded-lg border ${isInRange ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-amber-500/10 border-amber-500/20 text-amber-400"}`}>
              <div className="flex items-center gap-2 text-sm font-medium">
                {isInRange ? <><Zap className="h-4 w-4" /><span>In Range — earning fees</span></> : <><AlertTriangle className="h-4 w-4" /><span>Out of Range — no fees until price re-enters</span></>}
              </div>
              {!isInRange && (
                <p className="text-xs mt-1 opacity-80">
                  {depositMode === "token0-only" ? `Only ${token0Symbol} deposited. Earns fees when price rises above ${parseFloat(minPrice).toFixed(4)}.` : `Only ${token1Symbol} deposited. Earns fees when price falls below ${parseFloat(maxPrice).toFixed(4)}.`}
                </p>
              )}
            </div>
          )}

          {!poolExists && tokenA && tokenB && (
            <div className="flex items-start gap-2 p-3 bg-slate-800/50 border border-slate-700 rounded-lg">
              <Info className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400">Pool will be created at the mid-price of your range. Tick spacing for this fee: <span className="font-mono text-slate-300">{getTickSpacing(selectedFee)}</span>.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Slippage */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-3">
          <div className="flex items-center gap-2"><Settings className="h-4 w-4 text-slate-400" /><Label className="text-sm text-slate-400">Slippage Tolerance</Label></div>
          <div className="flex gap-2 items-center flex-wrap">
            {["0.5", "1", "2", "5"].map((s) => (<Button key={s} variant={slippage === s ? "default" : "outline"} size="sm" onClick={() => setSlippage(s)}>{s}%</Button>))}
            <div className="flex items-center gap-1 ml-auto">
              <Input type="number" value={slippage} onChange={(e) => setSlippage(e.target.value)} className="w-20 bg-slate-800 border-slate-600" min="0" max="50" step="0.1" />
              <span className="text-sm text-slate-400">%</span>
            </div>
          </div>
          {parseFloat(slippage) > 10 && <p className="text-xs text-amber-400">⚠ High slippage</p>}
          <p className="text-xs text-slate-600">
            Note: slippage tolerance is for display only. V3 mint uses 0 minimums
            (safe — the contract adjusts amounts to the exact pool ratio).
          </p>
        </CardContent>
      </Card>

      {(isNativeToken(tokenA?.address || "") || isNativeToken(tokenB?.address || "")) && tokenA && tokenB && (
        <div className="flex items-start gap-3 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
          <Shield className="h-5 w-5 text-green-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="font-semibold text-green-400 text-sm">Automatic Native Token Wrapping</h3>
            <p className="text-xs text-slate-300">Wrapped via multicall + refundETH — no pre-wrapping needed.</p>
          </div>
        </div>
      )}

      {isConnected ? (
        <Button onClick={handleAddLiquidity} className="w-full h-12 text-base font-semibold"
          disabled={
            !tokenA || !tokenB || !ticksValid || isAdding ||
            (depositMode !== "token1-only" && (!amountA || parseFloat(amountA) <= 0)) ||
            ((depositMode === "dual" || depositMode === "unknown" || depositMode === "token1-only") && (!amountB || parseFloat(amountB) < 0))
          }>
          {addButtonLabel()}
        </Button>
      ) : (
        <Button disabled className="w-full h-12">Connect Wallet</Button>
      )}

      <TokenSelector open={showTokenASelector} onClose={() => setShowTokenASelector(false)} onSelect={(t) => { setTokenA(t); setShowTokenASelector(false); }} tokens={tokens} onImport={handleImportToken} />
      <TokenSelector open={showTokenBSelector} onClose={() => setShowTokenBSelector(false)} onSelect={(t) => { setTokenB(t); setShowTokenBSelector(false); }} tokens={tokens} onImport={handleImportToken} />
    </div>
  );
}
