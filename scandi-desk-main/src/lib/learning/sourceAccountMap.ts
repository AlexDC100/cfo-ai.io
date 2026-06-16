// F5.0 Phase 1.6 — Static RAS source-account map per concept.
//
// Leaf concepts (Revenue, COGS, D&A, Cash, PP&E, etc.) bottom out at
// source accounts in the Romanian trial balance. The backend canonical
// envelope DOES carry per-period amounts but doesn't yet expose them
// keyed by concept; until that ships, this static table gives the
// popover a useful fallback — the typical RAS accounts behind each
// concept, with bilingual labels.
//
// When the popover renders a leaf concept, it merges:
//   · backend-supplied accountTraces (preferred — real amounts)
//   · this static map (always — codes + labels for deep linking)
//
// Each entry is a deep link via /financials?account=XXX (the highlight
// hook in useHighlightFromUrl picks up the param and scrolls the BS/PL
// table to that row).
//
// Phase 5 expansion: the backend's `assembled_canonical_v1` envelope
// will carry per-bucket account arrays, populating `accountTraces` at
// runtime so amounts show real figures. Until then this is the safety
// net so every leaf tap takes the user somewhere useful.

import type { AccountTrace } from "./concepts/_schema";
import type { PeriodLineItem } from "@/lib/activePeriod";

type StaticAccountEntry = Omit<AccountTrace, "amount"> & { defaultAmount?: number };

