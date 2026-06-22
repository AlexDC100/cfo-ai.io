// Classification engine — applies decision rules to raw SKU rows
// and produces a DailyRun matching src/data/dailyRun.ts shape.

import type { Anchor, CategoryDecision, DailyRun, Flag } from "@/data/dailyRun";

export interface RawSkuRow {
  category: string;
  sku?: string;
  volumeT: number;        // tonnes
  revenue: number;        // RON (NIV)
  grossMarginPct: number; // % e.g. 12.4
  dioDays: number;        // days
  strategicFlag?: boolean;
}

export interface EngineConfig {
  costOfCapitalPct: number;       // e.g. 6.5
  anchorTopPct: number;           // top % by absolute profit -> anchor (e.g. 20)
  anchorMinRevenueSharePct: number; // e.g. 5
  highVolumeAnchorFloorPct: number; // e.g. 5
  highVolumeThresholdT: number;   // e.g. 250
  eliminateRealMarginPct: number; // e.g. 0
  reviewRealMarginPct: number;    // e.g. 2
  scaleRealMarginPct: number;     // e.g. 8
  subTonneVolumeT: number;        // e.g. 1
  wocaCorrectionPct: number;      // e.g. 0
}

export const defaultConfig: EngineConfig = {
  costOfCapitalPct: 6.5,
  anchorTopPct: 20,
  anchorMinRevenueSharePct: 5,
  highVolumeAnchorFloorPct: 5,
  highVolumeThresholdT: 250,
  eliminateRealMarginPct: 0,
  reviewRealMarginPct: 2,
  scaleRealMarginPct: 8,
  subTonneVolumeT: 1,
  wocaCorrectionPct: 0,
};

interface CategoryAgg {
  name: string;
  volumeT: number;
  revenue: number;
  grossMarginPct: number; // weighted by revenue
  dioDays: number;        // weighted by revenue
  realMarginPct: number;
  absoluteProfitKRon: number;
  capitalMRon: number;
  strategic: boolean;
}

export function aggregateRows(rows: RawSkuRow[], cfg: EngineConfig): CategoryAgg[] {
  const buckets = new Map<string, RawSkuRow[]>();
  for (const r of rows) {
    if (!r.category) continue;
    const key = r.category.trim();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }

  const out: CategoryAgg[] = [];
  for (const [name, items] of buckets) {
    const revenue = sum(items.map((i) => i.revenue));
    const volumeT = sum(items.map((i) => i.volumeT));
    const gm = revenue > 0 ? sum(items.map((i) => i.grossMarginPct * i.revenue)) / revenue : 0;
    const dio = revenue > 0 ? sum(items.map((i) => i.dioDays * i.revenue)) / revenue : 0;
    const dioCost = (dio / 365) * cfg.costOfCapitalPct;
    const realMarginPct = gm - dioCost - cfg.wocaCorrectionPct;
    const absoluteProfitKRon = (revenue * realMarginPct) / 100 / 1000;
    // Capital tied up ≈ revenue * (DIO / 365). Express in MRON.
    const capitalMRon = (revenue * (dio / 365)) / 1_000_000;
    out.push({
      name,
      volumeT,
      revenue,
      grossMarginPct: gm,
      dioDays: dio,
      realMarginPct,
      absoluteProfitKRon,
      capitalMRon,
      strategic: items.some((i) => i.strategicFlag),
    });
  }
  return out;
}

