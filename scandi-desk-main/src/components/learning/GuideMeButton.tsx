// F5.0 Step 4 (CFO AI Learn) — Reusable "Guide me" trigger button.
//
// Composes:
//   · a Sparkles-iconed mint pill that opens a page tour
//   · an auto-open effect for first-time guided-mode users
//   · the PageGuideOverlay itself
//
// One-liner usage:
//   <GuideMeButton pageId="valuation" title="Valuation" steps={VALUATION_GUIDE} />
//
// Behavior:
//   · Always renders the button (so Subtle / Off users can still open it)
//   · Auto-opens once for Guided-mode users who haven't seen this pageId
//   · Marks pageId as seen in the LearningMode store when the user
//     closes / completes the tour (handled inside PageGuideOverlay)

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { PageGuideOverlay, type GuideStep } from "./PageGuideOverlay";
import { useLearningMode } from "@/stores/learningMode";

interface Props {
  pageId: string;
  title: string;
  steps: GuideStep[];
  /** Optional className override on the button. */
  className?: string;
  /** Delay before auto-opening the guide on first visit. Useful to give
   *  the spotlight target time to render. Default 600ms. */
  autoOpenDelayMs?: number;
}

export function GuideMeButton({
  pageId,
  title,
  steps,
  className,
  autoOpenDelayMs = 600,
}: Props) {
  const { mode, tutorialsSeen } = useLearningMode();
  const [open, setOpen] = useState(false);

  // Auto-open on first visit for Guided-mode users only.
  useEffect(() => {
    if (mode !== "guided") return;
    if (tutorialsSeen[pageId]) return;
    if (open) return;
    const t = window.setTimeout(() => setOpen(true), autoOpenDelayMs);
    return () => window.clearTimeout(t);
    // Mount only — tutorialsSeen will flip true once the user closes;
    // we don't want that to re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`guide-trigger-${pageId}`}
        className={
          className ??
          `
            inline-flex items-center gap-1.5
            text-[11px] uppercase tracking-[0.1em] font-semibold
            text-[hsl(165,80%,38%)] hover:text-[hsl(165,80%,30%)]
            px-2.5 py-1 rounded-md
            bg-[hsl(165,75%,55%)]/[0.08] hover:bg-[hsl(165,75%,55%)]/[0.14]
            border border-[hsl(165,75%,55%)]/[0.20]
            transition-colors
          `
        }
      >
        <Sparkles className="w-3 h-3" />
        Guide me
      </button>
      <PageGuideOverlay
        open={open}
        pageId={pageId}
        title={title}
        steps={steps}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
