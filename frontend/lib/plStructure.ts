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

/** The part a section plays in the reference layout. PLStatementView places
 *  each section BY ITS ROLE — the EBITDA box after the operating expenses,
 *  the profit-before-tax-to-net-profit block last — never by its index:
 *  the optional OTHER OPERATING INCOME section (account 758) shifts every
 *  index after it. */
export type PLSectionRole =
  | "operatingRevenue"
  | "otherOperatingIncome"
  | "operatingExpenses"
  | "depreciation"
  | "financialItems"
  | "closing";

export interface PLSection {
  /** The section's place in the reference layout. Both RO builders set it
   *  on every section; a statement that sets none (the public-company
   *  adapter) is read positionally, as before — see PLStatementView's
   *  `plLayout`. */
  role?: PLSectionRole;
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
  /** WHAT THIS SUBTOTAL FOLDS IN BEYOND THE ENGINE LINE ITS KEY MAPS TO,
   *  for the comparatives guard (lib/comparatives.ts `cellForRow`). Keyed
   *  by the served `assembled_pl` field that states each component; the
   *  value is the CURRENT period's amount (null: unreadable). "Total
   *  operating revenue" is net turnover PLUS capitalized own work (722) —
   *  and, on the line-item path, discounts received (767) — so it may
   *  carry the engine's net-turnover cells only while every component here
   *  is zero in BOTH periods (the prior's is read off the served
   *  comparatives document). Absent: the subtotal folds nothing in. */
  subtotalFolds?: Readonly<Record<string, number | null>>;
}

export interface PLKeyMargin {
  label: string;
  /** null = REFUSED. A margin whose operands the payload does not carry has no
   *  value, and 0.00% is a different claim: it says the company earned nothing.
   *  Measured 2026-09-21 — with the canonical rows absent this block printed
   *  "Net margin 0.00%" beside a net profit of 7,533,676 on the same screen. */
  value: number | null;
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
  /** Revenue by three-digit account family ("701", "706", …), read off
   *  the period's OWN revenue-bucket leaves — the same reading as the
   *  aggregates row's chip (`revenueFamiliesChip`). The footnote's
   *  rental-dominance test reads the 706 family here. It used to look for
   *  a line whose `accountCode` was exactly "706": on a sub-account ledger
   *  (7061, 7062, …) that found nothing, and on the aggregates path it
   *  found the row's chip — a label — so a chip reading "706" made every
   *  such book a landlord and a chip listing five families made none.
   *  Absent when no leaves were available to read. */
  revenueFamilyAmounts?: Record<string, number>;
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

/**
 * One amount of a SERVED `assembled_pl` block, read under the served
 * contract — the one reading the P&L builders and the comparatives guard
 * share for the components a total folds in (`PLSection.subtotalFolds`).
 *
 * The engine serves the block densely: every field on every assembled P&L,
 * 0.00 for a book that holds none of it (`capitalized_own_work_memo` is
 * `round(pl.get("capitalizedOwnWork", 0.0), 2)`). So a field the block
 * does not carry, or a block that was not served at all, reads as ZERO —
 * that is what the contract says the absence means. (Where the whole block
 * is missing, the engine's comparative lines read absent from it too, so
 * no prior figure stands beside that zero.)
 *
 * A value that IS served but is not a finite number — null, NaN, a string
 * — is not an absence the contract produces. It is a refusal or a defect,
 * and it reads as `null`: never as a zero.
 */
export function servedPlAmount(block: unknown, field: string): number | null {
  if (block === undefined || block === null) return 0;
  if (typeof block !== "object" || Array.isArray(block)) return null;
  const value = (block as Record<string, unknown>)[field];
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
