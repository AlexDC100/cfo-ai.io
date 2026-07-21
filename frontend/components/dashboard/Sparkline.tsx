// F6.1 (2026-06-21) — Dashboard sparkline.
//
// A minimal multi-year trend line for the Trend view of a MetricCard. Mirrors
// the StockPriceChart visual language (single line + soft area, no axes, no
// grid) but shrunk to a card footprint. Renders nothing below two points —
// the caller already gates on series.available, this is a belt-and-braces.
//
// The gradient id MUST be unique per card: every card on the dashboard shares
// the SAME period labels (FY2021…FY2025), so deriving the id from the labels
// alone would collide and cross-wire colors. The caller passes `idKey`
// (the conceptKey) which is unique per card.

import { Area, AreaChart, ResponsiveContainer } from "recharts";
import type { SeriesDatum } from "@/lib/learning/multiPeriodSeries";

interface Props {
  data: SeriesDatum[];
  /** Unique, DOM-safe token (the conceptKey) so gradient ids don't collide. */
  idKey: string;
  /** Up trend → green, down → red. Defaults to up. */
  positive?: boolean;
  height?: number;
}

export function Sparkline({ data, idKey, positive = true, height = 34 }: Props) {
  if (!data || data.length < 2) return null;

  const color = positive ? "#1B7268" : "#c62828";
  // Sanitize idKey to a valid SVG id fragment (concept keys are already
  // snake_case, but guard anyway).
  const gradId = `spark-grad-${idKey.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 3, right: 1, left: 1, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.6}
          fill={`url(#${gradId})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
