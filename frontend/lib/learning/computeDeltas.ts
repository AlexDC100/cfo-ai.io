// F6.0.1 Phase 1 foundation (2026-06-20) — Delta math primitives.
//
// Pure functions, NO React, NO side effects. Live here so they can be
// unit-tested with vitest without mounting a component, AND so the same
// math is used by every renderer (Money, Percentage, DeltaBadge,
// LearningPopover delta line, future Variance view).
//
// CRITICAL MATH DISCIPLINE — locked at the type system:
//
//   The delta of a RATIO (percentage, margin, multiple, etc.) is expressed
//   in PERCENTAGE POINTS (pp), NOT percentage. If EBITDA margin moves from
//   12% → 14%, the delta is +2pp, NOT +16.7%. Mixing these up is the most
//   common variance-analysis bug in finance software — even Mosaic and
//   Causal occasionally render ratio deltas as percentages.
//
//   The Delta type signals this with `pct: number | null`:
//     · For ABSOLUTE values (revenue, ebitda, cash): pct = (a − b) / |b|
//     · For RATIO values (margin, equity_ratio, etc.): pct = null
//   The DeltaBadge renderer reads `pct === null` to mean "show as +Xpp"
//   instead of "+X%". TypeScript catches any attempt to render a null pct
//   as a percentage string.
//
// Zero and sign handling (plan_contract_v2 section 7, S7): the ONE
// classifier (lib/changeKind.ts) decides whether a percentage exists. A
// change from zero, to zero, or across sign carries `pct: null` and a
// `change.kind` the renderer states in WORDS beside the absolute change —
// 6.1M becoming -107.6M is "turned negative", never "-19x" (defect 0.4).
// The `absolute` field still carries the full change.

import {
  ROUNDED_MONEY_ZERO_FLOOR,
  classifyChange,
  deltaPctNumber,
  type ChangeResult,
} from "@/lib/changeKind";

export interface Delta {
  /** The arithmetic difference: primary − comparison. Signed. */
  absolute: number;
  /** Relative change as a decimal fraction (0.05 = +5%). NULL when:
   *  - The underlying value is itself a ratio/percentage (delta must be
   *    rendered in percentage points, not percent-of-percent)
   *  - The change is not the classifier's "compared" with a non-zero
   *    base (from zero, to zero, or across sign) */
  pct: number | null;
  /** The classifier's verdict for an ABSOLUTE value; null for a RATIO
   *  delta (rendered in percentage points, never classified). */
  change: ChangeResult | null;
}

/** Delta for an ABSOLUTE value (currency, count, etc.). Returns:
 *  - absolute: primary − comparison (signed)
 *  - change: classifyChange(comparison, primary) at the rounded-money floor
 *  - pct: the classifier's delta_pct, or null for every other kind */
export function delta(primary: number, comparison: number): Delta {
  const absolute = primary - comparison;
  const change = classifyChange(comparison, primary, ROUNDED_MONEY_ZERO_FLOOR);
  return { absolute, pct: deltaPctNumber(change), change };
}

/** Delta for a RATIO value (margin, percentage, multiple). Returns:
 *  - absolute: primary − comparison (in the ratio's own units; e.g. for
 *              margins stored as decimals, 0.14 − 0.12 = 0.02 = +2pp)
 *  - pct: ALWAYS null — ratio deltas must render in percentage points
 *
 *  Renderers detect `pct === null` to format with "pp" suffix instead of "%".
 *  Compile-time discipline: never pass a ratio value to `delta()`; use this. */
export function deltaRatio(primary: number, comparison: number): Delta {
  return {
    absolute: primary - comparison,
    pct: null,
    change: null,
  };
}

/** Sentiment for visual coloring. Positive deltas on most financial
 *  metrics (revenue, margin, equity) are good (green); negative are bad
 *  (red). Some metrics invert this convention (debt, expenses, DSO) —
 *  the caller can pass `invert: true` to swap green/red.
 *
 *  Returns "neutral" when delta is exactly zero so the badge shows a
 *  muted dot instead of green/red — important for the empty-state case
 *  where comparison data exists but values are unchanged. */
export type DeltaSentiment = "positive" | "negative" | "neutral";

export function sentimentFor(
  d: Delta,
  opts?: { invert?: boolean },
): DeltaSentiment {
  if (d.absolute === 0) return "neutral";
  const raw: DeltaSentiment = d.absolute > 0 ? "positive" : "negative";
  if (opts?.invert) {
    return raw === "positive" ? "negative" : "positive";
  }
  return raw;
}
