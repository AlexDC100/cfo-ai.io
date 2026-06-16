// bucket3.ts — Client-side, threshold-driven 3-bucket classifier.
//
// Purpose
// ───────
// The Products page receives `classification` per SKU from the backend
// (the engine bucket: anchor / scale / watch / keep / wind_down / etc.).
// Those classifications were computed at upload time and are NOT reactive
// to threshold-slider changes the user makes on the Decision-rules panel.
//
// This module fixes that: `assignBucket3(sku, thresholds)` is a pure
// function that maps any SKU to one of three display buckets — Protect,
// Watch, Wind down — using the *current* threshold values. Callers wrap
// it in a useMemo on (rows, thresholds) so the UI re-buckets immediately
// when the user drags a slider.
//
// Semantics
// ─────────
// • The engine's classification is used as a sensible *starting point*
//   (the engine has more context — cumulative-profit anchor rules, P90 GM
//   thresholds, multi-month trend lookback) than a stateless renderer.
// • Three threshold-driven *overrides* are then applied on top of that
//   base. These are the rules the user can adjust on the Decision-rules
//   panel and see take effect immediately:
//     1. Capital-trap → Wind down  (DIO too high + thin margin)
//     2. Micro-volume + micro-profit → Wind down
//     3. Strong margin OR strong volume-play → Protect
//
// Why this design (vs. a full reimplementation of the engine in JS):
// • The engine logic uses fields the FE doesn't always have (channel
//   distribution, trend windows, real-margin breakdown). Re-implementing
//   client-side risks divergence; deltas between FE and engine would
//   confuse users more than the current bug.
// • Using the engine as the base + thresholds as overrides gives the user
//   live reactivity on the rules they actually control, without faking
//   computations on missing fields.

import type { Thresholds } from "./thresholds";

export type Bucket3 = "protect" | "watch" | "wind_down";

/** The seven engine-emitted classification tokens. */
export type EngineClassification =
  | "anchor"
  | "anchor_alert"
  | "keep"
  | "watch"
  | "eliminate"
  | "wind_down"
  | "scale";

/** Minimal SKU shape the classifier needs. Permissive on optional fields
 *  so the same helper works for upload rows + persisted aggregates. */
export interface ClassifiableSku {
  classification?: EngineClassification | string | null;
  volume_tons?: number | null;
  niv_krn?: number | null;
  gm_krn?: number | null;
  gm_pct?: number | null;
  real_margin_krn?: number | null;
  real_margin_pct?: number | null;
  days_inventory_on_hand?: number | null;
}

/**
 * Assign a SKU to one of three buckets using the two single-axis cutoffs.
 *
 * Single-axis model: the metric is gross profit in RON (`gm_krn`). Two
 * cutoffs slice the axis into three zones — Wind down (below lower),
 * Watch (between), Protect (at or above upper).
 *
 * Why this design (vs. the multi-dimensional rules of the earlier draft):
 * the user-facing Decision-rules modal is a two-handle slider on ONE
 * axis. Modelling the same rules client-side as a single-metric cut keeps
 * the modal honest — what the user sees on the axis is what gets applied.
 * SKUs missing `gm_krn` fall back to `real_margin_krn` (post-allocation
 * profit) and then to 0. The detailed multi-spec rules in
 * `thresholdSchema.ts` remain available for the "advanced" Data-rules
 * settings page and still drive the engine's upload-time classification.
 *
 * Pure: same inputs → same output. Wrap in useMemo on (rows, thresholds);
 * referentially stable across re-renders that don't change either input.
 */
export function assignBucket3(sku: ClassifiableSku, t: Thresholds): Bucket3 {
  const gp = sku.gm_krn ?? sku.real_margin_krn ?? 0;
  if (gp <= t.simpleLowerCutoffKrn) return "wind_down";
  if (gp >= t.simpleUpperCutoffKrn) return "protect";
  return "watch";
}

/** The numeric metric the 3-bucket axis quantifies. Read this off a SKU
 *  to plot histograms, compute per-bucket sums, etc. */
export function bucketAxisValue(sku: ClassifiableSku): number {
  return sku.gm_krn ?? sku.real_margin_krn ?? 0;
}

/** Display metadata for the 3 buckets. Colors picked from the existing
 *  Tailwind tokens used elsewhere in the product (emerald/amber/orange) so
 *  no new design tokens are introduced. */
export const BUCKET3_META: Record<
  Bucket3,
  { label: string; dot: string; tone: "strong" | "warn" | "danger" }
> = {
  protect:   { label: "Protect",   dot: "bg-emerald-500", tone: "strong" },
  watch:     { label: "Watch",     dot: "bg-amber-500",   tone: "warn" },
  wind_down: { label: "Wind down", dot: "bg-orange-500",  tone: "danger" },
};

export const BUCKET3_ORDER: Bucket3[] = ["protect", "watch", "wind_down"];

/** Roll a population of SKUs into bucket counts under the current
 *  thresholds. Same input → same output (pure). */
export function countBuckets3<T extends ClassifiableSku>(
  rows: readonly T[],
  thresholds: Thresholds,
): Record<Bucket3, number> {
  const counts: Record<Bucket3, number> = { protect: 0, watch: 0, wind_down: 0 };
  for (const r of rows) counts[assignBucket3(r, thresholds)] += 1;
  return counts;
}

/** Per-bucket sum of revenue (niv_krn) for the bucket-card "value"
 *  metric. Same shape as countBuckets3 so callers can index identically. */
export function sumRevenue3<
  T extends ClassifiableSku & { niv_krn?: number | null },
>(rows: readonly T[], thresholds: Thresholds): Record<Bucket3, number> {
  const sums: Record<Bucket3, number> = { protect: 0, watch: 0, wind_down: 0 };
  for (const r of rows) sums[assignBucket3(r, thresholds)] += r.niv_krn ?? 0;
  return sums;
}
