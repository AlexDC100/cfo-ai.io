// Taxonomy for cross-page number tracing.
//
// Every clickable number in the dashboard carries a TraceableSource so
// the renderer can navigate to the page + row where the number lives.
// The taxonomy uses STABLE bucket keys (not row indexes, not labels)
// so renames or row reorderings don't break links.
//
// Mirrors the engine's canonical BS / PL / CF bucket names exactly —
// see src/engine/api/_ro_coa.py `_BUCKET_TO_BS_FIELD` /
// `_BUCKET_TO_PL_FIELD`. When the engine grows a bucket, add it here
// and to the corresponding statement renderer's `data-traceable-target`
// attribute on the row.

/** Which statement tab the source row lives in. */
export type Statement = "bs" | "pl" | "cf";

/** Balance-sheet bucket keys — match engine canonical view exactly. */
export type BSBucket =
  // Current assets
  | "cash"
  | "accountsReceivable"
  | "inventory"
  | "otherCurrentAssets"
  | "totalCurrentAssets"
  // Non-current assets
  | "propertyPlantEquipment"
  | "intangibles"
  | "otherNonCurrentAssets"
  | "totalNonCurrentAssets"
  // Totals
  | "totalAssets"
  // Current liabilities
  | "accountsPayable"
  | "shortTermDebt"
  | "otherCurrentLiabilities"
  | "totalCurrentLiabilities"
  // Non-current liabilities
  | "longTermDebt"
  | "otherNonCurrentLiabilities"
  | "totalNonCurrentLiabilities"
  // Totals
  | "totalLiabilities"
  // Equity
  | "shareCapital"
  | "retainedEarnings"
  | "otherEquity"
  | "currentYearNetProfit"
  | "totalEquity"
  // Derived
  | "netDebt"
  | "workingCapital";

/** P&L bucket keys — match engine canonical view exactly. */
export type PLBucket =
  | "revenue"
  | "costOfGoodsSold"
  | "operatingExpenses"
  | "depreciationAmortization"
  | "interestExpense"
  | "otherIncome"
  | "financialIncome"
  | "financialExpense"
  | "taxExpense"
  | "capitalizedOwnWork"
  | "inventoryVariationMemo"
  // Derived
  | "grossProfit"
  | "ebitda"
  | "ebitdaStatutory"
  | "ebitdaCash"
  | "ebit"
  | "pretax"
  | "netIncome"
  | "netIncomeStatutory"
  | "netIncomeOperational"
  | "totalOperatingRevenue";

/** Cash-flow bucket keys. */
export type CFBucket =
  | "cashFromOperating"
  | "cashFromInvesting"
  | "cashFromFinancing"
  | "netChangeInCash"
  | "capex";

export type Bucket = BSBucket | PLBucket | CFBucket;

/** Origin metadata attached to a clickable number. The renderer turns
 *  this into `?tab=<statement>&highlight=<bucket>` on the URL when
 *  the user clicks. */
export interface TraceableSource {
  statement: Statement;
  bucket: Bucket;
  /** Optional human-readable hint shown in the tooltip on hover.
   *  e.g. "Trade receivables (4111)" — never overrides the formal
   *  bucket key but helps the user understand where they'll land. */
  hint?: string;
}

/** Maps each statement to its dashboard tab name (used by the URL).
 *  These must match the `tab=` values the dashboard router already
 *  uses for the existing pages. */
export const STATEMENT_TAB: Record<Statement, string> = {
  bs: "balance_sheet",
  pl: "pl",
  cf: "cash_flow",
};

/** The data attribute every target row sets so the highlight hook can
 *  find it. Same value as the source's `bucket`. */
export const TRACEABLE_TARGET_ATTR = "data-traceable-target";

/** The URL query parameter used to request a highlight. */
export const HIGHLIGHT_PARAM = "highlight";

/** The URL query parameter the dashboard already uses for the active
 *  statement tab. */
export const TAB_PARAM = "tab";
