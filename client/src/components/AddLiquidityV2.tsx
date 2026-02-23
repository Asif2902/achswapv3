import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, ExternalLink, RefreshCw, Info, Droplets, AlertTriangle } from "lucide-react";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useBalance, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, formatUnits, parseUnits } from "ethers";
import { defaultTokens, getTokensByChainId } from "@/data/tokens";
import { formatAmount, parseAmount, calculateRatio } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getErrorForToast } from "@/lib/error-utils";
import { getRpcUrl, FALLBACK_RPC, fetchWithRetry } from "@/lib/config";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

export function AddLiquidityV2() {
  const [tokenA, setTokenA] = useState<Token | null>(null);
  const [tokenB, setTokenB] = useState<Token | null>(null);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [showTokenASelector, setShowTokenASelector] = useState(false);
  const [showTokenBSelector, setShowTokenBSelector] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [pairExists, setPairExists] = useState(false);
  const [reserveA, setReserveA] = useState<bigint>(0n);
  const [reserveB, setReserveB] = useState<bigint>(0n);
  const [isLoadingPair, setIsLoadingPair] = useState(false);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;

  const FACTORY_ABI = [
    "function getPair(address tokenA, address tokenB) external view returns (address pair)"
  ];
  const PAIR_ABI = [
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
  ];
  const ROUTER_ABI = [
    "function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB, uint liquidity)",
    "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)"
  ];

  useEffect(() => { loadTokens(); }, [chainId]);

  const openExplorer = (txHash: string) => {
    if (contracts) window.open(`${contracts.explorer}${txHash}`, "_blank");
  };

  useEffect(() => {
    const checkPairExists = async () => {
      if (!tokenA || !tokenB || !window.ethereum) {
        setPairExists(false); setReserveA(0n); setReserveB(0n); return;
      }
      setIsLoadingPair(true);
      try {
        if (!contracts) return;
        const provider = new BrowserProvider(window.ethereum);
        const factory = new Contract(contracts.v2.factory, FACTORY_ABI, provider);
        const wrappedToken = tokens.find(t => t.symbol === 'wUSDC');
        const wrappedAddress = wrappedToken?.address;
        if (!wrappedAddress) { setPairExists(false); setReserveA(0n); setReserveB(0n); setIsLoadingPair(false); return; }
        const isTokenANative = tokenA.address === "0x0000000000000000000000000000000000000000";
        const isTokenBNative = tokenB.address === "0x0000000000000000000000000000000000000000";
        const tokenAAddress = isTokenANative ? wrappedAddress : tokenA.address;
        const tokenBAddress = isTokenBNative ? wrappedAddress : tokenB.address;
        const pairAddress = await factory.getPair(tokenAAddress, tokenBAddress);
        if (pairAddress === "0x0000000000000000000000000000000000000000") {
          setPairExists(false); setReserveA(0n); setReserveB(0n);
        } else {
          setPairExists(true);
          const pairContract = new Contract(pairAddress, PAIR_ABI, provider);
          const [reserve0, reserve1] = await pairContract.getReserves();
          const token0Address = await pairContract.token0();
          if (tokenAAddress.toLowerCase() === token0Address.toLowerCase()) {
            setReserveA(reserve0); setReserveB(reserve1);
          } else {
            setReserveA(reserve1); setReserveB(reserve0);
          }
        }
      } catch (error) {
        console.error('Failed to check pair:', error);
        setPairExists(false); setReserveA(0n); setReserveB(0n);
      } finally { setIsLoadingPair(false); }
    };
    checkPairExists();
  }, [tokenA, tokenB, tokens, address]);

  useEffect(() => {
    if (!pairExists || !tokenA || !tokenB || !amountA || parseFloat(amountA) <= 0) return;
    if (reserveA === 0n || reserveB === 0n) return;
    try {
      const amountABigInt = parseAmount(amountA, tokenA.decimals);
      const amountBBigInt = (amountABigInt * reserveB) / reserveA;
      setAmountB(formatAmount(amountBBigInt, tokenB.decimals));
    } catch (error) { console.error('Failed to calculate amount B:', error); }
  }, [amountA, pairExists, tokenA, tokenB, reserveA, reserveB]);

  const loadTokens = async () => {
    try {
      if (!chainId) return;
      const chainTokens = getTokensByChainId(chainId);
      const imported = localStorage.getItem('importedTokens');
      const importedTokens = imported ? JSON.parse(imported) : [];
      const chainImportedTokens = importedTokens.filter((t: Token) => t.chainId === chainId);
      setTokens([
        ...chainTokens.map(t => ({ ...t, logoURI: t.logoURI || `/img/logos/unknown-token.png` })),
        ...chainImportedTokens.map((t: Token) => ({ ...t, logoURI: t.logoURI || `/img/logos/unknown-token.png` }))
      ]);
    } catch (error) { console.error('Failed to load tokens:', error); }
  };

  const handleImportToken = async (address: string): Promise<Token | null> => {
    try {
      if (!address || address.length !== 42 || !address.startsWith('0x')) throw new Error("Invalid token address format");
      const exists = tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
      if (exists) { toast({ title: "Token already added", description: `${exists.symbol} is already in your token list` }); return exists; }
      const primaryRpcUrl = getRpcUrl(chainId);
      const fallbackRpcUrl = chainId === 2201 ? getRpcUrl(2201) : FALLBACK_RPC;
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          let url = primaryRpcUrl;
          try {
            const r = await fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 3);
            const d = await r.json();
            if (d.error) throw new Error(d.error.message);
            return d.result;
          } catch {
            console.warn('Primary RPC failed, trying fallback');
            url = fallbackRpcUrl;
            const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
            const d = await r.json();
            if (d.error) throw new Error(d.error.message);
            return d.result;
          }
        },
      });
      const contract = new Contract(address, ERC20_ABI, provider);
      const [name, symbol, decimals] = await Promise.race([Promise.all([contract.name(), contract.symbol(), contract.decimals()]), new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), 10000))]) as [string, string, bigint];
      if (!chainId) throw new Error("Chain ID not available");
      const newToken: Token = { address, name, symbol, decimals: Number(decimals), logoURI: "/img/logos/unknown-token.png", verified: false, chainId };
      const imported = localStorage.getItem('importedTokens');
      const importedTokens = imported ? JSON.parse(imported) : [];
      if (!importedTokens.find((t: Token) => t.address.toLowerCase() === address.toLowerCase())) { importedTokens.push(newToken); localStorage.setItem('importedTokens', JSON.stringify(importedTokens)); }
      setTokens(prev => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} has been added to your token list` });
      return newToken;
    } catch (error: any) {
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
      return null;
    }
  };

  const isTokenANative = tokenA?.address === "0x0000000000000000000000000000000000000000";
  const isTokenBNative = tokenB?.address === "0x0000000000000000000000000000000000000000";

  const { data: balanceA, refetch: refetchBalanceA } = useBalance({
    address: address as `0x${string}` | undefined,
    ...(tokenA && !isTokenANative ? { token: tokenA.address as `0x${string}` } : {}),
  });
  const { data: balanceB, refetch: refetchBalanceB } = useBalance({
    address: address as `0x${string}` | undefined,
    ...(tokenB && !isTokenBNative ? { token: tokenB.address as `0x${string}` } : {}),
  });

  const balanceAFormatted = balanceA ? formatAmount(balanceA.value, balanceA.decimals) : "0.00";
  const balanceBFormatted = balanceB ? formatAmount(balanceB.value, balanceB.decimals) : "0.00";

  const poolHasLiquidity = pairExists && reserveA > 0n && reserveB > 0n;
  const isNewPool = !pairExists;
  const isEmptyPool = pairExists && (reserveA === 0n || reserveB === 0n);

  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !amountA || !amountB || parseFloat(amountA) <= 0 || parseFloat(amountB) <= 0) return;
    setIsAdding(true);
    try {
      if (!address || !window.ethereum) throw new Error("Please connect your wallet");
      const amountADesired = parseAmount(amountA, tokenA.decimals);
      const amountBDesired = parseAmount(amountB, tokenB.decimals);
      if (balanceA && amountADesired > balanceA.value) throw new Error(`Insufficient ${tokenA.symbol} balance`);
      if (balanceB && amountBDesired > balanceB.value) throw new Error(`Insufficient ${tokenB.symbol} balance`);
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      if (!contracts) throw new Error("Chain contracts not configured");
      const router = new Contract(contracts.v2.router, ROUTER_ABI, signer);
      const amountAMin = (!pairExists || reserveA === 0n || reserveB === 0n) ? 0n : amountADesired * 95n / 100n;
      const amountBMin = (!pairExists || reserveA === 0n || reserveB === 0n) ? 0n : amountBDesired * 95n / 100n;
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const wrappedSymbol = chainId === 2201 ? 'wUSDT' : 'wUSDC';
      const wrappedToken = tokens.find(t => t.symbol === wrappedSymbol);
      if (!wrappedToken?.address) throw new Error(`${wrappedSymbol} token not found`);
      const tokenAAddress = isTokenANative ? wrappedToken.address : tokenA.address;
      const tokenBAddress = isTokenBNative ? wrappedToken.address : tokenB.address;
      toast({ title: "Adding liquidity", description: `Adding ${amountA} ${tokenA.symbol} and ${amountB} ${tokenB.symbol}` });
      let tx;
      if (isTokenANative || isTokenBNative) {
        const token = isTokenANative ? tokenB : tokenA;
        const tokenAddress = isTokenANative ? tokenBAddress : tokenAAddress;
        const tokenAmount = isTokenANative ? amountBDesired : amountADesired;
        const tokenAmountMin = isTokenANative ? amountBMin : amountAMin;
        const ethAmount = isTokenANative ? amountADesired : amountBDesired;
        const ethAmountMin = isTokenANative ? amountAMin : amountBMin;
        const tokenContract = new Contract(token.address, ERC20_ABI, signer);
        const allowance = await tokenContract.allowance(address, contracts.v2.router);
        if (allowance < tokenAmount) {
          const g = await tokenContract.approve.estimateGas(contracts.v2.router, tokenAmount);
          const approveTx = await tokenContract.approve(contracts.v2.router, tokenAmount, { gasLimit: g * 150n / 100n });
          const approveReceipt = await approveTx.wait();
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);
          toast({ title: "Approval successful", description: (<div className="flex items-center gap-2"><span>Token approval confirmed</span><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(approveReceipt.hash)}><ExternalLink className="h-3 w-3" /></Button></div>) });
        }
        const gasEstimate = await router.addLiquidityETH.estimateGas(tokenAddress, tokenAmount, tokenAmountMin, ethAmountMin, address, deadline, { value: ethAmount });
        tx = await router.addLiquidityETH(tokenAddress, tokenAmount, tokenAmountMin, ethAmountMin, address, deadline, { value: ethAmount, gasLimit: gasEstimate * 150n / 100n });
      } else {
        const tokenAContract = new Contract(tokenAAddress, ERC20_ABI, signer);
        const tokenBContract = new Contract(tokenBAddress, ERC20_ABI, signer);
        if ((await tokenAContract.allowance(address, contracts.v2.router)) < amountADesired) {
          const g = await tokenAContract.approve.estimateGas(contracts.v2.router, amountADesired);
          const approveTx = await tokenAContract.approve(contracts.v2.router, amountADesired, { gasLimit: g * 150n / 100n });
          const approveReceipt = await approveTx.wait();
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);
          toast({ title: "Approval successful", description: (<div className="flex items-center gap-2"><span>Token A approved</span><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(approveReceipt.hash)}><ExternalLink className="h-3 w-3" /></Button></div>) });
        }
        if ((await tokenBContract.allowance(address, contracts.v2.router)) < amountBDesired) {
          const g = await tokenBContract.approve.estimateGas(contracts.v2.router, amountBDesired);
          const approveTx = await tokenBContract.approve(contracts.v2.router, amountBDesired, { gasLimit: g * 150n / 100n });
          const approveReceipt = await approveTx.wait();
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);
          toast({ title: "Approval successful", description: (<div className="flex items-center gap-2"><span>Token B approved</span><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(approveReceipt.hash)}><ExternalLink className="h-3 w-3" /></Button></div>) });
        }
        const gasEstimate = await router.addLiquidity.estimateGas(tokenAAddress, tokenBAddress, amountADesired, amountBDesired, amountAMin, amountBMin, address, deadline);
        tx = await router.addLiquidity(tokenAAddress, tokenBAddress, amountADesired, amountBDesired, amountAMin, amountBMin, address, deadline, { gasLimit: gasEstimate * 150n / 100n });
      }
      await tx.wait();
      setAmountA(""); setAmountB("");
      await new Promise(resolve => setTimeout(resolve, 1500));
      await Promise.all([refetchBalanceA(), refetchBalanceB()]);
      toast({ title: "Liquidity added!", description: (<div className="flex items-center gap-2"><span>Successfully added to {tokenA.symbol}/{tokenB.symbol} pool</span><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(tx.hash)}><ExternalLink className="h-3 w-3" /></Button></div>) });
    } catch (error: any) {
      console.error('Add liquidity error:', error);
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
    } finally { setIsAdding(false); }
  };

  const poolStatusConfig = isLoadingPair
    ? { label: "Checking", color: "rgba(255,255,255,0.1)", text: "rgba(255,255,255,0.4)", dot: "#6b7280" }
    : poolHasLiquidity
    ? { label: "Active Pool", color: "rgba(34,197,94,0.12)", text: "#4ade80", dot: "#22c55e" }
    : isEmptyPool
    ? { label: "Empty Pool", color: "rgba(245,158,11,0.12)", text: "#fbbf24", dot: "#f59e0b" }
    : { label: "New Pool", color: "rgba(99,102,241,0.12)", text: "#818cf8", dot: "#6366f1" };

  const canSubmit = tokenA && tokenB && amountA && amountB && parseFloat(amountA) > 0 && parseFloat(amountB) > 0 && !isAdding;

  return (
    <>
      <style>{`
        .alv2-token-box {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          transition: border-color 0.2s, background 0.2s;
        }
        .alv2-token-box:focus-within {
          border-color: rgba(99,102,241,0.5);
          background: rgba(99,102,241,0.05);
        }
        .alv2-token-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px;
          border-radius: 12px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.1);
          color: white;
          font-weight: 600;
          font-size: 14px;
          cursor: pointer;
          transition: all 0.2s;
          white-space: nowrap;
        }
        .alv2-token-btn:hover {
          background: rgba(99,102,241,0.2);
          border-color: rgba(99,102,241,0.4);
        }
        .alv2-token-btn.empty {
          background: linear-gradient(135deg, rgba(99,102,241,0.25), rgba(139,92,246,0.25));
          border-color: rgba(99,102,241,0.4);
          color: #a5b4fc;
        }
        .alv2-max-btn {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.05em;
          padding: 3px 10px;
          border-radius: 8px;
          background: rgba(99,102,241,0.15);
          border: 1px solid rgba(99,102,241,0.3);
          color: #a5b4fc;
          cursor: pointer;
          transition: all 0.2s;
        }
        .alv2-max-btn:hover {
          background: rgba(99,102,241,0.3);
          border-color: rgba(99,102,241,0.6);
        }
        .alv2-input {
          background: transparent;
          border: none;
          outline: none;
          color: white;
          font-size: clamp(20px, 5vw, 28px);
          font-weight: 700;
          width: 100%;
          font-variant-numeric: tabular-nums;
        }
        .alv2-input::placeholder { color: rgba(255,255,255,0.2); }
        .alv2-input:disabled { opacity: 0.7; cursor: not-allowed; }
        .alv2-input[type=number]::-webkit-outer-spin-button,
        .alv2-input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        .alv2-divider-ring {
          width: 40px; height: 40px;
          border-radius: 50%;
          background: rgba(99,102,241,0.15);
          border: 1px solid rgba(99,102,241,0.3);
          display: flex; align-items: center; justify-content: center;
          color: #818cf8;
          flex-shrink: 0;
        }
        .alv2-pool-card {
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.07);
          overflow: hidden;
        }
        .alv2-pool-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: rgba(255,255,255,0.02);
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .alv2-stat-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 16px;
        }
        .alv2-stat-row + .alv2-stat-row {
          border-top: 1px solid rgba(255,255,255,0.05);
        }
        .alv2-submit-btn {
          width: 100%;
          height: 52px;
          border-radius: 16px;
          font-weight: 700;
          font-size: 15px;
          letter-spacing: 0.02em;
          border: none;
          cursor: pointer;
          transition: all 0.2s;
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .alv2-submit-btn.active {
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: white;
          box-shadow: 0 4px 24px rgba(99,102,241,0.35);
        }
        .alv2-submit-btn.active:hover {
          background: linear-gradient(135deg, #4f46e5, #7c3aed);
          box-shadow: 0 6px 32px rgba(99,102,241,0.5);
          transform: translateY(-1px);
        }
        .alv2-submit-btn.loading {
          background: rgba(99,102,241,0.3);
          color: rgba(255,255,255,0.5);
          cursor: not-allowed;
        }
        .alv2-submit-btn.disabled {
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.25);
          cursor: not-allowed;
        }
        .alv2-refresh-btn {
          display: flex; align-items: center; gap: 4px;
          padding: 4px 10px;
          border-radius: 8px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.4);
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .alv2-refresh-btn:hover:not(:disabled) {
          background: rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.7);
        }
        .alv2-refresh-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        @keyframes alv2-spin { to { transform: rotate(360deg); } }
        .alv2-spin { animation: alv2-spin 1s linear infinite; }
        @keyframes alv2-pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
        .alv2-pulse { animation: alv2-pulse 1.5s ease-in-out infinite; }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* ── Banner ── */}
        <div style={{
          display: "flex", alignItems: "center", gap: "12px",
          padding: "12px 16px", borderRadius: "14px",
          background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)"
        }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(99,102,241,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Droplets style={{ width: 16, height: 16, color: "#818cf8" }} />
          </div>
          <div>
            <p style={{ fontSize: 12, fontWeight: 700, color: "#a5b4fc", margin: 0 }}>Add V2 Liquidity</p>
            <p style={{ fontSize: 11, color: "rgba(129,140,248,0.55)", margin: 0, marginTop: 2 }}>Earn 0.3% on every swap through your pool</p>
          </div>
        </div>

        {/* ── Token A Box ── */}
        <div className="alv2-token-box" style={{ padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Token A</span>
            {isConnected && tokenA && (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                Balance: <span style={{ color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>{balanceAFormatted}</span>
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              data-testid="input-token-a-amount"
              type="number"
              placeholder="0.00"
              value={amountA}
              onChange={e => setAmountA(e.target.value)}
              className="alv2-input"
              style={{ flex: 1, minWidth: 0 }}
            />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
              <button
                data-testid="button-select-token-a"
                onClick={() => setShowTokenASelector(true)}
                className={`alv2-token-btn ${!tokenA ? "empty" : ""}`}
              >
                {tokenA ? (
                  <>
                    <img src={tokenA.logoURI} alt={tokenA.symbol} style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)" }} />
                    <span>{tokenA.symbol}</span>
                  </>
                ) : (
                  <span>Select token</span>
                )}
              </button>
              {isConnected && tokenA && balanceA && (
                <button className="alv2-max-btn" onClick={() => setAmountA(balanceAFormatted)}>MAX</button>
              )}
            </div>
          </div>
        </div>

        {/* ── Plus divider ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="alv2-divider-ring">
            <Plus style={{ width: 18, height: 18 }} />
          </div>
        </div>

        {/* ── Token B Box ── */}
        <div className="alv2-token-box" style={{ padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Token B</span>
            {isConnected && tokenB && (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                Balance: <span style={{ color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>{balanceBFormatted}</span>
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              data-testid="input-token-b-amount"
              type="number"
              placeholder={poolHasLiquidity ? "Auto-calculated" : "0.00"}
              value={amountB}
              onChange={e => poolHasLiquidity ? null : setAmountB(e.target.value)}
              disabled={poolHasLiquidity}
              className="alv2-input"
              style={{ flex: 1, minWidth: 0, opacity: poolHasLiquidity ? 0.7 : 1 }}
            />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
              <button
                data-testid="button-select-token-b"
                onClick={() => setShowTokenBSelector(true)}
                className={`alv2-token-btn ${!tokenB ? "empty" : ""}`}
              >
                {tokenB ? (
                  <>
                    <img src={tokenB.logoURI} alt={tokenB.symbol} style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)" }} />
                    <span>{tokenB.symbol}</span>
                  </>
                ) : (
                  <span>Select token</span>
                )}
              </button>
              {isConnected && tokenB && balanceB && !poolHasLiquidity && (
                <button className="alv2-max-btn" onClick={() => setAmountB(balanceBFormatted)}>MAX</button>
              )}
            </div>
          </div>

          {poolHasLiquidity && amountB && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <Info style={{ width: 12, height: 12, color: "rgba(129,140,248,0.6)", flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "rgba(129,140,248,0.6)" }}>Calculated from pool ratio</span>
            </div>
          )}
        </div>

        {/* ── Pool Info Card ── */}
        {tokenA && tokenB && (
          <div className="alv2-pool-card">
            {/* Header */}
            <div className="alv2-pool-header">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Pool Info</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Status badge */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "3px 10px", borderRadius: 20,
                  background: poolStatusConfig.color,
                  border: `1px solid ${poolStatusConfig.dot}30`,
                }}>
                  {isLoadingPair ? (
                    <span className="alv2-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "#6b7280", display: "inline-block" }} />
                  ) : (
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: poolStatusConfig.dot, display: "inline-block" }} />
                  )}
                  <span style={{ fontSize: 11, fontWeight: 700, color: poolStatusConfig.text }}>
                    {poolStatusConfig.label}
                  </span>
                </div>
                <button
                  className="alv2-refresh-btn"
                  disabled={isLoadingPair}
                  data-testid="button-refresh-pool"
                  onClick={() => { setIsLoadingPair(true); setTimeout(() => setTokenA(tokenA), 100); }}
                >
                  <RefreshCw style={{ width: 11, height: 11 }} className={isLoadingPair ? "alv2-spin" : ""} />
                </button>
              </div>
            </div>

            {/* Pool ratio */}
            {poolHasLiquidity && (
              <>
                <div className="alv2-stat-row">
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Pool Ratio</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "white", fontVariantNumeric: "tabular-nums" }}>
                    1 {tokenA.symbol} = {calculateRatio(reserveB, tokenB.decimals, reserveA, tokenA.decimals)} {tokenB.symbol}
                  </span>
                </div>
                <div className="alv2-stat-row">
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Slippage Tolerance</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#4ade80" }}>5%</span>
                </div>
                {amountA && amountB && parseFloat(amountA) > 0 && parseFloat(amountB) > 0 && (
                  <div className="alv2-stat-row">
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Your deposit</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "white" }}>
                      {parseFloat(amountA).toFixed(4)} + {parseFloat(amountB).toFixed(4)}
                    </span>
                  </div>
                )}
              </>
            )}

            {/* New / empty pool */}
            {(isNewPool || isEmptyPool) && (
              <>
                <div className="alv2-stat-row">
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
                    {isEmptyPool ? "Pool is empty — set initial ratio" : "Set initial price ratio"}
                  </span>
                </div>
                {amountA && amountB && parseFloat(amountA) > 0 && parseFloat(amountB) > 0 ? (
                  <div className="alv2-stat-row" style={{ background: "rgba(99,102,241,0.05)" }}>
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Initial ratio</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#a5b4fc" }}>
                      1 {tokenA.symbol} = {(parseFloat(amountB) / parseFloat(amountA)).toFixed(6)} {tokenB.symbol}
                    </span>
                  </div>
                ) : (
                  <div className="alv2-stat-row">
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", fontStyle: "italic" }}>Enter amounts to preview ratio</span>
                  </div>
                )}
              </>
            )}

            {/* New pool warning */}
            {isNewPool && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: 8,
                padding: "10px 16px",
                background: "rgba(245,158,11,0.05)",
                borderTop: "1px solid rgba(245,158,11,0.15)"
              }}>
                <AlertTriangle style={{ width: 13, height: 13, color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />
                <p style={{ fontSize: 11, color: "rgba(245,158,11,0.7)", margin: 0, lineHeight: 1.5 }}>
                  You are creating a new pool. The ratio you set becomes the initial price.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Submit button ── */}
        {isConnected ? (
          <button
            data-testid="button-add-liquidity"
            onClick={handleAddLiquidity}
            disabled={!canSubmit}
            className={`alv2-submit-btn ${isAdding ? "loading" : canSubmit ? "active" : "disabled"}`}
          >
            {isAdding ? (
              <>
                <span style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "white", borderRadius: "50%", display: "inline-block" }} className="alv2-spin" />
                Adding Liquidity…
              </>
            ) : (
              <>
                <Droplets style={{ width: 18, height: 18 }} />
                Add Liquidity
              </>
            )}
          </button>
        ) : (
          <button disabled className="alv2-submit-btn disabled" data-testid="button-connect-wallet">
            Connect Wallet to Continue
          </button>
        )}
      </div>

      <TokenSelector
        open={showTokenASelector}
        onClose={() => setShowTokenASelector(false)}
        onSelect={token => { setTokenA(token); setShowTokenASelector(false); }}
        tokens={tokens}
        onImport={handleImportToken}
      />
      <TokenSelector
        open={showTokenBSelector}
        onClose={() => setShowTokenBSelector(false)}
        onSelect={token => { setTokenB(token); setShowTokenBSelector(false); }}
        tokens={tokens}
        onImport={handleImportToken}
      />
    </>
  );
}
