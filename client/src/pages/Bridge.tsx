import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  ArrowDownUp, ExternalLink, ChevronDown, AlertTriangle, Clock, Check,
  Loader2, Search, ArrowRight, Zap, Shield, Globe, RotateCcw, Bell, X, Trash2,
} from "lucide-react";
import { useAccount } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import { Contract, BrowserProvider, zeroPadValue, parseUnits, formatUnits, Interface } from "ethers";
import {
  CCTP_TESTNET_CHAINS,
  CCTP_ATTESTATION_API,
  ERC20_ABI,
  TOKEN_MESSENGER_V2_ABI,
  MESSAGE_TRANSMITTER_V2_ABI,
  getWorkingProvider,
  getChainByDomain,
  getCCTPFeeRate,
  type CCTPChain,
} from "@/lib/cctp-config";
import {
  savePendingTransfer,
  updateTransferStatus,
  fetchPendingTransfers,
  getCachedPendingTransfersForWallet,
  getTransferHistory,
  getCachedHistoryForWallet,
  getTransferStatusRank,
  isBridgeTransferApiAvailable,
  removeTransfer,
  reconcileAllPendingTransfers,
  type PendingBridgeTransfer,
} from "@/lib/bridge-transfers";

const TOKEN_MESSENGER_V2_INTERFACE = new Interface([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);
const MESSAGE_TRANSMITTER_V2_INTERFACE = new Interface(MESSAGE_TRANSMITTER_V2_ABI);

const PRIORITY_FEE_PER_GAS = BigInt(10e9);

// ── Transfer status steps ────────────────────────────────────────────────────
type BridgeStep = "idle" | "approving" | "burning" | "attesting" | "minting" | "complete" | "error";

interface TransferState {
  step: BridgeStep;
  burnTxHash: string | null;
  mintTxHash: string | null;
  attestation: { message: string; attestation: string } | null;
  error: string | null;
}

interface AttestationPollResult {
  message: string;
  attestation: string;
  destinationDomain?: number;
}

const CCTP_MESSAGE_NONCE_OFFSET_BYTES = 12;
const CCTP_MESSAGE_NONCE_LENGTH_BYTES = 32;

function extractCCTPMessageNonce(message: string): `0x${string}` | null {
  const normalized = message.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(normalized)) return null;

  const start = 2 + CCTP_MESSAGE_NONCE_OFFSET_BYTES * 2;
  const end = start + CCTP_MESSAGE_NONCE_LENGTH_BYTES * 2;
  if (normalized.length < end) return null;

  return `0x${normalized.slice(start, end)}` as `0x${string}`;
}

async function isTransferClaimedOnDestination(
  dstChain: CCTPChain,
  attestationMessage: string,
  options?: { runner?: BrowserProvider },
): Promise<boolean> {
  const messageNonce = extractCCTPMessageNonce(attestationMessage);
  if (!messageNonce) return false;

  try {
    const provider = options?.runner ?? await getWorkingProvider(dstChain);
    const messageTransmitter = new Contract(
      dstChain.messageTransmitterV2,
      MESSAGE_TRANSMITTER_V2_ABI,
      provider,
    );

    const [nonceState, nonceUsedValue] = await Promise.all([
      messageTransmitter.usedNonces(messageNonce) as Promise<bigint>,
      messageTransmitter.NONCE_USED() as Promise<bigint>,
    ]);

    return nonceUsedValue > 0n
      ? nonceState === nonceUsedValue
      : nonceState > 0n;
  } catch (err) {
    console.warn("Destination claimed-state check failed", err);
    return false;
  }
}

async function prepareMintTransaction(
  dstChain: CCTPChain,
  signerAddress: string,
  attestation: { message: string; attestation: string },
): Promise<{ data: `0x${string}`; gasLimit: bigint }> {
  const provider = await getWorkingProvider(dstChain);
  const data = MESSAGE_TRANSMITTER_V2_INTERFACE.encodeFunctionData("receiveMessage", [
    attestation.message,
    attestation.attestation,
  ]) as `0x${string}`;

  const txRequest = {
    from: signerAddress,
    to: dstChain.messageTransmitterV2,
    data,
  };

  // Preflight through a public RPC so we get clearer errors than wallet
  // providers usually return for failed gas estimation.
  await provider.call(txRequest);

  const estimatedGas = await provider.estimateGas(txRequest);
  const gasLimit = estimatedGas * 120n / 100n;
  return { data, gasLimit };
}

async function resolveMintErrorMessage(
  dstChain: CCTPChain,
  signerAddress: string,
  attestation: { message: string; attestation: string },
  originalError: unknown,
): Promise<string> {
  const originalText = extractErrorText(originalError).trim();
  const normalizedOriginal = originalText.toLowerCase();

  if (originalText && !normalizedOriginal.includes("missing revert data")) {
    return originalText;
  }

  try {
    await prepareMintTransaction(dstChain, signerAddress, attestation);
  } catch (simulationError) {
    const simulationText = extractErrorText(simulationError).trim();
    if (simulationText) return simulationText;
  }

  if (originalText) return originalText;
  return "Mint transaction could not be estimated. The message may already be claimed or not yet mintable on the destination chain.";
}

async function detectClaimedAfterMintFailure(
  dstChain: CCTPChain,
  attestationMessage: string,
  walletProvider?: BrowserProvider,
): Promise<boolean> {
  const checkClaimed = async (): Promise<boolean> => {
    if (await isTransferClaimedOnDestination(dstChain, attestationMessage)) {
      return true;
    }

    if (walletProvider) {
      return isTransferClaimedOnDestination(dstChain, attestationMessage, { runner: walletProvider });
    }

    return false;
  };

  if (await checkClaimed()) return true;

  await new Promise((resolve) => setTimeout(resolve, 1200));
  return checkClaimed();
}

function extractErrorCode(error: unknown): number | string | null {
  if (!error || typeof error !== "object") return null;

  const maybeError = error as {
    code?: unknown;
    error?: { code?: unknown };
    data?: { originalError?: { code?: unknown } };
    info?: { error?: { code?: unknown } };
  };

  const rawCode =
    maybeError.code ??
    maybeError.error?.code ??
    maybeError.data?.originalError?.code ??
    maybeError.info?.error?.code;

  return typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : null;
}

function extractErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";

  const maybeError = error as {
    message?: unknown;
    reason?: unknown;
    shortMessage?: unknown;
    details?: unknown;
    data?: unknown;
    error?: { message?: unknown; reason?: unknown; data?: unknown };
    info?: { error?: { message?: unknown; reason?: unknown; data?: unknown } };
  };

  return [
    maybeError.message,
    maybeError.reason,
    maybeError.shortMessage,
    maybeError.details,
    maybeError.error?.message,
    maybeError.error?.reason,
    maybeError.info?.error?.message,
    maybeError.info?.error?.reason,
    maybeError.data,
    maybeError.error?.data,
    maybeError.info?.error?.data,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function isUserRejectedRequestError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (code === 4001 || code === "4001" || code === "ACTION_REJECTED") return true;

  const normalized = extractErrorText(error).toLowerCase();
  return (
    normalized.includes("user rejected") ||
    normalized.includes("user denied") ||
    normalized.includes("request rejected") ||
    normalized.includes("rejected by user")
  );
}

function isChainNotAddedError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (code === 4902 || code === "4902") return true;

  const normalized = extractErrorText(error).toLowerCase();
  return (
    normalized.includes("unrecognized chain") ||
    normalized.includes("unknown chain") ||
    normalized.includes("chain not added") ||
    normalized.includes("unsupported chain") ||
    normalized.includes("wallet_addethereumchain") ||
    normalized.includes("does not exist")
  );
}

function isAlreadyClaimedError(error: unknown): boolean {
  const errorText = extractErrorText(error);

  if (!errorText) return false;

  const normalized = errorText.toLowerCase();
  return (
    normalized.includes("already claimed") ||
    normalized.includes("already received") ||
    normalized.includes("already processed") ||
    normalized.includes("message already") ||
    normalized.includes("nonce already used") ||
    normalized.includes("nonce was already used") ||
    (normalized.includes("nonce") && normalized.includes("used"))
  );
}

const CHAIN_SWITCH_VERIFY_TIMEOUT_MS = 6000;
const CHAIN_SWITCH_VERIFY_POLL_MS = 120;

