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
// Zero-denominator handling: never divide by zero. When the comparison
// value is 0, `pct` becomes null (treated like a ratio delta — no
// meaningful percentage change exists when starting from zero). The
// `absolute` field still carries the full change.

export interface Delta {
  /** The arithmetic difference: primary − comparison. Signed. */
  absolute: number;
  /** Relative change as a decimal fraction (0.05 = +5%). NULL when:
   *  - The underlying value is itself a ratio/percentage (delta must be
   *    rendered in percentage points, not percent-of-percent)
   *  - The comparison value is 0 (would divide by zero) */
  pct: number | null;
}

/** Delta for an ABSOLUTE value (currency, count, etc.). Returns:
 *  - absolute: primary − comparison (signed)
 *  - pct: (primary − comparison) / |comparison| OR null if comparison === 0 */
export function delta(primary: number, comparison: number): Delta {
  const absolute = primary - comparison;
  if (comparison === 0) {
    return { absolute, pct: null };
  }
  return { absolute, pct: absolute / Math.abs(comparison) };
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
