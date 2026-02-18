import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowDownUp, Settings, AlertTriangle, ExternalLink, HelpCircle, ChevronDown, Bell, ArrowRight, Zap } from "lucide-react";
import { TokenSelector } from "@/components/TokenSelector";
import { SwapSettings } from "@/components/SwapSettings";
import { TransactionHistory } from "@/components/TransactionHistory";
import { PathVisualizer, type RouteHop } from "@/components/PathVisualizer";
import { V3ContractStatus } from "@/components/V3ContractStatus";
import { useAccount, useBalance, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Contract, BrowserProvider, formatUnits, parseUnits } from "ethers";
import { defaultTokens, getTokensByChainId, isNativeToken, getWrappedAddress } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getSmartRouteQuote, type SmartRoutingResult } from "@/lib/smart-routing";
import { loadDexSettings, saveDexSettings } from "@/lib/dex-settings";
import { getCachedQuote, setCachedQuote } from "@/lib/quote-cache";
import { SWAP_ROUTER_V3_ABI } from "@/lib/abis/v3";

// ERC20 ABI for token operations
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// Wrapped token contract ABI for deposit/withdraw (wUSDC/wUSDT)
const WRAPPED_TOKEN_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

export default function Swap() {
  const [fromToken, setFromToken] = useState<Token | null>(null);
  const [toToken, setToToken] = useState<Token | null>(null);
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [showFromSelector, setShowFromSelector] = useState(false);
  const [showToSelector, setShowToSelector] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [isSwapping, setIsSwapping] = useState(false);
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const [slippage, setSlippage] = useState(0.5); // Default to 0.5% slippage (safe default)
  const [deadline, setDeadline] = useState(20);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [priceImpact, setPriceImpact] = useState<number | null>(null);
  const [quoteRefreshInterval, setQuoteRefreshInterval] = useState(30);
  const [routingPath, setRoutingPath] = useState<string[]>([]);
  const [showTransactionHistory, setShowTransactionHistory] = useState(false);
  const [isPriceImpactCollapsed, setIsPriceImpactCollapsed] = useState(false);
  
  // Smart routing state
  const [smartRoutingResult, setSmartRoutingResult] = useState<SmartRoutingResult | null>(null);
  const [routeHops, setRouteHops] = useState<RouteHop[]>([]);
  const [v2Enabled, setV2Enabled] = useState(true);
  const [v3Enabled, setV3Enabled] = useState(true);
  
  // Abort controller for quote fetching race conditions
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  
  // Load DEX settings on mount
  useEffect(() => {
    const settings = loadDexSettings();
    setV2Enabled(settings.v2Enabled);
    setV3Enabled(settings.v3Enabled);
  }, []);
  
  // Save DEX settings when they change
  useEffect(() => {
    saveDexSettings({ v2Enabled, v3Enabled });
  }, [v2Enabled, v3Enabled]);

  // Get chain-specific contracts
  const contracts = chainId ? getContractsForChain(chainId) : null;

  // Function to open transaction in explorer
  const openExplorer = (txHash: string) => {
    if (contracts) {
      window.open(`${contracts.explorer}${txHash}`, '_blank');
    }
  };

  // Load tokens from JSON and localStorage - filter by chain
  useEffect(() => {
    loadTokens();
  }, [chainId]);

  // Set default tokens based on chain
  useEffect(() => {
    if (tokens.length === 0 || !chainId) return;

    // Set defaults only if not already set or if chain changed
    if (!fromToken || fromToken.chainId !== chainId) {
      // Default to USDC for ARC Testnet
      const defaultFrom = tokens.find(t => t.symbol === 'USDC');
      if (defaultFrom) setFromToken(defaultFrom);
    }

    if (!toToken || toToken.chainId !== chainId) {
      // Default to ACHS
      const achs = tokens.find(t => t.symbol === 'ACHS');
      if (achs) setToToken(achs);
    }
  }, [tokens, fromToken, toToken, chainId]);

  // Fetch quote when fromAmount, fromToken, or toToken changes - with debounce and abort
  useEffect(() => {
    // Debounce the quote fetch to avoid race conditions
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    
    // Abort any previous fetch
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    debounceTimeoutRef.current = setTimeout(() => {
      const fetchQuote = async (signal: AbortSignal) => {
        if (!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0) {
          setToAmount("");
          setPriceImpact(null);
          return;
        }

        // Handle wrap/unwrap - 1:1 ratio for ARC Testnet
        const isWrap = fromToken.symbol === 'USDC' && toToken.symbol === 'wUSDC';
        const isUnwrap = fromToken.symbol === 'wUSDC' && toToken.symbol === 'USDC';

        if (isWrap || isUnwrap) {
          setToAmount(fromAmount);
          setPriceImpact(0);
          setRouteHops([{
            tokenIn: fromToken,
            tokenOut: toToken,
            protocol: "V2",
          }]);
          return;
        }

        if (!window.ethereum || !contracts) return;

        setIsLoadingQuote(true);
        try {
          const provider = new BrowserProvider(window.ethereum);
          
          // Get wrapped token address for routing
          const wrappedTokenData = tokens.find(t => t.symbol === 'wUSDC');
          const wrappedAddress = wrappedTokenData?.address;

          if (!wrappedAddress) {
            throw new Error('wUSDC token not found');
          }

          const amountIn = parseAmount(fromAmount, fromToken.decimals);
          
          // Check if both protocols are disabled
          if (!v2Enabled && !v3Enabled) {
            toast({
              title: "No protocols enabled",
              description: "Please enable at least one protocol in settings",
              variant: "destructive",
            });
            setToAmount("");
            setPriceImpact(null);
            setRouteHops([]);
            return;
          }

          // Check if aborted
          if (signal.aborted) return;

          // Check cache first
          const cachedQuote = getCachedQuote(
            fromToken.address,
            toToken.address,
            fromAmount,
            v2Enabled,
            v3Enabled
          );

          let result: SmartRoutingResult | null;

          if (cachedQuote) {
            result = cachedQuote;
          } else {
            // Get smart route quote
            result = await getSmartRouteQuote(
              provider,
              contracts.v2.router,
              contracts.v3.quoter02,
              fromToken,
              toToken,
              amountIn,
              wrappedAddress,
              v2Enabled,
              v3Enabled
            );

            // Check if aborted after async call
            if (signal.aborted) return;

            // Cache the result
            if (result) {
              setCachedQuote(
                fromToken.address,
                toToken.address,
                fromAmount,
                v2Enabled,
                v3Enabled,
                result
              );
            }
          }

          if (!result || !result.bestQuote) {
            setToAmount("");
            setPriceImpact(null);
            setRouteHops([]);
            return;
          }

          // Update state with best route
          setSmartRoutingResult(result);
          const outputAmount = formatAmount(result.bestQuote.outputAmount, toToken.decimals);
          setToAmount(outputAmount);
          setPriceImpact(result.bestQuote.priceImpact);
          setRouteHops(result.bestQuote.route);
        } catch (error) {
          // Don't update state if aborted
          if (signal.aborted) return;
          
          console.error('Failed to fetch quote:', error);
          setToAmount("");
          setPriceImpact(null);
          setRouteHops([]);
          setSmartRoutingResult(null);
        } finally {
          if (!signal.aborted) {
            setIsLoadingQuote(false);
          }
        }
      };

      // Create new abort controller for this fetch
      const controller = new AbortController();
      abortControllerRef.current = controller;
      fetchQuote(controller.signal);
    }, 300); // 300ms debounce

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fromAmount, fromToken, toToken, tokens, quoteRefreshInterval, contracts, chainId, v2Enabled, v3Enabled, toast]);

  const loadTokens = async () => {
    try {
      if (!chainId) return;

      // Filter tokens by current chain ID
      const chainTokens = getTokensByChainId(chainId);

      // Load imported tokens from localStorage (filter by chain)
      const imported = localStorage.getItem('importedTokens');
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
      const chainImportedTokens = importedTokens.filter(t => t.chainId === chainId);

      // Add a default logoURI for missing logos, fallback to '?' if not available
      const processedTokens = chainTokens.map(token => ({
        ...token,
        logoURI: token.logoURI || `/img/logos/unknown-token.png` // Fallback logo
      }));

      const processedImportedTokens = chainImportedTokens.map(token => ({
        ...token,
        logoURI: token.logoURI || `/img/logos/unknown-token.png` // Fallback logo
      }));

      setTokens([...processedTokens, ...processedImportedTokens]);
    } catch (error) {
      console.error('Failed to load tokens:', error);
    }
  };

  const handleImportToken = async (address: string): Promise<Token | null> => {
    try {
      // Validate address format
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

      // Use public RPC for token data (no wallet needed) - ARC Testnet
      const rpcUrl = 'https://rpc.testnet.arc.network';
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

      // Fetch token metadata with timeout
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
        logoURI: `/img/logos/unknown-token.png`, // Fallback logo
        verified: false,
        chainId,
      };

      // Save to localStorage
      const imported = localStorage.getItem('importedTokens');
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];

      // Check if already imported
      const alreadyImported = importedTokens.find((t: Token) => t.address.toLowerCase() === address.toLowerCase());
      if (!alreadyImported) {
        importedTokens.push( newToken);
        localStorage.setItem('importedTokens', JSON.stringify(importedTokens));
      }

      // Update state
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

  const handleSwapTokens = () => {
    const temp = fromToken;
    setFromToken(toToken);
    setToToken(temp);
    // Clear amounts instead of swapping - let user input fresh amount
    // This avoids the jarring UX of showing a quoted output as input
    setFromAmount("");
    setToAmount("");
    setSmartRoutingResult(null);
  };

  const handleWrap = async (amount: string) => {
    if (!address || !window.ethereum || !wrappedToken || !nativeToken) return;

    setIsSwapping(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const amountBigInt = parseAmount(amount, wrappedToken.decimals);

      // For native token, we send it to wrapped contract's deposit function
      const wrappedContract = new Contract(wrappedToken.address, WRAPPED_TOKEN_ABI, signer);

      toast({
        title: "Wrapping...",
        description: `Wrapping ${amount} ${nativeSymbol} to ${wrappedSymbol}`,
      });

      // Call deposit with the amount as value (native token transfer)
      // Estimate gas and add 50% buffer
      const gasEstimate = await wrappedContract.deposit.estimateGas({ value: amountBigInt });
      const gasLimit = (gasEstimate * 150n) / 100n;
      const tx = await wrappedContract.deposit({ value: amountBigInt, gasLimit });
      const receipt = await tx.wait();

      // Refetch balances
      await Promise.all([refetchFromBalance(), refetchToBalance()]);

      setFromAmount("");
      setToAmount("");

      toast({
        title: "Wrap successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully wrapped {amount} {nativeSymbol} to {wrappedSymbol}</span>
            <Button 
              size="sm" 
              variant="ghost" 
              className="h-6 px-2"
              onClick={() => openExplorer(receipt.hash)}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error('Wrap error:', error);
      toast({
        title: "Wrap failed",
        description: error.reason || error.message || "Failed to wrap tokens",
        variant: "destructive",
      });
    } finally {
      setIsSwapping(false);
    }
  };

  const handleUnwrap = async (amount: string) => {
    if (!address || !window.ethereum || !wrappedToken || !nativeToken) return;

    setIsSwapping(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const amountBigInt = parseAmount(amount, wrappedToken.decimals);
      const wrappedContract = new Contract(wrappedToken.address, WRAPPED_TOKEN_ABI, signer);

      toast({
        title: "Unwrapping...",
        description: `Unwrapping ${amount} ${wrappedSymbol} to ${nativeSymbol}`,
      });

      // Note: withdraw() burns from caller's balance directly, no approval needed
      // The previous approval logic was incorrect - it approved wrappedToken to spend from itself
      
      // Call withdraw with gas buffer
      const gasEstimate = await wrappedContract.withdraw.estimateGas(amountBigInt);
      const gasLimit = (gasEstimate * 150n) / 100n;
      const tx = await wrappedContract.withdraw(amountBigInt, { gasLimit });
      const receipt = await tx.wait();

      // Refetch balances
      await Promise.all([refetchFromBalance(), refetchToBalance()]);

      setFromAmount("");
      setToAmount("");

      toast({
        title: "Unwrap successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully unwrapped {amount} {wrappedSymbol} to {nativeSymbol}</span>
            <Button 
              size="sm" 
              variant="ghost" 
              className="h-6 px-2"
              onClick={() => openExplorer(receipt.hash)}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error('Unwrap error:', error);
      toast({
        title: "Unwrap failed",
        description: error.reason || error.message || "Failed to unwrap tokens",
        variant: "destructive",
      });
    } finally {
      setIsSwapping(false);
    }
  };

  const saveTransaction = (from: Token, to: Token, fromAmt: string, toAmt: string, txHash: string) => {
    const transaction = {
      id: txHash,
      fromToken: from,
      toToken: to,
      fromAmount: fromAmt,
      toAmount: toAmt,
      timestamp: Date.now(),
      chainId: chainId,
    };

    const storageKey = `transactions_${chainId}`;
    const existing = localStorage.getItem(storageKey);
    const transactions = existing ? JSON.parse(existing) : [];
    transactions.unshift(transaction); // Add to beginning
    
    // Keep only last 50 transactions
    if (transactions.length > 50) {
      transactions.pop();
    }
    
    localStorage.setItem(storageKey, JSON.stringify(transactions));
  };

  const handleSwap = async () => {
    if (!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0) return;

    // Check if this is a wrap/unwrap operation for ARC Testnet
    const isWrap = fromToken.symbol === 'USDC' && toToken.symbol === 'wUSDC';
    const isUnwrap = fromToken.symbol === 'wUSDC' && toToken.symbol === 'USDC';

    if (isWrap) {
      await handleWrap(fromAmount);
      return;
    }

    if (isUnwrap) {
      await handleUnwrap(fromAmount);
      return;
    }

    setIsSwapping(true);
    try {

      if (!address || !window.ethereum) {
        throw new Error("Please connect your wallet");
      }

      if (!contracts) {
        throw new Error("Chain contracts not configured");
      }
      
      if (!smartRoutingResult || !smartRoutingResult.bestQuote) {
        throw new Error("No valid quote available");
      }

      // Freshness check - warn if quote is older than 30 seconds
      const quoteAge = Date.now() - (smartRoutingResult.timestamp || 0);
      const QUOTE_STALE_THRESHOLD = 30 * 1000; // 30 seconds
      
      if (quoteAge > QUOTE_STALE_THRESHOLD) {
        toast({
          title: "Stale quote detected",
          description: "The price may have changed. Please refresh the quote.",
          variant: "destructive",
        });
        setIsSwapping(false);
        return;
      }

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      const bestQuote = smartRoutingResult.bestQuote;
      const amountIn = parseAmount(fromAmount, fromToken.decimals);
      // Calculate minimum output with slippage protection
      // slippage is a percentage (e.g., 0.5 means 0.5%)
      const slippageBps = BigInt(Math.floor(slippage * 100)); // Convert to basis points
      const minAmountOut = (bestQuote.outputAmount * (10000n - slippageBps)) / 10000n;
      const deadlineTimestamp = Math.floor(Date.now() / 1000) + (deadline * 60);
      
      // Validate and checksum recipient address
      let recipient: string;
      if (recipientAddress) {
        try {
          // getAddress validates and applies checksum
          recipient = getAddress(recipientAddress);
        } catch (e) {
          throw new Error("Invalid recipient address format. Please check the address and try again.");
        }
      } else {
        recipient = address!;
      }

      // Helper function for retry with exponential backoff
      const executeWithRetry = async <T,>(
        fn: () => Promise<T>,
        maxRetries: number = 2,
        operationName: string = "operation"
      ): Promise<T> => {
        let lastError: Error | null = null;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await fn();
          } catch (error: any) {
            lastError = error;
            console.error(`${operationName} attempt ${attempt + 1} failed:`, error.reason || error.message);
            
            if (attempt === maxRetries) {
              throw error;
            }
            
            // Exponential backoff: 500ms, 1000ms
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
        
        throw lastError;
      };

      // Check if we have an alternative route available for fallback
      const hasAlternativeRoute = smartRoutingResult?.alternativeQuotes && smartRoutingResult.alternativeQuotes.length > 0;

      toast({
        title: "Swapping...",
        description: `Using ${bestQuote.protocol} protocol`,
      });

      let tx;
      
      if (bestQuote.protocol === "V3") {
        // V3 Swap - V3 only works with ERC20 tokens
        const swapRouter = new Contract(contracts.v3.swapRouter, SWAP_ROUTER_V3_ABI, signer);
        
        // Handle native token - V3 requires ERC20, so wrap first
        const fromTokenIsNative = isNativeToken(fromToken.address);
        const toTokenIsNative = isNativeToken(toToken.address);
        const wrappedAddress = getWrappedAddress(chainId, "0x0000000000000000000000000000000000000000");
        
        if (!wrappedAddress) {
          throw new Error("No wrapped token configured for native token");
        }
        
        // Get ERC20 addresses for V3 swap
        const fromTokenERC20 = fromTokenIsNative ? wrappedAddress : fromToken.address;
        const toTokenERC20 = toTokenIsNative ? wrappedAddress : toToken.address;
        
        // Only need separate approval for non-native tokens
        if (!fromTokenIsNative) {
          const tokenContract = new Contract(fromTokenERC20, ERC20_ABI, signer);
          const allowance = await tokenContract.allowance(address, contracts.v3.swapRouter);
          
          if (allowance < amountIn) {
            toast({
              title: "Approval needed",
              description: "Approving token for V3 swap...",
            });
            const approveGasEstimate = await tokenContract.approve.estimateGas(contracts.v3.swapRouter, amountIn);
            const approveGasLimit = (approveGasEstimate * 150n) / 100n;
            const approveTx = await tokenContract.approve(contracts.v3.swapRouter, amountIn, { gasLimit: approveGasLimit });
            await approveTx.wait();
          }
        }
        
        // Build calls for multicall (swap + optional unwrap in one transaction)
        const calls: string[] = [];
        let totalValue = fromTokenIsNative ? amountIn : 0n;
        
        // Check if single-hop or multi-hop
        if (bestQuote.route.length === 1) {
          // Single-hop V3 swap
          const fee = bestQuote.route[0].fee || 3000;
          
          const params = {
            tokenIn: fromTokenERC20,
            tokenOut: toTokenERC20,
            fee: fee,
            recipient: recipient,
            deadline: deadlineTimestamp,
            amountIn: amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0n,
          };
          
          // Use exactInputSingle function
          const exactInputSingleData = swapRouter.interface.encodeFunctionData("exactInputSingle", [params]);
          calls.push(exactInputSingleData);
          
          // If output should be native, add unwrap call
          if (toTokenIsNative) {
            const unwrapCall = swapRouter.interface.encodeFunctionData("unwrapWETH9", [minAmountOut, recipient]);
            calls.push(unwrapCall);
          }
          
          // Execute multicall with retry
          try {
            tx = await executeWithRetry(
              async () => {
                const gasEstimate = await swapRouter.multicall.estimateGas(calls, { value: totalValue });
                const gasLimit = (gasEstimate * 150n) / 100n;
                return await swapRouter.multicall(calls, { gasLimit, value: totalValue });
              },
              2,
              "V3 swap"
            );
          } catch (v3Error: any) {
            // V3 failed - try fallback to V2 if available
            console.error('V3 swap failed, attempting fallback:', v3Error.reason || v3Error.message);
            
            if (hasAlternativeRoute) {
              const alternativeQuote = smartRoutingResult.alternativeQuotes!.find(q => q.protocol === "V2");
              
              if (alternativeQuote) {
                toast({
                  title: "Falling back to V2",
                  description: "V3 swap failed, trying V2 route instead...",
                });
                
                // Execute V2 swap as fallback
                tx = await executeV2Swap(
                  signer,
                  contracts,
                  fromToken,
                  toToken,
                  alternativeQuote,
                  amountIn,
                  (alternativeQuote.outputAmount * (10000n - BigInt(Math.floor(slippage * 100)))) / 10000n,
                  deadlineTimestamp,
                  recipient,
                  address,
                  executeWithRetry
                );
                
                // Update bestQuote for transaction receipt
                Object.assign(bestQuote, alternativeQuote);
              } else {
                throw v3Error;
              }
            } else {
              throw v3Error;
            }
          }
        } else {
          // Multi-hop V3 swap
          const { encodePath } = await import("@/lib/v3-utils");
          const tokens: string[] = [fromTokenERC20];
          const fees: number[] = [];
          
          for (const hop of bestQuote.route) {
            // Use wrapped address for native tokens in path
            const hopTokenOut = isNativeToken(hop.tokenOut.address) ? wrappedAddress : hop.tokenOut.address;
            if (hopTokenOut !== tokens[tokens.length - 1]) {
              tokens.push(hopTokenOut);
              fees.push(hop.fee || 3000);
            }
          }
          
          const path = encodePath(tokens, fees);
          
          const params = {
            path: path,
            recipient: recipient,
            deadline: deadlineTimestamp,
            amountIn: amountIn,
            amountOutMinimum: minAmountOut,
          };
          
          // Use exactInput function
          const exactInputData = swapRouter.interface.encodeFunctionData("exactInput", [params]);
          calls.push(exactInputData);
          
          // If output should be native, add unwrap call
          if (toTokenIsNative) {
            const unwrapCall = swapRouter.interface.encodeFunctionData("unwrapWETH9", [minAmountOut, recipient]);
            calls.push(unwrapCall);
          }
          
          // Execute multicall (deadline is in the params struct)
          const gasEstimate = await swapRouter.multicall.estimateGas(calls, { value: totalValue });
          const gasLimit = (gasEstimate * 150n) / 100n;
          tx = await swapRouter.multicall(calls, { gasLimit, value: totalValue });
        }
      } else {
        // V2 Swap
        const V2_ROUTER_ABI = [
          "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
          "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
          "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
        ];
        
        const router = new Contract(contracts.v2.router, V2_ROUTER_ABI, signer);
        
        // Handle native token for V2
        const fromTokenIsNative = isNativeToken(fromToken.address);
        const toTokenIsNative = isNativeToken(toToken.address);
        const wrappedAddress = getWrappedAddress(chainId, "0x0000000000000000000000000000000000000000");
        
        // Build path from route (use wrapped address for native tokens)
        const path: string[] = [];
        for (let i = 0; i < bestQuote.route.length; i++) {
          const hop = bestQuote.route[i];
          if (i === 0) {
            const tokenIn = isNativeToken(hop.tokenIn.address) ? wrappedAddress : hop.tokenIn.address;
            path.push(tokenIn);
          }
          const tokenOut = isNativeToken(hop.tokenOut.address) ? wrappedAddress : hop.tokenOut.address;
          if (tokenOut !== path[path.length - 1]) {
            path.push(tokenOut);
          }
        }
        
        // Execute swap based on native token involvement
        if (fromTokenIsNative) {
          // Swap native for tokens - use swapExactETHForTokens
          const gasEstimate = await router.swapExactETHForTokens.estimateGas(
            minAmountOut,
            path,
            recipient,
            deadlineTimestamp,
            { value: amountIn }
          );
          const gasLimit = (gasEstimate * 150n) / 100n;
          tx = await router.swapExactETHForTokens(
            minAmountOut,
            path,
            recipient,
            deadlineTimestamp,
            { value: amountIn, gasLimit }
          );
        } else if (toTokenIsNative) {
          // Swap tokens for native - use swapExactTokensForETH
          const tokenContract = new Contract(fromToken.address, ERC20_ABI, signer);
          const allowance = await tokenContract.allowance(address, contracts.v2.router);
          
          if (allowance < amountIn) {
            toast({
              title: "Approval needed",
              description: "Approving token for V2 swap...",
            });
            const approveGasEstimate = await tokenContract.approve.estimateGas(contracts.v2.router, amountIn);
            const approveGasLimit = (approveGasEstimate * 150n) / 100n;
            const approveTx = await tokenContract.approve(contracts.v2.router, amountIn, { gasLimit: approveGasLimit });
            await approveTx.wait();
          }
          
          const gasEstimate = await router.swapExactTokensForETH.estimateGas(
            amountIn,
            minAmountOut,
            path,
            recipient,
            deadlineTimestamp
          );
          const gasLimit = (gasEstimate * 150n) / 100n;
          tx = await router.swapExactTokensForETH(
            amountIn,
            minAmountOut,
            path,
            recipient,
            deadlineTimestamp,
            { gasLimit }
          );
        } else {
          // Regular token-to-token swap
          const tokenContract = new Contract(fromToken.address, ERC20_ABI, signer);
          const allowance = await tokenContract.allowance(address, contracts.v2.router);
          
          if (allowance < amountIn) {
            toast({
              title: "Approval needed",
              description: "Approving token for V2 swap...",
            });
            const approveGasEstimate = await tokenContract.approve.estimateGas(contracts.v2.router, amountIn);
            const approveGasLimit = (approveGasEstimate * 150n) / 100n;
            const approveTx = await tokenContract.approve(contracts.v2.router, amountIn, { gasLimit: approveGasLimit });
            await approveTx.wait();
          }
          
          const gasEstimate = await router.swapExactTokensForTokens.estimateGas(
            amountIn,
            minAmountOut,
            path,
            recipient,
            deadlineTimestamp
          );
          const gasLimit = (gasEstimate * 150n) / 100n;
          tx = await router.swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            path,
            recipient,
            deadlineTimestamp,
            { gasLimit }
          );
        }
      }

      const receipt = await tx.wait();

      // Save transaction
      saveTransaction(fromToken, toToken, fromAmount, toAmount, receipt.hash);

      // Refetch balances
      await Promise.all([refetchFromBalance(), refetchToBalance()]);

      setFromAmount("");
      setToAmount("");
      setSmartRoutingResult(null);
      setRouteHops([]);

      toast({
        title: "Swap successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Swapped {fromAmount} {fromToken.symbol} for {toAmount} {toToken.symbol} via {bestQuote.protocol}</span>
            <Button 
              size="sm" 
              variant="ghost" 
              className="h-6 px-2"
              onClick={() => openExplorer(receipt.hash)}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error('Swap error:', error);
      toast({
        title: "Swap failed",
        description: error.reason || error.message || "Failed to execute swap",
        variant: "destructive",
      });
    } finally {
      setIsSwapping(false);
    }
  };

  // Fetch balances for selected tokens with auto-refresh
  const isFromTokenNative = fromToken?.address === "0x0000000000000000000000000000000000000000";
  const isToTokenNative = toToken?.address === "0x0000000000000000000000000000000000000000";

  const { data: fromBalance, refetch: refetchFromBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    ...(fromToken && !isFromTokenNative ? { token: fromToken.address as `0x${string}` } : {}),
  });

  const { data: toBalance, refetch: refetchToBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    ...(toToken && !isToTokenNative ? { token: toToken.address as `0x${string}` } : {}),
  });

  // Refetch balances immediately when tokens change
  useEffect(() => {
    if (!isConnected || !fromToken || !toToken) return;

    refetchFromBalance();
    refetchToBalance();
  }, [isConnected, fromToken?.address, toToken?.address]);

  // Auto-refresh balances every 30 seconds
  useEffect(() => {
    if (!isConnected) return;

    const intervalId = setInterval(() => {
      refetchFromBalance();
      refetchToBalance();
    }, 30000); // 30 seconds

    return () => clearInterval(intervalId);
  }, [isConnected, refetchFromBalance, refetchToBalance]);

  let fromBalanceFormatted = "0.00";
  let toBalanceFormatted = "0.00";

  try {
    if (fromBalance) {
      const formatted = formatAmount(fromBalance.value, fromBalance.decimals);
      fromBalanceFormatted = formatted;
    }
  } catch (error) {
    console.error('Error formatting fromBalance', error);
  }

  try {
    if (toBalance) {
      const formatted = formatAmount(toBalance.value, toBalance.decimals);
      toBalanceFormatted = formatted;
    }
  } catch (error) {
    console.error('Error formatting toBalance', error);
  }

  // Get native and wrapped tokens for ARC Testnet
  const nativeSymbol = 'USDC';
  const wrappedSymbol = 'wUSDC';
  const nativeToken = tokens.find(t => t.symbol === nativeSymbol);
  const wrappedToken = tokens.find(t => t.symbol === wrappedSymbol);

  // Define ROUTER_ADDRESS based on chainId
  let ROUTER_ADDRESS = "";
  if (contracts) {
    ROUTER_ADDRESS = contracts.v2.router;
  }

  return (
    <div className="container max-w-md mx-auto px-4 py-4 md:py-8 fade-in">
      {/* V3 Contract Status */}
      <V3ContractStatus />
      
      <Card className="border-border/40 shadow-2xl backdrop-blur-xl bg-card/95 card-hover overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-blue-500/5 pointer-events-none"></div>
        <CardHeader className="space-y-1 pb-4 md:pb-6 relative z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl md:text-2xl font-bold bg-gradient-to-r from-foreground to-foreground/80 bg-clip-text">
              Swap Tokens
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button 
                data-testid="button-transaction-history"
                size="icon" 
                variant="ghost"
                onClick={() => setShowTransactionHistory(true)}
                className="h-9 w-9 hover:bg-accent/50 transition-all duration-300"
              >
                <Bell className="h-4 w-4" />
              </Button>
              <Button 
                data-testid="button-settings"
                size="icon" 
                variant="ghost"
                onClick={() => setShowSettings(true)}
                className="h-9 w-9 hover:bg-accent/50 hover:rotate-90 transition-all duration-300"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground">Trade tokens instantly with the best rates</p>
        </CardHeader>

        <CardContent className="space-y-3 md:space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-muted-foreground">From</label>
              {isConnected && fromToken && (
                <span className="text-xs text-muted-foreground">
                  Balance: {fromBalanceFormatted}
                </span>
              )}
            </div>

            <div className="relative bg-gradient-to-br from-muted/50 to-muted/30 rounded-xl p-4 border border-border/40 hover:border-primary/40 transition-all duration-300 glass group">
              <Input
                data-testid="input-from-amount"
                type="number"
                placeholder="0.00"
                value={fromAmount}
                onChange={(e) => setFromAmount(e.target.value)}
                className="border-0 bg-transparent text-xl md:text-2xl font-semibold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all duration-300"
              />

              <div className="flex items-center justify-between mt-3">
                <Button
                  data-testid="button-select-from-token"
                  onClick={() => setShowFromSelector(true)}
                  variant="secondary"
                  className="h-10 px-3 md:px-4 hover:bg-secondary/80 hover:scale-105 transition-all duration-300 group"
                >
                  {fromToken ? (
                    <div className="flex items-center gap-2">
                      {fromToken.logoURI ? (
                        <img 
                          src={fromToken.logoURI} 
                          alt={fromToken.symbol} 
                          className="w-6 h-6 rounded-full group-hover:scale-110 transition-transform duration-300" 
                          onError={(e) => {
                            console.error('Failed to load token logo:', fromToken.logoURI);
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-red-500"></div>
                      )}
                      <span className="font-semibold text-sm md:text-base">{fromToken.symbol}</span>
                    </div>
                  ) : (
                    "Select token"
                  )}
                </Button>
                {isConnected && fromToken && fromBalance && (
                  <Button
                    data-testid="button-max-from"
                    onClick={() => setFromAmount(fromBalanceFormatted)}
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

          <div className="flex justify-center -my-2 relative z-10">
            <Button
              data-testid="button-swap-direction"
              size="icon"
              variant="ghost"
              onClick={handleSwapTokens}
              disabled={!fromToken || !toToken}
              className="rounded-full h-10 w-10 bg-card border-4 border-background hover:bg-primary hover:text-primary-foreground hover:rotate-180 transition-all duration-500 shadow-lg hover:shadow-primary/50 disabled:opacity-50 pulse-glow"
            >
              <ArrowDownUp className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-muted-foreground">To</label>
              {isConnected && toToken && (
                <span className="text-xs text-muted-foreground">
                  Balance: {toBalanceFormatted}
                </span>
              )}
            </div>

            <div className="relative bg-gradient-to-br from-muted/50 to-muted/30 rounded-xl p-4 border border-border/40 hover:border-primary/40 transition-all duration-300 glass">
              <Input
                data-testid="input-to-amount"
                type="number"
                placeholder={isLoadingQuote ? "Calculating..." : "0.00"}
                value={toAmount}
                onChange={(e) => setToAmount(e.target.value)}
                className="border-0 bg-transparent text-xl md:text-2xl font-semibold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled
              />

              <div className="flex items-center justify-between mt-3">
                <Button
                  data-testid="button-select-to-token"
                  onClick={() => setShowToSelector(true)}
                  variant="secondary"
                  className="h-10 px-3 md:px-4 hover:bg-secondary/80"
                >
                  {toToken ? (
                    <div className="flex items-center gap-2">
                      {toToken.logoURI ? (
                        <img 
                          src={toToken.logoURI} 
                          alt={toToken.symbol} 
                          className="w-6 h-6 rounded-full" 
                          onError={(e) => {
                            console.error('Failed to load token logo:', toToken.logoURI);
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-red-500"></div>
                      )}
                      <span className="font-semibold text-sm md:text-base">{toToken.symbol}</span>
                    </div>
                  ) : (
                    "Select token"
                  )}
                </Button>
              </div>
            </div>
          </div>

          {fromToken && toToken && fromAmount && toAmount && (
            <>
              {priceImpact !== null && priceImpact > 15 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-2 fade-in">
                  <div className="flex items-center gap-2 text-red-500">
                    <AlertTriangle className="h-5 w-5" />
                    <span className="font-semibold text-sm">High Price Impact Warning!</span>
                  </div>
                  <p className="text-xs text-red-400">
                    This swap has a price impact of {priceImpact.toFixed(2)}%. You may receive significantly less than expected.
                  </p>
                </div>
              )}
              
              <Collapsible open={!isPriceImpactCollapsed} onOpenChange={(open) => setIsPriceImpactCollapsed(!open)}>
                <CollapsibleTrigger asChild>
                  <Button 
                    variant="ghost" 
                    className="w-full flex items-center justify-between p-3 bg-gradient-to-br from-muted/50 to-muted/30 rounded-xl border border-border/40 hover:bg-muted/60 transition-all"
                  >
                    <span className="text-sm font-medium">Trade Details</span>
                    <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${!isPriceImpactCollapsed ? 'rotate-180' : ''}`} />
                  </Button>
                </CollapsibleTrigger>
                
                <CollapsibleContent className="mt-2">
                  <div className="bg-gradient-to-br from-muted/50 to-muted/30 rounded-xl p-4 space-y-3 border border-border/40 glass fade-in">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Exchange Rate</span>
                      <span className="font-medium">
                        1 {fromToken.symbol} = {(parseFloat(toAmount) / parseFloat(fromAmount)).toFixed(6)} {toToken.symbol}
                      </span>
                    </div>
                    {priceImpact !== null && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Price Impact</span>
                        <span className={`font-medium flex items-center gap-1 ${
                          priceImpact > 15 ? 'text-red-500' : 
                          priceImpact > 5 ? 'text-orange-500' : 
                          priceImpact > 2 ? 'text-yellow-500' : 
                          'text-green-500'
                        }`}>
                          {priceImpact > 5 && <AlertTriangle className="h-3 w-3" />}
                          {priceImpact.toFixed(2)}%
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Minimum Received</span>
                      <span className="font-medium">
                        {`${(parseFloat(toAmount) * (100 - slippage) / 100).toFixed(6)} ${toToken.symbol}`}
                      </span>
                    </div>
                    
                    {routeHops && routeHops.length > 0 && (
                      <div className="pt-3 border-t border-border/40 mt-3">
                        <PathVisualizer route={routeHops} />
                        
                        {/* Show V2 vs V3 comparison if both quotes available */}
                        {smartRoutingResult && smartRoutingResult.v2Quote && smartRoutingResult.v3Quote && (
                          <div className="mt-3 p-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                            <div className="flex items-center gap-2 text-xs">
                              <Zap className="h-3 w-3 text-blue-400" />
                              <span className="text-blue-400 font-medium">
                                Smart Routing: {smartRoutingResult.bestQuote.protocol} selected 
                                ({formatAmount(smartRoutingResult.bestQuote.outputAmount, toToken?.decimals || 18)} vs {formatAmount(
                                  smartRoutingResult.bestQuote.protocol === "V3" 
                                    ? smartRoutingResult.v2Quote.outputAmount 
                                    : smartRoutingResult.v3Quote.outputAmount,
                                  toToken?.decimals || 18
                                )})
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}

          {isConnected ? (
            <Button
              data-testid="button-swap"
              onClick={handleSwap}
              disabled={!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0 || isSwapping}
              className="w-full h-12 md:h-14 text-base md:text-lg font-semibold bg-gradient-to-r from-primary via-blue-500 to-blue-600 hover:from-primary/90 hover:via-blue-500/90 hover:to-blue-600/90 shadow-xl hover:shadow-2xl hover:shadow-primary/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 hover:scale-[1.02] relative overflow-hidden group"
            >
              <span className="relative z-10">{isSwapping ? "Swapping..." : "Swap"}</span>
              <span className="absolute inset-0 bg-gradient-to-r from-blue-600 to-primary opacity-0 group-hover:opacity-100 transition-opacity duration-300"></span>
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
        open={showFromSelector}
        onClose={() => setShowFromSelector(false)}
        onSelect={(token) => {
          setFromToken(token);
          setShowFromSelector(false);
        }}
        tokens={tokens}
        onImport={handleImportToken}
      />

      <TokenSelector
        open={showToSelector}
        onClose={() => setShowToSelector(false)}
        onSelect={(token) => {
          setToToken(token);
          setShowToSelector(false);
        }}
        tokens={tokens}
        onImport={handleImportToken}
      />

      <SwapSettings
        open={showSettings}
        onClose={() => setShowSettings(false)}
        slippage={slippage}
        onSlippageChange={setSlippage}
        deadline={deadline}
        onDeadlineChange={setDeadline}
        recipientAddress={recipientAddress}
        onRecipientAddressChange={setRecipientAddress}
        quoteRefreshInterval={quoteRefreshInterval}
        onQuoteRefreshIntervalChange={setQuoteRefreshInterval}
        v2Enabled={v2Enabled}
        v3Enabled={v3Enabled}
        onV2EnabledChange={setV2Enabled}
        onV3EnabledChange={setV3Enabled}
      />

      <TransactionHistory
        open={showTransactionHistory}
        onClose={() => setShowTransactionHistory(false)}
      />
    </div>
  );
}