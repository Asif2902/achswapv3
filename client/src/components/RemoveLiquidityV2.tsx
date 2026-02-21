import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ArrowDown, Minus, Wallet } from "lucide-react";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, formatUnits, parseUnits } from "ethers";
import { defaultTokens, getTokensByChainId } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getErrorForToast } from "@/lib/error-utils";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
];

export function RemoveLiquidityV2() {
  const [percentage, setPercentage] = useState([25]);
  const [isRemoving, setIsRemoving] = useState(false);
  const [tokenA, setTokenA] = useState<Token | null>(null);
  const [tokenB, setTokenB] = useState<Token | null>(null);
  const [showTokenASelector, setShowTokenASelector] = useState(false);
  const [showTokenBSelector, setShowTokenBSelector] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [pairAddress, setPairAddress] = useState<string | null>(null);
  const [lpBalance, setLpBalance] = useState<string>("0");
  const [lpBalanceRaw, setLpBalanceRaw] = useState<bigint>(0n);
  const [amountAToReceive, setAmountAToReceive] = useState<string>("0");
  const [amountBToReceive, setAmountBToReceive] = useState<string>("0");

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;

  useEffect(() => { loadTokens(); }, [chainId]);
  useEffect(() => {
    if (tokenA && tokenB && address && tokens.length > 0) fetchPairInfo();
  }, [tokenA, tokenB, address, tokens]);

  useEffect(() => {
    const calculateAmountsToReceive = async () => {
      if (!pairAddress || !tokenA || !tokenB || parseFloat(lpBalance) <= 0) {
        setAmountAToReceive("0"); setAmountBToReceive("0"); return;
      }
      try {
        if (!window.ethereum) return;
        const provider = new BrowserProvider(window.ethereum);
        const pairContract = new Contract(pairAddress, PAIR_ABI, provider);
        const [reserve0, reserve1] = await pairContract.getReserves();
        const totalSupply = await pairContract.totalSupply();
        const token0Address = await pairContract.token0();
        const liquidityToRemove = lpBalanceRaw * BigInt(percentage[0]) / 100n;
        const amount0 = liquidityToRemove * reserve0 / totalSupply;
        const amount1 = liquidityToRemove * reserve1 / totalSupply;
        const wrappedSymbol = chainId === 2201 ? 'wUSDT' : 'wUSDC';
        const wrappedToken = tokens.find(t => t.symbol === wrappedSymbol);
        const wrappedAddress = wrappedToken?.address || '';
        const tokenAAddress = tokenA.address === "0x0000000000000000000000000000000000000000" ? wrappedAddress : tokenA.address;
        const tokenBAddress = tokenB.address === "0x0000000000000000000000000000000000000000" ? wrappedAddress : tokenB.address;
        const isTokenAToken0 = tokenAAddress.toLowerCase() === token0Address.toLowerCase();
        if (isTokenAToken0) {
          setAmountAToReceive(formatAmount(amount0, tokenA.decimals));
          setAmountBToReceive(formatAmount(amount1, tokenB.decimals));
        } else {
          setAmountAToReceive(formatAmount(amount1, tokenA.decimals));
          setAmountBToReceive(formatAmount(amount0, tokenB.decimals));
        }
      } catch (error) {
        console.error('Failed to calculate amounts:', error);
        setAmountAToReceive("0"); setAmountBToReceive("0");
      }
    };
    calculateAmountsToReceive();
  }, [pairAddress, tokenA, tokenB, lpBalanceRaw, percentage, tokens]);

  const loadTokens = async () => {
    try {
      if (!chainId) return;
      const chainTokens = getTokensByChainId(chainId);
      const imported = localStorage.getItem('importedTokens');
      const importedTokens = imported ? JSON.parse(imported) : [];
      const chainImportedTokens = importedTokens.filter((t: Token) => t.chainId === chainId);
      const processedDefaultTokens = chainTokens.map(token => ({ ...token, logoURI: token.logoURI || `/img/logos/unknown-token.png` }));
      const processedImportedTokens = chainImportedTokens.map((token: Token) => ({ ...token, logoURI: token.logoURI || `/img/logos/unknown-token.png` }));
      setTokens([...processedDefaultTokens, ...processedImportedTokens]);
    } catch (error) { console.error('Failed to load tokens:', error); }
  };

  const handleImportToken = async (address: string): Promise<Token | null> => {
    try {
      if (!address || address.length !== 42 || !address.startsWith('0x')) throw new Error("Invalid token address format");
      if (!window.ethereum) throw new Error("Please connect your wallet to import tokens");
      const provider = new BrowserProvider(window.ethereum);
      const contract = new Contract(address, ERC20_ABI, provider);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), 10000));
      const [name, symbol, decimals] = await Promise.race([Promise.all([contract.name(), contract.symbol(), contract.decimals()]), timeout]) as [string, string, bigint];
      if (!chainId) throw new Error("Chain ID not available");
      const newToken: Token = { address, name, symbol, decimals: Number(decimals), logoURI: "/img/logos/unknown-token.png", verified: false, chainId };
      const exists = tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
      if (exists) throw new Error("Token already in list");
      const imported = localStorage.getItem('importedTokens');
      const importedTokens = imported ? JSON.parse(imported) : [];
      const alreadyImported = importedTokens.find((t: Token) => t.address.toLowerCase() === address.toLowerCase());
      if (!alreadyImported) { importedTokens.push(newToken); localStorage.setItem('importedTokens', JSON.stringify(importedTokens)); }
      setTokens(prev => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} has been added to your token list` });
      return newToken;
    } catch (error: any) {
      console.error('Token import error:', error);
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
      return null;
    }
  };

  const fetchPairInfo = async () => {
    try {
      if (!window.ethereum || !tokenA || !tokenB) return;
      const provider = new BrowserProvider(window.ethereum);
      if (!contracts) return;
      const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];
      const factory = new Contract(contracts.v2.factory, FACTORY_ABI, provider);
      const wrappedSymbol = chainId === 2201 ? 'wUSDT' : 'wUSDC';
      const wrappedToken = tokens.find(t => t.symbol === wrappedSymbol);
      const wusdcAddress = wrappedToken?.address;
      if (!wusdcAddress) { setPairAddress(null); setLpBalance("0"); return; }
      const isTokenANative = tokenA.address === "0x0000000000000000000000000000000000000000";
      const isTokenBNative = tokenB.address === "0x0000000000000000000000000000000000000000";
      const tokenAAddress = isTokenANative ? wusdcAddress : tokenA.address;
      const tokenBAddress = isTokenBNative ? wusdcAddress : tokenB.address;
      const pair = await factory.getPair(tokenAAddress, tokenBAddress);
      if (pair === "0x0000000000000000000000000000000000000000") {
        setPairAddress(null); setLpBalance("0");
        toast({ title: "Pool not found", description: "No liquidity pool exists for this token pair", variant: "destructive" });
        return;
      }
      setPairAddress(pair);
      const pairContract = new Contract(pair, ERC20_ABI, provider);
      const balance = await pairContract.balanceOf(address);
      setLpBalanceRaw(balance);
      setLpBalance(formatAmount(balance, 18));
    } catch (error) {
      console.error('Failed to fetch pair info:', error);
      toast({ title: "Error", description: "Failed to fetch pool information", variant: "destructive" });
    }
  };

  const handleRemoveLiquidity = async () => {
    if (!tokenA || !tokenB || !pairAddress || parseFloat(lpBalance) <= 0) return;
    setIsRemoving(true);
    try {
      if (!address || !window.ethereum) throw new Error("Please connect your wallet");
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      if (!contracts) throw new Error("Chain contracts not configured");
      const ROUTER_ABI = [
        "function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB)",
        "function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external returns (uint amountToken, uint amountETH)"
      ];
      const router = new Contract(contracts.v2.router, ROUTER_ABI, signer);
      const pairContract = new Contract(pairAddress, ERC20_ABI, signer);
      const liquidityToRemove = lpBalanceRaw * BigInt(percentage[0]) / 100n;
      const allowance = await pairContract.allowance(address, contracts.v2.router);
      if (allowance < liquidityToRemove) {
        const approveGasEstimate = await pairContract.approve.estimateGas(contracts.v2.router, liquidityToRemove);
        const approveGasLimit = (approveGasEstimate * 150n) / 100n;
        const approveTx = await pairContract.approve(contracts.v2.router, liquidityToRemove, { gasLimit: approveGasLimit });
        await approveTx.wait();
      }
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const amountAMin = 0n; const amountBMin = 0n;
      toast({ title: "Removing liquidity", description: `Removing ${percentage[0]}% of your liquidity` });
      const isTokenANative = tokenA.address === "0x0000000000000000000000000000000000000000";
      const isTokenBNative = tokenB.address === "0x0000000000000000000000000000000000000000";
      const wrappedSymbol = chainId === 2201 ? 'wUSDT' : 'wUSDC';
      const wrappedToken = tokens.find(t => t.symbol === wrappedSymbol);
      const wrappedAddress = wrappedToken?.address;
      if (!wrappedAddress) throw new Error(`${wrappedSymbol} token not found`);
      const tokenAAddress = isTokenANative ? wrappedAddress : tokenA.address;
      const tokenBAddress = isTokenBNative ? wrappedAddress : tokenB.address;
      let tx;
      if (isTokenANative || isTokenBNative) {
        const token = isTokenANative ? tokenBAddress : tokenAAddress;
        const gasEstimate = await router.removeLiquidityETH.estimateGas(token, liquidityToRemove, amountAMin, amountBMin, address, deadline);
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.removeLiquidityETH(token, liquidityToRemove, amountAMin, amountBMin, address, deadline, { gasLimit });
      } else {
        const gasEstimate = await router.removeLiquidity.estimateGas(tokenAAddress, tokenBAddress, liquidityToRemove, amountAMin, amountBMin, address, deadline);
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.removeLiquidity(tokenAAddress, tokenBAddress, liquidityToRemove, amountAMin, amountBMin, address, deadline, { gasLimit });
      }
      await tx.wait();
      toast({ title: "Liquidity removed!", description: `Successfully removed ${percentage[0]}% of your liquidity` });
      setPercentage([25]);
      await new Promise(resolve => setTimeout(resolve, 1000));
      fetchPairInfo();
    } catch (error: any) {
      console.error('Remove liquidity error:', error);
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
    } finally {
      setIsRemoving(false);
    }
  };

  const hasPosition = pairAddress && parseFloat(lpBalance) > 0;

  return (
    <div className="w-full max-w-md mx-auto px-3 py-4 sm:px-4 sm:py-8">
      <Card className="border-border/40 shadow-xl backdrop-blur-sm bg-card/95 overflow-hidden">

        {/* ── Header ── */}
        <CardHeader className="px-4 pt-5 pb-4 sm:px-6 sm:pt-6">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-red-500/15 flex-shrink-0">
              <Minus className="w-4 h-4 text-red-400" />
            </div>
            <div>
              <CardTitle className="text-lg sm:text-xl font-bold leading-tight">
                Remove Liquidity
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Withdraw tokens from a V2 pool
              </p>
            </div>
          </div>
        </CardHeader>

        <CardContent className="px-4 pb-5 sm:px-6 sm:pb-6 space-y-4">

          {/* ── Token Pair Selection ── */}
          <div className="grid grid-cols-2 gap-2">
            <button
              data-testid="button-select-token-a"
              onClick={() => setShowTokenASelector(true)}
              className={`flex items-center gap-2 px-3 py-3 rounded-xl border transition-all text-left min-h-[52px] ${
                tokenA
                  ? "border-border/60 bg-muted/40 hover:bg-muted/60"
                  : "border-dashed border-border/50 bg-muted/20 hover:bg-muted/40 hover:border-primary/40"
              }`}
            >
              {tokenA ? (
                <>
                  <img
                    src={tokenA.logoURI}
                    alt={tokenA.symbol}
                    className="w-7 h-7 rounded-full flex-shrink-0"
                    onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                  />
                  <div className="min-w-0">
                    <p className="font-semibold text-sm leading-tight truncate">{tokenA.symbol}</p>
                    <p className="text-[10px] text-muted-foreground leading-tight">Token A</p>
                  </div>
                </>
              ) : (
                <div className="min-w-0">
                  <p className="text-sm font-medium text-muted-foreground">Select</p>
                  <p className="text-[10px] text-muted-foreground">Token A</p>
                </div>
              )}
            </button>

            <button
              data-testid="button-select-token-b"
              onClick={() => setShowTokenBSelector(true)}
              className={`flex items-center gap-2 px-3 py-3 rounded-xl border transition-all text-left min-h-[52px] ${
                tokenB
                  ? "border-border/60 bg-muted/40 hover:bg-muted/60"
                  : "border-dashed border-border/50 bg-muted/20 hover:bg-muted/40 hover:border-primary/40"
              }`}
            >
              {tokenB ? (
                <>
                  <img
                    src={tokenB.logoURI}
                    alt={tokenB.symbol}
                    className="w-7 h-7 rounded-full flex-shrink-0"
                    onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                  />
                  <div className="min-w-0">
                    <p className="font-semibold text-sm leading-tight truncate">{tokenB.symbol}</p>
                    <p className="text-[10px] text-muted-foreground leading-tight">Token B</p>
                  </div>
                </>
              ) : (
                <div className="min-w-0">
                  <p className="text-sm font-medium text-muted-foreground">Select</p>
                  <p className="text-[10px] text-muted-foreground">Token B</p>
                </div>
              )}
            </button>
          </div>

          {/* ── Pool Position Info ── */}
          {tokenA && tokenB && pairAddress && (
            <>
              {/* LP Balance pill */}
              <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-muted/40 border border-border/40">
                <span className="text-xs text-muted-foreground">Your LP tokens</span>
                <span className="text-sm font-semibold tabular-nums">
                  {parseFloat(lpBalance).toFixed(6)}
                </span>
              </div>

              {/* ── Percentage Selector ── */}
              <div className="rounded-xl border border-border/40 bg-muted/20 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">Remove amount</span>
                  <span className="text-2xl font-bold text-primary tabular-nums">
                    {percentage[0]}%
                  </span>
                </div>

                <Slider
                  data-testid="slider-remove-percentage"
                  value={percentage}
                  onValueChange={setPercentage}
                  max={100}
                  step={1}
                  className="py-1"
                />

                {/* Quick % buttons */}
                <div className="grid grid-cols-4 gap-1.5">
                  {[25, 50, 75, 100].map((value) => (
                    <button
                      key={value}
                      data-testid={`button-percentage-${value}`}
                      onClick={() => setPercentage([value])}
                      className={`py-2 rounded-lg text-xs font-semibold transition-all ${
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

              {/* ── Arrow divider ── */}
              <div className="flex justify-center">
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted/60 border border-border/40">
                  <ArrowDown className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>

              {/* ── You Will Receive ── */}
              <div className="rounded-xl border border-border/40 bg-muted/20 overflow-hidden">
                <p className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  You will receive
                </p>
                <div className="divide-y divide-border/30">
                  {[
                    { token: tokenA, amount: amountAToReceive },
                    { token: tokenB, amount: amountBToReceive },
                  ].map(({ token, amount }) => (
                    <div key={token.symbol} className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <img
                          src={token.logoURI}
                          alt={token.symbol}
                          className="w-7 h-7 rounded-full"
                          onError={(e) => { e.currentTarget.src = "/img/logos/unknown-token.png"; }}
                        />
                        <span className="font-semibold text-sm">{token.symbol}</span>
                      </div>
                      <span className="font-semibold text-sm tabular-nums">
                        {parseFloat(amount).toFixed(6)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── Empty state when no pair ── */}
          {tokenA && tokenB && !pairAddress && (
            <div className="text-center py-4 text-sm text-muted-foreground">
              No liquidity pool found for this pair
            </div>
          )}

          {/* ── Action Button ── */}
          {isConnected ? (
            <Button
              data-testid="button-remove-liquidity"
              onClick={handleRemoveLiquidity}
              disabled={!tokenA || !tokenB || !pairAddress || parseFloat(lpBalance) <= 0 || isRemoving}
              className="w-full h-12 text-base font-semibold bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-500/90 hover:to-rose-600/90 shadow-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all text-white"
            >
              {isRemoving ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Removing…
                </span>
              ) : (
                "Remove Liquidity"
              )}
            </Button>
          ) : (
            <Button
              data-testid="button-connect-wallet"
              disabled
              variant="outline"
              className="w-full h-12 text-base font-semibold gap-2"
            >
              <Wallet className="w-4 h-4" />
              Connect Wallet
            </Button>
          )}

          <p className="text-center text-xs text-muted-foreground leading-relaxed">
            Removing liquidity returns your tokens and any earned fees
          </p>
        </CardContent>
      </Card>

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
