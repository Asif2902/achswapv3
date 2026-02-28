import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  ArrowDownUp, ExternalLink, ChevronDown, AlertTriangle, Clock, Check,
  Loader2, Search, ArrowRight, Zap, Shield, Globe,
} from "lucide-react";
import { useAccount } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import { Contract, JsonRpcProvider, BrowserProvider, zeroPadValue, getAddress } from "ethers";
import {
  CCTP_TESTNET_CHAINS,
  CCTP_ATTESTATION_API,
  ERC20_ABI,
  TOKEN_MESSENGER_V2_ABI,
  MESSAGE_TRANSMITTER_V2_ABI,
  type CCTPChain,
} from "@/lib/cctp-config";

// ── Transfer status steps ────────────────────────────────────────────────────
type BridgeStep = "idle" | "approving" | "burning" | "attesting" | "minting" | "complete" | "error";

interface TransferState {
  step: BridgeStep;
  burnTxHash: string | null;
  mintTxHash: string | null;
  attestation: { message: string; attestation: string } | null;
  error: string | null;
}

const INITIAL_STATE: TransferState = {
  step: "idle",
  burnTxHash: null,
  mintTxHash: null,
  attestation: null,
  error: null,
};

// ── Chain Selector modal ─────────────────────────────────────────────────────
function ChainSelector({
  open,
  onClose,
  onSelect,
  chains,
  selectedChain,
  excludeChain,
  label,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (chain: CCTPChain) => void;
  chains: CCTPChain[];
  selectedChain: CCTPChain | null;
  excludeChain: CCTPChain | null;
  label: string;
}) {
  const [search, setSearch] = useState("");
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) { setMounted(true); requestAnimationFrame(() => setVisible(true)); setSearch(""); }
    else { setVisible(false); setTimeout(() => setMounted(false), 200); }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const filtered = chains.filter(c => {
    if (excludeChain && c.domain === excludeChain.domain) return false;
    if (!search) return true;
    return c.name.toLowerCase().includes(search.toLowerCase()) ||
           c.shortName.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 0.2s" }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-md"
        style={{ transform: visible ? "scale(1)" : "scale(0.96)", transition: "transform 0.2s" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{
          background: "rgba(15,18,30,0.97)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 20,
          overflow: "hidden",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
        }}>
          {/* Header */}
          <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: "white" }}>{label}</span>
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>x</button>
          </div>

          {/* Search */}
          <div style={{ padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <Search style={{ width: 14, height: 14, color: "rgba(255,255,255,0.3)" }} />
              <input
                type="text"
                placeholder="Search chains..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "white", fontSize: 14 }}
              />
            </div>
          </div>

          {/* Chain list */}
          <div style={{ overflowY: "auto", padding: "0 8px 12px", flex: 1 }}>
            {filtered.map(chain => (
              <button
                key={chain.domain}
                onClick={() => { onSelect(chain); onClose(); }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "none",
                  background: selectedChain?.domain === chain.domain ? "rgba(99,102,241,0.12)" : "transparent",
                  cursor: "pointer",
                  transition: "background 0.15s",
                  textAlign: "left",
                }}
                onMouseEnter={e => { if (selectedChain?.domain !== chain.domain) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { if (selectedChain?.domain !== chain.domain) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: "50%",
                  background: `linear-gradient(135deg, ${chain.color}33, ${chain.color}66)`,
                  border: `2px solid ${chain.color}44`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 14, fontWeight: 800, color: chain.color,
                  flexShrink: 0,
                  overflow: "hidden",
                }}>
                  {chain.logo ? (
                    <img src={chain.logo} alt={chain.shortName} style={{ width: 24, height: 24, borderRadius: "50%" }} onError={e => { e.currentTarget.style.display = "none"; (e.currentTarget.parentElement as HTMLElement).textContent = chain.shortName.charAt(0); }} />
                  ) : chain.shortName.charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "white" }}>{chain.name}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                    Domain {chain.domain} · {chain.nativeCurrency.symbol}
                    {chain.supportsFastTransfer && <span style={{ marginLeft: 6, color: "#818cf8" }}><Zap style={{ width: 10, height: 10, display: "inline" }} /> Fast</span>}
                  </div>
                </div>
                {selectedChain?.domain === chain.domain && (
                  <Check style={{ width: 16, height: 16, color: "#818cf8", flexShrink: 0 }} />
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: 24, color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No chains found</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Bridge Step indicator ────────────────────────────────────────────────────
function StepIndicator({ step, burnTxHash, mintTxHash, sourceChain, destChain }: {
  step: BridgeStep;
  burnTxHash: string | null;
  mintTxHash: string | null;
  sourceChain: CCTPChain | null;
  destChain: CCTPChain | null;
}) {
  if (step === "idle") return null;

  const steps = [
    { key: "approving", label: "Approve USDC", icon: Shield },
    { key: "burning", label: "Burn on Source", icon: ArrowRight },
    { key: "attesting", label: "Attestation", icon: Clock },
    { key: "minting", label: "Mint on Dest", icon: Check },
  ];

  const currentIdx = steps.findIndex(s => s.key === step);
  const isComplete = step === "complete";
  const isError = step === "error";

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 16,
        padding: "16px 18px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          {isComplete ? (
            <Check style={{ width: 16, height: 16, color: "#4ade80" }} />
          ) : isError ? (
            <AlertTriangle style={{ width: 16, height: 16, color: "#f87171" }} />
          ) : (
            <Loader2 style={{ width: 16, height: 16, color: "#818cf8", animation: "spin 1s linear infinite" }} />
          )}
          <span style={{ fontSize: 13, fontWeight: 700, color: isError ? "#f87171" : isComplete ? "#4ade80" : "white" }}>
            {isError ? "Transfer Failed" : isComplete ? "Transfer Complete!" : "Transfer in Progress..."}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {steps.map((s, i) => {
            const isActive = s.key === step;
            const isDone = isComplete || currentIdx > i;
            const isPending = !isDone && !isActive;
            const Icon = s.icon;

            return (
              <div key={s.key} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 10px",
                borderRadius: 10,
                background: isActive ? "rgba(99,102,241,0.08)" : "transparent",
                transition: "background 0.2s",
              }}>
                <div style={{
                  width: 26, height: 26, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: isDone ? "rgba(74,222,128,0.15)" : isActive ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${isDone ? "rgba(74,222,128,0.3)" : isActive ? "rgba(99,102,241,0.4)" : "rgba(255,255,255,0.08)"}`,
                }}>
                  {isDone ? (
                    <Check style={{ width: 12, height: 12, color: "#4ade80" }} />
                  ) : isActive ? (
                    <Loader2 style={{ width: 12, height: 12, color: "#818cf8", animation: "spin 1s linear infinite" }} />
                  ) : (
                    <Icon style={{ width: 12, height: 12, color: "rgba(255,255,255,0.2)" }} />
                  )}
                </div>
                <span style={{
                  fontSize: 12, fontWeight: 600,
                  color: isDone ? "#4ade80" : isActive ? "white" : "rgba(255,255,255,0.3)",
                }}>{s.label}</span>
              </div>
            );
          })}
        </div>

        {/* Tx links */}
        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {burnTxHash && sourceChain && (
            <a
              href={`${sourceChain.explorerUrl}${sourceChain.explorerTxPath}${burnTxHash}`}
              target="_blank" rel="noopener noreferrer"
              style={{
                fontSize: 11, fontWeight: 600, color: "#818cf8",
                display: "flex", alignItems: "center", gap: 4,
                padding: "4px 10px", borderRadius: 8,
                background: "rgba(99,102,241,0.08)",
                border: "1px solid rgba(99,102,241,0.2)",
                textDecoration: "none",
              }}
            >
              Burn Tx <ExternalLink style={{ width: 10, height: 10 }} />
            </a>
          )}
          {mintTxHash && destChain && (
            <a
              href={`${destChain.explorerUrl}${destChain.explorerTxPath}${mintTxHash}`}
              target="_blank" rel="noopener noreferrer"
              style={{
                fontSize: 11, fontWeight: 600, color: "#4ade80",
                display: "flex", alignItems: "center", gap: 4,
                padding: "4px 10px", borderRadius: 8,
                background: "rgba(74,222,128,0.08)",
                border: "1px solid rgba(74,222,128,0.2)",
                textDecoration: "none",
              }}
            >
              Mint Tx <ExternalLink style={{ width: 10, height: 10 }} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Bridge component
// ═══════════════════════════════════════════════════════════════════════════════
export default function Bridge() {
  const { address, isConnected } = useAccount();
  const { toast } = useToast();

  // Chain selection
  const [sourceChain, setSourceChain] = useState<CCTPChain>(CCTP_TESTNET_CHAINS[0]); // Arc Testnet
  const [destChain, setDestChain] = useState<CCTPChain>(CCTP_TESTNET_CHAINS[1]); // Ethereum Sepolia
  const [showSourceSelector, setShowSourceSelector] = useState(false);
  const [showDestSelector, setShowDestSelector] = useState(false);

  // Amount + balances
  const [amount, setAmount] = useState("");
  const [sourceBalance, setSourceBalance] = useState<string | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [useFastTransfer, setUseFastTransfer] = useState(true);

  // Transfer state
  const [transfer, setTransfer] = useState<TransferState>(INITIAL_STATE);
  const abortRef = useRef(false);

  // ── Fetch USDC balance on source chain ──────────────────────────────────────
  const fetchBalance = useCallback(async () => {
    if (!address || !sourceChain) return;
    setIsLoadingBalance(true);
    try {
      const provider = new JsonRpcProvider(sourceChain.rpcUrl);
      const usdc = new Contract(sourceChain.usdcAddress, ERC20_ABI, provider);
      const bal: bigint = await usdc.balanceOf(address);
      const decimals = sourceChain.usdcDecimals;
      const formatted = (Number(bal) / 10 ** decimals).toFixed(decimals > 4 ? 4 : decimals);
      setSourceBalance(formatted);
    } catch (e) {
      console.error("Balance fetch error:", e);
      setSourceBalance(null);
    } finally {
      setIsLoadingBalance(false);
    }
  }, [address, sourceChain]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  // ── Swap source/dest ────────────────────────────────────────────────────────
  const handleSwapChains = () => {
    setSourceChain(destChain);
    setDestChain(sourceChain);
    setAmount("");
    setSourceBalance(null);
    setTransfer(INITIAL_STATE);
  };

  // ── CCTP Bridge execution ──────────────────────────────────────────────────
  const handleBridge = async () => {
    if (!address || !window.ethereum || !amount || parseFloat(amount) <= 0) return;
    if (transfer.step !== "idle" && transfer.step !== "complete" && transfer.step !== "error") return;

    abortRef.current = false;
    setTransfer({ ...INITIAL_STATE, step: "approving" });

    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const decimals = sourceChain.usdcDecimals;
      const amountWei = BigInt(Math.floor(parseFloat(amount) * 10 ** decimals));
      const maxFee = BigInt(Math.floor(parseFloat(amount) * 0.0005 * 10 ** decimals)); // 0.05% max fee
      const minFinalityThreshold = (useFastTransfer && sourceChain.supportsFastTransfer) ? 1000 : 2000;

      // ── Check connected network & prompt switch ─────────────────────────
      const currentChainId = await provider.getNetwork().then(n => Number(n.chainId));
      if (currentChainId !== sourceChain.chainId) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + sourceChain.chainId.toString(16) }],
          });
        } catch (switchErr: any) {
          // If chain not added, try adding it
          if (switchErr.code === 4902) {
            await window.ethereum.request({
              method: "wallet_addEthereumChain",
              params: [{
                chainId: "0x" + sourceChain.chainId.toString(16),
                chainName: sourceChain.name,
                nativeCurrency: sourceChain.nativeCurrency,
                rpcUrls: [sourceChain.rpcUrl],
                blockExplorerUrls: [sourceChain.explorerUrl],
              }],
            });
          } else {
            throw new Error(`Please switch to ${sourceChain.name} to continue`);
          }
        }
      }

      // ── Step 1: Approve USDC ────────────────────────────────────────────
      toast({ title: "Approving USDC...", description: `On ${sourceChain.name}` });
      const usdcContract = new Contract(sourceChain.usdcAddress, ERC20_ABI, signer);
      const currentAllowance: bigint = await usdcContract.allowance(address, sourceChain.tokenMessengerV2);

      if (currentAllowance < amountWei) {
        const approveTx = await usdcContract.approve(sourceChain.tokenMessengerV2, amountWei);
        await approveTx.wait();
      }

      if (abortRef.current) return;
      setTransfer(prev => ({ ...prev, step: "burning" }));

      // ── Step 2: Burn USDC (depositForBurn) ──────────────────────────────
      toast({ title: "Burning USDC...", description: `Sending to ${destChain.name}` });
      const mintRecipient = zeroPadValue(address, 32) as `0x${string}`;
      const destCallerBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

      const tokenMessenger = new Contract(
        sourceChain.tokenMessengerV2,
        TOKEN_MESSENGER_V2_ABI,
        signer
      );

      const burnTx = await tokenMessenger.depositForBurn(
        amountWei,
        destChain.domain,
        mintRecipient,
        sourceChain.usdcAddress,
        destCallerBytes32,
        maxFee,
        minFinalityThreshold
      );
      const burnReceipt = await burnTx.wait();
      const burnTxHash = burnReceipt.hash;

      if (abortRef.current) return;
      setTransfer(prev => ({ ...prev, step: "attesting", burnTxHash }));

      // ── Step 3: Poll for attestation ────────────────────────────────────
      toast({ title: "Waiting for attestation...", description: "This may take 1-20 minutes" });
      const attestation = await pollForAttestation(sourceChain.domain, burnTxHash);

      if (abortRef.current) return;
      setTransfer(prev => ({ ...prev, step: "minting", attestation }));

      // ── Step 4: Mint USDC on destination ────────────────────────────────
      // Switch to destination chain
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x" + destChain.chainId.toString(16) }],
        });
      } catch (switchErr: any) {
        if (switchErr.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x" + destChain.chainId.toString(16),
              chainName: destChain.name,
              nativeCurrency: destChain.nativeCurrency,
              rpcUrls: [destChain.rpcUrl],
              blockExplorerUrls: [destChain.explorerUrl],
            }],
          });
        } else {
          throw new Error(`Please switch to ${destChain.name} to receive USDC`);
        }
      }

      const destProvider = new BrowserProvider(window.ethereum);
      const destSigner = await destProvider.getSigner();

      toast({ title: "Minting USDC...", description: `On ${destChain.name}` });
      const messageTransmitter = new Contract(
        destChain.messageTransmitterV2,
        MESSAGE_TRANSMITTER_V2_ABI,
        destSigner
      );

      const mintTx = await messageTransmitter.receiveMessage(
        attestation.message,
        attestation.attestation
      );
      const mintReceipt = await mintTx.wait();

      setTransfer(prev => ({
        ...prev,
        step: "complete",
        mintTxHash: mintReceipt.hash,
      }));

      toast({
        title: "Bridge Complete!",
        description: `${amount} USDC bridged from ${sourceChain.shortName} to ${destChain.shortName}`,
      });

      // Refresh balance
      fetchBalance();

    } catch (err: any) {
      console.error("Bridge error:", err);
      const message = err?.message || err?.reason || "Unknown error";
      setTransfer(prev => ({ ...prev, step: "error", error: message }));
      toast({
        title: "Bridge Failed",
        description: message.length > 120 ? message.slice(0, 120) + "..." : message,
        variant: "destructive",
      });
    }
  };

  // ── Attestation polling ────────────────────────────────────────────────────
  async function pollForAttestation(
    srcDomain: number,
    txHash: string
  ): Promise<{ message: string; attestation: string }> {
    const url = `${CCTP_ATTESTATION_API}/v2/messages/${srcDomain}?transactionHash=${txHash}`;
    const maxAttempts = 120; // ~10 minutes at 5s intervals

    for (let i = 0; i < maxAttempts; i++) {
      if (abortRef.current) throw new Error("Transfer cancelled");

      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data?.messages?.[0]?.status === "complete") {
            return {
              message: data.messages[0].message,
              attestation: data.messages[0].attestation,
            };
          }
        }
      } catch { /* retry */ }

      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error("Attestation timeout — you can retry minting later with the burn tx hash");
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const isTransferring = transfer.step !== "idle" && transfer.step !== "complete" && transfer.step !== "error";
  const canBridge = isConnected && amount && parseFloat(amount) > 0 && !isTransferring;
  const estimatedTime = (useFastTransfer && sourceChain.supportsFastTransfer) ? "~8-20 seconds" : "~15-19 minutes";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        .br-wrap { display:flex; flex-direction:column; align-items:center; padding:28px 16px 56px; box-sizing:border-box; }
        .br-inner { width:100%; max-width:436px; }

        .br-title { text-align:center; margin-bottom:24px; }
        .br-title h1 { font-size:clamp(20px,5vw,28px); font-weight:800; margin:0 0 5px; letter-spacing:-0.02em; background:linear-gradient(135deg,#e2e8f0,#a5b4fc); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
        .br-title p { font-size:13px; color:rgba(255,255,255,0.3); margin:0; }

        .br-shell { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:24px; overflow:hidden; }

        .br-hdr { display:flex; align-items:center; justify-content:space-between; padding:15px 20px; border-bottom:1px solid rgba(255,255,255,0.06); }
        .br-hdr-left { display:flex; align-items:center; gap:10px; }
        .br-hdr-dot { width:8px; height:8px; border-radius:50%; background:linear-gradient(135deg,#6366f1,#818cf8); box-shadow:0 0 8px rgba(99,102,241,0.6); }
        .br-hdr-title { font-size:16px; font-weight:800; color:white; letter-spacing:-0.01em; }
        .br-powered { font-size:10px; color:rgba(255,255,255,0.25); display:flex; align-items:center; gap:5px; }

        .br-body { padding:16px; display:flex; flex-direction:column; gap:4px; }

        .br-box { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:18px; padding:14px 16px; transition:border-color 0.2s,background 0.2s; }
        .br-box:focus-within { border-color:rgba(99,102,241,0.5); background:rgba(99,102,241,0.035); }
        .br-box.dest-box { background:rgba(0,0,0,0.12); }

        .br-box-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
        .br-box-label { font-size:11px; font-weight:700; color:rgba(255,255,255,0.28); text-transform:uppercase; letter-spacing:0.08em; }
        .br-bal { font-size:11px; color:rgba(255,255,255,0.28); }
        .br-bal-val { color:rgba(255,255,255,0.6); font-weight:600; cursor:pointer; }
        .br-bal-val:hover { color:#a5b4fc; }

        .br-row { display:flex; align-items:center; gap:12px; }
        .br-amount-input { background:transparent; border:none; outline:none; color:white; font-size:clamp(22px,6vw,30px); font-weight:700; flex:1; min-width:0; font-variant-numeric:tabular-nums; }
        .br-amount-input::placeholder { color:rgba(255,255,255,0.16); }
        .br-amount-input:disabled { opacity:0.5; cursor:not-allowed; }
        .br-amount-input[type=number]::-webkit-outer-spin-button,
        .br-amount-input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; }

        .br-chain-col { display:flex; flex-direction:column; align-items:flex-end; gap:7px; flex-shrink:0; }
        .br-chain-btn { display:flex; align-items:center; gap:8px; padding:8px 13px; border-radius:12px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:white; font-weight:700; font-size:13px; cursor:pointer; transition:all 0.2s; white-space:nowrap; }
        .br-chain-btn:hover { background:rgba(99,102,241,0.18); border-color:rgba(99,102,241,0.4); }
        .br-max-btn { font-size:11px; font-weight:700; letter-spacing:0.05em; padding:3px 10px; border-radius:8px; background:rgba(99,102,241,0.14); border:1px solid rgba(99,102,241,0.3); color:#a5b4fc; cursor:pointer; transition:all 0.2s; }
        .br-max-btn:hover { background:rgba(99,102,241,0.28); border-color:rgba(99,102,241,0.55); }

        .br-dir-wrap { display:flex; align-items:center; justify-content:center; height:0; position:relative; z-index:10; }
        .br-dir-btn { width:40px; height:40px; border-radius:50%; background:rgba(99,102,241,0.15); border:3px solid rgba(99,102,241,0.2); color:#818cf8; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all 0.35s cubic-bezier(.4,0,.2,1); margin-top:-20px; margin-bottom:-20px; box-shadow:0 2px 14px rgba(0,0,0,0.35); }
        .br-dir-btn:hover:not(:disabled) { background:rgba(99,102,241,0.35); border-color:rgba(99,102,241,0.55); color:#c7d2fe; transform:rotate(180deg); box-shadow:0 4px 20px rgba(99,102,241,0.35); }
        .br-dir-btn:disabled { opacity:0.3; cursor:not-allowed; }

        .br-info { margin-top:12px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:14px; overflow:hidden; }
        .br-info-row { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; }
        .br-info-row + .br-info-row { border-top:1px solid rgba(255,255,255,0.05); }
        .br-info-label { font-size:12px; color:rgba(255,255,255,0.33); }
        .br-info-val { font-size:12px; font-weight:600; color:rgba(255,255,255,0.85); display:flex; align-items:center; gap:5px; }

        .br-fast-toggle { display:flex; align-items:center; gap:8px; margin-top:12px; padding:10px 14px; border-radius:14px; background:rgba(99,102,241,0.06); border:1px solid rgba(99,102,241,0.15); cursor:pointer; transition:all 0.2s; }
        .br-fast-toggle:hover { background:rgba(99,102,241,0.1); border-color:rgba(99,102,241,0.25); }
        .br-fast-toggle-track { width:36px; height:20px; border-radius:10px; background:rgba(255,255,255,0.1); position:relative; transition:background 0.2s; flex-shrink:0; }
        .br-fast-toggle-track.on { background:rgba(99,102,241,0.5); }
        .br-fast-toggle-thumb { width:16px; height:16px; border-radius:50%; background:white; position:absolute; top:2px; left:2px; transition:left 0.2s; }
        .br-fast-toggle-track.on .br-fast-toggle-thumb { left:18px; }

        .br-submit { width:100%; height:52px; border-radius:16px; font-weight:800; font-size:16px; letter-spacing:0.02em; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:9px; transition:all 0.22s; margin-top:14px; }
        .br-submit.active { background:linear-gradient(135deg,#6366f1,#3b82f6); color:white; box-shadow:0 4px 24px rgba(99,102,241,0.38); }
        .br-submit.active:hover { background:linear-gradient(135deg,#4f46e5,#2563eb); box-shadow:0 6px 32px rgba(99,102,241,0.52); transform:translateY(-1px); }
        .br-submit.loading { background:rgba(99,102,241,0.28); color:rgba(255,255,255,0.5); cursor:not-allowed; }
        .br-submit.off { background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.24); cursor:not-allowed; }

        @keyframes spin { to { transform: rotate(360deg); } }
        .br-spin { animation: spin 1s linear infinite; display:inline-block; width:18px; height:18px; border:2.5px solid rgba(255,255,255,0.2); border-top-color:white; border-radius:50%; }

        .br-usdc-icon { width:22px; height:22px; border-radius:50%; background:linear-gradient(135deg,#2775ca,#3b8dd4); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:900; color:white; flex-shrink:0; border:1px solid rgba(39,117,202,0.3); }

        @media (max-width:400px) { .br-body{padding:12px;} .br-box{padding:12px 14px;} .br-hdr{padding:13px 16px;} }
      `}</style>

      <div className="br-wrap">
        <div className="br-inner">

          <div className="br-title">
            <h1>USDC Bridge</h1>
            <p>Cross-chain USDC transfers via Circle CCTP</p>
          </div>

          <div className="br-shell">

            {/* Header */}
            <div className="br-hdr">
              <div className="br-hdr-left">
                <span className="br-hdr-dot" />
                <span className="br-hdr-title">Bridge</span>
              </div>
              <div className="br-powered">
                <Shield style={{ width: 12, height: 12 }} />
                <span>Powered by Circle CCTP</span>
              </div>
            </div>

            {/* Body */}
            <div className="br-body">

              {/* SOURCE box */}
              <div className="br-box">
                <div className="br-box-top">
                  <span className="br-box-label">From</span>
                  {isConnected && (
                    <span className="br-bal">
                      USDC Balance:{" "}
                      <span
                        className="br-bal-val"
                        onClick={() => { if (sourceBalance) setAmount(sourceBalance); }}
                      >
                        {isLoadingBalance ? "..." : sourceBalance ?? "0.00"}
                      </span>
                    </span>
                  )}
                </div>
                <div className="br-row">
                  <input
                    type="number"
                    placeholder="0.00"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    disabled={isTransferring}
                    className="br-amount-input"
                  />
                  <div className="br-chain-col">
                    <button
                      className="br-chain-btn"
                      onClick={() => setShowSourceSelector(true)}
                      disabled={isTransferring}
                    >
                      <div style={{
                        width: 22, height: 22, borderRadius: "50%",
                        background: `linear-gradient(135deg, ${sourceChain.color}44, ${sourceChain.color}88)`,
                        border: `1.5px solid ${sourceChain.color}55`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontWeight: 800, color: sourceChain.color,
                        overflow: "hidden",
                      }}>
                        {sourceChain.logo ? (
                          <img src={sourceChain.logo} alt={sourceChain.shortName} style={{ width: 16, height: 16, borderRadius: "50%" }} onError={e => { e.currentTarget.style.display = "none"; }} />
                        ) : sourceChain.shortName.charAt(0)}
                      </div>
                      <span>{sourceChain.shortName}</span>
                      <ChevronDown style={{ width: 14, height: 14, opacity: 0.5 }} />
                    </button>
                    {isConnected && sourceBalance && (
                      <button
                        className="br-max-btn"
                        onClick={() => setAmount(sourceBalance)}
                        disabled={isTransferring}
                      >MAX</button>
                    )}
                  </div>
                </div>
              </div>

              {/* Direction swap */}
              <div className="br-dir-wrap">
                <button className="br-dir-btn" onClick={handleSwapChains} disabled={isTransferring}>
                  <ArrowDownUp style={{ width: 16, height: 16 }} />
                </button>
              </div>

              {/* DESTINATION box */}
              <div className="br-box dest-box">
                <div className="br-box-top">
                  <span className="br-box-label">To</span>
                </div>
                <div className="br-row">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                    <span className="br-usdc-icon">$</span>
                    <span style={{
                      fontSize: "clamp(22px,6vw,30px)", fontWeight: 700,
                      color: amount && parseFloat(amount) > 0 ? "white" : "rgba(255,255,255,0.16)",
                      fontVariantNumeric: "tabular-nums",
                    }}>
                      {amount && parseFloat(amount) > 0 ? parseFloat(amount).toFixed(2) : "0.00"}
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "rgba(255,255,255,0.4)" }}>USDC</span>
                  </div>
                  <div className="br-chain-col">
                    <button
                      className="br-chain-btn"
                      onClick={() => setShowDestSelector(true)}
                      disabled={isTransferring}
                    >
                      <div style={{
                        width: 22, height: 22, borderRadius: "50%",
                        background: `linear-gradient(135deg, ${destChain.color}44, ${destChain.color}88)`,
                        border: `1.5px solid ${destChain.color}55`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontWeight: 800, color: destChain.color,
                        overflow: "hidden",
                      }}>
                        {destChain.logo ? (
                          <img src={destChain.logo} alt={destChain.shortName} style={{ width: 16, height: 16, borderRadius: "50%" }} onError={e => { e.currentTarget.style.display = "none"; }} />
                        ) : destChain.shortName.charAt(0)}
                      </div>
                      <span>{destChain.shortName}</span>
                      <ChevronDown style={{ width: 14, height: 14, opacity: 0.5 }} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Fast Transfer toggle (only if source supports it) */}
              {sourceChain.supportsFastTransfer && (
                <div className="br-fast-toggle" onClick={() => setUseFastTransfer(!useFastTransfer)}>
                  <div className={`br-fast-toggle-track ${useFastTransfer ? "on" : ""}`}>
                    <div className="br-fast-toggle-thumb" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: useFastTransfer ? "#a5b4fc" : "rgba(255,255,255,0.5)" }}>
                      <Zap style={{ width: 12, height: 12, display: "inline", marginRight: 4 }} />
                      Fast Transfer
                    </div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>
                      {useFastTransfer ? "~8-20 seconds (higher fee)" : "~15-19 minutes (lower fee)"}
                    </div>
                  </div>
                </div>
              )}

              {/* Transfer info */}
              {amount && parseFloat(amount) > 0 && (
                <div className="br-info">
                  <div className="br-info-row">
                    <span className="br-info-label">You Send</span>
                    <span className="br-info-val">{parseFloat(amount).toFixed(2)} USDC</span>
                  </div>
                  <div className="br-info-row">
                    <span className="br-info-label">You Receive</span>
                    <span className="br-info-val" style={{ color: "#4ade80" }}>~{parseFloat(amount).toFixed(2)} USDC</span>
                  </div>
                  <div className="br-info-row">
                    <span className="br-info-label">Route</span>
                    <span className="br-info-val">
                      {sourceChain.shortName}
                      <ArrowRight style={{ width: 12, height: 12, color: "#818cf8" }} />
                      {destChain.shortName}
                    </span>
                  </div>
                  <div className="br-info-row">
                    <span className="br-info-label">Est. Time</span>
                    <span className="br-info-val">
                      <Clock style={{ width: 12, height: 12, color: "#818cf8" }} />
                      {estimatedTime}
                    </span>
                  </div>
                  <div className="br-info-row">
                    <span className="br-info-label">Protocol</span>
                    <span className="br-info-val">
                      <span style={{
                        padding: "2px 8px", borderRadius: 8,
                        fontSize: 10, fontWeight: 800, letterSpacing: "0.04em",
                        background: "rgba(99,102,241,0.14)", color: "#818cf8",
                        border: "1px solid rgba(99,102,241,0.25)",
                      }}>CCTP V2</span>
                    </span>
                  </div>
                </div>
              )}

              {/* Step indicator */}
              <StepIndicator
                step={transfer.step}
                burnTxHash={transfer.burnTxHash}
                mintTxHash={transfer.mintTxHash}
                sourceChain={sourceChain}
                destChain={destChain}
              />

              {/* Submit */}
              {isConnected ? (
                <button
                  onClick={handleBridge}
                  disabled={!canBridge}
                  className={`br-submit ${isTransferring ? "loading" : canBridge ? "active" : "off"}`}
                >
                  {isTransferring ? (
                    <><span className="br-spin" />Bridging...</>
                  ) : transfer.step === "complete" ? (
                    <><Check style={{ width: 18, height: 18 }} />Bridge Again</>
                  ) : (
                    <><Globe style={{ width: 18, height: 18 }} />Bridge USDC</>
                  )}
                </button>
              ) : (
                <button disabled className="br-submit off">Connect Wallet to Bridge</button>
              )}

              {/* Error message */}
              {transfer.step === "error" && transfer.error && (
                <div style={{
                  marginTop: 10, padding: "10px 14px", borderRadius: 12,
                  background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.18)",
                  display: "flex", alignItems: "flex-start", gap: 8,
                }}>
                  <AlertTriangle style={{ width: 14, height: 14, color: "#f87171", flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 11, color: "#f87171", lineHeight: 1.5, wordBreak: "break-word" }}>
                    {transfer.error.length > 200 ? transfer.error.slice(0, 200) + "..." : transfer.error}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Info cards */}
          <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{
              padding: "14px 16px", borderRadius: 16,
              background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
            }}>
              <Shield style={{ width: 16, height: 16, color: "#818cf8", marginBottom: 6 }} />
              <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginBottom: 2 }}>Secure</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", lineHeight: 1.5 }}>Native burn & mint. No wrapped tokens.</div>
            </div>
            <div style={{
              padding: "14px 16px", borderRadius: 16,
              background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
            }}>
              <Globe style={{ width: 16, height: 16, color: "#818cf8", marginBottom: 6 }} />
              <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginBottom: 2 }}>{CCTP_TESTNET_CHAINS.length} Chains</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", lineHeight: 1.5 }}>Testnet chains supported via CCTP.</div>
            </div>
          </div>
        </div>
      </div>

      {/* Chain selectors */}
      <ChainSelector
        open={showSourceSelector}
        onClose={() => setShowSourceSelector(false)}
        onSelect={setSourceChain}
        chains={CCTP_TESTNET_CHAINS}
        selectedChain={sourceChain}
        excludeChain={destChain}
        label="Select Source Chain"
      />
      <ChainSelector
        open={showDestSelector}
        onClose={() => setShowDestSelector(false)}
        onSelect={setDestChain}
        chains={CCTP_TESTNET_CHAINS}
        selectedChain={destChain}
        excludeChain={sourceChain}
        label="Select Destination Chain"
      />
    </>
  );
}
