// Reference-format P&L statement structure.
//
// This is the canonical data shape every P&L renders against. It mirrors
// the EEI reference output the user provided — same sections, same
// EBITDA boxing, same financial items section with explicit ± signs.
//
// The build function (buildPLStatement) takes per-account line items from
// the backend and produces this structured form. The renderer
// (PLStatementView) consumes it and produces the visible P&L.

export type LineStyle = "item" | "subtotal" | "total" | "boxed" | "section_header";
export type LineSign = "positive" | "negative" | "neutral";

export interface PLLine {
  /** Romanian account code, e.g. "706", "6024". Undefined for subtotals. */
  accountCode?: string;
  /** Line description, e.g. "Rental & lease income". */
  label: string;
  /** Line amount; undefined for headers. */
  amount?: number;
  /** Rendering style. */
  style: LineStyle;
  /** For financial-items section — controls ± prefix on the amount. */
  sign?: LineSign;
  /** Optional indent level (0 = section, 1 = item, 2 = sub-item). */
  indent?: number;
  /** Stable Traceable bucket key (Phase C) — populated for rows any
   *  ratio / valuation tile on another tab might link back to via a
   *  `<TraceableNumber>` click. PLStatementView emits this as
   *  `data-traceable-target=` so `useHighlightFromUrl()` can scroll +
   *  pulse it. See src/lib/traceableSource.ts for the taxonomy. */
  bucket?: string;
}

export interface PLSection {
  /** Section header, e.g. "OPERATING REVENUE". Empty string = no header. */
  header: string;
  /** Line items in display order. */
  lines: PLLine[];
  /** Optional subtotal label (e.g. "Total operating revenue"). */
  subtotalLabel?: string;
  /** Optional subtotal amount paired with subtotalLabel. */
  subtotalAmount?: number;
  /** Stable Traceable bucket key for the section subtotal — e.g.
   *  "revenue" (= Total operating revenue), "ebit", "pretax", "netIncome".
   *  PLStatementView emits this on the subtotal row. */
  subtotalBucket?: string;
}

export interface PLKeyMargin {
  label: string;
  value: number;
  pct: boolean;
}

export interface PLStatement {
  entity: string;
  period: string;
  currency: string;
  sections: PLSection[];
  keyMargins: PLKeyMargin[];
  ebitda: number;
  ebit: number;
  netFinancialResult: number;
  profitBeforeTax: number;
  tax: number;
  /** Operational net profit — excludes account 722 (capitalized own-work).
   *  This is the "cash earnings" view used by buyers, lenders, and the
   *  valuation tab. For Scandia FY2025: RON 34.57M. */
  netProfit: number;
  /** Statutory net profit — INCLUDES 722. Matches account 121 closing
   *  balance, i.e. the legally filed net profit on ANAF books. This is
   *  the headline figure shown in the P&L tab and cited in the briefing
   *  because it's the number a Romanian CFO recognizes from their own
   *  accounts. For Scandia FY2025: RON 36.79M. */
  netProfitStatutory?: number;
  /** Capitalized own-work (722) — surfaced for the reconciliation footnote. */
  capitalizedOwnWorkMemo?: number;
  /** Account 628 third-party services — surfaced for the footnote. */
  extServOther?: number;
  /** Account 231 closing — for the CIP reconciliation. */
  cipUnderDevelopment?: number;
  /** Period month name for the footnote ("December", etc.). */
  periodMonth?: string;
}

// ───────────────────────────────────────────────────────────────────────
// Line items returned from the backend API
// ───────────────────────────────────────────────────────────────────────

/**
 * Per-account amount from the backend's assembled line_items list.
 * The amount is sign-corrected (positive for natural-side balances).
 */
export interface ApiLineItem {
  statement: "BS" | "PL" | "IGNORED";
  bucket: string;
  ro_account_code: string;
  ro_account_name?: string;
  amount: number;
  is_derived?: boolean;
}

/**
 * Sum line-item amounts where the account code matches a predicate.
 * Used by buildPLStatement to extract per-account totals from the
 * flat line-items list returned by the backend.
 */
export function sumByCode(items: ApiLineItem[], predicate: (code: string) => boolean): number {
  let total = 0;
  for (const li of items) {
    if (li.statement !== "PL") continue;
    if (predicate(li.ro_account_code)) total += li.amount;
  }
  return total;
}

/** Sum every line whose code starts with one of the prefixes. */
export function sumByPrefix(items: ApiLineItem[], ...prefixes: string[]): number {
  return sumByCode(items, (code) => prefixes.some((p) => code.startsWith(p)));
}

/** Sum lines for an exact account code. */
export function sumByExact(items: ApiLineItem[], code: string): number {
  return sumByCode(items, (c) => c === code);
}
