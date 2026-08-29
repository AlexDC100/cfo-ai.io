// F6.1 (2026-06-21) — Dashboard sparkline.
//
// A minimal multi-year trend line for the Trend view of a MetricCard. Mirrors
// the StockPriceChart visual language (single line + soft area, no axes, no
// grid) but shrunk to a card footprint. Renders nothing below two points —
// the caller already gates on series.available, this is a belt-and-braces.
//
// THE INSTRUMENT (2026-08-29): color flows through tokens, not hex. The line
// and its gradient render in `currentColor`, and a wrapper span carries a
// token text class — `positive` maps to success/alert (the market-surface
// convention the public-companies consumers rely on), while `toneClass`
// lets a calmer surface (the metrics grid) pin one accent for both
// directions, because red is reserved for imbalance/danger there.
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
  /** Up trend → success, down → alert. Defaults to up. Ignored when
   *  `toneClass` is set. */
  positive?: boolean;
  /** Token text class that pins the line color regardless of direction
   *  (e.g. "text-brand-d dark:text-brand-l" on the metrics grid). */
  toneClass?: string;
  height?: number;
}

export function Sparkline({ data, idKey, positive = true, toneClass, height = 34 }: Props) {
  if (!data || data.length < 2) return null;

  const colorClass = toneClass ?? (positive ? "text-success" : "text-alert");
  // Sanitize idKey to a valid SVG id fragment (concept keys are already
  // snake_case, but guard anyway).
  const gradId = `spark-grad-${idKey.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <div className={colorClass}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 3, right: 1, left: 1, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke="currentColor"
            strokeWidth={1.6}
            fill={`url(#${gradId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
