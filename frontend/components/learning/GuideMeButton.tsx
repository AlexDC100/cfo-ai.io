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
          // Matches the dashboard tab-bar "Guide me" button (2026-07-26 per
          // operator): rounded-xl, h-8, animated brand gradient, non-uppercase
          // 12px medium label.
          `
            inline-flex items-center gap-1.5
            h-8 px-3 rounded-xl
            text-[12px] font-medium text-ink
            ask-ai-anim-fill [animation-duration:10s]
            border border-brand/40 hover:border-brand/60
            transition-colors
          `
        }
      >
        <Sparkles className="w-3.5 h-3.5" />
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
