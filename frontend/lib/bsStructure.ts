// Reference-format Balance Sheet structure.
//
// Same shape philosophy as the P&L renderer (plStructure.ts): a structured
// list of sections, each with line items and an optional subtotal. The
// difference is the BS shows TWO periods side-by-side (opening + closing)
// with a delta column, and contra-asset rows (accumulated depreciation)
// render in parentheses.

export type BSLineStyle = "item" | "subtotal" | "total" | "contra" | "note";

export interface BSLine {
  /** Romanian account code(s), e.g. "215", "1621", "5121+5124+5311" */
  accountCode?: string;
  /** Description, e.g. "Investment property" */
  label: string;
  /** Opening balance (01.01.<year>) */
  opening?: number;
  /** Closing balance (31.12.<year>) */
  closing?: number;
  /** Delta — when undefined, the renderer computes closing − opening */
  delta?: number;
  style: BSLineStyle;
  /** Contra-asset (accumulated depreciation) — render in parens, treat as negative */
  isContra?: boolean;
  indent?: number;
  /** Stable Traceable bucket key — populated for rows that any ratio,
   *  valuation tile, or KPI on another tab might link back to. The
   *  BSStatementView renderer emits this as `data-traceable-target=`
   *  on the row so `useHighlightFromUrl()` can scroll+pulse it when
   *  a `<TraceableNumber>` click lands here. See
   *  src/lib/traceableSource.ts for the bucket taxonomy. */
  bucket?: string;
}

export interface BSSection {
  /** Section header, e.g. "NON-CURRENT" or "EQUITY" */
  header: string;
  lines: BSLine[];
  subtotalLabel?: string;
  subtotalOpening?: number;
  subtotalClosing?: number;
  subtotalDelta?: number;
  /** Stable Traceable bucket key for the section subtotal row — e.g.
   *  "totalCurrentAssets", "totalCurrentLiabilities". Renderer emits
   *  this on the subtotal row so cross-page TraceableNumber clicks
   *  can land here. */
  subtotalBucket?: string;
}

export interface BSStatement {
  entity: string;
  /** Date string for closing column, e.g. "31.12.2025" */
  asOf: string;
  /** Date string for opening column, e.g. "01.01.2025" */
  comparativeDate: string;
  currency: string;
  /** Asset side — typically [NON-CURRENT, CURRENT] */
  assetSections: BSSection[];
  totalAssets: { opening: number; closing: number; delta: number };
  /** Equity & liabilities side — typically [EQUITY, NON-CURRENT LIAB, CURRENT LIAB] */
  equityLiabSections: BSSection[];
  totalEquityLiab: { opening: number; closing: number; delta: number };
  /** closing total assets − closing total E&L; should be ~0 */
  balanceCheck: number;
  /** Optional note shown beneath the BS, e.g. dividends declared-but-not-paid */
  note?: string;
}
