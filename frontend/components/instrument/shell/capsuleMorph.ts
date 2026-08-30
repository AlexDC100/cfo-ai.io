// THE CAPSULE — the morph.
//
// The overlay does not APPEAR. It is the capsule, grown.
//
// ── Why this is geometry and not an animation preset ──────────────────
//
// `zoom-in-95` (what this surface used to use) scales the panel about its
// own centre from 95%. It looks like a panel arriving. The reader's eye
// has no reason to connect it to the pill they just clicked, because
// nothing about the motion starts where the pill is. The r0 screenshots
// show the result: a flat rectangle 70px BELOW the control that opened
// it, with the eye having to re-find the surface after it lands.
//
// A shared-element transform fixes that by construction. We measure the
// trigger's box, measure the panel's resting box, and start the panel at
// the transform that maps one onto the other:
//
//     transform-origin: top left
//     translate(fromX - toX, fromY - toY) scale(fromW/toW, fromH/toH)
//
// One frame later that transform is released to identity and the panel
// travels its own 200ms to where it belongs. The first frame is
// PIXEL-IDENTICAL in position and size to the pill, so there is no
// moment where two things are on screen claiming to be the same object.
//
// ── The two honest compromises ────────────────────────────────────────
//
// 1. The panel's CONTENT is scaled with it for those 200ms, so during the
//    growth it is geometrically distorted. It is also nearly invisible:
//    the content fades 0→1 over the first ~60% of the travel, so what the
//    eye actually reads is a shape growing and text resolving inside it.
//    Counter-scaling every child would be the pure version and costs a
//    second transform on every subtree — not worth it at 200ms.
// 2. The trigger is looked up by `data-testid`, across a lane boundary
//    (the header owns that element). A `querySelector` is the cheapest
//    honest contract here: no shared module, no ref plumbed through three
//    components, and — importantly — a MISS is survivable. If the header
//    ever renames or drops the pill, `measureTrigger` returns null and
//    the panel simply fades, which is the reduced-motion path and is
//    already correct. Recorded as a cross-lane note, not a silent grab.
//
// `morphTransform` and `measureTrigger` are plain functions and are
// exported for exactly that reason: the maths is assertable without a
// renderer, and the DOM read is assertable with nothing but a stub
// element. The hook is the only part of this file that needs React.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

/** The element the overlay grows OUT OF. Owned by the header lane; read
 *  here, never written. */
export const CAPSULE_TRIGGER_SELECTOR = '[data-testid="header-capsule"]';

/** Below this the surface is full-bleed and there is no pill to grow
 *  from — the header collapses it. Morphing from a control the reader
 *  cannot see is worse than not morphing. */
export const MORPH_MIN_VIEWPORT = 640;

export interface MorphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The transform that maps `to` onto `from`, for `transform-origin: top left`.
 *  Null when either box is degenerate — a zero-width target would divide
 *  by zero, and a zero-width source has nothing to grow from. */
export function morphTransform(from: MorphRect, to: MorphRect): string | null {
  if (!(to.width > 0) || !(to.height > 0)) return null;
  if (!(from.width > 0) || !(from.height > 0)) return null;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  const tx = from.x - to.x;
  const ty = from.y - to.y;
  // Rounded to hundredths: the exact value carries float noise that
  // shows up as a different string on every open, which makes the
  // transform impossible to assert in a test for no visual gain.
  const r = (n: number) => Math.round(n * 100) / 100;
  return `translate(${r(tx)}px, ${r(ty)}px) scale(${r(sx)}, ${r(sy)})`;
}

/** The trigger's box right now, or null when it is not on screen. */
export function measureTrigger(
  selector: string = CAPSULE_TRIGGER_SELECTOR,
): MorphRect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface CapsuleMorph {
  /** Attach to the panel element. */
  ref: (node: HTMLElement | null) => void;
  /** Spread onto the panel. Carries the anchored `left` for as long as
   *  the panel is open, and the starting transform for exactly one
   *  frame. */
  style: CSSProperties;
  /** True while the growth is in flight — the host fades content in
   *  behind it so the distorted frames are not read as text. */
  morphing: boolean;
}

/** Keeps the panel on screen with a margin, whatever the trigger's
 *  centre asks for. A capsule near the viewport edge must not push the
 *  panel half off it. */
export const ANCHOR_MARGIN = 8;

/**
 * Where the panel's left edge goes so that its centre sits under the
 * TRIGGER's centre — clamped into the viewport.
 *
 * Why this exists: the panel used to centre on the VIEWPORT (`mx-auto`),
 * and the capsule does not sit at the viewport's centre — the 240px rail
 * pushes it right. The gates lane measured the result at 28px of centre
 * drift against a 24px tolerance (K6), which is the "detached panel"
 * complaint surviving in a form small enough to argue about. Centring on
 * the trigger makes the drift zero by construction rather than by luck,
 * and it is what "the overlay geometry originates from the capsule's own
 * bounding box" actually means.
 */
export function anchoredLeft(
  trigger: MorphRect,
  panelWidth: number,
  viewportWidth: number,
  margin: number = ANCHOR_MARGIN,
): number {
  const centre = trigger.x + trigger.width / 2;
  const ideal = centre - panelWidth / 2;
  const max = Math.max(margin, viewportWidth - panelWidth - margin);
  return Math.round(Math.min(Math.max(ideal, margin), max));
}

