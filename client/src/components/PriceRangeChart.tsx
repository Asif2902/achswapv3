import { useMemo } from "react";

interface PriceRangeChartProps {
  minPrice: number;
  maxPrice: number;
  currentPrice?: number;
  token0Symbol: string;
  token1Symbol: string;
}

// Gaussian bell curve — normalized 0..1
function gaussian(x: number, mean: number, sigma: number): number {
  return Math.exp(-0.5 * Math.pow((x - mean) / sigma, 2));
}

// Smooth polyline → SVG path using quadratic bezier midpoints
function smoothPath(points: [number, number][]): string {
  if (points.length < 2) return "";
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const curr = points[i];
    const next = points[i + 1];
    const mx = ((curr[0] + next[0]) / 2).toFixed(2);
    const my = ((curr[1] + next[1]) / 2).toFixed(2);
    d += ` Q ${curr[0].toFixed(2)} ${curr[1].toFixed(2)} ${mx} ${my}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
  return d;
}

function formatLabel(price: number): string {
  if (price === 0) return "0";
  if (Math.abs(price) < 0.0001) return price.toPrecision(2);
  if (Math.abs(price) < 0.01) return price.toFixed(5);
  if (Math.abs(price) < 1) return price.toFixed(4);
  if (Math.abs(price) < 1000) return price.toFixed(2);
  return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function PriceRangeChart({
  minPrice,
  maxPrice,
  currentPrice,
  token0Symbol,
  token1Symbol,
}: PriceRangeChartProps) {
  const W = 480;
  const H = 148;
  const PX = 22;           // horizontal padding
  const CURVE_TOP = 12;    // top of curve area
  const AXIS_Y = H - 38;   // where axis line sits
  const CURVE_H = AXIS_Y - CURVE_TOP;

  const data = useMemo(() => {
    if (!minPrice || !maxPrice || minPrice >= maxPrice) return null;

    const pad = (maxPrice - minPrice) * 0.38;
    const vMin = Math.max(0, minPrice - pad);
    const vMax = maxPrice + pad;
    const vRange = vMax - vMin;

    const toX = (p: number) => PX + ((p - vMin) / vRange) * (W - PX * 2);

    const mean = currentPrice ?? (minPrice + maxPrice) / 2;
    const sigma = vRange * 0.20;

    const STEPS = 90;
    const pts: [number, number][] = [];
    for (let i = 0; i <= STEPS; i++) {
      const price = vMin + (i / STEPS) * vRange;
      const g = gaussian(price, mean, sigma);
      const x = PX + (i / STEPS) * (W - PX * 2);
      const y = CURVE_TOP + CURVE_H * (1 - g * 0.88); // 0.88 = peak doesn't touch top
      pts.push([x, y]);
    }

    const minX = toX(minPrice);
    const maxX = toX(maxPrice);
    const currX = currentPrice != null ? toX(currentPrice) : null;

    const isInRange = currentPrice != null && currentPrice >= minPrice && currentPrice <= maxPrice;

    // Range fill path: subset of curve + close along axis
    const rangePts = pts.filter(([x]) => x >= minX - 0.5 && x <= maxX + 0.5);
    let rangeFill = "";
    if (rangePts.length >= 2) {
      rangeFill =
        smoothPath(rangePts) +
        ` L ${rangePts[rangePts.length - 1][0].toFixed(2)} ${AXIS_Y}` +
        ` L ${rangePts[0][0].toFixed(2)} ${AXIS_Y} Z`;
    }

    return { pts, rangeFill, rangePts, minX, maxX, currX, isInRange };
  }, [minPrice, maxPrice, currentPrice]);

  if (!data) {
    return (
      <div className="h-36 flex items-center justify-center rounded-xl border border-slate-700/50 bg-slate-900/60">
        <p className="text-[11px] text-slate-500 tracking-wider">
          Enter a valid price range to preview
        </p>
      </div>
    );
  }

  const accent = data.isInRange ? "#22d3ee" : "#f97316"; // cyan in-range, orange out
  const accentDim = data.isInRange ? "#0e7490" : "#9a3412";
  const isOutBelowRange = currentPrice != null && currentPrice < minPrice;
  const isOutAboveRange = currentPrice != null && currentPrice > maxPrice;
  const statusText = data.isInRange
    ? "In Range"
    : currentPrice != null
    ? isOutBelowRange
      ? "Below Range"
      : "Above Range"
    : "No Pool";

  const rangeWidthPct =
    minPrice && maxPrice ? ((maxPrice / minPrice - 1) * 100).toFixed(1) : "0";

  const capEfficiency = (() => {
    if (!currentPrice || !data.isInRange) return null;
    try {
      const sqC = Math.sqrt(currentPrice),
        sqMin = Math.sqrt(minPrice),
        sqMax = Math.sqrt(maxPrice);
      if (sqC <= sqMin || sqC >= sqMax) return null;
      return Math.min(Math.round((sqC / (sqC - sqMin)) * (sqMax / (sqMax - sqC))), 9999);
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] font-semibold text-slate-500 tracking-[0.1em] uppercase">
          Liquidity Distribution
        </span>
        <div
          className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold border"
          style={{
            color: accent,
            borderColor: accent + "55",
            background: accent + "12",
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: accent,
              boxShadow: data.isInRange ? `0 0 6px ${accent}` : "none",
              animation: data.isInRange ? "pulse 2s infinite" : "none",
            }}
          />
          {statusText}
        </div>
      </div>

      {/* SVG */}
      <div className="rounded-xl overflow-hidden border border-slate-700/60 shadow-xl shadow-black/40">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ display: "block" }}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            {/* Dark bg with subtle vignette */}
            <radialGradient id="rg-bg" cx="50%" cy="40%" r="70%">
              <stop offset="0%" stopColor="#111827" />
              <stop offset="100%" stopColor="#080c14" />
            </radialGradient>

            {/* Curve bg fill (entire curve area, muted) */}
            <linearGradient id="rg-curveBg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1e293b" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#1e293b" stopOpacity="0" />
            </linearGradient>

            {/* Range fill — in range (cyan) */}
            <linearGradient id="rg-cyan" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.03" />
            </linearGradient>

            {/* Range fill — out of range (orange) */}
            <linearGradient id="rg-orange" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f97316" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#f97316" stopOpacity="0.03" />
            </linearGradient>

            {/* Current price glow */}
            <filter id="f-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="3.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Soft drop shadow for markers */}
            <filter id="f-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#000" floodOpacity="0.5" />
            </filter>

            {/* Clip chart */}
            <clipPath id="clip-chart">
              <rect x={PX} y={CURVE_TOP - 2} width={W - PX * 2} height={AXIS_Y - CURVE_TOP + 4} />
            </clipPath>
          </defs>

          {/* Background */}
          <rect width={W} height={H} fill="url(#rg-bg)" />

          {/* Subtle horizontal grid */}
          {[0.25, 0.5, 0.75].map((t, i) => (
            <line
              key={i}
              x1={PX + t * (W - PX * 2)}
              y1={CURVE_TOP}
              x2={PX + t * (W - PX * 2)}
              y2={AXIS_Y}
              stroke="#1e293b"
              strokeWidth="1"
              strokeDasharray="2 5"
            />
          ))}

          {/* Full curve bg fill */}
          <path
            d={
              smoothPath(data.pts) +
              ` L ${W - PX} ${AXIS_Y} L ${PX} ${AXIS_Y} Z`
            }
            fill="url(#rg-curveBg)"
            clipPath="url(#clip-chart)"
          />

          {/* Range fill */}
          {data.rangeFill && (
            <path
              d={data.rangeFill}
              fill={data.isInRange ? "url(#rg-cyan)" : "url(#rg-orange)"}
              clipPath="url(#clip-chart)"
            />
          )}

          {/* Full curve stroke (muted) */}
          <path
            d={smoothPath(data.pts)}
            fill="none"
            stroke="#334155"
            strokeWidth="1.5"
            strokeLinejoin="round"
            clipPath="url(#clip-chart)"
          />

          {/* Range curve stroke (accent) */}
          {data.rangePts.length >= 2 && (
            <path
              d={smoothPath(data.rangePts)}
              fill="none"
              stroke={accent}
              strokeWidth="2.2"
              strokeLinejoin="round"
              clipPath="url(#clip-chart)"
              opacity="0.9"
            />
          )}

          {/* Axis */}
          <line
            x1={PX}
            y1={AXIS_Y}
            x2={W - PX}
            y2={AXIS_Y}
            stroke="#1e293b"
            strokeWidth="1.5"
          />

          {/* Min price marker */}
          <line
            x1={data.minX}
            y1={CURVE_TOP}
            x2={data.minX}
            y2={AXIS_Y}
            stroke={accent}
            strokeWidth="1.5"
            strokeDasharray="4 3"
            opacity="0.6"
          />
          <circle
            cx={data.minX}
            cy={AXIS_Y}
            r="5"
            fill={accentDim}
            stroke={accent}
            strokeWidth="1.5"
            filter="url(#f-shadow)"
          />

          {/* Max price marker */}
          <line
            x1={data.maxX}
            y1={CURVE_TOP}
            x2={data.maxX}
            y2={AXIS_Y}
            stroke={accent}
            strokeWidth="1.5"
            strokeDasharray="4 3"
            opacity="0.6"
          />
          <circle
            cx={data.maxX}
            cy={AXIS_Y}
            r="5"
            fill={accentDim}
            stroke={accent}
            strokeWidth="1.5"
            filter="url(#f-shadow)"
          />

          {/* Current price line */}
          {data.currX !== null && (
            <>
              {/* Glow band */}
              <line
                x1={data.currX}
                y1={CURVE_TOP - 2}
                x2={data.currX}
                y2={AXIS_Y}
                stroke="#facc15"
                strokeWidth="6"
                opacity="0.12"
              />
              {/* Actual line */}
              <line
                x1={data.currX}
                y1={CURVE_TOP - 2}
                x2={data.currX}
                y2={AXIS_Y}
                stroke="#facc15"
                strokeWidth="1.8"
                filter="url(#f-glow)"
              />
              {/* Bottom diamond */}
              <polygon
                points={`${data.currX},${AXIS_Y - 7} ${data.currX + 5},${AXIS_Y} ${data.currX},${AXIS_Y + 5} ${data.currX - 5},${AXIS_Y}`}
                fill="#facc15"
                filter="url(#f-glow)"
              />
            </>
          )}

          {/* ── Labels ── */}

          {/* Min label */}
          {(() => {
            const lx = Math.max(PX + 12, Math.min(W - PX - 12, data.minX));
            return (
              <g>
                <text x={lx} y={AXIS_Y + 14} textAnchor="middle" fontSize="9.5" fill={accent} fontFamily="'Courier New', monospace" fontWeight="600">
                  {formatLabel(minPrice)}
                </text>
                <text x={lx} y={AXIS_Y + 25} textAnchor="middle" fontSize="8" fill="#475569" fontFamily="sans-serif">
                  Min
                </text>
              </g>
            );
          })()}

          {/* Max label */}
          {(() => {
            const lx = Math.max(PX + 12, Math.min(W - PX - 12, data.maxX));
            return (
              <g>
                <text x={lx} y={AXIS_Y + 14} textAnchor="middle" fontSize="9.5" fill={accent} fontFamily="'Courier New', monospace" fontWeight="600">
                  {formatLabel(maxPrice)}
                </text>
                <text x={lx} y={AXIS_Y + 25} textAnchor="middle" fontSize="8" fill="#475569" fontFamily="sans-serif">
                  Max
                </text>
              </g>
            );
          })()}

          {/* Current price label */}
          {data.currX !== null && currentPrice != null && (() => {
            // Keep label inside chart; also nudge away from min/max labels if too close
            let lx = data.currX;
            if (Math.abs(lx - data.minX) < 36) lx = data.minX + 38;
            if (Math.abs(lx - data.maxX) < 36) lx = data.maxX - 38;
            lx = Math.max(PX + 14, Math.min(W - PX - 14, lx));
            return (
              <g>
                <text x={lx} y={AXIS_Y + 14} textAnchor="middle" fontSize="9.5" fill="#facc15" fontFamily="'Courier New', monospace" fontWeight="700">
                  {formatLabel(currentPrice)}
                </text>
                <text x={lx} y={AXIS_Y + 25} textAnchor="middle" fontSize="8" fill="#92400e" fontFamily="sans-serif">
                  Current
                </text>
              </g>
            );
          })()}

          {/* Pair label — top-right */}
          <text
            x={W - PX}
            y={CURVE_TOP + 9}
            textAnchor="end"
            fontSize="9"
            fill="#334155"
            fontFamily="'Courier New', monospace"
            letterSpacing="0.04em"
          >
            {token1Symbol}/{token0Symbol}
          </text>
        </svg>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        {[
          {
            label: "Range Width",
            value: `${rangeWidthPct}%`,
            color: "text-white",
          },
          {
            label: "Cap. Efficiency",
            value: capEfficiency && capEfficiency > 0 ? `${capEfficiency}×` : "—",
            color: capEfficiency && capEfficiency > 1 ? "text-cyan-400" : "text-slate-400",
          },
          {
            label: "Position",
            value: statusText,
            color: data.isInRange ? "text-cyan-400" : "text-orange-400",
          },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="p-2.5 rounded-lg border border-slate-700/50 bg-slate-800/50 space-y-0.5"
          >
            <div className="text-[9px] uppercase tracking-widest text-slate-500 font-medium">
              {label}
            </div>
            <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
