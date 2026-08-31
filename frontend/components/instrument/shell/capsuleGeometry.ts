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
// The first ruling was (B) > (A) > (C), and (C) was dropped: the resting
// card took a FIXED height sized for three suggestion chips.
//
// ══ WHY THAT WAS RE-RULED, AND THE ARITHMETIC BEHIND IT ═══════════════
//
// Measured on the shipped build, 2026-08-31: the workspace renders ONE
// chip, and the resting card was 298px with 113px — 37.9% — of blank
// above its first ink at 1440, 104px of 268px (38.8%) at 390. The owner
// re-ruled: "A card that budgets three suggestion chips and renders one
// should shrink to what it renders … keep the constant bottom edge by
// growing the card upward from that edge — anchoring the bottom does not
// require reserving space you're not using."
//
// That sentence drops (A), and it has to, because (A)+(B)+(C) are not
// merely in tension — they are ALGEBRAICALLY INCOMPATIBLE, and the
// arithmetic belongs on the record rather than in a round of surprise:
//
//     pillBottom          46   (fixed by the header)
//     restContent        185   (fixed by what the resting card says)
//     composerY            C   (the one free variable)
//
//     (A) ⟹ cardTop_rest ≈ 68 ⟹ C = 68 + restContent − 11 = 242
//     the card may not grow above EDGE_MARGIN, so
//     maxHeight = (C + 11) − 8 = restContent + 60
//
// So under (A)+(B) the answer canvas ceiling IS `restContent + 60`: the
// 113px of air at rest and the 113px the ANSWERING state uses are THE
// SAME PIXELS. Shrinking the resting card to its content while keeping
// (A) would have taken the ceiling from 358px to 245px — the answering
// state measures 358px and is already AT that ceiling, and the typing
// state paints nine rows into it. That is not a fix; it is the defect
// moved into the two states the reader spends longer in.
//
// ══ WHAT THIS FILE DOES INSTEAD ═══════════════════════════════════════
//
//     bottom  = CAPSULE_BOTTOM                     — a constant
//     height  = measured content, clamped to MAX   — no resting floor
//     top     = bottom − height                    — rises as it grows
//
// (B) holds exactly: the bottom is the same number in every state, so
// the composer does not move — and, crucially, `bottom` is no longer
// computed FROM the resting height, so a leaner resting card cannot
// shorten the answer canvas. That is the decoupling the ruling asked
// for: `maxHeight` is a fraction of the VIEWPORT, capped only by the
// room that physically exists above a fixed bottom edge, and it is the
// same 358px at 1440 and 590px at 390 that it was before this change.
//
// (C) holds: nothing reserves space it is not using. `useCapsuleHeight`
// measures the thread and the composer and the card is their sum.
//
// (A) is the one that goes, and the cost is MEASURED and stated rather
// than hidden. On a workspace whose resting content is shorter than
// `CAPSULE_REST_BUDGET`, the resting card no longer touches the pill:
// with one chip it measures 208px and starts at y=158, and
// `e2e/design/capsule.spec.ts`'s K6 reports
//
//     [K6 centre] drift 2.0px · gap 113.5px        (tolerance 24px)
//
// — one of K6's four assertions RED, the other three (the anchor ran,
// the width is derived, CLS 0 on open/close/stream) green.
//
// THAT IS AN OPEN, REPORTED CONFLICT, not a number this file quietly
// satisfies. K6's gap assertion encodes (A), and (A) was only ever
// guaranteed by the fixed resting height the ruling deleted. Once the
// resting card measures its content, the gap is a FUNCTION OF THE
// CONTENT — so K6's tolerance can no longer be a stable law about this
// surface, whatever number this file picks.
//
// The alternative was built and PRICED rather than argued about. Setting
// the budget to 208 — this workspace's measured resting content — puts
// the card back under the pill (K6 4/4 green, gap 23.5px) and costs:
//
//     typing    @1440   358px → 268px   (9 rows into 268px)
//     answering @1440   358px → 268px   (the action row and the
//                                        follow-up chips go below the
//                                        fold; the card is already AT
//                                        its ceiling at 358)
//     composer          y 355  → y 265
//
// and it is a fit to ONE DATA POINT: a workspace yielding three chips
// then measures 298 against a 208 budget, gets clamped to the ceiling,
// and rests at y=8 — COVERING the pill it grew out of. K6 would pass
// that (a negative gap is ≤ 24) while the surface hid its own trigger.
//
// 298 degrades the other way: the card detaches, and a workspace that
// fills the budget rests at `CAPSULE_ANCHOR_TOP` with K6 untouched. A
// graceful degradation was preferred to a pathological one, and the
// re-ruling of K6 — whether it should measure the morph's ORIGIN rather
// than a static gap — belongs to the owner and to the lane that owns
// that file.
//
// ══ WHY CAPSULE_REST_BUDGET IS THE NUMBER IT IS ═══════════════════════
//
// It is no longer a HEIGHT — nothing is ever sized to it. It is the
// distance from the anchor to the constant bottom edge, i.e. how tall a
// resting card WOULD be if the workspace had everything to say:
//
//     thread padding  14 + 12
//     context strip   28
//     chips block     10 + 3×34 + 2×8 + 10 + 28 + 4   = 176
//     composer block  68
//                                                     ≈ 298
//
// Three chips is `MAX_SUGGESTIONS`, so this is the tallest the resting
// state can honestly be, and pinning the bottom edge to it is what keeps
// the FULL resting card anchored under the pill.

