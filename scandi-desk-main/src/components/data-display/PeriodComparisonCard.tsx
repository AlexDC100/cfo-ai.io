// PeriodComparisonCard — primitive #2 of the mobile-consolidation set.
//
// Label on top, two periods side-by-side in a 2-col sub-grid, optional
// % change at the bottom with green/red tint. The shape every BS row,
// P&L line, and CF line uses on mobile-card layouts.
//
// Why side-by-side instead of stacked: comparing prior-vs-current is the
// whole point of these statements. Stacking the periods makes the user
// scroll between them to compare. The 2-col sub-grid sits in ~340px wide
// (well within iPhone SE's 375px viewport).
//
// Each cell uses `min-w-0` + `truncate tabular-nums` so long numbers fall
// back to compact format (via <Money>'s auto-compact behavior) before
// hitting their column edge.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PeriodComparisonCardProps {
  /** Row label. Romanian account name OK — line-clamp-2 prevents overflow. */
  label: ReactNode;
  /** Current period value cell. Wrap in <Money/> for auto-compact. */
  currentValue: ReactNode;
  /** Prior period value cell. */
  priorValue: ReactNode;
  /** Short period labels (e.g. "31 Dec 2025"). */
  currentLabel: string;
  priorLabel: string;
  /** Pre-computed % change as decimal fraction. Pass `null` to hide.
   *  Caller computes — keeps this component dumb so callers control
   *  edge cases (zero denominators, sign conventions). */
  changeFraction?: number | null;
  /** Indent depth for sub-items in hierarchical reports (P&L sub-lines).
   *  Each step ≈ 12px left margin. */
  indent?: number;
  /** Visual emphasis for subtotal/total rows. */
  variant?: "default" | "total";
  className?: string;
}

export function PeriodComparisonCard({
  label,
  currentValue,
  priorValue,
  currentLabel,
  priorLabel,
  changeFraction,
  indent = 0,
  variant = "default",
  className,
}: PeriodComparisonCardProps) {
  const tint =
    variant === "total"
      ? "border-caution/30 bg-caution/[0.04]"
      : "border-rule bg-surface/80";

  return (
    <div
      className={cn(
        "rounded-xl border p-4 min-w-0",
        tint,
        className,
      )}
      style={indent > 0 ? { marginLeft: indent * 12 } : undefined}
    >
      <div className="text-[13px] font-medium text-ink mb-3 leading-snug line-clamp-2">
        {label}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-ink-mute mb-0.5 truncate">
            {currentLabel}
          </div>
          <div className="text-[14px] font-semibold tabular-nums text-ink truncate whitespace-nowrap">
            {currentValue}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-ink-mute mb-0.5 truncate">
            {priorLabel}
          </div>
          <div className="text-[14px] tabular-nums text-ink-soft truncate whitespace-nowrap">
            {priorValue}
          </div>
        </div>
      </div>

      {changeFraction !== undefined && changeFraction !== null && (
        <div className="mt-3 pt-3 border-t border-rule/50 flex items-center justify-between">
          <span className="text-[11px] text-ink-mute uppercase tracking-wider">
            Change
          </span>
          <span
            className={cn(
              "text-[13px] font-medium tabular-nums whitespace-nowrap",
              changeFraction > 0 ? "text-emerald-500"
              : changeFraction < 0 ? "text-alert"
              :                      "text-ink-mute",
            )}
          >
            {changeFraction > 0 ? "+" : ""}
            {(changeFraction * 100).toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}
