// F5.0 Step 3 (CFO AI Learn) — First-run coach card.
//
// Dismissable, non-intrusive teaching card that introduces the
// Learning Layer the first time a user opens the analyst surface. Once
// dismissed (or after the first guided tour finishes) it stays gone
// forever — tracked via the LearningMode store's `coachDismissed` flag,
// not a separate localStorage key, so the coach + tour state stay
// coupled.
//
// Mount points: AppShell main rail (above the page content), behind
// `mode === "guided" && !coachDismissed && !inGuidedTour`. On dismissal
// the store flips mode "guided" → "subtle" automatically.

import { useState } from "react";
import { Sparkles, ChevronRight, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useLearningMode } from "@/stores/learningMode";
import { cn } from "@/lib/utils";

interface Props {
  /** When provided, "Show me" navigates the user to that page's guided
   *  tour. Default: no-op — the card just dismisses. */
  onShowGuide?: () => void;
}

export function LearningCoach({ onShowGuide }: Props) {
  const { mode, coachDismissed, dismissCoach } = useLearningMode();
  const [exiting, setExiting] = useState(false);

  if (mode !== "guided" || coachDismissed) return null;

  const handleDismiss = () => {
    setExiting(true);
    // Wait for motion exit before flipping the persisted flag so the
    // card doesn't pop back on a quick re-render.
    setTimeout(() => {
      dismissCoach();
    }, 180);
  };

  const handleShowMe = () => {
    if (onShowGuide) onShowGuide();
    handleDismiss();
  };

  return (
    <AnimatePresence>
      {!exiting && (
        <motion.aside
          data-testid="learning-coach"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            "relative rounded-2xl",
            "bg-[hsl(165,75%,55%)]/[0.08] dark:bg-[hsl(165,75%,55%)]/[0.06]",
            "border border-[hsl(165,75%,55%)]/[0.18]",
            "px-4 py-3.5 sm:px-5 sm:py-4",
            "flex items-start gap-3.5",
            "mb-4",
            "shadow-[0_2px_12px_-4px_hsl(165,75%,55%/0.18)]",
          )}
        >
          <span
            className="
              shrink-0 mt-0.5 w-7 h-7 rounded-full
              bg-[hsl(165,75%,55%)]/[0.16]
              grid place-items-center
            "
            aria-hidden
          >
            <Sparkles className="w-3.5 h-3.5 text-[hsl(165,80%,40%)]" />
          </span>

          <div className="min-w-0 flex-1">
            <h3 className="text-[13.5px] font-semibold text-ink leading-tight">
              Learn how CFO AI reads your numbers
            </h3>
            <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">
              Click any underlined value to see how it was calculated —
              all the way back to the source accounts in your trial balance.
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {onShowGuide && (
                <button
                  type="button"
                  onClick={handleShowMe}
                  data-testid="learning-coach-show"
                  className="
                    inline-flex items-center gap-1.5
                    text-[12px] font-semibold
                    text-white bg-[hsl(165,80%,38%)] hover:bg-[hsl(165,80%,33%)]
                    px-3 py-1.5 rounded-md
                    transition-colors
                  "
                >
                  Show me
                  <ChevronRight className="w-3 h-3" />
                </button>
              )}
              <button
                type="button"
                onClick={handleDismiss}
                data-testid="learning-coach-dismiss"
                className="
                  text-[12px] font-medium
                  text-ink-soft hover:text-ink
                  px-3 py-1.5 rounded-md
                  transition-colors
                "
              >
                Maybe later
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="
              shrink-0 w-6 h-6 rounded-full
              text-ink-mute hover:text-ink hover:bg-ink/[0.06]
              grid place-items-center
              transition-colors
              -mt-0.5 -mr-1
            "
          >
            <X className="w-3 h-3" />
          </button>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
