// F6.0.1b (2026-06-21) — Budget vs Actual vs Last-Year variance types.
//
// Modeled on the Scandia management pack (BUG'26 budget deck + Dec'25 MTM
// actuals deck): a P&L variance report with ACTUAL / BUDGET / LAST YEAR
// columns and Δ-vs-Budget + Δ-vs-LY deltas, in the company's currency.
//
// "Budget" + "Last year" values come from an uploaded comparison file (or a
// labeled demo seed on the test workspace). Actuals come from the live
// period, reconciled to the dashboard tiles via buildDashboardCanonical.

export type VarianceLineKey =
  | "operating_revenue"
  | "cogs"
  | "gross_profit"
  | "opex"
  | "ebitda"
  | "depreciation"
  | "ebit"
  | "net_financial_result"
  | "income_tax"
  | "net_profit";

export interface VarianceLineDef {
  key: VarianceLineKey;
  label: string;
  /** Favorable direction: revenue/profit up = good; cost/tax up = bad.
   *  Drives the green/red of the Δ badges. */
  higherIsBetter: boolean;
  /** Subtotal rows (gross profit, EBITDA, EBIT, net profit) render bold. */
  emphasis?: boolean;
}

/** The P&L rows of the variance report, in statement order. */
export const VARIANCE_LINES: VarianceLineDef[] = [
  { key: "operating_revenue", label: "Revenue", higherIsBetter: true, emphasis: true },
  { key: "cogs", label: "Cost of sales", higherIsBetter: false },
  { key: "gross_profit", label: "Gross profit", higherIsBetter: true, emphasis: true },
  { key: "opex", label: "Operating expenses", higherIsBetter: false },
  { key: "ebitda", label: "EBITDA", higherIsBetter: true, emphasis: true },
  { key: "depreciation", label: "Depreciation & amortization", higherIsBetter: false },
  { key: "ebit", label: "EBIT (operating result)", higherIsBetter: true, emphasis: true },
  { key: "net_financial_result", label: "Net financial result", higherIsBetter: true },
  { key: "income_tax", label: "Income tax", higherIsBetter: false },
  { key: "net_profit", label: "Net profit", higherIsBetter: true, emphasis: true },
];

/** The headline KPIs surfaced as variance cards above the table. */
export const VARIANCE_KPI_KEYS: VarianceLineKey[] = [
  "operating_revenue",
  "ebitda",
  "net_profit",
];

/** A comparison dataset: budget + prior-year amounts keyed by line, in the
 *  same currency as the actuals. Sparse — any line may be absent (renders
 *  "—" rather than a fabricated zero). */
export interface ComparisonDataset {
  budget: Partial<Record<VarianceLineKey, number>>;
  lastYear: Partial<Record<VarianceLineKey, number>>;
  /** Source currency of the budget/LY figures (defaults to the period's). */
  currency?: string;
  /** Human label, e.g. "Budget 2026 · FY2025 actuals" or "Demo". */
  label?: string;
  source: "demo" | "upload";
  /** ISO timestamp of the upload (omitted for demo). */
  updatedAt?: string;
}
