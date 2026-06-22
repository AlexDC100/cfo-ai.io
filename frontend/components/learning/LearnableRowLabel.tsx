// F5.0 Wave 3 — Inline learnable row-label.
//
// Why this exists (separate from LearnableRow):
//   The BS / PL / CF rows use a CSS grid (`.bs-row { display: grid }`)
//   and already contain interior LearnableNumber buttons on each amount
//   cell. Wrapping the whole row with another <button> would either
//   break the grid (button isn't display: grid) or produce nested
//   buttons (invalid HTML).
//
//   This component instead promotes the LABEL TEXT into a click target.
//   Clicking the label opens the concept popover; the amount cells keep
//   their per-value popovers. Hover state on the label hints at the
//   action without flashing the whole row.
//
// Visual: text looks identical to a regular label; on hover, a soft
// underline + a tiny "Learn" affordance appears in Guided mode (the
// global affordance rules from src/styles/learning.css apply).

import type { ReactNode } from "react";
import { usePopoverStack } from "./PopoverStackProvider";
import { cn } from "@/lib/utils";
import type { ValueFormat } from "@/lib/learning/concepts/_schema";

interface Props {
  /** Concept registry key. */
  conceptKey: string;
  /** Numeric value to seed the popover with (typically the closing balance). */
  value: number;
  /** The visible label text + any inline children (e.g. RAS account code). */
  children: ReactNode;
  /** Optional className passthrough. */
  className?: string;
  /** Optional format override for the popover headline. */
  formatHint?: ValueFormat;
  /** Optional data-testid. */
  "data-testid"?: string;
}

export function LearnableRowLabel({
  conceptKey,
  value,
  children,
  className,
  formatHint,
  "data-testid": testId,
}: Props) {
  const { push } = usePopoverStack();

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
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
      data-testid={testId ?? `row-label-${conceptKey}`}
      className={cn(
        // Match the surrounding text exactly — no extra padding, no
        // disruption to the grid baseline.
        "inline text-left bg-transparent border-0 p-0 m-0 cursor-pointer",
        "text-inherit font-inherit",
        // Subtle hover affordance — dotted underline so the row looks
        // like a clean financial line until the user discovers it.
        "hover:text-[hsl(165,75%,42%)] hover:underline hover:decoration-dotted hover:underline-offset-2",
        "focus-visible:outline-none focus-visible:text-[hsl(165,75%,42%)] focus-visible:underline focus-visible:decoration-dotted focus-visible:underline-offset-2",
        "transition-colors",
        className,
      )}
    >
      {children}
    </button>
  );
}