/**
 * Grow `open` panels out of the capsule.
 *
 * The sequence, and why each step is where it is:
 *   · LAYOUT effect measures both boxes and writes the FROM transform
 *     before the browser paints. A `useEffect` here would paint one
 *     frame of the panel at full size first — a visible pop that no
 *     amount of easing afterwards can take back.
 *   · a double rAF releases it. One frame is not reliably enough: the
 *     style has to be committed AND the transition has to be observed
 *     against it, and a single frame occasionally collapses the two.
 *   · a timer clears `morphing` so the panel stops carrying a transform
 *     it no longer needs (a lingering transform creates a containing
 *     block, which quietly breaks `position: fixed` children).
 */
export function useCapsuleMorph(open: boolean, enabled = true): CapsuleMorph {
  const [style, setStyle] = useState<CSSProperties>({});
  const [morphing, setMorphing] = useState(false);
  // THE NODE IS STATE, NOT A REF, and that is the whole fix for a bug
  // that made this hook silently do nothing.
  //
  // The panel is a Radix `Dialog.Content` inside a Portal. It does not
  // mount in the same commit that flips `open` — Presence mounts it one
  // commit later. A layout effect keyed on `[open]` therefore ran while
  // `nodeRef.current` was still null, took the early return, and never
  // ran again because its deps had not changed. The panel kept its
  // `mx-auto` fallback and the anchor was dead code: measured live at
  // 30px of centre drift with an empty inline `style` attribute.
  //
  // A callback ref that sets STATE re-renders when the node arrives, so
  // the effect re-runs with a real element to measure.
  const [node, setNode] = useState<HTMLElement | null>(null);
  const rafs = useRef<number[]>([]);
  const timer = useRef<number | null>(null);

  const clear = useCallback(() => {
    for (const id of rafs.current) cancelAnimationFrame(id);
    rafs.current = [];
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const ref = useCallback((el: HTMLElement | null) => setNode(el), []);

  useLayoutEffect(() => {
    clear();
    if (!open) {
      setStyle({});
      setMorphing(false);
      return;
    }
    const narrow =
      typeof window !== "undefined" && window.innerWidth < MORPH_MIN_VIEWPORT;
    const from = narrow ? null : measureTrigger();
    const rect = node?.getBoundingClientRect();

    // ── THE ANCHOR IS NOT PART OF THE MOTION ─────────────────────────
    //
    // Where the panel SITS and how it GOT there are two different
    // questions, and only the second one is animation. So the anchor is
    // computed before every early return below: a reader with
    // `prefers-reduced-motion` still gets a panel centred under the
    // capsule, and so does the answer canvas, which never morphs at all.
    // Wiring the anchor into the morph's own bail-out was the first
    // version of this file, and it meant "no animation" silently also
    // meant "back to centring on the viewport".
    //
    // Below MORPH_MIN_VIEWPORT there is nothing to anchor to: the panel
    // is full-bleed and the header has collapsed the pill.
    const anchor: CSSProperties =
      from && rect && rect.width > 0
        ? {
            left: anchoredLeft(from, rect.width, window.innerWidth),
            right: "auto",
            marginLeft: 0,
            marginRight: 0,
          }
        : {};

    if (!enabled || !node || !from || !rect || prefersReducedMotion()) {
      // The fade the overlay's own classes already provide, in the place
      // the anchor put it.
      setStyle(anchor);
      setMorphing(false);
      return;
    }

    // One measurement, not two: moving an element horizontally cannot
    // change its width, so the destination rect is known without a
    // second layout pass.
    const to = {
      x: typeof anchor.left === "number" ? anchor.left : rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };

    const transform = morphTransform(from, to);
    if (!transform) {
      setStyle(anchor);
      setMorphing(false);
      return;
    }

    setMorphing(true);
    setStyle({
      ...anchor,
      transformOrigin: "top left",
      transform,
      opacity: 0.6,
      transition: "none",
    });

    rafs.current.push(
      requestAnimationFrame(() => {
        rafs.current.push(
          requestAnimationFrame(() => {
            setStyle({
              ...anchor,
              transformOrigin: "top left",
              transform: "none",
              opacity: 1,
              // The spring: overshoot-free, fast out of the gate, long
              // settle. Matches `ease-quint` in the Tailwind config so
              // the morph and the app's other motion share one curve.
              transition:
                "transform 200ms cubic-bezier(0.16, 1, 0.3, 1), opacity 120ms linear",
            });
          }),
        );
      }),
    );

    timer.current = window.setTimeout(() => {
      // Drop the TRANSFORM once it has arrived — a residual `transform:
      // none` is harmless, but leaving a computed transform on a fixed
      // panel creates a containing block and quietly breaks `position:
      // fixed` children. The ANCHOR stays: it is where the panel lives,
      // not how it got there.
      setStyle(anchor);
      setMorphing(false);
    }, 240);

    return clear;
  }, [open, enabled, node, clear]);

  useEffect(() => clear, [clear]);

  return { ref, style, morphing };
}
