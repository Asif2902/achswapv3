import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, ExternalLink, Info, ChevronDown, ChevronUp, Droplets, TrendingUp } from "lucide-react";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useBalance, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, formatUnits, parseUnits } from "ethers";
import { defaultTokens, getTokensByChainId } from "@/data/tokens";
import { formatAmount, parseAmount, calculateRatio } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";

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
  const [showPoolInfo, setShowPoolInfo] = useState(true);

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

  useEffect(() => {
    loadTokens();
  }, [chainId]);

  const openExplorer = (txHash: string) => {
    if (contracts) {
      window.open(`${contracts.explorer}${txHash}`, "_blank");
    }
  };

  useEffect(() => {
    const checkPairExists = async () => {
      if (!tokenA || !tokenB || !window.ethereum) {
        setPairExists(false);
        setReserveA(0n);
        setReserveB(0n);
        return;
      }

      setIsLoadingPair(true);
      try {
        if (!contracts) return;

        const provider = new BrowserProvider(window.ethereum);
        const factory = new Contract(contracts.v2.factory, FACTORY_ABI, provider);

        const wrappedToken = tokens.find(t => t.symbol === 'wUSDC');
        const wrappedAddress = wrappedToken?.address;

        if (!wrappedAddress) {
          console.error('wUSDC token not found');
          setPairExists(false);
          setReserveA(0n);
          setReserveB(0n);
          setIsLoadingPair(false);
          return;
        }

        const isTokenANative = tokenA.address === "0x0000000000000000000000000000000000000000";
        const isTokenBNative = tokenB.address === "0x0000000000000000000000000000000000000000";
        const tokenAAddress = isTokenANative ? wrappedAddress : tokenA.address;
        const tokenBAddress = isTokenBNative ? wrappedAddress : tokenB.address;

        const pairAddress = await factory.getPair(tokenAAddress, tokenBAddress);

        if (pairAddress === "0x0000000000000000000000000000000000000000") {
          setPairExists(false);
          setReserveA(0n);
          setReserveB(0n);
        } else {
          setPairExists(true);

          const pairContract = new Contract(pairAddress, PAIR_ABI, provider);
          const [reserve0, reserve1] = await pairContract.getReserves();
          const token0Address = await pairContract.token0();

          if (tokenAAddress.toLowerCase() === token0Address.toLowerCase()) {
            setReserveA(reserve0);
            setReserveB(reserve1);
          } else {
            setReserveA(reserve1);
            setReserveB(reserve0);
          }
        }
      } catch (error) {
        console.error('Failed to check pair:', error);
        setPairExists(false);
        setReserveA(0n);
        setReserveB(0n);
      } finally {
        setIsLoadingPair(false);
      }
    };

    checkPairExists();
  }, [tokenA, tokenB, tokens, address]);

  useEffect(() => {
    if (!pairExists || !tokenA || !tokenB || !amountA || parseFloat(amountA) <= 0) return;
    if (reserveA === 0n || reserveB === 0n) return;

    try {
      const amountABigInt = parseAmount(amountA, tokenA.decimals);
      const amountBBigInt = (amountABigInt * reserveB) / reserveA;
      const calculatedAmountB = formatAmount(amountBBigInt, tokenB.decimals);
      setAmountB(calculatedAmountB);
    } catch (error) {
      console.error('Failed to calculate amount B:', error);
    }
  }, [amountA, pairExists, tokenA, tokenB, reserveA, reserveB]);

  const loadTokens = async () => {
    try {
      if (!chainId) return;
      const chainTokens = getTokensByChainId(chainId);
      const imported = localStorage.getItem('importedTokens');
      const importedTokens = imported ? JSON.parse(imported) : [];
      const chainImportedTokens = importedTokens.filter((t: Token) => t.chainId === chainId);

      const processedDefaultTokens = chainTokens.map(token => ({
        ...token,
        logoURI: token.logoURI || `/img/logos/unknown-token.png`
      }));
      const processedImportedTokens = chainImportedTokens.map((token: Token) => ({
        ...token,
        logoURI: token.logoURI || `/img/logos/unknown-token.png`
      }));

      setTokens([...processedDefaultTokens, ...processedImportedTokens]);
    } catch (error) {
      console.error('Failed to load tokens:', error);
    }
  };

  const handleImportToken = async (address: string): Promise<Token | null> => {
    try {
      if (!address || address.length !== 42 || !address.startsWith('0x')) {
        throw new Error("Invalid token address format");
      }

      const exists = tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
      if (exists) {
        toast({ title: "Token already added", description: `${exists.symbol} is already in your token list` });
        return exists;
      }

      const rpcUrl = chainId === 2201
        ? 'https://rpc.testnet.stable.xyz/'
        : 'https://rpc.testnet.arc.network';
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error.message);
          return data.result;
        },
      });
      const contract = new Contract(address, ERC20_ABI, provider);

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 10000)
      );

      const [name, symbol, decimals] = await Promise.race([
        Promise.all([contract.name(), contract.symbol(), contract.decimals()]),
        timeout
      ]) as [string, string, bigint];

      if (!chainId) throw new Error("Chain ID not available");

      const newToken: Token = {
        address, name, symbol,
        decimals: Number(decimals),
        logoURI: "/img/logos/unknown-token.png",
        verified: false,
        chainId,
      };

      const imported = localStorage.getItem('importedTokens');
      const importedTokens = imported ? JSON.parse(imported) : [];
      const alreadyImported = importedTokens.find((t: Token) => t.address.toLowerCase() === address.toLowerCase());
      if (!alreadyImported) {
        importedTokens.push(newToken);
        localStorage.setItem('importedTokens', JSON.stringify(importedTokens));
      }

      setTokens(prev => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} has been added to your token list` });
      return newToken;
    } catch (error: any) {
      console.error('Token import error:', error);
      let errorMessage = "Unable to fetch token data. Please verify the address is correct.";
      if (error.message.includes("timeout")) errorMessage = "Request timed out. Please check the address and try again.";
      else if (error.message.includes("Invalid") || error.message.includes("wallet") || error.message.includes("already")) errorMessage = error.message;

      toast({ title: "Import failed", description: errorMessage, variant: "destructive" });
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

      let amountAMin: bigint;
      let amountBMin: bigint;

      if (!pairExists || reserveA === 0n || reserveB === 0n) {
        amountAMin = 0n;
        amountBMin = 0n;
      } else {
        amountAMin = amountADesired * 95n / 100n;
        amountBMin = amountBDesired * 95n / 100n;
      }

      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const wrappedSymbol = chainId === 2201 ? 'wUSDT' : 'wUSDC';
      const wrappedToken = tokens.find(t => t.symbol === wrappedSymbol);
      const wrappedAddress = wrappedToken?.address;
      if (!wrappedAddress) throw new Error(`${wrappedSymbol} token not found`);

      toast({
        title: "Adding liquidity",
        description: `Adding ${amountA} ${tokenA.symbol} and ${amountB} ${tokenB.symbol}`,
      });

      const tokenAAddress = isTokenANative ? wrappedAddress : tokenA.address;
      const tokenBAddress = isTokenBNative ? wrappedAddress : tokenB.address;

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
          const approveGasEstimate = await tokenContract.approve.estimateGas(contracts.v2.router, tokenAmount);
          const approveGasLimit = (approveGasEstimate * 150n) / 100n;
          const approveTx = await tokenContract.approve(contracts.v2.router, tokenAmount, { gasLimit: approveGasLimit });
          const approveReceipt = await approveTx.wait();
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);

          toast({
            title: "Approval successful",
            description: (
              <div className="flex items-center gap-2">
                <span>Token approval confirmed</span>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(approveReceipt.hash)}>
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            ),
          });
        }

        const gasEstimate = await router.addLiquidityETH.estimateGas(tokenAddress, tokenAmount, tokenAmountMin, ethAmountMin, address, deadline, { value: ethAmount });
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.addLiquidityETH(tokenAddress, tokenAmount, tokenAmountMin, ethAmountMin, address, deadline, { value: ethAmount, gasLimit });
      } else {
        const tokenAContract = new Contract(tokenAAddress, ERC20_ABI, signer);
        const tokenBContract = new Contract(tokenBAddress, ERC20_ABI, signer);

        const allowanceA = await tokenAContract.allowance(address, contracts.v2.router);
        const allowanceB = await tokenBContract.allowance(address, contracts.v2.router);

        if (allowanceA < amountADesired) {
          const approveGasEstimate = await tokenAContract.approve.estimateGas(contracts.v2.router, amountADesired);
          const approveGasLimit = (approveGasEstimate * 150n) / 100n;
          const approveTx = await tokenAContract.approve(contracts.v2.router, amountADesired, { gasLimit: approveGasLimit });
          const approveReceipt = await approveTx.wait();
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);

          toast({
            title: "Approval successful",
            description: (
              <div className="flex items-center gap-2">
                <span>Token A approval confirmed</span>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(approveReceipt.hash)}>
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            ),
          });
        }

        if (allowanceB < amountBDesired) {
          const approveGasEstimate = await tokenBContract.approve.estimateGas(contracts.v2.router, amountBDesired);
          const approveGasLimit = (approveGasEstimate * 150n) / 100n;
          const approveTx = await tokenBContract.approve(contracts.v2.router, amountBDesired, { gasLimit: approveGasLimit });
          const approveReceipt = await approveTx.wait();
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);

          toast({
            title: "Approval successful",
            description: (
              <div className="flex items-center gap-2">
                <span>Token B approval confirmed</span>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(approveReceipt.hash)}>
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            ),
          });
        }

        const gasEstimate = await router.addLiquidity.estimateGas(tokenAAddress, tokenBAddress, amountADesired, amountBDesired, amountAMin, amountBMin, address, deadline);
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.addLiquidity(tokenAAddress, tokenBAddress, amountADesired, amountBDesired, amountAMin, amountBMin, address, deadline, { gasLimit });
      }

      await tx.wait();
      setAmountA("");
      setAmountB("");
      await new Promise(resolve => setTimeout(resolve, 1500));
      await Promise.all([refetchBalanceA(), refetchBalanceB()]);

      toast({
        title: "Liquidity added!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully added liquidity to {tokenA.symbol}/{tokenB.symbol} pool</span>
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(tx.hash)}>
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error('Add liquidity error:', error);
      toast({
        title: "Failed to add liquidity",
        description: error.reason || error.message || "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsAdding(false);
    }
  };

  // Pool status derived values
  const poolHasLiquidity = pairExists && reserveA > 0n && reserveB > 0n;
  const poolIsEmpty = pairExists && (reserveA === 0n || reserveB === 0n);
  const isNewPool = !pairExists;
  const isRatioLocked = poolHasLiquidity;

  const poolStatusConfig = isLoadingPair
    ? { label: "Checking…", color: "text-slate-400", bg: "bg-slate-500/10 border-slate-500/20", dot: "bg-slate-400" }
    : poolHasLiquidity
    ? { label: "Active Pool", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", dot: "bg-emerald-400" }
    : poolIsEmpty
    ? { label: "Empty Pool", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", dot: "bg-amber-400" }
    : { label: "New Pool", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", dot: "bg-blue-400" };

  const canSubmit = tokenA && tokenB && amountA && amountB && parseFloat(amountA) > 0 && parseFloat(amountB) > 0 && !isAdding;

  return (
    <div className="w-full space-y-3">
      {/* Token A Input */}
      <div className="rounded-2xl bg-slate-800/60 border border-slate-700/50 p-4 space-y-3 transition-all hover:border-slate-600/60">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Token A</span>
          {isConnected && tokenA && (
            <span className="text-xs text-slate-400">
              Balance: <span className="text-slate-300 font-medium">{balanceAFormatted}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Input
            data-testid="input-token-a-amount"
            type="number"
            placeholder="0.00"
            value={amountA}
            onChange={(e) => setAmountA(e.target.value)}
            className="border-0 bg-transparent text-2xl sm:text-3xl font-bold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0 text-white placeholder:text-slate-600 flex-1 min-w-0"
          />

          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <Button
              data-testid="button-select-token-a"
              onClick={() => setShowTokenASelector(true)}
              variant="secondary"
              className="h-10 px-3 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-xl gap-2 min-w-[110px] justify-between"
            >
              {tokenA ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <img
                      src={tokenA.logoURI}
                      alt={tokenA.symbol}
                      className="w-5 h-5 rounded-full flex-shrink-0"
                      onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                    />
                    <span className="font-semibold text-sm text-white">{tokenA.symbol}</span>
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

            {isConnected && tokenA && balanceA && (
              <button
                data-testid="button-max-token-a"
                onClick={() => setAmountA(balanceAFormatted)}
                className="text-[10px] font-bold text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 px-2 py-0.5 rounded-md transition-colors"
              >
                MAX
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Plus Divider */}
      <div className="flex items-center justify-center">
        <div className="flex items-center gap-3 w-full">
          <div className="flex-1 h-px bg-slate-700/60" />
          <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 shadow-md">
            <Plus className="h-4 w-4 text-slate-400" />
          </div>
          <div className="flex-1 h-px bg-slate-700/60" />
        </div>
      </div>

      {/* Token B Input */}
      <div className={`rounded-2xl bg-slate-800/60 border p-4 space-y-3 transition-all ${
        isRatioLocked
          ? "border-blue-500/30 bg-slate-800/40"
          : "border-slate-700/50 hover:border-slate-600/60"
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Token B</span>
            {isRatioLocked && (
              <span className="text-[10px] font-semibold text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded-full">
                Auto
              </span>
            )}
          </div>
          {isConnected && tokenB && (
            <span className="text-xs text-slate-400">
              Balance: <span className="text-slate-300 font-medium">{balanceBFormatted}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Input
            data-testid="input-token-b-amount"
            type="number"
            placeholder={isRatioLocked ? "Calculated automatically" : "0.00"}
            value={amountB}
            onChange={(e) => (!isRatioLocked ? setAmountB(e.target.value) : null)}
            disabled={isRatioLocked}
            className={`border-0 bg-transparent text-2xl sm:text-3xl font-bold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0 flex-1 min-w-0 ${
              isRatioLocked
                ? "text-slate-400 cursor-not-allowed placeholder:text-slate-600"
                : "text-white placeholder:text-slate-600"
            }`}
          />

          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <Button
              data-testid="button-select-token-b"
              onClick={() => setShowTokenBSelector(true)}
              variant="secondary"
              className="h-10 px-3 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-xl gap-2 min-w-[110px] justify-between"
            >
              {tokenB ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <img
                      src={tokenB.logoURI}
                      alt={tokenB.symbol}
                      className="w-5 h-5 rounded-full flex-shrink-0"
                      onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                    />
                    <span className="font-semibold text-sm text-white">{tokenB.symbol}</span>
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

            {isConnected && tokenB && balanceB && !isRatioLocked && (
              <button
                data-testid="button-max-token-b"
                onClick={() => setAmountB(balanceBFormatted)}
                className="text-[10px] font-bold text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 px-2 py-0.5 rounded-md transition-colors"
              >
                MAX
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Pool Info Panel - only shown when both tokens selected */}
      {tokenA && tokenB && (
        <div className={`rounded-2xl border overflow-hidden transition-all ${poolStatusConfig.bg}`}>
          {/* Header - always visible, acts as toggle */}
          <button
            className="w-full flex items-center justify-between px-4 py-3"
            onClick={() => setShowPoolInfo(p => !p)}
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${poolStatusConfig.dot} ${
                isLoadingPair ? "animate-pulse" : poolHasLiquidity ? "animate-pulse" : ""
              }`} />
              <span className={`text-sm font-semibold ${poolStatusConfig.color}`}>
                {poolStatusConfig.label}
              </span>
              {poolHasLiquidity && (
                <span className="hidden sm:inline text-xs text-slate-500">· Ratio locked to pool</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsLoadingPair(true);
                  setTimeout(() => setTokenA(tokenA), 100);
                }}
                disabled={isLoadingPair}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-2 py-0.5 rounded hover:bg-slate-700/50"
                data-testid="button-refresh-pool"
              >
                {isLoadingPair ? "…" : "Refresh"}
              </button>
              {showPoolInfo
                ? <ChevronUp className="h-4 w-4 text-slate-500" />
                : <ChevronDown className="h-4 w-4 text-slate-500" />
              }
            </div>
          </button>

          {/* Collapsible content */}
          {showPoolInfo && (
            <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3">
              {poolHasLiquidity && (
                <>
                  {/* Current ratio */}
                  <div className="flex items-start gap-3">
                    <TrendingUp className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-500 mb-0.5">Current pool ratio</p>
                      <p className="text-sm font-semibold text-white break-words">
                        1 {tokenA.symbol} = {calculateRatio(reserveB, tokenB.decimals, reserveA, tokenA.decimals)} {tokenB.symbol}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Info className="h-4 w-4 text-slate-500 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Token B amount is calculated automatically to match the pool ratio.
                    </p>
                  </div>
                </>
              )}

              {(isNewPool || poolIsEmpty) && (
                <>
                  <div className="flex items-start gap-3">
                    <Droplets className="h-4 w-4 text-blue-400 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-500 mb-0.5">
                        {poolIsEmpty ? "Pool is empty — set the opening ratio" : "You are creating a new pool"}
                      </p>
                      {amountA && amountB && parseFloat(amountA) > 0 && parseFloat(amountB) > 0 ? (
                        <p className="text-sm font-semibold text-white break-words">
                          1 {tokenA.symbol} = {(parseFloat(amountB) / parseFloat(amountA)).toFixed(6)} {tokenB.symbol}
                        </p>
                      ) : (
                        <p className="text-sm text-slate-500">Enter amounts above to preview ratio</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Info className="h-4 w-4 text-slate-500 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-slate-500 leading-relaxed">
                      The ratio you set becomes the initial price for this pool. Choose carefully.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* CTA */}
      {isConnected ? (
        <Button
          data-testid="button-add-liquidity"
          onClick={handleAddLiquidity}
          disabled={!canSubmit}
          className="w-full h-13 text-base font-bold rounded-2xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20 transition-all duration-200 hover:shadow-blue-500/30 hover:scale-[1.01] active:scale-[0.99]"
          style={{ height: "52px" }}
        >
          {isAdding ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              Adding Liquidity…
            </span>
          ) : !tokenA || !tokenB ? (
            "Select Tokens"
          ) : !amountA || !amountB || parseFloat(amountA) <= 0 || parseFloat(amountB) <= 0 ? (
            "Enter Amounts"
          ) : (
            "Add Liquidity"
          )}
        </Button>
      ) : (
        <Button
          data-testid="button-connect-wallet"
          disabled
          className="w-full h-13 text-base font-bold rounded-2xl bg-slate-700 text-slate-500 cursor-not-allowed"
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
