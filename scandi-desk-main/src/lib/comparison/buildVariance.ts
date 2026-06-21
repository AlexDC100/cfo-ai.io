// F6.0.1b (2026-06-21) — Variance row builder.
//
// Produces the Actual / Budget / Last-Year rows + deltas for the variance
// report. ACTUAL values reconcile to the dashboard tiles (operating revenue,
// statutory EBITDA, statutory net profit are the canonical values, the same
// ones the dashboard + scenario baseline use); the remaining line items come
// from the period's ReportingMetrics snapshot. BUDGET + LAST-YEAR come from
// the uploaded (or demo) ComparisonDataset.

import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";
import type { DashboardCanonical } from "@/lib/scenarios/dashboardCanon";
import {
  delta,
  type Delta,
  type DeltaSentiment,
  sentimentFor,
} from "@/lib/learning/computeDeltas";
import {
  VARIANCE_LINES,
  type ComparisonDataset,
  type VarianceLineKey,
} from "./types";

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Build the ACTUAL value for each variance line from the reconciled canonical
 * headline values + the metrics snapshot. Mirrors the dashboard so the
 * Actual column ties to the tiles to the RON.
 */
export function buildActualLines(
  metrics: ReportingMetrics,
  canon: DashboardCanonical,
): Record<VarianceLineKey, number | null> {
  const revenue = num(canon.operatingRevenue);
  const cogs = num(metrics.cogs);
  const ebitda = num(canon.ebitda);
  const dep = num(metrics.depreciation);
  // Gross profit + EBIT derived consistently from the canonical anchors so
  // the column reads as a clean waterfall (revenue − cogs; ebitda − D&A).
  const grossProfit =
    revenue !== null && cogs !== null ? revenue - cogs : num(metrics.grossProfit);
  const ebit =
    ebitda !== null && dep !== null ? ebitda - dep : num(metrics.ebit);
  return {
    operating_revenue: revenue,
    cogs,
    gross_profit: grossProfit,
    opex: num(metrics.opex),
    ebitda,
    depreciation: dep,
    ebit,
    net_financial_result: num(metrics.netFinancialResult),
    income_tax: num(metrics.incomeTax),
    net_profit: num(canon.netProfit),
  };
}

export interface VarianceRow {
  key: VarianceLineKey;
  label: string;
  emphasis: boolean;
  higherIsBetter: boolean;
  actual: number | null;
  budget: number | null;
  lastYear: number | null;
  /** Δ Actual − Budget (null when either side missing). */
  vsBudget: Delta | null;
  vsBudgetSentiment: DeltaSentiment | null;
  /** Δ Actual − Last Year. */
  vsLastYear: Delta | null;
  vsLastYearSentiment: DeltaSentiment | null;
}

function rowDelta(
  actual: number | null,
  comparison: number | null,
  higherIsBetter: boolean,
): { d: Delta | null; sentiment: DeltaSentiment | null } {
  if (actual === null || comparison === null) return { d: null, sentiment: null };
  const d = delta(actual, comparison);
  return { d, sentiment: sentimentFor(d, { invert: !higherIsBetter }) };
}

/** Build the full variance row set for the table. */
export function buildVarianceRows(
  actual: Record<VarianceLineKey, number | null>,
  dataset: ComparisonDataset | null,
): VarianceRow[] {
  return VARIANCE_LINES.map((def) => {
    const a = actual[def.key] ?? null;
    const b = dataset ? num(dataset.budget[def.key]) : null;
    const ly = dataset ? num(dataset.lastYear[def.key]) : null;
    const vb = rowDelta(a, b, def.higherIsBetter);
    const vl = rowDelta(a, ly, def.higherIsBetter);
    return {
      key: def.key,
      label: def.label,
      emphasis: def.emphasis ?? false,
      higherIsBetter: def.higherIsBetter,
      actual: a,
      budget: b,
      lastYear: ly,
      vsBudget: vb.d,
      vsBudgetSentiment: vb.sentiment,
      vsLastYear: vl.d,
      vsLastYearSentiment: vl.sentiment,
    };
  });
}
