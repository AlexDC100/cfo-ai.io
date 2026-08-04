// F6.0.4 (2026-06-20) — Configurable dashboard metric card.
// Redesigned 2026-08-04 (metrics v2): uniform card system on the shared
// `.card-2026` chrome, a plain-language ⓘ tooltip on every tile
// (MetricInfoTip — hover tooltip on desktop, tap popover on touch), and a
// per-card ⋯ overflow menu (Rearrange / Size / Remove) replacing the old
// header-level Customize entry point. All user-visible strings via t().
//
// Renders ONE card: concept name + live value (resolved from the active
// period ReportingMetrics) + optional trend badge (Trend view only, when
// the multi-year series exists). Rendered numbers are untouched by the
// redesign — same resolver, same formatting, same overrides.
//
// In edit mode ("Rearrange") the card grows a drag handle (dnd-kit) +
// remove button, and tapping the body cycles its size. Drag stays armed
// only in edit mode (distance/long-press sensors live in the parent).

import { useMemo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  X,
  TrendingUp,
  TrendingDown,
  MoreHorizontal,
  Check,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { lookupConcept } from "@/lib/learning/concepts";
import { useReportingMetrics } from "@/components/learning/ReportingContextProvider";
import { usePopoverStack } from "@/components/learning/PopoverStackProvider";
import { Money } from "@/components/ui/Money";
import { useDashboard } from "@/stores/dashboard";
import {
  resolveConceptValue,
  formatCardValue,
} from "@/lib/dashboard/resolveConceptValue";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MetricInfoTip } from "./MetricInfoTip";
import "./metricsV2I18n";
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
  /** Metrics v2 — the ⋯ menu's "Rearrange" entry flips the grid into edit
   *  mode (the old header "Customize" button is gone). */
  onRearrange?: () => void;
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

/** Responsive grid footprint per card size. The grid is
 *  grid-cols-1 sm:grid-cols-2 xl:grid-cols-4, so a 2-col span must
 *  collapse to 1 col on phones or it would overflow the 1-col grid. */
const SIZE_GRID: Record<CardSize, string> = {
  sm: "col-span-1 row-span-1",
  md: "col-span-1 sm:col-span-2 row-span-1",
  lg: "col-span-1 sm:col-span-2 row-span-2",
};

/** Resize cycles sm → md → lg → sm (edit-mode tap). */
const NEXT_SIZE: Record<CardSize, CardSize> = {
  sm: "md",
  md: "lg",
  lg: "sm",
};

/** Default English titles baked into DEFAULT_DASHBOARD for the count cards
 *  (no concept-registry entry). When the stored customTitle is still the
 *  default, render the translated label instead of the baked literal. */
const DEFAULT_COUNT_TITLES: Record<string, string> = {
  open_risks: "Risks",
  open_opportunities: "Opportunities",
};

