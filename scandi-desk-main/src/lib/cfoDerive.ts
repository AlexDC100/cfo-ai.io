// Bridge layer: derive the CFO bucket model from the legacy DailyRun shape.
//
// The new /api/cfo/today endpoint returns the same shape directly, so when
// the upload flow is rewritten to feed it, this module is a single import
// flip. Until then, this lets the new pages render against the same seed
// data the legacy dashboard has been using.

import type { DailyRun, CategoryDecision, Anchor } from "@/data/dailyRun";
import type { Bucket, Recommendation, ExecutiveSummary } from "@/lib/cfoApi";
import { FX_RON_TO_EUR } from "@/lib/currency";

export interface CfoItem {
  id: string;
  category: string | null;
  bucket: Bucket;
  realMargin: number;
  absoluteProfit: number;
  volumeT: number;
  dioDays: number;
  cccDays: number | null;
  capitalMRon: number;
  reason: string | null;
  isAnchor: boolean;
}

function anchorToBucket(a: Anchor): Bucket {
  return a.status === "alert" ? "WATCH" : "PROTECT";
}

function decisionToBucket(d: CategoryDecision): Bucket {
  if (d.flag === "scale") return "SCALE";
  if (d.flag === "eliminate") {
    // Negative real margin → liquidate; positive but trapped → reduce
    if (d.realMargin < 0) return "LIQUIDATE";
    if (d.absoluteProfit > 0) return "REDUCE";
    return "LIQUIDATE";
  }
  if (d.flag === "review" || d.flag === "warning") {
    // Thin margin with volume → fix; long DIO without margin pressure → watch
    if (d.realMargin < 3 && Math.abs(d.absoluteProfit) > 0) return "FIX";
    return "WATCH";
  }
  return "WATCH";
}

/** Estimate capital footprint when the seed didn't carry one.
 *
 *  For non-anchor items the seed only stores realMargin + absoluteProfit; we
 *  approximate working capital from absolute profit magnitude (~6× heuristic,
 *  comparable to a typical 60-day inventory turn at 10% margin). Good enough
 *  for the demo dashboard until live SKU data is wired.
 */
function estimateCapitalMRon(absProfit: number, dioDays: number): number {
  if (!isFinite(absProfit) || absProfit === 0) return 0;
  const dioWeight = dioDays > 0 ? dioDays / 90 : 1; // longer DIO = more locked capital
  return Math.abs(absProfit) * 6 * dioWeight / 1000; // kRON → MRON
}

export function flatten(run: DailyRun): CfoItem[] {
  const out: CfoItem[] = [];
  // The seed dataset is in RON. We convert to EUR at this boundary so every
  // CfoItem.* downstream is already in display currency. `capitalMRon` and
  // `absoluteProfit` keep their names for now to minimize churn — but their
  // unit is now "millions of EUR" / "kEUR" respectively.
  for (const a of run.anchors) {
    out.push({
      id: a.name,
      category: null,
      bucket: anchorToBucket(a),
      realMargin: a.realMargin,
      absoluteProfit: a.absoluteProfit / FX_RON_TO_EUR,
      volumeT: a.volumeT,
      dioDays: a.dioDays,
      cccDays: a.cccDays ?? null,
      capitalMRon: a.capitalMRon / FX_RON_TO_EUR,
      reason: a.alertReason ?? null,
      isAnchor: true,
    });
  }
  for (const d of [...run.eliminate, ...run.review, ...run.scale]) {
    const dio = d.dioDays ?? 90;
    const capitalRon = d.capitalMRon ?? estimateCapitalMRon(d.absoluteProfit, dio);
    out.push({
      id: d.name,
      category: null,
      bucket: decisionToBucket(d),
      realMargin: d.realMargin,
      absoluteProfit: d.absoluteProfit / FX_RON_TO_EUR,
      volumeT: d.volumeT ?? 0,
      dioDays: dio,
      cccDays: d.cccDays ?? null,
      capitalMRon: capitalRon / FX_RON_TO_EUR,
      reason: d.reason ?? null,
      isAnchor: false,
    });
  }
  return out;
}

