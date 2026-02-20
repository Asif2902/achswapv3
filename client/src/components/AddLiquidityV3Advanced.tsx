import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Info, Settings, BarChart3, Layers, Target, Activity, ChevronDown,
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

function formatCounterpartAmount(raw: bigint, decimals: number): string {
  const full = formatUnits(raw, decimals);
  const num = parseFloat(full);
  if (num === 0 && raw > 0n) return full;
  if (num !== 0 && Math.abs(num) < 0.00000001) return num.toPrecision(6);
  return parseFloat(num.toFixed(8)).toString();
}

function formatPoolReserve(raw: bigint, decimals: number): string {
  const full = formatUnits(raw, decimals);
  const n = parseFloat(full);
  if (n === 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1)             return n.toFixed(2);
  if (n >= 0.0001)        return n.toFixed(6);
  return n.toPrecision(3);
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
  const [poolToken0Reserve, setPoolToken0Reserve] = useState<bigint | null>(null);
  const [poolToken1Reserve, setPoolToken1Reserve] = useState<bigint | null>(null);
  const [poolAddress, setPoolAddress] = useState<string | null>(null);
  const [token0Symbol, setToken0Symbol] = useState("");
  const [token1Symbol, setToken1Symbol] = useState("");
  const [token0Decimals, setToken0Decimals] = useState(18);
  const [token1Decimals, setToken1Decimals] = useState(18);
  const [isAdding, setIsAdding] = useState(false);
  const [balanceA, setBalanceA] = useState<bigint | null>(null);
  const [balanceB, setBalanceB] = useState<bigint | null>(null);
  const [amountBIsAuto, setAmountBIsAuto] = useState(false);
  const [autoCalcAmounts, setAutoCalcAmounts] = useState<{
    amount0: bigint; amount1: bigint; forAmountA: string;
  } | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  const contracts = chainId ? getContractsForChain(chainId) : null;

  const feeOptions = [
    { value: V3_FEE_TIERS.LOWEST,     label: "0.01%", description: "Very stable" },
    { value: V3_FEE_TIERS.LOW,        label: "0.05%", description: "Stable" },
    { value: V3_FEE_TIERS.MEDIUM,     label: "0.3%",  description: "Most pairs" },
    { value: V3_FEE_TIERS.HIGH,       label: "1%",    description: "Exotic" },
    { value: V3_FEE_TIERS.ULTRA_HIGH, label: "10%",   description: "Very exotic" },
  ];

  const getSortedTokens = useCallback(() => {
    if (!tokenA || !tokenB || !chainId) return null;
    const erc20A = getERC20Address(tokenA, chainId);
    const erc20B = getERC20Address(tokenB, chainId);
    const [tok0, tok1] = sortTokens({ ...tokenA, address: erc20A }, { ...tokenB, address: erc20B });
    const isToken0A = erc20A.toLowerCase() === tok0.address.toLowerCase();
    return { tok0, tok1, isToken0A };
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
        setToken0Symbol(tok0.symbol);
        setToken1Symbol(tok1.symbol);
        setToken0Decimals(tok0.decimals);
        setToken1Decimals(tok1.decimals);
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
        const sqrtPX96: bigint = slot0[0];
        const tick = Number(slot0[1]);
        const price = sqrtPriceX96ToPrice(sqrtPX96, tok0.decimals, tok1.decimals);
        setCurrentSqrtPriceX96(sqrtPX96); setCurrentPrice(price);
        setCurrentTick(tick); setPoolLiquidity(liq);
        try {
          const tok0Contract = new Contract(tok0.address, ERC20_ABI, provider);
          const tok1Contract = new Contract(tok1.address, ERC20_ABI, provider);
          const [res0, res1] = await Promise.all([tok0Contract.balanceOf(poolAddr), tok1Contract.balanceOf(poolAddr)]);
          setPoolToken0Reserve(res0 as bigint); setPoolToken1Reserve(res1 as bigint);
        } catch { setPoolToken0Reserve(null); setPoolToken1Reserve(null); }
        if (!minPrice && !maxPrice) applyRangePresetValues("wide", price, tick, tok0 as any, tok1 as any);
      } catch (err) {
        console.error("Pool check error:", err);
        setPoolExists(false); setPoolToken0Reserve(null); setPoolToken1Reserve(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenA, tokenB, selectedFee, contracts, chainId]);

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
      if (currentTick < tl!) {
        const amount0 = parseAmount(amountA, isToken0A ? tok0.decimals : tok1.decimals);
        setAmountB("0"); setAmountBIsAuto(true);
        setAutoCalcAmounts({ amount0: isToken0A ? amount0 : 0n, amount1: isToken0A ? 0n : amount0, forAmountA: amountA }); return;
      }
      if (currentTick >= tu!) {
        const amount1 = parseAmount(amountA, isToken0A ? tok0.decimals : tok1.decimals);
        setAmountB("0"); setAmountBIsAuto(true);
        setAutoCalcAmounts({ amount0: isToken0A ? 0n : amount1, amount1: isToken0A ? amount1 : 0n, forAmountA: amountA }); return;
      }
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
      } catch (err) { console.warn("V3 math fallback:", err); setAutoCalcAmounts(null); }
    }
    if (currentPrice) {
      const calc = (() => { const s2 = getSortedTokens(); if (!s2) return aFloat * currentPrice; return s2.isToken0A ? aFloat * currentPrice : aFloat / currentPrice; })();
      setAmountB(calc.toFixed(8)); setAmountBIsAuto(true); setAutoCalcAmounts(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (tickLower >= tickUpper) { toast({ title: "Invalid tick range", description: `Ticks must differ by at least ${ts}`, variant: "destructive" }); return; }
      let amount0Desired: bigint, amount1Desired: bigint;
      if (depositMode === "token0-only") {
        amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals); amount1Desired = 0n;
      } else if (depositMode === "token1-only") {
        amount0Desired = 0n; amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
      } else {
        const useStoredAmounts = amountBIsAuto && autoCalcAmounts !== null && autoCalcAmounts.forAmountA === amountA;
        if (useStoredAmounts && autoCalcAmounts) {
          amount0Desired = autoCalcAmounts.amount0; amount1Desired = autoCalcAmounts.amount1;
        } else if (currentSqrtPriceX96 && ticksValid) {
          try {
            const inputBig = parseAmount(amountA, isToken0A ? token0.decimals : token1.decimals);
            const { amount0, amount1 } = calculateAmountsForLiquidity(inputBig, isToken0A, currentSqrtPriceX96, tickLower, tickUpper, token0.decimals, token1.decimals);
            amount0Desired = amount0; amount1Desired = amount1;
          } catch (mathErr) {
            amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
            amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
          }
        } else {
          amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
          amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
        }
      }
      if (amount0Desired === 0n && amount1Desired === 0n) {
        toast({ title: "Amount error", description: "Could not compute valid token amounts.", variant: "destructive" }); return;
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
      const amount0Min = 0n, amount1Min = 0n;
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      toast({ title: "Adding liquidity…", description: "Creating your V3 position" });
      const params = { token0: token0.address, token1: token1.address, fee: selectedFee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient: address, deadline };
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
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}>
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
    if (!tokenA || !tokenB) return "Select Tokens";
    if (!ticksValid) return "Set Price Range";
    if (depositMode === "token0-only") return `Deposit ${token0Symbol || tokenA?.symbol} Only`;
    if (depositMode === "token1-only") return `Deposit ${token1Symbol || tokenB?.symbol} Only`;
    if (!amountA || parseFloat(amountA) <= 0) return "Enter Amount";
    return "Add V3 Liquidity";
  };

  const canSubmit = !!(
    tokenA && tokenB && ticksValid && !isAdding &&
    (depositMode !== "token1-only" ? (amountA && parseFloat(amountA) > 0) : true) &&
    ((depositMode === "dual" || depositMode === "unknown" || depositMode === "token1-only") ? (amountB !== undefined && parseFloat(amountB) >= 0) : true)
  );

  const poolReservesLabel = useMemo(() => {
    if (poolToken0Reserve === null || poolToken1Reserve === null) return null;
    const r0 = formatPoolReserve(poolToken0Reserve, token0Decimals);
    const r1 = formatPoolReserve(poolToken1Reserve, token1Decimals);
    return `${r0} ${token0Symbol} / ${r1} ${token1Symbol}`;
  }, [poolToken0Reserve, poolToken1Reserve, token0Decimals, token1Decimals, token0Symbol, token1Symbol]);

  // ── Token input block ─────────────────────────────────────────────────────
  const TokenInput = ({
    label, role, amount, setAmount, token, onSelect, balance, disabled, warning,
    testIdInput, testIdSelect,
  }: {
    label: string; role?: string; amount: string; setAmount: (v: string) => void;
    token: Token | null; onSelect: () => void; balance: bigint | null;
    disabled?: boolean; warning?: string;
    testIdInput?: string; testIdSelect?: string;
  }) => (
    <div className={`rounded-2xl bg-slate-800/60 border p-4 space-y-3 transition-all ${
      disabled ? "border-slate-700/30 opacity-60" : "border-slate-700/50 hover:border-slate-600/60"
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
          {role && <span className="text-[10px] text-slate-600 font-mono bg-slate-700/50 px-1.5 py-0.5 rounded">({role})</span>}
        </div>
        {balance !== null && token && (
          <button
            className="text-xs text-slate-400 hover:text-blue-400 transition-colors"
            onClick={() => setAmount(formatAmount(balance, token.decimals))}
          >
            Balance: <span className="font-medium">{formatAmount(balance, token.decimals)}</span>
            <span className="text-blue-400 ml-1 font-bold">MAX</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Input
          data-testid={testIdInput}
          type="number"
          placeholder={disabled ? "—" : "0.00"}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={disabled}
          className="border-0 bg-transparent text-2xl sm:text-3xl font-bold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0 text-white placeholder:text-slate-600 flex-1 min-w-0 disabled:opacity-40"
        />
        <Button
          data-testid={testIdSelect}
          onClick={onSelect}
          variant="secondary"
          className="h-10 px-3 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-xl gap-2 min-w-[110px] justify-between flex-shrink-0"
        >
          {token ? (
            <>
              <div className="flex items-center gap-1.5">
                <img src={token.logoURI || "/img/logos/unknown-token.png"} alt={token.symbol} className="w-5 h-5 rounded-full flex-shrink-0" onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }} />
                <span className="font-semibold text-sm text-white">{token.symbol}</span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </>
          ) : (
            <>
              <span className="text-slate-300 text-sm">Select</span>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </>
          )}
        </Button>
      </div>

      {warning && (
        <div className="flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{warning}</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="w-full space-y-3">
      {/* Advanced mode warning */}
      <div className="flex items-start gap-3 p-3.5 bg-orange-500/8 border border-orange-500/20 rounded-2xl">
        <AlertTriangle className="h-4 w-4 text-orange-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-orange-400 leading-none mb-1">Advanced Mode</p>
          <p className="text-xs text-slate-400 leading-relaxed">Out-of-range positions deposit only one token and earn no fees until the price re-enters your range.</p>
        </div>
      </div>

      {/* ── Token Inputs ── */}
      <TokenInput
        label="Token A"
        role={token0Symbol && tokenA ? (tokenA.symbol === token0Symbol ? "token0" : "token1") : undefined}
        amount={amountA}
        setAmount={setAmountA}
        token={tokenA}
        onSelect={() => setShowTokenASelector(true)}
        balance={balanceA}
        disabled={depositMode === "token1-only"}
        warning={depositMode === "token1-only" ? `Price above range — only ${token1Symbol || tokenB?.symbol} can be deposited` : undefined}
        testIdInput="input-token-a"
        testIdSelect="button-select-token-a"
      />

      <TokenInput
        label="Token B"
        role={token1Symbol && tokenB ? (tokenB.symbol === token1Symbol ? "token1" : "token0") : undefined}
        amount={amountB}
        setAmount={(v) => { setAmountB(v); setAmountBIsAuto(false); setAutoCalcAmounts(null); }}
        token={tokenB}
        onSelect={() => setShowTokenBSelector(true)}
        balance={balanceB}
        disabled={depositMode === "token0-only"}
        warning={depositMode === "token0-only" ? `Price below range — only ${token0Symbol || tokenA?.symbol} can be deposited` : undefined}
        testIdInput="input-token-b"
        testIdSelect="button-select-token-b"
      />

      {amountBIsAuto && depositMode === "dual" && (
        <p className="text-xs text-slate-500 px-1">Token B auto-calculated via V3 math — tap to override</p>
      )}

      {/* ── Fee Tier ── */}
      <div className="rounded-2xl bg-slate-800/60 border border-slate-700/50 p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Fee Tier</span>
            <Info className="h-3.5 w-3.5 text-slate-600" />
          </div>
          {poolExists && poolReservesLabel && (
            <div className="flex items-center gap-1.5 text-xs">
              <BarChart3 className="h-3.5 w-3.5 text-slate-500" />
              <span className="text-slate-500">Reserves:</span>
              <span className="font-mono text-slate-300 font-medium">{poolReservesLabel}</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-5 gap-1.5">
          {feeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSelectedFee(opt.value)}
              className={`flex flex-col items-center py-2.5 px-1 rounded-xl border text-center transition-all ${
                selectedFee === opt.value
                  ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/20"
                  : "bg-slate-700/50 border-slate-600/50 text-slate-400 hover:border-slate-500 hover:text-slate-300"
              }`}
            >
              <span className="text-xs font-bold leading-none mb-1">{opt.label}</span>
              <span className="text-[9px] leading-none opacity-70 hidden sm:block">{opt.description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Price Range ── */}
      <div className="rounded-2xl bg-slate-800/60 border border-slate-700/50 p-4 space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-700/50 rounded-lg">
            <button
              onClick={() => setUseTickMode(false)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                !useTickMode ? "bg-slate-600 text-white shadow" : "text-slate-400 hover:text-slate-300"
              }`}
            >
              Price
            </button>
            <button
              onClick={() => setUseTickMode(true)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                useTickMode ? "bg-slate-600 text-white shadow" : "text-slate-400 hover:text-slate-300"
              }`}
            >
              Ticks
            </button>
          </div>

          {poolExists && currentPrice !== null && (
            <div className="text-right">
              <p className="text-xs text-white font-semibold font-mono">{currentPrice.toFixed(6)}</p>
              <p className="text-[10px] text-slate-500">{priceLabel} · tick {currentTick}</p>
            </div>
          )}
        </div>

        {/* Range presets */}
        {poolExists && currentPrice !== null && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500 font-medium">Quick Presets</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {([
                { key: "full",    label: "Full Range",  Icon: Layers,    tip: "Min/max ticks" },
                { key: "wide",    label: "Wide ±50%",   Icon: TrendingUp, tip: "0.5x–2x price" },
                { key: "narrow",  label: "Narrow ±10%", Icon: Target,    tip: "90%–110%" },
                { key: "current", label: "At Tick",     Icon: Activity,  tip: `${getTickSpacing(selectedFee)}-tick span` },
              ] as const).map(({ key, label, Icon, tip }) => (
                <button
                  key={key}
                  title={tip}
                  onClick={() => applyRangePreset(key as any)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-700/50 border border-slate-600/50 hover:border-slate-500 hover:bg-slate-700 transition-all text-left"
                >
                  <Icon className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                  <span className="text-xs font-medium text-slate-300">{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Min / Max inputs */}
        {!useTickMode ? (
          <div className="grid grid-cols-2 gap-3">
            {[
              { lbl: "Min Price", val: minPrice, onChange: handleMinPriceChange, tickVal: minTick, Icon: TrendingDown },
              { lbl: "Max Price", val: maxPrice, onChange: handleMaxPriceChange, tickVal: maxTick, Icon: TrendingUp },
            ].map(({ lbl, val, onChange, tickVal, Icon }) => (
              <div key={lbl} className="space-y-1.5">
                <p className="text-xs text-slate-500">{lbl}</p>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={val}
                    onChange={(e) => onChange(e.target.value)}
                    className="bg-slate-700/50 border-slate-600/50 rounded-xl pr-8 text-white placeholder:text-slate-600"
                  />
                  <Icon className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 pointer-events-none" />
                </div>
                {tickVal && <p className="text-[10px] text-slate-600 font-mono">tick {tickVal}</p>}
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {[
              { lbl: "Tick Lower", placeholder: "-887272", val: minTick, onChange: handleMinTickChange, priceVal: minPrice },
              { lbl: "Tick Upper", placeholder: "887272",  val: maxTick, onChange: handleMaxTickChange, priceVal: maxPrice },
            ].map(({ lbl, placeholder, val, onChange, priceVal }) => (
              <div key={lbl} className="space-y-1.5">
                <p className="text-xs text-slate-500">{lbl} <span className="text-slate-600 font-mono">(Δ{getTickSpacing(selectedFee)})</span></p>
                <Input
                  type="number"
                  placeholder={placeholder}
                  value={val}
                  onChange={(e) => onChange(e.target.value)}
                  className="bg-slate-700/50 border-slate-600/50 rounded-xl text-white placeholder:text-slate-600"
                />
                {priceVal && <p className="text-[10px] text-slate-600">≈ {parseFloat(priceVal).toFixed(6)}</p>}
              </div>
            ))}
            <div className="col-span-2">
              <p className="text-[10px] text-slate-600">Tick spacing for this fee tier: <span className="font-mono">{getTickSpacing(selectedFee)}</span></p>
            </div>
          </div>
        )}

        {/* Tick snap warning */}
        {minTick && maxTick && (() => {
          const ts = getTickSpacing(selectedFee);
          const tlOk = parseInt(minTick) % ts === 0, tuOk = parseInt(maxTick) % ts === 0;
          return (!tlOk || !tuOk) ? (
            <div className="flex items-start gap-2 p-3 bg-amber-500/8 border border-amber-500/20 rounded-xl text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>
                Ticks will be snapped to spacing {ts} on submit.
                {!tlOk && ` Lower: ${minTick} → ${getNearestUsableTick(parseInt(minTick), ts)}.`}
                {!tuOk && ` Upper: ${maxTick} → ${getNearestUsableTick(parseInt(maxTick), ts)}.`}
              </span>
            </div>
          ) : null;
        })()}

        {/* Price range chart */}
        {tokenA && tokenB && minPrice && maxPrice && parseFloat(minPrice) > 0 && parseFloat(maxPrice) > 0 && (
          <PriceRangeChart
            minPrice={parseFloat(minPrice)}
            maxPrice={parseFloat(maxPrice)}
            currentPrice={currentPrice || undefined}
            token0Symbol={token0Symbol || tokenA.symbol}
            token1Symbol={token1Symbol || tokenB.symbol}
          />
        )}

        {/* Capital efficiency */}
        {capitalEfficiency !== null && (
          <div className="flex items-center justify-between p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-blue-400" />
              <span className="text-sm text-blue-400 font-medium">Capital Efficiency</span>
            </div>
            <div className="text-right">
              <span className="text-xl font-bold text-blue-300">{capitalEfficiency}×</span>
              <p className="text-[10px] text-slate-500">vs full range</p>
            </div>
          </div>
        )}

        {/* In/out of range status */}
        {poolExists && isInRange !== null && ticksValid && (
          <div className={`flex items-start gap-3 p-3 rounded-xl border ${
            isInRange
              ? "bg-emerald-500/8 border-emerald-500/20"
              : "bg-amber-500/8 border-amber-500/20"
          }`}>
            {isInRange
              ? <Zap className="h-4 w-4 text-emerald-400 flex-shrink-0 mt-0.5" />
              : <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
            }
            <div>
              <p className={`text-sm font-semibold ${isInRange ? "text-emerald-400" : "text-amber-400"}`}>
                {isInRange ? "In Range — earning fees" : "Out of Range — no fees"}
              </p>
              {!isInRange && (
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                  {depositMode === "token0-only"
                    ? `Only ${token0Symbol} deposited. Earns fees when price rises above ${parseFloat(minPrice).toFixed(4)}.`
                    : `Only ${token1Symbol} deposited. Earns fees when price falls below ${parseFloat(maxPrice).toFixed(4)}.`
                  }
                </p>
              )}
            </div>
          </div>
        )}

        {/* New pool info */}
        {!poolExists && tokenA && tokenB && (
          <div className="flex items-start gap-2.5 p-3 bg-slate-700/30 border border-slate-700/50 rounded-xl">
            <Info className="h-4 w-4 text-slate-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-slate-400 leading-relaxed">
              Pool will be created at the mid-price of your range. Tick spacing for this fee:
              <span className="font-mono text-slate-300 ml-1">{getTickSpacing(selectedFee)}</span>
            </p>
          </div>
        )}
      </div>

      {/* ── Slippage ── */}
      <div className="rounded-2xl bg-slate-800/60 border border-slate-700/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Settings className="h-3.5 w-3.5 text-slate-500" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Slippage Tolerance</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {["0.5", "1", "2", "5"].map((s) => (
            <button
              key={s}
              onClick={() => setSlippage(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                slippage === s
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-slate-700/50 border-slate-600/50 text-slate-400 hover:border-slate-500 hover:text-slate-300"
              }`}
            >
              {s}%
            </button>
          ))}
          <div className="flex items-center gap-1.5 ml-auto">
            <Input
              type="number"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              className="w-18 h-8 text-sm bg-slate-700/50 border-slate-600/50 rounded-lg text-center text-white"
              style={{ width: "4.5rem" }}
              min="0" max="50" step="0.1"
            />
            <span className="text-xs text-slate-400">%</span>
          </div>
        </div>

        {parseFloat(slippage) > 10 && (
          <div className="flex items-center gap-1.5 text-xs text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            <span>High slippage tolerance</span>
          </div>
        )}

        <p className="text-[10px] text-slate-600 leading-relaxed">
          Display only — V3 mint uses 0 minimums. The contract adjusts amounts to the exact pool ratio.
        </p>
      </div>

      {/* ── CTA ── */}
      {isConnected ? (
        <Button
          onClick={handleAddLiquidity}
          disabled={!canSubmit}
          className="w-full h-13 text-base font-bold rounded-2xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed shadow-lg shadow-violet-500/20 transition-all duration-200 hover:shadow-violet-500/30 hover:scale-[1.01] active:scale-[0.99]"
          style={{ height: "52px" }}
        >
          {isAdding ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Adding Liquidity…
            </span>
          ) : addButtonLabel()}
        </Button>
      ) : (
        <Button
          disabled
          className="w-full text-base font-bold rounded-2xl bg-slate-700 text-slate-500 cursor-not-allowed"
          style={{ height: "52px" }}
        >
          Connect Wallet to Continue
        </Button>
      )}

      <TokenSelector open={showTokenASelector} onClose={() => setShowTokenASelector(false)} onSelect={(t) => { setTokenA(t); setShowTokenASelector(false); }} tokens={tokens} onImport={handleImportToken} />
      <TokenSelector open={showTokenBSelector} onClose={() => setShowTokenBSelector(false)} onSelect={(t) => { setTokenB(t); setShowTokenBSelector(false); }} tokens={tokens} onImport={handleImportToken} />
    </div>
  );
}
