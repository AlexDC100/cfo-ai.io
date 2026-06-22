// DataCard — primitive #1 of the mobile-consolidation set.
//
// Single-row label-left + value-right card. The flex pattern enforces
// the "values take priority over labels on small screens" rule:
//   - Parent flex has `min-w-0` so children can shrink
//   - Label gets `truncate flex-1 min-w-0` (gives way first)
//   - Value gets `flex-shrink-0` (never shrinks)
//
// Use for: any single-metric surface where label + value sit on one line.
// Use PeriodComparisonCard for: two-period side-by-side comparisons (BS row, P&L line).
// Use KpiCard (existing at @/components/cfo/KpiCard) for: dashboard tiles
// with animated reveal + halo. DataCard is the unanimated workhorse.
//
// Comment-only conventions used:
//   - `cfo-surface` is the project's card surface utility (matches existing
//     KpiCard / SkuDetailDrawer / etc.). It carries border + radius +
//     subtle bg tint per the dual-theme token system.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface DataCardProps {
  /** Primary text — truncates on narrow viewports. */
  label: ReactNode;
  /** Numeric value — never shrinks. Wrap in <Money/> for currency. */
  value: ReactNode;
  /** Optional second line under the label (e.g. sector, period). */
  sublabel?: ReactNode;
  /** Optional change-since-prior delta. Decimal fraction, not percentage
   *  points (0.051 = +5.1%). Color tints +/- automatically. */
  change?: number;
  /** Accent variant. `accent` adds the brand-tinted border treatment
   *  used for "your row" / "selected" emphasis. `total` adds the
   *  amber-tinted treatment used for subtotal rows. */
  variant?: "default" | "accent" | "total";
  /** Extra className appended after the default card classes. */
  className?: string;
  /** Pass-through for click handlers (chair / row tap targets). */
  onClick?: () => void;
}

export function DataCard({
  label,
  value,
  sublabel,
  change,
  variant = "default",
  className,
  onClick,
}: DataCardProps) {
  const tint =
    variant === "accent" ? "border-brand/30 bg-brand/[0.03]"
    : variant === "total"  ? "border-caution/30 bg-caution/[0.04]"
    :                        "border-rule bg-surface/80";

  const Wrapper = onClick ? "button" : "div";

  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-xl border p-4 min-w-0",
        tint,
        onClick && "transition-colors hover:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink truncate leading-snug">
            {label}
          </div>
          {sublabel && (
            <div className="text-[11px] text-ink-mute truncate mt-0.5">
              {sublabel}
            </div>
          )}
        </div>
        <div className="text-[15px] font-semibold tabular-nums text-ink flex-shrink-0 whitespace-nowrap">
          {value}
        </div>
      </div>

      {change !== undefined && change !== null && (
        <div className="mt-3 pt-3 border-t border-rule/50 flex items-center justify-between">
          <span className="text-[11px] text-ink-mute uppercase tracking-wider">
            Change
          </span>
          <span
            className={cn(
              "text-[13px] font-medium tabular-nums whitespace-nowrap",
              change > 0 ? "text-emerald-500" : change < 0 ? "text-alert" : "text-ink-mute",
            )}
          >
            {change > 0 ? "+" : ""}
            {(change * 100).toFixed(1)}%
          </span>
        </div>
      )}
    </Wrapper>
  );
}
