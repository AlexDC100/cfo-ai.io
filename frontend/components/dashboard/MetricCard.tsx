// F6.0.4 (2026-06-20) — Configurable dashboard metric card.
//
// Renders ONE card: concept name + live value (resolved from the active
// period ReportingMetrics) + optional period-comparison delta. The value
// is wrapped in LearnableNumber so the F5.0 popover still opens on tap.
//
// In edit mode the card grows a drag handle (dnd-kit) + a "..." menu with
// Remove and Resize. The grid footprint follows card.size.
//
// Visual language matches the legacy KpiTile (rounded-xl, border-rule,
// bg-surface, num-hero-fluid value) so the configurable grid reads as a
// natural evolution of the fixed tiles, not a different component.

import { useMemo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X, Maximize2, TrendingUp, TrendingDown } from "lucide-react";
import { lookupConcept } from "@/lib/learning/concepts";
import { useReportingMetrics } from "@/components/learning/ReportingContextProvider";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { Money } from "@/components/ui/Money";
import { useDashboard } from "@/stores/dashboard";
import {
  resolveConceptValue,
  formatCardValue,
} from "@/lib/dashboard/resolveConceptValue";
import { Sparkline } from "./Sparkline";
import {
  seriesForConcept,
  computeCAGR,
  type MultiYearSeries,
} from "@/lib/learning/multiPeriodSeries";
import type { DashboardCard, CardSize } from "@/types/dashboard";
import type { Currency } from "@/lib/rates";
import { cn } from "@/lib/utils";
import type { DashboardView } from "@/stores/dashboardView";

interface Props {
  card: DashboardCard;
  editMode: boolean;
  /** Canonical value overrides keyed by conceptKey — the page passes
   *  engine-routed numbers for legacy tiles so they stay byte-identical. */
  overrides?: Record<string, number | null | undefined>;
  /** F6.1 — multi-year series for the active period (built once at the page
   *  from statements.historicalPeriods). Drives the Trend-view sparkline. */
  series?: MultiYearSeries;
  /** F6.1 — snapshot (single value) vs trend (sparkline + CAGR). */
  view?: DashboardView;
}

interface TrendBadge {
  text: string;
  /** Direction of change: true = rose over the window, false = fell. Drives
   *  the up/down arrow + color. Purely directional — not a good/bad verdict. */
  positive: boolean;
}

/** Compact signed magnitude for a currency delta when CAGR can't be computed
 *  (a series endpoint ≤ 0 — e.g. a metric that's negative every year). No
 *  currency symbol: the headline above already carries the unit, so the badge
 *  reads as "moved by ~X" in the same unit. Avoids calling the currency
 *  formatter, which returns null (it defers to <Money>) and would print
 *  the literal string "null". */
