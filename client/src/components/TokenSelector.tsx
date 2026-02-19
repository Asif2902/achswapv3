import { useState, useMemo, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Search, CheckCircle2, AlertCircle, X, Zap, TrendingUp } from "lucide-react";
import { useAccount, useBalance } from "wagmi";
import { isAddress } from "ethers";
import type { Token } from "@shared/schema";
import { formatAmount } from "@/lib/decimal-utils";

interface TokenSelectorProps {
  open: boolean;
  onClose: () => void;
  onSelect: (token: Token) => void;
  tokens: Token[];
  onImport?: (address: string) => Promise<Token | null>;
}

export function TokenSelector({ open, onClose, onSelect, tokens, onImport }: TokenSelectorProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { address: userAddress } = useAccount();

  // Animate in/out
  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      setTimeout(() => inputRef.current?.focus(), 120);
    } else {
      setVisible(false);
      const t = setTimeout(() => {
        setMounted(false);
        setSearchQuery("");
        setImportError("");
      }, 300);
      return () => clearTimeout(t);
    }
  }, [open]);

  const filteredTokens = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return tokens;
    return tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address.toLowerCase().includes(q),
    );
  }, [tokens, searchQuery]);

  const isValidAddress = Boolean(searchQuery.trim() && isAddress(searchQuery.trim()));
  const tokenExists =
    isValidAddress &&
    tokens.find((t) => t.address.toLowerCase() === searchQuery.trim().toLowerCase());
  const showImportButton = isValidAddress && !tokenExists;

  const handleImport = async () => {
    if (!onImport || !searchQuery.trim()) return;
    setIsImporting(true);
    setImportError("");
    try {
      const token = await onImport(searchQuery.trim());
      if (token) {
        onSelect(token);
        setSearchQuery("");
      }
    } catch (err: any) {
      setImportError(err.message || "Failed to import token");
    } finally {
      setIsImporting(false);
    }
  };

  const handleSelect = (token: Token) => {
    onSelect(token);
    setSearchQuery("");
    setImportError("");
  };

  if (!mounted) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-50 transition-all duration-300"
        style={{
          background: "rgba(0,0,0,0.7)",
          backdropFilter: visible ? "blur(8px)" : "blur(0px)",
          opacity: visible ? 1 : 0,
        }}
      />

      {/* Panel — bottom sheet on mobile, centered modal on sm+ */}
      <div
        className="fixed z-50 left-0 right-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center sm:p-4"
        style={{ pointerEvents: "none" }}
      >
        <div
          className="relative w-full sm:max-w-md sm:rounded-2xl overflow-hidden"
          style={{
            pointerEvents: "auto",
            background: "linear-gradient(145deg, #0f1117 0%, #0d0f14 100%)",
            border: "1px solid rgba(255,255,255,0.07)",
            boxShadow: "0 -4px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
            borderRadius: "20px 20px 0 0",
            transform: visible
              ? "translateY(0) scale(1)"
              : "translateY(100%) scale(1)",
            opacity: visible ? 1 : 0,
            transition: "transform 0.32s cubic-bezier(0.32,0.72,0,1), opacity 0.2s ease",
            maxHeight: "92dvh",
            display: "flex",
            flexDirection: "column",
          }}
          // Desktop override via media query workaround via inline + class
        >
          {/* Drag handle — mobile only */}
          <div className="flex justify-center pt-3 pb-1 sm:hidden">
            <div className="w-9 h-1 rounded-full bg-white/10" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3 sm:pt-5 flex-shrink-0">
            <div>
              <h2 className="text-base font-semibold text-white tracking-tight">Select token</h2>
              <p className="text-[11px] text-white/30 mt-0.5">{tokens.length} tokens available</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Search */}
          <div className="px-5 pb-3 flex-shrink-0">
            <div
              className="relative group"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12,
                transition: "border-color 0.2s",
              }}
              onFocusCapture={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(99,102,241,0.5)";
                (e.currentTarget as HTMLDivElement).style.boxShadow =
                  "0 0 0 3px rgba(99,102,241,0.12)";
              }}
              onBlurCapture={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.08)";
                (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
              }}
            >
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
              <input
                ref={inputRef}
                data-testid="input-token-search"
                placeholder="Search name or paste address…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-transparent pl-10 pr-4 py-3 text-sm text-white placeholder:text-white/25 outline-none"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white/10 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/20 transition-all"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Import warning */}
          {showImportButton && (
            <div className="mx-5 mb-3 flex-shrink-0 rounded-xl overflow-hidden"
              style={{
                background: "rgba(234,179,8,0.06)",
                border: "1px solid rgba(234,179,8,0.2)",
              }}
            >
              <div className="flex items-start gap-3 p-3.5">
                <div className="w-7 h-7 rounded-lg bg-yellow-500/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <AlertCircle className="w-3.5 h-3.5 text-yellow-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-yellow-300">Unknown token</p>
                  <p className="text-[11px] text-yellow-400/60 mt-0.5 leading-relaxed">
                    Not in the active token list. Import at your own risk.
                  </p>
                  {importError && (
                    <p className="text-[11px] text-red-400 mt-1">{importError}</p>
                  )}
                </div>
                <button
                  data-testid="button-import-token"
                  onClick={handleImport}
                  disabled={isImporting}
                  className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50"
                  style={{
                    background: "rgba(234,179,8,0.15)",
                    border: "1px solid rgba(234,179,8,0.3)",
                    color: "#fde047",
                  }}
                >
                  {isImporting ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 border border-yellow-400/30 border-t-yellow-400 rounded-full animate-spin" />
                      Importing
                    </span>
                  ) : (
                    "Import"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Import error (standalone) */}
          {importError && !showImportButton && (
            <div className="mx-5 mb-3 flex-shrink-0 px-3.5 py-2.5 rounded-xl text-xs text-red-300 flex items-center gap-2"
              style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
            >
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {importError}
            </div>
          )}

          {/* Divider */}
          <div className="mx-5 h-px flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }} />

          {/* Token list */}
          <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-2"
            style={{ scrollbarWidth: "none" }}
          >
            {filteredTokens.length === 0 && !showImportButton ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
                  style={{ background: "rgba(255,255,255,0.04)" }}
                >
                  <Search className="w-5 h-5 text-white/20" />
                </div>
                <p className="text-sm text-white/30">No tokens found</p>
              </div>
            ) : (
              filteredTokens.map((token, i) => (
                <TokenRow
                  key={token.address}
                  token={token}
                  userAddress={userAddress}
                  index={i}
                  onClick={() => handleSelect(token)}
                />
              ))
            )}
            {/* Bottom safe area spacer for mobile */}
            <div className="h-safe-area-bottom h-4 sm:h-2" />
          </div>
        </div>
      </div>

      {/* Desktop: fix border radius */}
      <style>{`
        @media (min-width: 640px) {
          [data-token-panel] {
            border-radius: 20px !important;
            transform: ${visible ? "translateY(0) scale(1)" : "translateY(12px) scale(0.97)"} !important;
          }
        }
      `}</style>
    </>
  );
}

