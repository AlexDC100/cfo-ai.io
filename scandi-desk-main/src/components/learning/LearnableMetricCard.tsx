// F5.0 Step 3 (CFO AI Learn) — KPI-tile primitive that bundles a label,
// a learnable value, an optional sub-line, and sentiment-tinted accent.
//
// Replaces ~150 ad-hoc <KpiTile> / <KpiCard> call sites with one
// concept-aware primitive. Tap-anywhere on the card opens the concept's
// popover — bigger hit target than just the numeric span.

import type { ReactNode } from "react";
import { usePopoverStack } from "./PopoverStackProvider";
import { cn } from "@/lib/utils";
import type { ValueFormat } from "@/lib/learning/concepts/_schema";

interface Props {
  /** Display label shown above the value. */
  label: string;
  /** Concept registry key — the popover that opens on click. */
  conceptKey: string;
  /** Raw numeric value (in source units). */
  value: number;
  /** Pre-formatted display value (Money / formatPercent / etc.). */
  display: ReactNode;
  /** Optional sub-line beneath the value (margin %, "vs benchmark", etc.). */
  sub?: ReactNode;
  /** Optional sentiment tint on the left border. */
  tone?: "default" | "positive" | "warn" | "critical";
  /** Optional override for the format the popover renders the headline as. */
  formatHint?: ValueFormat;
  /** Optional className override (rarely needed). */
  className?: string;
  /** Optional data-testid. Defaults to `metric-${conceptKey}`. */
  "data-testid"?: string;
}

const toneClass: Record<NonNullable<Props["tone"]>, string> = {
  default: "border-l-rule",
  positive: "border-l-[hsl(150,55%,55%)]/70",
  warn: "border-l-[hsl(40,90%,55%)]/80",
  critical: "border-l-[hsl(0,75%,60%)]/80",
};

export function LearnableMetricCard({
  label,
  conceptKey,
  value,
  display,
  sub,
  tone = "default",
  formatHint,
  className,
  "data-testid": testId,
}: Props) {
  const { push } = usePopoverStack();

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    push({
      conceptKey,
      value,
      triggerRect: rect,
      formatOverride: formatHint,
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid={testId ?? `metric-${conceptKey}`}
      aria-label={`${label} — learn`}
      className={cn(
        "group text-left w-full",
        "rounded-2xl border border-rule bg-surface p-4",
        "border-l-[3px]",
        toneClass[tone],
        // FIT-1 (2026-06-08) — `min-w-0` + `overflow-hidden` so the
        // card shrinks to its grid cell without bursting; `display`
        // node below uses the fluid font helper so long currency
        // strings auto-compact at narrower breakpoints.
        "min-w-0 overflow-hidden",
        "hover:bg-surface/95 hover:border-rule/80",
        "transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(165,75%,55%)]/30",
        className,
      )}
    >
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium truncate">
        {label}
      </div>
      <div className="mt-1 num-hero-fluid-sm font-semibold tabular-nums tracking-[-0.005em] text-ink leading-tight break-words">
        {display}
      </div>
      {sub && (
        <div className="mt-1 text-[11.5px] text-ink-soft leading-snug break-words">
          {sub}
        </div>
      )}
    </button>
  );
}