async function waitForWalletChain(chainId: number): Promise<boolean> {
  if (!window.ethereum) return false;
  const startedAt = Date.now();

  while (Date.now() - startedAt < CHAIN_SWITCH_VERIFY_TIMEOUT_MS) {
    try {
      const rawChainId = await window.ethereum.request({ method: "eth_chainId" });
      const currentChainId = typeof rawChainId === "string"
        ? Number.parseInt(rawChainId, 16)
        : Number(rawChainId);
      if (currentChainId === chainId) {
        return true;
      }
    } catch {
      // wallet/provider may still be switching
    }

    await new Promise((resolve) => setTimeout(resolve, CHAIN_SWITCH_VERIFY_POLL_MS));
  }

  return false;
}

async function switchToChain(targetChain: CCTPChain, purposeLabel: string): Promise<void> {
  if (!window.ethereum) throw new Error("No wallet connected");

  const targetChainHex = `0x${targetChain.chainId.toString(16)}`;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetChainHex }],
    });
  } catch (switchErr) {
    if (isUserRejectedRequestError(switchErr)) {
      throw new Error(`Chain switch cancelled. Please switch to ${targetChain.name} to ${purposeLabel}.`);
    }

    if (isChainNotAddedError(switchErr)) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: targetChainHex,
            chainName: targetChain.name,
            nativeCurrency: targetChain.nativeCurrency,
            rpcUrls: targetChain.rpcUrls,
            blockExplorerUrls: [targetChain.explorerUrl],
          }],
        });
      } catch (addErr) {
        if (isUserRejectedRequestError(addErr)) {
          throw new Error(`Network add cancelled. Please add ${targetChain.name} in your wallet, then try again.`);
        }

        const addErrorText = extractErrorText(addErr);
        throw new Error(
          addErrorText
            ? `Failed to add ${targetChain.name}: ${addErrorText}`
            : `Failed to add ${targetChain.name}. Please add it in your wallet, then try again.`
        );
      }

      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: targetChainHex }],
        });
      } catch (switchAfterAddErr) {
        if (isUserRejectedRequestError(switchAfterAddErr)) {
          throw new Error(`Chain switch cancelled. Please switch to ${targetChain.name} to ${purposeLabel}.`);
        }

        const switchErrorText = extractErrorText(switchAfterAddErr);
        throw new Error(
          switchErrorText
            ? `Failed to switch to ${targetChain.name}: ${switchErrorText}`
            : `Failed to switch to ${targetChain.name}. Please switch manually in your wallet and retry.`
        );
      }
    } else {
      const switchErrorText = extractErrorText(switchErr);
      throw new Error(
        switchErrorText
          ? `Failed to switch to ${targetChain.name}: ${switchErrorText}`
          : `Please switch to ${targetChain.name} to ${purposeLabel}`
      );
    }
  }

  const switched = await waitForWalletChain(targetChain.chainId);
  if (!switched) {
    throw new Error(`Chain switch to ${targetChain.name} did not complete. Please try again.`);
  }
}

