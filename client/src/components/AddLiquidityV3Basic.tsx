import { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, parseUnits, formatUnits } from "ethers";
import { getTokensByChainId, isNativeToken, getWrappedAddress } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V3_FEE_TIERS,
  FEE_TIER_LABELS,
} from "@/lib/abis/v3";
import {
  priceToSqrtPriceX96,
  getWideRangeTicks,
  sortTokens,
  getPriceFromAmounts,
  sqrtPriceX96ToPrice,
  getFullRangeTicks,
} from "@/lib/v3-utils";
import { calculateAmountsForLiquidity } from "@/lib/v3-liquidity-math";
import { PoolHealthChecker } from "@/components/PoolHealthChecker";
import type { PoolHealthResult } from "@/components/PoolHealthChecker";
import { AlertTriangle, Info, Shield, ExternalLink, ChevronDown } from "lucide-react";

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
  const [isFetchingBalances, setIsFetchingBalances] = useState(false);

  const [poolAddress, setPoolAddress]         = useState<string | null>(null);
  const [poolExists, setPoolExists]           = useState(false);
  const [isCheckingPool, setIsCheckingPool]   = useState(false);
  const [currentPrice, setCurrentPrice]       = useState<number | null>(null);
  const [currentSqrtPriceX96, setCurrentSqrtPriceX96] = useState<bigint | null>(null);
  const [currentTick, setCurrentTick]         = useState<number | null>(null);
  const [activeLiquidity, setActiveLiquidity] = useState<bigint | null>(null);
  const [token0Symbol, setToken0Symbol]       = useState<string>("");
  const [token1Symbol, setToken1Symbol]       = useState<string>("");
  const [poolHealth, setPoolHealth] = useState<PoolHealthResult | null>(null);

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

  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    const imported = localStorage.getItem("importedTokens");
    const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
    setTokens([...chainTokens, ...importedTokens.filter((t) => t.chainId === chainId)]);
  }, [chainId]);

  const handleImportToken = async (addr: string): Promise<Token | null> => {
    try {
      if (!addr || addr.length !== 42 || !addr.startsWith("0x")) throw new Error("Invalid token address format");
      const exists = tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());
      if (exists) { toast({ title: "Token already added", description: `${exists.symbol} is already in your list` }); return exists; }
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const res = await fetch("https://rpc.testnet.arc.network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          const data = await res.json(); if (data.error) throw new Error(data.error.message); return data.result;
        },
      });
      const META_ABI = ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
      const contract = new Contract(addr, META_ABI, provider);
      const timeout = new Promise<never>((_, r) => setTimeout(() => r(new Error("Request timed out")), 10000));
      const [name, symbol, decimals] = await Promise.race([Promise.all([contract.name(), contract.symbol(), contract.decimals()]), timeout]) as [string, string, bigint];
      if (!chainId) throw new Error("Chain ID not available");
      const newToken: Token = { address: addr, name, symbol, decimals: Number(decimals), logoURI: "/img/logos/unknown-token.png", verified: false, chainId };
      const imported = localStorage.getItem("importedTokens");
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
      if (!importedTokens.find((t: Token) => t.address.toLowerCase() === addr.toLowerCase())) { importedTokens.push(newToken); localStorage.setItem("importedTokens", JSON.stringify(importedTokens)); }
      setTokens((prev) => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} added` });
      return newToken;
    } catch (error: any) {
      const msg = error.message.includes("timeout") ? "Request timed out." : error.message.includes("Invalid") ? error.message : "Unable to fetch token data.";
      toast({ title: "Import failed", description: msg, variant: "destructive" });
      return null;
    }
  };

  useEffect(() => {
    if (tokens.length === 0) return;
    if (!tokenA) { const t = tokens.find((t) => t.symbol === "USDC"); if (t) setTokenA(t); }
    if (!tokenB) { const t = tokens.find((t) => t.symbol === "ACHS"); if (t) setTokenB(t); }
  }, [tokens, tokenA, tokenB]);

  const fetchBalances = useCallback(async () => {
    if (!address || !chainId || !window.ethereum) { setBalanceA(null); setBalanceB(null); return; }
    setIsFetchingBalances(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const fetchOne = async (token: Token | null): Promise<bigint | null> => {
        if (!token) return null;
        try {
          if (isNativeToken(token.address)) return await provider.getBalance(address);
          return await new Contract(token.address, ERC20_ABI, provider).balanceOf(address);
        } catch { return null; }
      };
      const [rawA, rawB] = await Promise.all([fetchOne(tokenA), fetchOne(tokenB)]);
      setBalanceA(rawA); setBalanceB(rawB);
    } catch (err) { console.error("Balance fetch error:", err); }
    finally { setIsFetchingBalances(false); }
  }, [address, chainId, tokenA, tokenB]);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);

  const fetchPoolState = async () => {
    if (!tokenA || !tokenB || !contracts || !window.ethereum || !chainId) return;
    setIsCheckingPool(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
      const erc20A = getERC20Address(tokenA, chainId), erc20B = getERC20Address(tokenB, chainId);
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
      const sqrtPX96: bigint = slot0[0]; const tick = Number(slot0[1]);
      setCurrentSqrtPriceX96(sqrtPX96); setCurrentTick(tick); setActiveLiquidity(liq);
      setCurrentPrice(sqrtPX96 === 0n ? null : sqrtPriceX96ToPrice(sqrtPX96, tok0.decimals, tok1.decimals));
    } catch (error) {
      console.error("Pool state error:", error);
      setPoolExists(false); setCurrentPrice(null); setCurrentSqrtPriceX96(null); setCurrentTick(null); setActiveLiquidity(null);
    } finally { setIsCheckingPool(false); }
  };

  useEffect(() => { fetchPoolState(); }, [tokenA, tokenB, selectedFee, contracts, chainId]); // eslint-disable-line

  const expectedPriceRatio = useMemo(() => {
    if (!tokenA || !tokenB || !amountA || !amountB || !chainId) return null;
    const a = parseFloat(amountA), b = parseFloat(amountB);
    if (!a || !b || isNaN(a) || isNaN(b)) return null;
    const erc20A = getERC20Address(tokenA, chainId), erc20B = getERC20Address(tokenB, chainId);
    const [tok0] = sortTokens({ ...tokenA, address: erc20A }, { ...tokenB, address: erc20B });
    return erc20A.toLowerCase() === tok0.address.toLowerCase() ? b / a : a / b;
  }, [tokenA, tokenB, amountA, amountB, chainId]);

  useEffect(() => {
    if (!currentPrice || !amountA || !tokenA || !tokenB || !chainId) return;
    const aFloat = parseFloat(amountA);
    if (isNaN(aFloat) || aFloat <= 0) return;
    try {
      const [tok0] = sortTokens({ ...tokenA, address: getERC20Address(tokenA, chainId) }, { ...tokenB, address: getERC20Address(tokenB, chainId) });
      const isToken0A = getERC20Address(tokenA, chainId).toLowerCase() === tok0.address.toLowerCase();
      setAmountB((isToken0A ? aFloat * currentPrice : aFloat / currentPrice).toFixed(6));
    } catch { /* ignore */ }
  }, [amountA, currentPrice, tokenA, tokenB, chainId]);

  const handleMaxA = () => { if (balanceA === null || !tokenA) return; setAmountA(formatUnits(balanceA, tokenA.decimals)); };
  const handleMaxB = () => { if (balanceB === null || !tokenB) return; setAmountB(formatUnits(balanceB, tokenB.decimals)); };

  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !amountA || !amountB || !address || !contracts || !window.ethereum || !chainId) return;
    setIsAdding(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const pm = new Contract(contracts.v3.nonfungiblePositionManager, NONFUNGIBLE_POSITION_MANAGER_ABI, signer);
      const tokenAIsNative = isNativeToken(tokenA.address), tokenBIsNative = isNativeToken(tokenB.address);
      const tokenAERC20 = getERC20Address(tokenA, chainId), tokenBERC20 = getERC20Address(tokenB, chainId);
      const [token0, token1] = sortTokens({ ...tokenA, address: tokenAERC20 }, { ...tokenB, address: tokenBERC20 });
      const isToken0A = tokenAERC20.toLowerCase() === token0.address.toLowerCase();
      const amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
      const amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
      let nativeAmount = 0n;
      if (tokenAIsNative) nativeAmount = parseAmount(amountA, tokenA.decimals);
      else if (tokenBIsNative) nativeAmount = parseAmount(amountB, tokenB.decimals);
      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
      const existingPool = await factory.getPool(token0.address, token1.address, selectedFee);
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (!existingPool || existingPool === ZERO) {
        const price = getPriceFromAmounts(amount0Desired, amount1Desired, token0.decimals, token1.decimals);
        const sqrtPX96 = priceToSqrtPriceX96(price, token0.decimals, token1.decimals);
        toast({ title: "Creating V3 pool…" });
        if (nativeAmount > 0n) {
          const cd = pm.interface.encodeFunctionData("createAndInitializePoolIfNecessary", [token0.address, token1.address, selectedFee, sqrtPX96]);
          await (await pm.multicall([cd, pm.interface.encodeFunctionData("refundETH", [])], { value: nativeAmount })).wait();
        } else {
          await (await pm.createAndInitializePoolIfNecessary(token0.address, token1.address, selectedFee, sqrtPX96)).wait();
        }
      }
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);
      toast({ title: "Approving tokens…" });
      if (!tokenAIsNative || !isToken0A) {
        const c = new Contract(token0.address, ERC20_ABI, signer);
        if (await c.allowance(address, contracts.v3.nonfungiblePositionManager) < amount0Desired)
          await (await c.approve(contracts.v3.nonfungiblePositionManager, amount0Desired)).wait();
      }
      if (!tokenBIsNative || isToken0A) {
        const c = new Contract(token1.address, ERC20_ABI, signer);
        if (await c.allowance(address, contracts.v3.nonfungiblePositionManager) < amount1Desired)
          await (await c.approve(contracts.v3.nonfungiblePositionManager, amount1Desired)).wait();
      }
      const amount0Min = (amount0Desired * 98n) / 100n;
      const amount1Min = (amount1Desired * 98n) / 100n;
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      toast({ title: "Adding liquidity…", description: "Creating V3 position" });
      const params = { token0: token0.address, token1: token1.address, fee: selectedFee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient: address, deadline };
      let receipt;
      if (nativeAmount > 0n) {
        const md = pm.interface.encodeFunctionData("mint", [params]);
        const rd = pm.interface.encodeFunctionData("refundETH", []);
        const gas = await pm.multicall.estimateGas([md, rd], { value: nativeAmount });
        receipt = await (await pm.multicall([md, rd], { value: nativeAmount, gasLimit: (gas * 150n) / 100n })).wait();
      } else {
        const gas = await pm.mint.estimateGas(params);
        receipt = await (await pm.mint(params, { gasLimit: (gas * 150n) / 100n })).wait();
      }
      setAmountA(""); setAmountB("");
      await Promise.all([fetchPoolState(), fetchBalances()]);
      toast({
        title: "Liquidity added!",
        description: (
          <div className="flex items-center gap-2">
            <span>V3 liquidity added (Safe Mode)</span>
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}>
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error("Add liquidity error:", error);
      toast({ title: "Failed to add liquidity", description: error.reason || error.message || "Transaction failed", variant: "destructive" });
    } finally { setIsAdding(false); }
  };

  const amountAExceedsBalance =
    isConnected && balanceA !== null && tokenA !== null && amountA !== "" &&
    parseFloat(amountA) > 0 && parseAmount(amountA, tokenA.decimals) > balanceA;

  const amountBExceedsBalance =
    isConnected && balanceB !== null && tokenB !== null && amountB !== "" &&
    parseFloat(amountB) > 0 && parseAmount(amountB, tokenB.decimals) > balanceB;

  const canSubmit = !!(
    tokenA && tokenB && amountA && amountB &&
    parseFloat(amountA) > 0 && parseFloat(amountB) > 0 &&
    !isAdding && !amountAExceedsBalance && !amountBExceedsBalance &&
    poolHealth?.severity !== "error"
  );

  const addButtonLabel = () => {
    if (isAdding) return "Adding Liquidity…";
    if (!tokenA || !tokenB) return "Select Tokens";
    if (!amountA || parseFloat(amountA) <= 0) return "Enter Amount";
    if (amountAExceedsBalance || amountBExceedsBalance) return "Insufficient Balance";
    if (poolHealth?.severity === "error") return "Fix Pool Issues First";
    return "Add V3 Liquidity";
  };

  // ── Reusable Token Input Block ─────────────────────────────────────────────
  const TokenInputBlock = ({
    label, amount, setAmount, token, onSelect, balance,
    disabled, exceeds, onMax, testIdInput, testIdBtn,
  }: {
    label: string; amount: string; setAmount: (v: string) => void;
    token: Token | null; onSelect: () => void; balance: bigint | null;
    disabled?: boolean; exceeds?: boolean; onMax: () => void;
    testIdInput?: string; testIdBtn?: string;
  }) => (
    <div className={`rounded-2xl bg-slate-800/60 border p-4 space-y-3 transition-all ${
      exceeds
        ? "border-red-500/40 bg-red-500/5"
        : disabled
          ? "border-slate-700/30 opacity-60"
          : "border-slate-700/50 hover:border-slate-600/60"
    }`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
        {isConnected && token && (
          <button
            type="button"
            onClick={onMax}
            disabled={balance === null || disabled}
            className="text-xs text-slate-400 hover:text-blue-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {balance !== null
              ? <>Balance: <span className="font-medium text-slate-300">{formatBalance(balance, token.decimals)}</span> <span className="text-blue-400 font-bold ml-1">MAX</span></>
              : "Balance: —"
            }
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <Input
            data-testid={testIdInput}
            type="number"
            placeholder={disabled ? "Calculated automatically" : "0.00"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={disabled}
            className="border-0 bg-transparent text-2xl sm:text-3xl font-bold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-slate-600 disabled:opacity-40 w-full"
            style={{ color: exceeds ? "rgb(248 113 113)" : "white" }}
          />
          {exceeds && (
            <p className="text-xs text-red-400 mt-1 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              Exceeds balance
            </p>
          )}
          {disabled && poolExists && currentPrice !== null && (
            <p className="text-[10px] text-slate-500 mt-1">Auto-calculated from pool price</p>
          )}
        </div>

        <Button
          data-testid={testIdBtn}
          onClick={onSelect}
          variant="secondary"
          className="h-10 px-3 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-xl gap-2 min-w-[110px] justify-between flex-shrink-0"
        >
          {token ? (
            <>
              <div className="flex items-center gap-1.5">
                <img
                  src={token.logoURI || "/img/logos/unknown-token.png"}
                  alt={token.symbol}
                  className="w-5 h-5 rounded-full flex-shrink-0"
                  onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                />
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
    </div>
  );

  return (
    <div className="w-full space-y-3">
      {/* Safe mode banner */}
      <div className="flex items-start gap-3 p-3.5 bg-blue-500/8 border border-blue-500/20 rounded-2xl">
        <Shield className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-blue-400 leading-none mb-1">Safe Mode — Full Range</p>
          <p className="text-xs text-slate-400 leading-relaxed">
            Liquidity is placed across the full price range. Always earns fees — ideal for beginners.
          </p>
        </div>
      </div>

      {/* Token Inputs */}
      <TokenInputBlock
        label="Token A"
        amount={amountA}
        setAmount={setAmountA}
        token={tokenA}
        onSelect={() => setShowTokenASelector(true)}
        balance={balanceA}
        exceeds={amountAExceedsBalance}
        onMax={handleMaxA}
        testIdInput="input-token-a"
        testIdBtn="button-select-token-a"
      />

      <TokenInputBlock
        label="Token B"
        amount={amountB}
        setAmount={setAmountB}
        token={tokenB}
        onSelect={() => setShowTokenBSelector(true)}
        balance={balanceB}
        disabled={poolExists && !!currentPrice}
        exceeds={amountBExceedsBalance}
        onMax={handleMaxB}
        testIdInput="input-token-b"
        testIdBtn="button-select-token-b"
      />

      {/* Fee Tier */}
      <div className="rounded-2xl bg-slate-800/60 border border-slate-700/50 p-4 space-y-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Fee Tier</span>
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

      {/* Pool health */}
      {tokenA && tokenB && (
        isCheckingPool ? (
          <div className="flex items-center gap-3 p-4 rounded-2xl bg-slate-800/60 border border-slate-700/50 text-slate-400 text-sm">
            <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Checking pool status…
          </div>
        ) : (
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
        )
      )}

      {/* CTA */}
      {isConnected ? (
        <Button
          onClick={handleAddLiquidity}
          disabled={!canSubmit}
          className="w-full text-base font-bold rounded-2xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20 transition-all duration-200 hover:shadow-blue-500/30 hover:scale-[1.01] active:scale-[0.99]"
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

      <TokenSelector
        open={showTokenASelector}
        onClose={() => setShowTokenASelector(false)}
        onSelect={(token) => { setTokenA(token); setShowTokenASelector(false); }}
        tokens={tokens}
        onImport={handleImportToken}
      />
      <TokenSelector
        open={showTokenBSelector}
        onClose={() => setShowTokenBSelector(false)}
        onSelect={(token) => { setTokenB(token); setShowTokenBSelector(false); }}
        tokens={tokens}
        onImport={handleImportToken}
      />
    </div>
  );
}
