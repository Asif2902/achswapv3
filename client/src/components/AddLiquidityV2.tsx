import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, ExternalLink } from "lucide-react";
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

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  // Get chain-specific contracts
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

  // Check if pair exists and fetch reserves
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

        // Get wrapped token for ARC Testnet
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

        // Convert native token to wrapped for pool lookup
        const isTokenANative = tokenA.address === "0x0000000000000000000000000000000000000000";
        const isTokenBNative = tokenB.address === "0x0000000000000000000000000000000000000000";
        const tokenAAddress = isTokenANative ? wrappedAddress : tokenA.address;
        const tokenBAddress = isTokenBNative ? wrappedAddress : tokenB.address;

        console.log('Checking pair:', { tokenAAddress, tokenBAddress, isTokenANative, isTokenBNative, factoryAddress: contracts.v2.factory });

        const pairAddress = await factory.getPair(tokenAAddress, tokenBAddress);
        console.log('Pair lookup result:', pairAddress);

        if (pairAddress === "0x0000000000000000000000000000000000000000") {
          console.log('No existing pair found');
          setPairExists(false);
          setReserveA(0n);
          setReserveB(0n);
        } else {
          console.log('Pair found at:', pairAddress);
          setPairExists(true);

          // Fetch reserves
          const pairContract = new Contract(pairAddress, PAIR_ABI, provider);
          const [reserve0, reserve1] = await pairContract.getReserves();
          const token0Address = await pairContract.token0();

          console.log('Reserves:', { reserve0: reserve0.toString(), reserve1: reserve1.toString(), token0: token0Address });

          // Determine which reserve corresponds to which token (using pool addresses)
          if (tokenAAddress.toLowerCase() === token0Address.toLowerCase()) {
            setReserveA(reserve0);
            setReserveB(reserve1);
            console.log('Reserve mapping: reserveA=reserve0, reserveB=reserve1');
          } else {
            setReserveA(reserve1);
            setReserveB(reserve0);
            console.log('Reserve mapping: reserveA=reserve1, reserveB=reserve0');
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

  // Auto-calculate amountB based on pool ratio when amountA changes
  useEffect(() => {
    // Only auto-calculate if pool exists AND has reserves
    if (!pairExists || !tokenA || !tokenB || !amountA || parseFloat(amountA) <= 0) {
      return;
    }

    // If pool exists but has no reserves (all liquidity removed), don't auto-calculate
    if (reserveA === 0n || reserveB === 0n) {
      return;
    }

    try {
      const amountABigInt = parseAmount(amountA, tokenA.decimals);
      
      // Calculate amountB = amountA * reserveB / reserveA
      // This works for any decimal combination because:
      // - amountABigInt is in tokenA's decimals
      // - reserveA is in tokenA's decimals
      // - reserveB is in tokenB's decimals
      // - Result will be in tokenB's decimals
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

      // Filter tokens by current chain ID
      const chainTokens = getTokensByChainId(chainId);

      const imported = localStorage.getItem('importedTokens');
      const importedTokens = imported ? JSON.parse(imported) : [];
      const chainImportedTokens = importedTokens.filter((t: Token) => t.chainId === chainId);

      // Process tokens to add fallback logos
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

      // Check if token already exists in default or imported tokens
      const exists = tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
      if (exists) {
        toast({
          title: "Token already added",
          description: `${exists.symbol} is already in your token list`,
        });
        return exists;
      }

      // Use public RPC for token data (no wallet needed) - chain-specific
      const rpcUrl = chainId === 2201 
        ? 'https://rpc.testnet.stable.xyz/' 
        : 'https://rpc.testnet.arc.network';
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method,
              params,
            }),
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
        Promise.all([
          contract.name(),
          contract.symbol(),
          contract.decimals(),
        ]),
        timeout
      ]) as [string, string, bigint];

      if (!chainId) throw new Error("Chain ID not available");

      const newToken: Token = {
        address,
        name,
        symbol,
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

      toast({
        title: "Token imported",
        description: `${symbol} has been added to your token list`,
      });

      return newToken;
    } catch (error: any) {
      console.error('Token import error:', error);
      let errorMessage = "Failed to import token";

      if (error.message.includes("timeout")) {
        errorMessage = "Request timed out. Please check the address and try again.";
      } else if (error.message.includes("Invalid")) {
        errorMessage = error.message;
      } else if (error.message.includes("wallet")) {
        errorMessage = error.message;
      } else if (error.message.includes("already")) {
        errorMessage = error.message;
      } else {
        errorMessage = "Unable to fetch token data. Please verify the address is correct.";
      }

      toast({
        title: "Import failed",
        description: errorMessage,
        variant: "destructive",
      });
      return null;
    }
  };

  // Fetch balances for selected tokens
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

  let balanceAFormatted = "0.00";
  let balanceBFormatted = "0.00";
  
  if (balanceA) {
    balanceAFormatted = formatAmount(balanceA.value, balanceA.decimals);
  }
  
  if (balanceB) {
    balanceBFormatted = formatAmount(balanceB.value, balanceB.decimals);
  }

  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !amountA || !amountB || parseFloat(amountA) <= 0 || parseFloat(amountB) <= 0) return;

    setIsAdding(true);
    try {
      if (!address || !window.ethereum) {
        throw new Error("Please connect your wallet");
      }

      // Validate balances before proceeding
      const amountADesired = parseAmount(amountA, tokenA.decimals);
      const amountBDesired = parseAmount(amountB, tokenB.decimals);

      if (balanceA && amountADesired > balanceA.value) {
        throw new Error(`Insufficient ${tokenA.symbol} balance`);
      }

      if (balanceB && amountBDesired > balanceB.value) {
        throw new Error(`Insufficient ${tokenB.symbol} balance`);
      }

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      if (!contracts) throw new Error("Chain contracts not configured");
      const router = new Contract(contracts.v2.router, ROUTER_ABI, signer);

      // For new pools, use 0 minimum amounts. For existing pools, use 5% slippage tolerance
      let amountAMin: bigint;
      let amountBMin: bigint;
      
      if (!pairExists || reserveA === 0n || reserveB === 0n) {
        // New pool - no slippage impact, use 0 minimums
        amountAMin = 0n;
        amountBMin = 0n;
      } else {
        // Existing pool - apply 5% slippage tolerance
        amountAMin = amountADesired * 95n / 100n;
        amountBMin = amountBDesired * 95n / 100n;
      }

      // Deadline: 20 minutes from now
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      // Get wrapped token for native conversion (chain-specific)
      const wrappedSymbol = chainId === 2201 ? 'wUSDT' : 'wUSDC';
      const wrappedToken = tokens.find(t => t.symbol === wrappedSymbol);
      const wrappedAddress = wrappedToken?.address;
      
      if (!wrappedAddress) {
        throw new Error(`${wrappedSymbol} token not found`);
      }

      console.log('Adding liquidity:', {
        tokenA: tokenA.symbol,
        tokenB: tokenB.symbol,
        amountADesired: amountADesired.toString(),
        amountBDesired: amountBDesired.toString(),
        amountAMin: amountAMin.toString(),
        amountBMin: amountBMin.toString(),
      });

      toast({
        title: "Adding liquidity",
        description: `Adding ${amountA} ${tokenA.symbol} and ${amountB} ${tokenB.symbol}`,
      });

      // Convert native token to wrapped for pool operations
      const tokenAAddress = isTokenANative ? wrappedAddress : tokenA.address;
      const tokenBAddress = isTokenBNative ? wrappedAddress : tokenB.address;

      let tx;

      if (isTokenANative || isTokenBNative) {
        // Add liquidity with native USDC (acts as ETH)
        const token = isTokenANative ? tokenB : tokenA;
        const tokenAddress = isTokenANative ? tokenBAddress : tokenAAddress;
        const tokenAmount = isTokenANative ? amountBDesired : amountADesired;
        const tokenAmountMin = isTokenANative ? amountBMin : amountAMin;
        const ethAmount = isTokenANative ? amountADesired : amountBDesired;
        const ethAmountMin = isTokenANative ? amountAMin : amountBMin;

        // Approve token (if not native)
        const tokenContract = new Contract(token.address, ERC20_ABI, signer);
        const allowance = await tokenContract.allowance(address, contracts.v2.router);

        if (allowance < tokenAmount) {
          const approveGasEstimate = await tokenContract.approve.estimateGas(contracts.v2.router, tokenAmount);
          const approveGasLimit = (approveGasEstimate * 150n) / 100n;
          const approveTx = await tokenContract.approve(contracts.v2.router, tokenAmount, { gasLimit: approveGasLimit });
          const approveReceipt = await approveTx.wait();

          // Refetch balances after approval
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);

          toast({
            title: "Approval successful",
            description: (
              <div className="flex items-center gap-2">
                <span>Token approval confirmed</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() => openExplorer(approveReceipt.hash)}
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            ),
          });
        }

        const gasEstimate = await router.addLiquidityETH.estimateGas(
          tokenAddress,
          tokenAmount,
          tokenAmountMin,
          ethAmountMin,
          address,
          deadline,
          { value: ethAmount }
        );
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.addLiquidityETH(
          tokenAddress,
          tokenAmount,
          tokenAmountMin,
          ethAmountMin,
          address,
          deadline,
          { value: ethAmount, gasLimit }
        );
      } else {
        // Add liquidity with two ERC20 tokens
        // Approve both tokens
        const tokenAContract = new Contract(tokenAAddress, ERC20_ABI, signer);
        const tokenBContract = new Contract(tokenBAddress, ERC20_ABI, signer);

        const allowanceA = await tokenAContract.allowance(address, contracts.v2.router);
        const allowanceB = await tokenBContract.allowance(address, contracts.v2.router);

        if (allowanceA < amountADesired) {
          const approveGasEstimate = await tokenAContract.approve.estimateGas(contracts.v2.router, amountADesired);
          const approveGasLimit = (approveGasEstimate * 150n) / 100n;
          const approveTx = await tokenAContract.approve(contracts.v2.router, amountADesired, { gasLimit: approveGasLimit });
          const approveReceipt = await approveTx.wait();

          // Refetch balances after approval
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);

          toast({
            title: "Approval successful",
            description: (
              <div className="flex items-center gap-2">
                <span>Token approval confirmed</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() => openExplorer(approveReceipt.hash)}
                >
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

          // Refetch balances after approval
          await Promise.all([refetchBalanceA(), refetchBalanceB()]);

          toast({
            title: "Approval successful",
            description: (
              <div className="flex items-center gap-2">
                <span>Token approval confirmed</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() => openExplorer(approveReceipt.hash)}
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            ),
          });
        }

        const gasEstimate = await router.addLiquidity.estimateGas(
          tokenAAddress,
          tokenBAddress,
          amountADesired,
          amountBDesired,
          amountAMin,
          amountBMin,
          address,
          deadline
        );
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.addLiquidity(
          tokenAAddress,
          tokenBAddress,
          amountADesired,
          amountBDesired,
          amountAMin,
          amountBMin,
          address,
          deadline,
          { gasLimit }
        );
      }

      await tx.wait();

      setAmountA("");
      setAmountB("");

      // Wait a moment for blockchain to update, then refetch balances
      await new Promise(resolve => setTimeout(resolve, 1500));
      await Promise.all([refetchBalanceA(), refetchBalanceB()]);

      toast({
        title: "Liquidity added!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully added liquidity to {tokenA.symbol}/{tokenB.symbol} pool</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={() => openExplorer(tx.hash)}
            >
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

  return (
    <div className="container max-w-md mx-auto px-4 py-4 md:py-8">
      <Card className="border-border/40 shadow-xl backdrop-blur-sm bg-card/95">
        <CardHeader className="space-y-1 pb-4 md:pb-6">
          <CardTitle className="text-xl md:text-2xl font-bold">Add Liquidity</CardTitle>
          <p className="text-xs md:text-sm text-muted-foreground">
            Add liquidity to earn fees on swaps
          </p>
        </CardHeader>

        <CardContent className="space-y-3 md:space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-muted-foreground">Token A</label>
              {isConnected && tokenA && (
                <span className="text-xs text-muted-foreground">
                  Balance: {balanceAFormatted}
                </span>
              )}
            </div>

            <div className="relative bg-muted/50 rounded-xl p-4 border border-border/40 hover:border-border/60 transition-colors">
              <Input
                data-testid="input-token-a-amount"
                type="number"
                placeholder="0.00"
                value={amountA}
                onChange={(e) => setAmountA(e.target.value)}
                className="border-0 bg-transparent text-xl md:text-2xl font-semibold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              />

              <div className="flex items-center justify-between mt-3">
                <Button
                  data-testid="button-select-token-a"
                  onClick={() => setShowTokenASelector(true)}
                  variant="secondary"
                  className="h-10 px-3 md:px-4 hover:bg-secondary/80"
                >
                  {tokenA ? (
                    <div className="flex items-center gap-2">
                      <img src={tokenA.logoURI} alt={tokenA.symbol} className="w-6 h-6 rounded-full" />
                      <span className="font-semibold text-sm md:text-base">{tokenA.symbol}</span>
                    </div>
                  ) : (
                    "Select token"
                  )}
                </Button>
                {isConnected && tokenA && balanceA && (
                  <Button
                    data-testid="button-max-token-a"
                    onClick={() => setAmountA(balanceAFormatted)}
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs font-semibold text-primary hover:text-primary/80 hover:bg-primary/10"
                  >
                    MAX
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-center -my-2">
            <div className="rounded-full h-10 w-10 bg-card border-4 border-background flex items-center justify-center shadow-md">
              <Plus className="h-5 w-5 text-primary" />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-muted-foreground">Token B</label>
              {isConnected && tokenB && (
                <span className="text-xs text-muted-foreground">
                  Balance: {balanceBFormatted}
                </span>
              )}
            </div>

            <div className="relative bg-muted/50 rounded-xl p-4 border border-border/40 hover:border-border/60 transition-colors">
              <Input
                data-testid="input-token-b-amount"
                type="number"
                placeholder={pairExists && reserveA > 0n && reserveB > 0n ? "Calculated from pool ratio" : "0.00"}
                value={amountB}
                onChange={(e) => (pairExists && reserveA > 0n && reserveB > 0n ? null : setAmountB(e.target.value))}
                disabled={pairExists && reserveA > 0n && reserveB > 0n}
                className="border-0 bg-transparent text-xl md:text-2xl font-semibold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-100 disabled:cursor-not-allowed"
              />

              <div className="flex items-center justify-between mt-3">
                <Button
                  data-testid="button-select-token-b"
                  onClick={() => setShowTokenBSelector(true)}
                  variant="secondary"
                  className="h-10 px-3 md:px-4 hover:bg-secondary/80"
                >
                  {tokenB ? (
                    <div className="flex items-center gap-2">
                      <img src={tokenB.logoURI} alt={tokenB.symbol} className="w-6 h-6 rounded-full" />
                      <span className="font-semibold text-sm md:text-base">{tokenB.symbol}</span>
                    </div>
                  ) : (
                    "Select token"
                  )}
                </Button>
                {isConnected && tokenB && balanceB && !(pairExists && reserveA > 0n && reserveB > 0n) && (
                  <Button
                    data-testid="button-max-token-b"
                    onClick={() => setAmountB(balanceBFormatted)}
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs font-semibold text-primary hover:text-primary/80 hover:bg-primary/10"
                  >
                    MAX
                  </Button>
                )}
              </div>
            </div>
          </div>

          {tokenA && tokenB && (
            <div className="space-y-3">
              {/* Pool Status Card */}
              <div className="bg-primary/5 border border-primary/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">Pool Information</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-semibold px-2.5 py-1 rounded-full ${
                      isLoadingPair 
                        ? 'bg-muted text-muted-foreground' 
                        : pairExists && reserveA > 0n && reserveB > 0n 
                          ? 'bg-green-500/20 text-green-400' 
                          : pairExists ? 'bg-yellow-500/20 text-yellow-400' 
                          : 'bg-blue-500/20 text-blue-400'
                    }`}>
                      {isLoadingPair ? "Checking..." : pairExists && reserveA > 0n && reserveB > 0n ? "Existing" : pairExists ? "Empty" : "New"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setIsLoadingPair(true);
                        setTimeout(() => {
                          // Trigger check by causing a state update
                          setTokenA(tokenA);
                        }, 100);
                      }}
                      disabled={isLoadingPair}
                      className="h-7 px-2 text-xs"
                      data-testid="button-refresh-pool"
                    >
                      Refresh
                    </Button>
                  </div>
                </div>

                {/* Current Pool Ratio */}
                {pairExists && reserveA > 0n && reserveB > 0n && (
                  <div className="pt-2 border-t border-primary/20 space-y-1.5">
                    <p className="text-xs text-muted-foreground">Current Pool Ratio:</p>
                    <p className="text-base font-semibold text-foreground">
                      1 {tokenA.symbol} = {calculateRatio(reserveB, tokenB.decimals, reserveA, tokenA.decimals)} {tokenB.symbol}
                    </p>
                    <p className="text-xs text-muted-foreground">Your deposit must match this ratio</p>
                  </div>
                )}

                {/* Initial Ratio For New Pool */}
                {(!pairExists || (pairExists && (reserveA === 0n || reserveB === 0n))) && (
                  <div className="pt-2 border-t border-primary/20 space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                      {pairExists ? "Pool exists but is empty. Set initial ratio:" : "New Pool - Set initial ratio:"}
                    </p>
                    {amountA && amountB && parseFloat(amountA) > 0 && parseFloat(amountB) > 0 ? (
                      <p className="text-base font-semibold text-foreground">
                        1 {tokenA.symbol} = {(parseFloat(amountB) / parseFloat(amountA)).toFixed(6)} {tokenB.symbol}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">Enter amounts to see ratio</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {isConnected ? (
            <Button
              data-testid="button-add-liquidity"
              onClick={handleAddLiquidity}
              disabled={!tokenA || !tokenB || !amountA || !amountB || parseFloat(amountA) <= 0 || parseFloat(amountB) <= 0 || isAdding}
              className="w-full h-12 md:h-14 text-base md:text-lg font-semibold bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-600/90 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {isAdding ? "Adding Liquidity..." : "Add Liquidity"}
            </Button>
          ) : (
            <Button
              data-testid="button-connect-wallet"
              disabled
              className="w-full h-12 md:h-14 text-base md:text-lg font-semibold"
            >
              Connect Wallet
            </Button>
          )}
        </CardContent>
      </Card>

      <TokenSelector
        open={showTokenASelector}
        onClose={() => setShowTokenASelector(false)}
        onSelect={(token) => {
          setTokenA(token);
          setShowTokenASelector(false);
        }}
        tokens={tokens}
        onImport={handleImportToken}
      />

      <TokenSelector
        open={showTokenBSelector}
        onClose={() => setShowTokenBSelector(false)}
        onSelect={(token) => {
          setTokenB(token);
          setShowTokenBSelector(false);
        }}
        tokens={tokens}
        onImport={handleImportToken}
      />
    </div>
  );
}