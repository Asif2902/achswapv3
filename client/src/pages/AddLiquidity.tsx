import { useState } from "react";
import { AddLiquidityV2 } from "@/components/AddLiquidityV2";
import { AddLiquidityV3Basic } from "@/components/AddLiquidityV3Basic";
import { AddLiquidityV3Advanced } from "@/components/AddLiquidityV3Advanced";
import { MigrateV2ToV3 } from "@/components/MigrateV2ToV3";
import { Droplets, Layers, Zap, ArrowRight, AlertTriangle } from "lucide-react";
import { useRequireArcChain } from "@/hooks/useRequireArcChain";

type V2Tab = "add" | "migrate";
type V3Tab = "basic" | "advanced";
type Proto = "v2" | "v3";

export default function AddLiquidity() {
  const { isWrongChain, isSwitching, switchToArc } = useRequireArcChain();
  const [proto, setProto] = useState<Proto>("v2");
  const [v2Tab, setV2Tab] = useState<V2Tab>("add");
  const [v3Tab, setV3Tab] = useState<V3Tab>("basic");

  return (
    <>
      <style>{`
        .alp-root {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 24px 16px 48px;
          box-sizing: border-box;
        }
        .alp-inner {
          width: 100%;
          max-width: 480px;
        }
        /* ── page heading ── */
        .alp-heading {
          text-align: center;
          margin-bottom: 24px;
        }
        .alp-heading h1 {
          font-size: clamp(22px, 5vw, 28px);
          font-weight: 800;
          color: white;
          margin: 0 0 6px;
          letter-spacing: -0.02em;
        }
        .alp-heading p {
          font-size: 13px;
          color: rgba(255,255,255,0.35);
          margin: 0;
        }
        /* ── protocol switcher ── */
        .alp-proto-tabs {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-bottom: 16px;
        }
        .alp-proto-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 14px 12px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.07);
          background: rgba(255,255,255,0.03);
          cursor: pointer;
          transition: all 0.2s;
          color: rgba(255,255,255,0.35);
        }
        .alp-proto-btn:hover {
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.6);
        }
        .alp-proto-btn.active-v2 {
          background: rgba(99,102,241,0.12);
          border-color: rgba(99,102,241,0.4);
          color: #a5b4fc;
        }
        .alp-proto-btn.active-v3 {
          background: rgba(139,92,246,0.12);
          border-color: rgba(139,92,246,0.4);
          color: #c4b5fd;
        }
        .alp-proto-label {
          font-size: 16px;
          font-weight: 800;
          letter-spacing: -0.01em;
        }
        .alp-proto-desc {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          opacity: 0.7;
        }
        /* ── card shell ── */
        .alp-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          overflow: hidden;
        }
        /* ── sub-tab bar ── */
        .alp-subtabs {
          display: flex;
          gap: 4px;
          padding: 8px;
          background: rgba(0,0,0,0.2);
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .alp-subtab {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 9px 8px;
          border-radius: 12px;
          border: none;
          background: transparent;
          color: rgba(255,255,255,0.35);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .alp-subtab:hover { color: rgba(255,255,255,0.6); background: rgba(255,255,255,0.04); }
        .alp-subtab.active-v2 {
          background: rgba(99,102,241,0.2);
          color: #a5b4fc;
        }
        .alp-subtab.active-v3 {
          background: rgba(139,92,246,0.2);
          color: #c4b5fd;
        }
        /* ── content area ── */
        .alp-content {
          padding: 20px;
        }
        @media (max-width: 400px) {
          .alp-content { padding: 14px; }
          .alp-proto-btn { padding: 12px 8px; }
        }
        .alp-chain-banner { display:flex; align-items:center; gap:10px; padding:12px 16px; margin-bottom:12px; border-radius:16px; background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.25); }
        .alp-chain-banner-icon { flex-shrink:0; color:#f59e0b; }
        .alp-chain-banner-text { flex:1; font-size:13px; color:rgba(255,255,255,0.7); line-height:1.4; }
        .alp-chain-banner-text strong { color:#fbbf24; font-weight:700; }
        .alp-chain-banner-btn { flex-shrink:0; padding:7px 14px; border-radius:10px; border:none; background:linear-gradient(135deg,#6366f1,#3b82f6); color:white; font-size:12px; font-weight:700; cursor:pointer; transition:all 0.2s; white-space:nowrap; }
        .alp-chain-banner-btn:hover { background:linear-gradient(135deg,#4f46e5,#2563eb); transform:translateY(-1px); box-shadow:0 4px 16px rgba(99,102,241,0.4); }
        .alp-chain-banner-btn:disabled { opacity:0.6; cursor:not-allowed; transform:none; box-shadow:none; }
      `}</style>

      <div className="alp-root">
        <div className="alp-inner">

          {/* Heading */}
          <div className="alp-heading">
            <h1>Add Liquidity</h1>
            <p>Provide liquidity and earn trading fees</p>
          </div>

          {isWrongChain && (
            <div className="alp-chain-banner">
              <AlertTriangle className="alp-chain-banner-icon" style={{ width: 18, height: 18 }} />
              <span className="alp-chain-banner-text">
                You're on the <strong>wrong network</strong>. Switch to <strong>Arc Testnet</strong> to add liquidity.
              </span>
              <button className="alp-chain-banner-btn" onClick={switchToArc} disabled={isSwitching}>
                {isSwitching ? "Switching..." : "Switch"}
              </button>
            </div>
          )}

          {/* Protocol toggle */}
          <div className="alp-proto-tabs">
            <button
              className={`alp-proto-btn ${proto === "v2" ? "active-v2" : ""}`}
              onClick={() => setProto("v2")}
            >
              <Droplets style={{ width: 20, height: 20 }} />
              <span className="alp-proto-label">V2</span>
              <span className="alp-proto-desc">Classic AMM</span>
            </button>
            <button
              className={`alp-proto-btn ${proto === "v3" ? "active-v3" : ""}`}
              onClick={() => setProto("v3")}
            >
              <Zap style={{ width: 20, height: 20 }} />
              <span className="alp-proto-label">V3</span>
              <span className="alp-proto-desc">Concentrated</span>
            </button>
          </div>

          {/* Card */}
          <div className="alp-card">

            {/* Sub-tabs */}
            {proto === "v2" && (
              <div className="alp-subtabs">
                <button
                  className={`alp-subtab ${v2Tab === "add" ? "active-v2" : ""}`}
                  onClick={() => setV2Tab("add")}
                >
                  <Droplets style={{ width: 14, height: 14 }} />
                  Add LP
                </button>
                <button
                  className={`alp-subtab ${v2Tab === "migrate" ? "active-v2" : ""}`}
                  onClick={() => setV2Tab("migrate")}
                >
                  <ArrowRight style={{ width: 14, height: 14 }} />
                  Migrate to V3
                </button>
              </div>
            )}
            {proto === "v3" && (
              <div className="alp-subtabs">
                <button
                  className={`alp-subtab ${v3Tab === "basic" ? "active-v3" : ""}`}
                  onClick={() => setV3Tab("basic")}
                >
                  <Layers style={{ width: 14, height: 14 }} />
                  Basic (Safe)
                </button>
                <button
                  className={`alp-subtab ${v3Tab === "advanced" ? "active-v3" : ""}`}
                  onClick={() => setV3Tab("advanced")}
                >
                  <Zap style={{ width: 14, height: 14 }} />
                  Advanced (Pro)
                </button>
              </div>
            )}

            {/* Content */}
            <div className="alp-content">
              {proto === "v2" && v2Tab === "add"     && <AddLiquidityV2 />}
              {proto === "v2" && v2Tab === "migrate" && <MigrateV2ToV3 />}
              {proto === "v3" && v3Tab === "basic"   && <AddLiquidityV3Basic />}
              {proto === "v3" && v3Tab === "advanced" && <AddLiquidityV3Advanced />}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