function resolveDestinationChain(
  destinationDomain: unknown,
  fallbackChain: CCTPChain | null | undefined,
): CCTPChain | undefined {
  if (typeof destinationDomain === "number") {
    const byDomain = getChainByDomain(destinationDomain);
    if (byDomain) return byDomain;
  }

  if (fallbackChain) {
    return fallbackChain;
  }

  return undefined;
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
    let timer: ReturnType<typeof setTimeout>;
    if (open) { setMounted(true); requestAnimationFrame(() => setVisible(true)); setSearch(""); }
    else { setVisible(false); timer = setTimeout(() => setMounted(false), 200); }
    return () => clearTimeout(timer);
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
  const [sourceBalanceRaw, setSourceBalanceRaw] = useState<bigint | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [useFastTransfer, setUseFastTransfer] = useState(true);
  const balanceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const balanceFetchVersionRef = useRef(0);

  // Transfer state
  const [transfer, setTransfer] = useState<TransferState>(INITIAL_STATE);
  const abortRef = useRef(false);
  const currentTransferIdRef = useRef<string | null>(null);

  // Notification panel state (full-screen modal like TransactionHistory)
  const [notifOpen, setNotifOpen] = useState(false);
  const [allTransfers, setAllTransfers] = useState<PendingBridgeTransfer[]>([]);
  const [transferHistory, setTransferHistory] = useState<PendingBridgeTransfer[]>([]);
  const [notifVisible, setNotifVisible] = useState(false);
  const [notifMounted, setNotifMounted] = useState(false);

  // Manual claim state
  const [manualClaimOpen, setManualClaimOpen] = useState(false);
  const [manualClaimTxHash, setManualClaimTxHash] = useState("");
  const [manualClaimLoading, setManualClaimLoading] = useState(false);

  // Reconciliation state
  const [reconciling, setReconciling] = useState(false);
  const [manualClaimTxHashValid, setManualClaimTxHashValid] = useState(false);
  const [manualClaimSourceChain, setManualClaimSourceChain] = useState<CCTPChain | null>(null);
  const [manualClaimDestChain, setManualClaimDestChain] = useState<CCTPChain | null>(null);
  const [manualClaimAttestation, setManualClaimAttestation] = useState<{ message: string; attestation: string } | null>(null);
  const [manualClaimStatus, setManualClaimStatus] = useState<"idle" | "fetching" | "ready" | "not_found" | "error">("idle");
  const [isBridgeDbAvailable, setIsBridgeDbAvailable] = useState(true);

  const isTransferring = transfer.step !== "idle" && transfer.step !== "complete" && transfer.step !== "error";

  // ── Load resumable transfers ───────────────────────────────────────────────
  const refreshPendingTransfers = useCallback(async () => {
    if (!address) {
      setAllTransfers([]);
      setTransferHistory([]);
      return;
    }

    try {
      const transfers = await fetchPendingTransfers(address);
      setAllTransfers(transfers);
    } catch (e) {
      console.error("[bridge] Failed to fetch pending transfers; using cached fallback", e);
      setAllTransfers(
        getCachedPendingTransfersForWallet(address),
      );
    }

    setTransferHistory(getCachedHistoryForWallet(address));
  }, [address]);

  const probeBridgeAvailability = useCallback(async (): Promise<boolean> => {
    if (!address) {
      setIsBridgeDbAvailable(true);
      return true;
    }

    try {
      const ok = await isBridgeTransferApiAvailable(address);
      setIsBridgeDbAvailable(ok);
      return ok;
    } catch (e) {
      console.error("[bridge] Bridge DB availability probe failed", e);
      setIsBridgeDbAvailable(false);
      return false;
    }
  }, [address]);

  const savePendingTransferWithProbe = useCallback(async (
    transfer: PendingBridgeTransfer,
    options?: { strict?: boolean },
  ): Promise<boolean> => {
    try {
      const ok = await savePendingTransfer(transfer, options);
      if (!ok) {
        void probeBridgeAvailability();
      }
      return ok;
    } catch (err) {
      void probeBridgeAvailability();
      throw err;
    }
  }, [probeBridgeAvailability]);

  useEffect(() => {
    if (!notifOpen) return;
    setTransferHistory(getCachedHistoryForWallet(address || ""));
    void refreshPendingTransfers();
  }, [notifOpen, address]);

  useEffect(() => {
    if (!address) return;
    void refreshPendingTransfers();
  }, [address]);

  // Listen for bridge-transfers-updated events (from persistence layer)
  useEffect(() => {
    const handler = () => { void refreshPendingTransfers(); };
    window.addEventListener("bridge-transfers-updated", handler);
    return () => window.removeEventListener("bridge-transfers-updated", handler);
  }, [refreshPendingTransfers]);

  useEffect(() => {
    if (!address) return;

    let interval: ReturnType<typeof setInterval> | null = null;
    let lastPollTime = 0;

    const poll = () => {
      const now = Date.now();
      if (now - lastPollTime < 5000) return;
      lastPollTime = now;
      void refreshPendingTransfers();
      void probeBridgeAvailability();
    };

    const startPoll = () => {
      if (interval) return;
      const intervalMs = document.visibilityState !== "visible" ? 30000 : 12000;
      interval = setInterval(poll, intervalMs);
    };

    const stopPoll = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibilityChange = () => {
      stopPoll();
      if (document.visibilityState === "visible") {
        poll();
        startPoll();
      } else {
        startPoll();
      }
    };

    startPoll();
    poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", poll);

    return () => {
      stopPoll();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", poll);
    };
  }, [address, probeBridgeAvailability, refreshPendingTransfers]);

  useEffect(() => {
    let mounted = true;

    const runProbe = async () => {
      const ok = await probeBridgeAvailability();
      if (!mounted) return;
      setIsBridgeDbAvailable(ok);
      void refreshPendingTransfers();
    };

    void runProbe();

    const onFocus = () => { void runProbe(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runProbe();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mounted = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [probeBridgeAvailability, refreshPendingTransfers]);

  // Animate notification panel in/out (same pattern as TransactionHistory)
  useEffect(() => {
    if (notifOpen) {
      setNotifMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setNotifVisible(true)));
    } else {
      setNotifVisible(false);
      const t = setTimeout(() => setNotifMounted(false), 300);
      return () => clearTimeout(t);
    }
  }, [notifOpen]);

  // Escape key to close notification panel
  useEffect(() => {
    if (!notifOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setNotifOpen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [notifOpen]);

  // Listen for resume events
  // Keep a ref to the latest resumeTransfer so the stable event handler never
  // holds a stale closure (e.g. address captured as undefined on first render).
  const resumeTransferRef = useRef<(tx: PendingBridgeTransfer) => unknown>(() => {});
  useEffect(() => {
    resumeTransferRef.current = resumeTransfer;
  }); // runs after every render — intentionally no dep array

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PendingBridgeTransfer>).detail;
      if (detail) resumeTransferRef.current(detail);
    };
    window.addEventListener("bridge-resume-transfer", handler);
    return () => window.removeEventListener("bridge-resume-transfer", handler);
  }, []); // handler is stable; ref gives it access to the latest resumeTransfer

  const resumableCount = allTransfers.filter(
    (tx) => tx.status === "attesting" || tx.status === "ready_to_mint",
  ).length;

  const handleDismiss = async (id: string) => {
    const removed = await removeTransfer(id);
    if (!removed) {
      toast({
        title: "Unable to dismiss",
        description: "Only failed or completed transfers can be dismissed.",
        variant: "warning",
      });
      return;
    }
    void refreshPendingTransfers();
  };

  const getStatusInfo = (status: PendingBridgeTransfer["status"]) => {
    switch (status) {
      case "attesting": return { label: "Waiting for attestation", color: "#f59e0b", Icon: Clock };
      case "ready_to_mint": return { label: "Ready to mint", color: "#4ade80", Icon: Check };
      case "minting": return { label: "Minting...", color: "#818cf8", Icon: RotateCcw };
      case "complete": return { label: "Complete", color: "#4ade80", Icon: Check };
      case "failed": return { label: "Failed", color: "#f87171", Icon: AlertTriangle };
      default: return { label: status, color: "#818cf8", Icon: Clock };
    }
  };

  // ── Fetch USDC balance on source chain ──────────────────────────────────────
  const fetchBalance = useCallback(async () => {
    const fetchVersion = ++balanceFetchVersionRef.current;

    if (!address || !sourceChain) {
      setSourceBalance(null);
      setSourceBalanceRaw(null);
      setIsLoadingBalance(false);
      return;
    }
    setIsLoadingBalance(true);
    try {
      const provider = await getWorkingProvider(sourceChain);

      if (sourceChain.isNativeUSDC) {
        // Arc Testnet: USDC is the native gas token
        const nativeBal = await provider.getBalance(address);
        if (fetchVersion !== balanceFetchVersionRef.current) return;
        const formatted = Number(formatUnits(nativeBal, sourceChain.nativeCurrency.decimals)).toFixed(4);
        setSourceBalance(formatted);
        setSourceBalanceRaw(nativeBal);
      } else {
        // Standard ERC-20 USDC (6 decimals)
        const usdc = new Contract(sourceChain.usdcAddress, ERC20_ABI, provider);
        const bal: bigint = await usdc.balanceOf(address);
        if (fetchVersion !== balanceFetchVersionRef.current) return;
        const decimals = sourceChain.usdcDecimals;
        const formatted = Number(formatUnits(bal, decimals)).toFixed(decimals > 4 ? 4 : decimals);
        setSourceBalance(formatted);
        setSourceBalanceRaw(bal);
      }
    } catch (e) {
      if (fetchVersion !== balanceFetchVersionRef.current) return;
      console.error("Balance fetch error:", e);
      setSourceBalance(null);
      setSourceBalanceRaw(null);
    } finally {
      if (fetchVersion === balanceFetchVersionRef.current) {
        setIsLoadingBalance(false);
      }
    }
  }, [address, sourceChain]);

  // Poll balance every 8 seconds while connected
  useEffect(() => {
    if (!address || !sourceChain) {
      if (balanceIntervalRef.current) {
        clearInterval(balanceIntervalRef.current);
        balanceIntervalRef.current = null;
      }
      return;
    }

    fetchBalance();

    if (balanceIntervalRef.current) {
      clearInterval(balanceIntervalRef.current);
    }

    balanceIntervalRef.current = setInterval(() => {
      fetchBalance();
    }, 8000);

    return () => {
      if (balanceIntervalRef.current) {
        clearInterval(balanceIntervalRef.current);
        balanceIntervalRef.current = null;
      }
    };
  }, [address, sourceChain, fetchBalance]);

  // ── Swap source/dest ────────────────────────────────────────────────────────
  const handleSwapChains = () => {
    setSourceChain(destChain);
    setDestChain(sourceChain);
    setAmount("");
    setSourceBalance(null);
    setSourceBalanceRaw(null);
    setTransfer(INITIAL_STATE);
  };

  // ── Resume an interrupted transfer ──────────────────────────────────────────
  const resumeTransfer = async (pendingTx: PendingBridgeTransfer) => {
    if (!address || !window.ethereum) return;

    const srcChain = getChainByDomain(pendingTx.sourceDomain);
    const dstChain = getChainByDomain(pendingTx.destDomain);
    if (!srcChain || !dstChain) return;

    // Set the chains/amount in the UI
    setSourceChain(srcChain);
    setDestChain(dstChain);
    setAmount(pendingTx.amount);
    currentTransferIdRef.current = pendingTx.id;
    abortRef.current = false;

    try {
      if (pendingTx.status === "attesting") {
        let attestationResult: { message: string; attestation: string; destinationDomain: number };

        // If we already have attestation, use it directly (don't poll again)
        if (pendingTx.attestation?.message) {
          toast({ title: "Resuming transfer...", description: "Using existing attestation" });
          attestationResult = {
            message: pendingTx.attestation.message,
            attestation: pendingTx.attestation.attestation || pendingTx.attestation.message,
            destinationDomain: pendingTx.destDomain || 0,
          };
        } else {
          // Resume from attestation polling
          setTransfer({
            step: "attesting",
            burnTxHash: pendingTx.burnTxHash,
            mintTxHash: null,
            attestation: null,
            error: null,
          });

          toast({ title: "Resuming transfer...", description: "Polling for attestation" });
          attestationResult = await pollForAttestation(srcChain.domain, pendingTx.burnTxHash);
        }

        if (abortRef.current) return;

        const resolvedDst = resolveDestinationChain(
          attestationResult.destinationDomain,
          dstChain,
        );

        if (!resolvedDst) {
          throw new Error("Could not resolve destination chain from attestation");
        }

        await updateTransferStatus(pendingTx.id, {
          status: "ready_to_mint",
          attestation: { message: attestationResult.message, attestation: attestationResult.attestation },
          destDomain: resolvedDst.domain,
          destChainId: resolvedDst.chainId,
        });
        setDestChain(resolvedDst);
        setTransfer(prev => ({
          ...prev,
          step: "minting",
          attestation: { message: attestationResult.message, attestation: attestationResult.attestation },
        }));

        // Proceed to mint
        await executeMint(
          resolvedDst,
          { message: attestationResult.message, attestation: attestationResult.attestation },
          pendingTx.id,
          pendingTx.amount,
        );

      } else if (pendingTx.status === "ready_to_mint" && pendingTx.attestation) {
        // Resume from minting step
        setTransfer({
          step: "minting",
          burnTxHash: pendingTx.burnTxHash,
          mintTxHash: null,
          attestation: pendingTx.attestation,
          error: null,
        });

        await executeMint(dstChain, pendingTx.attestation, pendingTx.id, pendingTx.amount);
      }
    } catch (err: any) {
      console.error("Resume error:", err);
      const message = err?.message || err?.reason || "Unknown error";
      const isTimeout = /timeout/i.test(message);
      if (isTimeout) {
        // Keep transfer resumable — don't mark as failed
        await updateTransferStatus(pendingTx.id, { status: "attesting", error: message });
        setTransfer(prev => ({ ...prev, step: "error", error: message }));
      } else {
        await updateTransferStatus(pendingTx.id, { status: "failed", error: message });
        setTransfer(prev => ({ ...prev, step: "error", error: message }));
      }
      toast({
        title: isTimeout ? "Attestation Timed Out" : "Resume Failed",
        description: (isTimeout ? "You can retry later. " : "") +
          (message.length > 120 ? message.slice(0, 120) + "..." : message),
        variant: isTimeout ? "warning" : "destructive",
      });
    }
  };

  // ── Execute the mint step (shared by handleBridge and resumeTransfer) ──────
  const executeMint = async (
    dstChain: CCTPChain,
    attestation: { message: string; attestation: string },
    transferId: string,
    transferAmount: string,
  ) => {
    if (!window.ethereum) throw new Error("No wallet connected");

    await updateTransferStatus(transferId, { status: "minting" });

    try {
      await switchToChain(dstChain, "receive USDC");

      const destProvider = new BrowserProvider(window.ethereum);
      const destSigner = await destProvider.getSigner();
      const signerAddress = await destSigner.getAddress();

      toast({ title: "Minting USDC...", description: `On ${dstChain.name}` });
      const nonceAlreadyUsed = await detectClaimedAfterMintFailure(
        dstChain,
        attestation.message,
        destProvider,
      );
      if (nonceAlreadyUsed) {
        await updateTransferStatus(transferId, {
          status: "complete",
          attestation,
          error: undefined,
        });
        setTransfer(prev => ({
          ...prev,
          step: "complete",
          error: null,
        }));
        toast({
          title: "Already Claimed",
          description: "This transfer was already claimed on the destination chain.",
        });
        fetchBalance();
        return;
      }

      const { data, gasLimit } = await prepareMintTransaction(dstChain, signerAddress, attestation);
      const mintTx = await destSigner.sendTransaction({
        to: dstChain.messageTransmitterV2,
        data,
        gasLimit,
        maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
      });
      const mintReceipt = await mintTx.wait();

      if (!mintReceipt || mintReceipt.status !== 1) {
        const errorMsg = mintReceipt ? "Mint transaction failed" : "Failed to get mint receipt";
        await updateTransferStatus(transferId, { status: "failed", mintTxHash: mintReceipt?.hash });
        setTransfer(prev => ({ ...prev, step: "error", error: errorMsg }));
        toast({ title: "Mint Failed", description: errorMsg, variant: "destructive" });
        return;
      }

      await updateTransferStatus(transferId, {
        status: "complete",
        mintTxHash: mintReceipt.hash,
        attestation,
      });
      setTransfer(prev => ({
        ...prev,
        step: "complete",
        mintTxHash: mintReceipt.hash,
      }));

      toast({
        title: "Bridge Complete!",
        description: `${transferAmount} USDC bridged to ${dstChain.shortName}`,
      });

      fetchBalance();

    } catch (mintErr: any) {
      let walletProvider: BrowserProvider | undefined = undefined;
      if (window.ethereum) {
        const provider = new BrowserProvider(window.ethereum);
        const network = await provider.getNetwork();
        if (Number(network.chainId) === dstChain.chainId) {
          walletProvider = provider;
        }
      }
      const claimedOnDestination = await detectClaimedAfterMintFailure(
        dstChain,
        attestation.message,
        walletProvider,
      );
      if (claimedOnDestination || isAlreadyClaimedError(mintErr)) {
        await updateTransferStatus(transferId, {
          status: "complete",
          attestation,
          error: undefined,
        });
        setTransfer(prev => ({
          ...prev,
          step: "complete",
          error: null,
        }));
        toast({
          title: "Already Claimed",
          description: "This transfer was already claimed on the destination chain.",
        });
        fetchBalance();
        return;
      }

      // Mint failed or was cancelled — keep transfer resumable with attestation intact
      const signerAddress = address || "";
      const msg = await resolveMintErrorMessage(dstChain, signerAddress, attestation, mintErr);
      await updateTransferStatus(transferId, { status: "ready_to_mint", attestation, error: msg });
      setTransfer(prev => ({ ...prev, step: "error", error: msg }));
      toast({
        title: "Mint Failed — Your Funds Are Safe",
        description: "The attestation is saved. You can retry minting from the notifications panel.",
        variant: "warning",
      });
      // Don't re-throw — the transfer is recoverable, not lost
    }
  };

  // ── Manual claim: fetch attestation and mint from burn tx hash ──────────────────
  const handleManualClaim = async () => {
    const txHash = manualClaimTxHash.trim().toLowerCase();
    if (!txHash || !window.ethereum || !address) {
      toast({ title: "Missing required fields", variant: "destructive" });
      return;
    }
    if (!/^0x[a-f0-9]{64}$/.test(txHash)) {
      toast({ title: "Invalid transaction hash format", variant: "destructive" });
      return;
    }

    setManualClaimLoading(true);
    try {
      currentTransferIdRef.current = null;

      if (!manualClaimSourceChain) {
        throw new Error("Please select the source chain where the burn transaction was made");
      }

      // Validate and fetch tx info BEFORE closing modal
      const provider = await getWorkingProvider(manualClaimSourceChain);
      
      // Get transaction to verify sender
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        throw new Error("Transaction not found on the selected chain. Make sure you selected the correct source chain.");
      }
      
      // Check if the transaction was made by the connected wallet
      const txSender = (tx.from || "").toLowerCase();
      if (txSender !== address.toLowerCase()) {
        throw new Error(`Transaction was not made by your connected wallet. Please use the wallet that made the burn transaction.`);
      }

      const expectedDepositMethod = TOKEN_MESSENGER_V2_INTERFACE.getFunction("depositForBurn")
        ?.selector
        ?.toLowerCase();
      if (!expectedDepositMethod || !tx.data || tx.data.slice(0, 10).toLowerCase() !== expectedDepositMethod) {
        throw new Error("Transaction is not a CCTP depositForBurn transaction");
      }

      const expectedTokenMessenger = manualClaimSourceChain.tokenMessengerV2.toLowerCase();
      if (!tx.to || tx.to.toLowerCase() !== expectedTokenMessenger) {
        throw new Error("Transaction was not sent to the chain's TokenMessengerV2 contract");
      }

      // Get receipt for amount and success validation
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        throw new Error("Burn transaction failed on-chain");
      }

      let decodedDepositForBurn:
        | {
            amount: bigint;
            destinationDomain: number;
            mintRecipient: string;
          }
        | null = null;
      try {
        const parsedTx = TOKEN_MESSENGER_V2_INTERFACE.parseTransaction({ data: tx.data, value: tx.value ?? 0n });
          if (parsedTx && parsedTx.name === "depositForBurn") {
            decodedDepositForBurn = {
              amount: parsedTx.args[0] as bigint,
              destinationDomain: Number(parsedTx.args[1]),
              mintRecipient: String(parsedTx.args[2]),
            };
          }
      } catch (err) {
        console.error("Failed to decode depositForBurn transaction", {
          txHash,
          dataPrefix: tx.data?.slice(0, 10),
          error: err,
        });
        decodedDepositForBurn = null;
      }

      if (!decodedDepositForBurn || decodedDepositForBurn.amount <= 0n) {
        throw new Error("Unable to decode burn transaction amount");
      }

      const depositForBurnEvent = TOKEN_MESSENGER_V2_INTERFACE.getEvent("DepositForBurn");
      if (!depositForBurnEvent) {
        throw new Error("DepositForBurn event definition unavailable");
      }
      const depositForBurnTopic = depositForBurnEvent.topicHash;
      const burnEvent = receipt.logs.find((log) => {
        if (log.address.toLowerCase() !== expectedTokenMessenger) return false;
        if (!log.topics || log.topics.length === 0) return false;
        return log.topics[0].toLowerCase() === depositForBurnTopic.toLowerCase();
      });

      if (!burnEvent) {
        throw new Error("No TokenMessengerV2 DepositForBurn event found for this transaction");
      }

      let parsedBurnEvent:
        | {
            amount: bigint;
            depositor: string;
            destinationDomain: number;
            mintRecipient: string;
          }
        | null = null;
      try {
        const parsed = TOKEN_MESSENGER_V2_INTERFACE.parseLog({
          topics: burnEvent.topics,
          data: burnEvent.data,
        });
          if (parsed && parsed.name === "DepositForBurn") {
            parsedBurnEvent = {
              amount: parsed.args.amount as bigint,
              depositor: String(parsed.args.depositor),
              destinationDomain: Number(parsed.args.destinationDomain),
              mintRecipient: String(parsed.args.mintRecipient),
            };
          }
      } catch (err) {
        console.error("Failed to parse DepositForBurn event", {
          txHash,
          eventAddress: burnEvent.address,
          error: err,
        });
        parsedBurnEvent = null;
      }

      if (!parsedBurnEvent) {
        throw new Error("Failed to parse DepositForBurn event");
      }

      if (parsedBurnEvent.depositor.toLowerCase() !== address.toLowerCase()) {
        throw new Error("Burn event depositor does not match connected wallet");
      }
      if (parsedBurnEvent.amount !== decodedDepositForBurn.amount) {
        throw new Error("Burn event amount does not match transaction input");
      }
      if (parsedBurnEvent.destinationDomain !== decodedDepositForBurn.destinationDomain) {
        throw new Error("Burn event destination domain does not match transaction input");
      }

      const expectedMintRecipient = zeroPadValue(address, 32).toLowerCase();
      if (decodedDepositForBurn.mintRecipient.toLowerCase() !== expectedMintRecipient) {
        throw new Error("Burn transaction mint recipient does not match connected wallet");
      }
      if (parsedBurnEvent.mintRecipient.toLowerCase() !== expectedMintRecipient) {
        throw new Error("Burn event mint recipient does not match connected wallet");
      }

      let amount = "0";

      try {
        amount = (Number(decodedDepositForBurn.amount) / 1000000).toString();
      } catch {
        amount = "0";
      }
      
      // If still 0, try parsing logs for USDC Transfer (Transfer single from ERC1155 or Transfer from ERC20)
      if (amount === "0" && receipt && receipt.logs) {
        // Try USDC ERC20 Transfer event
        const usdcIface = new Interface([
          "event Transfer(address indexed from, address indexed to, uint256 value)"
        ]);
        // USDC on testnet typically at a known address, but we can try any Transfer to 0 address (burn)
        for (const log of receipt.logs) {
          if (log.topics && log.topics.length >= 3) {
            // Transfer(address,address,uint256) - topic[0] is signature
            // Check if it's a burn (to address is 0)
            try {
              const parsed = usdcIface.parseLog({ topics: log.topics, data: log.data });
              if (parsed && parsed.args.to === "0x0000000000000000000000000000000000000000") {
                const amountWei = parsed.args.value as bigint;
                amount = (Number(amountWei) / 1000000).toString();
                break;
              }
            } catch { continue; }
          }
        }
      }
      
      // Close modal and notification NOW that validation passed
      setManualClaimOpen(false);
      setNotifOpen(false);
      setManualClaimTxHash("");
      setManualClaimSourceChain(null);
      setManualClaimStatus("idle");

      // Use burn transaction destination as source of truth
      const decodedDestinationDomain = Number(decodedDepositForBurn.destinationDomain);
      const decodedDestinationChain = getChainByDomain(decodedDestinationDomain);
      if (!decodedDestinationChain) {
        throw new Error("Burn transaction destination chain is not supported");
      }

       let resolvedDestChain: CCTPChain | undefined = decodedDestinationChain;
      let attestation: { message: string; attestation: string } | undefined;

      try {
        // Fetch attestation
        const url = `${CCTP_ATTESTATION_API}/v2/messages/${manualClaimSourceChain.domain}?transactionHash=${txHash}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        
        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) {
          const data = await response.json();
          console.log("Circle API response:", JSON.stringify(data));
          
          if (data?.messages?.[0]) {
            const msg = data.messages[0];
            const apiDestinationDomain =
              typeof msg.destinationDomain === "number"
                ? msg.destinationDomain
                : Number(msg.destinationDomain);
            if (
              Number.isFinite(apiDestinationDomain) &&
              Number(apiDestinationDomain) !== decodedDestinationDomain
            ) {
              const errorMsg = `Destination domain mismatch: expected ${decodedDestinationDomain}, got ${apiDestinationDomain}`;
              setTransfer(prev => ({ ...prev, step: "error", error: errorMsg }));
              throw new Error(errorMsg);
            }

            if (msg.status === "complete" && msg.attestation) {
              attestation = {
                message: msg.message,
                attestation: msg.attestation,
              };
               
               // Extract amount from message if missing
               if (msg.message && amount === "0") {
                 const match = msg.message.match(/amount[:\s]+(\d+)/i);
                 if (match) amount = match[1];
               }
             }
          }
        }
      } catch (apiErr) {
        console.log("API fetch failed, will poll for attestation:", apiErr);
      }

      // Update UI like resume system does - IMMEDIATELY
      setSourceChain(manualClaimSourceChain);
      setDestChain(resolvedDestChain);
      setAmount(amount);
      abortRef.current = false;

      if (attestation) {
        // Has attestation - go to minting
        setTransfer({
          step: "minting",
          burnTxHash: txHash,
          mintTxHash: null,
          attestation: attestation,
          error: null,
        });

        await savePendingTransferWithProbe({
          id: txHash,
          burnTxHash: txHash,
          sourceDomain: manualClaimSourceChain.domain,
          sourceChainId: manualClaimSourceChain.chainId,
          destDomain: resolvedDestChain.domain,
          destChainId: resolvedDestChain.chainId,
          amount,
          userAddress: address,
          timestamp: Date.now(),
          status: "ready_to_mint",
          attestation,
        }, { strict: isBridgeDbAvailable });

        currentTransferIdRef.current = txHash;

        await executeMint(resolvedDestChain, attestation, txHash, amount);
      } else {
        // No attestation yet - go to attesting and poll
        setTransfer({
          step: "attesting",
          burnTxHash: txHash,
          mintTxHash: null,
          attestation: null,
          error: null,
        });

        await savePendingTransferWithProbe({
          id: txHash,
          burnTxHash: txHash,
          sourceDomain: manualClaimSourceChain.domain,
          sourceChainId: manualClaimSourceChain.chainId,
          destDomain: resolvedDestChain.domain,
          destChainId: resolvedDestChain.chainId,
          amount,
          userAddress: address,
          timestamp: Date.now(),
          status: "attesting",
        }, { strict: isBridgeDbAvailable });

        currentTransferIdRef.current = txHash;

        toast({ title: "Waiting for attestation...", description: "This may take 1-20 minutes" });
        
        const fetchedAttestationResult = await pollForAttestation(manualClaimSourceChain.domain, txHash);
        
        if (abortRef.current) return;

        if (
          typeof fetchedAttestationResult.destinationDomain === "number" &&
          fetchedAttestationResult.destinationDomain !== decodedDestinationDomain
        ) {
          await updateTransferStatus(txHash, {
            status: "attesting",
            error: "Attestation destination does not match burn transaction",
          });
          setTransfer(prev => ({ ...prev, step: "error", error: "Attestation destination does not match burn transaction" }));
          toast({
            title: "Destination mismatch",
            description: "Attestation destination does not match burn transaction",
            variant: "destructive",
          });
          return;
        }

        resolvedDestChain = resolveDestinationChain(
          decodedDestinationDomain,
          resolvedDestChain,
        );

      if (!resolvedDestChain) {
        await updateTransferStatus(txHash, {
            status: "attesting",
            error: "Attestation did not provide a valid destination chain",
          });
          setTransfer(prev => ({ ...prev, step: "error", error: "Attestation did not provide a valid destination chain" }));

          toast({
            title: "Destination unresolved",
            description: "Attestation did not provide a valid destination chain",
            variant: "destructive",
          });
          return;
        }
        
        await updateTransferStatus(txHash, {
          status: "ready_to_mint",
          attestation: {
            message: fetchedAttestationResult.message,
            attestation: fetchedAttestationResult.attestation,
          },
          destDomain: resolvedDestChain.domain,
          destChainId: resolvedDestChain.chainId,
        });
        
        // Use destination resolved from attestation when available
        setDestChain(resolvedDestChain);
        
        setTransfer(prev => ({
          ...prev,
          step: "minting",
          attestation: {
            message: fetchedAttestationResult.message,
            attestation: fetchedAttestationResult.attestation,
          },
        }));
        
        await executeMint(
          resolvedDestChain,
          {
            message: fetchedAttestationResult.message,
            attestation: fetchedAttestationResult.attestation,
          },
          txHash,
          amount,
        );
      }

      fetchBalance();

    } catch (err: any) {
      const msg = err?.message || "Manual claim failed";
      if (currentTransferIdRef.current === txHash) {
        let shouldDowngradeToAttesting = true;
        try {
          const latestTransfers = await fetchPendingTransfers(address);
          const persisted = latestTransfers.find((t) => t.id === currentTransferIdRef.current);
          if (persisted && getTransferStatusRank(persisted.status) > getTransferStatusRank("attesting")) {
            shouldDowngradeToAttesting = false;
          }
        } catch {
          const cached = getCachedPendingTransfersForWallet(address)
            .find((t) => t.id === currentTransferIdRef.current);
          if (cached && getTransferStatusRank(cached.status) > getTransferStatusRank("attesting")) {
            shouldDowngradeToAttesting = false;
          }
        }

        if (shouldDowngradeToAttesting) {
          await updateTransferStatus(currentTransferIdRef.current, {
            status: "attesting",
            error: msg,
          });
        }
      }
      setTransfer(prev => ({ ...prev, step: "error", error: msg }));
      toast({ title: "Claim Failed", description: msg, variant: "destructive" });
    } finally {
      setManualClaimLoading(false);
    }
  };

  // ── CCTP Bridge execution ──────────────────────────────────────────────────
  const handleBridge = async () => {
    if (!address || !window.ethereum || !amount || parseFloat(amount) <= 0) return;
    if (transfer.step !== "idle" && transfer.step !== "complete" && transfer.step !== "error") return;

    abortRef.current = false;
    currentTransferIdRef.current = null;
    setTransfer({ ...INITIAL_STATE, step: "approving" });

    try {
      const decimals = sourceChain.usdcDecimals; // always 6 for CCTP operations
      const amountWei = parseUnits(amount, decimals);

      const useFastTransferNow = useFastTransfer && sourceChain.supportsFastTransfer;
      const minFinalityThreshold = useFastTransferNow ? 1000 : 2000;

      let maxFee: bigint;
      if (useFastTransferNow) {
        let feeRateBps: number;
        try {
          feeRateBps = await getCCTPFeeRate(sourceChain.domain, destChain.domain);
        } catch (err) {
          console.error("Failed to fetch CCTP fee rate, using fallback:", err);
          feeRateBps = 5;
        }
        maxFee = amountWei * BigInt(feeRateBps) * 110n / 100n / 10000n;
      } else {
        maxFee = amountWei * 5n / 10000n;
      }

      // ── Check connected network & prompt switch ─────────────────────────
      const preProvider = new BrowserProvider(window.ethereum);
      const currentChainId = await preProvider.getNetwork().then(n => Number(n.chainId));
      if (currentChainId !== sourceChain.chainId) {
        await switchToChain(sourceChain, "continue");
      }

      // ── Create fresh provider/signer AFTER chain switch ─────────────────
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      // ── Step 1: Approve USDC ────────────────────────────────────────────
      toast({ title: "Approving USDC...", description: `On ${sourceChain.name}` });
      const usdcContract = new Contract(sourceChain.usdcAddress, ERC20_ABI, signer);
      const currentAllowance: bigint = await usdcContract.allowance(address, sourceChain.tokenMessengerV2);

      if (currentAllowance < amountWei) {
        const approveTx = await usdcContract.approve(sourceChain.tokenMessengerV2, amountWei, {
          maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
        });
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
        minFinalityThreshold,
        { maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS }
      );
      const burnReceipt = await burnTx.wait();
      const burnTxHash = burnReceipt.hash;

      if (abortRef.current) return;
      setTransfer(prev => ({ ...prev, step: "attesting", burnTxHash }));

      // ── Persist the transfer after successful burn ──────────────────────
      const transferId = burnTxHash;
      currentTransferIdRef.current = transferId;
      await savePendingTransferWithProbe({
        id: transferId,
        burnTxHash,
        sourceDomain: sourceChain.domain,
        sourceChainId: sourceChain.chainId,
        destDomain: destChain.domain,
        destChainId: destChain.chainId,
        amount,
        userAddress: address,
        timestamp: Date.now(),
        status: "attesting",
      }, { strict: isBridgeDbAvailable });

      fetchBalance();

      // ── Step 3: Poll for attestation ────────────────────────────────────
      toast({ title: "Waiting for attestation...", description: "This may take 1-20 minutes" });
      const attestationResult = await pollForAttestation(sourceChain.domain, burnTxHash);

      if (abortRef.current) return;

      const resolvedDestChain = resolveDestinationChain(
        attestationResult.destinationDomain,
        destChain,
      );

      if (!resolvedDestChain) {
        throw new Error("Could not resolve destination chain from attestation");
      }

      await updateTransferStatus(transferId, {
        status: "ready_to_mint",
        attestation: { message: attestationResult.message, attestation: attestationResult.attestation },
        destDomain: resolvedDestChain.domain,
        destChainId: resolvedDestChain.chainId,
      });
      setDestChain(resolvedDestChain);
      setTransfer(prev => ({
        ...prev,
        step: "minting",
        attestation: { message: attestationResult.message, attestation: attestationResult.attestation },
      }));

      // ── Step 4: Mint USDC on destination ────────────────────────────────
      await executeMint(
        resolvedDestChain,
        { message: attestationResult.message, attestation: attestationResult.attestation },
        transferId,
        amount,
      );

    } catch (err: any) {
      console.error("Bridge error:", err);
      const message = err?.message || err?.reason || "Unknown error";
      const isTimeout = /timeout/i.test(message);
      // Update persisted transfer if we have one
      if (currentTransferIdRef.current) {
        if (isTimeout) {
          // Keep transfer resumable — don't mark as failed
          await updateTransferStatus(currentTransferIdRef.current, { status: "attesting", error: message });
        } else {
          await updateTransferStatus(currentTransferIdRef.current, { status: "failed", error: message });
        }
      }
      setTransfer(prev => ({ ...prev, step: "error", error: message }));
      toast({
        title: isTimeout ? "Attestation Timed Out" : "Bridge Failed",
        description: (isTimeout ? "You can retry later. " : "") +
          (message.length > 120 ? message.slice(0, 120) + "..." : message),
        variant: isTimeout ? "warning" : "destructive",
      });
    }
  };

  // ── Attestation polling ────────────────────────────────────────────────────
  async function pollForAttestation(
    srcDomain: number,
    txHash: string
  ): Promise<AttestationPollResult> {
    const url = `${CCTP_ATTESTATION_API}/v2/messages/${srcDomain}?transactionHash=${txHash}`;
    const maxAttempts = 120; // ~10 minutes at 5s intervals
    const FETCH_TIMEOUT_MS = 10_000; // 10 seconds per request

    for (let i = 0; i < maxAttempts; i++) {
      if (abortRef.current) throw new Error("Transfer cancelled");

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) {
          const data = await res.json();
          if (data?.messages?.[0]?.status === "complete") {
            return {
              message: data.messages[0].message,
              attestation: data.messages[0].attestation,
              destinationDomain:
                typeof data.messages[0].destinationDomain === "number"
                  ? data.messages[0].destinationDomain
                  : undefined,
            };
          }
        }
      } catch { /* transient error or abort timeout — retry */ }

      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error("Attestation timeout — you can retry minting later with the burn tx hash");
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const parsedAmount = amount ? parseFloat(amount) : 0;
  const normalizedManualClaimTxHash = manualClaimTxHash.trim().toLowerCase();
  let insufficientBalance = false;
  if (parsedAmount > 0 && sourceBalanceRaw !== null && amount) {
    try {
      const amountWei = parseUnits(amount, sourceChain.usdcDecimals);
      insufficientBalance = amountWei > sourceBalanceRaw;
    } catch {
      // Invalid input (e.g. trailing dot) — don't flag as insufficient
    }
  }
  const canBridge = isConnected && amount && parsedAmount > 0 && !isTransferring && !insufficientBalance;
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

        /* notification bell */
        .br-hdr-right { display:flex; align-items:center; gap:8px; }
        .br-notif-btn { position:relative; width:34px; height:34px; border-radius:10px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.04); color:rgba(255,255,255,0.45); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all 0.2s; }
        .br-notif-btn:hover { background:rgba(255,255,255,0.1); color:rgba(255,255,255,0.85); border-color:rgba(255,255,255,0.16); }
        .br-notif-badge { position:absolute; top:-4px; right:-4px; min-width:16px; height:16px; padding:0 4px; border-radius:8px; background:#f59e0b; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:800; color:white; animation:pulse 2s infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
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
              <div className="br-hdr-right">
                <div className="br-powered">
                  <Shield style={{ width: 12, height: 12 }} />
                  <span>Powered by Circle CCTP</span>
                </div>
                <button
                  className="br-notif-btn"
                  onClick={() => setNotifOpen(true)}
                  title="Bridge transfers"
                >
                  <Bell style={{ width: 15, height: 15 }} />
                  {resumableCount > 0 && (
                    <span className="br-notif-badge">{resumableCount}</span>
                  )}
                </button>
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

              {/* Native USDC info for Arc */}
              {(sourceChain.isNativeUSDC || destChain.isNativeUSDC) && (
                <div style={{
                  marginTop: 10, padding: "8px 12px", borderRadius: 10,
                  background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.15)",
                  display: "flex", alignItems: "flex-start", gap: 8,
                }}>
                  <Shield style={{ width: 13, height: 13, color: "#818cf8", flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", lineHeight: 1.5 }}>
                    {sourceChain.isNativeUSDC
                      ? "Arc uses USDC as its native gas token. The bridge uses Arc's ERC-20 interface to burn USDC for cross-chain transfer."
                      : "USDC will arrive as native currency on Arc Testnet (used for both value and gas)."}
                  </span>
                </div>
              )}

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
                  ) : insufficientBalance ? (
                    <><AlertTriangle style={{ width: 18, height: 18 }} />Insufficient USDC Balance</>
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

      {/* Bridge Transfers Panel (full-screen modal — same pattern as TransactionHistory) */}
      {notifMounted && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setNotifOpen(false)}
            onTouchMove={(e) => e.preventDefault()}
            className="fixed inset-0 z-50 transition-all duration-300"
            style={{
              background: "rgba(0,0,0,0.72)",
              backdropFilter: notifVisible ? "blur(8px)" : "blur(0px)",
              opacity: notifVisible ? 1 : 0,
            }}
          />

          {/* Panel */}
          <div
            className="fixed z-50 left-0 right-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center sm:p-4"
            style={{ pointerEvents: "none" }}
          >
            <div
              data-bridge-history-panel
              className="relative w-full sm:max-w-md overflow-hidden"
              style={{
                pointerEvents: "auto",
                background: "linear-gradient(160deg, #0f1117 0%, #0c0e13 100%)",
                border: "1px solid rgba(255,255,255,0.07)",
                boxShadow: "0 -4px 48px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)",
                borderRadius: "20px 20px 0 0",
                transform: notifVisible ? "translateY(0)" : "translateY(100%)",
                opacity: notifVisible ? 1 : 0,
                transition: "transform 0.32s cubic-bezier(0.32,0.72,0,1), opacity 0.2s ease",
                maxHeight: "92dvh",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* Drag handle — mobile only */}
              <div className="flex justify-center pt-3 pb-1 sm:hidden">
                <div className="w-9 h-1 rounded-full bg-white/10" />
              </div>

              {/* Header */}
              <div className="flex items-center justify-between px-5 pt-4 pb-3 sm:pt-5 flex-shrink-0">
                <div>
                  <h2 className="text-base font-semibold text-white tracking-tight">
                    Bridge Transfers
                  </h2>
                  <p className="text-[11px] text-white/30 mt-0.5">
                    {allTransfers.length === 0
                      ? "No transfers yet"
                      : `${allTransfers.length} transfer${allTransfers.length !== 1 ? "s" : ""}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setManualClaimOpen(true)}
                    className="text-[11px] font-bold px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all"
                    style={{
                      color: "#60a5fa",
                      background: "rgba(96,165,250,0.1)",
                      border: "1px solid rgba(96,165,250,0.25)",
                    }}
                  >
                    <Zap className="w-3 h-3" />
                    Manual Claim
                  </button>

                  {/* Reconcile button */}
                  <button
                    onClick={async () => {
                      if (reconciling || !address) return;
                      setReconciling(true);
                      try {
                        await reconcileAllPendingTransfers(address);
                        void refreshPendingTransfers();
                        toast({
                          title: "Reconciliation complete",
                          description: "Checked pending transfers against blockchain",
                        });
                      } catch (err: any) {
                        toast({
                          title: "Reconciliation failed",
                          description: err?.message || "Unknown error",
                          variant: "destructive",
                        });
                      } finally {
                        setReconciling(false);
                      }
                    }}
                    disabled={reconciling || !address}
                    className="text-[11px] font-bold px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all disabled:opacity-50"
                    style={{
                      color: "#4ade80",
                      background: "rgba(74,222,128,0.1)",
                      border: "1px solid rgba(74,222,128,0.25)",
                    }}
                  >
                    <RotateCcw className={`w-3 h-3 ${reconciling ? "animate-spin" : ""}`} />
                    {reconciling ? "Reconciling..." : "Reconcile"}
                  </button>

                  {allTransfers.length > 0 && (
                    <button
                      onClick={async () => {
                        const results = await Promise.all(
                          allTransfers.map(async (tx) => removeTransfer(tx.id)),
                        );
                        const removedCount = results.filter(Boolean).length;
                        const total = allTransfers.length;
                        if (removedCount !== total) {
                          toast({
                            title: "Some transfers were kept",
                            description: `${removedCount}/${total} dismissed. Pending transfers stay until completion.`,
                            variant: "warning",
                          });
                        }
                        void refreshPendingTransfers();
                      }}
                      title="Clear all"
                      className="w-8 h-8 rounded-xl flex items-center justify-center text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-all"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => setNotifOpen(false)}
                    className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Divider */}
              <div className="mx-5 h-px flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }} />

              {/* Scrollable content */}
              <div
                className="flex-1 overflow-y-auto overscroll-contain px-5 py-4"
                style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
              >
                {allTransfers.length === 0 && transferHistory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <div
                      className="w-14 h-14 rounded-2xl flex items-center justify-center"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
                    >
                      <Clock className="w-6 h-6 text-white/15" />
                    </div>
                    <p className="text-sm text-white/30">No pending transfers</p>
                    <p className="text-[11px] text-white/20">Completed transfers appear in history</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {allTransfers.map((tx, i) => {
                      const srcChain = getChainByDomain(tx.sourceDomain);
                      const dstChain = getChainByDomain(tx.destDomain);
                      const { label, color, Icon } = getStatusInfo(tx.status);
                      const age = Date.now() - tx.timestamp;
                      const ageStr = age < 60000 ? "<1m ago"
                        : age < 3600000 ? `${Math.floor(age / 60000)}m ago`
                        : age < 86400000 ? `${Math.floor(age / 3600000)}h ago`
                        : `${Math.floor(age / 86400000)}d ago`;
                      const canResume = tx.status === "attesting" || tx.status === "ready_to_mint";
                      const canDismiss = tx.status === "complete" || tx.status === "failed";

                      return (
                        <div
                          key={tx.id}
                          className="rounded-2xl p-4 transition-all"
                          style={{
                            background: "rgba(255,255,255,0.025)",
                            border: "1px solid rgba(255,255,255,0.06)",
                            animationDelay: `${i * 40}ms`,
                          }}
                        >
                          {/* Top row: route + age */}
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-1.5">
                              <Clock className="w-3 h-3 text-white/20" />
                              <span className="text-[11px] text-white/30 font-medium">{ageStr}</span>
                            </div>
                            {tx.burnTxHash && srcChain && (
                              <a
                                href={`${srcChain.explorerUrl}/tx/${tx.burnTxHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="View on explorer"
                                className="w-6 h-6 rounded-lg flex items-center justify-center text-white/25 hover:text-indigo-400 hover:bg-indigo-500/10 transition-all"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>

                          {/* Route row */}
                          <div className="flex items-center gap-3">
                            {/* Source chain */}
                            <div className="flex items-center gap-2.5 flex-1 min-w-0">
                              <div
                                className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center"
                                style={{
                                  background: `linear-gradient(135deg, ${srcChain?.color || "#666"}33, ${srcChain?.color || "#666"}66)`,
                                  boxShadow: "0 0 0 1px rgba(255,255,255,0.08)",
                                }}
                              >
                                {srcChain?.logo ? (
                                  <img src={srcChain.logo} alt={srcChain.shortName} className="w-full h-full object-cover" />
                                ) : (
                                  <span style={{ fontSize: 14, fontWeight: 800, color: srcChain?.color || "#888" }}>
                                    {srcChain?.shortName.charAt(0) || "?"}
                                  </span>
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-white tabular-nums">{tx.amount}</p>
                                <p className="text-[11px] text-white/35 truncate">{srcChain?.shortName || "Unknown"}</p>
                              </div>
                            </div>

                            {/* Arrow */}
                            <div
                              className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
                              style={{ background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)" }}
                            >
                              <ArrowRight className="w-3.5 h-3.5 text-indigo-400" />
                            </div>

                            {/* Dest chain */}
                            <div className="flex items-center gap-2.5 flex-1 min-w-0 justify-end">
                              <div className="min-w-0 text-right">
                                <p className="text-sm font-semibold text-white tabular-nums">USDC</p>
                                <p className="text-[11px] text-white/35 truncate">{dstChain?.shortName || "Unknown"}</p>
                              </div>
                              <div
                                className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center"
                                style={{
                                  background: `linear-gradient(135deg, ${dstChain?.color || "#666"}33, ${dstChain?.color || "#666"}66)`,
                                  boxShadow: "0 0 0 1px rgba(255,255,255,0.08)",
                                }}
                              >
                                {dstChain?.logo ? (
                                  <img src={dstChain.logo} alt={dstChain.shortName} className="w-full h-full object-cover" />
                                ) : (
                                  <span style={{ fontSize: 14, fontWeight: 800, color: dstChain?.color || "#888" }}>
                                    {dstChain?.shortName.charAt(0) || "?"}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Status + actions row */}
                          <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                            <div className="flex items-center gap-1.5" style={{ color }}>
                              <Icon className="w-3 h-3" />
                              <span className="text-[11px] font-semibold">{label}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {canResume && (
                                <button
                                  onClick={() => { setNotifOpen(false); resumeTransfer(tx); }}
                                  disabled={isTransferring}
                                  className="text-[11px] font-bold px-3 py-1 rounded-lg flex items-center gap-1.5 transition-all"
                                  style={{
                                    color: "#4ade80",
                                    background: "rgba(74,222,128,0.1)",
                                    border: "1px solid rgba(74,222,128,0.25)",
                                    cursor: isTransferring ? "not-allowed" : "pointer",
                                    opacity: isTransferring ? 0.5 : 1,
                                  }}
                                >
                                  <RotateCcw className="w-2.5 h-2.5" />
                                  Resume
                                </button>
                              )}
                              {canDismiss && (
                                <button
                                  onClick={async () => handleDismiss(tx.id)}
                                  className="text-[11px] text-white/30 px-2 py-1 rounded-lg hover:text-white/50 hover:bg-white/5 transition-all"
                                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
                                >
                                  Dismiss
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {transferHistory.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 mt-6 mb-3">
                      <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.06)" }} />
                      <span className="text-[11px] text-white/30 font-medium uppercase tracking-wider">History</span>
                      <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.06)" }} />
                    </div>
                    <div className="space-y-2.5">
                      {transferHistory.map((tx, i) => {
                        const srcChain = getChainByDomain(tx.sourceDomain);
                        const dstChain = getChainByDomain(tx.destDomain);
                        const { label, color, Icon } = getStatusInfo(tx.status);
                        const age = Date.now() - (tx.updatedAt || tx.timestamp);
                        const ageStr = age < 60000 ? "<1m ago"
                          : age < 3600000 ? `${Math.floor(age / 60000)}m ago`
                          : age < 86400000 ? `${Math.floor(age / 3600000)}h ago`
                          : `${Math.floor(age / 86400000)}d ago`;
                        const canDismiss = tx.status === "complete" || tx.status === "failed";

                        return (
                          <div
                            key={tx.id}
                            className="rounded-2xl p-4 transition-all opacity-60 hover:opacity-80"
                            style={{
                              background: "rgba(255,255,255,0.015)",
                              border: "1px solid rgba(255,255,255,0.04)",
                            }}
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${srcChain?.color || "#666"}33, ${srcChain?.color || "#666"}66)` }}>
                                {srcChain?.logo ? <img src={srcChain.logo} alt={srcChain.shortName} className="w-full h-full object-cover" /> : <span style={{ fontSize: 14, fontWeight: 800, color: srcChain?.color || "#888" }}>{srcChain?.shortName.charAt(0) || "?"}</span>}
                              </div>
                              <ArrowRight className="w-4 h-4 text-white/20" />
                              <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${dstChain?.color || "#666"}33, ${dstChain?.color || "#666"}66)` }}>
                                {dstChain?.logo ? <img src={dstChain.logo} alt={dstChain.shortName} className="w-full h-full object-cover" /> : <span style={{ fontSize: 14, fontWeight: 800, color: dstChain?.color || "#888" }}>{dstChain?.shortName.charAt(0) || "?"}</span>}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-white truncate">{tx.amount} USDC</p>
                                <p className="text-[11px] text-white/30 truncate">{ageStr}</p>
                              </div>
                              <div className="flex items-center gap-1.5" style={{ color }}>
                                <Icon className="w-3 h-3" />
                                <span className="text-[11px] font-semibold">{label}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {/* Bottom safe area */}
                <div className="h-safe-area-bottom h-4 sm:h-2" />
              </div>
            </div>
          </div>

          <style>{`
            @media (min-width: 640px) {
              [data-bridge-history-panel] {
                border-radius: 20px !important;
                transform: ${notifVisible ? "translateY(0) scale(1)" : "translateY(12px) scale(0.97)"} !important;
              }
            }
            [data-bridge-history-panel] ::-webkit-scrollbar { display: none; }
          `}</style>
        </>
      )}

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

      {/* Manual Claim Modal */}
      {manualClaimOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => {
              setManualClaimOpen(false);
              setManualClaimTxHash("");
              setManualClaimSourceChain(null);
              setManualClaimDestChain(null);
              setManualClaimAttestation(null);
              setManualClaimStatus("idle");
            }}
            className="fixed inset-0 z-50"
            style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(8px)" }}
          />
          {/* Modal */}
          <div className="fixed z-50 inset-0 flex items-center justify-center p-4">
            <div
              className="relative w-full max-w-md overflow-hidden"
              style={{
                background: "linear-gradient(160deg, #0f1117 0%, #0c0e13 100%)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 20,
                padding: 24,
              }}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-white">Manual Claim</h2>
                  <p className="text-[11px] text-white/40 mt-1">Claim USDC using a burn transaction hash</p>
                </div>
                <button
                  onClick={() => {
              setManualClaimOpen(false);
              setManualClaimTxHash("");
              setManualClaimSourceChain(null);
              setManualClaimDestChain(null);
              setManualClaimAttestation(null);
              setManualClaimStatus("idle");
            }}
                  className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Form */}
              <div className="space-y-4">
                {/* Source Chain Selector */}
                <div>
                  <label className="text-[11px] font-medium text-white/60 mb-1.5 block">Source Chain (where you burned USDC)</label>
                  <select
                    value={String(manualClaimSourceChain?.domain ?? "")}
                    onChange={(e) => {
                      if (e.target.value === "") {
                        setManualClaimSourceChain(null);
                      } else {
                        const chain = CCTP_TESTNET_CHAINS.find(c => c.domain === Number(e.target.value));
                        setManualClaimSourceChain(chain || null);
                      }
                    }}
                    className="w-full px-3 py-2.5 rounded-xl text-sm text-white bg-white/5 border border-white/10 focus:border-indigo-500/50 focus:outline-none"
                  >
                    <option value="">Select source chain</option>
                    {CCTP_TESTNET_CHAINS.map(chain => (
                      <option key={chain.domain} value={chain.domain}>{chain.name}</option>
                    ))}
                  </select>
                </div>

                {/* Burn Tx Hash */}
                <div>
                  <label className="text-[11px] font-medium text-white/60 mb-1.5 block">Burn Transaction Hash</label>
                  <input
                    type="text"
                    value={manualClaimTxHash}
                    onChange={(e) => {
                      const normalized = e.target.value.trim().toLowerCase();
                      setManualClaimTxHash(normalized);
                      setManualClaimTxHashValid(/^0x[a-f0-9]{64}$/.test(normalized));
                    }}
                    placeholder="0x..."
                    className={`w-full px-3 py-2.5 rounded-xl text-sm text-white bg-white/5 border focus:outline-none placeholder:text-white/20 ${
                      normalizedManualClaimTxHash && !manualClaimTxHashValid ? "border-red-500 focus:border-red-500" : "border-white/10 focus:border-indigo-500/50"
                    }`}
                  />
                  {normalizedManualClaimTxHash && !manualClaimTxHashValid && (
                    <p className="text-[10px] text-red-400 mt-1">Invalid transaction hash format</p>
                  )}
                </div>

                {/* Submit */}
                <button
                  onClick={handleManualClaim}
                  disabled={!normalizedManualClaimTxHash || !manualClaimTxHashValid || !manualClaimSourceChain || manualClaimLoading || !address}
                  className="w-full py-3 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2"
                  style={{
                    background: normalizedManualClaimTxHash && manualClaimTxHashValid && manualClaimSourceChain && !manualClaimLoading && address
                      ? "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)"
                      : "rgba(99,102,241,0.3)",
                    color: normalizedManualClaimTxHash && manualClaimTxHashValid && manualClaimSourceChain && !manualClaimLoading && address ? "white" : "rgba(255,255,255,0.3)",
                    cursor: normalizedManualClaimTxHash && manualClaimTxHashValid && manualClaimSourceChain && !manualClaimLoading && address ? "pointer" : "not-allowed",
                  }}
                >
                  {manualClaimLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4" />
                      Resume Transfer
                    </>
                  )}
                </button>

                {!address && (
                  <p className="text-[11px] text-center text-amber-400">Connect wallet to claim</p>
                )}
                <p className="text-[10px] text-center text-white/30">Enter the burn tx hash to resume your transfer</p>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
