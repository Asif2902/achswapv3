import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, formatUnits, parseUnits } from "ethers";
import { getTokensByChainId } from "@/data/tokens";
import { formatAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getErrorForToast } from "@/lib/error-utils";
import { ExternalLink, Trash2, Coins, RefreshCw, Wallet, ChevronRight, ArrowDown, Plus, Search } from "lucide-react";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

const FACTORY_ABI = [
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function getPair(address, address) view returns (address)",
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

interface V2Position {
  pairAddress: string;
  token0Address: string;
  token0Symbol: string;
  token0Decimals: number;
  token1Address: string;
  token1Symbol: string;
  token1Decimals: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
}

export function RemoveLiquidityV2() {
  const [positions, setPositions] = useState<V2Position[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<V2Position | null>(null);
  const [percentage, setPercentage] = useState([50]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importTokenA, setImportTokenA] = useState<Token | null>(null);
  const [importTokenB, setImportTokenB] = useState<Token | null>(null);
  const [showTokenASelector, setShowTokenASelector] = useState(false);
  const [showTokenBSelector, setShowTokenBSelector] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;
  const knownTokens = getTokensByChainId(chainId);

  const getTokenLogo = (symbol: string): string =>
    knownTokens.find((t) => t.symbol === symbol)?.logoURI ??
    "/img/logos/unknown-token.png";

  // Load tokens
  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    const imported = localStorage.getItem("importedTokens");
    const importedTokens = imported ? JSON.parse(imported) : [];
    const chainImportedTokens = importedTokens.filter((t: Token) => t.chainId === chainId);
    const processed = chainTokens.map(token => ({ ...token, logoURI: token.logoURI || "/img/logos/unknown-token.png" }));
    setTokens([...processed, ...chainImportedTokens]);
  }, [chainId]);

  const loadPositions = useCallback(async () => {
    if (!address || !contracts || !window.ethereum) {
      console.log("loadPositions: missing requirements", { address: !!address, contracts: !!contracts, ethereum: !!window.ethereum });
      return;
    }
    setIsLoading(true);
    try {
      console.log("Loading V2 positions for:", address);
      const provider = new BrowserProvider(window.ethereum);
      const factory = new Contract(contracts.v2.factory, FACTORY_ABI, provider);
      
      const pairsLength = await factory.allPairsLength();
      console.log("Total V2 pairs:", pairsLength.toString());
      
      // Get all pair addresses first
      const pairAddresses: string[] = [];
      for (let i = 0; i < Number(pairsLength); i++) {
        const pairAddr = await factory.allPairs(i);
        pairAddresses.push(pairAddr);
      }
      
      console.log("Got all pair addresses:", pairAddresses.length);
      
      // Check balances for all pairs in parallel
      const pairContracts = pairAddresses.map(addr => new Contract(addr, PAIR_ABI, provider));
      const balances = await Promise.all(pairContracts.map(pair => pair.balanceOf(address)));
      
      // Filter pairs with balance and get details in parallel
      const positionsWithBalance = pairAddresses.filter((_, i) => balances[i] > 0n);
      console.log("Pairs with balance:", positionsWithBalance.length);
      
      if (positionsWithBalance.length === 0) {
        setPositions([]);
        return;
      }
      
      const userPositions: V2Position[] = [];
      
      // Process each position with balance
      for (const pairAddress of positionsWithBalance) {
        const pair = new Contract(pairAddress, PAIR_ABI, provider);
        const [token0Address, token1Address, reserves, totalSupply, liquidity] = await Promise.all([
          pair.token0(),
          pair.token1(),
          pair.getReserves(),
          pair.totalSupply(),
          pair.balanceOf(address),
        ]);
        
        const token0Contract = new Contract(token0Address, ERC20_ABI, provider);
        const token1Contract = new Contract(token1Address, ERC20_ABI, provider);
        
        const [token0Symbol, token0Decimals, token1Symbol, token1Decimals] = await Promise.all([
          token0Contract.symbol(),
          token0Contract.decimals(),
          token1Contract.symbol(),
          token1Contract.decimals(),
        ]);
        
        const amount0 = liquidity * reserves.reserve0 / totalSupply;
        const amount1 = liquidity * reserves.reserve1 / totalSupply;
        
        userPositions.push({
          pairAddress,
          token0Address,
          token0Symbol,
          token0Decimals,
          token1Address,
          token1Symbol,
          token1Decimals,
          liquidity,
          amount0,
          amount1,
        });
      }
      
      setPositions(userPositions);
      console.log("Found V2 positions:", userPositions.length);
      if (userPositions.length > 0 && selectedPosition === null) {
        setSelectedPosition(userPositions[0]);
      }
    } catch (error) {
      console.error("Failed to load V2 positions:", error);
    } finally {
      setIsLoading(false);
    }
  }, [address, contracts]);

  useEffect(() => {
    if (isConnected && address) {
      loadPositions();
    }
  }, [isConnected, address]);

  const handleImportPool = async () => {
    if (!importTokenA || !importTokenB || !contracts || !window.ethereum) return;
    
    try {
      const provider = new BrowserProvider(window.ethereum);
      const factory = new Contract(contracts.v2.factory, FACTORY_ABI, provider);
      const pairAddress = await factory.getPair(
        importTokenA.address === "0x0000000000000000000000000000000000000000" 
          ? "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA"
          : importTokenA.address,
        importTokenB.address === "0x0000000000000000000000000000000000000000"
          ? "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA"
          : importTokenB.address
      );
      
      if (pairAddress === "0x0000000000000000000000000000000000000000") {
        toast({ title: "Pool not found", description: "This pool does not exist", variant: "destructive" });
        return;
      }
      
      const pair = new Contract(pairAddress, PAIR_ABI, provider);
      const [token0Address, reserves, totalSupply] = await Promise.all([
        pair.token0(),
        pair.getReserves(),
        pair.totalSupply(),
      ]);
      
      const balance = await pair.balanceOf(address);
      
      if (balance === 0n) {
        toast({ title: "No liquidity", description: "You don't have LP tokens for this pool", variant: "destructive" });
        return;
      }
      
      const token0Contract = new Contract(token0Address, ERC20_ABI, provider);
      const [token0Symbol, token0Decimals, token1Symbol, token1Decimals] = await Promise.all([
        token0Contract.symbol(),
        token0Contract.decimals(),
        token0Address === importTokenA.address || token0Address === "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA"
          ? importTokenB.symbol
          : importTokenA.symbol,
        token0Address === importTokenA.address || token0Address === "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA"
          ? importTokenB.decimals
          : importTokenA.decimals,
      ]);
      
      const amount0 = balance * reserves.reserve0 / totalSupply;
      const amount1 = balance * reserves.reserve1 / totalSupply;
      
      const newPosition: V2Position = {
        pairAddress,
        token0Address,
        token0Symbol,
        token0Decimals,
        token1Address: token0Address === importTokenA.address || token0Address === "0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA" 
          ? importTokenB.address 
          : importTokenA.address,
        token1Symbol,
        token1Decimals,
        liquidity: balance,
        amount0,
        amount1,
      };
      
      setPositions(prev => {
        const exists = prev.find(p => p.pairAddress === pairAddress);
        if (exists) return prev;
        return [...prev, newPosition];
      });
      setSelectedPosition(newPosition);
      setShowImportModal(false);
      setImportTokenA(null);
      setImportTokenB(null);
      toast({ title: "Pool imported", description: `Added ${token0Symbol}/${token1Symbol} pool` });
    } catch (error) {
      console.error("Import failed:", error);
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
    }
  };

  const previewAmounts = selectedPosition ? {
    amount0: selectedPosition.amount0 * BigInt(percentage[0]) / 100n,
    amount1: selectedPosition.amount1 * BigInt(percentage[0]) / 100n,
  } : null;

  const handleRemove = async () => {
    if (!selectedPosition || !address || !contracts || !window.ethereum) return;
    
    setIsRemoving(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      const routerABI = [
        "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)",
        "function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)",
      ];
      
      const router = new Contract(contracts.v2.router, routerABI, signer);
      const liquidityToRemove = selectedPosition.liquidity * BigInt(percentage[0]) / 100n;
      const deadline = Math.floor(Date.now() / 1000) + 600;
      
      const isToken0Native = selectedPosition.token0Address === "0x0000000000000000000000000000000000000000";
      const isToken1Native = selectedPosition.token1Address === "0x0000000000000000000000000000000000000000";
      
      let tx;
      if (isToken0Native || isToken1Native) {
        const token = isToken0Native ? selectedPosition.token1Address : selectedPosition.token0Address;
        const amountTokenMin = 0;
        const amountETHMin = 0;
        tx = await router.removeLiquidityETH(token, liquidityToRemove, amountTokenMin, amountETHMin, address, deadline);
      } else {
        const amountAMin = 0;
        const amountBMin = 0;
        tx = await router.removeLiquidity(
          selectedPosition.token0Address,
          selectedPosition.token1Address,
          liquidityToRemove,
          amountAMin,
          amountBMin,
          address,
          deadline
        );
      }
      
      await tx.wait();
      toast({ title: "Liquidity removed!", description: `Removed ${percentage[0]}% of your V2 liquidity` });
      setPercentage([50]);
      await loadPositions();
    } catch (error: any) {
      console.error("Remove liquidity error:", error);
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
    } finally {
      setIsRemoving(false);
    }
  };

  const fmt = (amount: bigint, decimals: number) => {
    const val = formatAmount(amount, decimals);
    return parseFloat(val).toFixed(4);
  };

  const fmtCompact = (amount: bigint, decimals: number) => {
    const val = formatAmount(amount, decimals);
    const n = parseFloat(val);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
    return n.toFixed(2);
  };

  return (
    <div className="w-full max-w-md mx-auto">
      {/* ── Empty state + Import ── */}
      {positions.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
          <div 
            className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <Wallet className="w-7 h-7 text-white/20" />
          </div>
          <p className="text-sm font-medium text-white/60 mb-1">No V2 liquidity positions</p>
          <p className="text-xs text-white/40 mb-6">Your V2 LP positions will appear here</p>
          
          <button
            onClick={() => setShowImportModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{ 
              background: "rgba(99,102,241,0.12)", 
              border: "1px solid rgba(99,102,241,0.3)",
              color: "#a5b4fc"
            }}
          >
            <Plus className="w-4 h-4" />
            Import Pool
          </button>
        </div>
      )}

      {/* ── Loading state ── */}
      {isLoading && (
        <div className="flex flex-col items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 text-white/40 animate-spin mb-3" />
          <p className="text-xs text-white/40">Loading your positions...</p>
        </div>
      )}

      {/* ── Positions list ── */}
      {positions.length > 0 && (
        <div className="space-y-3">
          {/* Header with import button */}
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/40">
              Your V2 Pools ({positions.length})
            </p>
            <button
              onClick={() => setShowImportModal(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{ 
                background: "rgba(255,255,255,0.04)", 
                border: "1px solid rgba(255,255,255,0.08)",
                color: "rgba(255,255,255,0.5)"
              }}
            >
              <Plus className="w-3 h-3" />
              Import
            </button>
          </div>

          {positions.map((position, index) => {
            const isSelected = selectedPosition?.pairAddress === position.pairAddress;
            
            return (
              <div key={position.pairAddress}>
                {/* Position card */}
                <button
                  onClick={() => setSelectedPosition(position)}
                  className="w-full text-left rounded-2xl p-4 transition-all"
                  style={{ 
                    background: isSelected ? "rgba(99,102,241,0.1)" : "rgba(255,255,255,0.025)",
                    border: `1px solid ${isSelected ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.06)"}`,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex -space-x-2">
                        <img
                          src={getTokenLogo(position.token0Symbol)}
                          alt={position.token0Symbol}
                          className="w-8 h-8 rounded-full border-2 border-[#0f1117] object-cover"
                          onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                        />
                        <img
                          src={getTokenLogo(position.token1Symbol)}
                          alt={position.token1Symbol}
                          className="w-8 h-8 rounded-full border-2 border-[#0f1117] object-cover"
                          onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                        />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white">
                            {position.token0Symbol}/{position.token1Symbol}
                          </span>
                          <span 
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={{ 
                              background: "rgba(99,102,241,0.15)", 
                              color: "#a5b4fc",
                              border: "1px solid rgba(99,102,241,0.25)"
                            }}
                          >
                            V2
                          </span>
                        </div>
                        <p className="text-[11px] text-white/40 mt-0.5">
                          {fmtCompact(position.liquidity, 18)} LP
                        </p>
                      </div>
                    </div>
                    <ChevronRight 
                      className={`w-4 h-4 text-white/30 transition-transform duration-200 ${isSelected ? "rotate-90" : ""}`}
                    />
                  </div>
                </button>

                {/* Expanded detail */}
                {isSelected && (
                  <div 
                    className="mt-2 rounded-2xl overflow-hidden"
                    style={{ 
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.06)"
                    }}
                  >
                    {/* Liquidity value */}
                    <div className="px-4 py-3" style={{ background: "rgba(255,255,255,0.02)" }}>
                      <div className="flex items-center gap-1.5 mb-2.5">
                        <Coins className="w-3 h-3 text-indigo-400/70" />
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
                          Liquidity Value
                        </span>
                      </div>
                      <div className="flex gap-6">
                        <div className="flex items-center gap-2">
                          <img
                            src={getTokenLogo(position.token0Symbol)}
                            alt={position.token0Symbol}
                            className="w-5 h-5 rounded-full flex-shrink-0"
                            onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                          />
                          <div>
                            <p className="text-sm font-semibold text-white tabular-nums">
                              {fmt(position.amount0, position.token0Decimals)}
                            </p>
                            <p className="text-[11px] text-white/40">{position.token0Symbol}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <img
                            src={getTokenLogo(position.token1Symbol)}
                            alt={position.token1Symbol}
                            className="w-5 h-5 rounded-full flex-shrink-0"
                            onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                          />
                          <div>
                            <p className="text-sm font-semibold text-white tabular-nums">
                              {fmt(position.amount1, position.token1Decimals)}
                            </p>
                            <p className="text-[11px] text-white/40">{position.token1Symbol}</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Percentage selector */}
                    <div className="px-4 py-3" style={{ background: "rgba(255,255,255,0.02)" }}>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-medium text-white/60">Remove amount</span>
                        <span className="text-2xl font-bold text-indigo-400 tabular-nums">
                          {percentage[0]}%
                        </span>
                      </div>

                      <Slider
                        value={percentage}
                        onValueChange={setPercentage}
                        max={100}
                        step={1}
                        className="py-1"
                      />

                      <div className="grid grid-cols-4 gap-1.5 mt-3">
                        {[25, 50, 75, 100].map((value) => (
                          <button
                            key={value}
                            onClick={() => setPercentage([value])}
                            className={`py-2.5 rounded-xl text-xs font-semibold transition-all min-h-[44px] flex items-center justify-center touch-manipulation ${
                              percentage[0] === value
                                ? "text-white shadow-sm"
                                : "text-white/40 hover:text-white/70 hover:bg-white/[0.05]"
                            }`}
                            style={percentage[0] === value ? {
                              background: "linear-gradient(135deg, rgba(99,102,241,0.8), rgba(139,92,246,0.8))",
                            } : {
                              background: "rgba(255,255,255,0.04)",
                              border: "1px solid rgba(255,255,255,0.08)"
                            }}
                          >
                            {value === 100 ? "MAX" : `${value}%`}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Preview */}
                    {previewAmounts && (previewAmounts.amount0 > 0n || previewAmounts.amount1 > 0n) && (
                      <div className="px-4 py-3" style={{ background: "rgba(255,255,255,0.02)" }}>
                        <div className="flex items-center gap-1.5 mb-2.5">
                          <ArrowDown className="w-3 h-3 text-indigo-400/70" />
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
                            You will receive
                          </span>
                        </div>
                        <div className="flex gap-6">
                          <div className="flex items-center gap-2">
                            <img
                              src={getTokenLogo(position.token0Symbol)}
                              alt={position.token0Symbol}
                              className="w-5 h-5 rounded-full flex-shrink-0"
                              onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                            />
                            <div>
                              <p className="text-sm font-semibold text-white tabular-nums">
                                {fmtCompact(previewAmounts.amount0, position.token0Decimals)}
                              </p>
                              <p className="text-[11px] text-white/40">{position.token0Symbol}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <img
                              src={getTokenLogo(position.token1Symbol)}
                              alt={position.token1Symbol}
                              className="w-5 h-5 rounded-full flex-shrink-0"
                              onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                            />
                            <div>
                              <p className="text-sm font-semibold text-white tabular-nums">
                                {fmtCompact(previewAmounts.amount1, position.token1Decimals)}
                              </p>
                              <p className="text-[11px] text-white/40">{position.token1Symbol}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Remove button */}
                    <div className="p-4">
                      <button
                        onClick={handleRemove}
                        disabled={isRemoving || percentage[0] === 0}
                        className="w-full py-3.5 rounded-xl text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{
                          background: "linear-gradient(135deg, #ef4444, #dc2626)",
                          color: "white",
                          boxShadow: "0 4px 14px rgba(239,68,68,0.3)"
                        }}
                      >
                        {isRemoving ? (
                          <span className="flex items-center justify-center gap-2">
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            Removing...
                          </span>
                        ) : (
                          `Remove ${percentage[0]}%`
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Import Modal ── */}
      {showImportModal && (
        <>
          <div 
            className="fixed inset-0 z-50"
            style={{ 
              background: "rgba(0,0,0,0.72)",
              backdropFilter: "blur(8px)"
            }}
            onClick={() => setShowImportModal(false)}
          />
          <div 
            className="fixed z-50 left-4 right-4 top-1/2 -translate-y-1/2 sm:left-auto sm:right-auto sm:top-auto sm:bottom-0 sm:left-1/2 sm:-translate-x-1/2 sm:translate-y-0 sm:w-full sm:max-w-md"
          >
            <div 
              className="rounded-2xl p-5"
              style={{ 
                background: "linear-gradient(160deg, #0f1117 0%, #0c0e13 100%)",
                border: "1px solid rgba(255,255,255,0.07)",
                boxShadow: "0 -4px 48px rgba(0,0,0,0.7)"
              }}
            >
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h3 className="text-base font-bold text-white">Import V2 Pool</h3>
                  <p className="text-[11px] text-white/40 mt-0.5">Select token pair to view your position</p>
                </div>
                <button
                  onClick={() => setShowImportModal(false)}
                  className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all"
                >
                  ×
                </button>
              </div>

              <div className="space-y-3">
                <button
                  onClick={() => setShowTokenASelector(true)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border transition-all"
                  style={{ 
                    background: importTokenA ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.08)"
                  }}
                >
                  {importTokenA ? (
                    <>
                      <img src={importTokenA.logoURI} alt={importTokenA.symbol} className="w-7 h-7 rounded-full" />
                      <span className="font-semibold text-white">{importTokenA.symbol}</span>
                    </>
                  ) : (
                    <span className="text-sm text-white/40">Select token A</span>
                  )}
                </button>

                <button
                  onClick={() => setShowTokenBSelector(true)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border transition-all"
                  style={{ 
                    background: importTokenB ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.08)"
                  }}
                >
                  {importTokenB ? (
                    <>
                      <img src={importTokenB.logoURI} alt={importTokenB.symbol} className="w-7 h-7 rounded-full" />
                      <span className="font-semibold text-white">{importTokenB.symbol}</span>
                    </>
                  ) : (
                    <span className="text-sm text-white/40">Select token B</span>
                  )}
                </button>
              </div>

              <button
                onClick={handleImportPool}
                disabled={!importTokenA || !importTokenB}
                className="w-full mt-4 py-3.5 rounded-xl text-sm font-bold transition-all disabled:opacity-50"
                style={{
                  background: importTokenA && importTokenB 
                    ? "linear-gradient(135deg, rgba(99,102,241,0.8), rgba(139,92,246,0.8))"
                    : "rgba(255,255,255,0.08)",
                  color: importTokenA && importTokenB ? "white" : "rgba(255,255,255,0.3)"
                }}
              >
                Load Pool
              </button>
            </div>
          </div>
        </>
      )}

      {/* Token Selectors */}
      <TokenSelector
        open={showTokenASelector}
        onClose={() => setShowTokenASelector(false)}
        onSelect={(token) => { setImportTokenA(token); setShowTokenASelector(false); }}
        tokens={tokens}
      />
      <TokenSelector
        open={showTokenBSelector}
        onClose={() => setShowTokenBSelector(false)}
        onSelect={(token) => { setImportTokenB(token); setShowTokenBSelector(false); }}
        tokens={tokens}
      />
    </div>
  );
}
