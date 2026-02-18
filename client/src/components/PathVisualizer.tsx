import { ArrowRight } from "lucide-react";
import { Token } from "@shared/schema";
import { FEE_TIER_LABELS } from "@/lib/abis/v3";

export interface RouteHop {
  tokenIn: Token;
  tokenOut: Token;
  protocol: "V2" | "V3";
  fee?: number; // For V3 only
}

interface PathVisualizerProps {
  route: RouteHop[];
  className?: string;
}

export function PathVisualizer({ route, className = "" }: PathVisualizerProps) {
  if (!route || route.length === 0) {
    return null;
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="text-xs font-medium text-slate-400">Routing Path</div>
      <div className="flex items-center gap-2 flex-wrap">
        {route.map((hop, index) => (
          <div key={index} className="flex items-center gap-2">
            {/* Token In (only show for first hop) */}
            {index === 0 && (
              <>
                <TokenBadge token={hop.tokenIn} />
                <Arrow />
              </>
            )}
            
            {/* Protocol & Fee Badge */}
            <ProtocolBadge protocol={hop.protocol} fee={hop.fee} />
            <Arrow />
            
            {/* Token Out */}
            <TokenBadge token={hop.tokenOut} />
            
            {/* Add arrow if not last hop */}
            {index < route.length - 1 && <Arrow />}
          </div>
        ))}
      </div>
    </div>
  );
}

function TokenBadge({ token }: { token: Token }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg">
      {token.logoURI && (
        <img
          src={token.logoURI}
          alt={token.symbol}
          className="w-4 h-4 rounded-full"
          onError={(e) => {
            e.currentTarget.src = "/img/logos/unknown-token.png";
          }}
        />
      )}
      <span className="text-xs font-medium text-white">{token.symbol}</span>
    </div>
  );
}

function ProtocolBadge({ protocol, fee }: { protocol: "V2" | "V3"; fee?: number }) {
  const isV3 = protocol === "V3";
  const feeLabel = fee && isV3 ? FEE_TIER_LABELS[fee as keyof typeof FEE_TIER_LABELS] : null;
  
  return (
    <div
      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border ${
        isV3
          ? "bg-purple-500/10 border-purple-500/30 text-purple-400"
          : "bg-blue-500/10 border-blue-500/30 text-blue-400"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span>{protocol}</span>
        {feeLabel && <span className="text-[10px] opacity-75">({feeLabel})</span>}
      </div>
    </div>
  );
}

function Arrow() {
  return <ArrowRight className="h-3 w-3 text-slate-500 shrink-0" />;
}
