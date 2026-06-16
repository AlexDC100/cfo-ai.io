// F5.0 Wave 4 — Benchmark metric → concept key resolver.
//
// The benchmark API returns rows keyed by metric_name (e.g.
// "ebitda_margin_pct", "current_ratio", "net_debt_ebitda"). The F5.0
// concept registry uses snake_case (e.g. "ebitda_margin", "current_ratio").
// This helper bridges the two so HeadlineGrid / ComparisonSection rows
// can wrap their metric label with LearnableRowLabel.
//
// Unmapped names return undefined; callers MUST handle the undefined
// case by rendering plain text (no popover).

const BENCHMARK_METRIC_TO_CONCEPT: Readonly<Record<string, string>> = {
  // Profitability
  net_margin_pct: "net_margin",
  net_margin: "net_margin",
  ebitda_margin_pct: "ebitda_margin",
  ebitda_margin: "ebitda_margin",
  gross_margin_pct: "gross_margin",
  gross_margin: "gross_margin",
  ebit_margin_pct: "ebit_margin",
  ebit_margin: "ebit_margin",
  roe: "roe",
  roe_pct: "roe",
  roa: "roa",
  roa_pct: "roa",
  roic: "roic",
  roic_pct: "roic",

  // Liquidity
  current_ratio: "current_ratio",
  quick_ratio: "quick_ratio",
  cash_ratio: "cash_ratio",
  working_capital: "working_capital",

  // Leverage
  net_debt_ebitda: "net_debt_ebitda",
  net_debt_to_ebitda: "net_debt_ebitda",
  debt_to_equity: "debt_to_equity",
  debt_equity: "debt_to_equity",
  equity_ratio: "equity_ratio",
  equity_ratio_pct: "equity_ratio",
  interest_coverage: "interest_coverage",
  dscr: "dscr",

  // Efficiency
  dio_days: "dio_days",
  dio: "dio_days",
  dso_days: "dso_days",
  dso: "dso_days",
  dpo_days: "dpo_days",
  dpo: "dpo_days",
  ccc_days: "ccc_days",
  ccc: "ccc_days",
  asset_turnover: "asset_turnover",
  inventory_turnover: "inventory_turnover",

  // Risk
  altman_z: "altman_z",
  altman_z_score: "altman_z",
  piotroski_f: "piotroski_f",

  // Headline / scale
  revenue: "revenue",
  net_turnover: "revenue",
  turnover: "revenue",
  ebitda: "ebitda",
  net_profit: "net_profit",
  net_income: "net_profit",
  total_assets: "total_assets",
  total_equity: "shareholders_equity",
  shareholders_equity: "shareholders_equity",
  total_debt: "total_debt",
  cash: "cash",
};

/** Resolve a benchmark metric_name to a concept registry key. Returns
 *  undefined for unmapped names — callers MUST handle the undefined
 *  case by rendering plain text (no popover). */
export function benchmarkMetricToConcept(
  name: string | undefined | null,
): string | undefined {
  if (!name) return undefined;
  const k = name.trim().toLowerCase();
  return BENCHMARK_METRIC_TO_CONCEPT[k];
}
