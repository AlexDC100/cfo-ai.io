// F6.0.4 (2026-06-20) — Configurable dashboard metric card.
// Redesigned 2026-08-04 (metrics v2): plain-language ⓘ tooltip on every
// tile (MetricInfoTip — hover tooltip on desktop, tap popover on touch),
// and a per-card ⋯ overflow menu (Rearrange / Size / Remove) replacing the
// old header-level Customize entry point. All user-visible strings via t().
//
// THE INSTRUMENT (2026-08-29) — the last serif holdout on the flagship,
// migrated: stat-panel chrome (hairline border, radius token, NO resting
// shadow — the `.card-2026` shadowed card is gone), 11px caps label, and
// every figure through <Amount> in the mono ledger voice. Money values
// obey the ONE MoneyAmountGroup the parent grid mounts, so magnitudes
// unify across the row ("295,1 M RON" beside "17,7 M RON", never beside
// "17.703.055"). Percent levels render via PercentLevel (unsigned level,
// not a signed delta), ratios via CappedMultiple. Red is reserved for
// imbalance/danger, so the trend badge is a NEUTRAL chip whose signed
// figure carries direction — same convention as the key-metric row above.
//
// In edit mode ("Rearrange") the card grows a drag handle (dnd-kit) +
// remove button, and tapping the body cycles its size. Drag stays armed
// only in edit mode (distance/long-press sensors live in the parent).

import { useMemo, type ReactNode } from "react";
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
import { Amount } from "@/components/instrument/Amount";
import { Chip } from "@/components/instrument/Panel";
import {
  MoneyAmount,
  PercentLevel,
  CappedMultiple,
} from "@/components/comparison/MoneyAmount";
import { pickMagnitude } from "@/lib/amountFormat";
import { useDashboard } from "@/stores/dashboard";
import { resolveConceptValue } from "@/lib/dashboard/resolveConceptValue";
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
  /** Rendered figure (an <Amount> — mono, locale-aware, signed). */
  node: ReactNode;
  /** Direction of change: true = rose over the window, false = fell. Drives
   *  the up/down arrow only. Purely directional — not a good/bad verdict,
   *  which is exactly why the badge stays a NEUTRAL chip. */
  positive: boolean;
}

