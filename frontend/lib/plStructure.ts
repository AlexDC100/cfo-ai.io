// Reference-format P&L statement structure.
//
// This is the canonical data shape every P&L renders against. It mirrors
// the EEI reference output the user provided — same sections, same
// EBITDA boxing, same financial items section with explicit ± signs.
//
// The build function (buildPLStatement) takes per-account line items from
// the backend and produces this structured form. The renderer
// (PLStatementView) consumes it and produces the visible P&L.
//
// THE ONE EBITDA (owner ruling 2026-09-26). On an engine period every
// subtotal the statement states — net turnover, EBITDA, EBIT, profit before
// tax, the net result — is the SERVED figure (lib/servedOneEbitda.ts), and a
// refused one is `null` with its typed reason beside it, never a zero and
// never a figure this file derived. The stock variation (711) and own work
// capitalised (72x) are rows of their own, named by the engine.

import type { Bilingual, ServedOneEbitda, ServedRefusal } from "./servedOneEbitda";

/** A name the engine serves in Romanian with an English gloss. The Romanian
 *  UI prints `ro`; the English UI prints `ro` and the gloss beside it
 *  (CLAUDE.md §11: Romanian account names stay; the English explains). */
export interface RoName {
  readonly ro: string;
  readonly glossEn?: string | null;
}

export type LineStyle = "item" | "subtotal" | "total" | "boxed" | "section_header";
export type LineSign = "positive" | "negative" | "neutral";

export interface PLLine {
  /** Romanian account code, e.g. "706", "6024". Undefined for subtotals. */
  accountCode?: string;
  /** The same chip as the engine words it for a Romanian reader, where the
   *  two differ ("68x fără 6812, 6814" beside "68x excl. 6812, 6814"). The
   *  view prints it in the Romanian interface; `accountCode` stays the
   *  English wording and the key the term map reads. */
  accountCodeRo?: string;
  /** Line description, e.g. "Rental & lease income". */
  label: string;
  /** Line amount; undefined for headers and for a REFUSED figure (then
   *  `refusal` says why). */
  amount?: number;
  /** The engine's own Romanian name for the line (with its English gloss).
   *  When present the view prints it instead of `label`, which stays the
   *  English fallback for non-view readers. */
  roName?: RoName;
  /** The engine's provenance for a MEASURED line (net 711, net 72x): its
   *  key and its sentence, printed under the row. */
  provenance?: { readonly key: string; readonly label: Bilingual | null };
  /** A figure the engine REFUSED. The row prints the reason, never a
   *  number and never a bare dash. */
  refusal?: ServedRefusal;
  /** The stock variation's direction, as the owner asked it shown:
   *  "+ creștere de stoc" / "− scădere de stoc". */
  stockDirection?: "increase" | "decrease";
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
  /** Own work capitalised (72x): operating, outside turnover. */
  | "capitalizedOwnWork"
  | "operatingExpenses"
  /** Variația stocurilor de produse (711): beside the cost block, signed. */
  | "stockVariation"
  | "depreciation"
  | "financialItems"
  | "closing";

export interface PLSection {
  /** The section's place in the reference layout. Both RO builders set it
   *  on every section; a statement that sets none (the public-company
   *  adapter) is read positionally, as before — see PLStatementView's
   *  `plLayout`. */
  role?: PLSectionRole;
  /** Section header, e.g. "NET TURNOVER". Empty string = no header. */
  header: string;
  /** Line items in display order. */
  lines: PLLine[];
  /** Optional subtotal label (e.g. "Total net turnover"). */
  subtotalLabel?: string;
  /** Optional subtotal amount paired with subtotalLabel. */
  subtotalAmount?: number;
  /** Stable Traceable bucket key for the section subtotal — e.g.
   *  "revenue" (= Total net turnover), "ebit", "pretax", "netIncomeStatutory".
   *  PLStatementView emits this on the subtotal row. */
  subtotalBucket?: string;
  /** The engine's Romanian name for the subtotal (with its gloss). */
  subtotalRoName?: RoName;
  /** The engine's Romanian name for the header (with its gloss). */
  headerRoName?: RoName;
  /** The subtotal the engine REFUSED (then `subtotalAmount` is undefined). */
  subtotalRefusal?: ServedRefusal;
}

export interface PLKeyMargin {
  label: string;
  /** null = REFUSED. A margin whose operands the payload does not carry has no
   *  value, and 0.00% is a different claim: it says the company earned nothing.
   *  Measured 2026-09-21 — with the canonical rows absent this block printed
   *  "Net margin 0.00%" beside a net profit of 7,533,676 on the same screen. */
  value: number | null;
  pct: boolean;
  /** The ENGINE's refusal of this margin, per language, when turnover is
   *  negligible against operating activity (engine.ratios.margin_meaning,
   *  served on `statements.margin_meaning`). Present iff `value` is null
   *  for that reason; the view prints it in place of a percent. */
  refusal?: { readonly ro: string; readonly en: string };
}

export interface PLStatement {
  entity: string;
  period: string;
  currency: string;
  sections: PLSection[];
  keyMargins: PLKeyMargin[];
  /** THE ONE EBITDA — the engine's `assembled_pl.ebitda` on an engine
   *  period (711 and 72x inside, 767 financial). null = REFUSED: the stock
   *  variation could not be measured, and `ebitdaRefusal` says why. */
  ebitda: number | null;
  /** Why `ebitda` (and EBIT, profit before tax, the net result built from
   *  the accounts) is null. */
  ebitdaRefusal?: ServedRefusal | null;
  /** The operating result (EBIT) — served, or null with the refusal. */
  ebit: number | null;
  netFinancialResult: number;
  /** Profit before tax on the one definition — served, or null. */
  profitBeforeTax: number | null;
  tax: number;
  /** The net result the statement's closing line states: account 121 (as
   *  filed) where the trial balance anchors it, else the result built from
   *  the accounts. null when that build is refused and no anchor exists. */
  netProfit: number | null;
  /** `assembled_pl.net_income_statutory` as served (account 121 when
   *  anchored). Absent on a payload the engine did not assemble. */
  netProfitStatutory?: number | null;
  /** Net 72x — own work capitalised — inside EBITDA, outside turnover. */
  capitalizedOwnWorkMemo?: number;
  /** Account 231 closing — for the CIP reconciliation. */
  cipUnderDevelopment?: number;
  /** Period month name ("December", etc.). */
  periodMonth?: string;
  /** The served one-EBITDA reading (bridge, provenance, notes) the view
   *  prints under the EBITDA line. null on a payload the engine did not
   *  assemble — the fictional demo, a public-company adapter. */
  served?: ServedOneEbitda | null;
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
