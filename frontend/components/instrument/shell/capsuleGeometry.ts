// THE CAPSULE — WHERE THE CARD IS, AND HOW BIG.
//
// One module, because three things have to agree about these numbers and
// two of them are gates: the component that lays the card out, the live
// spec that measures it, and the jsdom test that reasons about it. When
// the constants lived inline in `CommandPalette.tsx`, a gate could only
// restate them — and a gate that restates a number cannot notice when
// the product changes it.
//
// ══ THE RULING THIS FILE IMPLEMENTS ═══════════════════════════════════
//
// Three constraints were escalated as mutually exclusive:
//
//   (A) the card is ANCHORED to the capsule — it grows out of the pill,
//       so at rest its top edge sits just under it (gated by K6, which
//       allows 24px between the pill's bottom and the card's top);
//   (B) the card's BOTTOM edge is at a constant viewport y, so the
//       composer pinned to it never moves between rest, typing and
//       answering (G2);
//   (C) the resting card is the size of its content (G1, complaint 1).
//
// The owner ruled, in priority order: (B), then (A), then (C). So (C) is
// the one that goes: the resting card has a FIXED height.
//
//     bottom  = ANCHOR_TOP + REST_HEIGHT          — a constant
//     height  = clamp(measured content, REST_HEIGHT, MAX)
//     top     = bottom − height                   — rises as it grows
//
// At rest, height == REST_HEIGHT, so top == ANCHOR_TOP and (A) holds.
// In every state the bottom is the same number, so (B) holds. Growth
// moves the TOP, which no gate pins outside the resting state.
//
// ══ WHAT THE RULING COSTS, IN PIXELS, STATED HERE ═════════════════════
//
// (A) and (B) together CAP the height: the card can never be taller than
// `bottom − EDGE_MARGIN`, which is `ANCHOR_TOP + REST_HEIGHT − 8`. At
// 1440×900 that is 360px — 40vh, well inside the 70vh ceiling, and
// materially shorter than the 522px the top-anchored card used to reach.
// Long result lists and long answers scroll INSIDE the card. That is the
// price of a composer that does not move, and it is a price, not a free
// win: a taller ceiling is only buyable by making the RESTING card
// taller, and a taller resting card is complaint 1 coming back.
//
// ══ WHY REST_HEIGHT IS THE NUMBER IT IS ═══════════════════════════════
//
// Measured, not chosen: the resting thread is the context strip, up to
// three question chips, and the one basis line under them; the composer
// block is the key legend, the input row and its hairline. Three chips
// is the engine's own `MAX_SUGGESTIONS`, so this is the tallest the
// resting state can honestly be.
//
//     thread padding  14 + 12
//     context strip   28
//     chips block     10 + 3×34 + 2×8 + 10 + 28 + 4   = 176
//     composer block  68
//                                                     ≈ 298
//
// A workspace with fewer than three chips leaves the difference as slack
// — and the slack sits ABOVE the content, not below it, because the
// thread is bottom-aligned inside the card (`mt-auto`). An empty
// conversation whose first words sit just above the composer is the
// shape every chat surface has; a card whose content stops halfway down
// and leaves a hole at the bottom is the shape of the menu this pass
// exists to stop being. Same pixels, and they read as opposite things.

/** Below this the card is full-bleed and the pill it would anchor to is
 *  not what the reader is looking at. Mirrors `MORPH_MIN_VIEWPORT`. */
export const CAPSULE_NARROW_MAX = 640;

/** Where the RESTING card's top edge sits at ≥640px. Not free: K6 allows
 *  24px between the header pill's bottom (~46px) and the card's top, so
 *  70 is the ceiling and this is 2px inside it. */
export const CAPSULE_ANCHOR_TOP = 68;

/** Keep-off from the viewport edges, both ends. */
export const CAPSULE_EDGE_MARGIN = 8;

/**
 * The card's own border, top + bottom. Every height in this module is a
 * CARD height — what a gate measures with `getBoundingClientRect` — and
 * the inline height is applied to the stack INSIDE that border, so the
 * caller subtracts this.
 *
 * It is a named constant because it was a bug first: the ceiling was
 * applied to the stack, the gate measured the card, and 70vh came back
 * as 70.2vh at 390×844. Two pixels, and it is the difference between a
 * gate that holds a budget and a gate that misses by exactly the amount
 * nobody thought to account for.
 */
export const CAPSULE_BORDER = 2;

/** The fixed resting height. See the header for the arithmetic. */
export const CAPSULE_REST_HEIGHT = 298;

/** The resting height below `CAPSULE_NARROW_MAX`. Shorter than the wide
 *  one because the key legend does not render on a phone (no keyboard to
 *  legend) and the chips wrap tighter into a narrower column. */
export const CAPSULE_REST_HEIGHT_NARROW = 268;

/** The ceiling the brief sets, as a fraction of the viewport. The owner's
 *  words: "mobile is where a 75vh overlay feels like a takeover." */
export const CAPSULE_TALL_VH = 0.7;

export interface CapsuleFrame {
  /** True below `CAPSULE_NARROW_MAX`. */
  narrow: boolean;
  /** Distance from the VIEWPORT'S bottom to the card's bottom edge — what
   *  goes in `style.bottom`. Constant for a given viewport, which is the
   *  whole point. */
  bottomOffset: number;
  /** The card's bottom edge in viewport coordinates. Reported so a gate
   *  can assert the composer against it without re-deriving. */
  bottom: number;
  /** The fixed resting height, already clamped into the viewport. */
  restHeight: number;
  /** The tallest the card may ever be. */
  maxHeight: number;
}

/**
 * The card's frame for a viewport. Pure — no DOM, no window.
 *
 * WIDE: bottom = anchor + rest, so the resting top lands on the anchor.
 *
 * NARROW: the card is a bottom sheet. (A) and (B) genuinely cannot both
 * hold on a phone — anchoring the top at 8px and fixing the bottom at
 * `8 + rest` would cap the card at the resting height, so a result list
 * or an answer could never grow at all. The owner's order settles it:
 * (B) outranks (A), so the card keeps its constant bottom edge and gives
 * up the top anchor. It also lands the composer where a thumb already
 * is, which is what the surface is for.
 */
export function capsuleFrame(viewportW: number, viewportH: number): CapsuleFrame {
  const narrow = viewportW < CAPSULE_NARROW_MAX;
  const bottom = narrow
    ? Math.max(0, viewportH - CAPSULE_EDGE_MARGIN)
    : CAPSULE_ANCHOR_TOP + CAPSULE_REST_HEIGHT;
  // FLOOR, not round. `Math.round(844 × 0.7)` is 591, and 591/844 is
  // 0.7002 — a ceiling that is 0.02vh over the ceiling.
  const ceiling = Math.floor(viewportH * CAPSULE_TALL_VH);
  // Two ceilings, and the smaller wins: the viewport fraction the brief
  // sets, and the room that actually exists above the constant bottom
  // edge. A card that grew past the second one would be off-screen.
  const maxHeight = Math.max(
    0,
    Math.min(ceiling, bottom - CAPSULE_EDGE_MARGIN),
  );
  const wanted = narrow ? CAPSULE_REST_HEIGHT_NARROW : CAPSULE_REST_HEIGHT;
  return {
    narrow,
    bottomOffset: Math.max(0, viewportH - bottom),
    bottom,
    // A short viewport (a laptop at 600px, a phone in landscape) gets a
    // resting card that fits it rather than one that hangs off the top.
    restHeight: Math.min(wanted, maxHeight),
    maxHeight,
  };
}