function TokenRow({
  token,
  userAddress,
  index,
  onClick,
}: {
  token: Token;
  userAddress?: string;
  index: number;
  onClick: () => void;
}) {
  const isNativeToken = token.address === "0x0000000000000000000000000000000000000000";
  const { data: balance } = useBalance({
    address: userAddress as `0x${string}` | undefined,
    ...(isNativeToken ? {} : { token: token.address as `0x${string}` }),
  });

  let displayBalance = "";
  try {
    if (balance && userAddress) {
      const formatted = formatAmount(balance.value, balance.decimals);
      const num = parseFloat(formatted);
      displayBalance = num > 0
        ? num < 0.0001
          ? "<0.0001"
          : num >= 1000
          ? num.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : formatted
        : "";
    }
  } catch {}

  const [imgError, setImgError] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <button
      data-testid={`button-select-token-${token.symbol}`}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all text-left relative group"
      style={{
        background: hovered ? "rgba(255,255,255,0.05)" : "transparent",
        animationDelay: `${index * 18}ms`,
      }}
    >
      {/* Hover accent bar */}
      <div
        className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full transition-all duration-150"
        style={{
          background: "linear-gradient(180deg, #6366f1, #8b5cf6)",
          opacity: hovered ? 1 : 0,
          transform: hovered ? "scaleY(1)" : "scaleY(0.4)",
        }}
      />

      <div className="flex items-center gap-3 min-w-0 pl-1.5">
        {/* Token logo */}
        <div className="relative flex-shrink-0">
          <div
            className="w-9 h-9 rounded-full overflow-hidden"
            style={{
              boxShadow: hovered ? "0 0 0 2px rgba(99,102,241,0.4)" : "0 0 0 1px rgba(255,255,255,0.08)",
              transition: "box-shadow 0.15s",
            }}
          >
            <img
              src={!imgError && token.logoURI ? token.logoURI : "/img/logos/unknown-token.png"}
              alt={token.symbol}
              className="w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          </div>
          {token.verified && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center"
              style={{ background: "#0f1117", boxShadow: "0 0 0 1px rgba(255,255,255,0.06)" }}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-blue-500 flex items-center justify-center">
                <CheckCircle2 className="w-2 h-2 text-white" data-testid={`icon-verified-${token.symbol}`} />
              </div>
            </div>
          )}
        </div>

        {/* Token info */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-sm text-white tracking-tight">{token.symbol}</span>
            {!token.verified && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  color: "rgba(255,255,255,0.3)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                unverified
              </span>
            )}
          </div>
          <p className="text-[11px] truncate mt-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>
            {token.name}
          </p>
        </div>
      </div>

      {/* Balance */}
      {userAddress && displayBalance && (
        <div className="flex-shrink-0 ml-2 text-right">
          <p
            className="text-xs font-mono font-medium tabular-nums"
            data-testid={`text-balance-${token.symbol}`}
            style={{ color: "rgba(255,255,255,0.7)" }}
          >
            {displayBalance}
          </p>
        </div>
      )}
    </button>
  );
}
