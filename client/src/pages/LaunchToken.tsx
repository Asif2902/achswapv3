import { useState, useEffect, useRef } from "react";
import {
  Rocket, Image as ImageIcon, ChevronRight, ChevronLeft,
  ExternalLink, AlertTriangle, Check, Info, Coins,
  Droplets, Tag, Sparkles, Copy, ArrowRight,
} from "lucide-react";
import { useAccount, useBalance, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import { BrowserProvider, Contract, parseUnits, formatUnits } from "ethers";
import { getContractsForChain } from "@/lib/contracts";
import { ACH_TOKEN_FACTORY_ABI, FACTORY_ADDRESS } from "@/lib/factory-abi";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, dp = 4): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(dp);
}

const COMMUNITY_THRESHOLD = 500; // USDC

// ─── Step indicators ──────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: "Token Info", icon: Tag },
  { id: 2, label: "Liquidity", icon: Droplets },
  { id: 3, label: "Review", icon: Rocket },
];

// ─── Hosting tip links ────────────────────────────────────────────────────────

const LOGO_HOSTS = [
  { name: "PostImages", url: "https://postimages.org", free: true },
  { name: "ImgBB", url: "https://imgbb.com", free: true },
  { name: "Imgur", url: "https://imgur.com", free: true },
];

// ═══════════════════════════════════════════════════════════════════════════════
export default function LaunchToken() {
  const [step, setStep] = useState(1);

  // Step 1 — Token details
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [totalSupply, setTotalSupply] = useState("1000000000"); // 1B default
  const [logoUrl, setLogoUrl] = useState("");
  const [logoError, setLogoError] = useState(false);

  // Step 2 — Liquidity
  const [liquidityPercent, setLiquidityPercent] = useState(20);
  const [usdcAmount, setUsdcAmount] = useState("");

  // Deploy state
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployedToken, setDeployedToken] = useState<string | null>(null);
  const [deployTxHash, setDeployTxHash] = useState<string | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const { data: nativeBalance } = useBalance({ address: address as `0x${string}` | undefined });

  let contracts: ReturnType<typeof getContractsForChain> | null = null;
  try { contracts = chainId ? getContractsForChain(chainId) : null; } catch { /**/ }

  const openExplorer = (hash: string) => {
    if (contracts) window.open(`${contracts.explorer}${hash}`, "_blank");
  };
  const openTokenExplorer = (addr: string) => {
    if (contracts) window.open(`${contracts.explorer.replace('/tx/', '/token/')}${addr}`, "_blank");
  };

  // ── Derived numbers ────────────────────────────────────────────────────────
  const supply = parseFloat(totalSupply) || 0;
  const usdc = parseFloat(usdcAmount) || 0;
  const tokensForLiquidity = supply * (liquidityPercent / 100);
  const tokensForOwner = supply - tokensForLiquidity;
  const initialPrice = tokensForLiquidity > 0 && usdc > 0
    ? usdc / tokensForLiquidity
    : 0;
  const marketCap = initialPrice > 0 ? supply * initialPrice : 0;
  const willBeListed = usdc >= COMMUNITY_THRESHOLD;

  // ── Validation ─────────────────────────────────────────────────────────────
  const step1Valid =
    name.trim().length >= 2 &&
    symbol.trim().length >= 2 && symbol.trim().length <= 10 &&
    supply > 0;

  const step2Valid =
    usdc > 0 &&
    liquidityPercent >= 10 && liquidityPercent <= 100;

  // ── Deploy ─────────────────────────────────────────────────────────────────
  const handleDeploy = async () => {
    if (!address || !window.ethereum) return;
    setIsDeploying(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const factory = new Contract(FACTORY_ADDRESS, ACH_TOKEN_FACTORY_ABI, signer);

      // Use raw strings to avoid JS float precision loss on large numbers
      // e.g. parseFloat("1000000000000").toFixed(0) can drift — pass string directly
      const cleanSupply = totalSupply.trim().replace(/[^0-9]/g, "");
      if (!cleanSupply || cleanSupply === "0") throw new Error("Invalid total supply");
      // Pass whole tokens — contract does *10^18 internally. parseUnits would double-multiply → uint112 overflow
      const totalSupplyArg = BigInt(cleanSupply);

      const cleanUsdc = usdcAmount.trim();
      if (!cleanUsdc || parseFloat(cleanUsdc) <= 0) throw new Error("Invalid USDC amount");
      const msgValue = parseUnits(cleanUsdc, 18); // USDC is native 18 decimals on Arc

      toast({ title: "Deploying your token…", description: "This is a single transaction — sit tight!" });

      const gasEstimate = await factory.deployToken.estimateGas(
        name.trim(),
        symbol.trim().toUpperCase(),
        totalSupplyArg,
        logoUrl.trim() || "",
        BigInt(liquidityPercent),
        { value: msgValue }
      );

      const tx = await factory.deployToken(
        name.trim(),
        symbol.trim().toUpperCase(),
        totalSupplyArg,
        logoUrl.trim() || "",
        BigInt(liquidityPercent),
        { value: msgValue, gasLimit: gasEstimate * 150n / 100n }
      );

      toast({ title: "Transaction submitted!", description: "Waiting for confirmation…" });

      const receipt = await tx.wait();

      // Parse TokenCreated event to get token address
      const iface = factory.interface;
      let newTokenAddress: string | null = null;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "TokenCreated") {
            newTokenAddress = parsed.args.tokenAddress;
            break;
          }
        } catch { /* skip */ }
      }

      setDeployedToken(newTokenAddress);
      setDeployTxHash(receipt.hash);
      setStep(4); // success screen

      toast({
        title: "🎉 Token launched!",
        description: `${symbol.toUpperCase()} is live on AchSwap`,
      });
    } catch (err: any) {
      const msg = err?.reason || err?.message || "Unknown error";
      toast({
        title: "Launch failed",
        description: msg.length > 120 ? msg.slice(0, 120) + "…" : msg,
        variant: "destructive",
      });
    } finally {
      setIsDeploying(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        .lt-root {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 28px 16px 64px;
          box-sizing: border-box;
        }
        .lt-inner { width: 100%; max-width: 520px; }

        /* ── heading ── */
        .lt-heading {
          text-align: center;
          margin-bottom: 28px;
        }
        .lt-heading h1 {
          font-size: clamp(22px, 5vw, 30px);
          font-weight: 900;
          color: white;
          margin: 0 0 7px;
          letter-spacing: -0.03em;
          background: linear-gradient(135deg, #fff 30%, #a5b4fc 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .lt-heading p {
          font-size: 13px;
          color: rgba(255,255,255,0.33);
          margin: 0;
        }

        /* ── step indicator ── */
        .lt-steps {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0;
          margin-bottom: 24px;
        }
        .lt-step-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .lt-step-dot {
          width: 36px; height: 36px;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 13px; font-weight: 800;
          transition: all 0.3s;
        }
        .lt-step-dot.done {
          background: rgba(74,222,128,0.2);
          border: 2px solid rgba(74,222,128,0.5);
          color: #4ade80;
        }
        .lt-step-dot.active {
          background: linear-gradient(135deg, rgba(99,102,241,0.35), rgba(139,92,246,0.35));
          border: 2px solid rgba(99,102,241,0.7);
          color: #a5b4fc;
          box-shadow: 0 0 16px rgba(99,102,241,0.3);
        }
        .lt-step-dot.pending {
          background: rgba(255,255,255,0.04);
          border: 2px solid rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.25);
        }
        .lt-step-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          transition: color 0.3s;
        }
        .lt-step-label.active { color: #a5b4fc; }
        .lt-step-label.done { color: #4ade80; }
        .lt-step-label.pending { color: rgba(255,255,255,0.2); }
        .lt-step-connector {
          width: 40px; height: 2px;
          margin: 0 4px;
          margin-bottom: 22px;
          border-radius: 2px;
          transition: background 0.3s;
        }
        .lt-step-connector.done { background: rgba(74,222,128,0.4); }
        .lt-step-connector.pending { background: rgba(255,255,255,0.08); }

        /* ── card ── */
        .lt-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          overflow: hidden;
        }
        .lt-card-hdr {
          padding: 18px 22px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          background: rgba(0,0,0,0.15);
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .lt-card-hdr-icon {
          width: 34px; height: 34px;
          border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          background: rgba(99,102,241,0.18);
          border: 1px solid rgba(99,102,241,0.3);
        }
        .lt-card-hdr h2 {
          font-size: 15px;
          font-weight: 800;
          color: white;
          margin: 0 0 2px;
          letter-spacing: -0.01em;
        }
        .lt-card-hdr p {
          font-size: 11px;
          color: rgba(255,255,255,0.3);
          margin: 0;
        }
        .lt-card-body { padding: 20px 22px; display: flex; flex-direction: column; gap: 18px; }

        /* ── field ── */
        .lt-field { display: flex; flex-direction: column; gap: 7px; }
        .lt-label {
          font-size: 11px;
          font-weight: 700;
          color: rgba(255,255,255,0.45);
          text-transform: uppercase;
          letter-spacing: 0.07em;
          display: flex; align-items: center; gap: 6px;
        }
        .lt-label-req {
          color: #f87171;
          font-size: 13px;
        }
        .lt-input {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.09);
          border-radius: 12px;
          padding: 13px 16px;
          color: white;
          font-size: 15px;
          font-weight: 600;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
          width: 100%;
          box-sizing: border-box;
        }
        .lt-input::placeholder { color: rgba(255,255,255,0.2); font-weight: 400; }
        .lt-input:focus {
          border-color: rgba(99,102,241,0.55);
          box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
        }
        .lt-input.error { border-color: rgba(239,68,68,0.5); }
        .lt-input[type=number]::-webkit-outer-spin-button,
        .lt-input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }

        /* ── hint ── */
        .lt-hint {
          font-size: 11px;
          color: rgba(255,255,255,0.28);
          line-height: 1.5;
          display: flex; align-items: flex-start; gap: 6px;
        }
        .lt-hint svg { flex-shrink: 0; margin-top: 1px; }

        /* ── logo preview row ── */
        .lt-logo-row {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 12px;
          align-items: flex-start;
        }
        .lt-logo-preview {
          width: 64px; height: 64px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.1);
          display: flex; align-items: center; justify-content: center;
          background: rgba(255,255,255,0.04);
          overflow: hidden;
          flex-shrink: 0;
        }
        .lt-logo-preview img { width: 100%; height: 100%; object-fit: cover; }

        /* ── host links ── */
        .lt-hosts {
          display: flex; align-items: center; gap: 6px;
          flex-wrap: wrap;
          margin-top: 4px;
        }
        .lt-host-chip {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 3px 10px;
          border-radius: 20px;
          background: rgba(99,102,241,0.1);
          border: 1px solid rgba(99,102,241,0.2);
          color: #a5b4fc;
          font-size: 11px;
          font-weight: 600;
          text-decoration: none;
          transition: all 0.2s;
          cursor: pointer;
        }
        .lt-host-chip:hover {
          background: rgba(99,102,241,0.2);
          border-color: rgba(99,102,241,0.4);
        }

        /* ── slider ── */
        .lt-slider-wrap {
          display: flex; flex-direction: column; gap: 10px;
        }
        .lt-slider-header {
          display: flex; align-items: center; justify-content: space-between;
        }
        .lt-slider-val {
          font-size: 22px;
          font-weight: 900;
          color: white;
          letter-spacing: -0.02em;
        }
        .lt-slider {
          -webkit-appearance: none;
          width: 100%;
          height: 6px;
          border-radius: 4px;
          background: rgba(255,255,255,0.08);
          outline: none;
          cursor: pointer;
        }
        .lt-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 22px; height: 22px;
          border-radius: 50%;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(99,102,241,0.5);
          transition: box-shadow 0.2s;
        }
        .lt-slider::-webkit-slider-thumb:hover {
          box-shadow: 0 2px 16px rgba(99,102,241,0.7);
        }
        .lt-slider-ticks {
          display: flex; justify-content: space-between;
          font-size: 10px; color: rgba(255,255,255,0.2);
          font-weight: 600;
        }

        /* ── info cards row ── */
        .lt-info-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .lt-info-card {
          background: rgba(0,0,0,0.2);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 14px;
          padding: 12px 14px;
        }
        .lt-info-card-label {
          font-size: 10px;
          font-weight: 700;
          color: rgba(255,255,255,0.3);
          text-transform: uppercase;
          letter-spacing: 0.07em;
          margin-bottom: 6px;
        }
        .lt-info-card-val {
          font-size: 16px;
          font-weight: 800;
          color: white;
          letter-spacing: -0.01em;
        }
        .lt-info-card-sub {
          font-size: 10px;
          color: rgba(255,255,255,0.3);
          margin-top: 2px;
        }
        .lt-info-card.highlight {
          background: rgba(99,102,241,0.08);
          border-color: rgba(99,102,241,0.2);
        }
        .lt-info-card.highlight .lt-info-card-val { color: #a5b4fc; }

        /* ── community badge ── */
        .lt-community-badge {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          border-radius: 14px;
          transition: all 0.3s;
        }
        .lt-community-badge.yes {
          background: rgba(74,222,128,0.08);
          border: 1px solid rgba(74,222,128,0.25);
        }
        .lt-community-badge.no {
          background: rgba(245,158,11,0.06);
          border: 1px solid rgba(245,158,11,0.2);
        }

        /* ── token split viz ── */
        .lt-split-bar {
          height: 10px;
          border-radius: 20px;
          overflow: hidden;
          background: rgba(255,255,255,0.06);
          display: flex;
        }
        .lt-split-liq {
          background: linear-gradient(90deg, #6366f1, #8b5cf6);
          border-radius: 20px 0 0 20px;
          transition: width 0.3s;
        }
        .lt-split-own {
          background: rgba(99,102,241,0.2);
          flex: 1;
          border-radius: 0 20px 20px 0;
        }
        .lt-split-legend {
          display: flex;
          gap: 16px;
          margin-top: 8px;
        }
        .lt-split-leg-item {
          display: flex; align-items: center; gap: 6px;
          font-size: 11px; color: rgba(255,255,255,0.4);
        }
        .lt-split-leg-dot {
          width: 8px; height: 8px;
          border-radius: 50%;
        }

        /* ── review section ── */
        .lt-review-section { display: flex; flex-direction: column; gap: 8px; }
        .lt-review-title {
          font-size: 10px;
          font-weight: 700;
          color: rgba(255,255,255,0.25);
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin-bottom: 2px;
        }
        .lt-review-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 9px 14px;
          background: rgba(0,0,0,0.15);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 12px;
        }
        .lt-review-row-label { font-size: 12px; color: rgba(255,255,255,0.35); }
        .lt-review-row-val { font-size: 12px; font-weight: 700; color: white; text-align: right; max-width: 60%; word-break: break-all; }

        /* ── nav buttons ── */
        .lt-btn-row {
          display: flex; gap: 10px;
          padding: 16px 22px;
          border-top: 1px solid rgba(255,255,255,0.06);
        }
        .lt-btn-back {
          flex: 1;
          height: 48px;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.04);
          color: rgba(255,255,255,0.55);
          font-size: 14px; font-weight: 700;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center; gap: 7px;
          transition: all 0.2s;
        }
        .lt-btn-back:hover { background: rgba(255,255,255,0.08); color: white; }
        .lt-btn-next {
          flex: 2;
          height: 48px;
          border-radius: 14px;
          border: none;
          font-size: 14px; font-weight: 800;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center; gap: 8px;
          transition: all 0.22s;
          letter-spacing: 0.02em;
        }
        .lt-btn-next.active {
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: white;
          box-shadow: 0 4px 20px rgba(99,102,241,0.35);
        }
        .lt-btn-next.active:hover {
          background: linear-gradient(135deg, #4f46e5, #7c3aed);
          box-shadow: 0 6px 28px rgba(99,102,241,0.5);
          transform: translateY(-1px);
        }
        .lt-btn-next.disabled {
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.2);
          cursor: not-allowed;
        }
        .lt-btn-next.loading {
          background: rgba(99,102,241,0.3);
          color: rgba(255,255,255,0.5);
          cursor: not-allowed;
        }

        @keyframes lt-spin { to { transform: rotate(360deg); } }
        .lt-spin { animation: lt-spin 1s linear infinite; display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.25); border-top-color: white; border-radius: 50%; }

        /* ── success screen ── */
        .lt-success {
          display: flex; flex-direction: column; align-items: center;
          padding: 40px 22px 30px;
          text-align: center;
          gap: 16px;
        }
        .lt-success-ring {
          width: 72px; height: 72px;
          border-radius: 50%;
          background: rgba(74,222,128,0.12);
          border: 2px solid rgba(74,222,128,0.4);
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 0 40px rgba(74,222,128,0.2);
        }
        .lt-success-actions {
          display: flex; flex-direction: column; gap: 10px;
          width: 100%;
          margin-top: 8px;
        }
        .lt-success-btn {
          width: 100%; height: 46px;
          border-radius: 14px;
          border: none;
          font-size: 14px; font-weight: 700;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center; gap: 8px;
          transition: all 0.2s;
        }
        .lt-success-btn.primary {
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: white;
        }
        .lt-success-btn.secondary {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.6);
        }
        .lt-success-btn:hover { opacity: 0.85; }

        /* ── warning box ── */
        .lt-warn {
          display: flex; align-items: flex-start; gap: 10px;
          padding: 12px 14px;
          background: rgba(245,158,11,0.06);
          border: 1px solid rgba(245,158,11,0.2);
          border-radius: 14px;
          font-size: 11px; color: rgba(251,191,36,0.8);
          line-height: 1.55;
        }
        .lt-warn svg { flex-shrink: 0; margin-top: 1px; color: #f59e0b; }

        @media (max-width: 420px) {
          .lt-card-body { padding: 16px 16px; }
          .lt-btn-row { padding: 14px 16px; }
          .lt-info-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="lt-root">
        <div className="lt-inner">

          {/* Heading */}
          <div className="lt-heading">
            <h1>
              <Rocket style={{ display: "inline", width: 28, height: 28, marginRight: 8, verticalAlign: "middle" }} />
              Launch Your Token
            </h1>
            <p>Deploy an ERC-20 with instant liquidity — fully on-chain, zero setup</p>
          </div>

          {/* Step indicators (hide on success) */}
          {step <= 3 && (
            <div className="lt-steps">
              {STEPS.map((s, i) => {
                const Icon = s.icon;
                const isDone = step > s.id;
                const isActive = step === s.id;
                return (
                  <div key={s.id} style={{ display: "flex", alignItems: "center" }}>
                    <div className="lt-step-item">
                      <div className={`lt-step-dot ${isDone ? "done" : isActive ? "active" : "pending"}`}>
                        {isDone ? <Check style={{ width: 15, height: 15 }} /> : <Icon style={{ width: 15, height: 15 }} />}
                      </div>
                      <span className={`lt-step-label ${isDone ? "done" : isActive ? "active" : "pending"}`}>
                        {s.label}
                      </span>
                    </div>
                    {i < STEPS.length - 1 && (
                      <div className={`lt-step-connector ${isDone ? "done" : "pending"}`} />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── STEP 1: Token Info ── */}
          {step === 1 && (
            <div className="lt-card">
              <div className="lt-card-hdr">
                <div className="lt-card-hdr-icon">
                  <Tag style={{ width: 16, height: 16, color: "#818cf8" }} />
                </div>
                <div>
                  <h2>Token Details</h2>
                  <p>Name, symbol, supply and logo</p>
                </div>
              </div>
              <div className="lt-card-body">

                {/* Name */}
                <div className="lt-field">
                  <label className="lt-label">Token Name <span className="lt-label-req">*</span></label>
                  <input
                    className="lt-input"
                    placeholder="e.g. My Awesome Token"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    maxLength={40}
                  />
                  <span className="lt-hint">
                    <Info style={{ width: 12, height: 12 }} />
                    This is the full name displayed in wallets and explorers
                  </span>
                </div>

                {/* Symbol */}
                <div className="lt-field">
                  <label className="lt-label">Ticker Symbol <span className="lt-label-req">*</span></label>
                  <input
                    className="lt-input"
                    placeholder="e.g. MAT"
                    value={symbol}
                    onChange={e => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    maxLength={10}
                  />
                  <span className="lt-hint">
                    <Info style={{ width: 12, height: 12 }} />
                    2–10 characters, letters and numbers only. Auto-uppercased.
                  </span>
                </div>

                {/* Total Supply */}
                <div className="lt-field">
                  <label className="lt-label">Total Supply <span className="lt-label-req">*</span></label>
                  <input
                    className="lt-input"
                    type="number"
                    placeholder="e.g. 1000000000"
                    value={totalSupply}
                    onChange={e => setTotalSupply(e.target.value)}
                    min={1}
                  />
                  {supply > 0 && (
                    <span className="lt-hint">
                      <Sparkles style={{ width: 12, height: 12, color: "#a5b4fc" }} />
                      <span style={{ color: "#a5b4fc", fontWeight: 600 }}>{fmt(supply, 0)} tokens</span>
                      &nbsp;will be created. All decimals are 18.
                    </span>
                  )}
                  {/* Supply presets */}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                    {[
                      { label: "1M", val: "1000000" },
                      { label: "100M", val: "100000000" },
                      { label: "1B", val: "1000000000" },
                      { label: "100B", val: "100000000000" },
                      { label: "1T", val: "1000000000000" },
                    ].map(p => (
                      <button
                        key={p.val}
                        onClick={() => setTotalSupply(p.val)}
                        style={{
                          padding: "3px 10px",
                          borderRadius: 8,
                          border: `1px solid ${totalSupply === p.val ? "rgba(99,102,241,0.5)" : "rgba(255,255,255,0.08)"}`,
                          background: totalSupply === p.val ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.03)",
                          color: totalSupply === p.val ? "#a5b4fc" : "rgba(255,255,255,0.35)",
                          fontSize: 11, fontWeight: 700,
                          cursor: "pointer", transition: "all 0.15s",
                        }}
                      >{p.label}</button>
                    ))}
                  </div>
                </div>

                {/* Logo URL */}
                <div className="lt-field">
                  <label className="lt-label">
                    Logo URL
                    <span style={{ fontSize: 10, fontWeight: 500, color: "rgba(255,255,255,0.2)", textTransform: "none", letterSpacing: 0 }}>optional</span>
                  </label>
                  <div className="lt-logo-row">
                    <div style={{ flex: 1 }}>
                      <input
                        className="lt-input"
                        placeholder="https://i.postimg.cc/your-logo.png"
                        value={logoUrl}
                        onChange={e => { setLogoUrl(e.target.value); setLogoError(false); }}
                      />
                    </div>
                    <div className="lt-logo-preview">
                      {logoUrl && !logoError ? (
                        <img
                          src={logoUrl}
                          alt="Token logo"
                          onError={() => setLogoError(true)}
                        />
                      ) : (
                        <ImageIcon style={{ width: 22, height: 22, color: "rgba(255,255,255,0.15)" }} />
                      )}
                    </div>
                  </div>
                  {logoError && (
                    <span className="lt-hint" style={{ color: "#f87171" }}>
                      <AlertTriangle style={{ width: 12, height: 12, color: "#f87171" }} />
                      Can't load this image URL. Try a different direct link.
                    </span>
                  )}
                  <div style={{ marginTop: 4 }}>
                    <span className="lt-hint" style={{ marginBottom: 6, display: "flex" }}>
                      <Info style={{ width: 12, height: 12 }} />
                      Upload your logo to a free host, then paste the <strong style={{ color: "rgba(255,255,255,0.5)" }}>direct image link</strong>
                    </span>
                    <div className="lt-hosts">
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", fontWeight: 600 }}>FREE HOSTS:</span>
                      {LOGO_HOSTS.map(h => (
                        <a key={h.name} href={h.url} target="_blank" rel="noopener noreferrer" className="lt-host-chip">
                          {h.name} <ExternalLink style={{ width: 9, height: 9 }} />
                        </a>
                      ))}
                    </div>
                  </div>
                </div>

              </div>
              <div className="lt-btn-row" style={{ justifyContent: "flex-end" }}>
                <button
                  className={`lt-btn-next ${step1Valid ? "active" : "disabled"}`}
                  style={{ flex: 1, maxWidth: 240 }}
                  onClick={() => step1Valid && setStep(2)}
                  disabled={!step1Valid}
                >
                  Set Liquidity <ChevronRight style={{ width: 16, height: 16 }} />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 2: Liquidity ── */}
          {step === 2 && (
            <div className="lt-card">
              <div className="lt-card-hdr">
                <div className="lt-card-hdr-icon">
                  <Droplets style={{ width: 16, height: 16, color: "#818cf8" }} />
                </div>
                <div>
                  <h2>Liquidity Setup</h2>
                  <p>This sets the initial price and listing</p>
                </div>
              </div>
              <div className="lt-card-body">

                {/* USDC to add */}
                <div className="lt-field">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <label className="lt-label">USDC to Add <span className="lt-label-req">*</span></label>
                    {isConnected && nativeBalance && (
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                        Balance:{" "}
                        <span
                          style={{ color: "rgba(255,255,255,0.55)", fontWeight: 600, cursor: "pointer" }}
                          onClick={() => {
                            const bal = parseFloat(formatUnits(nativeBalance.value, 18));
                            setUsdcAmount((bal * 0.99).toFixed(4));
                          }}
                        >
                          {parseFloat(formatUnits(nativeBalance.value, 18)).toFixed(4)} USDC
                        </span>
                      </span>
                    )}
                  </div>
                  <input
                    className="lt-input"
                    type="number"
                    placeholder="e.g. 500"
                    value={usdcAmount}
                    onChange={e => setUsdcAmount(e.target.value)}
                    min={0}
                  />
                  {/* Quick amounts */}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                    {[100, 500, 1000, 5000].map(v => (
                      <button
                        key={v}
                        onClick={() => setUsdcAmount(String(v))}
                        style={{
                          padding: "3px 10px",
                          borderRadius: 8,
                          border: `1px solid ${parseFloat(usdcAmount) === v ? "rgba(99,102,241,0.5)" : "rgba(255,255,255,0.08)"}`,
                          background: parseFloat(usdcAmount) === v ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.03)",
                          color: parseFloat(usdcAmount) === v ? "#a5b4fc" : "rgba(255,255,255,0.35)",
                          fontSize: 11, fontWeight: 700,
                          cursor: "pointer", transition: "all 0.15s",
                        }}
                      >{v}</button>
                    ))}
                  </div>
                </div>

                {/* Liquidity % slider */}
                <div className="lt-field">
                  <label className="lt-label">% of Supply for Liquidity</label>
                  <div className="lt-slider-wrap">
                    <div className="lt-slider-header">
                      <span style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>
                        {fmt(tokensForLiquidity, 0)} tokens go to pool
                      </span>
                      <span className="lt-slider-val">{liquidityPercent}%</span>
                    </div>
                    <input
                      type="range"
                      className="lt-slider"
                      min={10} max={100} step={1}
                      value={liquidityPercent}
                      onChange={e => setLiquidityPercent(Number(e.target.value))}
                      style={{
                        background: `linear-gradient(to right, #6366f1 0%, #6366f1 ${liquidityPercent}%, rgba(255,255,255,0.08) ${liquidityPercent}%, rgba(255,255,255,0.08) 100%)`
                      }}
                    />
                    <div className="lt-slider-ticks">
                      <span>10%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
                    </div>
                  </div>

                  {/* Token split visualization */}
                  {supply > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <div className="lt-split-bar">
                        <div className="lt-split-liq" style={{ width: `${liquidityPercent}%` }} />
                        <div className="lt-split-own" />
                      </div>
                      <div className="lt-split-legend">
                        <div className="lt-split-leg-item">
                          <div className="lt-split-leg-dot" style={{ background: "#6366f1" }} />
                          Liquidity pool: {liquidityPercent}% ({fmt(tokensForLiquidity, 0)})
                        </div>
                        <div className="lt-split-leg-item">
                          <div className="lt-split-leg-dot" style={{ background: "rgba(99,102,241,0.3)" }} />
                          You keep: {100 - liquidityPercent}% ({fmt(tokensForOwner, 0)})
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Price / Market cap cards */}
                {usdc > 0 && supply > 0 && (
                  <div className="lt-info-grid">
                    <div className="lt-info-card highlight">
                      <div className="lt-info-card-label">Initial Price</div>
                      <div className="lt-info-card-val">${initialPrice < 0.000001 ? initialPrice.toExponential(2) : initialPrice.toFixed(8)}</div>
                      <div className="lt-info-card-sub">per {symbol || "TOKEN"}</div>
                    </div>
                    <div className="lt-info-card">
                      <div className="lt-info-card-label">Fully Diluted MCap</div>
                      <div className="lt-info-card-val">${fmt(marketCap, 2)}</div>
                      <div className="lt-info-card-sub">at launch price</div>
                    </div>
                    <div className="lt-info-card">
                      <div className="lt-info-card-label">Tokens You Receive</div>
                      <div className="lt-info-card-val">{fmt(tokensForOwner, 0)}</div>
                      <div className="lt-info-card-sub">{100 - liquidityPercent}% of supply</div>
                    </div>
                    <div className="lt-info-card">
                      <div className="lt-info-card-label">LP Tokens</div>
                      <div className="lt-info-card-val">You own all</div>
                      <div className="lt-info-card-sub">sent to your wallet</div>
                    </div>
                  </div>
                )}

                {/* Community listing badge */}
                <div className={`lt-community-badge ${willBeListed ? "yes" : "no"}`}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                    background: willBeListed ? "rgba(74,222,128,0.15)" : "rgba(245,158,11,0.12)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {willBeListed
                      ? <Check style={{ width: 16, height: 16, color: "#4ade80" }} />
                      : <AlertTriangle style={{ width: 16, height: 16, color: "#f59e0b" }} />
                    }
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: willBeListed ? "#4ade80" : "#fbbf24", marginBottom: 2 }}>
                      {willBeListed ? "✓ Will appear in Community Made" : "Won't appear in token list"}
                    </div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>
                      {willBeListed
                        ? `Your token will be searchable and tradable on AchSwap immediately after launch.`
                        : `Add at least ${COMMUNITY_THRESHOLD} USDC liquidity to get listed in the Community Made token list.`
                      }
                    </div>
                  </div>
                </div>

                {/* What happens to your tokens */}
                <div style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 14,
                  padding: "14px 16px",
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                    What happens with your tokens?
                  </div>
                  {[
                    { dot: "#6366f1", text: `${liquidityPercent}% of supply goes into the trading pool paired with your USDC` },
                    { dot: "#4ade80", text: `${100 - liquidityPercent}% is sent directly to your wallet — you own it fully` },
                    { dot: "#818cf8", text: "LP tokens representing your pool share go to your wallet" },
                    { dot: "#f59e0b", text: "You are the token owner — you can mint more or renounce ownership anytime" },
                  ].map((item, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: i < 3 ? 8 : 0 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: item.dot, flexShrink: 0, marginTop: 4 }} />
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", lineHeight: 1.5 }}>{item.text}</span>
                    </div>
                  ))}
                </div>

              </div>
              <div className="lt-btn-row">
                <button className="lt-btn-back" onClick={() => setStep(1)}>
                  <ChevronLeft style={{ width: 16, height: 16 }} /> Back
                </button>
                <button
                  className={`lt-btn-next ${step2Valid ? "active" : "disabled"}`}
                  onClick={() => step2Valid && setStep(3)}
                  disabled={!step2Valid}
                >
                  Review <ChevronRight style={{ width: 16, height: 16 }} />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 3: Review & Deploy ── */}
          {step === 3 && (
            <div className="lt-card">
              <div className="lt-card-hdr">
                <div className="lt-card-hdr-icon">
                  <Rocket style={{ width: 16, height: 16, color: "#818cf8" }} />
                </div>
                <div>
                  <h2>Review & Launch</h2>
                  <p>One transaction — deploys token + adds liquidity</p>
                </div>
              </div>
              <div className="lt-card-body">

                {/* Token identity preview */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 14,
                  padding: "14px 16px",
                  background: "rgba(99,102,241,0.06)",
                  border: "1px solid rgba(99,102,241,0.18)",
                  borderRadius: 16,
                }}>
                  <div style={{ width: 52, height: 52, borderRadius: "50%", border: "2px solid rgba(99,102,241,0.3)", overflow: "hidden", background: "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {logoUrl && !logoError
                      ? <img src={logoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setLogoError(true)} />
                      : <Coins style={{ width: 22, height: 22, color: "rgba(255,255,255,0.2)" }} />
                    }
                  </div>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: "white", letterSpacing: "-0.02em" }}>{name}</div>
                    <div style={{ fontSize: 13, color: "#a5b4fc", fontWeight: 700 }}>${symbol} · {fmt(supply, 0)} total supply</div>
                  </div>
                </div>

                {/* Review rows */}
                <div className="lt-review-section">
                  <div className="lt-review-title">Token</div>
                  {[
                    { label: "Name", val: name },
                    { label: "Symbol", val: symbol },
                    { label: "Total Supply", val: `${fmt(supply, 0)} tokens` },
                    { label: "Decimals", val: "18 (standard)" },
                  ].map(r => (
                    <div className="lt-review-row" key={r.label}>
                      <span className="lt-review-row-label">{r.label}</span>
                      <span className="lt-review-row-val">{r.val}</span>
                    </div>
                  ))}
                </div>

                <div className="lt-review-section">
                  <div className="lt-review-title">Liquidity</div>
                  {[
                    { label: "USDC Added", val: `${usdc} USDC` },
                    { label: "Tokens to Pool", val: `${fmt(tokensForLiquidity, 0)} (${liquidityPercent}%)` },
                    { label: "Tokens to Wallet", val: `${fmt(tokensForOwner, 0)} (${100 - liquidityPercent}%)` },
                    { label: "Initial Price", val: `$${initialPrice.toExponential(3)} per ${symbol}` },
                    { label: "Fully Diluted MCap", val: `$${fmt(marketCap, 2)}` },
                  ].map(r => (
                    <div className="lt-review-row" key={r.label}>
                      <span className="lt-review-row-label">{r.label}</span>
                      <span className="lt-review-row-val">{r.val}</span>
                    </div>
                  ))}
                </div>

                <div className="lt-review-section">
                  <div className="lt-review-title">Listing</div>
                  <div className="lt-review-row">
                    <span className="lt-review-row-label">Community Made listing</span>
                    <span className="lt-review-row-val" style={{ color: willBeListed ? "#4ade80" : "#fbbf24" }}>
                      {willBeListed ? "✓ Yes (≥500 USDC)" : "✗ No (<500 USDC)"}
                    </span>
                  </div>
                </div>

                {/* Warning */}
                <div className="lt-warn">
                  <AlertTriangle style={{ width: 14, height: 14 }} />
                  <span>
                    This action is <strong style={{ color: "rgba(251,191,36,0.9)" }}>irreversible</strong>.
                    The token contract will be deployed and liquidity locked in the pool.
                    Make sure all details are correct before proceeding.
                    You will pay <strong style={{ color: "rgba(251,191,36,0.9)" }}>{usdc} USDC</strong> + gas.
                  </span>
                </div>

                {!isConnected && (
                  <div className="lt-warn" style={{ background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.2)" }}>
                    <AlertTriangle style={{ width: 14, height: 14, color: "#f87171" }} />
                    <span style={{ color: "#f87171" }}>Connect your wallet to launch your token.</span>
                  </div>
                )}

              </div>
              <div className="lt-btn-row">
                <button className="lt-btn-back" onClick={() => setStep(2)} disabled={isDeploying}>
                  <ChevronLeft style={{ width: 16, height: 16 }} /> Back
                </button>
                <button
                  className={`lt-btn-next ${isDeploying ? "loading" : isConnected ? "active" : "disabled"}`}
                  onClick={handleDeploy}
                  disabled={isDeploying || !isConnected}
                >
                  {isDeploying
                    ? <><span className="lt-spin" /> Launching…</>
                    : <><Rocket style={{ width: 16, height: 16 }} /> Launch Token</>
                  }
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 4: Success ── */}
          {step === 4 && (
            <div className="lt-card">
              <div className="lt-success">
                <div className="lt-success-ring">
                  <Check style={{ width: 32, height: 32, color: "#4ade80" }} />
                </div>
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 900, color: "white", margin: "0 0 6px", letterSpacing: "-0.02em" }}>
                    🎉 {symbol} is live!
                  </h2>
                  <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", margin: 0 }}>
                    Your token is deployed and tradable on AchSwap
                  </p>
                </div>

                {/* Token address */}
                {deployedToken && (
                  <div style={{
                    width: "100%",
                    padding: "12px 16px",
                    background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 14,
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Token Address</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {deployedToken}
                      </div>
                    </div>
                    <button
                      onClick={() => { navigator.clipboard.writeText(deployedToken); toast({ title: "Address copied!" }); }}
                      style={{ flexShrink: 0, padding: "6px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.4)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}
                    >
                      <Copy style={{ width: 12, height: 12 }} /> Copy
                    </button>
                  </div>
                )}

                {/* What's next */}
                <div style={{ width: "100%", background: "rgba(0,0,0,0.15)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: "14px 16px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>What's next?</div>
                  {[
                    { icon: "1", text: `Your ${symbol} tokens and LP tokens are in your wallet` },
                    { icon: "2", text: willBeListed ? `${symbol} appears in the Community Made section of the token selector` : `Add more liquidity to reach 500 USDC and get listed` },
                    { icon: "3", text: "You can swap, add liquidity, or share the contract address" },
                  ].map((item, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: i < 2 ? 10 : 0 }}>
                      <div style={{ width: 18, height: 18, borderRadius: "50%", background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "#a5b4fc", flexShrink: 0, marginTop: 1 }}>
                        {item.icon}
                      </div>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", lineHeight: 1.55 }}>{item.text}</span>
                    </div>
                  ))}
                </div>

                {/* Action buttons */}
                <div className="lt-success-actions">
                  <button className="lt-success-btn primary" onClick={() => window.location.href = "/"}>
                    <ArrowRight style={{ width: 16, height: 16 }} /> Swap {symbol} Now
                  </button>
                  {deployTxHash && (
                    <button className="lt-success-btn secondary" onClick={() => openExplorer(deployTxHash)}>
                      <ExternalLink style={{ width: 14, height: 14 }} /> View Transaction
                    </button>
                  )}
                  {deployedToken && (
                    <button className="lt-success-btn secondary" onClick={() => openTokenExplorer(deployedToken)}>
                      <ExternalLink style={{ width: 14, height: 14 }} /> View Token Contract
                    </button>
                  )}
                  <button
                    className="lt-success-btn secondary"
                    onClick={() => {
                      setStep(1); setName(""); setSymbol(""); setTotalSupply("1000000000");
                      setLogoUrl(""); setUsdcAmount(""); setLiquidityPercent(20);
                      setDeployedToken(null); setDeployTxHash(null);
                    }}
                  >
                    <Rocket style={{ width: 14, height: 14 }} /> Launch Another Token
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  );
}
