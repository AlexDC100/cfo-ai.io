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
import { Sparkles, ChevronDown, BookOpen, Check, RotateCcw } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { openGlossary } from "@/components/learning/MetricGlossaryDrawer";
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
  const { mode, coachDismissed, tutorialsSeen, setMode, resetAll } =
    useLearningMode();
  const [open, setOpen] = useState(false);

  const activeRow = MODE_ROWS.find((r) => r.value === mode) ?? MODE_ROWS[1];
  const completedCount = Object.values(tutorialsSeen).filter(Boolean).length;
  const hasInteractedWithCoach = coachDismissed || completedCount > 0;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-testid="top-learning-hub-trigger"
          aria-label="Open learning hub"
          title="Learning hub"
          className={cn(
            "hidden sm:inline-flex items-center gap-1.5",
            "h-8 pl-2 pr-1.5 rounded-md",
            "text-[12px] font-medium",
            "text-ink-soft hover:text-ink",
            "hover:bg-bg-2 data-[state=open]:bg-bg-2 data-[state=open]:text-ink",
            "transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-[hsl(165,75%,55%)]/40",
          )}
        >
          <Sparkles className="w-3.5 h-3.5 text-[hsl(165,75%,45%)]" />
          <span>Learn</span>
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
          {/* Header — "Guide me…" lead-in. Reads like Music's "Show in
              Library" header, not a full-blown Settings section. */}
          <div className="px-3 pt-2.5 pb-1.5">
            <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft/70">
              Guide me
            </div>
            <div className="text-[11.5px] text-ink-soft mt-0.5 leading-snug">
              Currently{" "}
              <span className="font-medium text-ink">
                {activeRow.label.toLowerCase()}
              </span>
              {hasInteractedWithCoach && (
                <>
                  {" · "}
                  <span>{completedCount}</span> tour
                  {completedCount === 1 ? "" : "s"}
                </>
              )}
            </div>
          </div>

          {/* Mode rows. Single-column rather than a 3-up segmented
              control: gives space for the one-line hint without forcing
              the header into mobile-tablet sizing. */}
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
                      ? "bg-[hsl(165,75%,55%)]/[0.08] text-ink"
                      : "hover:bg-bg-2 text-ink-soft hover:text-ink",
                    "outline-none focus-visible:ring-2 focus-visible:ring-[hsl(165,75%,55%)]/40",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-[3px] inline-flex items-center justify-center",
                      "w-3.5 h-3.5 rounded-full shrink-0",
                      active
                        ? "bg-[hsl(165,75%,45%)] text-white"
                        : "border border-rule bg-transparent",
                    )}
                  >
                    {active && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-[13px] font-medium leading-tight",
                        active && "text-[hsl(165,80%,32%)] dark:text-[hsl(165,70%,60%)]",
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

          {/* Divider — hairline so the next row reads as a separate
              category without breaking the dropdown's quiet rhythm. */}
          <div className="mx-3 my-1.5 h-px bg-rule/70" />

          {/* Glossary entry — same action that the standalone pill
              used to fire. The hub now subsumes both surfaces so the
              top bar stays uncluttered. */}
          <button
            type="button"
            data-testid="top-learning-hub-glossary"
            onClick={() => {
              setOpen(false);
              // Defer so the dropdown's exit animation doesn't fight
              // the glossary's enter.
              queueMicrotask(openGlossary);
            }}
            className={cn(
              "group w-full text-left",
              "flex items-center gap-2.5",
              "px-3 py-2 rounded-xl",
              "text-[13px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2",
              "transition-colors",
              "outline-none focus-visible:ring-2 focus-visible:ring-[hsl(165,75%,55%)]/40",
            )}
          >
            <BookOpen className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">Open Glossary</span>
            <span
              aria-hidden
              className="text-[10.5px] uppercase tracking-[0.14em] text-ink-soft/60"
            >
              every term
            </span>
          </button>

          {/* Reset — only visible when there's something to reset.
              Keeps the empty state from looking cluttered. */}
          {hasInteractedWithCoach && (
            <button
              type="button"
              data-testid="top-learning-hub-reset"
              onClick={() => {
                resetAll();
              }}
              className={cn(
                "group w-full text-left",
                "flex items-center gap-2.5",
                "px-3 py-1.5 mt-0.5 rounded-xl",
                "text-[11.5px] text-ink-soft hover:text-ink hover:bg-bg-2",
                "transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-[hsl(165,75%,55%)]/40",
              )}
            >
              <RotateCcw className="w-3 h-3 shrink-0" />
              <span>Reset coach + page tours</span>
            </button>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
