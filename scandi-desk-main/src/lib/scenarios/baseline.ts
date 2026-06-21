// F6.0.5 (2026-06-20) — Scenario baseline builder + display config.
//
// THE RECONCILIATION LAYER between the live period and the cascade engine.
//
// Problem this solves: the cascade (cascade.ts) recomputes EBITDA/EBIT/Net
// profit from P&L PRIMITIVES (revenue − cogs − opex + D&A). But the
// dashboard shows STATUTORY EBITDA (engine `assembled_pl.ebitda_statutory`),
// which for asset-heavy entities (EEI) differs materially from the cash-view
// EBITDA that `deriveTotals` / `buildReportingMetricsSnapshot` produce —
// the 711/722 non-cash adjustments. If we fed raw snapshot primitives into
// the cascade, the scenario's "EBITDA at zero adjustment" would NOT equal
// the dashboard's EBITDA, and the user would see their numbers change when
// they changed nothing. That destroys trust in every downstream delta.
//
// Fix: CALIBRATE the baseline primitives so the cascade reproduces the
// statutory anchors EXACTLY at zero adjustment:
//
//   revenue   = canon.operatingRevenue  (the SAME value the dashboard tile
//               renders — passed in via buildDashboardCanonical, which mirrors
//               FinancialStatements' tile derivation. Review #1/#2/#3 caught
//               that sourcing this from the engine assembled_pl canonical
//               instead diverged from the tile by the 767/708 wedge.)
//   ebitda/NI = canon.ebitda / canon.netProfit  (likewise the tile values)
//   cogs      = snapshot cogs                          (cash cost of sales)
//   D&A       = snapshot depreciation + amortization
//   opex      = PLUG so that  (revenue − cogs) − opex + D&A = EBITDA_statutory
//   incomeTax = PLUG so that  ebit + netFinancialResult − tax = NetIncome_statutory
//
// With those plugs, cascadePnL at zero adjustment yields EBITDA_statutory,
// operating_ebit, and NetIncome_statutory to the RON — so the baseline
// column ties to the dashboard tiles (4.9M / 2.1M / 5.92×). A revenue −20%
// adjustment then drops gross profit by 20%×revenue (costs held unless the
// user also adjusts them), which flows correctly into EBITDA → net debt /
// EBITDA → covenant tests. That is exactly the "rent drops, what happens to
// leverage" question this feature answers.
//
// The opex + tax plugs stay INTERNAL — the comparison surface never shows
// them (it shows Revenue / EBITDA / Net profit / Cash / Debt + ratios), so
// there's no "weird opex number" leaking to the user.

import { deriveTotals, type Statements } from "@/lib/financialReport";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";

type WithAssembledPl = Statements & { assembled_pl?: Record<string, number> };

/** Prefer a finite canonical value, else the legacy fallback. Mirrors the
 *  `pick` helper in financialReport.ts so the scenario baseline reconciles
 *  to the exact values the dashboard renders. */
