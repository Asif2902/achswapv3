import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V3_FEE_TIERS,
  FEE_TIER_LABELS,
} from "@/lib/abis/v3";
import {
  priceToSqrtPriceX96,
  sortTokens,
  getPriceFromAmounts,
  sqrtPriceX96ToPrice,
  getFullRangeTicks,
} from "@/lib/v3-utils";
import { PoolHealthChecker } from "@/components/PoolHealthChecker";
import type { PoolHealthResult } from "@/components/PoolHealthChecker";
import { getPoolStats, type PoolStats } from "@/lib/pool-apr-utils";
import { Shield, ExternalLink, Plus, RefreshCw, Info, Zap, AlertTriangle, TrendingUp } from "lucide-react";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

function getERC20Address(token: Token, chainId: number): string {
  if (isNativeToken(token.address)) {
    const wrapped = getWrappedAddress(chainId, token.address);
    return wrapped || token.address;
  }
  return token.address;
}

function formatBalance(raw: bigint, decimals: number): string {
  const full = parseFloat(formatUnits(raw, decimals));
  if (full === 0) return "0";
  if (full < 0.0001) return "<0.0001";
  if (full >= 1_000_000) return `${(full / 1_000_000).toFixed(2)}M`;
  if (full >= 1_000) return `${(full / 1_000).toFixed(2)}K`;
  return full.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

const FEE_OPTIONS = [
  { value: V3_FEE_TIERS.LOWEST,     label: "0.01%", tag: "Very Stable" },
  { value: V3_FEE_TIERS.LOW,        label: "0.05%", tag: "Stable"      },
  { value: V3_FEE_TIERS.MEDIUM,     label: "0.3%",  tag: "Most Pairs"  },
  { value: V3_FEE_TIERS.HIGH,       label: "1%",    tag: "Exotic"      },
  { value: V3_FEE_TIERS.ULTRA_HIGH, label: "10%",   tag: "Very Exotic" },
];

export function AddLiquidityV3Basic() {
  const [tokenA, setTokenA] = useState<Token | null>(null);
  const [tokenB, setTokenB] = useState<Token | null>(null);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [showTokenASelector, setShowTokenASelector] = useState(false);
  const [showTokenBSelector, setShowTokenBSelector] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selectedFee, setSelectedFee] = useState<number>(V3_FEE_TIERS.MEDIUM);
  const [isAdding, setIsAdding] = useState(false);

  const [balanceA, setBalanceA] = useState<bigint | null>(null);
  const [balanceB, setBalanceB] = useState<bigint | null>(null);

  const maxAmountAWeiRef = useRef<bigint | null>(null);
  const maxAmountBWeiRef = useRef<bigint | null>(null);

  const [poolAddress, setPoolAddress]         = useState<string | null>(null);
  const [poolExists, setPoolExists]           = useState(false);
  const [isCheckingPool, setIsCheckingPool]   = useState(false);
  const [currentPrice, setCurrentPrice]       = useState<number | null>(null);
  const [currentSqrtPriceX96, setCurrentSqrtPriceX96] = useState<bigint | null>(null);
  const [currentTick, setCurrentTick]         = useState<number | null>(null);
  const [activeLiquidity, setActiveLiquidity] = useState<bigint | null>(null);
  const [token0Symbol, setToken0Symbol]       = useState<string>("");
  const [token1Symbol, setToken1Symbol]       = useState<string>("");
  const [poolHealth, setPoolHealth]           = useState<PoolHealthResult | null>(null);
  const [poolStats, setPoolStats]             = useState<PoolStats | null>(null);
  const [isLoadingApr, setIsLoadingApr]      = useState(false);
  const [aprError, setAprError]              = useState<string | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  const contracts = chainId ? getContractsForChain(chainId) : null;

  // ── Load tokens ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    const imported = localStorage.getItem("importedTokens");
    const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
    setTokens([...chainTokens, ...importedTokens.filter(t => t.chainId === chainId)]);
  }, [chainId]);

  // ── Default tokens ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (tokens.length === 0) return;
    if (!tokenA) { const u = tokens.find(t => t.symbol === "USDC"); if (u) setTokenA(u); }
    if (!tokenB) { const a = tokens.find(t => t.symbol === "ACHS"); if (a) setTokenB(a); }
  }, [tokens, tokenA, tokenB]);

  // ── Import token ───────────────────────────────────────────────────────────
  const handleImportToken = async (addr: string): Promise<Token | null> => {
    try {
      if (!addr || addr.length !== 42 || !addr.startsWith("0x")) throw new Error("Invalid token address format");
      const exists = tokens.find(t => t.address.toLowerCase() === addr.toLowerCase());
      if (exists) { toast({ title: "Token already added", description: `${exists.symbol} is already in your token list` }); return exists; }
      const provider = new BrowserProvider({ request: async ({ method, params }: any) => {
        const r = await fetch("https://rpc.testnet.arc.network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const d = await r.json(); if (d.error) throw new Error(d.error.message); return d.result;
      }});
      const ERC20_META_ABI = ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
      const contract = new Contract(addr, ERC20_META_ABI, provider);
      const [name, symbol, decimals] = await Promise.race([Promise.all([contract.name(), contract.symbol(), contract.decimals()]), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000))]) as [string, string, bigint];
      if (!chainId) throw new Error("Chain ID not available");
      const newToken: Token = { address: addr, name, symbol, decimals: Number(decimals), logoURI: "/img/logos/unknown-token.png", verified: false, chainId };
      const imported = localStorage.getItem("importedTokens");
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
      if (!importedTokens.find((t: Token) => t.address.toLowerCase() === addr.toLowerCase())) { importedTokens.push(newToken); localStorage.setItem("importedTokens", JSON.stringify(importedTokens)); }
      setTokens(prev => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} has been added to your token list` });
      return newToken;
    } catch (error: any) {
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
      return null;
    }
  };

  // ── Fetch balances ─────────────────────────────────────────────────────────
  const fetchBalances = useCallback(async () => {
    if (!address || !chainId || !window.ethereum) { setBalanceA(null); setBalanceB(null); return; }
    try {
      const provider = new BrowserProvider(window.ethereum);
      const fetch = async (token: Token | null): Promise<bigint | null> => {
        if (!token) return null;
        try {
          if (isNativeToken(token.address)) return await provider.getBalance(address);
          return await new Contract(token.address, ERC20_ABI, provider).balanceOf(address);
        } catch { return null; }
      };
      const [rawA, rawB] = await Promise.all([fetch(tokenA), fetch(tokenB)]);
      setBalanceA(rawA); setBalanceB(rawB);
    } catch { /* ignore */ }
  }, [address, chainId, tokenA, tokenB]);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);

  // ── Fetch pool state ───────────────────────────────────────────────────────
  const fetchPoolState = async () => {
    if (!tokenA || !tokenB || !contracts || !window.ethereum || !chainId) return;
    setIsCheckingPool(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
      const erc20A = getERC20Address(tokenA, chainId);
      const erc20B = getERC20Address(tokenB, chainId);
      const [tok0, tok1] = sortTokens({ ...tokenA, address: erc20A }, { ...tokenB, address: erc20B });
      setToken0Symbol(tok0.symbol); setToken1Symbol(tok1.symbol);
      const addr = await factory.getPool(tok0.address, tok1.address, selectedFee);
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (!addr || addr === ZERO) {
        setPoolAddress(null); setPoolExists(false); setCurrentPrice(null);
        setCurrentSqrtPriceX96(null); setCurrentTick(null); setActiveLiquidity(null); return;
      }
      setPoolAddress(addr); setPoolExists(true);
      const pool = new Contract(addr, V3_POOL_ABI, provider);
      const [slot0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
      const sqrtPriceX96: bigint = slot0[0]; const tick = Number(slot0[1]);
      setCurrentSqrtPriceX96(sqrtPriceX96); setCurrentTick(tick); setActiveLiquidity(liq);
      setCurrentPrice(sqrtPriceX96 === 0n ? null : sqrtPriceX96ToPrice(sqrtPriceX96, tok0.decimals, tok1.decimals));
    } catch (e) { console.error("Pool state error:", e); setPoolExists(false); setCurrentPrice(null); setCurrentSqrtPriceX96(null); setCurrentTick(null); setActiveLiquidity(null); }
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

  // ── Expected price ratio ───────────────────────────────────────────────────
  const expectedPriceRatio = useMemo(() => {
    if (!tokenA || !tokenB || !amountA || !amountB || !chainId) return null;
    const a = parseFloat(amountA); const b = parseFloat(amountB);
    if (!a || !b) return null;
    const erc20A = getERC20Address(tokenA, chainId); const erc20B = getERC20Address(tokenB, chainId);
    const [tok0] = sortTokens({ ...tokenA, address: erc20A }, { ...tokenB, address: erc20B });
    return erc20A.toLowerCase() === tok0.address.toLowerCase() ? b / a : a / b;
  }, [tokenA, tokenB, amountA, amountB, chainId]);

  // ── Auto-calc amountB ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentPrice || !amountA || !tokenA || !tokenB || !chainId) return;
    const v = parseFloat(amountA); if (isNaN(v) || v <= 0) return;
    const [tok0] = sortTokens({ ...tokenA, address: getERC20Address(tokenA, chainId) }, { ...tokenB, address: getERC20Address(tokenB, chainId) });
    const isToken0A = getERC20Address(tokenA, chainId).toLowerCase() === tok0.address.toLowerCase();
    setAmountB((isToken0A ? v * currentPrice : v / currentPrice).toFixed(6));
  }, [amountA, currentPrice, tokenA, tokenB, chainId]);

  const amountAExceedsBalance = isConnected && balanceA !== null && tokenA !== null && amountA !== "" && parseFloat(amountA) > 0 && parseAmount(amountA, tokenA.decimals) > balanceA;
  const amountBExceedsBalance = isConnected && balanceB !== null && tokenB !== null && amountB !== "" && parseFloat(amountB) > 0 && parseAmount(amountB, tokenB.decimals) > balanceB;

  // ── Add liquidity ──────────────────────────────────────────────────────────
  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !amountA || !amountB || !address || !contracts || !window.ethereum || !chainId) return;
    setIsAdding(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const pm = new Contract(contracts.v3.nonfungiblePositionManager, NONFUNGIBLE_POSITION_MANAGER_ABI, signer);
      const tokenAIsNative = isNativeToken(tokenA.address);
      const tokenBIsNative = isNativeToken(tokenB.address);
      const tokenAERC20 = getERC20Address(tokenA, chainId);
      const tokenBERC20 = getERC20Address(tokenB, chainId);
      const [token0, token1] = sortTokens({ ...tokenA, address: tokenAERC20 }, { ...tokenB, address: tokenBERC20 });
      const isToken0A = tokenAERC20.toLowerCase() === token0.address.toLowerCase();
      
      // Use max amount refs if set, otherwise parse from input
      let amount0Desired: bigint;
      let amount1Desired: bigint;
      
      if (maxAmountAWeiRef.current !== null && maxAmountBWeiRef.current !== null) {
        amount0Desired = isToken0A ? maxAmountAWeiRef.current : maxAmountBWeiRef.current;
        amount1Desired = isToken0A ? maxAmountBWeiRef.current : maxAmountAWeiRef.current;
        maxAmountAWeiRef.current = null;
        maxAmountBWeiRef.current = null;
      } else {
        amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
        amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
      }
      
      let nativeAmount = 0n;
      if (tokenAIsNative) nativeAmount = isToken0A ? amount0Desired : amount1Desired;
      else if (tokenBIsNative) nativeAmount = isToken0A ? amount1Desired : amount0Desired;
      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
      const existingPool = await factory.getPool(token0.address, token1.address, selectedFee);
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (!existingPool || existingPool === ZERO) {
        const price = getPriceFromAmounts(amount0Desired, amount1Desired, token0.decimals, token1.decimals);
        const sqrtPriceX96 = priceToSqrtPriceX96(price, token0.decimals, token1.decimals);
        toast({ title: "Creating V3 pool…", description: "Initializing new pool with current price" });
        if (nativeAmount > 0n) {
          const tx = await pm.multicall([pm.interface.encodeFunctionData("createAndInitializePoolIfNecessary", [token0.address, token1.address, selectedFee, sqrtPriceX96]), pm.interface.encodeFunctionData("refundETH", [])], { value: nativeAmount });
          await tx.wait();
        } else { await (await pm.createAndInitializePoolIfNecessary(token0.address, token1.address, selectedFee, sqrtPriceX96)).wait(); }
      }
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);
      toast({ title: "Approving tokens…", description: "Please approve token spending" });
      if (!tokenAIsNative || !isToken0A) { const c = new Contract(token0.address, ERC20_ABI, signer); if ((await c.allowance(address, contracts.v3.nonfungiblePositionManager)) < amount0Desired) await (await c.approve(contracts.v3.nonfungiblePositionManager, amount0Desired)).wait(); }
      if (!tokenBIsNative || isToken0A) { const c = new Contract(token1.address, ERC20_ABI, signer); if ((await c.allowance(address, contracts.v3.nonfungiblePositionManager)) < amount1Desired) await (await c.approve(contracts.v3.nonfungiblePositionManager, amount1Desired)).wait(); }
      const params = { token0: token0.address, token1: token1.address, fee: selectedFee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min: (amount0Desired * 98n) / 100n, amount1Min: (amount1Desired * 98n) / 100n, recipient: address, deadline: Math.floor(Date.now() / 1000) + 1200 };
      toast({ title: "Adding liquidity…", description: "Creating V3 position" });
      let receipt;
      if (nativeAmount > 0n) {
        const gasEst = await pm.multicall.estimateGas([pm.interface.encodeFunctionData("mint", [params]), pm.interface.encodeFunctionData("refundETH", [])], { value: nativeAmount });
        receipt = await (await pm.multicall([pm.interface.encodeFunctionData("mint", [params]), pm.interface.encodeFunctionData("refundETH", [])], { value: nativeAmount, gasLimit: gasEst * 150n / 100n })).wait();
      } else {
        const gasEst = await pm.mint.estimateGas(params);
        receipt = await (await pm.mint(params, { gasLimit: gasEst * 150n / 100n })).wait();
      }
      setAmountA(""); setAmountB("");
      await Promise.all([fetchPoolState(), fetchBalances()]);
      toast({ title: "Liquidity added!", description: (<div className="flex items-center gap-2"><span>V3 position created (Safe Range)</span><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}><ExternalLink className="h-3 w-3" /></Button></div>) });
    } catch (error: any) {
      console.error("Add liquidity error:", error);
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
    } finally { setIsAdding(false); }
  };

  const canSubmit = tokenA && tokenB && amountA && amountB && parseFloat(amountA) > 0 && parseFloat(amountB) > 0 && !isAdding && !amountAExceedsBalance && !amountBExceedsBalance && poolHealth?.severity !== "error";

  return (
    <>
      <style>{`
        .v3b-token-box {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          transition: border-color 0.2s, background 0.2s;
        }
        .v3b-token-box:focus-within {
          border-color: rgba(139,92,246,0.5);
          background: rgba(139,92,246,0.04);
        }
        .v3b-token-box.error-border {
          border-color: rgba(239,68,68,0.5) !important;
        }
        .v3b-token-btn {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 14px; border-radius: 12px;
          background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
          color: white; font-weight: 600; font-size: 14px;
          cursor: pointer; transition: all 0.2s; white-space: nowrap;
        }
        .v3b-token-btn:hover { background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.4); }
        .v3b-token-btn.empty { background: linear-gradient(135deg,rgba(139,92,246,0.25),rgba(99,102,241,0.25)); border-color: rgba(139,92,246,0.4); color: #c4b5fd; }
        .v3b-max-btn {
          font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
          padding: 3px 10px; border-radius: 8px;
          background: rgba(139,92,246,0.15); border: 1px solid rgba(139,92,246,0.3);
          color: #c4b5fd; cursor: pointer; transition: all 0.2s;
        }
        .v3b-max-btn:hover { background: rgba(139,92,246,0.3); border-color: rgba(139,92,246,0.6); }
        .v3b-max-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .v3b-input {
          background: transparent; border: none; outline: none;
          color: white; font-size: clamp(20px,5vw,28px); font-weight: 700;
          width: 100%; font-variant-numeric: tabular-nums;
        }
        .v3b-input::placeholder { color: rgba(255,255,255,0.2); }
        .v3b-input:disabled { opacity: 0.6; cursor: not-allowed; }
        .v3b-input[type=number]::-webkit-outer-spin-button,
        .v3b-input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        .v3b-divider-ring {
          width: 40px; height: 40px; border-radius: 50%;
          background: rgba(139,92,246,0.15); border: 1px solid rgba(139,92,246,0.3);
          display: flex; align-items: center; justify-content: center; color: #c4b5fd; flex-shrink: 0;
        }
        .v3b-fee-grid { display: grid; grid-template-columns: repeat(5,1fr); gap: 6px; }
        @media (max-width: 400px) { .v3b-fee-grid { grid-template-columns: repeat(3,1fr); } }
        .v3b-fee-btn {
          display: flex; flex-direction: column; align-items: center;
          padding: 10px 6px; border-radius: 12px; border: 1px solid transparent;
          background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.4);
          cursor: pointer; transition: all 0.2s; text-align: center;
        }
        .v3b-fee-btn:hover { background: rgba(139,92,246,0.12); color: rgba(255,255,255,0.7); }
        .v3b-fee-btn.active {
          background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.5); color: #c4b5fd;
        }
        .v3b-fee-label { font-size: 13px; font-weight: 800; }
        .v3b-fee-tag { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.65; margin-top: 2px; }
        .v3b-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px; overflow: hidden;
        }
        .v3b-card-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 16px;
          background: rgba(0,0,0,0.15);
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .v3b-submit-btn {
          width: 100%; height: 52px; border-radius: 16px;
          font-weight: 700; font-size: 15px; letter-spacing: 0.02em;
          border: none; cursor: pointer; transition: all 0.2s;
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .v3b-submit-btn.active {
          background: linear-gradient(135deg,#8b5cf6,#6366f1);
          color: white; box-shadow: 0 4px 24px rgba(139,92,246,0.35);
        }
        .v3b-submit-btn.active:hover {
          background: linear-gradient(135deg,#7c3aed,#4f46e5);
          box-shadow: 0 6px 32px rgba(139,92,246,0.5); transform: translateY(-1px);
        }
        .v3b-submit-btn.loading { background: rgba(139,92,246,0.3); color: rgba(255,255,255,0.5); cursor: not-allowed; }
        .v3b-submit-btn.disabled { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.25); cursor: not-allowed; }
        @keyframes v3b-spin { to { transform: rotate(360deg); } }
        .v3b-spin { animation: v3b-spin 1s linear infinite; }
        @keyframes v3b-pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
        .v3b-pulse { animation: v3b-pulse 1.5s ease-in-out infinite; }
        .v3b-stat-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 16px; }
        .v3b-stat-row + .v3b-stat-row { border-top: 1px solid rgba(255,255,255,0.05); }
        .v3b-error-text { font-size: 11px; color: #f87171; margin-top: 4px; display: flex; align-items: center; gap: 4px; }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* ── Safe mode banner ── */}
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 12,
          padding: "12px 16px", borderRadius: 14,
          background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)"
        }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(139,92,246,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
            <Shield style={{ width: 16, height: 16, color: "#c4b5fd" }} />
          </div>
          <div>
            <p style={{ fontSize: 12, fontWeight: 700, color: "#c4b5fd", margin: 0 }}>Basic Mode — Safe &amp; Simple</p>
            <p style={{ fontSize: 11, color: "rgba(196,181,253,0.55)", margin: 0, marginTop: 3, lineHeight: 1.5 }}>
              Full-range liquidity for maximum safety. Recommended for beginners — no manual tick management required.
            </p>
          </div>
        </div>

        {/* ── Token A ── */}
        <div className={`v3b-token-box ${amountAExceedsBalance ? "error-border" : ""}`} style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Token A</span>
            {isConnected && tokenA && (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                Balance:{" "}
                <span
                  onClick={() => balanceA !== null && setAmountA(formatUnits(balanceA, tokenA.decimals))}
                  style={{ color: "rgba(255,255,255,0.65)", fontWeight: 600, cursor: balanceA !== null ? "pointer" : "default" }}
                >
                  {balanceA !== null ? formatBalance(balanceA, tokenA.decimals) : "—"} {tokenA.symbol}
                </span>
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="number" placeholder="0.00" value={amountA}
              onChange={e => setAmountA(e.target.value)}
              className="v3b-input" style={{ flex: 1, minWidth: 0 }}
            />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
              <button onClick={() => setShowTokenASelector(true)} className={`v3b-token-btn ${!tokenA ? "empty" : ""}`}>
                {tokenA ? (<><img src={tokenA.logoURI} alt={tokenA.symbol} style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)" }} /><span>{tokenA.symbol}</span></>) : <span>Select token</span>}
              </button>
              {isConnected && tokenA && balanceA !== null && (
                <button className="v3b-max-btn" onClick={() => {
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
          {amountAExceedsBalance && (
            <p className="v3b-error-text">
              <AlertTriangle style={{ width: 11, height: 11 }} /> Exceeds balance
            </p>
          )}
        </div>

        {/* ── Plus divider ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="v3b-divider-ring"><Plus style={{ width: 18, height: 18 }} /></div>
        </div>

        {/* ── Token B ── */}
        <div className={`v3b-token-box ${amountBExceedsBalance ? "error-border" : ""}`} style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Token B</span>
            {isConnected && tokenB && (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                Balance:{" "}
                <span
                  onClick={() => balanceB !== null && !poolExists && setAmountB(formatUnits(balanceB, tokenB.decimals))}
                  style={{ color: "rgba(255,255,255,0.65)", fontWeight: 600, cursor: (balanceB !== null && !poolExists) ? "pointer" : "default" }}
                >
                  {balanceB !== null ? formatBalance(balanceB, tokenB.decimals) : "—"} {tokenB.symbol}
                </span>
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="number" placeholder={poolExists && currentPrice ? "Auto-calculated" : "0.00"} value={amountB}
              onChange={e => setAmountB(e.target.value)}
              disabled={poolExists && !!currentPrice}
              className="v3b-input" style={{ flex: 1, minWidth: 0, opacity: poolExists && currentPrice ? 0.7 : 1 }}
            />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
              <button onClick={() => setShowTokenBSelector(true)} className={`v3b-token-btn ${!tokenB ? "empty" : ""}`}>
                {tokenB ? (<><img src={tokenB.logoURI} alt={tokenB.symbol} style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)" }} /><span>{tokenB.symbol}</span></>) : <span>Select token</span>}
              </button>
              {isConnected && tokenB && balanceB !== null && !(poolExists && currentPrice) && (
                <button className="v3b-max-btn" onClick={() => {
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
          {poolExists && currentPrice && amountB && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <Info style={{ width: 12, height: 12, color: "rgba(196,181,253,0.6)", flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "rgba(196,181,253,0.6)" }}>Calculated from pool price</span>
            </div>
          )}
          {amountBExceedsBalance && (
            <p className="v3b-error-text"><AlertTriangle style={{ width: 11, height: 11 }} /> Exceeds balance</p>
          )}
        </div>

        {/* ── Fee tier ── */}
        <div className="v3b-card">
          <div className="v3b-card-header">
            <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Fee Tier</span>
            <span style={{ fontSize: 11, color: "rgba(196,181,253,0.6)" }}>{FEE_OPTIONS.find(f => f.value === selectedFee)?.tag}</span>
          </div>
          <div style={{ padding: "12px 14px" }}>
            <div className="v3b-fee-grid">
              {FEE_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setSelectedFee(opt.value)} className={`v3b-fee-btn ${selectedFee === opt.value ? "active" : ""}`}>
                  <span className="v3b-fee-label">{opt.label}</span>
                  <span className="v3b-fee-tag">{opt.tag}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Pool info card ── */}
        {tokenA && tokenB && (
          <div className="v3b-card">
            <div className="v3b-card-header">
              <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Pool State</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Status dot */}
                <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, background: isCheckingPool ? "rgba(255,255,255,0.05)" : poolExists ? "rgba(139,92,246,0.12)" : "rgba(99,102,241,0.12)", border: `1px solid ${isCheckingPool ? "transparent" : poolExists ? "rgba(139,92,246,0.3)" : "rgba(99,102,241,0.3)"}` }}>
                  <span className={isCheckingPool ? "v3b-pulse" : ""} style={{ width: 6, height: 6, borderRadius: "50%", background: isCheckingPool ? "#6b7280" : poolExists ? "#a78bfa" : "#818cf8", display: "inline-block" }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: isCheckingPool ? "#6b7280" : poolExists ? "#c4b5fd" : "#a5b4fc" }}>
                    {isCheckingPool ? "Checking…" : poolExists ? "Pool Exists" : "New Pool"}
                  </span>
                </div>
                <button
                  onClick={fetchPoolState}
                  disabled={isCheckingPool}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", fontSize: 11, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}
                >
                  <RefreshCw style={{ width: 11, height: 11 }} className={isCheckingPool ? "v3b-spin" : ""} />
                </button>
              </div>
            </div>

            {poolExists && currentPrice && (
              <>
                <div className="v3b-stat-row">
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Current Price</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "white", fontVariantNumeric: "tabular-nums" }}>
                    1 {token0Symbol} = {currentPrice.toFixed(6)} {token1Symbol}
                  </span>
                </div>
                <div className="v3b-stat-row">
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Range</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#c4b5fd" }}>Full Range</span>
                </div>
                <div className="v3b-stat-row">
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Slippage</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#4ade80" }}>2%</span>
                </div>
                {poolStats && (
                  <>
                    <div className="v3b-stat-row" style={{ background: "rgba(34,197,94,0.05)" }}>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 4 }}>
                        <TrendingUp style={{ width: 12, height: 12 }} /> Est. APR
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: poolStats.aprActive > 0 ? "#4ade80" : "rgba(255,255,255,0.4)", fontVariantNumeric: "tabular-nums" }}>
                        {poolStats.aprActive > 0 ? `${poolStats.aprActive.toFixed(2)}%` : "N/A"}
                      </span>
                    </div>
                    <div className="v3b-stat-row">
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>7d Volume</span>
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontVariantNumeric: "tabular-nums" }}>
                        ${poolStats.volume7dUSD >= 1_000_000 ? `${(poolStats.volume7dUSD / 1_000_000).toFixed(2)}M` : poolStats.volume7dUSD >= 1_000 ? `${(poolStats.volume7dUSD / 1_000).toFixed(2)}K` : poolStats.volume7dUSD.toFixed(2)}
                      </span>
                    </div>
                    <div className="v3b-stat-row">
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>7d Fees</span>
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontVariantNumeric: "tabular-nums" }}>
                        ${poolStats.fees7dUSD >= 1_000 ? `${(poolStats.fees7dUSD / 1_000).toFixed(2)}K` : poolStats.fees7dUSD.toFixed(2)}
                      </span>
                    </div>
                    {poolStats.aprActive === 0 && poolStats.daysWithData > 0 && (
                      <div className="v3b-stat-row">
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>Daily: ${(poolStats.fees7dUSD / poolStats.daysWithData).toFixed(2)}</span>
                      </div>
                    )}
                  </>
                )}
                {isLoadingApr && (
                  <div className="v3b-stat-row">
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>Loading APR...</span>
                  </div>
                )}
                {aprError && !poolStats && (
                  <div className="v3b-stat-row">
                    <span style={{ fontSize: 10, color: "rgba(248,113,113,0.6)" }}>APR unavailable</span>
                  </div>
                )}
              </>
            )}

            {!poolExists && !isCheckingPool && (
              <>
                <div className="v3b-stat-row">
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
                    {amountA && amountB ? "Initial ratio" : "Set initial price ratio"}
                  </span>
                  {amountA && amountB && parseFloat(amountA) > 0 && parseFloat(amountB) > 0 ? (
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#a5b4fc" }}>
                      1 {tokenA.symbol} = {(parseFloat(amountB) / parseFloat(amountA)).toFixed(6)} {tokenB.symbol}
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", fontStyle: "italic" }}>Enter amounts</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 16px", background: "rgba(245,158,11,0.05)", borderTop: "1px solid rgba(245,158,11,0.15)" }}>
                  <AlertTriangle style={{ width: 13, height: 13, color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />
                  <p style={{ fontSize: 11, color: "rgba(245,158,11,0.7)", margin: 0, lineHeight: 1.5 }}>
                    Creating a new pool. The amounts you enter set the initial price.
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Pool health checker ── */}
        {tokenA && tokenB && !isCheckingPool && (
          <PoolHealthChecker
            poolAddress={poolAddress}
            poolExists={poolExists}
            sqrtPriceX96={currentSqrtPriceX96}
            currentTick={currentTick}
            currentPrice={currentPrice}
            activeLiquidity={activeLiquidity}
            token0Symbol={token0Symbol}
            token1Symbol={token1Symbol}
            expectedPriceRatio={expectedPriceRatio}
            tokenA={tokenA}
            tokenB={tokenB}
            fee={selectedFee}
            chainId={chainId}
            onHealthChange={setPoolHealth}
            onFixed={fetchPoolState}
          />
        )}

        {/* ── Submit ── */}
        {isConnected ? (
          <button
            onClick={handleAddLiquidity}
            disabled={!canSubmit}
            className={`v3b-submit-btn ${isAdding ? "loading" : canSubmit ? "active" : "disabled"}`}
          >
            {isAdding ? (
              <>
                <span style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "white", borderRadius: "50%", display: "inline-block" }} className="v3b-spin" />
                {poolExists ? "Adding Liquidity…" : "Creating Pool & Adding…"}
              </>
            ) : poolHealth?.severity === "error" ? (
              "Fix Pool Issues First"
            ) : (
              <>
                <Zap style={{ width: 18, height: 18 }} />
                Add V3 Liquidity
              </>
            )}
          </button>
        ) : (
          <button disabled className="v3b-submit-btn disabled">Connect Wallet to Continue</button>
        )}
      </div>

      <TokenSelector open={showTokenASelector} onClose={() => setShowTokenASelector(false)} onSelect={t => { setTokenA(t); setShowTokenASelector(false); }} tokens={tokens} onImport={handleImportToken} />
      <TokenSelector open={showTokenBSelector} onClose={() => setShowTokenBSelector(false)} onSelect={t => { setTokenB(t); setShowTokenBSelector(false); }} tokens={tokens} onImport={handleImportToken} />
    </>
  );
}
