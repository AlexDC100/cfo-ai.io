// F5.0 Step 3 (CFO AI Learn) — Row-level learnable wrapper.
//
// Tap-anywhere row → push concept onto the popover stack. Useful for
// PL / BS / CF table rows where the entire row should be discoverable
// rather than just the numeric span on the right.
//
// Renders as a button by default. Pass `as="tr"` (or any other element)
// when the row needs to live inside a <table>, but note: <button> can't
// be a child of <tbody>, so for native HTML tables prefer
// LearnableNumber on the amount cell instead.

import type { ReactNode, MouseEvent } from "react";
import { usePopoverStack } from "./PopoverStackProvider";
import { cn } from "@/lib/utils";
import type { ValueFormat } from "@/lib/learning/concepts/_schema";

interface Props {
  conceptKey: string;
  value: number;
  children: ReactNode;
  className?: string;
  formatHint?: ValueFormat;
  /** Disable interactivity (still renders, just doesn't push). */
  disabled?: boolean;
  "data-testid"?: string;
}

export function LearnableRow({
  conceptKey,
  value,
  children,
  className,
  formatHint,
  disabled,
  "data-testid": testId,
}: Props) {
  const { push } = usePopoverStack();

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
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
      disabled={disabled}
      data-testid={testId ?? `row-${conceptKey}`}
      className={cn(
        "block w-full text-left",
        "transition-colors",
        !disabled && "hover:bg-bg-2/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(165,75%,55%)]/30 focus-visible:rounded-md",
        className,
      )}
    >
      {children}
    </button>
  );
}