export const STATIC_SOURCE_ACCOUNTS: Readonly<Record<string, StaticAccountEntry[]>> = {
  // ── P&L revenue ────────────────────────────────────────────────
  revenue: [
    { code: "701", label: "Sales of finished products", side: "C" },
    { code: "704", label: "Services rendered", side: "C" },
    { code: "706", label: "Rental & royalty income", side: "C" },
    { code: "707", label: "Sales of merchandise", side: "C" },
    { code: "708", label: "Activity revenue / supplier discounts", side: "C" },
    { code: "709", label: "Commercial reductions (contra)", side: "C" },
  ],
  operating_revenue: [
    // LEARN-FIX-1B (2026-06-13) — 711 (Production variation) is a memo
    // movement, NOT a top-line revenue contributor. The engine's
    // `total_operating_revenue` excludes 711's gross movement (its net
    // effect feeds inventory, not turnover). Keeping 711 here made the
    // composition sum ~1.05B for Scandia when the header says 413.7M.
    // Drop it — same prefixes as `revenue` plus the 708/758 memo items
    // that DO net positively into total_operating_revenue.
    //
    // LEARN-FIX-1B-cont (2026-06-14) — ADD 722 (Capitalized own work).
    // The engine's `totalOperatingRevenue` is built as
    //   revenue + capitalizedOwnWorkMemo
    // (see FinancialStatements.tsx:1036 — the Operating revenue KPI
    // tile's sub-text reads `incl. 722 CIP <Money>`). Without 722 in the
    // composition, the bars summed to revenue-only on every
    // 722-bearing fixture (Scandia's CIP is ~2.16M of a 4.91M header)
    // and the bars all rendered as a misleading "100% on 706" — a
    // direct contradiction with the header. Add 722 so the bars reconcile.
    { code: "701", label: "Sales of finished products", side: "C" },
    { code: "704", label: "Services rendered", side: "C" },
    { code: "706", label: "Rental & royalty income", side: "C" },
    { code: "707", label: "Sales of merchandise", side: "C" },
    { code: "708", label: "Activity revenue / supplier discounts", side: "C" },
    { code: "709", label: "Commercial reductions (contra)", side: "C" },
    { code: "722", label: "Capitalized own work (CIP)", side: "C" },
    { code: "758", label: "Other operating revenue", side: "C" },
  ],

  // ── P&L expenses ───────────────────────────────────────────────
  cogs: [
    { code: "601", label: "Raw materials", side: "D" },
    { code: "602", label: "Auxiliary materials / consumables", side: "D" },
    { code: "607", label: "Cost of merchandise sold", side: "D" },
  ],
  operating_expenses: [
    { code: "61", label: "Maintenance, rent, insurance", side: "D" },
    { code: "62", label: "External services (logistics, marketing, consulting)", side: "D" },
    { code: "63", label: "Other taxes & levies", side: "D" },
    { code: "64", label: "Personnel (salaries + social)", side: "D" },
    { code: "65", label: "Other operating expenses", side: "D" },
    { code: "605", label: "Utilities (electricity, gas, water)", side: "D" },
  ],
  depreciation_amortization: [
    { code: "681", label: "Depreciation & amortization (operating)", side: "D" },
  ],
  interest_expense: [
    { code: "666", label: "Interest expense", side: "D" },
  ],
  income_tax: [
    { code: "691", label: "Income tax expense", side: "D" },
    { code: "698", label: "Other tax provisions", side: "D" },
  ],
  net_financial_result: [
    { code: "761", label: "Income from affiliates / dividends", side: "C" },
    { code: "765", label: "FX gains", side: "C" },
    { code: "766", label: "Interest income", side: "C" },
    { code: "665", label: "FX losses", side: "D" },
    { code: "666", label: "Interest expense", side: "D" },
  ],

  // ── BS assets ──────────────────────────────────────────────────
  cash: [
    { code: "5121", label: "Bank accounts in RON", side: "D" },
    { code: "5124", label: "Bank accounts in FX", side: "D" },
    { code: "531", label: "Petty cash", side: "D" },
    { code: "541", label: "Other cash", side: "D" },
  ],
  inventory: [
    { code: "301", label: "Raw materials in stock", side: "D" },
    { code: "302", label: "Auxiliary materials / consumables", side: "D" },
    { code: "345", label: "Finished products", side: "D" },
    { code: "371", label: "Merchandise (for resale)", side: "D" },
    { code: "39", label: "Inventory provisions (contra)", side: "C" },
  ],
  receivables: [
    { code: "411", label: "Trade receivables", side: "D" },
    { code: "413", label: "Notes receivable", side: "D" },
    { code: "409", label: "Supplier advances", side: "D" },
    { code: "49", label: "Receivables provisions (contra)", side: "C" },
  ],
  ppe: [
    { code: "211", label: "Land & site improvements", side: "D" },
    { code: "212", label: "Buildings", side: "D" },
    { code: "213", label: "Equipment (technological, transport)", side: "D" },
    { code: "214", label: "Furniture & office", side: "D" },
    { code: "281", label: "Accumulated depreciation (contra)", side: "C" },
  ],
  non_current_assets: [
    { code: "205", label: "Intangibles — licenses & software", side: "D" },
    { code: "211", label: "Land", side: "D" },
    { code: "212", label: "Buildings", side: "D" },
    { code: "213", label: "Equipment", side: "D" },
    { code: "23", label: "Construction in progress (CIP)", side: "D" },
    { code: "261", label: "Affiliates", side: "D" },
    { code: "263", label: "Other equity interests", side: "D" },
  ],
  current_assets: [
    { code: "3", label: "Inventory (class 3)", side: "D" },
    { code: "411", label: "Trade receivables", side: "D" },
    { code: "5121", label: "Bank accounts (cash)", side: "D" },
    { code: "44", label: "VAT & tax receivables", side: "D" },
  ],
  total_assets: [
    { code: "1–5", label: "All asset classes (intangibles → cash)", side: "D" },
  ],

  // ── BS liabilities & equity ────────────────────────────────────
  accounts_payable: [
    { code: "401", label: "Trade payables (domestic)", side: "C" },
    { code: "403", label: "Notes payable", side: "C" },
    { code: "404", label: "Fixed-asset payables", side: "C" },
    { code: "408", label: "Invoices not received", side: "C" },
  ],
  short_term_debt: [
    { code: "519", label: "Short-term bank loans / revolvers", side: "C" },
    { code: "168", label: "Accrued interest on debt", side: "C" },
  ],
  long_term_debt: [
    { code: "162", label: "LT bank loans", side: "C" },
    { code: "167", label: "Leasing obligations", side: "C" },
  ],
  total_debt: [
    { code: "519", label: "Short-term bank loans", side: "C" },
    { code: "162", label: "LT bank loans", side: "C" },
    { code: "167", label: "Leasing obligations", side: "C" },
  ],
  current_liabilities: [
    { code: "401", label: "Trade payables", side: "C" },
    { code: "519", label: "Short-term bank loans", side: "C" },
    { code: "44", label: "Tax payables", side: "C" },
    { code: "43", label: "Social security payables", side: "C" },
    { code: "42", label: "Personnel payables", side: "C" },
    { code: "457", label: "Dividends declared", side: "C" },
  ],
  share_capital: [
    { code: "1012", label: "Paid-in share capital", side: "C" },
    { code: "104", label: "Share premium / merger premium", side: "C" },
  ],
  retained_earnings: [
    { code: "117", label: "Retained earnings (cumulative)", side: "C" },
    { code: "1061", label: "Legal reserves", side: "C" },
    { code: "1068", label: "Other reserves", side: "C" },
  ],
  shareholders_equity: [
    { code: "1012", label: "Share capital", side: "C" },
    { code: "104", label: "Share premium", side: "C" },
    { code: "117", label: "Retained earnings", side: "C" },
    { code: "121", label: "Current-year profit", side: "C" },
  ],
  total_equity_liab: [
    { code: "1–4", label: "All equity + liability classes", side: "C" },
  ],

  // ── CF lines ───────────────────────────────────────────────────
  capex: [
    { code: "211–214", label: "Gross PP&E movements", side: "D" },
    { code: "23", label: "Construction in progress additions", side: "D" },
  ],
  lt_debt_drawdowns: [
    { code: "162", label: "LT bank loan credit movements (drawdowns)", side: "C" },
  ],
  lt_debt_repayments: [
    { code: "162", label: "LT bank loan debit movements (repayments)", side: "D" },
  ],
  dividends_paid: [
    { code: "457", label: "Dividends payable (457 debit movements = paid)", side: "D" },
  ],
  net_profit: [
    { code: "121", label: "Profit & loss account (closing C balance)", side: "C" },
  ],
};

