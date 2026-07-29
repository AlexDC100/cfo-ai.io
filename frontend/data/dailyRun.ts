// Bundled demo/seed DailyRun.
//
// This is the fallback dataset returned by runStore.read() when no workbook
// has been uploaded (localStorage miss). It is DEMO data — category names are
// intentionally generic FMCG groupings so the dashboard never exposes a real
// customer's product catalog. The pack-size variants in cfoDerive.PACK_VARIANTS
// are keyed off these exact category names, so keep them in sync.
//
// Shape note: this is the legacy in-browser run model. The server returns the
// same shape from /api/classify-rows, /api/upload-excel, and /api/analyze, so
// engine.ts::classify() and the backend both produce a DailyRun.
//
// Units:
//   absoluteProfit  — kRON (thousands of RON)
//   capitalMRon     — MRON (millions of RON), working capital tied up
//   volumeT         — tonnes
//   realMargin / grossMargin — percent (e.g. 9.2 = 9.2%)
// cfoDerive.flatten() converts RON → EUR at the ingest boundary.

/** Decision bucket assigned to a non-anchor category by the engine. */
export type Flag = "eliminate" | "review" | "warning" | "scale";

/** A protected category — kept for volume / revenue weight regardless of margin. */
export interface Anchor {
  name: string;
  realMargin: number;        // % after working-capital cost
  absoluteProfit: number;    // kRON
  volumeT: number;           // tonnes
  dioDays: number;
  capitalMRon: number;       // MRON tied up
  status: "healthy" | "alert";
  grossMargin: number;       // %
  /** Cash-conversion cycle in days, when known (server runs carry it). */
  cccDays?: number | null;
  /** Populated when status === "alert": why the anchor is flagged. */
  alertReason?: string;
}

/** A non-anchor category routed into eliminate / review / scale. */
export interface CategoryDecision {
  name: string;
  flag: Flag;
  realMargin: number;        // %
  absoluteProfit: number;    // kRON
  reason?: string;
  // Optional richer fields the server attaches; the legacy seed may omit them
  // and cfoDerive falls back to estimates when absent.
  volumeT?: number;
  dioDays?: number;
  capitalMRon?: number;      // MRON
  cccDays?: number | null;
  grossMargin?: number;      // %
}

/** One classification run over a dataset — the unit the dashboard renders. */
export interface DailyRun {
  date: string;              // YYYY-MM-DD
  period: string;            // human label, e.g. "10 months to Apr 2026"
  workingCapitalMRon: number;
  roicPct: number;
  costOfCapitalPct: number;
  runCompletedAt: string;    // HH:MM
  nextRunAt: string;         // HH:MM
  confidence: "high" | "medium" | "low";
  /** Share of total profit carried by anchor categories, 0..1. */
  anchorProfitShare: number;
  eliminate: CategoryDecision[];
  review: CategoryDecision[];
  scale: CategoryDecision[];
  anchors: Anchor[];
}

const anchors: Anchor[] = [
  {
    name: "Flagship Line",
    realMargin: 9.2,
    absoluteProfit: 4200,
    volumeT: 820,
    dioDays: 48,
    capitalMRon: 5.1,
    status: "healthy",
    grossMargin: 14.5,
    cccDays: 38,
  },
  {
    name: "Core Range",
    realMargin: 7.8,
    absoluteProfit: 3100,
    volumeT: 540,
    dioDays: 55,
    capitalMRon: 4.0,
    status: "healthy",
    grossMargin: 13.1,
    cccDays: 44,
  },
  {
    name: "Premium Cuts",
    realMargin: 3.1,
    absoluteProfit: 1500,
    volumeT: 410,
    dioDays: 96,
    capitalMRon: 6.2,
    status: "alert",
    grossMargin: 11.8,
    cccDays: 82,
    alertReason:
      "Volume qualifies this category as anchor (410t). Real margin (3.1%) is below the 5% floor for high-volume anchors. Gross margin 11.8% is compressed by a 96-day inventory hold.",
  },
];

const scale: CategoryDecision[] = [
  {
    name: "Beverages",
    flag: "scale",
    realMargin: 14.6,
    absoluteProfit: 980,
    volumeT: 120,
    dioDays: 41,
    capitalMRon: 0.7,
    cccDays: 30,
    grossMargin: 19.2,
    reason: "Headroom above cost of capital — fast rotation, strong real margin.",
  },
  {
    name: "Fruit Preserves",
    flag: "scale",
    realMargin: 12.9,
    absoluteProfit: 640,
    volumeT: 75,
    dioDays: 58,
    capitalMRon: 0.6,
    cccDays: 49,
    grossMargin: 17.4,
    reason: "Headroom above cost of capital — scale candidate.",
  },
];

const review: CategoryDecision[] = [
  {
    name: "Pantry Essentials",
    flag: "review",
    realMargin: 4.2,
    absoluteProfit: 720,
    volumeT: 260,
    dioDays: 88,
    capitalMRon: 1.9,
    cccDays: 74,
    grossMargin: 10.6,
    reason: "Volume present, margin compressed by inventory hold.",
  },
  {
    name: "Tinned Range",
    flag: "review",
    realMargin: 2.4,
    absoluteProfit: 410,
    volumeT: 190,
    dioDays: 102,
    capitalMRon: 2.1,
    cccDays: 90,
    grossMargin: 9.1,
    reason: "Thin real margin with a long inventory cycle.",
  },
  {
    name: "Ready Meals",
    flag: "warning",
    realMargin: 4.8,
    absoluteProfit: 300,
    volumeT: 95,
    dioDays: 76,
    capitalMRon: 0.8,
    cccDays: 61,
    grossMargin: 11.0,
    reason: "Margin near the threshold — watch the trend.",
  },
];

const eliminate: CategoryDecision[] = [
  {
    name: "Specialty Imports",
    flag: "eliminate",
    realMargin: -2.6,
    absoluteProfit: -180,
    volumeT: 18,
    dioDays: 165,
    capitalMRon: 0.9,
    cccDays: 148,
    grossMargin: 6.4,
    reason: "Real margin -2.6% — destroying value after cost of capital.",
  },
  {
    name: "Pickled Goods",
    flag: "eliminate",
    realMargin: -1.1,
    absoluteProfit: -60,
    volumeT: 12,
    dioDays: 140,
    capitalMRon: 0.5,
    cccDays: 124,
    grossMargin: 7.2,
    reason: "Real margin -1.1% — negative after working-capital cost.",
  },
  {
    name: "Companion Foods",
    flag: "eliminate",
    realMargin: 1.8,
    absoluteProfit: 90,
    volumeT: 6,
    dioDays: 120,
    capitalMRon: 0.4,
    cccDays: 104,
    grossMargin: 8.0,
    reason: "Sub-scale volume with capital trapped at 120-day DIO.",
  },
];

/**
 * Demo seed. workingCapitalMRon / roicPct are the authoritative run-level
 * aggregates (per-item capital is partial — see cfoDerive.derive()).
 */
export const dailyRun: DailyRun = {
  date: "2026-06-29",
  period: "10 months to Apr 2026",
  workingCapitalMRon: 71.5,
  roicPct: 16.4,
  costOfCapitalPct: 6.5,
  runCompletedAt: "05:42",
  nextRunAt: "06:00",
  confidence: "high",
  anchorProfitShare: 0.752,
  eliminate,
  review,
  scale,
  anchors,
};

export default dailyRun;
