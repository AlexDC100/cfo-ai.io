// F5.0 Phase 1 — Bucket → Concept resolver.
//
// The canonical schema uses `bucket` strings (e.g. "ebit", "totalAssets",
// "currentYearNetProfit") to label both line items and subtotals across the
// PL/BS structures. The F5.0 concept library uses snake_case keys
// (e.g. "ebit", "total_assets", "net_profit"). This helper bridges the two
// so PLLineView/PLSectionView/BSLineView/BSSectionView can wrap any
// numeric cell that has a known bucket — without each call site needing
// to know the mapping table.
//
// Unmapped buckets return undefined; consumers MUST handle the undefined
// case by rendering the plain span (no popover). Adding a new concept is
// a 2-line change: register the concept key in statements.ts/seed.ts and
// add a row to BUCKET_TO_CONCEPT below.

const BUCKET_TO_CONCEPT: Readonly<Record<string, string>> = {
  // ── PL buckets ─────────────────────────────────────────────────────
  revenue: "operating_revenue",
  cogs: "cogs",
  grossProfit: "gross_profit",
  operatingExpenses: "operating_expenses",
  depreciation: "depreciation_amortization",
  depreciationAmortization: "depreciation_amortization",
  ebit: "ebit",
  financialIncome: "net_financial_result",
  financialExpense: "net_financial_result",
  interestExpense: "interest_expense",
  otherIncome: "net_financial_result",
  pretax: "pretax_profit",
  taxExpense: "income_tax",
  netIncome: "net_profit",
  netIncomeOperational: "net_profit",
  currentYearNetProfit: "net_profit",

  // ── BS buckets ─────────────────────────────────────────────────────
  // Assets
  cash: "cash",
  inventory: "inventory",
  receivables: "receivables",
  accountsReceivable: "receivables",
  ar: "receivables",
  otherCurrentAssets: "current_assets",
  totalCurrentAssets: "current_assets",
  intangibles: "non_current_assets",
  ppe: "ppe",
  otherNonCurrentAssets: "non_current_assets",
  totalAssets: "total_assets",

  // Equity & Liabilities
  accountsPayable: "accounts_payable",
  ap: "accounts_payable",
  shortTermDebt: "short_term_debt",
  stDebt: "short_term_debt",
  otherCurrentLiab: "current_liabilities",
  totalCurrentLiabilities: "current_liabilities",
  longTermDebt: "long_term_debt",
  ltDebt: "long_term_debt",
  totalDebt: "total_debt",
  shareCapital: "share_capital",
  retainedEarnings: "retained_earnings",
  otherEquity: "shareholders_equity",
  totalEquity: "shareholders_equity",
  totalLiabilitiesAndEquity: "total_equity_liab",
};

/** Resolve a canonical bucket name to a concept registry key.
 *  Returns undefined for unmapped buckets — callers MUST handle that case
 *  by rendering Layer 1 only (no popover). */
export function bucketToConcept(bucket: string | undefined | null): string | undefined {
  if (!bucket) return undefined;
  return BUCKET_TO_CONCEPT[bucket];
}
