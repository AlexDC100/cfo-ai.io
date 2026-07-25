// F6.0.4 (2026-06-20) — Configurable dashboard grid.
//
// Replaces the legacy fixed 4-tile KPI strip on the Overview. Renders the
// user's saved card layout as a draggable grid; an edit-mode toggle
// reveals reorder (drag) + per-card remove/resize + "Add metric" + "Reset
// to default".
//
// Drag uses @dnd-kit with a distance-based PointerSensor (8px) so a tap or
// scroll never accidentally starts a drag, and a TouchSensor with a
// 250ms long-press so mobile users can drag without fighting page scroll
// (directly addresses the spec's mobile-drag anti-pattern). Drag is only
// armed in edit mode.
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
import { Plus, Pencil, Check, RotateCcw, Sparkles } from "lucide-react";
import { useDashboard } from "@/stores/dashboard";
import { useDashboardView } from "@/stores/dashboardView";
import { MetricCard } from "./MetricCard";
import { ConceptPicker } from "./ConceptPicker";
import { cn } from "@/lib/utils";
import type { MultiYearSeries } from "@/lib/learning/multiPeriodSeries";

interface Props {
  /** Canonical value overrides keyed by conceptKey — engine-routed
   *  numbers for the legacy tiles so they stay byte-identical. */
  overrides?: Record<string, number | null | undefined>;
  /** F6.1 — multi-year series for the active period; drives the Trend view.
   *  When it carries <2 years the Snapshot/Trend toggle is disabled. */
  series?: MultiYearSeries;
}

export function ConfigurableDashboard({ overrides, series }: Props) {
  const {
    cards,
    isCustomized,
    atCardLimit,
    addCard,
    reorderCards,
    resetToDefault,
  } = useDashboard();
  const { view } = useDashboardView();

  const [editMode, setEditMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // "Add metric" tile — one at the front, plus enough fillers to complete the
  // last 4-column row so the grid never looks half-empty. Column footprint:
  // sm = 1 col, md/lg = 2 cols; +1 for the front tile itself.
  const COLS = 4;
  const usedUnits = 1 + cards.reduce((sum, c) => sum + (c.size === "sm" ? 1 : 2), 0);
  const trailingAddTiles = (COLS - (usedUnits % COLS)) % COLS;

  const addMetricTile = (key: string) => (
    <button
      key={`add-metric-${key}`}
      type="button"
      onClick={() => setPickerOpen(true)}
      disabled={atCardLimit}
      data-testid={key === "front" ? "dashboard-add-metric-tile" : "dashboard-add-metric-filler"}
      title={atCardLimit ? "Card limit reached (20)" : "Add a metric"}
      className={cn(
        "col-span-1 row-span-1 group flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-rule text-ink-mute transition-colors",
        atCardLimit
          ? "opacity-40 cursor-not-allowed"
          : "hover:text-ink hover:border-rule-strong hover:bg-bg-2/40",
      )}
    >
      <span className="grid place-items-center h-7 w-7 rounded-full border border-rule group-hover:border-rule-strong transition-colors">
        <Plus className="w-3.5 h-3.5" />
      </span>
      <span className="text-[11.5px] font-medium">Add metric</span>
    </button>
  );

  return (
    <section data-testid="configurable-dashboard" className="mb-3">
      {/* Control row — the Snapshot/Trend toggle + sync indicator were
          removed per operator directive (2026-07-25); the grid always
          renders the snapshot view. Only the edit/customize controls remain,
          pinned right. */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
          <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
          Metrics
        </div>
        <div className="flex items-center gap-1.5">
          {editMode && isCustomized && (
            <button
              type="button"
              onClick={resetToDefault}
              data-testid="dashboard-reset"
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </button>
          )}
          {editMode && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={atCardLimit}
              data-testid="dashboard-add-metric"
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12px] font-medium transition-colors",
                atCardLimit
                  ? "text-ink-mute cursor-not-allowed"
                  : "text-[hsl(173,57%,38%)] hover:bg-[hsl(173,57%,55%)]/[0.08]",
              )}
              title={atCardLimit ? "Card limit reached (20)" : "Add a metric"}
            >
              <Plus className="w-3.5 h-3.5" />
              Add metric
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditMode((v) => !v)}
            data-testid="dashboard-edit-toggle"
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12px] font-medium transition-colors",
              editMode
                ? "bg-[hsl(173,57%,55%)]/[0.12] text-[hsl(173,57%,38%)]"
                : "text-ink-soft hover:text-ink hover:bg-bg-2",
            )}
          >
            {editMode ? (
              <>
                <Check className="w-3.5 h-3.5" /> Done
              </>
            ) : (
              <>
                <Pencil className="w-3.5 h-3.5" /> Customize
              </>
            )}
          </button>
        </div>
      </div>

      {/* The grid */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={cards.map((c) => c.id)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-2 lg:grid-cols-4 auto-rows-[minmax(0,1fr)] gap-3">
            {/* Add metric — a square tile at the FRONT of the grid. */}
            {addMetricTile("front")}
            {cards.map((card) => (
              <MetricCard
                key={card.id}
                card={card}
                editMode={editMode}
                overrides={overrides}
                series={series}
                view={effectiveView}
              />
            ))}
            {/* Filler add-metric tiles padding the trailing empty cells so the
                grid always reads as full (each opens the concept picker too). */}
            {Array.from({ length: trailingAddTiles }).map((_, i) => addMetricTile(`fill-${i}`))}
          </div>
        </SortableContext>
      </DndContext>

      {cards.length === 0 && (
        <div className="rounded-xl border border-dashed border-rule px-5 py-8 text-center">
          <p className="text-[13px] text-ink-soft mb-3">
            Your dashboard is empty. Add the metrics you want to track.
          </p>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-[hsl(173,57%,45%)] text-white text-[13px] font-medium"
          >
            <Plus className="w-4 h-4" /> Add metric
          </button>
        </div>
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
