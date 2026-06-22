// percentiles.ts — pure helpers for computing percentile breakpoints
// of each metric a preset can reference.
//
// Why percentiles
// ───────────────
// A preset like "Logical default" says "wind down: below P33 of GM%,
// protect: above P67". P33/P67 are computed against the CURRENT
// dataset's distribution — so the same preset behaves sensibly on a
// portfolio of 30 SKUs or 3,000 SKUs, in RON or in USD, in a thick-
// margin category (cheese) or a thin-margin one (ammonia).
//
// Each metric is computed independently. Null/missing values are
// skipped per-metric (not propagated to other metrics) so a SKU with
// no DIO doesn't damage the GM% percentile calculation.

import {
  computeAdjustedGmPct,
  type FinancingParams,
  type SkuLite,
} from "./decisionRules";

export type PercentileKey = "p25" | "p33" | "p50" | "p67" | "p75";

export type Percentiles = Record<PercentileKey, number>;

export interface DatasetPercentiles {
  /** Volume (tons) */
  volume: Percentiles;
  /** Gross margin percentage points (gm_pct × 100) — matches the
   *  margin_pct rule's units */
  gmPct: Percentiles;
  /** Gross margin absolute (RON) */
  gmAbs: Percentiles;
  /** Days inventory outstanding */
  dio: Percentiles;
  /** Adjusted GM% computed at the preset's financing rate, percentage
   *  points to match the adjusted_gm_pct rule */
  adjustedGmPct: Percentiles;
}

/** Linear-interpolated percentile of a numeric array. q ∈ [0,1].
 *  Mirrors numpy.percentile default. Empty input returns 0. */
export function percentile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = q * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const w = idx - lo;
  return sortedAsc[lo]! * (1 - w) + sortedAsc[hi]! * w;
}

function fivePoints(values: number[]): Percentiles {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p25: percentile(sorted, 0.25),
    p33: percentile(sorted, 1 / 3),
    p50: percentile(sorted, 0.5),
    p67: percentile(sorted, 2 / 3),
    p75: percentile(sorted, 0.75),
  };
}

const EMPTY: Percentiles = { p25: 0, p33: 0, p50: 0, p67: 0, p75: 0 };

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function computeDatasetPercentiles(
  skus: readonly SkuLite[],
  financing: FinancingParams,
): DatasetPercentiles {
  // Each metric collects its own non-null sample. A SKU missing DIO is
  // simply absent from the DIO sample (rather than counted as 0).
  const volumeVals: number[] = [];
  const gmPctVals: number[] = [];
  const gmAbsVals: number[] = [];
  const dioVals: number[] = [];
  const adjustedGmPctVals: number[] = [];

  for (const s of skus) {
    if (isFiniteNum(s.volume_tons)) volumeVals.push(s.volume_tons);
    // gm_pct on the SKU is stored as a decimal (0–1); the rule's
    // thresholds + percentiles operate in percentage points so we
    // multiply here too. Matches decisionRules.ts margin_pct compute.
    const gp = isFiniteNum(s.gm_pct)
      ? s.gm_pct
      : isFiniteNum(s.real_margin_pct)
      ? s.real_margin_pct
      : null;
    if (gp !== null) gmPctVals.push(gp * 100);
    const gmAbs = isFiniteNum(s.gm_krn)
      ? s.gm_krn
      : isFiniteNum(s.real_margin_krn)
      ? s.real_margin_krn
      : null;
    if (gmAbs !== null) gmAbsVals.push(gmAbs);
    if (isFiniteNum(s.days_inventory_on_hand)) dioVals.push(s.days_inventory_on_hand);
    const adj = computeAdjustedGmPct(s, financing);
    if (adj !== null) adjustedGmPctVals.push(adj);
  }

  return {
    volume:        volumeVals.length        ? fivePoints(volumeVals)        : { ...EMPTY },
    gmPct:         gmPctVals.length         ? fivePoints(gmPctVals)         : { ...EMPTY },
    gmAbs:         gmAbsVals.length         ? fivePoints(gmAbsVals)         : { ...EMPTY },
    dio:           dioVals.length           ? fivePoints(dioVals)           : { ...EMPTY },
    adjustedGmPct: adjustedGmPctVals.length ? fivePoints(adjustedGmPctVals) : { ...EMPTY },
  };
}
