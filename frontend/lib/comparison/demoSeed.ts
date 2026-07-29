// F6.0.1b (2026-06-21) — Demo budget + last-year seed.
//
// On the PUBLIC_TEST_MODE workspace (already fully synthetic) we seed an
// illustrative budget + prior-year so the variance report renders live with
// realistic, mixed favorable/unfavorable deltas — the same posture as the
// configurable-dashboard demo. CLEARLY labeled "Demo" so it's never mistaken
// for real figures. Never seeded on a real uploaded workspace.

import type { ComparisonDataset, VarianceLineKey } from "./types";

// Per-line factors. Budget > actual on the top line (company a touch behind
// plan — the realistic case the Scandia Dec'25 deck itself shows: "Direct
// Margin vs BUG nefavorabil"); prior-year < actual (YoY growth).
const BUDGET_FACTOR: Partial<Record<VarianceLineKey, number>> = {
  operating_revenue: 1.06,
  cogs: 1.04,
  opex: 1.05,
  ebitda: 1.12,
  depreciation: 1.0,
  net_financial_result: 1.1,
  income_tax: 1.08,
  net_profit: 1.15,
};
const LY_FACTOR: Partial<Record<VarianceLineKey, number>> = {
  operating_revenue: 0.97,
  cogs: 0.95,
  opex: 0.93,
  ebitda: 0.9,
  depreciation: 0.98,
  net_financial_result: 1.25,
  income_tax: 0.92,
  net_profit: 0.85,
};

function scale(
  actual: Record<VarianceLineKey, number | null>,
  factors: Partial<Record<VarianceLineKey, number>>,
): Partial<Record<VarianceLineKey, number>> {
  const out: Partial<Record<VarianceLineKey, number>> = {};
  for (const [k, f] of Object.entries(factors) as [VarianceLineKey, number][]) {
    const a = actual[k];
    if (typeof a === "number" && Number.isFinite(a)) out[k] = a * f;
  }
  // Derive the subtotal lines so the demo waterfall ties internally.
  const rev = out.operating_revenue;
  const cogs = out.cogs;
  if (typeof rev === "number" && typeof cogs === "number") out.gross_profit = rev - cogs;
  const eb = out.ebitda;
  const dep = out.depreciation;
  if (typeof eb === "number" && typeof dep === "number") out.ebit = eb - dep;
  return out;
}

/** Build the illustrative demo comparison dataset from the live actuals. */
export function buildDemoComparison(
  actual: Record<VarianceLineKey, number | null>,
): ComparisonDataset {
  return {
    budget: scale(actual, BUDGET_FACTOR),
    lastYear: scale(actual, LY_FACTOR),
    label: "Demo budget · illustrative",
    source: "demo",
  };
}