// Narrow no-break space — the instrument's joint between figure and unit.
const NNBSP = " ";

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

  // F6.1 — Trend view: the multi-year series for THIS concept (oldest →
  // newest). Only when the user toggled Trend AND the period has ≥2 years.
  const trendSeries = useMemo(() => {
    if (view !== "trend" || !series || series.available < 2) return null;
    const s = seriesForConcept(series, card.conceptKey);
    return s.length >= 2 ? s : null;
  }, [view, series, card.conceptKey]);

  // The little badge under the sparkline: CAGR for currency levels,
  // percentage-point delta for margins/ratios stored as decimals, absolute
  // delta otherwise. Direction (the arrow) is factual, not a verdict — the
  // chip stays neutral, and every figure renders through <Amount>.
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
        // delta instead. No currency symbol: the headline above already
        // carries the unit, so the badge reads "moved by ~X" in-unit.
        const d = last - first;
        return {
          node: <Amount value={d} signed magnitude={pickMagnitude([d])} />,
          positive: rose,
        };
      }
      return {
        // ONE span so the chip's flex gap can never split figure from unit.
        node: (
          <span className="font-mono tabular-nums whitespace-nowrap">
            <Amount kind="percent" value={cagr} fractionDigits={1} />
            /yr
          </span>
        ),
        positive: cagr >= 0,
      };
    }
    if (resolved.format === "percentage") {
      const pp = last - first; // ratio units — Amount renders ×100 as pp
      return {
        node: (
          <span className="font-mono tabular-nums whitespace-nowrap">
            <Amount kind="count" value={pp * 100} fractionDigits={1} signed />
            {NNBSP}pp
          </span>
        ),
        positive: pp >= 0,
      };
    }
    // ratio / days / score → absolute delta in native unit. Ratios keep two
    // decimals (the level shows "1,85×" — a "+0,0×" delta beside it would
    // claim less precision than the instrument actually has).
    const d = last - first;
    const suffix = resolved.format === "days" ? `${NNBSP}d` : resolved.format === "ratio" ? "×" : "";
    const digits =
      resolved.format === "ratio" ? 2 : Number.isInteger(d) ? 0 : 1;
    return {
      node: (
        <span className="font-mono tabular-nums whitespace-nowrap">
          <Amount kind="count" value={d} fractionDigits={digits} signed />
          {suffix}
        </span>
      ),
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
  //
  // D1 axe (nested-interactive): the wrapper used to be role="button", which
  // nested the ⋯ / drag / remove <button>s inside an interactive control. The
  // wrapper is now a PLAIN div; the accessible learn trigger is a stretched
  // sibling <button> (absolute inset-0) rendered below the corner controls,
  // so keyboard/AT reach one real button and nothing interactive is nested.
  const canExplain = !editMode && resolved.value !== null && resolved.format !== "count";
  const openConcept = (e: React.MouseEvent<HTMLElement>) => {
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
  // cycles its size sm → md → lg → sm (mouse convenience — the accessible
  // path is the ⋯ menu's Size entries). Corner controls stopPropagation.
  const handleCardClick = () => {
    if (editMode) resizeCard(card.id, NEXT_SIZE[card.size]);
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
      onClick={editMode ? handleCardClick : undefined}
      title={editMode ? t("metricsV2.tapToResize") : undefined}
      data-testid={`metric-card-${card.conceptKey}`}
      // Instrument stat-panel chrome: hairline border, 10px radius token,
      // flat at rest — NO shadow, no hover lift. One chrome for every tile.
      // Edit mode adds a brand ring so "rearrange" reads clearly.
      className={cn(
        "relative rounded-md border border-rule bg-surface px-4 py-3 min-w-0",
        SIZE_GRID[card.size],
        editMode && "ring-1 ring-brand/25 cursor-pointer",
      )}
    >
      {/* Stretched learn trigger — the ONE interactive element for the card
          body. A positioned sibling of the corner controls (never their
          ancestor), it covers the tile at z-0 while the controls sit at
          z-10, so clicks on chrome open the concept and the a11y tree sees
          a flat set of buttons (no nested-interactive). */}
      {canExplain && (
        <button
          type="button"
          aria-label={title}
          onClick={(e) => {
            e.stopPropagation();
            openConcept(e);
          }}
          className="absolute inset-0 z-0 rounded-md cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        />
      )}
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
            className="text-ink-mute hover:text-alert min-w-[44px] min-h-[44px] grid place-items-center rounded-sm hover:bg-bg-2"
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
              className="absolute top-0 right-0 z-10 h-11 w-11 grid place-items-center rounded-md text-ink-mute/60 hover:text-ink transition-colors duration-150"
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
              className="min-h-[44px] gap-2 text-alert focus:text-alert"
            >
              <X className="w-4 h-4" />
              {t("metricsV2.menu.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Label row — name + ⓘ plain-language tip. pr clears the ⋯ corner
          control; nudged down in edit mode to clear the control row. */}
      {/* Lifted above the stretched trigger (z-[1]) so the ⓘ tip stays
          clickable; pointer-events-none on the row lets label clicks fall
          through to the trigger, re-enabled just on the tip itself. */}
      <div
        className={cn(
          "relative z-[1] pointer-events-none flex items-center gap-1.5 pr-8 min-w-0",
          editMode && "mt-11",
        )}
      >
        <span className="text-[11px] uppercase tracking-[0.08em] text-ink-soft font-medium truncate">
          {title}
        </span>
        {!editMode && tipText && (
          <span className="pointer-events-auto inline-flex">
            <MetricInfoTip text={tipText} conceptKey={card.conceptKey} />
          </span>
        )}
      </div>

      {/* Value — every figure through <Amount> (mono, tabular, locale-aware).
          Money obeys the ONE MoneyAmountGroup the parent grid mounts, so all
          currency tiles share a single magnitude. Same resolver as before. */}
      <div className="mt-2 text-[22px] font-medium text-ink leading-none tracking-[-0.01em] [overflow-wrap:anywhere]">
        {resolved.value === null ? (
          <span className="font-mono tabular-nums text-ink-soft">—</span>
        ) : resolved.format === "currency" ? (
          <MoneyAmount value={resolved.value} fromCurrency={currency as Currency} />
        ) : resolved.format === "percentage" ? (
          // Resolver stores percentages as DECIMALS (0.132) — PercentLevel
          // takes percent units, and renders an unsigned LEVEL ("13,2%"),
          // not a signed delta.
          <PercentLevel value={resolved.value * 100} />
        ) : resolved.format === "ratio" ? (
          <CappedMultiple value={resolved.value} />
        ) : resolved.format === "days" ? (
          <span className="font-mono tabular-nums">
            <Amount kind="count" value={Math.round(resolved.value)} />
            {NNBSP}d
          </span>
        ) : resolved.format === "count" ? (
          <Amount kind="count" value={Math.round(resolved.value)} />
        ) : (
          // score — raw figure, two decimals (Altman Z″ etc.)
          <Amount kind="count" value={resolved.value} fractionDigits={2} />
        )}
      </div>

      {/* F6.1 — Trend view: sparkline + range caption + CAGR/Δ badge replaces
          the definition line. Snapshot view keeps the definition (md/lg only).
          The headline value above stays identical in both views. */}
      {showTrend && trendSeries ? (
        <div className="mt-2" data-testid={`metric-trend-${card.conceptKey}`}>
          {/* One calm accent for the line in both directions — red is
              reserved for imbalance/danger on this surface; direction
              lives in the line's shape and the badge's signed figure. */}
          <Sparkline
            data={trendSeries}
            idKey={card.conceptKey}
            toneClass="text-brand-d dark:text-brand-l"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-ink-soft tabular-nums truncate">
              {trendSeries[0].label} → {trendSeries[trendSeries.length - 1].label}
            </span>
            {trendBadge && (
              <Chip
                tone="neutral"
                className="shrink-0 gap-1 whitespace-nowrap px-2 text-[10.5px]"
              >
                {trendBadge.positive ? (
                  <TrendingUp className="w-3 h-3 text-ink-soft" />
                ) : (
                  <TrendingDown className="w-3 h-3 text-ink-soft" />
                )}
                {trendBadge.node}
              </Chip>
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