// Per-category pack-size variants used to synthesize SKU-level rows from
// category-only seed data. Real uploads bring their own SKUs and skip this.
// Names are intentionally generic so the demo doesn't reveal any real
// customer's product catalog — operators see plausible FMCG groupings.
const PACK_VARIANTS: Record<string, string[]> = {
  "Flagship Line":      ["Flagship 80g", "Flagship 160g", "Flagship 1kg foodservice"],
  "Core Range":         ["Core 200g", "Core Smoked 250g", "Core 1kg"],
  "Premium Cuts":       ["Premium 200g", "Premium 350g", "Premium 1kg"],
  "Pantry Essentials":  ["Beans 400g", "Peas 400g", "Corn 400g", "Mixed Veg 400g"],
  "Tinned Range":       ["Tinned 100g", "Tinned 125g", "Tinned in Oil 200g"],
  "Specialty Imports":  ["Imports Rings 200g", "Imports Tubes 500g"],
  "Cold Chain":         ["Cold-Chain Fillet 200g", "Cold-Chain Smoked 100g"],
  "Ready Meals":        ["Ready Meal Classic 400g", "Ready Meal Veg 400g"],
  "Pickled Goods":      ["Pickle A 720ml", "Pickle B 720ml", "Pickle Mix 720ml"],
  "Fruit Preserves":    ["Preserve Plum 720ml", "Preserve Cherry 720ml", "Preserve Apricot 720ml"],
  "Companion Foods":    ["Dry Food 1kg", "Wet Food 400g", "Snack 100g"],
  Confectionery:        ["Sweets 200g", "Sweets Sour 150g"],
  Beverages:            ["Orange Juice 1L", "Multifruit Juice 1L", "Tomato Juice 1L"],
};

const FALLBACK_VARIANTS = (id: string): string[] => [`${id} 200g`, `${id} 500g`];

/** Spread a single CfoItem into 2-4 SKU rows. Each variant inherits the
 *  parent's bucket but the metrics jitter slightly so the per-product table
 *  feels lived-in, not cloned. Real upload data replaces this entirely. */
function expandToSkus(item: CfoItem): CfoItem[] {
  const variants = PACK_VARIANTS[item.id] ?? FALLBACK_VARIANTS(item.id);
  const n = variants.length;
  return variants.map((variant, idx) => {
    // Distribute volume + capital + profit across the variants. The first
    // variant carries the largest share; the tail gets smaller slices.
    const weights = variants.map((_, i) => Math.max(0.5, 1 - i * 0.18));
    const wSum = weights.reduce((s, w) => s + w, 0);
    const share = weights[idx] / wSum;
    // Margin variation: ±0.8pp around the parent so each row reads distinct
    const marginJitter = (idx - (n - 1) / 2) * 0.8;
    return {
      id: variant,
      category: item.id,
      bucket: item.bucket,
      realMargin: Number((item.realMargin + marginJitter).toFixed(2)),
      absoluteProfit: Number((item.absoluteProfit * share).toFixed(2)),
      volumeT: Number((item.volumeT * share).toFixed(2)),
      dioDays: item.dioDays,
      cccDays: item.cccDays,
      capitalMRon: Number((item.capitalMRon * share).toFixed(4)),
      reason: item.reason,
      isAnchor: item.isAnchor,
    };
  });
}

/** Per-SKU view derived from the category-level seed.
 *  When a real SKU upload is wired in, swap this for the uploaded rows. */
export function flattenSkus(run: DailyRun): CfoItem[] {
  return flatten(run).flatMap(expandToSkus);
}

export function bucketCounts(items: CfoItem[]): Record<Bucket, number> {
  const counts: Record<Bucket, number> = {
    PROTECT: 0, WATCH: 0, FIX: 0, REDUCE: 0, LIQUIDATE: 0, SCALE: 0,
  };
  for (const item of items) counts[item.bucket]++;
  return counts;
}

