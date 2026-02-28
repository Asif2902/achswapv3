import { useState } from "react";
import { RemoveLiquidityV2 } from "@/components/RemoveLiquidityV2";
import { RemoveLiquidityV3 } from "@/components/RemoveLiquidityV3";
import { Droplets, Zap, AlertTriangle } from "lucide-react";
import { useRequireArcChain } from "@/hooks/useRequireArcChain";

type Proto = "v2" | "v3";

export default function RemoveLiquidity() {
  const { isWrongChain, isSwitching, switchToArc } = useRequireArcChain();
  const [proto, setProto] = useState<Proto>("v2");

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-6 pb-12 box-border">
      <div className="w-full max-w-[480px]">

        <div className="text-center mb-6">
          <h1 className="text-2xl font-extrabold text-white mb-1.5 tracking-tight">Remove Liquidity</h1>
          <p className="text-xs text-white/35 m-0">Withdraw your liquidity from pools</p>
        </div>

        {isWrongChain && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", marginBottom: 12, borderRadius: 16, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)" }}>
            <AlertTriangle style={{ width: 18, height: 18, flexShrink: 0, color: "#f59e0b" }} />
            <span style={{ flex: 1, fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.4 }}>
              You're on the <strong style={{ color: "#fbbf24", fontWeight: 700 }}>wrong network</strong>. Switch to <strong style={{ color: "#fbbf24", fontWeight: 700 }}>Arc Testnet</strong> to remove liquidity.
            </span>
            <button
              onClick={switchToArc}
              disabled={isSwitching}
              style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 10, border: "none", background: "linear-gradient(135deg,#6366f1,#3b82f6)", color: "white", fontSize: 12, fontWeight: 700, cursor: isSwitching ? "not-allowed" : "pointer", opacity: isSwitching ? 0.6 : 1, whiteSpace: "nowrap" }}
            >
              {isSwitching ? "Switching..." : "Switch"}
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 mb-4">
          <button
            className={`flex flex-col items-center gap-1 p-3.5 rounded-2xl border bg-white/[0.03] border-white/[0.07] cursor-pointer transition-all duration-200 text-white/35 hover:bg-white/[0.06] hover:text-white/60 ${
              proto === "v2" ? "!bg-indigo-500/12 !border-indigo-500/40 !text-indigo-300" : ""
            }`}
            onClick={() => setProto("v2")}
          >
            <Droplets style={{ width: 20, height: 20 }} />
            <span className="text-base font-extrabold tracking-tight">V2</span>
            <span className="text-[10px] font-semibold tracking-widest uppercase opacity-70">Classic AMM</span>
          </button>
          <button
            className={`flex flex-col items-center gap-1 p-3.5 rounded-2xl border bg-white/[0.03] border-white/[0.07] cursor-pointer transition-all duration-200 text-white/35 hover:bg-white/[0.06] hover:text-white/60 ${
              proto === "v3" ? "!bg-violet-500/12 !border-violet-500/40 !text-violet-300" : ""
            }`}
            onClick={() => setProto("v3")}
          >
            <Zap style={{ width: 20, height: 20 }} />
            <span className="text-base font-extrabold tracking-tight">V3</span>
            <span className="text-[10px] font-semibold tracking-widest uppercase opacity-70">Collect Fees</span>
          </button>
        </div>

        {proto === "v2" && <RemoveLiquidityV2 />}
        {proto === "v3" && <RemoveLiquidityV3 />}

      </div>
    </div>
  );
}
