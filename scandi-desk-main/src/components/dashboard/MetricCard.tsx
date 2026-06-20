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

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X, Maximize2 } from "lucide-react";
import { lookupConcept } from "@/lib/learning/concepts";
import { useReportingMetrics } from "@/components/learning/ReportingContextProvider";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { Money } from "@/components/ui/Money";
import { useDashboard } from "@/stores/dashboard";
import {
  resolveConceptValue,
  formatCardValue,
} from "@/lib/dashboard/resolveConceptValue";
import type { DashboardCard, CardSize } from "@/types/dashboard";
import type { Currency } from "@/lib/rates";
import { cn } from "@/lib/utils";

interface Props {
  card: DashboardCard;
  editMode: boolean;
  /** Canonical value overrides keyed by conceptKey — the page passes
   *  engine-routed numbers for legacy tiles so they stay byte-identical. */
  overrides?: Record<string, number | null | undefined>;
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

export function MetricCard({ card, editMode, overrides }: Props) {
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
          ? "border-[hsl(165,75%,55%)]/40 ring-1 ring-[hsl(165,75%,55%)]/20"
          : "border-rule",
      )}
    >
      {/* Edit-mode controls — drag handle (left) + remove/resize (right). */}
      {editMode && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-2 py-1.5">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
            data-testid={`card-drag-${card.conceptKey}`}
            className="touch-none cursor-grab active:cursor-grabbing text-ink-mute hover:text-ink p-1 -m-1 rounded"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => resizeCard(card.id, NEXT_SIZE[card.size])}
              aria-label="Resize card"
              data-testid={`card-resize-${card.conceptKey}`}
              className="text-ink-mute hover:text-ink p-1 rounded hover:bg-bg-2"
              title={`Size: ${card.size.toUpperCase()} — tap to grow`}
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => removeCard(card.id)}
              aria-label="Remove card"
              data-testid={`card-remove-${card.conceptKey}`}
              className="text-ink-mute hover:text-[hsl(0,75%,55%)] p-1 rounded hover:bg-bg-2"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Label — nudged down in edit mode so it clears the control row. */}
      <div
        className={cn(
          "text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate",
          editMode && "mt-5",
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

      {/* Definition shown only on md/lg cards (room to breathe). */}
      {card.size !== "sm" && concept?.shortDefinition && (
        <div className="mt-1.5 text-[11px] text-ink-soft leading-snug line-clamp-2">
          {concept.shortDefinition[locale] ?? concept.shortDefinition.en}
        </div>
      )}
    </div>
  );
}