function compactDelta(d: number): string {
  const sign = d >= 0 ? "+" : "−";
  const a = Math.abs(d);
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(0)}k`;
  return `${sign}${Math.round(a)}`;
}

const SIZE_GRID: Record<CardSize, string> = {
  sm: "col-span-1 row-span-1",
  md: "col-span-2 row-span-1",
  lg: "col-span-2 row-span-2",
};

/** Resize cycles sm → md → lg → sm. */
const NEXT_SIZE: Record<CardSize, CardSize> = {
  sm: "md",
  md: "lg",
  lg: "sm",
};

export function MetricCard({ card, editMode, overrides, series, view = "snapshot" }: Props) {
  const { removeCard, resizeCard } = useDashboard();
  const { metrics, currency, locale } = useReportingMetrics();

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id, disabled: !editMode });

  const concept = lookupConcept(card.conceptKey);
  const title =
    card.customTitle ??
    concept?.name?.[locale] ??
    concept?.name?.en ??
    card.conceptKey;

  const resolved = resolveConceptValue(card.conceptKey, metrics, overrides);
  const display = formatCardValue(resolved.value, resolved.format);

  // F6.1 — Trend view: the multi-year series for THIS concept (oldest →
  // newest). Only when the user toggled Trend AND the period has ≥2 years.
  const trendSeries = useMemo(() => {
    if (view !== "trend" || !series || series.available < 2) return null;
    const s = seriesForConcept(series, card.conceptKey);
    return s.length >= 2 ? s : null;
  }, [view, series, card.conceptKey]);

  // The little badge under the sparkline: CAGR for currency levels,
  // percentage-point delta for margins/ratios stored as decimals, absolute
  // delta otherwise. Direction (arrow + color) is factual, not a verdict.
  const trendBadge = useMemo<TrendBadge | null>(() => {
    if (!trendSeries) return null;
    const first = trendSeries[0].value;
    const last = trendSeries[trendSeries.length - 1].value;
    const years = trendSeries.length - 1;
    const rose = last >= first;
    if (resolved.format === "currency") {
      const cagr = computeCAGR(first, last, years);
      if (cagr === null) {
        // Endpoint ≤ 0 → CAGR undefined; show a compact signed magnitude
        // delta instead (never the literal "null" the currency formatter
        // would yield, since it defers rendering to <Money>).
        return { text: compactDelta(last - first), positive: rose };
      }
      return { text: `${cagr >= 0 ? "+" : ""}${(cagr * 100).toFixed(1)}%/yr`, positive: cagr >= 0 };
    }
    if (resolved.format === "percentage") {
      const pp = (last - first) * 100;
      return { text: `${pp >= 0 ? "+" : ""}${pp.toFixed(1)}pp`, positive: pp >= 0 };
    }
    // ratio / days / score → absolute delta in native unit
    const d = last - first;
    const suffix = resolved.format === "days" ? "d" : resolved.format === "ratio" ? "×" : "";
    return {
      text: `${d >= 0 ? "+" : ""}${Number.isInteger(d) ? d : d.toFixed(1)}${suffix}`,
      positive: rose,
    };
  }, [trendSeries, resolved.format]);

  const showTrend = trendSeries !== null;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`metric-card-${card.conceptKey}`}
      className={cn(
        "relative rounded-xl border bg-surface px-4 py-3 min-w-0 overflow-hidden",
        SIZE_GRID[card.size],
        editMode
          ? "border-[hsl(173,57%,55%)]/40 ring-1 ring-[hsl(173,57%,55%)]/20"
          : "border-rule",
      )}
    >
      {/* Edit-mode controls — drag handle (left) + remove/resize (right).
          Review #4 (2026-06-20): each control gets a 44×44 hit area
          (min-w/min-h-[44px] + grid place-items-center) so the icons stay
          visually small but the tap zone meets WCAG 2.5.5 on mobile. */}
      {editMode && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-0.5">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
            data-testid={`card-drag-${card.conceptKey}`}
            className="touch-none cursor-grab active:cursor-grabbing text-ink-mute hover:text-ink min-w-[44px] min-h-[44px] grid place-items-center rounded"
          >
            <GripVertical className="w-4 h-4" />
          </button>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => resizeCard(card.id, NEXT_SIZE[card.size])}
              aria-label="Resize card"
              data-testid={`card-resize-${card.conceptKey}`}
              className="text-ink-mute hover:text-ink min-w-[44px] min-h-[44px] grid place-items-center rounded hover:bg-bg-2"
              title={`Size: ${card.size.toUpperCase()} — tap to grow`}
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => removeCard(card.id)}
              aria-label="Remove card"
              data-testid={`card-remove-${card.conceptKey}`}
              className="text-ink-mute hover:text-[hsl(0,75%,55%)] min-w-[44px] min-h-[44px] grid place-items-center rounded hover:bg-bg-2"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Label — nudged down in edit mode so it clears the control row. */}
      <div
        className={cn(
          "text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate",
          editMode && "mt-11",
        )}
      >
        {title}
      </div>

      {/* Value — learnable. Currency renders <Money>; others render the
          formatted string. Both wrapped in LearnableNumber so the F5.0
          popover still opens. */}
      <div className="mt-2 num-hero num-hero-fluid text-ink leading-none">
        {resolved.value === null ? (
          <span className="text-ink-mute">—</span>
        ) : resolved.format === "currency" ? (
          <LearnableNumber conceptKey={card.conceptKey} value={resolved.value}>
            <Money
              value={resolved.value}
              fromCurrency={currency as Currency}
              compact
            />
          </LearnableNumber>
        ) : (
          <LearnableNumber conceptKey={card.conceptKey} value={resolved.value}>
            <span className="tabular-nums">{display}</span>
          </LearnableNumber>
        )}
      </div>

      {/* F6.1 — Trend view: sparkline + range caption + CAGR/Δ badge replaces
          the definition line. Snapshot view keeps the definition (md/lg only).
          The headline value above stays identical in both views (engine-
          canonical override-aware), so toggling never changes the number —
          it just adds the multi-year context underneath. */}
      {showTrend && trendSeries ? (
        <div className="mt-2" data-testid={`metric-trend-${card.conceptKey}`}>
          <Sparkline
            data={trendSeries}
            idKey={card.conceptKey}
            positive={trendBadge?.positive ?? true}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-[10px] text-ink-mute tabular-nums truncate">
              {trendSeries[0].label} → {trendSeries[trendSeries.length - 1].label}
            </span>
            {trendBadge && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 text-[10.5px] font-semibold tabular-nums whitespace-nowrap",
                  trendBadge.positive
                    ? "text-[hsl(173,57%,32%)]"
                    : "text-[hsl(0,70%,46%)]",
                )}
              >
                {trendBadge.positive ? (
                  <TrendingUp className="w-3 h-3" />
                ) : (
                  <TrendingDown className="w-3 h-3" />
                )}
                {trendBadge.text}
              </span>
            )}
          </div>
        </div>
      ) : (
        card.size !== "sm" &&
        concept?.shortDefinition && (
          <div className="mt-1.5 text-[11px] text-ink-soft leading-snug line-clamp-2">
            {concept.shortDefinition[locale] ?? concept.shortDefinition.en}
          </div>
        )
      )}
    </div>
  );
}
