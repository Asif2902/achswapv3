import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  ArrowDownUp, AlertTriangle, ExternalLink, ChevronDown, Bell, Zap, Settings,
} from "lucide-react";
import { TokenSelector } from "@/components/TokenSelector";
import { SwapSettings } from "@/components/SwapSettings";
import { TransactionHistory } from "@/components/TransactionHistory";
import { PathVisualizer, type RouteHop } from "@/components/PathVisualizer";
import { useAccount, useBalance, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, JsonRpcProvider, getAddress } from "ethers";
import { getTokensByChainId, isNativeToken, getWrappedAddress } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { getSmartRouteQuote, type SmartRoutingResult } from "@/lib/smart-routing";
import { loadDexSettings, saveDexSettings } from "@/lib/dex-settings";
import { getCachedQuote, setCachedQuote } from "@/lib/quote-cache";
import { getErrorForToast } from "@/lib/error-utils";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const WRAPPED_TOKEN_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

function fmtBal(raw: string): string {
  const n = parseFloat(raw);
  if (!n || isNaN(n)) return "0";
  if (n < 0.0001) return "<0.0001";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

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
  const [slippage, setSlippage] = useState(0.5);
  const [deadline, setDeadline] = useState(20);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [priceImpact, setPriceImpact] = useState<number | null>(null);
  const [quoteRefreshInterval, setQuoteRefreshInterval] = useState(30);
  const [showTransactionHistory, setShowTransactionHistory] = useState(false);
  const [tradeDetailsOpen, setTradeDetailsOpen] = useState(false);

  const [smartRoutingResult, setSmartRoutingResult] = useState<SmartRoutingResult | null>(null);
  const [routeHops, setRouteHops] = useState<RouteHop[]>([]);
  const [v2Enabled, setV2Enabled] = useState(true);
  const [v3Enabled, setV3Enabled] = useState(true);

  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  const contracts = chainId ? getContractsForChain(chainId) : null;

  useEffect(() => { const s = loadDexSettings(); setV2Enabled(s.v2Enabled); setV3Enabled(s.v3Enabled); }, []);
  useEffect(() => { saveDexSettings({ v2Enabled, v3Enabled }); }, [v2Enabled, v3Enabled]);

  const openExplorer = (txHash: string) => { if (contracts) window.open(`${contracts.explorer}${txHash}`, "_blank"); };

  useEffect(() => { loadTokens(); }, [chainId]);

  useEffect(() => {
    if (!tokens.length || !chainId) return;
    if (!fromToken || fromToken.chainId !== chainId) { const t = tokens.find(t => t.symbol === "USDC"); if (t) setFromToken(t); }
    if (!toToken || toToken.chainId !== chainId) { const t = tokens.find(t => t.symbol === "ACHS"); if (t) setToToken(t); }
  }, [tokens, fromToken, toToken, chainId]);

  const loadTokens = async () => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    const imported: Token[] = JSON.parse(localStorage.getItem("importedTokens") || "[]");
    const process = (arr: Token[]) =>
      arr.filter(t => !chainId || t.chainId === chainId).map(t => ({ ...t, logoURI: t.logoURI || "/img/logos/unknown-token.png" }));
    setTokens([...process(chainTokens), ...process(imported)]);
  };

  const handleImportToken = async (addr: string): Promise<Token | null> => {
    try {
      if (!addr || addr.length !== 42 || !addr.startsWith("0x")) throw new Error("Invalid token address format");
      const exists = tokens.find(t => t.address.toLowerCase() === addr.toLowerCase());
      if (exists) { toast({ title: "Token already added", description: `${exists.symbol} is already in your list` }); return exists; }
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const r = await fetch("https://rpc.testnet.arc.network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          const d = await r.json(); if (d.error) throw new Error(d.error.message); return d.result;
        },
      });
      const contract = new Contract(addr, ERC20_ABI, provider);
      const [name, symbol, decimals] = await Promise.race([
        Promise.all([contract.name(), contract.symbol(), contract.decimals()]),
        new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 10000)),
      ]) as [string, string, bigint];
      if (!chainId) throw new Error("Chain ID not available");
      const newToken: Token = { address: addr, name, symbol, decimals: Number(decimals), logoURI: "/img/logos/unknown-token.png", verified: false, chainId };
      const imported: Token[] = JSON.parse(localStorage.getItem("importedTokens") || "[]");
      if (!imported.find(t => t.address.toLowerCase() === addr.toLowerCase())) { imported.push(newToken); localStorage.setItem("importedTokens", JSON.stringify(imported)); }
      setTokens(prev => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} added to your list` });
      return newToken;
    } catch (error: any) {
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" });
      return null;
    }
  };

  // ── Quote fetching ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
    if (abortControllerRef.current) abortControllerRef.current.abort();
    debounceTimeoutRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      fetchQuote(controller.signal);
    }, 300);
    return () => {
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, [fromAmount, fromToken, toToken, tokens, contracts, chainId, v2Enabled, v3Enabled]);

  const fetchQuote = async (signal: AbortSignal) => {
    if (!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0) {
      setToAmount(""); setPriceImpact(null); return;
    }
    const isWrap = fromToken.symbol === "USDC" && toToken.symbol === "wUSDC";
    const isUnwrap = fromToken.symbol === "wUSDC" && toToken.symbol === "USDC";
    if (isWrap || isUnwrap) {
      setToAmount(fromAmount); setPriceImpact(0);
      setRouteHops([{ tokenIn: fromToken, tokenOut: toToken, protocol: "V2" }]); return;
    }
    if (!contracts) return;
    setIsLoadingQuote(true);
    let provider;
    try {
      if (window.ethereum) {
        provider = new BrowserProvider(window.ethereum);
      } else {
        provider = new JsonRpcProvider("https://rpc.testnet.arc.network");
      }
      const wrappedTokenData = tokens.find(t => t.symbol === "wUSDC");
      if (!wrappedTokenData) throw new Error("wUSDC not found");
      const amountIn = parseAmount(fromAmount, fromToken.decimals);
      if (!v2Enabled && !v3Enabled) {
        toast({ title: "No protocols enabled", description: "Enable at least one in settings", variant: "destructive" });
        setToAmount(""); setPriceImpact(null); setRouteHops([]); return;
      }
      if (signal.aborted) return;
      const cached = getCachedQuote(fromToken.address, toToken.address, fromAmount, v2Enabled, v3Enabled);
      let result: SmartRoutingResult | null;
      if (cached) { result = cached; }
      else {
        result = await getSmartRouteQuote(provider, contracts.v2.router, contracts.v3.quoter02, fromToken, toToken, amountIn, wrappedTokenData.address, v2Enabled, v3Enabled);
        if (signal.aborted) return;
        if (result) setCachedQuote(fromToken.address, toToken.address, fromAmount, v2Enabled, v3Enabled, result);
      }
      if (!result?.bestQuote) { setToAmount(""); setPriceImpact(null); setRouteHops([]); return; }
      setSmartRoutingResult(result);
      setToAmount(formatAmount(result.bestQuote.outputAmount, toToken.decimals));
      setPriceImpact(result.bestQuote.priceImpact);
      setRouteHops(result.bestQuote.route);
    } catch { if (signal.aborted) return; setToAmount(""); setPriceImpact(null); setRouteHops([]); setSmartRoutingResult(null); }
    finally { if (!signal.aborted) setIsLoadingQuote(false); }
  };

  const handleSwapTokens = () => {
    setFromToken(toToken); setToToken(fromToken);
    setFromAmount(""); setToAmount(""); setSmartRoutingResult(null);
  };

  // ── Wrap / Unwrap ──────────────────────────────────────────────────────────
  const nativeToken = tokens.find(t => t.symbol === "USDC");
  const wrappedToken = tokens.find(t => t.symbol === "wUSDC");

  const handleWrap = async (amount: string) => {
    if (!address || !window.ethereum || !wrappedToken || !nativeToken) return;
    setIsSwapping(true);
    try {
      const provider = new BrowserProvider(window.ethereum); const signer = await provider.getSigner();
      const amountBigInt = parseAmount(amount, wrappedToken.decimals);
      const wc = new Contract(wrappedToken.address, WRAPPED_TOKEN_ABI, signer);
      toast({ title: "Wrapping…" });
      const g = await wc.deposit.estimateGas({ value: amountBigInt });
      const receipt = await (await wc.deposit({ value: amountBigInt, gasLimit: g * 150n / 100n })).wait();
      await Promise.all([refetchFromBalance(), refetchToBalance()]);
      setFromAmount(""); setToAmount("");
      toast({ title: "Wrap successful!", description: (<div className="flex items-center gap-2"><span>Wrapped {amount} USDC → wUSDC</span><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(receipt.hash)}><ExternalLink className="h-3 w-3" /></Button></div>) });
    } catch (error: any) { 
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" }); 
    }
    finally { setIsSwapping(false); }
  };

  const handleUnwrap = async (amount: string) => {
    if (!address || !window.ethereum || !wrappedToken || !nativeToken) return;
    setIsSwapping(true);
    try {
      const provider = new BrowserProvider(window.ethereum); const signer = await provider.getSigner();
      const amountBigInt = parseAmount(amount, wrappedToken.decimals);
      const wc = new Contract(wrappedToken.address, WRAPPED_TOKEN_ABI, signer);
      toast({ title: "Unwrapping…" });
      const g = await wc.withdraw.estimateGas(amountBigInt);
      const receipt = await (await wc.withdraw(amountBigInt, { gasLimit: g * 150n / 100n })).wait();
      await Promise.all([refetchFromBalance(), refetchToBalance()]);
      setFromAmount(""); setToAmount("");
      toast({ title: "Unwrap successful!", description: (<div className="flex items-center gap-2"><span>Unwrapped {amount} wUSDC → USDC</span><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(receipt.hash)}><ExternalLink className="h-3 w-3" /></Button></div>) });
    } catch (error: any) { 
      const errorInfo = getErrorForToast(error);
      toast({ title: errorInfo.title, description: errorInfo.description, rawError: errorInfo.rawError, variant: "destructive" }); 
    }
    finally { setIsSwapping(false); }
  };

  const saveTransaction = (from: Token, to: Token, fromAmt: string, toAmt: string, txHash: string) => {
    const key = `transactions_${chainId}`;
    const txs = JSON.parse(localStorage.getItem(key) || "[]");
    txs.unshift({ id: txHash, fromToken: from, toToken: to, fromAmount: fromAmt, toAmount: toAmt, timestamp: Date.now(), chainId });
    if (txs.length > 50) txs.pop();
    localStorage.setItem(key, JSON.stringify(txs));
  };

  // ── Main swap ──────────────────────────────────────────────────────────────
  const handleSwap = async () => {
    if (!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0) return;
    if (fromToken.symbol === "USDC" && toToken.symbol === "wUSDC") { await handleWrap(fromAmount); return; }
    if (fromToken.symbol === "wUSDC" && toToken.symbol === "USDC") { await handleUnwrap(fromAmount); return; }
    setIsSwapping(true);
    try {
      if (!address || !window.ethereum) throw new Error("Please connect your wallet");
      if (!contracts) throw new Error("Chain contracts not configured");
      if (!smartRoutingResult?.bestQuote) throw new Error("No valid quote available");
      if (Date.now() - (smartRoutingResult.timestamp || 0) > 30000) {
        toast({ title: "Stale quote", description: "Price may have changed. Please wait for a fresh quote.", variant: "destructive" });
        setIsSwapping(false); return;
      }
      const provider = new BrowserProvider(window.ethereum); const signer = await provider.getSigner();
      const bestQuote = smartRoutingResult.bestQuote;
      const amountIn = parseAmount(fromAmount, fromToken.decimals);
      const slippageBps = BigInt(Math.floor(slippage * 100));
      const minAmountOut = (bestQuote.outputAmount * (10000n - slippageBps)) / 10000n;
      const deadlineTimestamp = Math.floor(Date.now() / 1000) + deadline * 60;
      let recipient: string = address ?? "0x0000000000000000000000000000000000000000";
      if (recipientAddress) {
        try {
          const normalizedAddress = getAddress(recipientAddress);
          if (normalizedAddress === "0x0000000000000000000000000000000000000000") {
            throw new Error("Recipient cannot be zero address");
          }
          recipient = normalizedAddress;
        } catch (error) {
          throw new Error("Invalid recipient address format");
        }
      }
      const executeWithRetry = async <T,>(fn: () => Promise<T>, maxRetries = 2): Promise<T> => {
        let last: any;
        for (let i = 0; i <= maxRetries; i++) {
          try { return await fn(); } catch (e: any) { last = e; if (i < maxRetries) await new Promise(r => setTimeout(r, 500 * (i + 1))); }
        }
        throw last;
      };
      toast({ title: "Swapping…", description: `Using ${bestQuote.protocol} protocol` });
      let tx: any;

      if (bestQuote.protocol === "V3") {
        const swapRouter = new Contract(contracts.v3.swapRouter, SWAP_ROUTER_V3_ABI, signer);
        const fromNative = isNativeToken(fromToken.address);
        const toNative = isNativeToken(toToken.address);
        const wrappedAddr = getWrappedAddress(chainId, "0x0000000000000000000000000000000000000000");
        if (!wrappedAddr) throw new Error("No wrapped token configured");
        const fromERC20 = fromNative ? wrappedAddr : fromToken.address;
        const toERC20 = toNative ? wrappedAddr : toToken.address;

        // Approve input token if not native
        if (!fromNative) {
          const tc = new Contract(fromERC20, ERC20_ABI, signer);
          if (await tc.allowance(address, contracts.v3.swapRouter) < amountIn) {
            toast({ title: "Approval needed" });
            const ag = await tc.approve.estimateGas(contracts.v3.swapRouter, amountIn);
            await (await tc.approve(contracts.v3.swapRouter, amountIn, { gasLimit: ag * 150n / 100n })).wait();
          }
        }

        const calls: string[] = [];
        const totalValue = fromNative ? amountIn : 0n;

        if (bestQuote.route.length === 1) {
          // ─────────────────────────────────────────────────────────────────
          // FIX: When the output is native (toNative), the swap must send
          // wrapped tokens to the ROUTER (not the user) so that the
          // subsequent unwrapWETH9 call can pull them out and forward ETH
          // to the user. Sending directly to the user leaves the router
          // with nothing to unwrap → "insufficient weth9" revert.
          // ─────────────────────────────────────────────────────────────────
          const swapRecipient = toNative ? contracts.v3.swapRouter : recipient;

          calls.push(swapRouter.interface.encodeFunctionData("exactInputSingle", [{
            tokenIn: fromERC20,
            tokenOut: toERC20,
            fee: bestQuote.route[0].fee || 3000,
            recipient: swapRecipient,
            deadline: deadlineTimestamp,
            amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0n,
          }]));

          if (toNative) {
            calls.push(swapRouter.interface.encodeFunctionData("unwrapWETH9", [minAmountOut, recipient]));
          }

          try {
            tx = await executeWithRetry(async () => {
              const g = await swapRouter.multicall.estimateGas(calls, { value: totalValue });
              return swapRouter.multicall(calls, { gasLimit: g * 150n / 100n, value: totalValue });
            });
          } catch (v3Err: any) {
            const altQ = smartRoutingResult.alternativeQuotes?.find(q => q.protocol === "V2");
            if (altQ) {
              toast({ title: "Falling back to V2", description: "V3 failed, trying V2…" });
              const V2_ABI = [
                "function swapExactTokensForTokens(uint,uint,address[],address,uint) external returns (uint[])",
                "function swapExactETHForTokens(uint,address[],address,uint) external payable returns (uint[])",
                "function swapExactTokensForETH(uint,uint,address[],address,uint) external returns (uint[])",
              ];
              const router = new Contract(contracts.v2.router, V2_ABI, signer);
              const path: string[] = [];
              for (let i = 0; i < altQ.route.length; i++) {
                const hop = altQ.route[i];
                if (i === 0) path.push(isNativeToken(hop.tokenIn.address) ? wrappedAddr : hop.tokenIn.address);
                const o = isNativeToken(hop.tokenOut.address) ? wrappedAddr : hop.tokenOut.address;
                if (o !== path[path.length - 1]) path.push(o);
              }
              const altMin = (altQ.outputAmount * (10000n - slippageBps)) / 10000n;

              if (fromNative) {
                const g = await router.swapExactETHForTokens.estimateGas(altMin, path, recipient, deadlineTimestamp, { value: amountIn });
                tx = await router.swapExactETHForTokens(altMin, path, recipient, deadlineTimestamp, { value: amountIn, gasLimit: g * 150n / 100n });
              } else if (toNative) {
                // Ensure approval for V2 router
                const tc = new Contract(fromERC20, ERC20_ABI, signer);
                if (await tc.allowance(address, contracts.v2.router) < amountIn) {
                  const ag = await tc.approve.estimateGas(contracts.v2.router, amountIn);
                  await (await tc.approve(contracts.v2.router, amountIn, { gasLimit: ag * 150n / 100n })).wait();
                }
                const g = await router.swapExactTokensForETH.estimateGas(amountIn, altMin, path, recipient, deadlineTimestamp);
                tx = await router.swapExactTokensForETH(amountIn, altMin, path, recipient, deadlineTimestamp, { gasLimit: g * 150n / 100n });
              } else {
                const g = await router.swapExactTokensForTokens.estimateGas(amountIn, altMin, path, recipient, deadlineTimestamp);
                tx = await router.swapExactTokensForTokens(amountIn, altMin, path, recipient, deadlineTimestamp, { gasLimit: g * 150n / 100n });
              }
            } else throw v3Err;
          }
        } else {
          // Multi-hop V3 path
          const { encodePath } = await import("@/lib/v3-utils");
          const tks: string[] = [fromERC20];
          const fees: number[] = [];
          for (const hop of bestQuote.route) {
            const o = isNativeToken(hop.tokenOut.address) ? wrappedAddr : hop.tokenOut.address;
            if (o !== tks[tks.length - 1]) { tks.push(o); fees.push(hop.fee || 3000); }
          }

          // ─────────────────────────────────────────────────────────────────
          // FIX (multi-hop): Same as single-hop — when toNative, direct
          // output to the router so unwrapWETH9 can forward ETH to user.
          // ─────────────────────────────────────────────────────────────────
          const swapRecipient = toNative ? contracts.v3.swapRouter : recipient;

          calls.push(swapRouter.interface.encodeFunctionData("exactInput", [{
            path: encodePath(tks, fees),
            recipient: swapRecipient,
            deadline: deadlineTimestamp,
            amountIn,
            amountOutMinimum: minAmountOut,
          }]));

          if (toNative) {
            calls.push(swapRouter.interface.encodeFunctionData("unwrapWETH9", [minAmountOut, recipient]));
          }

          const g = await swapRouter.multicall.estimateGas(calls, { value: totalValue });
          tx = await swapRouter.multicall(calls, { gasLimit: g * 150n / 100n, value: totalValue });
        }
      } else {
        // ── V2 path ────────────────────────────────────────────────────────
        const V2_ABI = [
          "function swapExactTokensForTokens(uint,uint,address[],address,uint) external returns (uint[])",
          "function swapExactETHForTokens(uint,address[],address,uint) external payable returns (uint[])",
          "function swapExactTokensForETH(uint,uint,address[],address,uint) external returns (uint[])",
        ];
        const router = new Contract(contracts.v2.router, V2_ABI, signer);
        const fromNative = isNativeToken(fromToken.address);
        const toNative = isNativeToken(toToken.address);
        const wrappedAddr = getWrappedAddress(chainId, "0x0000000000000000000000000000000000000000");
        if (!wrappedAddr) throw new Error("Wrapped token address not found");
        const path: string[] = [];
        for (let i = 0; i < bestQuote.route.length; i++) {
          const hop = bestQuote.route[i];
          if (i === 0) path.push(isNativeToken(hop.tokenIn.address) ? wrappedAddr : hop.tokenIn.address);
          const o = isNativeToken(hop.tokenOut.address) ? wrappedAddr : hop.tokenOut.address;
          if (o !== path[path.length - 1]) path.push(o);
        }
        if (fromNative) {
          const g = await router.swapExactETHForTokens.estimateGas(minAmountOut, path, recipient, deadlineTimestamp, { value: amountIn });
          tx = await router.swapExactETHForTokens(minAmountOut, path, recipient, deadlineTimestamp, { value: amountIn, gasLimit: g * 150n / 100n });
        } else if (toNative) {
          const tc = new Contract(fromToken.address, ERC20_ABI, signer);
          if (await tc.allowance(address, contracts.v2.router) < amountIn) { const ag = await tc.approve.estimateGas(contracts.v2.router, amountIn); await (await tc.approve(contracts.v2.router, amountIn, { gasLimit: ag * 150n / 100n })).wait(); }
          const g = await router.swapExactTokensForETH.estimateGas(amountIn, minAmountOut, path, recipient, deadlineTimestamp);
          tx = await router.swapExactTokensForETH(amountIn, minAmountOut, path, recipient, deadlineTimestamp, { gasLimit: g * 150n / 100n });
        } else {
          const tc = new Contract(fromToken.address, ERC20_ABI, signer);
          if (await tc.allowance(address, contracts.v2.router) < amountIn) { const ag = await tc.approve.estimateGas(contracts.v2.router, amountIn); await (await tc.approve(contracts.v2.router, amountIn, { gasLimit: ag * 150n / 100n })).wait(); }
          const g = await router.swapExactTokensForTokens.estimateGas(amountIn, minAmountOut, path, recipient, deadlineTimestamp);
          tx = await router.swapExactTokensForTokens(amountIn, minAmountOut, path, recipient, deadlineTimestamp, { gasLimit: g * 150n / 100n });
        }
      }

      const receipt = await tx.wait();
      saveTransaction(fromToken, toToken, fromAmount, toAmount, receipt.hash);
      await Promise.all([refetchFromBalance(), refetchToBalance()]);
      setFromAmount(""); setToAmount(""); setSmartRoutingResult(null); setRouteHops([]);
      toast({
        title: "Swap successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Swapped {fromAmount} {fromToken.symbol} → {toAmount} {toToken.symbol} via {bestQuote.protocol}</span>
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openExplorer(receipt.hash)}><ExternalLink className="h-3 w-3" /></Button>
          </div>
        ),
      });
    } catch (error: any) {
      const errorInfo = getErrorForToast(error);
      toast({ 
        title: errorInfo.title, 
        description: errorInfo.description, 
        rawError: errorInfo.rawError,
        variant: "destructive" 
      });
    } finally { setIsSwapping(false); }
  };

  // ── Balances ───────────────────────────────────────────────────────────────
  const isFromNative = fromToken?.address === "0x0000000000000000000000000000000000000000";
  const isToNative = toToken?.address === "0x0000000000000000000000000000000000000000";

  const { data: fromBalance, refetch: refetchFromBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    ...(fromToken && !isFromNative ? { token: fromToken.address as `0x${string}` } : {}),
  });
  const { data: toBalance, refetch: refetchToBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    ...(toToken && !isToNative ? { token: toToken.address as `0x${string}` } : {}),
  });

  useEffect(() => {
    if (!isConnected || !fromToken || !toToken) return;
    refetchFromBalance(); refetchToBalance();
  }, [isConnected, fromToken?.address, toToken?.address]);

  useEffect(() => {
    if (!isConnected) return;
    const id = setInterval(() => { refetchFromBalance(); refetchToBalance(); }, 30000);
    return () => clearInterval(id);
  }, [isConnected, refetchFromBalance, refetchToBalance]);

  let fromBalFmt = "0.00", toBalFmt = "0.00";
  try { if (fromBalance) fromBalFmt = fmtBal(formatAmount(fromBalance.value, fromBalance.decimals)); } catch { /* ignore */ }
  try { if (toBalance) toBalFmt = fmtBal(formatAmount(toBalance.value, toBalance.decimals)); } catch { /* ignore */ }

  // ── Derived ────────────────────────────────────────────────────────────────
  const hasTradeInfo = !!(fromToken && toToken && fromAmount && toAmount && parseFloat(fromAmount) > 0 && parseFloat(toAmount) > 0);
  const impactColor = priceImpact === null ? "" : priceImpact > 15 ? "#f87171" : priceImpact > 5 ? "#fb923c" : priceImpact > 2 ? "#fbbf24" : "#4ade80";
  const canSwap = !!(isConnected && fromToken && toToken && fromAmount && parseFloat(fromAmount) > 0 && !isSwapping);
  const protocolLabel = smartRoutingResult?.bestQuote?.protocol;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        .sw-wrap { display:flex; flex-direction:column; align-items:center; padding:28px 16px 56px; box-sizing:border-box; }
        .sw-inner { width:100%; max-width:436px; }

        .sw-title { text-align:center; margin-bottom:24px; }
        .sw-title h1 { font-size:clamp(20px,5vw,28px); font-weight:800; margin:0 0 5px; letter-spacing:-0.02em; background:linear-gradient(135deg,#e2e8f0,#a5b4fc); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
        .sw-title p { font-size:13px; color:rgba(255,255,255,0.3); margin:0; }

        .sw-shell { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:24px; overflow:hidden; }

        /* header */
        .sw-hdr { display:flex; align-items:center; justify-content:space-between; padding:15px 20px; border-bottom:1px solid rgba(255,255,255,0.06); }
        .sw-hdr-left { display:flex; align-items:center; gap:10px; }
        .sw-hdr-dot { width:8px; height:8px; border-radius:50%; background:linear-gradient(135deg,#6366f1,#818cf8); box-shadow:0 0 8px rgba(99,102,241,0.6); }
        .sw-hdr-title { font-size:16px; font-weight:800; color:white; letter-spacing:-0.01em; }
        .sw-hdr-btns { display:flex; align-items:center; gap:7px; }
        .sw-hdr-btn { width:34px; height:34px; border-radius:10px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.04); color:rgba(255,255,255,0.45); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all 0.2s; }
        .sw-hdr-btn:hover { background:rgba(255,255,255,0.1); color:rgba(255,255,255,0.85); border-color:rgba(255,255,255,0.16); }

        /* body */
        .sw-body { padding:16px; display:flex; flex-direction:column; gap:4px; }

        /* token box */
        .sw-box { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:18px; padding:14px 16px; transition:border-color 0.2s,background 0.2s; }
        .sw-box:focus-within { border-color:rgba(99,102,241,0.5); background:rgba(99,102,241,0.035); }
        .sw-box.to-box { background:rgba(0,0,0,0.12); }
        .sw-box.to-box:focus-within { border-color:rgba(99,102,241,0.28); }

        .sw-box-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
        .sw-box-label { font-size:11px; font-weight:700; color:rgba(255,255,255,0.28); text-transform:uppercase; letter-spacing:0.08em; }
        .sw-bal { font-size:11px; color:rgba(255,255,255,0.28); }
        .sw-bal-val { color:rgba(255,255,255,0.6); font-weight:600; cursor:pointer; }
        .sw-bal-val:hover { color:#a5b4fc; }

        .sw-row { display:flex; align-items:center; gap:12px; }
        .sw-amount-input { background:transparent; border:none; outline:none; color:white; font-size:clamp(22px,6vw,30px); font-weight:700; flex:1; min-width:0; font-variant-numeric:tabular-nums; }
        .sw-amount-input::placeholder { color:rgba(255,255,255,0.16); }
        .sw-amount-input:disabled { opacity:0.5; cursor:not-allowed; }
        .sw-amount-input[type=number]::-webkit-outer-spin-button,
        .sw-amount-input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; }

        .sw-token-col { display:flex; flex-direction:column; align-items:flex-end; gap:7px; flex-shrink:0; }
        .sw-token-btn { display:flex; align-items:center; gap:8px; padding:8px 13px; border-radius:12px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:white; font-weight:700; font-size:14px; cursor:pointer; transition:all 0.2s; white-space:nowrap; }
        .sw-token-btn:hover { background:rgba(99,102,241,0.18); border-color:rgba(99,102,241,0.4); }
        .sw-token-btn.empty { background:linear-gradient(135deg,rgba(99,102,241,0.22),rgba(139,92,246,0.18)); border-color:rgba(99,102,241,0.4); color:#a5b4fc; }
        .sw-max-btn { font-size:11px; font-weight:700; letter-spacing:0.05em; padding:3px 10px; border-radius:8px; background:rgba(99,102,241,0.14); border:1px solid rgba(99,102,241,0.3); color:#a5b4fc; cursor:pointer; transition:all 0.2s; }
        .sw-max-btn:hover { background:rgba(99,102,241,0.28); border-color:rgba(99,102,241,0.55); }

        @keyframes sw-shimmer { 0%,100%{opacity:0.25}50%{opacity:0.55} }
        .sw-loading-text { font-size:clamp(22px,6vw,30px); font-weight:700; color:rgba(255,255,255,0.35); animation:sw-shimmer 1.4s ease-in-out infinite; }

        /* direction ring */
        .sw-dir-wrap { display:flex; align-items:center; justify-content:center; height:0; position:relative; z-index:10; }
        .sw-dir-btn { width:40px; height:40px; border-radius:50%; background:rgba(99,102,241,0.15); border:3px solid rgba(99,102,241,0.2); color:#818cf8; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all 0.35s cubic-bezier(.4,0,.2,1); margin-top:-20px; margin-bottom:-20px; box-shadow:0 2px 14px rgba(0,0,0,0.35); }
        .sw-dir-btn:hover:not(:disabled) { background:rgba(99,102,241,0.35); border-color:rgba(99,102,241,0.55); color:#c7d2fe; transform:rotate(180deg); box-shadow:0 4px 20px rgba(99,102,241,0.35); }
        .sw-dir-btn:disabled { opacity:0.3; cursor:not-allowed; }

        /* high impact */
        .sw-impact-warn { display:flex; align-items:flex-start; gap:10px; padding:11px 14px; border-radius:14px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.22); margin-top:12px; }

        /* trade details */
        .sw-details-trigger { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-radius:14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); cursor:pointer; transition:background 0.2s; margin-top:12px; }
        .sw-details-trigger:hover { background:rgba(255,255,255,0.06); }
        .sw-details-panel { margin-top:6px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:14px; overflow:hidden; }
        .sw-detail-row { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; }
        .sw-detail-row + .sw-detail-row { border-top:1px solid rgba(255,255,255,0.05); }
        .sw-detail-label { font-size:12px; color:rgba(255,255,255,0.33); }
        .sw-detail-val { font-size:12px; font-weight:600; color:rgba(255,255,255,0.85); font-variant-numeric:tabular-nums; display:flex; align-items:center; gap:5px; }
        .sw-route-section { padding:10px 14px; border-top:1px solid rgba(255,255,255,0.05); }
        .sw-routing-note { display:flex; align-items:center; gap:7px; padding:9px 12px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.18); border-radius:11px; margin:10px 14px 12px; }

        .sw-proto { display:inline-flex; align-items:center; padding:2px 8px; border-radius:8px; font-size:10px; font-weight:800; letter-spacing:0.04em; text-transform:uppercase; }
        .sw-proto-v2 { background:rgba(99,102,241,0.14); color:#818cf8; border:1px solid rgba(99,102,241,0.25); }
        .sw-proto-v3 { background:rgba(139,92,246,0.14); color:#c4b5fd; border:1px solid rgba(139,92,246,0.25); }

        /* submit */
        .sw-submit { width:100%; height:52px; border-radius:16px; font-weight:800; font-size:16px; letter-spacing:0.02em; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:9px; transition:all 0.22s; margin-top:14px; }
        .sw-submit.active { background:linear-gradient(135deg,#6366f1,#3b82f6); color:white; box-shadow:0 4px 24px rgba(99,102,241,0.38); }
        .sw-submit.active:hover { background:linear-gradient(135deg,#4f46e5,#2563eb); box-shadow:0 6px 32px rgba(99,102,241,0.52); transform:translateY(-1px); }
        .sw-submit.loading { background:rgba(99,102,241,0.28); color:rgba(255,255,255,0.5); cursor:not-allowed; }
        .sw-submit.off { background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.24); cursor:not-allowed; }

        @keyframes sw-spin { to{transform:rotate(360deg)} }
        .sw-spin { animation:sw-spin 1s linear infinite; display:inline-block; width:18px; height:18px; border:2.5px solid rgba(255,255,255,0.2); border-top-color:white; border-radius:50%; }

        @media (max-width:400px) { .sw-body{padding:12px;} .sw-box{padding:12px 14px;} .sw-hdr{padding:13px 16px;} }
      `}</style>

      <div className="sw-wrap">
        <div className="sw-inner">

          <div className="sw-title">
            <h1>Swap Tokens</h1>
            <p>Best rate · Smart routing · V2 &amp; V3</p>
          </div>

          <div className="sw-shell">

            {/* Header */}
            <div className="sw-hdr">
              <div className="sw-hdr-left">
                <span className="sw-hdr-dot" />
                <span className="sw-hdr-title">Swap</span>
              </div>
              <div className="sw-hdr-btns">
                <button className="sw-hdr-btn" data-testid="button-transaction-history" onClick={() => setShowTransactionHistory(true)} title="Transaction history">
                  <Bell style={{ width: 15, height: 15 }} />
                </button>
                <button className="sw-hdr-btn" data-testid="button-settings" onClick={() => setShowSettings(true)} title="Settings">
                  <Settings style={{ width: 15, height: 15 }} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="sw-body">

              {/* FROM box */}
              <div className="sw-box">
                <div className="sw-box-top">
                  <span className="sw-box-label">From</span>
                  {isConnected && fromToken && (
                    <span className="sw-bal">
                      Balance:{" "}
                      <span className="sw-bal-val" onClick={() => fromBalance && setFromAmount(formatAmount(fromBalance.value, fromBalance.decimals))}>
                        {fromBalFmt}
                      </span>
                    </span>
                  )}
                </div>
                <div className="sw-row">
                  <input
                    data-testid="input-from-amount"
                    type="number" placeholder="0.00" value={fromAmount}
                    onChange={e => setFromAmount(e.target.value)}
                    className="sw-amount-input"
                  />
                  <div className="sw-token-col">
                    <button data-testid="button-select-from-token" onClick={() => setShowFromSelector(true)} className={`sw-token-btn ${!fromToken ? "empty" : ""}`}>
                      {fromToken ? (
                        <>
                          <img src={fromToken.logoURI} alt={fromToken.symbol} style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.14)" }} onError={e => { e.currentTarget.style.display = "none"; }} />
                          <span>{fromToken.symbol}</span>
                        </>
                      ) : <span>Select</span>}
                    </button>
                    {isConnected && fromBalance && fromToken && (
                      <button data-testid="button-max-from" className="sw-max-btn" onClick={() => setFromAmount(formatAmount(fromBalance.value, fromBalance.decimals))}>MAX</button>
                    )}
                  </div>
                </div>
              </div>

              {/* Direction ring */}
              <div className="sw-dir-wrap">
                <button data-testid="button-swap-direction" className="sw-dir-btn" onClick={handleSwapTokens} disabled={!fromToken || !toToken}>
                  <ArrowDownUp style={{ width: 16, height: 16 }} />
                </button>
              </div>

              {/* TO box */}
              <div className="sw-box to-box">
                <div className="sw-box-top">
                  <span className="sw-box-label">To</span>
                  {isConnected && toToken && (
                    <span className="sw-bal">Balance: <span style={{ color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>{toBalFmt}</span></span>
                  )}
                </div>
                <div className="sw-row">
                  {isLoadingQuote ? (
                    <span className="sw-loading-text">Calculating…</span>
                  ) : (
                    <input
                      data-testid="input-to-amount"
                      type="number" placeholder="0.00" value={toAmount}
                      onChange={e => setToAmount(e.target.value)}
                      disabled className="sw-amount-input"
                    />
                  )}
                  <div className="sw-token-col">
                    <button data-testid="button-select-to-token" onClick={() => setShowToSelector(true)} className={`sw-token-btn ${!toToken ? "empty" : ""}`}>
                      {toToken ? (
                        <>
                          <img src={toToken.logoURI} alt={toToken.symbol} style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.14)" }} onError={e => { e.currentTarget.style.display = "none"; }} />
                          <span>{toToken.symbol}</span>
                        </>
                      ) : <span>Select</span>}
                    </button>
                  </div>
                </div>
              </div>

              {/* High impact warning */}
              {hasTradeInfo && priceImpact !== null && priceImpact > 15 && (
                <div className="sw-impact-warn">
                  <AlertTriangle style={{ width: 15, height: 15, color: "#f87171", flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "#f87171", margin: 0 }}>High Price Impact — {priceImpact.toFixed(2)}%</p>
                    <p style={{ fontSize: 11, color: "rgba(248,113,113,0.65)", margin: "3px 0 0", lineHeight: 1.5 }}>You may receive significantly less than expected.</p>
                  </div>
                </div>
              )}

              {/* Trade details */}
              {hasTradeInfo && (
                <>
                  <div className="sw-details-trigger" onClick={() => setTradeDetailsOpen(o => !o)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.45)" }}>
                        1 {fromToken!.symbol} = {(parseFloat(toAmount) / parseFloat(fromAmount)).toFixed(6)} {toToken!.symbol}
                      </span>
                      {protocolLabel && (
                        <span className={`sw-proto ${protocolLabel === "V3" ? "sw-proto-v3" : "sw-proto-v2"}`}>{protocolLabel}</span>
                      )}
                    </div>
                    <ChevronDown style={{ width: 15, height: 15, color: "rgba(255,255,255,0.3)", transform: tradeDetailsOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
                  </div>

                  {tradeDetailsOpen && (
                    <div className="sw-details-panel">
                      <div className="sw-detail-row">
                        <span className="sw-detail-label">Exchange Rate</span>
                        <span className="sw-detail-val">1 {fromToken!.symbol} = {(parseFloat(toAmount) / parseFloat(fromAmount)).toFixed(6)} {toToken!.symbol}</span>
                      </div>
                      {priceImpact !== null && (
                        <div className="sw-detail-row">
                          <span className="sw-detail-label">Price Impact</span>
                          <span className="sw-detail-val" style={{ color: impactColor }}>
                            {priceImpact > 5 && <AlertTriangle style={{ width: 12, height: 12 }} />}
                            {priceImpact.toFixed(2)}%
                          </span>
                        </div>
                      )}
                      <div className="sw-detail-row">
                        <span className="sw-detail-label">Minimum Received</span>
                        <span className="sw-detail-val">{(parseFloat(toAmount) * (100 - slippage) / 100).toFixed(6)} {toToken!.symbol}</span>
                      </div>
                      <div className="sw-detail-row">
                        <span className="sw-detail-label">Slippage</span>
                        <span className="sw-detail-val">{slippage}%</span>
                      </div>
                      {routeHops.length > 0 && (
                        <div className="sw-route-section"><PathVisualizer route={routeHops} /></div>
                      )}
                      {smartRoutingResult?.v2Quote && smartRoutingResult?.v3Quote && (
                        <div className="sw-routing-note">
                          <Zap style={{ width: 13, height: 13, color: "#818cf8", flexShrink: 0 }} />
                          <span style={{ fontSize: 11, color: "#a5b4fc", fontWeight: 600 }}>
                            Smart Routing: {smartRoutingResult.bestQuote.protocol} selected (
                            {formatAmount(smartRoutingResult.bestQuote.outputAmount, toToken?.decimals || 18)} vs{" "}
                            {formatAmount(
                              smartRoutingResult.bestQuote.protocol === "V3"
                                ? smartRoutingResult.v2Quote.outputAmount
                                : smartRoutingResult.v3Quote.outputAmount,
                              toToken?.decimals || 18
                            )})
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Submit */}
              {isConnected ? (
                <button data-testid="button-swap" onClick={handleSwap} disabled={!canSwap} className={`sw-submit ${isSwapping ? "loading" : canSwap ? "active" : "off"}`}>
                  {isSwapping
                    ? <><span className="sw-spin" />Swapping…</>
                    : <><ArrowDownUp style={{ width: 18, height: 18 }} />Swap</>
                  }
                </button>
              ) : (
                <button disabled data-testid="button-connect-wallet" className="sw-submit off">Connect Wallet to Swap</button>
              )}
            </div>
          </div>
        </div>
      </div>

      <TokenSelector open={showFromSelector} onClose={() => setShowFromSelector(false)} onSelect={t => { setFromToken(t); setShowFromSelector(false); }} tokens={tokens} onImport={handleImportToken} />
      <TokenSelector open={showToSelector} onClose={() => setShowToSelector(false)} onSelect={t => { setToToken(t); setShowToSelector(false); }} tokens={tokens} onImport={handleImportToken} />
      <SwapSettings open={showSettings} onClose={() => setShowSettings(false)} slippage={slippage} onSlippageChange={setSlippage} deadline={deadline} onDeadlineChange={setDeadline} recipientAddress={recipientAddress} onRecipientAddressChange={setRecipientAddress} quoteRefreshInterval={quoteRefreshInterval} onQuoteRefreshIntervalChange={setQuoteRefreshInterval} v2Enabled={v2Enabled} v3Enabled={v3Enabled} onV2EnabledChange={setV2Enabled} onV3EnabledChange={setV3Enabled} />
      <TransactionHistory open={showTransactionHistory} onClose={() => setShowTransactionHistory(false)} />
    </>
  );
}
