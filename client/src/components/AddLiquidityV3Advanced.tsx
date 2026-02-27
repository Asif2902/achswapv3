import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, formatUnits } from "ethers";
import { getTokensByChainId, isNativeToken, getWrappedAddress } from "@/data/tokens";
import { formatAmount, parseAmount, getMaxAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getErrorForToast } from "@/lib/error-utils";
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
  Info, Settings, BarChart3, Layers, Target, Activity, Plus, RefreshCw,
} from "lucide-react";
import { PriceRangeChart } from "./PriceRangeChart";
import { getPoolStats, type PoolStats } from "@/lib/pool-apr-utils";

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

function formatCounterpartAmount(raw: bigint, decimals: number): string {
  const full = formatUnits(raw, decimals);
  const num = parseFloat(full);
  if (num === 0 && raw > 0n) return full;
  if (num !== 0 && Math.abs(num) < 0.00000001) return num.toPrecision(6);
  return parseFloat(num.toFixed(8)).toString();
}

function formatPoolReserve(raw: bigint, decimals: number): string {
  const n = parseFloat(formatUnits(raw, decimals));
  if (n === 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toPrecision(3);
}

function formatBalance(raw: bigint, decimals: number): string {
  const n = parseFloat(formatUnits(raw, decimals));
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

const FEE_OPTIONS = [
  { value: V3_FEE_TIERS.LOWEST,     label: "0.01%", tag: "Very Stable" },
  { value: V3_FEE_TIERS.LOW,        label: "0.05%", tag: "Stable"      },
  { value: V3_FEE_TIERS.MEDIUM,     label: "0.3%",  tag: "Most Pairs"  },
  { value: V3_FEE_TIERS.HIGH,       label: "1%",    tag: "Exotic"      },
  { value: V3_FEE_TIERS.ULTRA_HIGH, label: "10%",   tag: "Very Exotic" },
];

const RANGE_PRESETS = [
  { key: "full",    label: "Full",    Icon: Layers,     tip: "Min/max ticks" },
  { key: "wide",    label: "Wide ±50%",  Icon: TrendingUp,  tip: "0.5x–2x price" },
  { key: "narrow",  label: "Narrow ±10%", Icon: Target,     tip: "90%–110%" },
  { key: "current", label: "At Tick",  Icon: Activity,   tip: "Current tick" },
] as const;

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
  const [poolToken0Reserve, setPoolToken0Reserve] = useState<bigint | null>(null);
  const [poolToken1Reserve, setPoolToken1Reserve] = useState<bigint | null>(null);
  const [poolAddress, setPoolAddress] = useState<string | null>(null);
  const [token0Symbol, setToken0Symbol] = useState("");
  const [token1Symbol, setToken1Symbol] = useState("");
  const [token0Decimals, setToken0Decimals] = useState(18);
  const [token1Decimals, setToken1Decimals] = useState(18);
  const [isAdding, setIsAdding] = useState(false);
  const [isCheckingPool, setIsCheckingPool] = useState(false);
  const [balanceA, setBalanceA] = useState<bigint | null>(null);
  const [balanceB, setBalanceB] = useState<bigint | null>(null);
  const [amountBIsAuto, setAmountBIsAuto] = useState(false);
  const [autoCalcAmounts, setAutoCalcAmounts] = useState<{ amount0: bigint; amount1: bigint; forAmountA: string } | null>(null);
  const [poolStats, setPoolStats] = useState<PoolStats | null>(null);
  const [isLoadingApr, setIsLoadingApr] = useState(false);
  const [aprError, setAprError] = useState<string | null>(null);

  const maxAmountAWeiRef = useRef<bigint | null>(null);
  const maxAmountBWeiRef = useRef<bigint | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  const contracts = chainId ? getContractsForChain(chainId) : null;

  const getSortedTokens = useCallback(() => {
    if (!tokenA || !tokenB || !chainId) return null;
    const erc20A = getERC20Address(tokenA, chainId);
    const erc20B = getERC20Address(tokenB, chainId);
    const [tok0, tok1] = sortTokens({ ...tokenA, address: erc20A }, { ...tokenB, address: erc20B });
    return { tok0, tok1, isToken0A: erc20A.toLowerCase() === tok0.address.toLowerCase() };
  }, [tokenA, tokenB, chainId]);

  const depositMode = useMemo((): DepositMode => {
    if (currentTick === null || !minTick || !maxTick) return "unknown";
    const tl = parseInt(minTick), tu = parseInt(maxTick);
    if (isNaN(tl) || isNaN(tu) || tl >= tu) return "unknown";
    if (currentTick < tl) return "token0-only";
    if (currentTick >= tu) return "token1-only";
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

  // ── Load tokens ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    const imported: Token[] = JSON.parse(localStorage.getItem("importedTokens") || "[]");
    setTokens([...chainTokens, ...imported.filter(t => t.chainId === chainId)]);
  }, [chainId]);

  useEffect(() => {
    if (tokens.length === 0) return;
    if (!tokenA) { const t = tokens.find(t => t.symbol === "USDC"); if (t) setTokenA(t); }
    if (!tokenB) { const t = tokens.find(t => t.symbol === "ACHS"); if (t) setTokenB(t); }
  }, [tokens, tokenA, tokenB]);

  const handleImportToken = async (addr: string): Promise<Token | null> => {
    try {
      if (!addr || addr.length !== 42 || !addr.startsWith("0x")) throw new Error("Invalid token address format");
      const exists = tokens.find(t => t.address.toLowerCase() === addr.toLowerCase());
      if (exists) { toast({ title: "Token already added", description: `${exists.symbol} is in your list` }); return exists; }
      const provider = new BrowserProvider({ request: async ({ method, params }: any) => { const r = await fetch("https://rpc.testnet.arc.network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const d = await r.json(); if (d.error) throw new Error(d.error.message); return d.result; } });
      const META_ABI = ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
      const contract = new Contract(addr, META_ABI, provider);
      const [name, symbol, decimals] = await Promise.race([Promise.all([contract.name(), contract.symbol(), contract.decimals()]), new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 10000))]) as [string, string, bigint];
      if (!chainId) throw new Error("Chain ID not available");
      const newToken: Token = { address: addr, name, symbol, decimals: Number(decimals), logoURI: "/img/logos/unknown-token.png", verified: false, chainId };
      const imported: Token[] = JSON.parse(localStorage.getItem("importedTokens") || "[]");
      if (!imported.find(t => t.address.toLowerCase() === addr.toLowerCase())) { imported.push(newToken); localStorage.setItem("importedTokens", JSON.stringify(imported)); }
      setTokens(prev => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} added` });
      return newToken;
    } catch (error: any) {
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
      return null;
    }
  };

  // ── Balances ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!address || !window.ethereum || !tokenA || !tokenB || !chainId) return;
    (async () => {
      try {
        const provider = new BrowserProvider(window.ethereum);
        const fetchBal = async (token: Token) => isNativeToken(token.address) ? provider.getBalance(address) : new Contract(getERC20Address(token, chainId), ERC20_ABI, provider).balanceOf(address);
        const [rawA, rawB] = await Promise.all([fetchBal(tokenA), fetchBal(tokenB)]);
        setBalanceA(rawA); setBalanceB(rawB);
      } catch { /* ignore */ }
    })();
  }, [address, tokenA, tokenB, chainId]);

  // ── Pool state ─────────────────────────────────────────────────────────────
  const fetchPoolState = async () => {
    if (!tokenA || !tokenB || !contracts || !window.ethereum || !chainId) return;
    setIsCheckingPool(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
      const s = getSortedTokens(); if (!s) return;
      const { tok0, tok1 } = s;
      setToken0Symbol(tok0.symbol); setToken1Symbol(tok1.symbol);
      setToken0Decimals(tok0.decimals); setToken1Decimals(tok1.decimals);
      const poolAddr = await factory.getPool(tok0.address, tok1.address, selectedFee);
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (!poolAddr || poolAddr === ZERO) {
        setPoolExists(false); setCurrentPrice(null); setCurrentSqrtPriceX96(null);
        setCurrentTick(null); setPoolLiquidity(0n); setPoolAddress(null);
        setPoolToken0Reserve(null); setPoolToken1Reserve(null); return;
      }
      setPoolExists(true); setPoolAddress(poolAddr);
      const pool = new Contract(poolAddr, V3_POOL_ABI, provider);
      const [slot0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
      const sqrtPX96: bigint = slot0[0]; const tick = Number(slot0[1]);
      const price = sqrtPriceX96ToPrice(sqrtPX96, tok0.decimals, tok1.decimals);
      setCurrentSqrtPriceX96(sqrtPX96); setCurrentPrice(price); setCurrentTick(tick); setPoolLiquidity(liq);
      try {
        const [res0, res1] = await Promise.all([new Contract(tok0.address, ERC20_ABI, provider).balanceOf(poolAddr), new Contract(tok1.address, ERC20_ABI, provider).balanceOf(poolAddr)]);
        setPoolToken0Reserve(res0 as bigint); setPoolToken1Reserve(res1 as bigint);
      } catch { setPoolToken0Reserve(null); setPoolToken1Reserve(null); }
      if (!minPrice && !maxPrice) applyRangePresetValues("wide", price, tick, tok0 as any, tok1 as any);
    } catch (err) { console.error("Pool check error:", err); setPoolExists(false); setPoolToken0Reserve(null); setPoolToken1Reserve(null); }
    finally { setIsCheckingPool(false); }
  };

  useEffect(() => { fetchPoolState(); }, [tokenA, tokenB, selectedFee, contracts, chainId]);

  // ── Fetch APR data ───────────────────────────────────────────────────────────
  const fetchPoolAPR = async (addr: string) => {
    setIsLoadingApr(true);
    setAprError(null);
    try {
      const stats = await getPoolStats(addr);
      setPoolStats(stats);
    } catch (err) {
      console.warn("Failed to fetch pool APR:", err);
      setAprError(err instanceof Error ? err.message : "Failed to fetch APR");
      setPoolStats(null);
    } finally {
      setIsLoadingApr(false);
    }
  };

  useEffect(() => {
    if (poolAddress) {
      fetchPoolAPR(poolAddress);
    } else {
      setPoolStats(null);
      setAprError(null);
    }
  }, [poolAddress]);

  // ── Auto-calc amountB ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!amountA || !tokenA || !tokenB || !chainId) return;
    const aFloat = parseFloat(amountA);
    if (isNaN(aFloat) || aFloat <= 0) { setAmountB(""); setAmountBIsAuto(false); setAutoCalcAmounts(null); return; }
    const s = getSortedTokens(); if (!s) return;
    const { tok0, tok1, isToken0A } = s;
    const tl = minTick ? parseInt(minTick) : null;
    const tu = maxTick ? parseInt(maxTick) : null;
    const validTicks = tl !== null && tu !== null && !isNaN(tl) && !isNaN(tu) && tl < tu;
    if (validTicks && currentTick !== null) {
      if (currentTick < tl!) { const a = parseAmount(amountA, isToken0A ? tok0.decimals : tok1.decimals); setAmountB("0"); setAmountBIsAuto(true); setAutoCalcAmounts({ amount0: isToken0A ? a : 0n, amount1: isToken0A ? 0n : a, forAmountA: amountA }); return; }
      if (currentTick >= tu!) { const a = parseAmount(amountA, isToken0A ? tok0.decimals : tok1.decimals); setAmountB("0"); setAmountBIsAuto(true); setAutoCalcAmounts({ amount0: isToken0A ? 0n : a, amount1: isToken0A ? a : 0n, forAmountA: amountA }); return; }
    }
    if (validTicks && currentSqrtPriceX96) {
      try {
        const inputBig = parseAmount(amountA, isToken0A ? tok0.decimals : tok1.decimals);
        const { amount0, amount1 } = calculateAmountsForLiquidity(inputBig, isToken0A, currentSqrtPriceX96, tl!, tu!, tok0.decimals, tok1.decimals);
        const counterpart = isToken0A ? amount1 : amount0;
        const counterpartDec = isToken0A ? tok1.decimals : tok0.decimals;
        setAutoCalcAmounts({ amount0, amount1, forAmountA: amountA });
        if (counterpart > 0n) { setAmountB(formatCounterpartAmount(counterpart, counterpartDec)); setAmountBIsAuto(true); return; }
        else { setAmountB("0"); setAmountBIsAuto(true); return; }
      } catch { setAutoCalcAmounts(null); }
    }
    if (currentPrice) {
      const calc = s.isToken0A ? aFloat * currentPrice : aFloat / currentPrice;
      setAmountB(calc.toFixed(8)); setAmountBIsAuto(true); setAutoCalcAmounts(null);
    }
  }, [amountA, minTick, maxTick, currentSqrtPriceX96, currentPrice, currentTick, tokenA, tokenB, chainId]);

  const handleMinPriceChange = (v: string) => { setMinPrice(v); const p = parseFloat(v); if (isNaN(p) || p <= 0) return; const s = getSortedTokens(); if (!s) return; setMinTick(getNearestUsableTick(priceToTick(p, s.tok0.decimals, s.tok1.decimals), getTickSpacing(selectedFee)).toString()); };
  const handleMaxPriceChange = (v: string) => { setMaxPrice(v); const p = parseFloat(v); if (isNaN(p) || p <= 0) return; const s = getSortedTokens(); if (!s) return; setMaxTick(getNearestUsableTick(priceToTick(p, s.tok0.decimals, s.tok1.decimals), getTickSpacing(selectedFee)).toString()); };
  const handleMinTickChange  = (v: string) => { setMinTick(v); const t = parseInt(v); if (isNaN(t)) return; const s = getSortedTokens(); if (!s) return; setMinPrice(tickToPrice(t, s.tok0.decimals, s.tok1.decimals).toFixed(6)); };
  const handleMaxTickChange  = (v: string) => { setMaxTick(v); const t = parseInt(v); if (isNaN(t)) return; const s = getSortedTokens(); if (!s) return; setMaxPrice(tickToPrice(t, s.tok0.decimals, s.tok1.decimals).toFixed(6)); };

  const applyRangePresetValues = useCallback((preset: "full" | "wide" | "narrow" | "current", price: number, tick: number, tok0: any, tok1: any) => {
    const ts = getTickSpacing(selectedFee);
    if (preset === "full") {
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);
      setMinTick(tickLower.toString()); setMaxTick(tickUpper.toString());
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
      if (tl >= tu) { const c = getNearestUsableTick(tick, ts); tl = c - ts; tu = c + ts; }
      setMinTick(tl.toString()); setMaxTick(tu.toString());
      setMinPrice(tickToPrice(tl, tok0.decimals, tok1.decimals).toFixed(6));
      setMaxPrice(tickToPrice(tu, tok0.decimals, tok1.decimals).toFixed(6));
    } else {
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

  const poolReservesLabel = useMemo(() => {
    if (poolToken0Reserve === null || poolToken1Reserve === null) return null;
    return `${formatPoolReserve(poolToken0Reserve, token0Decimals)} ${token0Symbol} / ${formatPoolReserve(poolToken1Reserve, token1Decimals)} ${token1Symbol}`;
  }, [poolToken0Reserve, poolToken1Reserve, token0Decimals, token1Decimals, token0Symbol, token1Symbol]);

  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !address || !contracts || !window.ethereum || !chainId) return;
    const tickLowerRaw = parseInt(minTick), tickUpperRaw = parseInt(maxTick);
    if (isNaN(tickLowerRaw) || isNaN(tickUpperRaw) || tickLowerRaw >= tickUpperRaw) { toast({ title: "Invalid price range", description: "Min price must be less than max price", variant: "destructive" }); return; }
    const aVal = parseFloat(amountA), bVal = parseFloat(amountB);
    if ((depositMode === "dual" || depositMode === "unknown") && (!amountA || aVal <= 0)) { toast({ title: "Enter amount", description: "Enter Token A amount", variant: "destructive" }); return; }
    if (depositMode === "token0-only" && (!amountA || aVal <= 0)) { toast({ title: "Enter amount", description: `Enter ${token0Symbol} amount`, variant: "destructive" }); return; }
    if (depositMode === "token1-only" && (!amountB || bVal <= 0)) { toast({ title: "Enter amount", description: `Enter ${token1Symbol} amount`, variant: "destructive" }); return; }
    setIsAdding(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const pm = new Contract(contracts.v3.nonfungiblePositionManager, NONFUNGIBLE_POSITION_MANAGER_ABI, signer);
      const tokenAIsNative = isNativeToken(tokenA.address), tokenBIsNative = isNativeToken(tokenB.address);
      const tokenAERC20 = getERC20Address(tokenA, chainId), tokenBERC20 = getERC20Address(tokenB, chainId);
      const [token0, token1] = sortTokens({ ...tokenA, address: tokenAERC20 }, { ...tokenB, address: tokenBERC20 });
      const isToken0A = tokenAERC20.toLowerCase() === token0.address.toLowerCase();
      const ts = getTickSpacing(selectedFee);
      const tickLower = getNearestUsableTick(tickLowerRaw, ts);
      const tickUpper = getNearestUsableTick(tickUpperRaw, ts);
      if (tickLower >= tickUpper) { toast({ title: "Invalid tick range", description: `Ticks must differ by at least ${ts}`, variant: "destructive" }); return; }
      
      // Use max amount refs if set
      const maxAmountA = maxAmountAWeiRef.current;
      const maxAmountB = maxAmountBWeiRef.current;
      const usedMaxA = maxAmountA !== null;
      const usedMaxB = maxAmountB !== null;
      
      // Clear refs first
      maxAmountAWeiRef.current = null;
      maxAmountBWeiRef.current = null;
      
      let amount0Desired: bigint, amount1Desired: bigint;
      if (depositMode === "token0-only") { 
        amount0Desired = usedMaxA ? (isToken0A ? maxAmountA : 0n) : parseAmount(isToken0A ? amountA : amountB, token0.decimals); 
        amount1Desired = 0n; 
      }
      else if (depositMode === "token1-only") { 
        amount0Desired = 0n; 
        amount1Desired = usedMaxB ? (isToken0A ? maxAmountB : maxAmountB) : parseAmount(isToken0A ? amountB : amountA, token1.decimals); 
      }
      else {
        if (amountBIsAuto && autoCalcAmounts?.forAmountA === amountA && autoCalcAmounts) { amount0Desired = autoCalcAmounts.amount0; amount1Desired = autoCalcAmounts.amount1; }
        else if (currentSqrtPriceX96 && ticksValid) {
          try { 
            const inputAmount = usedMaxA ? maxAmountA : parseAmount(amountA, isToken0A ? token0.decimals : token1.decimals); 
            const { amount0, amount1 } = calculateAmountsForLiquidity(inputAmount, isToken0A, currentSqrtPriceX96, tickLower, tickUpper, token0.decimals, token1.decimals); 
            amount0Desired = amount0; amount1Desired = amount1; 
          }
          catch { 
            amount0Desired = usedMaxA ? (isToken0A ? maxAmountA : parseAmount(amountB, token1.decimals)) : parseAmount(isToken0A ? amountA : amountB, token0.decimals); 
            amount1Desired = usedMaxB ? (isToken0A ? maxAmountB : maxAmountB) : parseAmount(isToken0A ? amountB : amountA, token1.decimals); 
          }
        } else { 
          amount0Desired = usedMaxA ? (isToken0A ? maxAmountA : (usedMaxB ? maxAmountB : parseAmount(amountB, token1.decimals))) : parseAmount(isToken0A ? amountA : amountB, token0.decimals); 
          amount1Desired = usedMaxB ? (isToken0A ? maxAmountB : maxAmountB) : parseAmount(isToken0A ? amountB : amountA, token1.decimals); 
        }
      }
      
      if (amount0Desired === 0n && amount1Desired === 0n) { toast({ title: "Amount error", description: "Could not compute valid amounts. Please enter manually.", variant: "destructive" }); return; }
      let nativeAmount = 0n;
      if (tokenAIsNative) nativeAmount = isToken0A ? amount0Desired : amount1Desired;
      else if (tokenBIsNative) nativeAmount = isToken0A ? amount1Desired : amount0Desired;
      if (!poolExists) {
        const midPrice = (parseFloat(minPrice) + parseFloat(maxPrice)) / 2;
        const sqrtPX96 = priceToSqrtPriceX96(midPrice, token0.decimals, token1.decimals);
        toast({ title: "Creating pool…", description: "Initializing new V3 pool" });
        if (nativeAmount > 0n) { await (await pm.multicall([pm.interface.encodeFunctionData("createAndInitializePoolIfNecessary", [token0.address, token1.address, selectedFee, sqrtPX96]), pm.interface.encodeFunctionData("refundETH", [])], { value: nativeAmount })).wait(); }
        else { await (await pm.createAndInitializePoolIfNecessary(token0.address, token1.address, selectedFee, sqrtPX96)).wait(); }
      }
      toast({ title: "Approving tokens…" });
      const pmAddr = contracts.v3.nonfungiblePositionManager;
      if (amount0Desired > 0n && !(tokenAIsNative && isToken0A) && !(tokenBIsNative && !isToken0A)) { const c = new Contract(token0.address, ERC20_ABI, signer); if (await c.allowance(address, pmAddr) < amount0Desired) await (await c.approve(pmAddr, amount0Desired)).wait(); }
      if (amount1Desired > 0n && !(tokenAIsNative && !isToken0A) && !(tokenBIsNative && isToken0A)) { const c = new Contract(token1.address, ERC20_ABI, signer); if (await c.allowance(address, pmAddr) < amount1Desired) await (await c.approve(pmAddr, amount1Desired)).wait(); }
      const params = { token0: token0.address, token1: token1.address, fee: selectedFee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min: 0n, amount1Min: 0n, recipient: address, deadline: Math.floor(Date.now() / 1000) + 1200 };
      toast({ title: "Adding liquidity…", description: "Creating your V3 position" });
      let receipt;
      if (nativeAmount > 0n) { const md = pm.interface.encodeFunctionData("mint", [params]); const rd = pm.interface.encodeFunctionData("refundETH", []); const gas = await pm.multicall.estimateGas([md, rd], { value: nativeAmount }); receipt = await (await pm.multicall([md, rd], { value: nativeAmount, gasLimit: gas * 150n / 100n })).wait(); }
      else { const gas = await pm.mint.estimateGas(params); receipt = await (await pm.mint(params, { gasLimit: gas * 150n / 100n })).wait(); }
      setAmountA(""); setAmountB(""); setAmountBIsAuto(false); setAutoCalcAmounts(null);
      await fetchPoolState();
      toast({ title: "Liquidity added!", description: (<div className="flex items-center gap-2"><span>V3 position created</span><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}><ExternalLink className="h-3 w-3" /></Button></div>) });
    } catch (error: any) {
      console.error("Add liquidity error:", error);
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
    } finally { setIsAdding(false); }
  };

  const canSubmit = isConnected && tokenA && tokenB && ticksValid && !isAdding &&
    (depositMode !== "token1-only" ? !!amountA && parseFloat(amountA) > 0 : true) &&
    ((depositMode === "dual" || depositMode === "unknown" || depositMode === "token1-only") ? parseFloat(amountB) >= 0 : true);

  const tickSpacing = getTickSpacing(selectedFee);

  return (
    <>
      <style>{`
        .v3a-token-box {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          transition: border-color 0.2s, background 0.2s;
        }
        .v3a-token-box:focus-within {
          border-color: rgba(251,146,60,0.45);
          background: rgba(251,146,60,0.03);
        }
        .v3a-token-box.disabled-box { opacity: 0.5; pointer-events: none; }
        .v3a-token-btn {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 14px; border-radius: 12px;
          background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
          color: white; font-weight: 600; font-size: 14px;
          cursor: pointer; transition: all 0.2s; white-space: nowrap;
        }
        .v3a-token-btn:hover { background: rgba(251,146,60,0.2); border-color: rgba(251,146,60,0.4); }
        .v3a-token-btn.empty { background: linear-gradient(135deg,rgba(251,146,60,0.2),rgba(245,158,11,0.2)); border-color: rgba(251,146,60,0.4); color: #fdba74; }
        .v3a-max-btn {
          font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
          padding: 3px 10px; border-radius: 8px;
          background: rgba(251,146,60,0.12); border: 1px solid rgba(251,146,60,0.3);
          color: #fdba74; cursor: pointer; transition: all 0.2s;
        }
        .v3a-max-btn:hover { background: rgba(251,146,60,0.25); border-color: rgba(251,146,60,0.55); }
        .v3a-input {
          background: transparent; border: none; outline: none;
          color: white; font-size: clamp(18px,4.5vw,26px); font-weight: 700;
          width: 100%; font-variant-numeric: tabular-nums;
        }
        .v3a-input::placeholder { color: rgba(255,255,255,0.2); }
        .v3a-input:disabled { opacity: 0.4; cursor: not-allowed; }
        .v3a-input[type=number]::-webkit-outer-spin-button,
        .v3a-input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        .v3a-divider-ring {
          width: 40px; height: 40px; border-radius: 50%;
          background: rgba(251,146,60,0.12); border: 1px solid rgba(251,146,60,0.3);
          display: flex; align-items: center; justify-content: center; color: #fdba74; flex-shrink: 0;
        }
        .v3a-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px; overflow: hidden;
        }
        .v3a-card-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 11px 16px;
          background: rgba(0,0,0,0.15);
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .v3a-label {
          font-size: 11px; font-weight: 700;
          color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.08em;
        }
        .v3a-fee-grid { display: grid; grid-template-columns: repeat(5,1fr); gap: 5px; }
        @media (max-width: 420px) { .v3a-fee-grid { grid-template-columns: repeat(3,1fr); } }
        .v3a-fee-btn {
          display: flex; flex-direction: column; align-items: center;
          padding: 9px 4px; border-radius: 11px; border: 1px solid transparent;
          background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.4);
          cursor: pointer; transition: all 0.2s; text-align: center;
        }
        .v3a-fee-btn:hover { background: rgba(251,146,60,0.1); color: rgba(255,255,255,0.7); }
        .v3a-fee-btn.active { background: rgba(251,146,60,0.18); border-color: rgba(251,146,60,0.5); color: #fdba74; }
        .v3a-stat-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 16px; }
        .v3a-stat-row + .v3a-stat-row { border-top: 1px solid rgba(255,255,255,0.05); }
        .v3a-range-input-box {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px; padding: 12px 14px;
          transition: border-color 0.2s;
        }
        .v3a-range-input-box:focus-within { border-color: rgba(251,146,60,0.4); }
        .v3a-range-input {
          background: transparent; border: none; outline: none;
          color: white; font-size: 17px; font-weight: 700; width: 100%;
          font-variant-numeric: tabular-nums;
        }
        .v3a-range-input::placeholder { color: rgba(255,255,255,0.2); }
        .v3a-range-input[type=number]::-webkit-outer-spin-button,
        .v3a-range-input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        .v3a-preset-btn {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 3px; padding: 9px 6px; border-radius: 11px;
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
          color: rgba(255,255,255,0.4); cursor: pointer; transition: all 0.2s; text-align: center;
          font-size: 11px; font-weight: 600;
        }
        .v3a-preset-btn:hover { background: rgba(251,146,60,0.12); border-color: rgba(251,146,60,0.3); color: #fdba74; }
        .v3a-preset-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .v3a-mode-btn {
          padding: 6px 14px; border-radius: 10px; font-size: 12px; font-weight: 700;
          border: 1px solid rgba(255,255,255,0.1); background: transparent;
          color: rgba(255,255,255,0.35); cursor: pointer; transition: all 0.2s;
        }
        .v3a-mode-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.6); }
        .v3a-mode-btn.active { background: rgba(251,146,60,0.18); border-color: rgba(251,146,60,0.5); color: #fdba74; }
        .v3a-slip-btn {
          padding: 6px 12px; border-radius: 10px; font-size: 12px; font-weight: 700;
          border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04);
          color: rgba(255,255,255,0.4); cursor: pointer; transition: all 0.2s;
        }
        .v3a-slip-btn:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7); }
        .v3a-slip-btn.active { background: rgba(251,146,60,0.18); border-color: rgba(251,146,60,0.5); color: #fdba74; }
        .v3a-slip-input {
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; padding: 6px 10px; color: white; font-size: 13px; font-weight: 700;
          outline: none; width: 68px; text-align: right; font-variant-numeric: tabular-nums;
        }
        .v3a-slip-input:focus { border-color: rgba(251,146,60,0.4); }
        .v3a-slip-input[type=number]::-webkit-outer-spin-button,
        .v3a-slip-input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        .v3a-submit-btn {
          width: 100%; height: 52px; border-radius: 16px;
          font-weight: 700; font-size: 15px; letter-spacing: 0.02em;
          border: none; cursor: pointer; transition: all 0.2s;
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .v3a-submit-btn.active { background: linear-gradient(135deg,#f97316,#f59e0b); color: white; box-shadow: 0 4px 24px rgba(249,115,22,0.35); }
        .v3a-submit-btn.active:hover { background: linear-gradient(135deg,#ea580c,#d97706); box-shadow: 0 6px 32px rgba(249,115,22,0.5); transform: translateY(-1px); }
        .v3a-submit-btn.loading { background: rgba(249,115,22,0.25); color: rgba(255,255,255,0.5); cursor: not-allowed; }
        .v3a-submit-btn.disabled { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.25); cursor: not-allowed; }
        @keyframes v3a-spin { to { transform: rotate(360deg); } }
        .v3a-spin { animation: v3a-spin 1s linear infinite; }
        @keyframes v3a-pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
        .v3a-pulse { animation: v3a-pulse 1.5s ease-in-out infinite; }
        .v3a-tick-snap-warn {
          display: flex; align-items: flex-start; gap: 7px; padding: 10px 12px;
          background: rgba(245,158,11,0.07); border: 1px solid rgba(245,158,11,0.2);
          border-radius: 11px; font-size: 11px; color: rgba(253,186,116,0.8); line-height: 1.5;
        }
        .v3a-efficiency-badge {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px; border-radius: 13px;
          background: rgba(251,146,60,0.08); border: 1px solid rgba(251,146,60,0.2);
        }
        .v3a-range-badge {
          display: flex; align-items: center; gap: 8px;
          padding: 11px 14px; border-radius: 13px; font-size: 13px; font-weight: 600;
        }
        .v3a-range-badge.in-range { background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.2); color: #4ade80; }
        .v3a-range-badge.out-range { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2); color: #fbbf24; }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ── Advanced mode banner ── */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px", borderRadius: 14, background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.2)" }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(251,146,60,0.18)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
            <Zap style={{ width: 16, height: 16, color: "#fdba74" }} />
          </div>
          <div>
            <p style={{ fontSize: 12, fontWeight: 700, color: "#fdba74", margin: 0 }}>Advanced Mode — Full Control</p>
            <p style={{ fontSize: 11, color: "rgba(253,186,116,0.55)", margin: 0, marginTop: 3, lineHeight: 1.5 }}>
              Set a custom price range for concentrated liquidity. Out-of-range positions earn no fees and deposit only one token.
            </p>
          </div>
        </div>

        {/* ── Token A ── */}
        <div className={`v3a-token-box ${depositMode === "token1-only" ? "disabled-box" : ""}`} style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span className="v3a-label">Token A{token0Symbol && tokenA ? ` · ${tokenA.symbol === token0Symbol ? "token0" : "token1"}` : ""}</span>
            {balanceA !== null && tokenA && (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", cursor: "pointer" }} onClick={() => {
                if (depositMode === "token1-only") return;
                const displayAmount = getMaxAmount(balanceA, tokenA.decimals, tokenA.symbol);
                setAmountA(displayAmount);
                let maxWei = balanceA;
                if (tokenA.symbol === "USDC") {
                  maxWei = (balanceA * 99n) / 100n;
                }
                maxAmountAWeiRef.current = maxWei;
              }}>
                Balance: <span style={{ color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>{formatBalance(balanceA, tokenA.decimals)}</span>
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input type="number" placeholder="0.00" value={amountA} onChange={e => setAmountA(e.target.value)} disabled={depositMode === "token1-only"} className="v3a-input" style={{ flex: 1, minWidth: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
              <button onClick={() => setShowTokenASelector(true)} className={`v3a-token-btn ${!tokenA ? "empty" : ""}`}>
                {tokenA ? (<><img src={tokenA.logoURI} alt={tokenA.symbol} style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)" }} /><span>{tokenA.symbol}</span></>) : <span>Select token</span>}
              </button>
              {balanceA !== null && tokenA && depositMode !== "token1-only" && (
                <button className="v3a-max-btn" onClick={() => {
                  const displayAmount = getMaxAmount(balanceA, tokenA.decimals, tokenA.symbol);
                  setAmountA(displayAmount);
                  let maxWei = balanceA;
                  if (tokenA.symbol === "USDC") {
                    maxWei = (balanceA * 99n) / 100n;
                  }
                  maxAmountAWeiRef.current = maxWei;
                }}>MAX</button>
              )}
            </div>
          </div>
          {depositMode === "token1-only" && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <AlertTriangle style={{ width: 12, height: 12, color: "#fbbf24", flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "rgba(251,191,36,0.7)" }}>Price above range — only {token1Symbol || tokenB?.symbol} can be deposited</span>
            </div>
          )}
        </div>

        {/* ── Plus divider ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="v3a-divider-ring"><Plus style={{ width: 18, height: 18 }} /></div>
        </div>

        {/* ── Token B ── */}
        <div className={`v3a-token-box ${depositMode === "token0-only" ? "disabled-box" : ""}`} style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span className="v3a-label">Token B{token1Symbol && tokenB ? ` · ${tokenB.symbol === token1Symbol ? "token1" : "token0"}` : ""}</span>
            {balanceB !== null && tokenB && (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", cursor: depositMode !== "token0-only" ? "pointer" : "default" }} onClick={() => {
                if (depositMode === "token0-only") return;
                const displayAmount = getMaxAmount(balanceB, tokenB.decimals, tokenB.symbol);
                setAmountB(displayAmount);
                let maxWei = balanceB;
                if (tokenB.symbol === "USDC") {
                  maxWei = (balanceB * 99n) / 100n;
                }
                maxAmountBWeiRef.current = maxWei;
              }}>
                Balance: <span style={{ color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>{formatBalance(balanceB, tokenB.decimals)}</span>
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input type="number" placeholder="0.00" value={amountB} onChange={e => { setAmountB(e.target.value); setAmountBIsAuto(false); setAutoCalcAmounts(null); }} disabled={depositMode === "token0-only"} className="v3a-input" style={{ flex: 1, minWidth: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
              <button onClick={() => setShowTokenBSelector(true)} className={`v3a-token-btn ${!tokenB ? "empty" : ""}`}>
                {tokenB ? (<><img src={tokenB.logoURI} alt={tokenB.symbol} style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)" }} /><span>{tokenB.symbol}</span></>) : <span>Select token</span>}
              </button>
              {balanceB !== null && tokenB && depositMode !== "token0-only" && (
                <button className="v3a-max-btn" onClick={() => {
                  const displayAmount = getMaxAmount(balanceB, tokenB.decimals, tokenB.symbol);
                  setAmountB(displayAmount);
                  let maxWei = balanceB;
                  if (tokenB.symbol === "USDC") {
                    maxWei = (balanceB * 99n) / 100n;
                  }
                  maxAmountBWeiRef.current = maxWei;
                }}>MAX</button>
              )}
            </div>
          </div>
          {depositMode === "token0-only" && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <AlertTriangle style={{ width: 12, height: 12, color: "#fbbf24", flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "rgba(251,191,36,0.7)" }}>Price below range — only {token0Symbol || tokenA?.symbol} can be deposited</span>
            </div>
          )}
          {amountBIsAuto && depositMode === "dual" && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <Info style={{ width: 12, height: 12, color: "rgba(253,186,116,0.5)", flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "rgba(253,186,116,0.5)" }}>Auto-calculated via V3 math — you can override</span>
            </div>
          )}
        </div>

        {/* ── Fee tier ── */}
        <div className="v3a-card">
          <div className="v3a-card-header">
            <span className="v3a-label">Fee Tier</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {poolExists && poolReservesLabel && (
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                  <BarChart3 style={{ width: 11, height: 11 }} />
                  <span style={{ fontFamily: "monospace", color: "rgba(255,255,255,0.6)" }}>{poolReservesLabel}</span>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, background: isCheckingPool ? "rgba(255,255,255,0.05)" : poolExists ? "rgba(251,146,60,0.1)" : "rgba(99,102,241,0.1)", border: `1px solid ${isCheckingPool ? "transparent" : poolExists ? "rgba(251,146,60,0.3)" : "rgba(99,102,241,0.3)"}` }}>
                <span className={isCheckingPool ? "v3a-pulse" : ""} style={{ width: 6, height: 6, borderRadius: "50%", background: isCheckingPool ? "#6b7280" : poolExists ? "#fb923c" : "#818cf8", display: "inline-block" }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: isCheckingPool ? "#6b7280" : poolExists ? "#fdba74" : "#a5b4fc" }}>{isCheckingPool ? "Checking…" : poolExists ? "Pool Exists" : "New Pool"}</span>
              </div>
              <button onClick={fetchPoolState} disabled={isCheckingPool} style={{ display: "flex", alignItems: "center", padding: "4px 8px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", cursor: "pointer" }}>
                <RefreshCw style={{ width: 11, height: 11 }} className={isCheckingPool ? "v3a-spin" : ""} />
              </button>
            </div>
          </div>
          <div style={{ padding: "12px 14px" }}>
            <div className="v3a-fee-grid">
              {FEE_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setSelectedFee(opt.value)} className={`v3a-fee-btn ${selectedFee === opt.value ? "active" : ""}`}>
                  <span style={{ fontSize: 12, fontWeight: 800 }}>{opt.label}</span>
                  <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", opacity: 0.65 }}>{opt.tag}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Price range ── */}
        <div className="v3a-card">
          <div className="v3a-card-header">
            <span className="v3a-label">Price Range</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={() => setUseTickMode(false)} className={`v3a-mode-btn ${!useTickMode ? "active" : ""}`}>Price</button>
              <button onClick={() => setUseTickMode(true)} className={`v3a-mode-btn ${useTickMode ? "active" : ""}`}>Ticks</button>
            </div>
          </div>

          <div style={{ padding: "14px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Pool price info */}
            {poolExists && currentPrice !== null && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 11, border: "1px solid rgba(255,255,255,0.06)" }}>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>Current price · tick {currentTick}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "white", fontFamily: "monospace" }}>{currentPrice.toFixed(6)}</span>
              </div>
            )}

            {/* APR Display */}
            {poolStats && poolExists && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "rgba(34,197,94,0.08)", borderRadius: 11, border: "1px solid rgba(34,197,94,0.2)" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase" }}>Est. APR</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>7d: ${poolStats.fees7dUSD >= 1_000 ? `${(poolStats.fees7dUSD / 1_000).toFixed(1)}K` : poolStats.fees7dUSD.toFixed(0)} fees{poolStats.aprActive === 0 && poolStats.daysWithData > 0 && ` ($${(poolStats.fees7dUSD / poolStats.daysWithData).toFixed(2)}/day)`}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: poolStats.aprActive > 0 ? "#4ade80" : "rgba(255,255,255,0.4)" }}>
                    {poolStats.aprActive > 0 ? `${poolStats.aprActive.toFixed(2)}%` : "N/A"}
                  </span>
                </div>
              </div>
            )}
            {isLoadingApr && poolExists && (
              <div style={{ padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 11, border: "1px solid rgba(255,255,255,0.06)" }}>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>Loading APR data...</span>
              </div>
            )}

            {/* Quick preset buttons */}
            {poolExists && currentPrice !== null && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
                {RANGE_PRESETS.map(({ key, label, Icon }) => (
                  <button key={key} onClick={() => applyRangePreset(key as any)} disabled={!currentPrice} className="v3a-preset-btn">
                    <Icon style={{ width: 13, height: 13 }} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Min / Max inputs */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {/* Min */}
              <div className="v3a-range-input-box">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{useTickMode ? "Tick Lower" : "Min Price"}</span>
                  <TrendingDown style={{ width: 12, height: 12, color: "rgba(255,255,255,0.25)" }} />
                </div>
                <input
                  type="number" placeholder={useTickMode ? "-887272" : "0.00"}
                  value={useTickMode ? minTick : minPrice}
                  onChange={e => useTickMode ? handleMinTickChange(e.target.value) : handleMinPriceChange(e.target.value)}
                  className="v3a-range-input"
                />
                {useTickMode && minPrice ? (
                  <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 4, fontFamily: "monospace" }}>≈ {parseFloat(minPrice).toFixed(6)}</p>
                ) : !useTickMode && minTick ? (
                  <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 4, fontFamily: "monospace" }}>tick: {minTick}</p>
                ) : null}
              </div>
              {/* Max */}
              <div className="v3a-range-input-box">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{useTickMode ? "Tick Upper" : "Max Price"}</span>
                  <TrendingUp style={{ width: 12, height: 12, color: "rgba(255,255,255,0.25)" }} />
                </div>
                <input
                  type="number" placeholder={useTickMode ? "887272" : "0.00"}
                  value={useTickMode ? maxTick : maxPrice}
                  onChange={e => useTickMode ? handleMaxTickChange(e.target.value) : handleMaxPriceChange(e.target.value)}
                  className="v3a-range-input"
                />
                {useTickMode && maxPrice ? (
                  <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 4, fontFamily: "monospace" }}>≈ {parseFloat(maxPrice).toFixed(6)}</p>
                ) : !useTickMode && maxTick ? (
                  <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 4, fontFamily: "monospace" }}>tick: {maxTick}</p>
                ) : null}
              </div>
            </div>
            {useTickMode && <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginTop: -6 }}>Tick spacing for this fee: {tickSpacing}</p>}

            {/* Tick snap warning */}
            {minTick && maxTick && (() => {
              const tlOk = parseInt(minTick) % tickSpacing === 0;
              const tuOk = parseInt(maxTick) % tickSpacing === 0;
              return (!tlOk || !tuOk) ? (
                <div className="v3a-tick-snap-warn">
                  <AlertTriangle style={{ width: 12, height: 12, color: "#fbbf24", flexShrink: 0, marginTop: 1 }} />
                  <span>Ticks will snap to spacing {tickSpacing} on submit.{!tlOk && ` Lower: ${minTick}→${getNearestUsableTick(parseInt(minTick), tickSpacing)}.`}{!tuOk && ` Upper: ${maxTick}→${getNearestUsableTick(parseInt(maxTick), tickSpacing)}.`}</span>
                </div>
              ) : null;
            })()}

            {/* Price range chart */}
            {tokenA && tokenB && minPrice && maxPrice && parseFloat(minPrice) > 0 && parseFloat(maxPrice) > 0 && (
              <PriceRangeChart
                minPrice={parseFloat(minPrice)} maxPrice={parseFloat(maxPrice)}
                currentPrice={currentPrice || undefined}
                token0Symbol={token0Symbol || tokenA.symbol} token1Symbol={token1Symbol || tokenB.symbol}
              />
            )}

            {/* Capital efficiency badge */}
            {capitalEfficiency !== null && (
              <div className="v3a-efficiency-badge">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Zap style={{ width: 16, height: 16, color: "#fb923c" }} />
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "#fdba74", margin: 0 }}>Capital Efficiency</p>
                    <p style={{ fontSize: 10, color: "rgba(253,186,116,0.5)", margin: 0 }}>vs full range</p>
                  </div>
                </div>
                <span style={{ fontSize: 24, fontWeight: 800, color: "#fb923c", fontVariantNumeric: "tabular-nums" }}>{capitalEfficiency}×</span>
              </div>
            )}

            {/* In/out of range badge */}
            {poolExists && isInRange !== null && ticksValid && (
              <div className={`v3a-range-badge ${isInRange ? "in-range" : "out-range"}`}>
                {isInRange ? (
                  <><Activity style={{ width: 15, height: 15 }} /><span>In Range — earning fees</span></>
                ) : (
                  <>
                    <AlertTriangle style={{ width: 15, height: 15 }} />
                    <div>
                      <p style={{ margin: 0 }}>Out of Range — no fees until price re-enters</p>
                      <p style={{ fontSize: 11, opacity: 0.7, margin: "2px 0 0" }}>
                        {depositMode === "token0-only"
                          ? `Only ${token0Symbol} deposited. Earns fees when price rises above ${parseFloat(minPrice).toFixed(4)}.`
                          : `Only ${token1Symbol} deposited. Earns fees when price falls below ${parseFloat(maxPrice).toFixed(4)}.`
                        }
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* New pool hint */}
            {!poolExists && tokenA && tokenB && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 11 }}>
                <Info style={{ width: 13, height: 13, color: "rgba(255,255,255,0.3)", flexShrink: 0, marginTop: 1 }} />
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", margin: 0, lineHeight: 1.5 }}>
                  Pool will be created at the mid-price of your range. Tick spacing: <span style={{ fontFamily: "monospace", color: "rgba(255,255,255,0.55)" }}>{tickSpacing}</span>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── Slippage ── */}
        <div className="v3a-card">
          <div className="v3a-card-header">
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Settings style={{ width: 13, height: 13, color: "rgba(255,255,255,0.35)" }} />
              <span className="v3a-label">Slippage Tolerance</span>
            </div>
          </div>
          <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {["0.5", "1", "2", "5"].map(s => (
                <button key={s} onClick={() => setSlippage(s)} className={`v3a-slip-btn ${slippage === s ? "active" : ""}`}>{s}%</button>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                <input type="number" value={slippage} onChange={e => setSlippage(e.target.value)} min="0" max="50" step="0.1" className="v3a-slip-input" />
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", fontWeight: 700 }}>%</span>
              </div>
            </div>
            {parseFloat(slippage) > 10 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle style={{ width: 12, height: 12, color: "#fbbf24" }} />
                <span style={{ fontSize: 11, color: "#fbbf24" }}>High slippage — use with caution</span>
              </div>
            )}
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", lineHeight: 1.5, margin: 0 }}>
              Note: slippage is for display only. V3 mint uses 0 minimums — the contract adjusts to the exact pool ratio.
            </p>
          </div>
        </div>

        {/* ── Submit ── */}
        {isConnected ? (
          <button
            onClick={handleAddLiquidity}
            disabled={!canSubmit}
            className={`v3a-submit-btn ${isAdding ? "loading" : canSubmit ? "active" : "disabled"}`}
          >
            {isAdding ? (
              <><span style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "white", borderRadius: "50%", display: "inline-block" }} className="v3a-spin" />{poolExists ? "Adding Liquidity…" : "Creating Pool & Adding…"}</>
            ) : depositMode === "token0-only" ? (
              <><Zap style={{ width: 17, height: 17 }} />Deposit {token0Symbol || tokenA?.symbol} Only</>
            ) : depositMode === "token1-only" ? (
              <><Zap style={{ width: 17, height: 17 }} />Deposit {token1Symbol || tokenB?.symbol} Only</>
            ) : (
              <><Zap style={{ width: 17, height: 17 }} />Add V3 Liquidity</>
            )}
          </button>
        ) : (
          <button disabled className="v3a-submit-btn disabled">Connect Wallet to Continue</button>
        )}
      </div>

      <TokenSelector open={showTokenASelector} onClose={() => setShowTokenASelector(false)} onSelect={t => { setTokenA(t); setShowTokenASelector(false); }} tokens={tokens} onImport={handleImportToken} />
      <TokenSelector open={showTokenBSelector} onClose={() => setShowTokenBSelector(false)} onSelect={t => { setTokenB(t); setShowTokenBSelector(false); }} tokens={tokens} onImport={handleImportToken} />
    </>
  );
}
