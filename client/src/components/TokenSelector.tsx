import { useState, useMemo, useEffect, useRef } from "react";
import { Search, CheckCircle2, AlertCircle, X, Sparkles, Users, Trash2 } from "lucide-react";
import { isAddress } from "ethers";
import { useAccount, useBalance, useChainId } from "wagmi";
import type { Token } from "@shared/schema";
import { formatAmount } from "@/lib/decimal-utils";
import { fetchCommunityTokens, type CommunityToken } from "@/data/tokens";

interface TokenSelectorProps {
  open: boolean;
  onClose: () => void;
  onSelect: (token: Token) => void;
  tokens: Token[];
  onImport?: (address: string) => Promise<Token | null>;
  onDelete?: (address: string) => void;
}
// ─── Main component ───────────────────────────────────────────────────────────

export function TokenSelector({ open, onClose, onSelect, tokens, onImport, onDelete }: TokenSelectorProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [communityTokens, setCommunityTokens] = useState<CommunityToken[]>([]);
  const [loadingCommunity, setLoadingCommunity] = useState(false);
  const [hiddenCommunity, setHiddenCommunity] = useState<Set<string>>(new Set());
  const [resetHoldingKey, setResetHoldingKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { address: userAddress } = useAccount();
  const chainId = useChainId();

  const hiddenKey = `hiddenCommunityTokens:${chainId ?? ""}`;

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(hiddenKey) || "[]");
      setHiddenCommunity(new Set(stored));
    } catch { setHiddenCommunity(new Set()); }
  }, [chainId]);

  // Animate in/out
  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      const isDesktop = window.matchMedia("(pointer: fine)").matches;
      if (isDesktop) {
        setTimeout(() => inputRef.current?.focus(), 120);
      }
      // Fetch community tokens
      if (chainId) {
        setLoadingCommunity(true);
        fetchCommunityTokens(chainId)
          .then(setCommunityTokens)
          .finally(() => setLoadingCommunity(false));
      }
    } else {
      setVisible(false);
      setResetHoldingKey(k => k + 1);
      const t = setTimeout(() => {
        setMounted(false);
        setSearchQuery("");
        setImportError("");
      }, 300);
      return () => clearTimeout(t);
    }
  }, [open, chainId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Build deduplicated list of community tokens (exclude what's already in the regular list)
  const regularAddresses = useMemo(
    () => new Set(tokens.map(t => t.address.toLowerCase())),
    [tokens]
  );
  const filteredCommunityTokens = useMemo(() => {
    if (!communityTokens.length) return [];
    const q = searchQuery.toLowerCase().trim();
    return communityTokens
      .filter(t => !regularAddresses.has(t.address.toLowerCase()))
      .filter(t => !hiddenCommunity.has(t.address.toLowerCase()))
      .filter(t => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase().includes(q));
  }, [communityTokens, regularAddresses, searchQuery, hiddenCommunity]);

  const handleDeleteCommunity = (address: string) => {
    const lower = address.toLowerCase();
    setHiddenCommunity(prev => {
      const next = new Set(prev);
      next.add(lower);
      localStorage.setItem(hiddenKey, JSON.stringify([...next]));
      return next;
    });
  };

  const { filteredVerified, filteredImported } = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const matches = (t: Token) =>
      !q ||
      t.symbol.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.address.toLowerCase().includes(q);
    return {
      filteredVerified: tokens.filter((t) => t.verified && matches(t)),
      filteredImported: tokens.filter((t) => !t.verified && matches(t)),
    };
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

  const totalCount = tokens.length + filteredCommunityTokens.length;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        onTouchMove={(e) => e.preventDefault()}
        className="fixed inset-0 z-50 transition-all duration-300"
        style={{
          background: "rgba(0,0,0,0.7)",
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
          data-token-panel
          className="relative w-full sm:max-w-md overflow-hidden"
          style={{
            pointerEvents: "auto",
            background: "linear-gradient(145deg, #0f1117 0%, #0d0f14 100%)",
            border: "1px solid rgba(255,255,255,0.07)",
            boxShadow: "0 -4px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
            borderRadius: "20px 20px 0 0",
            transform: visible ? "translateY(0) scale(1)" : "translateY(100%) scale(1)",
            opacity: visible ? 1 : 0,
            transition: "transform 0.32s cubic-bezier(0.32,0.72,0,1), opacity 0.2s ease",
            maxHeight: "92dvh",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-1 sm:hidden">
            <div className="w-9 h-1 rounded-full bg-white/10" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3 sm:pt-5 flex-shrink-0">
            <div>
              <h2 className="text-base font-semibold text-white tracking-tight">Select token</h2>
              <p className="text-[11px] text-white/30 mt-0.5">
                {tokens.length} listed
                {communityTokens.length > 0 && ` · ${communityTokens.length} community`}
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Search */}
          <div className="px-5 pb-3 flex-shrink-0">
            <div
              className="relative"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12,
                transition: "border-color 0.2s, box-shadow 0.2s",
              }}
              onFocusCapture={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(99,102,241,0.5)";
                (e.currentTarget as HTMLDivElement).style.boxShadow = "0 0 0 3px rgba(99,102,241,0.12)";
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
                inputMode="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="w-full bg-transparent pl-10 pr-10 py-3 text-sm text-white placeholder:text-white/25 outline-none"
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
            <div
              className="mx-5 mb-3 flex-shrink-0 rounded-xl overflow-hidden"
              style={{ background: "rgba(234,179,8,0.06)", border: "1px solid rgba(234,179,8,0.2)" }}
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
                  {importError && <p className="text-[11px] text-red-400 mt-1">{importError}</p>}
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
                  ) : "Import"}
                </button>
              </div>
            </div>
          )}

          {importError && !showImportButton && (
            <div
              className="mx-5 mb-3 flex-shrink-0 px-3.5 py-2.5 rounded-xl text-xs text-red-300 flex items-center gap-2"
              style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
            >
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {importError}
            </div>
          )}

          {/* Divider */}
          <div className="mx-5 h-px flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }} />

          {/* Token list */}
          <div
            className="flex-1 overflow-y-auto overscroll-contain px-3 py-2"
            style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
          >
            {/* ── Verified tokens ── */}
            {filteredVerified.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px 4px", marginBottom: 2 }}>
                  <Sparkles style={{ width: 11, height: 11, color: "#818cf8" }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Verified
                  </span>
                </div>
                {filteredVerified.map((token, i) => (
                  <TokenRow
                    key={token.address}
                    token={token}
                    userAddress={userAddress}
                    index={i}
                    onClick={() => handleSelect(token)}
                  />
                ))}
              </>
            )}

            {/* ── Imported tokens ── */}
            {filteredImported.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 4px", marginBottom: 2 }}>
                  <AlertCircle style={{ width: 11, height: 11, color: "#facc15" }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Imported
                  </span>
                </div>
                {filteredImported.map((token, i) => (
                  <TokenRow
                    key={token.address}
                    token={token}
                    userAddress={userAddress}
                    index={i}
                    onClick={() => handleSelect(token)}
                    onDelete={onDelete}
                    resetHolding={resetHoldingKey}
                  />
                ))}
              </>
            )}

            {/* ── Community Made section ── */}
            {(filteredCommunityTokens.length > 0 || loadingCommunity) && (
              <>
                <div style={{ padding: "10px 12px 4px", display: "flex", alignItems: "center", gap: 8 }}>
                  <Users style={{ width: 11, height: 11, color: "#a78bfa" }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Community Made
                  </span>
                </div>

                {loadingCommunity && filteredCommunityTokens.length === 0 ? (
                  <div style={{ padding: "16px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 14, height: 14, border: "2px solid rgba(139,92,246,0.2)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.2)" }}>Loading community tokens…</span>
                  </div>
                ) : (
                  filteredCommunityTokens.map((token, i) => (
                    <CommunityTokenRow
                      key={token.address}
                      token={token}
                      userAddress={userAddress}
                      index={i}
                      onClick={() => handleSelect(token)}
                      onDelete={handleDeleteCommunity}
                      resetHolding={resetHoldingKey}
                    />
                  ))
                )}
              </>
            )}

            {/* Empty state */}
            {filteredVerified.length === 0 && filteredImported.length === 0 && filteredCommunityTokens.length === 0 && !showImportButton && !loadingCommunity && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.04)" }}>
                  <Search className="w-5 h-5 text-white/20" />
                </div>
                <p className="text-sm text-white/30">No tokens found</p>
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                    Clear search
                  </button>
                )}
              </div>
            )}

            <div className="h-safe-area-bottom h-4 sm:h-2" />
          </div>
        </div>
      </div>

      <style>{`
        @media (min-width: 640px) {
          [data-token-panel] {
            border-radius: 20px !important;
            transform: ${visible ? "translateY(0) scale(1)" : "translateY(12px) scale(0.97)"} !important;
          }
        }
        [data-token-panel] ::-webkit-scrollbar { display: none; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}

// ─── Token Row (existing/listed tokens) ──────────────────────────────────────

function TokenRow({
  token,
  userAddress,
  index,
  onClick,
  onDelete,
  resetHolding,
}: {
  token: Token;
  userAddress?: string;
  index: number;
  onClick: () => void;
  onDelete?: (address: string) => void;
  resetHolding?: number;
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
      displayBalance =
        num > 0
          ? num < 0.0001 ? "<0.0001"
          : num >= 1000 ? num.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : formatted
          : "";
    }
  } catch { /**/ }

  const [imgError, setImgError] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [holding, setHolding] = useState(false);
  const [fadingOut, setFadingOut] = useState(false);
  const [focused, setFocused] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEndingHold = useRef(false);

  useEffect(() => {
    if (resetHolding) {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      setHolding(false);
      setFadingOut(false);
      setFocused(false);
      isEndingHold.current = false;
    }
    return () => {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    };
  }, [resetHolding]);

  const startHold = () => {
    if (!onDelete || token.verified || isEndingHold.current) return;
    isEndingHold.current = false;
    holdTimer.current = setTimeout(() => {
      setHolding(true);
      hideTimer.current = setTimeout(() => {
        if (!isEndingHold.current) {
          setFadingOut(true);
          setTimeout(() => {
            setHolding(false);
            setFadingOut(false);
          }, 300);
        }
      }, 3000);
    }, 500);
  };
  const endHold = () => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (holding && !fadingOut) {
      setFadingOut(true);
      hideTimer.current = setTimeout(() => {
        isEndingHold.current = false;
        setHolding(false);
        setFadingOut(false);
      }, 300);
    } else if (!holding) {
      isEndingHold.current = false;
      setHolding(false);
      setFadingOut(false);
    }
  };

  const showDelete = !!(onDelete && !token.verified && (holding || focused || fadingOut));
  const dismissDelete = () => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setHolding(false);
    setFadingOut(false);
    setFocused(false);
  };

  return (
    <div style={{ position: "relative", overflow: "hidden", borderRadius: 14 }}>
      {/* Delete slide-in from left */}
      {(holding || focused) && (
        <div
          className="absolute inset-y-0 left-0 flex items-center pl-2"
          style={{
            width: 52,
            transform: "translateX(0)",
            transition: "transform 0.25s ease-out, opacity 0.2s ease-out",
            opacity: fadingOut ? 0 : 1,
            zIndex: 2,
            background: "rgba(239,68,68,0.12)",
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); dismissDelete(); onDelete?.(token.address); }}
            className="w-9 h-9 rounded-lg flex items-center justify-center"
            style={{ background: "rgba(239,68,68,0.25)", border: "1px solid rgba(239,68,68,0.4)" }}
            title="Remove token"
            aria-label={`Remove ${token.symbol}`}
          >
            <Trash2 style={{ width: 15, height: 15, color: "#f87171" }} />
          </button>
        </div>
      )}
      {/* Main row — slides right when holding */}
      <button
        data-testid={`button-select-token-${token.symbol}`}
        onClick={holding ? endHold : onClick}
        onPointerDown={startHold}
        onPointerUp={endHold}
        onFocus={() => { if (onDelete && !token.verified) setFocused(true); }}
        onBlur={() => { if (!holding) setFocused(false); }}
        onKeyDown={(e) => {
          if ((e.key === "Delete" || e.key === "Backspace") && onDelete && !token.verified) {
            e.preventDefault();
            onDelete(token.address);
          }
        }}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left relative active:scale-[0.98]"
        style={{
          background: pressed ? "rgba(255,255,255,0.08)" : "transparent",
          transition: "background 0.12s ease, transform 0.25s ease-out",
          transform: (holding || fadingOut) ? "translateX(52px)" : "translateX(0)",
          borderRadius: 14,
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full pointer-events-none"
          style={{
            background: "linear-gradient(180deg, #6366f1, #8b5cf6)",
            opacity: pressed ? 1 : 0,
            transform: pressed ? "scaleY(1)" : "scaleY(0.4)",
            transition: "opacity 0.12s, transform 0.12s",
          }}
        />
        <div className="flex items-center gap-3 min-w-0 pl-1.5">
          <div className="relative flex-shrink-0">
            <div className="w-9 h-9 rounded-full overflow-hidden" style={{ boxShadow: "0 0 0 1px rgba(255,255,255,0.08)" }}>
              <img
                src={!imgError && token.logoURI ? token.logoURI : "/img/logos/unknown-token.png"}
                alt={token.symbol}
                className="w-full h-full object-cover"
                onError={() => setImgError(true)}
                loading="lazy"
              />
            </div>
            {token.verified && (
              <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center" style={{ background: "#0f1117", boxShadow: "0 0 0 1px rgba(255,255,255,0.06)" }}>
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-500 flex items-center justify-center">
                    <CheckCircle2 className="w-2 h-2 text-white" data-testid={`icon-verified-${token.symbol}`} />
                  </div>
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm text-white tracking-tight">{token.symbol}</span>
              {!token.verified && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.3)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  unverified
                </span>
              )}
            </div>
            <p className="text-[11px] truncate mt-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>{token.name}</p>
          </div>
        </div>
        {userAddress && displayBalance && (
          <div className="flex-shrink-0 ml-2 text-right">
            <p className="text-xs font-mono font-medium tabular-nums" data-testid={`text-balance-${token.symbol}`} style={{ color: "rgba(255,255,255,0.7)" }}>
              {displayBalance}
            </p>
          </div>
        )}
      </button>
    </div>
  );
}

// ─── Community Token Row ──────────────────────────────────────────────────────

function CommunityTokenRow({
  token,
  userAddress,
  index,
  onClick,
  onDelete,
  resetHolding,
}: {
  token: CommunityToken;
  userAddress?: string;
  index: number;
  onClick: () => void;
  onDelete?: (address: string) => void;
  resetHolding?: number;
}) {
  const { data: balance } = useBalance({
    address: userAddress as `0x${string}` | undefined,
    token: token.address as `0x${string}`,
  });

  let displayBalance = "";
  try {
    if (balance && userAddress) {
      const formatted = formatAmount(balance.value, balance.decimals);
      const num = parseFloat(formatted);
      displayBalance = num > 0 ? (num < 0.0001 ? "<0.0001" : num >= 1000 ? num.toLocaleString(undefined, { maximumFractionDigits: 2 }) : formatted) : "";
    }
  } catch { /**/ }

  const [imgError, setImgError] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [holding, setHolding] = useState(false);
  const [fadingOut, setFadingOut] = useState(false);
  const [focused, setFocused] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEndingHold = useRef(false);

  useEffect(() => {
    if (resetHolding) {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      setHolding(false);
      setFadingOut(false);
      setFocused(false);
      isEndingHold.current = false;
    }
    return () => {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    };
  }, [resetHolding]);

  const startHold = () => {
    if (!onDelete || isEndingHold.current) return;
    isEndingHold.current = false;
    holdTimer.current = setTimeout(() => {
      setHolding(true);
      hideTimer.current = setTimeout(() => {
        if (!isEndingHold.current) {
          setFadingOut(true);
          setTimeout(() => {
            setHolding(false);
            setFadingOut(false);
          }, 300);
        }
      }, 3000);
    }, 500);
  };
  const endHold = () => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (holding && !fadingOut) {
      setFadingOut(true);
      hideTimer.current = setTimeout(() => {
        isEndingHold.current = false;
        setHolding(false);
        setFadingOut(false);
      }, 300);
    } else if (!holding) {
      isEndingHold.current = false;
      setHolding(false);
      setFadingOut(false);
    }
  };

  const showDelete = !!(onDelete && (holding || focused || fadingOut));
  const dismissDelete = () => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setHolding(false);
    setFadingOut(false);
    setFocused(false);
  };

  return (
    <div style={{ position: "relative", overflow: "hidden", borderRadius: 14 }}>
      {(holding || focused) && (
        <div
          className="absolute inset-y-0 left-0 flex items-center pl-2"
          style={{
            width: 52,
            transform: "translateX(0)",
            transition: "transform 0.25s ease-out, opacity 0.2s ease-out",
            opacity: fadingOut ? 0 : 1,
            zIndex: 2,
            background: "rgba(139,92,246,0.1)",
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); dismissDelete(); onDelete?.(token.address); }}
            className="w-9 h-9 rounded-lg flex items-center justify-center"
            style={{ background: "rgba(239,68,68,0.25)", border: "1px solid rgba(239,68,68,0.4)" }}
            title="Remove token"
            aria-label={`Remove ${token.symbol}`}
          >
            <Trash2 style={{ width: 15, height: 15, color: "#f87171" }} />
          </button>
        </div>
      )}
      <button
        onClick={holding ? endHold : onClick}
        onPointerDown={startHold}
        onPointerUp={endHold}
        onFocus={() => { if (onDelete) setFocused(true); }}
        onBlur={() => { if (!holding) setFocused(false); }}
        onKeyDown={(e) => {
          if ((e.key === "Delete" || e.key === "Backspace") && onDelete) {
            e.preventDefault();
            onDelete(token.address);
          }
        }}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left relative active:scale-[0.98]"
        style={{
          background: pressed ? "rgba(139,92,246,0.1)" : "transparent",
          transition: "background 0.12s ease, transform 0.25s ease-out",
          transform: (holding || fadingOut) ? "translateX(52px)" : "translateX(0)",
          borderRadius: 14,
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full pointer-events-none"
          style={{
            background: "linear-gradient(180deg, #8b5cf6, #a78bfa)",
            opacity: pressed ? 1 : 0,
            transform: pressed ? "scaleY(1)" : "scaleY(0.4)",
            transition: "opacity 0.12s, transform 0.12s",
          }}
        />
        <div className="flex items-center gap-3 min-w-0 pl-1.5">
          <div className="relative flex-shrink-0">
            <div className="w-9 h-9 rounded-full overflow-hidden" style={{ boxShadow: "0 0 0 1.5px rgba(139,92,246,0.3)" }}>
              <img
                src={!imgError && token.logoURI && token.logoURI !== "/img/logos/unknown-token.png" ? token.logoURI : "/img/logos/unknown-token.png"}
                alt={token.symbol}
                className="w-full h-full object-cover"
                onError={() => setImgError(true)}
                loading="lazy"
              />
            </div>
            <div
              className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center"
              style={{ background: "#0f1117", boxShadow: "0 0 0 1px rgba(139,92,246,0.3)" }}
            >
              <div className="w-2.5 h-2.5 rounded-full flex items-center justify-center" style={{ background: "rgba(139,92,246,0.8)" }}>
                <Users style={{ width: 6, height: 6, color: "white" }} />
              </div>
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm text-white tracking-tight">{token.symbol}</span>
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full font-bold"
                style={{
                  background: "rgba(139,92,246,0.15)",
                  color: "#c4b5fd",
                  border: "1px solid rgba(139,92,246,0.25)",
                }}
              >
                community
              </span>
            </div>
            <p className="text-[11px] truncate mt-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>{token.name}</p>
          </div>
        </div>
        {userAddress && displayBalance && (
          <div className="flex-shrink-0 ml-2 text-right">
            <p className="text-xs font-mono font-medium tabular-nums" style={{ color: "rgba(255,255,255,0.7)" }}>
              {displayBalance}
            </p>
          </div>
        )}
      </button>
    </div>
  );
}