/** Resolve a concept key to its static account list. Returns empty array
 *  when no entries exist. Phase 5 will combine with backend-supplied
 *  per-period amounts. */
export function staticSourceAccounts(conceptKey: string): AccountTrace[] {
  const entries = STATIC_SOURCE_ACCOUNTS[conceptKey];
  if (!entries) return [];
  return entries.map((e) => ({
    code: e.code,
    label: e.label,
    amount: e.defaultAmount ?? 0,
    side: e.side,
  }));
}

// ─────────────────────────────────────────────────────────────────────
// LEARN-FIX-1 (2026-06-08) — Real per-account amounts.
//
// `staticSourceAccounts()` above only ships codes + labels (the
// `defaultAmount` slot is unused — every entry returns 0). The engine
// HAS the real amounts on `period.lineItems` (already RON-resolved per
// account class — class 6 expenses use rulaj_debitor, class 7 revenue
// uses rulaj_creditor, BS uses sold_final, etc.; the FE never sees the
// raw fields). The popover bug was that the FE only ever asked the
// static map for the amount and the static map said zero.
//
// This helper joins the static codes/labels with the engine-resolved
// amounts via `ro_account_code` prefix matching — same prefix-match
// pattern `_ro_coa.py` uses on the engine side. Filters zero/near-zero
// amounts (don't render `706 Rental income — 0 RON` when Scandia has
// no rental this period) and sorts descending so the dominant
// contributor is at the top.
// ─────────────────────────────────────────────────────────────────────

/** Threshold below which an account is treated as "absent". Currency-
 *  agnostic — 0.01 of the source unit. */
const NEAR_ZERO_AMOUNT = 0.01;

/** Look up the real engine-emitted amount for an RAS account code by
 *  prefix-matching against `lineItems`. Sums all rows whose
 *  `ro_account_code` starts with the requested prefix — captures
 *  sub-account variants (701, 7011, 70181, etc.) under their parent.
 *  Returns 0 when no matching rows exist. */
function sumLineItemsByPrefix(
  lineItems: PeriodLineItem[],
  prefix: string,
): number {
  if (!lineItems || lineItems.length === 0) return 0;
  let total = 0;
  for (const li of lineItems) {
    if (li.ro_account_code && li.ro_account_code.startsWith(prefix)) {
      total += Number(li.amount) || 0;
    }
  }
  return total;
}

