import { useEffect, useState } from "react";
import { X, ExternalLink, ArrowRight, Clock, Trash2 } from "lucide-react";
import { useChainId } from "wagmi";
import { getContractsForChain } from "@/lib/contracts";
import type { Token } from "@shared/schema";

interface Transaction {
  id: string;
  fromToken: Token;
  toToken: Token;
  fromAmount: string;
  toAmount: string;
  timestamp: number;
  chainId: number;
}

interface TransactionHistoryProps {
  open: boolean;
  onClose: () => void;
}

export function TransactionHistory({ open, onClose }: TransactionHistoryProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const chainId = useChainId();

  // Animate in/out — same pattern as SwapSettings & TokenSelector
  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Load transactions whenever panel opens
  useEffect(() => {
    if (open && chainId) {
      const stored = localStorage.getItem(`transactions_${chainId}`);
      setTransactions(stored ? JSON.parse(stored) : []);
    }
  }, [open, chainId]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const clearHistory = () => {
    if (!chainId) return;
    localStorage.removeItem(`transactions_${chainId}`);
    setTransactions([]);
  };

  const openExplorer = (txHash: string) => {
    const contracts = chainId ? getContractsForChain(chainId) : null;
    if (contracts) window.open(`${contracts.explorer}${txHash}`, "_blank");
  };

  const formatTime = (timestamp: number) => {
    const diffMins = Math.floor((Date.now() - timestamp) / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  };

  if (!mounted) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        onTouchMove={(e) => e.preventDefault()}
        className="fixed inset-0 z-50 transition-all duration-300"
        style={{
          background: "rgba(0,0,0,0.72)",
          backdropFilter: visible ? "blur(8px)" : "blur(0px)",
          opacity: visible ? 1 : 0,
        }}
      />

      {/* Panel */}
      <div
        className="fixed z-50 left-0 right-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center sm:p-4"
        style={{ pointerEvents: "none" }}
      >
        <div
          data-history-panel
          className="relative w-full sm:max-w-md overflow-hidden"
          style={{
            pointerEvents: "auto",
            background: "linear-gradient(160deg, #0f1117 0%, #0c0e13 100%)",
            border: "1px solid rgba(255,255,255,0.07)",
            boxShadow: "0 -4px 48px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)",
            borderRadius: "20px 20px 0 0",
            transform: visible ? "translateY(0)" : "translateY(100%)",
            opacity: visible ? 1 : 0,
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
                Transaction History
              </h2>
              <p className="text-[11px] text-white/30 mt-0.5">
                {transactions.length === 0
                  ? "No swaps yet"
                  : `${transactions.length} swap${transactions.length !== 1 ? "s" : ""} on this chain`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {transactions.length > 0 && (
                <button
                  onClick={clearHistory}
                  title="Clear history"
                  className="w-8 h-8 rounded-xl flex items-center justify-center text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={onClose}
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
            {transactions.length === 0 ? (
              /* Empty state */
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <Clock className="w-6 h-6 text-white/15" />
                </div>
                <p className="text-sm text-white/30">No transactions yet</p>
                <p className="text-[11px] text-white/20">Your swap history will appear here</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {transactions.map((tx, i) => (
                  <TxRow
                    key={tx.id}
                    tx={tx}
                    index={i}
                    formatTime={formatTime}
                    onOpenExplorer={() => openExplorer(tx.id)}
                  />
                ))}
              </div>
            )}

            {/* Bottom safe area */}
            <div className="h-safe-area-bottom h-4 sm:h-2" />
          </div>
        </div>
      </div>

      <style>{`
        @media (min-width: 640px) {
          [data-history-panel] {
            border-radius: 20px !important;
            transform: ${visible ? "translateY(0) scale(1)" : "translateY(12px) scale(0.97)"} !important;
          }
        }
        [data-history-panel] ::-webkit-scrollbar { display: none; }
      `}</style>
    </>
  );
}

// ─── Transaction Row ───────────────────────────────────────────────────────────

function TxRow({
  tx,
  index,
  formatTime,
  onOpenExplorer,
}: {
  tx: Transaction;
  index: number;
  formatTime: (ts: number) => string;
  onOpenExplorer: () => void;
}) {
  const [fromImgError, setFromImgError] = useState(false);
  const [toImgError, setToImgError] = useState(false);

  return (
    <div
      className="rounded-2xl p-4 transition-all"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.06)",
        animationDelay: `${index * 40}ms`,
      }}
    >
      {/* Top row: timestamp + explorer link */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-white/20" />
          <span className="text-[11px] text-white/30 font-medium">{formatTime(tx.timestamp)}</span>
        </div>
        <button
          onClick={onOpenExplorer}
          title="View on explorer"
          className="w-6 h-6 rounded-lg flex items-center justify-center text-white/25 hover:text-indigo-400 hover:bg-indigo-500/10 transition-all"
        >
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      {/* Token swap row */}
      <div className="flex items-center gap-3">
        {/* From */}
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <div
            className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0"
            style={{ boxShadow: "0 0 0 1px rgba(255,255,255,0.08)" }}
          >
            <img
              src={!fromImgError && tx.fromToken.logoURI ? tx.fromToken.logoURI : "/img/logos/unknown-token.png"}
              alt={tx.fromToken.symbol}
              className="w-full h-full object-cover"
              onError={() => setFromImgError(true)}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white tabular-nums">
              {parseFloat(tx.fromAmount).toFixed(4)}
            </p>
            <p className="text-[11px] text-white/35 truncate">{tx.fromToken.symbol}</p>
          </div>
        </div>

        {/* Arrow */}
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)" }}
        >
          <ArrowRight className="w-3.5 h-3.5 text-indigo-400" />
        </div>

        {/* To */}
        <div className="flex items-center gap-2.5 flex-1 min-w-0 justify-end">
          <div className="min-w-0 text-right">
            <p className="text-sm font-semibold text-white tabular-nums">
              {parseFloat(tx.toAmount).toFixed(4)}
            </p>
            <p className="text-[11px] text-white/35 truncate">{tx.toToken.symbol}</p>
          </div>
          <div
            className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0"
            style={{ boxShadow: "0 0 0 1px rgba(255,255,255,0.08)" }}
          >
            <img
              src={!toImgError && tx.toToken.logoURI ? tx.toToken.logoURI : "/img/logos/unknown-token.png"}
              alt={tx.toToken.symbol}
              className="w-full h-full object-cover"
              onError={() => setToImgError(true)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
