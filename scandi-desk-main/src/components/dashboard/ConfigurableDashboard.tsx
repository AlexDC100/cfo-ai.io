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
import { Plus, Pencil, Check, RotateCcw, Cloud, Smartphone, Activity, BarChart2 } from "lucide-react";
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
    syncSource,
    addCard,
    reorderCards,
    resetToDefault,
  } = useDashboard();
  const { view, setView } = useDashboardView();

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

  return (
    <section data-testid="configurable-dashboard" className="mb-3">
      {/* Control row */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* F6.1 — Snapshot ↔ Trend toggle. Disabled (with explanatory
              tooltip) when the active period lacks multi-year history, so the
              affordance is discoverable but never misleading. */}
          <div
            className={cn(
              "flex items-center gap-0.5 rounded-lg border border-rule bg-surface p-0.5",
              !trendAvailable && "opacity-50",
            )}
            data-testid="dashboard-view-toggle"
            title={
              trendAvailable
                ? "Switch between this period and the multi-year trend"
                : "Trend needs at least two years of history for this company"
            }
          >
            {([
              { key: "snapshot", label: "Snapshot", Icon: BarChart2 },
              { key: "trend", label: "Trend", Icon: Activity },
            ] as const).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                disabled={!trendAvailable && key === "trend"}
                onClick={() => setView(key)}
                data-testid={`dashboard-view-${key}`}
                aria-pressed={effectiveView === key}
                className={cn(
                  "inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11.5px] font-medium transition-colors",
                  effectiveView === key
                    ? "bg-[hsl(165,75%,55%)]/[0.14] text-[hsl(165,80%,34%)]"
                    : "text-ink-mute hover:text-ink",
                  !trendAvailable && key === "trend" && "cursor-not-allowed hover:text-ink-mute",
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
          <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-ink-mute">
            {syncSource === "account" ? (
              <span className="inline-flex items-center gap-1" title="Layout synced to your account">
                <Cloud className="w-3 h-3" /> Synced
              </span>
            ) : (
              <span className="inline-flex items-center gap-1" title="Layout saved on this device">
                <Smartphone className="w-3 h-3" /> On this device
              </span>
            )}
          </span>
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
                  : "text-[hsl(165,80%,38%)] hover:bg-[hsl(165,75%,55%)]/[0.08]",
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
                ? "bg-[hsl(165,75%,55%)]/[0.12] text-[hsl(165,80%,38%)]"
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
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-[hsl(165,75%,45%)] text-white text-[13px] font-medium"
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
