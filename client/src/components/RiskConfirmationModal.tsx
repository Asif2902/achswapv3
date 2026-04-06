import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

type RiskTone = "danger" | "warning";

interface RiskConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  warningText: string;
  onConfirm: () => void | Promise<void>;
  tone?: RiskTone;
  checkboxLabel?: string;
  confirmPhrase?: string;
  confirmPhraseLabel?: string;
  confirmButtonLabel?: string;
  cancelButtonLabel?: string;
}

export function RiskConfirmationModal({
  open,
  onOpenChange,
  title,
  description,
  warningText,
  onConfirm,
  tone = "danger",
  checkboxLabel = "I understand the risks and want to proceed",
  confirmPhrase = "CONFIRM",
  confirmPhraseLabel,
  confirmButtonLabel = "Confirm",
  cancelButtonLabel = "Cancel",
}: RiskConfirmationModalProps) {
  const [checked, setChecked] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setChecked(false);
      setText("");
      setSubmitting(false);
    }
  }, [open]);

  const isValidPhrase = text.trim().toUpperCase() === confirmPhrase.toUpperCase();
  const canConfirm = checked && isValidPhrase && !submitting;

  const palette = useMemo(() => {
    if (tone === "warning") {
      return {
        icon: "#fbbf24",
        border: "rgba(245,158,11,0.35)",
        warnBg: "rgba(245,158,11,0.08)",
        warnBorder: "rgba(245,158,11,0.22)",
        confirmBg: "rgba(245,158,11,0.15)",
        confirmColor: "#fcd34d",
        confirmBorder: "rgba(245,158,11,0.35)",
        confirmHoverBg: "rgba(245,158,11,0.25)",
        confirmHoverBorder: "rgba(245,158,11,0.55)",
      };
    }

    return {
      icon: "#f87171",
      border: "rgba(239,68,68,0.35)",
      warnBg: "rgba(239,68,68,0.08)",
      warnBorder: "rgba(239,68,68,0.22)",
      confirmBg: "rgba(239,68,68,0.15)",
      confirmColor: "#f87171",
      confirmBorder: "rgba(239,68,68,0.35)",
      confirmHoverBg: "rgba(239,68,68,0.25)",
      confirmHoverBorder: "rgba(239,68,68,0.55)",
    };
  }, [tone]);

  if (!open) return null;

  return (
    <>
      <div
        className="rcm-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onOpenChange(false);
          }
        }}
      >
        <div className="rcm-modal" style={{ border: `1px solid ${palette.border}` }}>
          <div className="rcm-icon">
            <AlertTriangle style={{ width: 42, height: 42, color: palette.icon }} />
          </div>

          <div className="rcm-title">{title}</div>
          <div className="rcm-desc">{description}</div>

          <div className="rcm-warn-box" style={{ background: palette.warnBg, border: `1px solid ${palette.warnBorder}` }}>
            <AlertTriangle style={{ width: 16, height: 16, color: palette.icon, flexShrink: 0 }} />
            <span>{warningText}</span>
          </div>

          <div className="rcm-check">
            <input
              type="checkbox"
              id="risk-confirm-check"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <label htmlFor="risk-confirm-check">{checkboxLabel}</label>
          </div>

          <div className="rcm-input-wrap">
            <div className="rcm-input-label">
              {confirmPhraseLabel ?? `Type "${confirmPhrase}" to continue`}
            </div>
            <input
              type="text"
              className="rcm-input"
              placeholder={confirmPhrase}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="rcm-btn-row">
            <button
              className="rcm-btn rcm-btn-cancel"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {cancelButtonLabel}
            </button>
            <button
              className="rcm-btn rcm-btn-confirm"
              disabled={!canConfirm}
              style={{
                background: palette.confirmBg,
                color: palette.confirmColor,
                border: `1px solid ${palette.confirmBorder}`,
              }}
              onMouseEnter={(e) => {
                if (canConfirm) {
                  e.currentTarget.style.background = palette.confirmHoverBg;
                  e.currentTarget.style.borderColor = palette.confirmHoverBorder;
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = palette.confirmBg;
                e.currentTarget.style.borderColor = palette.confirmBorder;
              }}
              onClick={async () => {
                if (!canConfirm) return;
                setSubmitting(true);
                try {
                  await onConfirm();
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              {submitting ? "Confirming..." : confirmButtonLabel}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .rcm-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.7); backdrop-filter:blur(4px); z-index:200; display:flex; align-items:center; justify-content:center; padding:16px; animation:rcm-fadeIn 0.15s ease; }
        @keyframes rcm-fadeIn { from{opacity:0} to{opacity:1} }
        .rcm-modal { background:#1a1a2e; border-radius:18px; padding:24px; width:100%; max-width:380px; box-shadow:0 24px 60px rgba(0,0,0,0.6); }
        .rcm-icon { display:flex; justify-content:center; margin-bottom:14px; }
        .rcm-title { font-size:17px; font-weight:800; color:white; text-align:center; margin-bottom:10px; }
        .rcm-desc { font-size:13px; color:rgba(255,255,255,0.6); text-align:center; line-height:1.55; margin-bottom:18px; }
        .rcm-warn-box { border-radius:12px; padding:12px 14px; margin-bottom:18px; display:flex; align-items:flex-start; gap:10px; }
        .rcm-warn-box svg { flex-shrink:0; margin-top:1px; }
        .rcm-warn-box span { font-size:12px; color:rgba(255,255,255,0.7); line-height:1.5; }
        .rcm-check { display:flex; align-items:center; gap:10px; cursor:pointer; margin-bottom:14px; }
        .rcm-check input[type=checkbox] { width:17px; height:17px; accent-color:#6366f1; cursor:pointer; flex-shrink:0; }
        .rcm-check label { font-size:13px; color:rgba(255,255,255,0.75); cursor:pointer; }
        .rcm-input-wrap { margin-bottom:20px; }
        .rcm-input-label { font-size:11px; font-weight:700; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.06em; margin-bottom:7px; }
        .rcm-input { width:100%; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:10px 14px; color:white; font-size:14px; font-weight:700; letter-spacing:0.05em; outline:none; box-sizing:border-box; transition:border-color 0.2s; font-family:inherit; }
        .rcm-input:focus { border-color:rgba(99,102,241,0.5); }
        .rcm-input::placeholder { color:rgba(255,255,255,0.2); font-weight:400; letter-spacing:0; }
        .rcm-btn-row { display:flex; gap:10px; }
        .rcm-btn { flex:1; height:44px; border-radius:12px; font-weight:800; font-size:14px; cursor:pointer; transition:all 0.2s; border:none; }
        .rcm-btn-cancel { background:rgba(255,255,255,0.07); color:rgba(255,255,255,0.6); border:1px solid rgba(255,255,255,0.1); }
        .rcm-btn-cancel:hover { background:rgba(255,255,255,0.12); color:rgba(255,255,255,0.85); }
        .rcm-btn-confirm:disabled { opacity:0.4; cursor:not-allowed; }
      `}</style>
    </>
  );
}
