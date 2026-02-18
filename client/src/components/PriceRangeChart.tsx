import { useMemo } from "react";

interface PriceRangeChartProps {
  minPrice: number;
  maxPrice: number;
  currentPrice?: number;
  token0Symbol: string;
  token1Symbol: string;
}

export function PriceRangeChart({
  minPrice,
  maxPrice,
  currentPrice,
  token0Symbol,
  token1Symbol,
}: PriceRangeChartProps) {
  const chartData = useMemo(() => {
    if (!minPrice || !maxPrice || minPrice >= maxPrice) return null;

    const range = maxPrice - minPrice;
    const padding = range * 0.2;
    const chartMin = Math.max(0, minPrice - padding);
    const chartMax = maxPrice + padding;
    const chartRange = chartMax - chartMin;

    // Calculate positions as percentages
    const minPricePos = ((minPrice - chartMin) / chartRange) * 100;
    const maxPricePos = ((maxPrice - chartMin) / chartRange) * 100;
    const currentPricePos = currentPrice ? ((currentPrice - chartMin) / chartRange) * 100 : null;

    // Clamp positions to valid range
    const clampedMinPos = Math.max(0, Math.min(100, minPricePos));
    const clampedMaxPos = Math.max(0, Math.min(100, maxPricePos));
    const clampedCurrentPos = currentPricePos ? Math.max(0, Math.min(100, currentPricePos)) : null;

    const isInRange = currentPrice && currentPrice >= minPrice && currentPrice <= maxPrice;

    return {
      minPricePos: clampedMinPos,
      maxPricePos: clampedMaxPos,
      currentPricePos: clampedCurrentPos,
      rangeWidth: clampedMaxPos - clampedMinPos,
      isInRange,
    };
  }, [minPrice, maxPrice, currentPrice]);

  if (!chartData) {
    return (
      <div className="h-32 flex items-center justify-center bg-slate-800 rounded-lg border border-slate-700">
        <p className="text-xs text-slate-500">Enter valid price range to see chart</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>Price Range Visualization</span>
        <span>1 {token0Symbol} = ? {token1Symbol}</span>
      </div>

      {/* Chart Container */}
      <div className="relative h-32 bg-slate-800 rounded-lg border border-slate-700 p-4">
        {/* Price axis */}
        <div className="absolute bottom-4 left-4 right-4 h-2 bg-slate-700 rounded-full overflow-hidden">
          {/* Selected range highlight */}
          <div
            className={`absolute h-full ${
              chartData.isInRange ? "bg-green-500/30" : "bg-blue-500/30"
            } transition-all duration-300`}
            style={{
              left: `${chartData.minPricePos}%`,
              width: `${chartData.rangeWidth}%`,
            }}
          />

          {/* Min price marker */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full border-2 border-slate-900 shadow-lg transition-all duration-300"
            style={{ left: `${chartData.minPricePos}%`, transform: "translate(-50%, -50%)" }}
          />

          {/* Max price marker */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full border-2 border-slate-900 shadow-lg transition-all duration-300"
            style={{ left: `${chartData.maxPricePos}%`, transform: "translate(-50%, -50%)" }}
          />

          {/* Current price marker */}
          {chartData.currentPricePos !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-1 h-8 bg-yellow-400 shadow-lg transition-all duration-300"
              style={{ left: `${chartData.currentPricePos}%`, transform: "translateX(-50%)" }}
            />
          )}
        </div>

        {/* Labels */}
        <div className="absolute bottom-10 left-4 right-4 flex justify-between text-xs">
          <div
            className="absolute -translate-x-1/2 transition-all duration-300"
            style={{ left: `${chartData.minPricePos}%` }}
          >
            <div className="flex flex-col items-center gap-1">
              <span className="text-blue-400 font-semibold">{minPrice.toFixed(6)}</span>
              <span className="text-slate-500">Min</span>
            </div>
          </div>

          {chartData.currentPricePos !== null && (
            <div
              className="absolute -translate-x-1/2 transition-all duration-300"
              style={{ left: `${chartData.currentPricePos}%` }}
            >
              <div className="flex flex-col items-center gap-1">
                <span className="text-yellow-400 font-semibold">{currentPrice?.toFixed(6)}</span>
                <span className="text-slate-500">Current</span>
              </div>
            </div>
          )}

          <div
            className="absolute -translate-x-1/2 transition-all duration-300"
            style={{ left: `${chartData.maxPricePos}%` }}
          >
            <div className="flex flex-col items-center gap-1">
              <span className="text-blue-400 font-semibold">{maxPrice.toFixed(6)}</span>
              <span className="text-slate-500">Max</span>
            </div>
          </div>
        </div>

        {/* Status badge */}
        <div className="absolute top-2 right-2">
          {chartData.isInRange ? (
            <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs font-medium rounded border border-green-500/30">
              In Range
            </span>
          ) : currentPrice ? (
            <span className="px-2 py-1 bg-orange-500/20 text-orange-400 text-xs font-medium rounded border border-orange-500/30">
              Out of Range
            </span>
          ) : (
            <span className="px-2 py-1 bg-slate-700 text-slate-400 text-xs font-medium rounded border border-slate-600">
              No Pool
            </span>
          )}
        </div>
      </div>

      {/* Capital Efficiency Info */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="p-2 bg-slate-800/50 rounded border border-slate-700">
          <div className="text-slate-400 mb-1">Range Width</div>
          <div className="font-semibold text-white">
            {maxPrice && minPrice ? ((maxPrice / minPrice - 1) * 100).toFixed(1) : "0"}%
          </div>
        </div>
        <div className="p-2 bg-slate-800/50 rounded border border-slate-700">
          <div className="text-slate-400 mb-1">Capital Efficiency</div>
          <div className="font-semibold text-white">
            {maxPrice && minPrice
              ? (100 / ((maxPrice / minPrice - 1) * 100 || 1)).toFixed(1)
              : "0"}x
          </div>
        </div>
      </div>
    </div>
  );
}
