import { useState } from "react";
import { RemoveLiquidityV2 } from "@/components/RemoveLiquidityV2";
import { RemoveLiquidityV3 } from "@/components/RemoveLiquidityV3";
import { Droplets, Zap } from "lucide-react";

type Proto = "v2" | "v3";

export default function RemoveLiquidity() {
  const [proto, setProto] = useState<Proto>("v2");

  return (
    <>
      <style>{`
        .rlp-root {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 24px 16px 48px;
          box-sizing: border-box;
        }
        .rlp-inner {
          width: 100%;
          max-width: 480px;
        }
        .rlp-heading {
          text-align: center;
          margin-bottom: 24px;
        }
        .rlp-heading h1 {
          font-size: clamp(22px, 5vw, 28px);
          font-weight: 800;
          color: white;
          margin: 0 0 6px;
          letter-spacing: -0.02em;
        }
        .rlp-heading p {
          font-size: 13px;
          color: rgba(255,255,255,0.35);
          margin: 0;
        }
        .rlp-proto-tabs {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-bottom: 16px;
        }
        .rlp-proto-btn {
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
        .rlp-proto-btn:hover {
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.6);
        }
        .rlp-proto-btn.active-v2 {
          background: rgba(99,102,241,0.12);
          border-color: rgba(99,102,241,0.4);
          color: #a5b4fc;
        }
        .rlp-proto-btn.active-v3 {
          background: rgba(139,92,246,0.12);
          border-color: rgba(139,92,246,0.4);
          color: #c4b5fd;
        }
        .rlp-proto-label {
          font-size: 16px;
          font-weight: 800;
          letter-spacing: -0.01em;
        }
        .rlp-proto-desc {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          opacity: 0.7;
        }
        .rlp-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          overflow: hidden;
        }
        .rlp-content {
          padding: 20px;
        }
        @media (max-width: 400px) {
          .rlp-content { padding: 14px; }
          .rlp-proto-btn { padding: 12px 8px; }
        }
      `}</style>

      <div className="rlp-root">
        <div className="rlp-inner">

          <div className="rlp-heading">
            <h1>Remove Liquidity</h1>
            <p>Withdraw your liquidity from pools</p>
          </div>

          <div className="rlp-proto-tabs">
            <button
              className={`rlp-proto-btn ${proto === "v2" ? "active-v2" : ""}`}
              onClick={() => setProto("v2")}
            >
              <Droplets style={{ width: 20, height: 20 }} />
              <span className="rlp-proto-label">V2</span>
              <span className="rlp-proto-desc">Classic AMM</span>
            </button>
            <button
              className={`rlp-proto-btn ${proto === "v3" ? "active-v3" : ""}`}
              onClick={() => setProto("v3")}
            >
              <Zap style={{ width: 20, height: 20 }} />
              <span className="rlp-proto-label">V3</span>
              <span className="rlp-proto-desc">Collect Fees</span>
            </button>
          </div>

          <div className="rlp-card">
            <div className="rlp-content">
              {proto === "v2" && <RemoveLiquidityV2 />}
              {proto === "v3" && <RemoveLiquidityV3 />}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
