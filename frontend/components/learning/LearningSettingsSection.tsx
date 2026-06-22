// F5.0 Step 3 (CFO AI Learn) — Settings → Learning panel.
//
// Lets the user pick a learning mode (Guided / Subtle / Off) and reset
// the "tutorialsSeen" + "coachDismissed" flags. Mirrors the segmented-
// pill pattern used by CurrencyToggle / LanguageToggle elsewhere in
// the app so it feels native.

import { Sparkles, RotateCcw } from "lucide-react";
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
                "text-left p-3.5 rounded-xl border transition-all",
                active
                  ? "border-[hsl(165,75%,55%)]/40 bg-[hsl(165,75%,55%)]/[0.08]"
                  : "border-rule bg-surface hover:bg-bg-2",
              )}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span
                  className={cn(
                    "text-[13.5px] font-semibold",
                    active ? "text-[hsl(165,80%,38%)]" : "text-ink",
                  )}
                >
                  {opt.label}
                </span>
                {active && (
                  <Sparkles className="w-3.5 h-3.5 text-[hsl(165,80%,38%)]" />
                )}
              </div>
              <div className="text-[11.5px] leading-snug text-ink-soft">
                {opt.description}
              </div>
            </button>
          );
        })}
      </div>

      {/* Status + reset */}
      <div className="rounded-xl border border-rule bg-bg-2/40 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[12px] text-ink-soft min-w-0">
          {hasDismissedCoach || completedCount > 0 ? (
            <>
              First-run coach{" "}
              <span className="text-ink font-medium">
                {hasDismissedCoach ? "dismissed" : "pending"}
              </span>
              {" · "}
              <span className="text-ink font-medium">{completedCount}</span>{" "}
              page tour{completedCount === 1 ? "" : "s"} completed
            </>
          ) : (
            "No learning interactions yet — turn on Guided to see the first-run coach."
          )}
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
