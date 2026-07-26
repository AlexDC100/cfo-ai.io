// LEARN-FIX-4 (2026-06-14) — Top-header Learning hub menu.
//
// Replaces the standalone Glossary pill in TopHeader with a single
// Sparkles-prefixed control that opens a frosted-glass dropdown
// surfacing both:
//   1. Learning Mode segmented control (Guided / Subtle / Off) — was
//      Settings-only; the user couldn't switch mode without nav-away.
//   2. Glossary entry — same `openGlossary()` action as before.
//
// Visual goal: Apple-2026 (Safari toolbar / Music sidebar density).
// Dense, rounded corners, soft translucency, generous tap-targets,
// no decorative chrome. Compact pill in the bar (~28×96), spacious
// content inside the dropdown.

import { useState } from "react";
import { Sparkles, ChevronDown, Check } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useLearningMode, type LearningMode } from "@/stores/learningMode";
import { cn } from "@/lib/utils";

interface ModeRow {
  value: LearningMode;
  label: string;
  hint: string;
}

const MODE_ROWS: ModeRow[] = [
  {
    value: "guided",
    label: "Guided",
    hint: "Underlines on numbers, first-run coach, page tours.",
  },
  {
    value: "subtle",
    label: "Subtle",
    hint: "Hover-only underlines. Glossary stays one tap away.",
  },
  {
    value: "off",
    label: "Off",
    hint: "No hotspots. Numbers still open popovers when clicked.",
  },
];

export function LearningHubMenu() {
  const { mode, setMode } = useLearningMode();
  const [open, setOpen] = useState(false);

  const activeRow = MODE_ROWS.find((r) => r.value === mode) ?? MODE_ROWS[1];

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-testid="top-learning-hub-trigger"
          aria-label="Open learning hub"
          title="Learning hub"
          className={cn(
            // Pill chrome matching the CurrencyToggle beside it (rounded-full
            // + border-rule + bg-bg-2, 32px tall) so the header controls read
            // as one family.
            "hidden sm:inline-flex items-center gap-1.5",
            "h-8 pl-3 pr-2.5 rounded-full border border-rule bg-bg-2",
            "text-[11.5px] font-medium tracking-wide",
            "text-ink-soft hover:text-ink",
            "hover:border-rule-strong data-[state=open]:text-ink data-[state=open]:border-brand/40",
            "transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-[hsl(173,57%,55%)]/40",
          )}
        >
          <Sparkles className={cn("w-3.5 h-3.5", mode === "off" ? "text-ink-mute" : "text-[hsl(173,57%,45%)]")} />
          <span>Learn</span>
          <span className="text-ink-mute font-normal">· {activeRow.label}</span>
          <ChevronDown
            className={cn(
              "w-3 h-3 opacity-60 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          data-testid="top-learning-hub-menu"
          className={cn(
            "z-[110] w-[300px] origin-top-right",
            // Apple-style frosted shell — strong blur, hairline border,
            // generous shadow. Sits comfortably over dashboard surfaces
            // without competing with the analyst content.
            "rounded-2xl",
            "bg-surface/95 backdrop-blur-2xl",
            "border border-rule",
            "shadow-[0_18px_50px_-12px_rgba(0,0,0,0.18),inset_0_0_0_1px_rgba(255,255,255,0.6)]",
            "dark:shadow-[0_18px_60px_-12px_rgba(0,0,0,0.55),inset_0_0_0_1px_rgba(255,255,255,0.04)]",
            "p-1.5",
            "outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          )}
        >
          {/* Mode rows. Single-column rather than a 3-up segmented
              control: gives space for the one-line hint without forcing
              the header into mobile-tablet sizing. (The "Guide me" header,
              "Currently…" line, Open Glossary and Reset rows were removed
              2026-07-26 per operator — the dropdown is just the mode picker.) */}
          <div role="radiogroup" aria-label="Learning mode" className="flex flex-col">
            {MODE_ROWS.map((row) => {
              const active = mode === row.value;
              return (
                <button
                  key={row.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setMode(row.value)}
                  data-testid={`top-learning-hub-mode-${row.value}`}
                  className={cn(
                    "group w-full text-left",
                    "flex items-start gap-2.5",
                    "px-3 py-2 rounded-xl",
                    "transition-colors",
                    active
                      ? "bg-[hsl(173,57%,55%)]/[0.08] text-ink"
                      : "hover:bg-bg-2 text-ink-soft hover:text-ink",
                    "outline-none focus-visible:ring-2 focus-visible:ring-[hsl(173,57%,55%)]/40",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-[3px] inline-flex items-center justify-center",
                      "w-3.5 h-3.5 rounded-full shrink-0",
                      active
                        ? "bg-[hsl(173,57%,45%)] text-white"
                        : "border border-rule bg-transparent",
                    )}
                  >
                    {active && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-[13px] font-medium leading-tight",
                        active && "text-[hsl(173,57%,32%)] dark:text-[hsl(173,57%,60%)]",
                      )}
                    >
                      {row.label}
                    </span>
                    <span className="block text-[11px] text-ink-soft mt-0.5 leading-snug">
                      {row.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
