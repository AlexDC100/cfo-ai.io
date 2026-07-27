// F5.0 Step 3 (CFO AI Learn) — Settings → Learning panel.
//
// Lets the user pick a learning mode (Guided / Subtle / Off) and reset
// the "tutorialsSeen" + "coachDismissed" flags. Mirrors the segmented-
// pill pattern used by CurrencyToggle / LanguageToggle elsewhere in
// the app so it feels native.

import { RotateCcw } from "lucide-react";
import { useLearningMode, type LearningMode } from "@/stores/learningMode";
import { cn } from "@/lib/utils";

interface ModeOption {
  value: LearningMode;
  label: string;
  description: string;
}

const OPTIONS: ModeOption[] = [
  {
    value: "guided",
    label: "Guided",
    description:
      "Always-visible underlines on numbers, first-run coach, per-page tours.",
  },
  {
    value: "subtle",
    label: "Subtle",
    description:
      "Underlines only on hover or keyboard focus. Glossary + Guide-me still available.",
  },
  {
    value: "off",
    label: "Off",
    description:
      "No visible hotspots. Numbers still open popovers when clicked. Glossary remains.",
  },
];

export function LearningSettingsSection() {
  const { mode, coachDismissed, tutorialsSeen, setMode, resetAll } =
    useLearningMode();

  const completedCount = Object.values(tutorialsSeen).filter(Boolean).length;
  const hasDismissedCoach = coachDismissed;

  return (
    <div data-testid="settings-learning" className="space-y-4">
      {/* Mode picker */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {OPTIONS.map((opt) => {
          const active = mode === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setMode(opt.value)}
              data-testid={`settings-learning-mode-${opt.value}`}
              aria-pressed={active}
              className={cn(
                "relative text-left p-3.5 rounded-xl border transition-all bg-surface",
                active
                  // `.ask-ai-anim-fill` (index.css) = the app's seam-free 45°
                  // teal gradient that slowly sweeps across the element.
                  // Reused rather than hand-rolling a second animated
                  // gradient; it handles the diagonal-tiling seam and turns
                  // itself off under prefers-reduced-motion.
                  //
                  // SELECTED CARD ONLY — the animation is what marks the
                  // chosen mode. Running it on all three made every card look
                  // selected and put motion under three blocks of description
                  // text at once. Alphas stay below the pill's defaults
                  // (0.26 / 0.12) so the sweep doesn't fight the copy.
                  ? "ask-ai-anim-fill border-[hsl(173,57%,55%)]/40 [--af-a1:0.16] [--af-a2:0.05]"
                  : "border-rule hover:bg-bg-2",
              )}
            >
              {active && (
                // Same selected-marker as the workspace cards
                // (Workspace.tsx) — glowing brand dot, absolutely pinned to
                // the card corner. In-flow beside the title it inherited the
                // title's line-height and sat too low.
                <span
                  className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_8px_rgba(92,211,197,0.6)]"
                  title={`${opt.label} selected`}
                >
                  <span className="sr-only">Selected</span>
                </span>
              )}
              {/* Title stays `text-ink` in both states — the dot, border and
                  animated fill already mark the selection, and recolouring
                  the label as well made it the only heading in Settings that
                  changes colour. `pr-4` keeps it clear of the dot. */}
              <div className="text-[13.5px] font-semibold text-ink mb-1.5 pr-4">
                {opt.label}
              </div>
              <div className="text-[11.5px] leading-snug text-ink-soft">
                {opt.description}
              </div>
            </button>
          );
        })}
      </div>

      {/* Status + reset. Styled as a `DocGuideCard` (the "what can I upload"
          cards in FinancialStatements.tsx): surface background, brand-tinted
          3px left rule, uppercase eyebrow over the body copy. Was a flat
          bg-bg-2/40 pill, which read as a disabled input rather than a
          status card. */}
      <div className="rounded-lg border border-rule border-l-[3px] border-l-brand bg-surface p-3 flex items-center justify-between gap-3 flex-wrap text-left">
        <div className="min-w-0">
          {/* Copy describes what Reset will DO, not just what's been seen —
              the state readout alone ("coach dismissed · 3 tours completed")
              left the button's effect to be inferred. Counts stay in the
              sentence so the consequence is concrete. */}
          <div className="text-[11.5px] text-ink-soft leading-relaxed">
            {hasDismissedCoach || completedCount > 0 ? (
              <>
                Reset brings back the first-run coach
                {hasDismissedCoach ? " (dismissed)" : ""}
                {completedCount > 0 && (
                  <>
                    {" "}and replays{" "}
                    <span className="text-ink font-medium">{completedCount}</span>{" "}
                    completed page tour{completedCount === 1 ? "" : "s"}
                  </>
                )}
                . Your learning mode above stays as it is.
              </>
            ) : (
              "Nothing to reset yet — the coach and page tours haven't been seen. Turn on Guided to see them."
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            resetAll();
          }}
          data-testid="settings-learning-reset"
          className="
            inline-flex items-center gap-1.5
            text-[12px] font-medium
            text-ink-soft hover:text-ink
            px-2.5 py-1.5 rounded-md
            bg-surface border border-rule hover:bg-bg-2
            transition-colors
          "
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>
    </div>
  );
}
