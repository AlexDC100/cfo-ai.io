// F5.0 Phase 1.5 — Tappable numeric primitive (stack-aware).
//
// Children pattern: wraps a Money / Percentage / numeric span. Adds the
// 2026-grade gradient underline (see `src/styles/learning.css`) and a
// pointer-cursor affordance. On click, pushes onto the global popover
// stack — that's it. The popover itself (chrome, formula, narrative)
// is rendered by PopoverStackRenderer at the app root.
//
// This is a clean break from Phase 1, which used per-instance Radix
// Popovers with hover-to-open. The new model:
//   · Click only (mobile parity, no hover races on touch devices)
//   · Stack push instead of self-rendered popover (recursion works)
//   · Outside-tap handled centrally (no race conditions)
//
// All existing call sites keep working — the API surface is identical
// (conceptKey, value, children, className, block).

import type { ReactNode, MouseEvent } from "react";
import { usePopoverStack } from "./PopoverStackProvider";
import { cn } from "@/lib/utils";
import type { ValueFormat } from "@/lib/learning/concepts/_schema";

export interface LearnableNumberProps {
  /** Concept registry key. */
  conceptKey: string;
  /** Raw numeric value (in source units — decimal for percentages, raw
   *  number for ratios, source-currency amount for money). */
  value: number;
  /** Visible content (Layer 1 — what the user sees). */
  children: ReactNode;
  /** Optional extra class on the trigger. */
  className?: string;
  /** When true, the trigger stretches to fill its grid cell and right-
   *  aligns its content (used inside BS/PL/CF amount cells). */
  block?: boolean;
  /** When set, overrides the format the popover uses to render the
   *  headline value. Otherwise inferred from the concept key. */
  formatHint?: ValueFormat;
  /** Phase 2 future hook — currently unused; the deep-dive panel is
   *  scheduled for Phase 2.5. */
  onDeepDive?: () => void;
}

export function LearnableNumber({
  conceptKey,
  value,
  children,
  className,
  block = false,
  formatHint,
  onDeepDive: _onDeepDive,
}: LearnableNumberProps) {
  const { push } = usePopoverStack();

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
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
      data-testid={`learnable-${conceptKey}`}
      aria-label={`Explain ${conceptKey}`}
      className={cn(
        "learnable-number",
        block
          ? "flex w-full items-baseline justify-end gap-1"
          : "inline-flex items-baseline gap-1",
        "transition-colors",
        "focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-[hsl(165,75%,55%)]/35",
        "focus-visible:rounded-sm",
        "cursor-pointer",
        className,
      )}
    >
      {children}
    </button>
  );
}