export function MetricCard({
  card,
  editMode,
  overrides,
  series,
  view = "snapshot",
  onRearrange,
}: Props) {
  const { t, i18n } = useTranslation();
  const { removeCard, resizeCard } = useDashboard();
  const { metrics, currency } = useReportingMetrics();
  const { push } = usePopoverStack();

  // Display locale follows the UI language (metrics v2 i18n pass). The
  // ReportingContextProvider's `locale` is hardcoded "en" at the page level,
  // so concept names/definitions would stay English in the RO UI without this.
  const locale: "en" | "ro" = i18n.language?.startsWith("ro") ? "ro" : "en";

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id, disabled: !editMode });

  const concept = lookupConcept(card.conceptKey);
  const defaultCountTitle = DEFAULT_COUNT_TITLES[card.conceptKey];
  const title =
    defaultCountTitle && (!card.customTitle || card.customTitle === defaultCountTitle)
      ? t(`metricsV2.count.${card.conceptKey}`, { defaultValue: defaultCountTitle })
      : card.customTitle ??
        concept?.name?.[locale] ??
        concept?.name?.en ??
        card.conceptKey;

  // Plain-language one-liner for the ⓘ tip. metricsV2.concepts.* covers every
  // addable concept + the count cards; the concept registry's translated
  // shortDefinition is the fallback for anything outside that set.
  const tipText = t(`metricsV2.concepts.${card.conceptKey}`, {
    defaultValue:
      concept?.shortDefinition?.[locale] ?? concept?.shortDefinition?.en ?? "",
  });

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

  // The WHOLE card is the learn trigger (2026-07-25) — pressing anywhere
  // opens the same concept popover the number used to. Disabled in edit
  // mode (that's for drag/resize) and when there's no value to explain.
  // Count cards (risks / opportunities tallies) have no concept-registry
  // entry, so there's nothing to explain — don't open the popover for them.
  const canExplain = !editMode && resolved.value !== null && resolved.format !== "count";
  const openConcept = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canExplain) return;
    push({
      conceptKey: card.conceptKey,
      value: resolved.value as number,
      triggerRect: e.currentTarget.getBoundingClientRect(),
      // KPI cards open the explanation as a right-edge slide-over (2026-07-25).
      presentation: "sheet",
    });
  };

  // Tap-to-grow (2026-07-25): in EDIT mode tapping anywhere on the card
  // cycles its size sm → md → lg → sm. In view mode the tap opens the
  // concept explanation. Corner controls stopPropagation.
  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (editMode) {
      resizeCard(card.id, NEXT_SIZE[card.size]);
      return;
    }
    if (canExplain) openConcept(e);
  };

  const sizeItems: Array<{ size: CardSize; label: string }> = [
    { size: "sm", label: t("metricsV2.menu.sizeSm") },
    { size: "md", label: t("metricsV2.menu.sizeMd") },
    { size: "lg", label: t("metricsV2.menu.sizeLg") },
  ];

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={editMode || canExplain ? handleCardClick : undefined}
      role={editMode || canExplain ? "button" : undefined}
      tabIndex={canExplain ? 0 : undefined}
      title={editMode ? t("metricsV2.tapToResize") : undefined}
      onKeyDown={
        canExplain
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                push({
                  conceptKey: card.conceptKey,
                  value: resolved.value as number,
                  triggerRect: e.currentTarget.getBoundingClientRect(),
                  presentation: "sheet",
                });
              }
            }
          : undefined
      }
      aria-label={canExplain ? title : undefined}
      data-testid={`metric-card-${card.conceptKey}`}
      // Metrics v2 chrome: the shared `.card-2026` editorial card (hairline
      // border, soft large-blur shadow, calm hover lift) — one chrome for
      // every tile. Edit mode adds a teal ring so "rearrange" reads clearly.
      className={cn(
        "card-2026 relative px-4 py-3 min-w-0",
        SIZE_GRID[card.size],
        editMode
          ? "ring-1 ring-[hsl(173,57%,55%)]/25 cursor-pointer"
          : "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
        canExplain && "cursor-pointer",
      )}
    >
      {/* Edit-mode controls — drag handle (left) + remove (right). Each
          control keeps a 44×44 hit area (WCAG 2.5.5). */}
      {editMode && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-0.5 z-10">
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("metricsV2.dragToReorder")}
            data-testid={`card-drag-${card.conceptKey}`}
            className="touch-none cursor-grab active:cursor-grabbing text-ink-mute hover:text-ink min-w-[44px] min-h-[44px] grid place-items-center rounded"
          >
            <GripVertical className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeCard(card.id); }}
            aria-label={t("metricsV2.removeCard")}
            data-testid={`card-remove-${card.conceptKey}`}
            className="text-ink-mute hover:text-[hsl(0,75%,55%)] min-w-[44px] min-h-[44px] grid place-items-center rounded hover:bg-bg-2"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* View-mode ⋯ overflow menu — the per-card home for Rearrange /
          Size / Remove now that the header Customize button is gone.
          44×44 hit area in the top-right corner. */}
      {!editMode && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("metricsV2.menu.open")}
              data-testid={`card-menu-${card.conceptKey}`}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="absolute top-0 right-0 z-10 h-11 w-11 grid place-items-center rounded-2xl text-ink-mute/60 hover:text-ink transition-colors duration-150"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={(e) => e.stopPropagation()}
            className="min-w-[170px]"
          >
            {onRearrange && (
              <DropdownMenuItem
                onClick={onRearrange}
                data-testid={`card-menu-rearrange-${card.conceptKey}`}
                className="min-h-[44px] gap-2"
              >
                <GripVertical className="w-4 h-4 text-ink-mute" />
                {t("metricsV2.menu.rearrange")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute">
              {t("metricsV2.menu.size")}
            </DropdownMenuLabel>
            {sizeItems.map((item) => (
              <DropdownMenuItem
                key={item.size}
                onClick={() => resizeCard(card.id, item.size)}
                className="min-h-[44px] gap-2"
              >
                <span className="grid place-items-center w-4">
                  {card.size === item.size && <Check className="w-3.5 h-3.5" />}
                </span>
                {item.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => removeCard(card.id)}
              data-testid={`card-menu-remove-${card.conceptKey}`}
              className="min-h-[44px] gap-2 text-[hsl(0,70%,52%)] focus:text-[hsl(0,70%,52%)]"
            >
              <X className="w-4 h-4" />
              {t("metricsV2.menu.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Label row — name + ⓘ plain-language tip. pr clears the ⋯ corner
          control; nudged down in edit mode to clear the control row. */}
      <div
        className={cn(
          "flex items-center gap-1.5 pr-8 min-w-0",
          editMode && "mt-11",
        )}
      >
        <span className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate">
          {title}
        </span>
        {!editMode && tipText && (
          <MetricInfoTip text={tipText} conceptKey={card.conceptKey} />
        )}
      </div>

      {/* Value — currency renders <Money>; others render the formatted
          string. Same resolver + formatting as before the redesign. */}
      <div className="mt-1 num-hero num-hero-fluid text-ink leading-none tabular-nums">
        {resolved.value === null ? (
          <span className="text-ink-mute">—</span>
        ) : resolved.format === "currency" ? (
          <Money
            value={resolved.value}
            fromCurrency={currency as Currency}
            compact
          />
        ) : (
          <span className="tabular-nums">{display}</span>
        )}
      </div>

      {/* F6.1 — Trend view: sparkline + range caption + CAGR/Δ badge replaces
          the definition line. Snapshot view keeps the definition (md/lg only).
          The headline value above stays identical in both views. */}
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
        tipText && (
          <div className="mt-1 text-[11px] text-ink-soft leading-snug line-clamp-2">
            {tipText}
          </div>
        )
      )}
    </div>
  );
}