export interface ResolvedSourceAccount extends AccountTrace {
  /** Best-effort Romanian-locale name harvested from `ro_account_name`
   *  on the matching line item; falls back to the static English
   *  label when the engine didn't ship a Romanian name. */
  labelRo?: string;
  /** Pre-resolved sign-neutral magnitude — display layer can render
   *  this directly. */
  magnitude: number;
  /** Percentage share of the positive-amount cohort (0..1). Set by
   *  `resolveSourceAccountsForConcept`. */
  share?: number;
}

/** LEARN-FIX-1 — resolve a concept's source accounts to REAL engine
 *  amounts. Falls back to the static-only list (zero amounts) when
 *  `lineItems` is empty — same behaviour as before for non-hydrated
 *  surfaces, but real numbers when the period is loaded.
 *
 *  Filtering rules:
 *    · Hide accounts whose engine amount is within `NEAR_ZERO_AMOUNT`
 *      of zero — a P&L account with no activity this period
 *      shouldn't render as "0 RON" (implies popover is broken).
 *    · Sort descending by magnitude — dominant contributor first.
 *    · Compute `share` after filtering so percentages add to 100%.
 *
 *  Caller is responsible for the aggregate cross-check (see
 *  `assertConceptCompositionMatches` below).
 */
export function resolveSourceAccountsForConcept(
  conceptKey: string,
  lineItems: PeriodLineItem[],
): ResolvedSourceAccount[] {
  const entries = STATIC_SOURCE_ACCOUNTS[conceptKey];
  if (!entries) return [];

  // No line items → return the static skeleton with zero amounts.
  // Old behaviour, kept so non-hydrated surfaces (landing page
  // previews, signed-out demos) don't crash.
  if (!lineItems || lineItems.length === 0) {
    return entries.map((e) => ({
      code: e.code,
      label: e.label,
      amount: 0,
      magnitude: 0,
      side: e.side,
    }));
  }

  const resolved: ResolvedSourceAccount[] = entries.map((e) => {
    const amount = sumLineItemsByPrefix(lineItems, e.code);
    // Try to grab the engine's Romanian name from the first matching
    // line item so the UI can localise.
    const sample = lineItems.find(
      (li) => li.ro_account_code && li.ro_account_code.startsWith(e.code),
    );
    return {
      code: e.code,
      label: e.label,
      labelRo: sample?.ro_account_name,
      amount,
      magnitude: Math.abs(amount),
      side: e.side,
    };
  });

  const populated = resolved.filter((a) => a.magnitude > NEAR_ZERO_AMOUNT);
  populated.sort((a, b) => b.magnitude - a.magnitude);

  // Compute share against the positive cohort (negatives — contra-
  // revenue or contra-asset accounts — get share against the same
  // base so the visualization stays comparable across signs).
  const totalMagnitude = populated.reduce((s, a) => s + a.magnitude, 0);
  if (totalMagnitude > 0) {
    populated.forEach((a) => {
      a.share = a.magnitude / totalMagnitude;
    });
  }

  return populated;
}

/** LEARN-FIX-1 — DEV-only sanity gate. Compares the aggregate value
 *  the popover shows in its header (`aggregate`) against the sum of
 *  the per-account amounts resolved for the same concept. Catches the
 *  exact regression class this fix addresses: aggregate from a
 *  different code path returning a real number while per-account
 *  composition silently returns 0. Fires `console.error` on mismatch
 *  > 1 RON; silent on production builds. */
export function assertConceptCompositionMatches(
  conceptKey: string,
  aggregate: number,
  accounts: ResolvedSourceAccount[],
): void {
  if (!import.meta.env.DEV) return;
  if (!accounts || accounts.length === 0) return;
  // Honour sign: contra accounts on the credit side reduce the total
  // when the concept itself is debit-side, and vice versa. We compare
  // magnitudes — the popover headline is the absolute value.
  const sum = accounts.reduce((s, a) => s + Math.abs(a.amount), 0);
  const drift = Math.abs(Math.abs(aggregate) - sum);
  if (drift > 1 && drift / Math.max(Math.abs(aggregate), 1) > 0.02) {
    // eslint-disable-next-line no-console
    console.error(
      `[learning] Composition mismatch for "${conceptKey}": ` +
        `aggregate ${aggregate.toFixed(2)} vs Σ accounts ${sum.toFixed(2)} (drift ${drift.toFixed(2)})`,
      { accounts },
    );
  }
}
