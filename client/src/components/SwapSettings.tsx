import { useState, useEffect, useRef } from "react";
import { X, AlertTriangle, RotateCcw, Zap, GitFork, Clock, RefreshCw, Wallet, ChevronDown } from "lucide-react";
import { Switch } from "@/components/ui/switch";

interface SwapSettingsProps {
  open: boolean;
  onClose: () => void;
  slippage: number;
  onSlippageChange: (value: number) => void;
  deadline: number;
  onDeadlineChange: (value: number) => void;
  recipientAddress: string;
  onRecipientAddressChange: (value: string) => void;
  quoteRefreshInterval?: number;
  onQuoteRefreshIntervalChange?: (value: number) => void;
  v2Enabled: boolean;
  v3Enabled: boolean;
  onV2EnabledChange: (enabled: boolean) => void;
  onV3EnabledChange: (enabled: boolean) => void;
  maxBalance?: number;
  onMaxBalanceClick?: () => void;
}

const PRESET_SLIPPAGES = [0.1, 0.5, 1.0];
const DEFAULT_DEADLINE = 20;
const DEFAULT_REFRESH = 30;

export function SwapSettings({
  open,
  onClose,
  slippage,
  onSlippageChange,
  deadline,
  onDeadlineChange,
  recipientAddress,
  onRecipientAddressChange,
  quoteRefreshInterval = DEFAULT_REFRESH,
  onQuoteRefreshIntervalChange,
  v2Enabled,
  v3Enabled,
  onV2EnabledChange,
  onV3EnabledChange,
  maxBalance,
  onMaxBalanceClick,
}: SwapSettingsProps) {
  const [customSlippage, setCustomSlippage] = useState(slippage.toString());
  const [customDeadline, setCustomDeadline] = useState(deadline.toString());
  const [customRefresh, setCustomRefresh] = useState(quoteRefreshInterval.toString());
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showRecipient, setShowRecipient] = useState(!!recipientAddress);

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

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const handleSlippageChange = (value: string) => {
    setCustomSlippage(value);
    const n = parseFloat(value);
    if (!isNaN(n) && n >= 0 && n <= 50) onSlippageChange(n);
  };

  const handleDeadlineChange = (value: string) => {
    setCustomDeadline(value);
    const n = parseInt(value);
    if (!isNaN(n) && n > 0) onDeadlineChange(n);
  };

  const handleRefreshChange = (value: string) => {
    setCustomRefresh(value);
    const n = parseInt(value);
    if (!isNaN(n) && n >= 5 && onQuoteRefreshIntervalChange) onQuoteRefreshIntervalChange(n);
  };

  const handleReset = () => {
    onSlippageChange(0.5);
    setCustomSlippage("0.5");
    onDeadlineChange(DEFAULT_DEADLINE);
    setCustomDeadline(DEFAULT_DEADLINE.toString());
    if (onQuoteRefreshIntervalChange) onQuoteRefreshIntervalChange(DEFAULT_REFRESH);
    setCustomRefresh(DEFAULT_REFRESH.toString());
  };

  const bothDisabled = !v2Enabled && !v3Enabled;
  const slippageHigh = slippage > 5;
  const slippageZero = slippage === 0;

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
          data-settings-panel
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
          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-1 sm:hidden">
            <div className="w-9 h-1 rounded-full bg-white/10" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3 sm:pt-5 flex-shrink-0">
            <div>
              <h2 className="text-base font-semibold text-white tracking-tight">Swap Settings</h2>
              <p className="text-[11px] text-white/30 mt-0.5">Customize your swap preferences</p>
            </div>
            <div className="flex items-center gap-2">
              {/* Reset button */}
              <button
                onClick={handleReset}
                title="Reset to defaults"
                className="w-8 h-8 rounded-xl flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/6 transition-all"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
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
            className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-5"
            style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
          >

            {/* ── Protocol Routing ────────────────────────── */}
            <Section icon={<GitFork className="w-3.5 h-3.5" />} label="Protocol Routing">
              <div className="space-y-2">
                <ProtocolRow
                  label="Achswap V2"
                  description="Classic constant product AMM"
                  checked={v2Enabled}
                  onChange={onV2EnabledChange}
                  disabled={v2Enabled && !v3Enabled}
                />
                <div className="h-px mx-1" style={{ background: "rgba(255,255,255,0.05)" }} />
                <ProtocolRow
                  label="Achswap V3"
                  description="Concentrated liquidity pools"
                  checked={v3Enabled}
                  onChange={onV3EnabledChange}
                  disabled={v3Enabled && !v2Enabled}
                />
              </div>

              {bothDisabled && (
                <Banner variant="error" icon={<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}>
                  At least one protocol must be enabled
                </Banner>
              )}
              {v2Enabled && v3Enabled && (
                <Banner variant="info" icon={<Zap className="w-3.5 h-3.5 flex-shrink-0" />}>
                  Smart routing enabled — best price selected automatically
                </Banner>
              )}
            </Section>

            {/* ── Slippage Tolerance ───────────────────────── */}
            <Section icon={<Zap className="w-3.5 h-3.5" />} label="Slippage Tolerance">
              {/* Preset pills */}
              <div className="flex gap-2">
                {PRESET_SLIPPAGES.map((p) => (
                  <button
                    key={p}
                    onClick={() => { onSlippageChange(p); setCustomSlippage(p.toString()); }}
                    className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all"
                    style={{
                      background: slippage === p
                        ? "rgba(99,102,241,0.2)"
                        : "rgba(255,255,255,0.05)",
                      border: slippage === p
                        ? "1px solid rgba(99,102,241,0.5)"
                        : "1px solid rgba(255,255,255,0.07)",
                      color: slippage === p ? "#a5b4fc" : "rgba(255,255,255,0.5)",
                    }}
                  >
                    {p}%
                  </button>
                ))}
                {/* Custom pill — active when not matching any preset */}
                <button
                  onClick={() => {}}
                  className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all"
                  style={{
                    background: !PRESET_SLIPPAGES.includes(slippage)
                      ? "rgba(99,102,241,0.2)"
                      : "rgba(255,255,255,0.05)",
                    border: !PRESET_SLIPPAGES.includes(slippage)
                      ? "1px solid rgba(99,102,241,0.5)"
                      : "1px solid rgba(255,255,255,0.07)",
                    color: !PRESET_SLIPPAGES.includes(slippage)
                      ? "#a5b4fc"
                      : "rgba(255,255,255,0.5)",
                  }}
                >
                  Custom
                </button>
              </div>

              {/* Custom input */}
              <NumberInput
                value={customSlippage}
                onChange={handleSlippageChange}
                suffix="%"
                min="0"
                max="50"
                step="0.1"
                placeholder="0.5"
              />

              {slippageHigh && (
                <Banner variant="warning" icon={<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}>
                  High slippage — your transaction may be frontrun
                </Banner>
              )}
              {slippageZero && (
                <Banner variant="error" icon={<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}>
                  0% slippage may cause transaction failures
                </Banner>
              )}
            </Section>

            {/* ── Transaction Deadline ─────────────────────── */}
            <Section icon={<Clock className="w-3.5 h-3.5" />} label="Transaction Deadline">
              <NumberInput
                value={customDeadline}
                onChange={handleDeadlineChange}
                suffix="min"
                min="1"
                placeholder="20"
              />
              <p className="text-[11px] text-white/30 leading-relaxed">
                Transaction reverts if pending longer than this time.
              </p>
            </Section>

            {/* ── Quote Refresh ─────────────────────────────── */}
            <Section icon={<RefreshCw className="w-3.5 h-3.5" />} label="Quote Refresh Interval">
              <NumberInput
                value={customRefresh}
                onChange={handleRefreshChange}
                suffix="sec"
                min="5"
                placeholder="30"
              />
              <p className="text-[11px] text-white/30 leading-relaxed">
                How often swap quotes are refreshed automatically.
              </p>
            </Section>

            {/* ── Recipient Address ─────────────────────────── */}
            <Section icon={<Wallet className="w-3.5 h-3.5" />} label="Recipient Address">
              {/* Collapsible toggle */}
              <button
                onClick={() => setShowRecipient((p) => !p)}
                className="w-full flex items-center justify-between py-1 text-xs text-white/40 hover:text-white/60 transition-colors"
              >
                <span>{showRecipient ? "Send to different wallet" : "Send to a different wallet after swap"}</span>
                <ChevronDown
                  className="w-3.5 h-3.5 transition-transform duration-200"
                  style={{ transform: showRecipient ? "rotate(180deg)" : "rotate(0deg)" }}
                />
              </button>

              {showRecipient && (
                <div
                  className="rounded-xl overflow-hidden transition-all"
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  <input
                    type="text"
                    placeholder="0x… (leave empty to use your wallet)"
                    value={recipientAddress}
                    onChange={(e) => onRecipientAddressChange(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full bg-transparent px-4 py-3 text-sm text-white placeholder:text-white/20 outline-none"
                  />
                </div>
              )}
            </Section>

            {/* ── Max Balance (optional) ────────────────────── */}
            {maxBalance !== undefined && onMaxBalanceClick && (
              <Section icon={<Wallet className="w-3.5 h-3.5" />} label="Max Available Balance">
                <div className="flex items-center gap-2">
                  <div
                    className="flex-1 px-4 py-3 rounded-xl text-sm text-white/70 font-mono tabular-nums"
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.07)",
                    }}
                  >
                    {maxBalance}
                  </div>
                  <button
                    onClick={onMaxBalanceClick}
                    className="px-4 py-3 rounded-xl text-xs font-bold tracking-widest transition-all"
                    style={{
                      background: "rgba(99,102,241,0.15)",
                      border: "1px solid rgba(99,102,241,0.35)",
                      color: "#a5b4fc",
                    }}
                  >
                    MAX
                  </button>
                </div>
              </Section>
            )}

            {/* Bottom safe area */}
            <div className="h-safe-area-bottom h-4 sm:h-1" />
          </div>
        </div>
      </div>

      <style>{`
        @media (min-width: 640px) {
          [data-settings-panel] {
            border-radius: 20px !important;
            transform: ${visible ? "translateY(0) scale(1)" : "translateY(12px) scale(0.97)"} !important;
          }
        }
        [data-settings-panel] ::-webkit-scrollbar { display: none; }
      `}</style>
    </>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function Section({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-white/30">{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">
          {label}
        </span>
      </div>
      <div
        className="rounded-2xl p-4 space-y-3"
        style={{
          background: "rgba(255,255,255,0.025)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ProtocolRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-[11px] text-white/35 mt-0.5">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="flex-shrink-0"
      />
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  suffix,
  min,
  max,
  step,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  min?: string;
  max?: string;
  step?: string;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <div
      className="relative flex items-center rounded-xl overflow-hidden transition-all duration-200"
      style={{
        background: "rgba(255,255,255,0.04)",
        border: focused
          ? "1px solid rgba(99,102,241,0.5)"
          : "1px solid rgba(255,255,255,0.07)",
        boxShadow: focused ? "0 0 0 3px rgba(99,102,241,0.1)" : "none",
      }}
    >
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        inputMode="decimal"
        className="flex-1 bg-transparent px-4 py-3 text-sm text-white placeholder:text-white/20 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span
        className="pr-4 text-xs font-medium flex-shrink-0"
        style={{ color: "rgba(255,255,255,0.25)" }}
      >
        {suffix}
      </span>
    </div>
  );
}

function Banner({
  variant,
  icon,
  children,
}: {
  variant: "warning" | "error" | "info";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles = {
    warning: {
      background: "rgba(234,179,8,0.07)",
      border: "1px solid rgba(234,179,8,0.2)",
      color: "#fbbf24",
    },
    error: {
      background: "rgba(239,68,68,0.07)",
      border: "1px solid rgba(239,68,68,0.2)",
      color: "#f87171",
    },
    info: {
      background: "rgba(99,102,241,0.07)",
      border: "1px solid rgba(99,102,241,0.2)",
      color: "#a5b4fc",
    },
  }[variant];

  return (
    <div
      className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl text-xs leading-relaxed"
      style={styles}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}