function pick(canon: number | undefined, legacy: number): number {
  return typeof canon === "number" && Number.isFinite(canon) ? canon : legacy;
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The four headline numbers the dashboard tiles render — see
 *  buildDashboardCanonical. When provided, the baseline ties to these
 *  EXACT values (review #1/#2/#3); without them it falls back to the engine
 *  assembled_pl picks. */
export interface ScenarioCanonical {
  operatingRevenue: number;
  ebitda: number;
  netProfit: number;
  totalDebt: number;
}

/**
 * Build the calibrated baseline ReportingMetrics the cascade operates on.
 * Returns {} for the empty-period state (the page renders an empty state).
 *
 * @param canon  The dashboard's four canonical values (from
 *               buildDashboardCanonical). The page ALWAYS passes these so
 *               the baseline column ties to the dashboard tiles to the RON.
 */
export function buildScenarioBaseline(
  statements: Statements | null,
  canon?: ScenarioCanonical,
): ReportingMetrics {
  const snap = buildReportingMetricsSnapshot(statements);
  if (!statements) return snap;

  const t = deriveTotals(statements);
  const ap = (statements as WithAssembledPl).assembled_pl ?? {};

  // Statutory anchors. Prefer the page-supplied canonical values (identical
  // derivation to the dashboard tiles) so the baseline reconciles exactly;
  // fall back to the engine assembled_pl picks for callers that don't pass
  // them.
  const revenue = canon ? canon.operatingRevenue : pick(ap.total_operating_revenue, num(snap.revenue));
  const ebitdaStatutory = canon ? canon.ebitda : pick(ap.ebitda_statutory, num(snap.ebitda) || t.ebitda);
  const niStatutory = canon ? canon.netProfit : pick(ap.net_income_statutory, num(snap.netProfit) || t.netIncome);
  const totalDebt = canon ? canon.totalDebt : num(snap.totalDebt) || t.totalDebt;

  const cogs = num(snap.cogs);
  const dep = num(snap.depreciation);
  const amort = num(snap.amortization);
  const netFinancialResult = num(snap.netFinancialResult);

  // Plug #1 — opex such that cascadePnL reproduces statutory EBITDA:
  //   ebitda = (revenue − cogs) − opex + dep + amort  ⇒
  //   opex   = (revenue − cogs) + dep + amort − ebitda_statutory
  const opexPlug = revenue - cogs + dep + amort - ebitdaStatutory;

  // The EBIT the cascade will derive at zero adjustment (= statutory EBIT).
  const ebitStatutory = ebitdaStatutory - dep - amort;

  // Plug #2 — incomeTax such that cascadePnL reproduces statutory net income:
  //   netProfit = (ebit + netFinancialResult) − tax  ⇒
  //   tax       = ebit + netFinancialResult − netIncome_statutory
  const taxPlug = ebitStatutory + netFinancialResult - niStatutory;

  return {
    ...snap,
    revenue,
    cogs,
    opex: opexPlug,
    depreciation: dep,
    amortization: amort,
    netFinancialResult,
    incomeTax: taxPlug,
    // ebitda / ebit / netProfit get RECOMPUTED by cascadePnL from the
    // primitives above; we seed them with the statutory values so a
    // zero-adjustment read before any cascade call is also correct.
    ebitda: ebitdaStatutory,
    ebit: ebitStatutory,
    netProfit: niStatutory,
    totalDebt,
  };
}

// ─── Comparison display config ──────────────────────────────────────────
//
// The rows shown in the Baseline → Scenario comparison table. Each maps to
// a concept key that resolveConceptValue() (the dashboard's resolver) knows
// how to read off a ReportingMetrics state — so baseline and scenario use
// the identical formula, and the LearnableNumber popover opens on each.

export type ScenarioMetricKind = "currency" | "percentage" | "ratio";

export interface ScenarioMetricRow {
  conceptKey: string;
  label: string;
  kind: ScenarioMetricKind;
  /** Drives delta sentiment colour: a higher value is good (revenue) vs a
   *  higher value is bad (leverage, debt). */
  higherIsBetter: boolean;
  /** Visual group separator — the first row of the "Ratios" block. */
  groupStart?: "headline" | "ratios";
}

export const SCENARIO_METRIC_ROWS: ScenarioMetricRow[] = [
  { conceptKey: "operating_revenue", label: "Revenue", kind: "currency", higherIsBetter: true, groupStart: "headline" },
  { conceptKey: "ebitda", label: "EBITDA", kind: "currency", higherIsBetter: true },
  { conceptKey: "net_profit", label: "Net profit", kind: "currency", higherIsBetter: true },
  { conceptKey: "cash", label: "Cash", kind: "currency", higherIsBetter: true },
  { conceptKey: "total_debt", label: "Total debt", kind: "currency", higherIsBetter: false },
  { conceptKey: "ebitda_margin", label: "EBITDA margin", kind: "percentage", higherIsBetter: true, groupStart: "ratios" },
  { conceptKey: "net_margin", label: "Net margin", kind: "percentage", higherIsBetter: true },
  { conceptKey: "net_debt_ebitda", label: "Net debt / EBITDA", kind: "ratio", higherIsBetter: false },
  { conceptKey: "current_ratio", label: "Current ratio", kind: "ratio", higherIsBetter: true },
  { conceptKey: "debt_to_equity", label: "Debt / equity", kind: "ratio", higherIsBetter: false },
  { conceptKey: "roe", label: "Return on equity", kind: "percentage", higherIsBetter: true },
];
