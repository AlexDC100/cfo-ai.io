// F6.0.1 Phase 1 foundation (2026-06-20) — Reusable delta indicator badge.
//
// Renders a small pill showing the change between primary + comparison
// values. Sentiment-colored (green/red/neutral). Used by:
//   · <Money comparison={...}> when comparison provided
//   · <Percentage comparison={...}> (when that component exists)
//   · LearningPopover header to show value + delta inline
//   · ScenarioCard impact summary (F6.0.5)
//
// CRITICAL MATH DISCIPLINE — enforced via Delta type:
//   When `pct === null`, the underlying value is a ratio (margin, etc.) and
//   the delta must render in PERCENTAGE POINTS (pp), NOT percent. The type
//   system catches any attempt to render a null pct as %. See
//   src/lib/learning/computeDeltas.ts for the math primitives.
//
// Visual: minimal 10-11px text in a rounded pill. Arrow glyph indicates
// direction (↑ ↓ ·). Background tint follows sentiment via accent/danger
// design tokens that already exist in the theme.

import { cn } from "@/lib/utils";
import type { Delta, DeltaSentiment } from "@/lib/learning/computeDeltas";
import { Money } from "@/components/ui/Money";
import type { Currency } from "@/lib/rates";

export interface DeltaBadgeProps {
  /** Computed delta from computeDeltas() — `pct: null` triggers pp render. */
  delta: Delta;
  /** Visual sentiment — usually computed via sentimentFor(delta, opts). */
  sentiment: DeltaSentiment;
  /** When true, render the absolute change (e.g. "+€3.2M") instead of pct.
   *  Useful when a small percentage hides a large absolute, or vice versa. */
  showAbsolute?: boolean;
  /** Currency used when showAbsolute is true. Defaults to RON since this is
   *  a Romanian-SME platform. Ignored otherwise. */
  currency?: Currency;
  /** Override className for layout (e.g. nesting inside a tight cell). */
  className?: string;
}

/** Sentiment → tint class map. Pulled from existing accent/danger tokens
 *  used by Money/Percentage so badges blend with the rest of the surface. */
function sentimentClasses(s: DeltaSentiment): string {
  if (s === "positive") return "bg-[hsl(173,57%,55%)]/10 text-[hsl(173,57%,42%)] dark:text-[hsl(173,57%,60%)]";
  if (s === "negative") return "bg-rose-500/10 text-rose-600 dark:text-rose-400";
  return "bg-white/[0.04] text-white/55 dark:text-white/55";
}

/** Arrow glyph for the direction. Picked to be visually balanced with
 *  tabular-nums in the pill (no font-fallback weirdness across platforms). */
function arrow(delta: Delta): string {
  if (delta.absolute > 0) return "↑";
  if (delta.absolute < 0) return "↓";
  return "·";
}

export function DeltaBadge({
  delta,
  sentiment,
  showAbsolute = false,
  currency = "RON",
  className,
}: DeltaBadgeProps) {
  const isRatio = delta.pct === null;
  const useAbsolute = showAbsolute || (isRatio && delta.pct === null);

  return (
    <span
      data-testid="delta-badge"
      data-delta-sign={delta.absolute > 0 ? "pos" : delta.absolute < 0 ? "neg" : "zero"}
      className={cn(
        "inline-flex items-center gap-0.5",
        "px-1.5 py-0.5 rounded-md",
        "text-[10px] font-medium tabular-nums whitespace-nowrap",
        sentimentClasses(sentiment),
        className,
      )}
    >
      <span aria-hidden>{arrow(delta)}</span>
      {isRatio ? (
        // Ratio delta — render in percentage POINTS. Format: "+2.0pp" / "-2.0pp".
        // Compile-time discipline: pct is null here, can't accidentally show %.
        <span>
          {delta.absolute > 0 ? "+" : ""}
          {(delta.absolute * 100).toFixed(1)}pp
        </span>
      ) : useAbsolute ? (
        // Absolute mode — render the currency change via Money primitive
        // so the FX + compact formatting stays consistent with the rest
        // of the app.
        <Money
          value={Math.abs(delta.absolute)}
          fromCurrency={currency}
          compact
          signed={false}
          className="text-[10px]"
        />
      ) : (
        // Default — relative percentage. `pct` is non-null here per the
        // isRatio branch above.
        <span>
          {delta.pct! > 0 ? "+" : delta.pct! < 0 ? "" : ""}
          {(Math.abs(delta.pct!) * 100).toFixed(1)}%
        </span>
      )}
    </span>
  );
}
