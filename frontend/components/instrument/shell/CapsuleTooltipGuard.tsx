// THE CAPSULE — NO NATIVE TOOLTIPS, ENFORCED AT THE SURFACE'S BOUNDARY.
//
// Complaint 4 was reported as "a native browser tooltip duplicates the
// suggestion text". It was closed by deleting one `title`, and the sweep
// that certified it ran at rest and while typing — two states where the
// remaining sites do not render. An ANSWERED turn carried three, and a
// follow-up carried six: the count grows with the conversation, because
// a provenance dot and a money span ride EVERY figure in EVERY turn.
//
// Three of those sites are in files this lane owns and were fixed where
// they are written (`TopHeader`, `TrustChip`, `CapsuleFigures`). Fixing
// a defect at its source is not optional when you own the source — a
// guard that hides your own bug is the same "correct code, wrong
// surface" failure one layer up.
//
// TWO ARE NOT OURS:
//
//   · `frontend/lib/narrativeMoney.tsx:350` — `title={resolved.provenance}`
//     on the money span. That file is import-only for every lane this
//     session.
//   · `frontend/components/cfo/TraceableNumber.tsx:127` — `title={tooltip}`
//     ("View source: Total assets — BS grand total on Balance Sheet").
//     Another lane's component, used app-wide.
//
// Both are legitimate where they live: on a dashboard, a hover tooltip on
// a converted figure is a reasonable disclosure. Inside a 680px overlay
// that has just been rebuilt to say each thing exactly once, an OS-drawn
// box appearing after a delay the design does not control, restating a
// string the surface is already responsible for, is not.
//
// So the rule is enforced at THIS surface's boundary, and only here. The
// app outside the Capsule is untouched.
//
// ── NOTHING IS DELETED ────────────────────────────────────────────────
//
// A guard that simply stripped `title` would delete a real disclosure —
// the money one names the FX rate a converted figure was displayed at.
// So each string is RE-HOMED before the attribute goes:
//
//   1. the element is interactive → it becomes part of that element's
//      accessible name. Strictly better than `title`: reachable by
//      keyboard focus and by a screen reader, neither of which `title`
//      serves reliably;
//   2. the element is not, but wraps exactly one interactive descendant
//      (the money span wrapping its `TraceableNumber` button is exactly
//      this) → it joins that descendant's name;
//   3. neither → it stays in the DOM as `data-suppressed-title`, so the
//      string is still there for whoever renders it properly later.
//
// Case 3 is the honest gap and is stated in the round's critique rather
// than smoothed over: a mouse user loses the hover. The right fix is a
// VISIBLE basis line, and that belongs to the money lane's file.
//
// ── Why a MutationObserver and not a render-time prop ─────────────────
//
// Because the attribute is written by components this lane does not own,
// inside a subtree that re-renders on every streamed token. There is no
// prop to pass. An observer is the only thing that can hold an invariant
// over someone else's render.

import { useEffect, useRef } from "react";

/** Elements whose accessible name a re-homed string may join. */
const INTERACTIVE =
  'button, a[href], input, select, textarea, [role="button"], [role="option"], [role="link"]';

/** Attribute the original string is parked in. Read by the gate. */
export const SUPPRESSED_TITLE_ATTR = "data-suppressed-title";

/** Join two accessible-name fragments without repeating one. */
export function mergeName(existing: string | null, addition: string): string {
  const a = (existing ?? "").trim();
  const b = addition.trim();
  if (!b) return a;
  if (!a) return b;
  if (a.includes(b)) return a;
  return `${a} · ${b}`;
}

/**
 * Re-home every `title` under `root` and remove the attribute.
 * Exported so a jsdom test can drive it against a hand-built subtree —
 * the observer wiring is not what needs proving, the re-homing is.
 *
 * Returns how many attributes it moved, so the caller (and the gate) can
 * tell "there were none" apart from "it did not run", which is the same
 * distinction every vacuity floor in this repo exists to make.
 */
export function suppressNativeTooltips(root: ParentNode): number {
  const nodes = root.querySelectorAll<HTMLElement>("[title]");
  let moved = 0;
  nodes.forEach((el) => {
    const title = el.getAttribute("title");
    if (title === null) return;
    el.removeAttribute("title");
    if (title.trim()) {
      el.setAttribute(SUPPRESSED_TITLE_ATTR, title);
      const host = el.matches(INTERACTIVE)
        ? el
        : el.querySelectorAll(INTERACTIVE).length === 1
        ? el.querySelector<HTMLElement>(INTERACTIVE)
        : el.closest<HTMLElement>(INTERACTIVE);
      if (host) host.setAttribute("aria-label", mergeName(host.getAttribute("aria-label"), title));
    }
    moved += 1;
  });
  return moved;
}

/**
 * Mounts inside the Capsule's card and holds the invariant over its whole
 * subtree for as long as the surface is open.
 *
 * Renders a zero-size marker rather than nothing, for one reason: the
 * guard has to FIND the surface, and finding it from its own position in
 * the tree is the only way that cannot go stale. A `querySelector` on a
 * testid would keep "working" after a rename by silently guarding
 * nothing, which is the failure mode this whole session has been about.
 */
export function CapsuleTooltipGuard() {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const marker = ref.current;
    const root = marker?.closest<HTMLElement>('[data-testid="command-palette"]');
    if (!root) return;
    let moved = suppressNativeTooltips(root);
    root.setAttribute("data-tooltip-guard", "on");
    root.setAttribute("data-tooltips-suppressed", String(moved));
    if (typeof MutationObserver === "undefined") return;
    const obs = new MutationObserver((records) => {
      // Only a `title` landing anywhere in the subtree can break this, so
      // the callback is cheap and re-entrant-safe: removing the attribute
      // fires the observer again with nothing left to find.
      let touched = false;
      for (const r of records) {
        if (r.type === "attributes" && r.attributeName === "title") touched = true;
        if (r.type === "childList" && r.addedNodes.length) touched = true;
      }
      if (!touched) return;
      moved += suppressNativeTooltips(root);
      root.setAttribute("data-tooltips-suppressed", String(moved));
    });
    obs.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });
    return () => obs.disconnect();
  }, []);

  return <span ref={ref} aria-hidden className="hidden" data-testid="capsule-tooltip-guard" />;
}
