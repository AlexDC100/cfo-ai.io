// StockPriceChart — Recharts area chart for the StockDetailDrawer.
//
// PUB-200 — Apple Stocks / Nasdaq-inspired. Single line + soft area
// underneath. Tooltip with date + price. Loading skeleton. Demo
// watermark when source !== "nasdaq". No volume bars in v1 (per spec
// §12 "optional"); reserved for a follow-up.
//
// Currency-aware: monetary axes render through the Money primitive's
// formatter so RON/EUR/USD toggle reflows the chart labels.

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Loader2 } from "lucide-react";

import type { PriceHistoryPayload, PriceRange } from "@/lib/publicCompanyPriceHistory";
import { priceDelta } from "@/lib/publicCompanyPriceHistory";
import { useCurrency } from "@/stores/currency";
import { convertFromTo } from "@/lib/money";
import type { Currency } from "@/lib/rates";

interface Props {
  data: PriceHistoryPayload | undefined;
  range: PriceRange;
  isLoading: boolean;
  isError: boolean;
  /** When true, render the empty-state "no live data" message. */
  unavailable?: boolean;
}

const HEIGHT = 220;

export function StockPriceChart({ data, range, isLoading, isError, unavailable }: Props) {
  const { display, rates } = useCurrency();
  // SEP series are USD; BVB series (source "bvb_yahoo") are RON — the
  // payload's currency field is authoritative.
  const sourceCurrency: Currency = (data?.currency as Currency) || "USD";

  const series = useMemo(() => {
    if (!data?.points) return [];
    return data.points.map((p) => ({
      date: p.date,
      close: convertFromTo(p.close, sourceCurrency, display, rates.rates),
    }));
  }, [data, display, rates, sourceCurrency]);

  const delta = useMemo(() => priceDelta(data?.points ?? []), [data]);
  const isDemo = data?.source === "demo";
  const isUnavailable = unavailable || data?.source === "unavailable";

  // ── Loading skeleton ──
  if (isLoading) {
    return (
      <div
        data-testid="stock-price-chart-loading"
        className="flex items-center justify-center rounded-lg border border-rule bg-bg-2/30"
        style={{ height: HEIGHT }}
      >
        <Loader2 className="animate-spin text-ink-mute" size={20} strokeWidth={1.5} />
      </div>
    );
  }

  // ── Error or unavailable ──
  if (isError || isUnavailable || series.length === 0) {
    return (
      <div
        data-testid="stock-price-chart-empty"
        className="
          flex flex-col items-center justify-center gap-2
          rounded-lg border border-rule bg-bg-2/30
          text-center px-6
        "
        style={{ height: HEIGHT }}
      >
        <div className="text-[13px] text-ink-soft font-medium">
          Price history unavailable
        </div>
        <div className="text-[11px] text-ink-mute max-w-[280px] leading-relaxed">
          {data?.message ??
            "No price points are available for this company yet."}
        </div>
      </div>
    );
  }

  // ── Chart ──
  // Movement colors from the token sheet: success up, alert down.
  const lineColor = delta && delta.abs >= 0 ? "hsl(var(--success))" : "hsl(var(--alert))";
  const areaGradientId = `area-grad-${data?.ticker ?? "x"}-${range}`;

  return (
    <div
      data-testid="stock-price-chart"
      data-source={data?.source ?? "unknown"}
      className="relative rounded-lg border border-rule bg-surface p-2"
      style={{ minHeight: HEIGHT + 24 }}
    >
      {isDemo && (
        <div
          aria-label="Demo data watermark"
          className="
            absolute top-2 right-3 z-10
            text-[10px] uppercase tracking-wider font-semibold
            text-ink-mute/60 select-none
          "
        >
          Demo
        </div>
      )}
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <AreaChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id={areaGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.18} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--rule-soft))" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(v) => {
              const d = new Date(v);
              if (range === "1D" || range === "5D") {
                return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
              }
              if (range === "1Y" || range === "YTD" || range === "6M" || range === "1M") {
                return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
              }
              return d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
            }}
            tick={{ fontSize: 10, fill: "hsl(var(--ink-mute))" }}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v) => `${display === "USD" ? "$" : ""}${Math.round(v).toLocaleString()}${display === "USD" ? "" : ` ${display}`}`}
            tick={{ fontSize: 10, fill: "hsl(var(--ink-mute))" }}
            tickLine={false}
            axisLine={false}
            width={60}
            orientation="right"
          />
          <Tooltip
            cursor={{ stroke: "hsl(var(--ink-faint))", strokeDasharray: "3 3" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const v = payload[0]?.value as number;
              const d = new Date(String(label));
              return (
                <div className="rounded-md border border-rule bg-bg shadow-md px-2.5 py-1.5">
                  <div className="text-[10px] text-ink-mute uppercase tracking-wide">
                    {d.toLocaleDateString(undefined, {
                      year: "numeric", month: "short", day: "numeric",
                    })}
                  </div>
                  <div className="text-[13px] font-semibold text-ink tabular-nums">
                    {display === "USD" ? "$" : ""}
                    {v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    {display !== "USD" && ` ${display}`}
                  </div>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke={lineColor}
            strokeWidth={1.75}
            fill={`url(#${areaGradientId})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
