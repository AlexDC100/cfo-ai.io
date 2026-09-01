// THE ARTIFACTS — the reveal. Skeleton, then values fill.
//
// Three properties, and each one is a rule the design brief states as a
// prohibition rather than a preference:
//
//   CLS 0 BY CONSTRUCTION. The values are in the DOM from the first
//   paint; only OPACITY animates. A skeleton that is a different element
//   from the value it stands in for has to guess the value's box, and
//   guesses wrong on the first long label. Here there is nothing to
//   guess — the box is the value's own box, painted at zero alpha for
//   one frame. Layout never moves, so cumulative layout shift is not
//   "small", it is structurally zero.
//
//   NO COUNTING-UP NUMBERS. A figure that ticks from 0 to its value is
//   a figure that is WRONG for 800ms, and this product's whole claim is
//   that a rendered number is a resolved fact. `motion.useCountUp` exists
//   in this codebase; it is deliberately not used here.
//
//   CARDS SETTLE ONCE. The stagger runs on MOUNT. A re-render — a
//   refine, a hover, a theme flip — does not replay it; a card that
//   re-animates every time the reader touches it reads as unstable.
//   The settle is tracked in a ref so a parent re-render cannot reset it.
//
// Reduced motion collapses the whole thing to a fade with no stagger and
// no translation, which is what the preference actually asks for.

import { ReactNode, useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/lib/motion";

/** Per-item stagger. The brief's number. */
export const ARTIFACT_STAGGER_MS = 160;

/** How long one item takes to reach full opacity. */
export const ARTIFACT_FADE_MS = 220;

/** Cap the stagger so a forty-row table does not take six seconds to
 *  appear. Past this index every item shares the last slot. */
export const ARTIFACT_STAGGER_CAP = 6;

export function useSettled(): boolean {
  const [settled, setSettled] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) {
      setSettled(true);
      return;
    }
    // One frame at zero alpha, then settle. rAF rather than a timeout so
    // the first paint has definitely happened — a 0ms timeout can land
    // before layout on a busy main thread and skip the transition.
    const id = requestAnimationFrame(() => {
      done.current = true;
      setSettled(true);
    });
    return () => cancelAnimationFrame(id);
  }, []);
  return settled;
}

export function ArtifactReveal({
  index = 0,
  children,
  className,
}: {
  index?: number;
  children: ReactNode;
  className?: string;
}) {
  const settled = useSettled();
  const reduced = usePrefersReducedMotion();
  const slot = Math.min(index, ARTIFACT_STAGGER_CAP);
  const delay = reduced ? 0 : slot * ARTIFACT_STAGGER_MS;
  return (
    <div
      data-artifact-reveal={settled ? "settled" : "pending"}
      className={className}
      style={{
        opacity: settled ? 1 : 0,
        transition: `opacity ${ARTIFACT_FADE_MS}ms ease-out ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}