export function classify(rows: RawSkuRow[], cfg: EngineConfig, meta: { date: string; period: string }): DailyRun {
  const agg = aggregateRows(rows, cfg);
  const totalRevenue = sum(agg.map((a) => a.revenue));
  const totalProfitK = sum(agg.map((a) => a.absoluteProfitKRon));
  const workingCapitalMRon = sum(agg.map((a) => a.capitalMRon));

  // Anchor selection: top N by absolute profit covering anchorTopPct of count, OR revenue share above threshold, OR strategic
  const sortedByProfit = [...agg].sort((a, b) => b.absoluteProfitKRon - a.absoluteProfitKRon);
  const topCount = Math.max(1, Math.round((cfg.anchorTopPct / 100) * agg.length));
  const topSet = new Set(sortedByProfit.slice(0, topCount).map((a) => a.name));

  const anchorNames = new Set<string>();
  for (const a of agg) {
    const revShare = totalRevenue > 0 ? (a.revenue / totalRevenue) * 100 : 0;
    if (a.strategic) anchorNames.add(a.name);
    else if (topSet.has(a.name) && revShare >= cfg.anchorMinRevenueSharePct) anchorNames.add(a.name);
  }

  const anchors: Anchor[] = [];
  const eliminate: CategoryDecision[] = [];
  const review: CategoryDecision[] = [];
  const scale: CategoryDecision[] = [];

  for (const a of agg) {
    const isAnchor = anchorNames.has(a.name);
    if (isAnchor) {
      const highVolume = a.volumeT >= cfg.highVolumeThresholdT;
      const breaches = highVolume && a.realMarginPct < cfg.highVolumeAnchorFloorPct;
      anchors.push({
        name: a.name,
        realMargin: round(a.realMarginPct),
        absoluteProfit: round(a.absoluteProfitKRon),
        volumeT: round(a.volumeT, 1),
        dioDays: Math.round(a.dioDays),
        capitalMRon: round(a.capitalMRon, 1),
        status: breaches ? "alert" : "healthy",
        grossMargin: round(a.grossMarginPct),
        alertReason: breaches
          ? `Volume qualifies this category as anchor (${Math.round(a.volumeT)}t). Real margin (${round(a.realMarginPct)}%) is below the ${cfg.highVolumeAnchorFloorPct}% floor for high-volume anchors. Gross margin ${round(a.grossMarginPct)}% compressed by ${Math.round(a.dioDays)}-day inventory hold.`
          : undefined,
      });
      continue;
    }

    const dec: CategoryDecision = {
      name: a.name,
      flag: "review",
      realMargin: round(a.realMarginPct),
      absoluteProfit: round(a.absoluteProfitKRon),
    };

    if (a.volumeT < cfg.subTonneVolumeT || a.realMarginPct < cfg.eliminateRealMarginPct) {
      dec.flag = "eliminate";
      dec.reason = a.volumeT < cfg.subTonneVolumeT ? "Sub-tonne volume" : `Real margin ${round(a.realMarginPct)}%`;
      eliminate.push(dec);
    } else if (a.realMarginPct >= cfg.scaleRealMarginPct) {
      dec.flag = "scale";
      dec.reason = "Headroom above cost of capital";
      scale.push(dec);
    } else if (a.realMarginPct < cfg.reviewRealMarginPct) {
      dec.flag = "review";
      dec.reason = "Volume present, margin compressed";
      review.push(dec);
    } else {
      // Healthy non-anchor: park in review with no urgency
      dec.flag = "review";
      review.push(dec);
    }
  }

  // Sort each list by impact (desc by abs profit / desc severity)
  eliminate.sort((a, b) => a.realMargin - b.realMargin);
  review.sort((a, b) => b.absoluteProfit - a.absoluteProfit);
  scale.sort((a, b) => b.absoluteProfit - a.absoluteProfit);
  anchors.sort((a, b) => b.absoluteProfit - a.absoluteProfit);

  const anchorProfit = sum(anchors.map((a) => a.absoluteProfit));
  const anchorProfitShare = totalProfitK > 0 ? Math.max(0, Math.min(1, anchorProfit / totalProfitK)) : 0;

  // ROIC ≈ total profit / working capital
  const profitMRon = totalProfitK / 1000;
  const roicPct = workingCapitalMRon > 0 ? (profitMRon / workingCapitalMRon) * 100 : 0;

  const now = new Date();
  return {
    date: meta.date,
    period: meta.period,
    workingCapitalMRon: round(workingCapitalMRon, 2),
    roicPct: round(roicPct),
    costOfCapitalPct: cfg.costOfCapitalPct,
    runCompletedAt: now.toTimeString().slice(0, 5),
    nextRunAt: "06:00",
    confidence: rows.length > 50 ? "high" : rows.length > 10 ? "medium" : "low",
    anchorProfitShare: round(anchorProfitShare, 3),
    eliminate,
    review,
    scale,
    anchors,
  };
}

function sum(xs: number[]) { return xs.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0); }
function round(v: number, d = 1) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

// ----- Column mapping helpers -----
export type FieldKey = keyof RawSkuRow;
// DIO is required for the in-browser engine but the SERVER engine inherits it
// from canonical category data when missing. We treat it as optional in the UI
// — when no DIO column is mapped, callers route to the backend instead.
export const REQUIRED_FIELDS: FieldKey[] = ["category", "volumeT", "revenue", "grossMarginPct"];
export const OPTIONAL_FIELDS: FieldKey[] = ["sku", "dioDays", "strategicFlag"];

export const FIELD_LABELS: Record<FieldKey, string> = {
  category: "Category",
  sku: "SKU (optional)",
  volumeT: "Volume (tonnes)",
  revenue: "Revenue / NIV (RON)",
  grossMarginPct: "Gross margin (%)",
  dioDays: "DIO (days)",
  strategicFlag: "Strategic flag (optional)",
};

const HINTS: Record<FieldKey, RegExp> = {
  category: /(categor|grup|family|familie)/i,
  sku: /^(sku|cod|code|article|articol)/i,
  volumeT: /(volum|tone|tons|tonn|qty|cantit)/i,
  revenue: /(revenue|niv|sales|cifra|venit|incasari)/i,
  grossMarginPct: /(gross.?margin|gm|marja|adaos)/i,
  dioDays: /(dio|days|stock.?days|zile)/i,
  strategicFlag: /(strateg|protect)/i,
};

export function autoMap(headers: string[]): Partial<Record<FieldKey, string>> {
  const map: Partial<Record<FieldKey, string>> = {};
  const used = new Set<string>();
  for (const f of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const found = headers.find((h) => !used.has(h) && HINTS[f].test(String(h)));
    if (found) { map[f] = found; used.add(found); }
  }
  return map;
}

export function rowsFromSheet(
  records: Record<string, unknown>[],
  mapping: Partial<Record<FieldKey, string>>,
): RawSkuRow[] {
  const out: RawSkuRow[] = [];
  for (const rec of records) {
    const get = (f: FieldKey) => (mapping[f] ? rec[mapping[f]!] : undefined);
    const category = String(get("category") ?? "").trim();
    if (!category) continue;
    const row: RawSkuRow = {
      category,
      sku: get("sku") != null ? String(get("sku")) : undefined,
      volumeT: toNum(get("volumeT")),
      revenue: toNum(get("revenue")),
      grossMarginPct: toPct(get("grossMarginPct")),
      dioDays: toNum(get("dioDays")),
      strategicFlag: toBool(get("strategicFlag")),
    };
    out.push(row);
  }
  return out;
}

function toNum(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function toPct(v: unknown): number {
  const n = toNum(v);
  // If it looks like a fraction (0.124), convert to percent
  return Math.abs(n) <= 1 && n !== 0 ? n * 100 : n;
}
function toBool(v: unknown): boolean {
  if (v == null || v === "") return false;
  const s = String(v).toLowerCase().trim();
  return ["1", "true", "yes", "y", "da", "x"].includes(s);
}
