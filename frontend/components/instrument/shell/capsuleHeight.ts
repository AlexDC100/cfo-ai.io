// THE CAPSULE — the card's height, animated.
//
// ── Why an explicit measured height, rather than `height: auto` ────────
//
// The composition puts the composer at the BOTTOM of the card, so every
// change of content changes where the composer is. `height: auto` is
// correct to the pixel and animates in exactly zero browsers: the card
// snaps from 240px to 470px the instant the first result row mounts, and
// the composer teleports 230px down the screen. That snap is what makes
// the surface read as a menu redrawing itself instead of a conversation
// growing.
//
// So the height is a NUMBER, measured from the content, applied to a
// shell, and transitioned. The composer then travels with the edge it is
// pinned to instead of jumping to it.
//
// ── The measurement is not circular, and that is the whole trick ───────
//
// The obvious version — "measure the card, then size the card" — is a
// feedback loop: constraining the card changes what the card measures.
// This measures the two things the card is MADE of, which are never
// constrained by it:
//
//     desired = thread content height + composer height
//
// `threadRef` points at the INNER stack inside the scroll container, not
// the scroll container itself, so its height is what the content wants
// rather than what the container currently allows. `composerRef` is a
// `shrink-0` block whose height depends only on the textarea's own
// auto-grow. Neither reads the shell, so nothing oscillates.
//
// ── Zero is a state, not a failure ────────────────────────────────────
//
// Before the first measurement (and in jsdom, where every box is 0×0)
// this returns `null`, and the caller must then apply NO height at all —
// falling back to `height: auto`. A hook that returned 0 would collapse
// the panel to an invisible line in every unit test that renders it, and
// the tests would be measuring a bug this file introduced.

import { useCallback, useEffect, useRef, useState } from "react";

export interface CapsuleHeightOptions {
  /** Do not grow past this. The caller derives it from the viewport. */
  max: number;
  /** Below this the card is a sliver; used only to reject a degenerate
   *  measurement (a mid-unmount frame), never to pad content. */
  min?: number;
  /** Off entirely — mobile full-bleed, where the card is not a card. */
  enabled?: boolean;
}

export interface CapsuleHeight {
  /** Attach to the inner stack inside the scrolling thread. */
  threadRef: (node: HTMLElement | null) => void;
  /** Attach to the composer block. */
  composerRef: (node: HTMLElement | null) => void;
  /** px, or null when nothing has been measured yet. */
  height: number | null;
}

/** The measured content height, clamped, or null when unmeasurable. */
export function desiredHeight(
  threadH: number,
  composerH: number,
  { max, min = 0 }: CapsuleHeightOptions,
): number | null {
  if (!(threadH > 0) && !(composerH > 0)) return null;
  const raw = threadH + composerH;
  if (!(raw > 0)) return null;
  return Math.round(Math.min(Math.max(raw, min), max));
}

export function useCapsuleHeight(opts: CapsuleHeightOptions): CapsuleHeight {
  const { max, min = 0, enabled = true } = opts;
  const [thread, setThread] = useState<HTMLElement | null>(null);
  const [composer, setComposer] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  // Read inside the observer callback so a changed `max` does not have to
  // tear down and rebuild the observer.
  const bounds = useRef({ max, min });
  bounds.current = { max, min };

  const threadRef = useCallback((n: HTMLElement | null) => setThread(n), []);
  const composerRef = useCallback((n: HTMLElement | null) => setComposer(n), []);

  useEffect(() => {
    if (!enabled) {
      setHeight(null);
      return;
    }
    if (typeof ResizeObserver === "undefined") return;
    if (!thread && !composer) return;

    const measure = () => {
      const th = thread?.offsetHeight ?? 0;
      const ch = composer?.offsetHeight ?? 0;
      const next = desiredHeight(th, ch, bounds.current);
      // Same value, same object identity, no render. Rounding above is
      // what makes this comparison stable across sub-pixel layouts.
      setHeight((prev) => (prev === next ? prev : next));
    };

    const ro = new ResizeObserver(measure);
    if (thread) ro.observe(thread);
    if (composer) ro.observe(composer);
    measure();
    return () => ro.disconnect();
  }, [thread, composer, enabled]);

  return { threadRef, composerRef, height };
}