/** Below this the card is full-bleed and the pill it would anchor to is
 *  not what the reader is looking at. Mirrors `MORPH_MIN_VIEWPORT`. */
export const CAPSULE_NARROW_MAX = 640;

/** Where the resting card's top edge sits at ≥640px WHEN ITS CONTENT
 *  FILLS `CAPSULE_REST_BUDGET`. A card with less to say starts lower —
 *  see the header for the algebra and for what that costs K6. Not free
 *  either way: K6 allows 24px between the header pill's bottom (~44.5px)
 *  and the card's top, so 70 is the ceiling and this is 2px inside it. */
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

/** The distance from `CAPSULE_ANCHOR_TOP` to the constant bottom edge —
 *  the height of a resting card that has everything to say. NOT a floor:
 *  no card is ever padded up to it. See the header for the arithmetic. */
export const CAPSULE_REST_BUDGET = 298;

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
  /** What a resting card would measure if it had everything to say. NOT
   *  applied as a floor: a card with less to say is shorter than this,
   *  which is the point of the 2026-08-31 re-ruling.
   *
   *  It governs the bottom edge at WIDE only. Below `CAPSULE_NARROW_MAX`
   *  the bottom edge is the viewport's, so this number describes nothing
   *  there and is reported only so `data-rest-budget` reads the same
   *  shape at both widths. */
  restBudget: number;
  /** The tallest the card may ever be. A fraction of the VIEWPORT,
   *  capped by the room above the constant bottom edge — never a
   *  function of what the resting card happens to contain. */
  maxHeight: number;
}

/**
 * The card's frame for a viewport. Pure — no DOM, no window.
 *
 * WIDE: bottom = anchor + BUDGET. The budget is a constant, so the
 * bottom edge is a constant, so the composer is a constant — and a
 * resting card shorter than the budget simply starts lower rather than
 * dragging the bottom edge (and with it the answer canvas) up behind it.
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
    : CAPSULE_ANCHOR_TOP + CAPSULE_REST_BUDGET;
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
  return {
    narrow,
    bottomOffset: Math.max(0, viewportH - bottom),
    bottom,
    // A short viewport (a laptop at 600px, a phone in landscape) gets a
    // budget that fits it rather than one that hangs off the top.
    restBudget: Math.min(CAPSULE_REST_BUDGET, maxHeight),
    maxHeight,
  };
}
