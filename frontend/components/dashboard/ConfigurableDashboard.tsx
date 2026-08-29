// F6.0.4 (2026-06-20) — Configurable dashboard grid.
// Redesigned 2026-08-04 (metrics v2):
//   · ONE "+ Add metric" entry — a single App-Store-style dashed tile at
//     the END of the grid opens the ConceptPicker. The old front tile,
//     the hole-filler tiles, and the header "Add metric" button are gone
//     (`grid-auto-flow: dense` backfills any md/lg wrap holes instead).
//   · The header "Customize" toggle is gone too — edit mode ("Rearrange")
//     is entered from any card's ⋯ overflow menu; the header shows only
//     Reset + Done while editing.
//   · Mobile-first columns (1 → sm:2 → xl:4), `.cards-stagger` reveal on
//     the grid (skipped in edit mode so the animation's fill-mode can't
//     fight dnd-kit's inline drag transforms), all strings via t().
//
// Drag uses @dnd-kit with a distance-based PointerSensor (8px) so a tap or
// scroll never accidentally starts a drag, and a TouchSensor with a
// 250ms long-press so mobile users can drag without fighting page scroll.
// Drag is only armed in edit mode.
//
// Lives INSIDE the ReportingContextProvider (the cards read
// useReportingMetrics there). Wrapped by DashboardProvider for the store.

import { useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { Plus, Check, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDashboard } from "@/stores/dashboard";
import { useDashboardView } from "@/stores/dashboardView";
import { useReportingMetrics } from "@/components/learning/ReportingContextProvider";
import { resolveConceptValue } from "@/lib/dashboard/resolveConceptValue";
import { MoneyAmountGroup } from "@/components/comparison/MoneyAmount";
import { MetricCard } from "./MetricCard";
import { ConceptPicker } from "./ConceptPicker";
import "./metricsV2I18n";
import { cn } from "@/lib/utils";
import type { MultiYearSeries } from "@/lib/learning/multiPeriodSeries";
import type { Currency } from "@/lib/rates";

interface Props {
  /** Canonical value overrides keyed by conceptKey — engine-routed
   *  numbers for the legacy tiles so they stay byte-identical. */
  overrides?: Record<string, number | null | undefined>;
  /** F6.1 — multi-year series for the active period; drives the Trend view.
   *  When it carries <2 years the Snapshot/Trend toggle is disabled. */
  series?: MultiYearSeries;
}

export function ConfigurableDashboard({ overrides, series }: Props) {
  const { t } = useTranslation();
  const {
    cards,
    isCustomized,
    atCardLimit,
    addCard,
    reorderCards,
    resetToDefault,
  } = useDashboard();
  const { view } = useDashboardView();
  const { metrics, currency } = useReportingMetrics();

  const [editMode, setEditMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // THE INSTRUMENT — ONE magnitude group for the whole grid: every money
  // tile's resolved value feeds the group, so the largest member picks the
  // shared scale and "295,1 M RON" can never sit beside "17.703.055 RON".
  // Non-money formats resolve to their own units and are excluded.
  const moneyValues = cards.map((c) => {
    const r = resolveConceptValue(c.conceptKey, metrics, overrides);
    return r.format === "currency" ? r.value : null;
  });

  // Trend is only meaningful with ≥2 years of history. When the active period
  // has none (e.g. a single backend trial balance), the toggle is disabled and
  // we force snapshot rendering regardless of the stored preference.
  const trendAvailable = (series?.available ?? 0) >= 2;
  const effectiveView = trendAvailable ? view : "snapshot";

  const sensors = useSensors(
    // Distance activation — a drag only begins after the pointer moves
    // 8px, so taps (open popover) and clicks (edit controls) are never
    // swallowed.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // Long-press for touch — 250ms with 8px tolerance lets vertical
    // scroll win unless the user deliberately holds.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = cards.map((c) => c.id);
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    reorderCards(arrayMove(ids, oldIndex, newIndex));
  }

  // THE one "+ Add metric" entry — a dashed QUIET panel that always closes
  // the grid. Same radius token as the stat panels so it reads as a sibling
  // tile; dashed hairline so it reads as an invitation, not data.
  const addMetricTile = (
    <button
      key="add-metric-tile"
      type="button"
      onClick={() => setPickerOpen(true)}
      disabled={atCardLimit}
      data-testid="dashboard-add-metric-tile"
      title={atCardLimit ? t("metricsV2.cardLimitReached") : t("metricsV2.addMetric")}
      className={cn(
        "col-span-1 row-span-1 group flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-rule text-ink-soft",
        "transition-colors duration-150 ease-out",
        atCardLimit
          ? "opacity-40 cursor-not-allowed"
          : "hover:text-ink hover:border-rule-strong hover:bg-bg-2/40 focus-visible:ring-2 focus-visible:ring-brand/30 focus:outline-none",
      )}
    >
      <span className="grid place-items-center h-8 w-8 rounded-full border border-rule group-hover:border-rule-strong transition-colors duration-150">
        <Plus className="w-4 h-4" />
      </span>
      <span className="text-[11.5px] font-medium">{t("metricsV2.addMetric")}</span>
    </button>
  );

  return (
    <section data-testid="configurable-dashboard" className="mb-3">
      {/* Control row — eyebrow left; Reset + Done appear only while
          rearranging (edit mode is entered from a card's ⋯ menu). */}
      <div className="flex items-center justify-between gap-2 mb-2 min-h-[32px]">
        <div className="text-[11px] uppercase tracking-[0.12em] text-ink-soft font-medium">
          {t("metricsV2.title")}
        </div>
        {editMode && (
          <div className="flex items-center gap-1.5">
            {isCustomized && (
              <button
                type="button"
                onClick={resetToDefault}
                data-testid="dashboard-reset"
                className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-2.5 rounded-md text-[12px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors duration-150"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t("metricsV2.reset")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditMode(false)}
              data-testid="dashboard-edit-toggle"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-2.5 rounded-md text-[12px] font-medium bg-brand-tint text-brand-d dark:text-brand-l transition-colors duration-150"
            >
              <Check className="w-3.5 h-3.5" />
              {t("metricsV2.done")}
            </button>
          </div>
        )}
      </div>

      {cards.length === 0 ? (
        // Empty dashboard — a single centered invitation instead of a
        // lonely dashed tile.
        <div className="rounded-md border border-dashed border-rule px-5 py-8 text-center">
          <p className="text-[13px] text-ink-soft mb-3">
            {t("metricsV2.emptyTitle")}
          </p>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            data-testid="dashboard-add-metric"
            className="inline-flex items-center gap-1.5 h-11 px-4 rounded-md bg-brand text-paper text-[13px] font-medium transition-colors duration-150 hover:bg-brand-d"
          >
            <Plus className="w-4 h-4" /> {t("metricsV2.addMetric")}
          </button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={cards.map((c) => c.id)}
            strategy={rectSortingStrategy}
          >
            {/* Mobile-first columns; dense auto-flow backfills the holes a
                wrapping md/lg card would otherwise strand. Stagger reveal is
                skipped in edit mode: `animation-fill-mode: forwards` would
                pin `transform: none` over dnd-kit's inline drag transform.
                MoneyAmountGroup converts to the display currency FIRST, so
                the shared magnitude is picked from what the reader sees. */}
            <MoneyAmountGroup
              values={moneyValues}
              fromCurrency={currency as Currency}
            >
              <div
                className={cn(
                  "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 auto-rows-[minmax(0,1fr)] gap-3 [grid-auto-flow:dense]",
                  !editMode && "cards-stagger",
                )}
              >
                {cards.map((card) => (
                  <MetricCard
                    key={card.id}
                    card={card}
                    editMode={editMode}
                    overrides={overrides}
                    series={series}
                    view={effectiveView}
                    onRearrange={() => setEditMode(true)}
                  />
                ))}
                {addMetricTile}
              </div>
            </MoneyAmountGroup>
          </SortableContext>
        </DndContext>
      )}

      <ConceptPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(key) => addCard(key)}
        excludeKeys={cards.map((c) => c.conceptKey)}
      />
    </section>
  );
}