export function derive(run: DailyRun): {
  items: CfoItem[];
  summary: ExecutiveSummary;
  topActions: Recommendation[];
} {
  const items = flatten(run);
  const counts = bucketCounts(items);

  // Authoritative working capital total comes from the run aggregate, not
  // the per-item rollup (per-item is partial). Convert RON → EUR.
  const cashTrappedKron = (run.workingCapitalMRon * 1000) / FX_RON_TO_EUR;

  // Cash recovery = sum of liquidate/reduce items' capital (already in EUR
  // because flatten() converted at ingest).
  const cashRecoveryKron = items
    .filter(i => i.bucket === "LIQUIDATE" || i.bucket === "REDUCE")
    .reduce((s, i) => s + Math.abs(i.capitalMRon) * 1000, 0);

  const totalAbsProfit = items.reduce((s, i) => s + i.absoluteProfit, 0);
  // Weighted real margin: weight by abs(absoluteProfit) magnitude as a proxy
  // for revenue contribution (we don't have NIV here)
  const weightTotal = items.reduce((s, i) => s + Math.max(Math.abs(i.absoluteProfit), 1), 0) || 1;
  const weightedRealMargin = items.reduce(
    (s, i) => s + i.realMargin * Math.max(Math.abs(i.absoluteProfit), 1),
    0,
  ) / weightTotal;

  const summary: ExecutiveSummary = {
    cash_trapped_kron: cashTrappedKron,
    cash_recovery_potential_kron: cashRecoveryKron,
    roic_pct: run.roicPct,
    real_margin_pct: weightedRealMargin,
    products_analyzed: items.length,
    categories_analyzed: items.length,
    urgent_actions: counts.LIQUIDATE + counts.FIX,
    bucket_counts: {
      protect: counts.PROTECT,
      watch: counts.WATCH,
      fix: counts.FIX,
      reduce: counts.REDUCE,
      liquidate: counts.LIQUIDATE,
      scale: counts.SCALE,
    },
  };

  const topActions: Recommendation[] = items
    .filter(i => i.bucket === "LIQUIDATE" || i.bucket === "FIX" || i.bucket === "REDUCE")
    .sort((a, b) => {
      const pri: Record<Bucket, number> = {
        LIQUIDATE: 0, FIX: 1, REDUCE: 2, WATCH: 3, SCALE: 4, PROTECT: 5,
      };
      const d = pri[a.bucket] - pri[b.bucket];
      if (d !== 0) return d;
      return a.realMargin - b.realMargin;
    })
    .slice(0, 5)
    .map((i, idx) => ({
      id: idx + 1,
      target_type: "category",
      target_id: i.id,
      bucket: i.bucket,
      action_type:
        i.bucket === "LIQUIDATE" ? "liquidate" :
        i.bucket === "FIX" ? "renegotiate_supplier" :
        "reduce_reorder_qty",
      title:
        i.bucket === "LIQUIDATE" ? `Liquidate ${i.id}` :
        i.bucket === "FIX" ? `Renegotiate ${i.id}` :
        `Reduce reorder for ${i.id}`,
      explanation: i.reason ??
        `Real margin ${i.realMargin.toFixed(1)}% with ${i.dioDays}d DIO — ${i.bucket.toLowerCase()} action recommended.`,
      expected_cash_impact_kron: Math.abs(i.capitalMRon) * 1000 * (i.bucket === "REDUCE" ? 0.3 : 1),
      expected_margin_impact_pct: i.bucket === "FIX" ? 2 : null,
      urgency: i.realMargin < 0 ? "critical" : i.bucket === "LIQUIDATE" ? "high" : "medium",
      owner: null,
      status: "new",
      due_date: null,
      created_at: null,
      updated_at: null,
    }));

  return { items, summary, topActions };
}
