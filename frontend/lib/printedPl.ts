// THE PRINTED P&L — one row model for the two deliverables a reader
// forwards: the standalone HTML report (`renderReportHtml`) and the Excel
// workbook's "P&L" sheet (`buildExcelWorkbook`).
//
// OWNER RULING (2026-09-26). Account 711 ("Variația stocurilor de
// produse") is inside EBITDA and the operating result, with its sign,
// printed next to cost of sales; 72x (own work capitalised) is operating,
// inside EBITDA, outside turnover. Turnover is net turnover (70x − 709).
// The reconciliation line is shown.
//
// OWNER RULINGS (2026-09-28). R2: the provision charges (6812, 6814) and
// their reversals (7812, 7814) are OUTSIDE EBITDA; their net is its own
// row between D&A and EBIT, under the engine's name. R3: net turnover
// holds 7411 (operating subsidies related to turnover, F20 rd. 05) — the
// row's accounts are the engine's.
//
// Before this module the two deliverables each assembled their own column
// from the `incomeStatement` buckets — neither of which carries the
// measured net 711 or net 72x — and printed the ENGINE's EBITDA under a
// column whose lines summed to the pre-ruling figure: agras "EBITDA
// 11,848,065" beneath lines summing to 10,776,378, the workbook printing
// 10,776,378 as EBITDA beside it (threeWayParity, exportPlFoots). Here the
// rows are the SERVED figures of the one definition, in the statutory
// order, and every subtotal is the sum of the rows above it:
//
//   Net turnover (70x − 709)
//   − Cost of goods sold
//   ± Variația stocurilor de produse (711)     ← next to cost of sales
//   = Gross profit
//   − Operating expenses
//   + Other operating income
//   + Own work capitalised (72x)               ← operating, outside turnover
//   = EBITDA
//   − Depreciation & amortization
//   ± Net provisions (6812 + 6814 − 7812 − 7814)   ← outside EBITDA (R2)
//   = EBIT (operating result)
//   + Financial income − interest − other financial expense
//   = Profit before tax
//   − Tax expense
//   [= Net result built from the accounts, ± not explained by the accounts]
//   = Net income (account 121, as filed)
//
// A figure the engine REFUSED (the stock variation could not be measured)
// is a row with `value: null` and its typed reason — never a zero and
// never a figure rebuilt on another definition. The words are English:
// both deliverables are English by contract (CLAUDE.md §11 keeps the
// Romanian account name, glossed).

import type { Statements } from "./financialReport";
import {
  componentShown,
  plLevelsOf,
  readRefusal,
  readServedOneEbitda,
  reconLine,
  type ServedComponent,
  type ServedRefusal,
} from "./servedOneEbitda";

export type PrintedPlKind = "step" | "subtotal" | "total";

export interface PrintedPlRow {
  /** Stable concept id (threeWayParity pairs the formats on it). */
  readonly key: string;
  /** The English label both deliverables print. */
  readonly label: string;
  /** Signed as its effect on the result; null = refused / not anchored. */
  readonly value: number | null;
  readonly kind: PrintedPlKind;
  /** Why `value` is null. */
  readonly refusal: ServedRefusal | null;
  /** The engine's provenance sentence for a measured line (711 / 72x). */
  readonly note: string | null;
}

export interface PrintedPl {
  readonly rows: readonly PrintedPlRow[];
  /** "EBITDA before stock variation and own work capitalised X · … = EBITDA W"
   *  — the served one-line bridge, English, or null when not served. */
  readonly bridge: string | null;
  /** The same bridge as rows (label EN, signed value or null = refused). */
  readonly bridgeParts: ReadonlyArray<{ key: string; label: string; value: number | null }>;
  /** "On a closed trial balance the 711 line is derived from account 121 …" */
  readonly identityNote: string | null;
  /** "The split between 711 and 72x assumes 722 has no debit postings." */
  readonly splitAssumption: string | null;
  /** The engine's refusal of EBITDA, when it refused it. */
  readonly ebitdaRefusal: ServedRefusal | null;
  /** Account 121 − the result built from the accounts, when non-zero. */
  readonly notExplained: number | null;
  /** Account 121 as filed; null when the period is not anchored. */
  readonly netIncomeFiled: number | null;
  /** pretax − tax: the result built from the accounts. */
  readonly netResultBuilt: number | null;
}

/** The label of the account-121 row; shared so no format renames it alone. */
export const NET_INCOME_FILED_LABEL = "Net Income (account 121, as filed)";
export const NOT_EXPLAINED_LABEL =
  "± Not explained by the revenue and expense accounts (account 121 − the result built from them)";
export const NET_RESULT_BUILT_LABEL = "Net result — built from the accounts";

const HALF_CENT = 0.005;

type Rec = Record<string, unknown>;
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** The Romanian name the owner ruled, verbatim, with its accounts — the
 *  row label. The English gloss travels in the row's note (CLAUDE.md §11:
 *  the Romanian account name stays; the English explains it). */
function componentLabel(c: ServedComponent | null, fallbackRo: string, accounts: string): string {
  return `${c?.nameRo ?? fallbackRo} (${c?.accounts ?? accounts})`;
}

/** The note under a measured row: the English gloss, then the engine's
 *  provenance sentence. */
function componentNote(c: ServedComponent | null, fallbackEn: string): string {
  const gloss = c?.glossEn ?? fallbackEn;
  const prov = c?.provenanceLabel?.en ?? null;
  return prov ? `${gloss} — ${prov}` : gloss;
}

const money = (n: number): string =>
  `${n < 0 ? "−" : ""}${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/**
 * The printed P&L of a payload. On a period the engine assembled every
 * subtotal is its served figure; on a payload it did not (the demo, a
 * public-company adapter) the same rows are built from the buckets on the
 * same definition (`plLevelsOf`).
 */
export function printedPl(s: Statements): PrintedPl {
  const is = s.incomeStatement;
  const apl = (s.assembled_pl ?? null) as Rec | null;
  const served = readServedOneEbitda(apl);
  const levels = plLevelsOf(s);
  const recon = served?.reconciliation ?? null;
  const sv = (k: string): number | null => (apl ? finite(apl[k]) : null);
  const bucket = (v: number | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  const cogs = sv("cogs") ?? bucket(is.costOfGoodsSold);
  const opex = sv("opex_total") ?? sv("opex_excluding_cogs_and_da") ?? bucket(is.operatingExpenses);
  const otherIncome = sv("other_operating_income") ?? bucket(is.otherIncome);
  const dna = sv("depreciation") ?? bucket(is.depreciationAmortization);
  const finIncome = sv("financial_income") ?? bucket(is.financialIncome);
  const interest = sv("interest_expense") ?? bucket(is.interestExpense);
  const finOther =
    sv("financial_expense") ??
    (sv("financial_expense_total") !== null ? (sv("financial_expense_total") as number) - interest : null) ??
    bucket(is.financialExpense);
  const tax = sv("tax") ?? bucket(is.taxExpense);
  const refusal = levels.refusal;

  const rows: PrintedPlRow[] = [];
  const push = (
    key: string,
    label: string,
    value: number | null,
    kind: PrintedPlKind,
    rowRefusal: ServedRefusal | null = null,
    note: string | null = null,
  ) => rows.push({ key, label, value, kind, refusal: value === null ? rowRefusal : null, note });

  // The turnover row's accounts are the engine's (70x − 709 + 7411 since
  // R3); a payload the engine did not assemble keeps the bucket's own.
  const turnoverAccounts = reconLine(recon, "turnover")?.accounts ?? "70x − 709";
  push("turnover", `Net turnover (${turnoverAccounts})`, levels.turnover, "step");
  push("cogs", "Cost of goods sold", -cogs, "step");

  // ── 711, beside cost of sales ─────────────────────────────────────────
  const inv = served?.inventoryVariation ?? null;
  const invShown = served ? componentShown(inv) : false;
  if (invShown && inv) {
    push(
      "inventory_variation",
      componentLabel(inv, "Variația stocurilor de produse", "711"),
      inv.value,
      "step",
      inv.refusal,
      componentNote(inv, "change in inventories of finished goods and WIP"),
    );
  } else if (!served && levels.refusal) {
    // A payload the engine did not assemble whose buckets show 711
    // activity it could not measure: the row states the refusal.
    push(
      "inventory_variation",
      "Variația stocurilor de produse (711)",
      null,
      "step",
      levels.refusal,
      "change in inventories of finished goods and WIP — not measured for this data",
    );
  }
  push("gross_profit", "Gross Profit", levels.grossProfit, "subtotal", levels.grossProfitRefusal);

  push("opex", "Operating expenses", -opex, "step");
  push("other_operating_income", "Other income", otherIncome, "step");
  // ── 72x — operating, outside turnover ─────────────────────────────────
  const cow = served?.capitalizedOwnWork ?? null;
  if (served ? componentShown(cow) : Math.abs(levels.capitalizedOwnWork ?? 0) >= HALF_CENT) {
    push(
      "capitalized_own_work",
      componentLabel(cow, "Producția realizată pentru scopuri proprii și capitalizată", "72x"),
      served ? cow?.value ?? null : levels.capitalizedOwnWork,
      "step",
      cow?.refusal ?? null,
      componentNote(cow, "own work capitalised"),
    );
  }
  push("ebitda", "EBITDA", levels.ebitda, "subtotal", refusal);
  push("da", "Depreciation & amortization", -dna, "step");
  // R2: net provisions, outside EBITDA — the engine's name and accounts,
  // signed as its effect on the result. Absent on a payload the engine did
  // not assemble under the ruling (its D&A still holds the charges).
  const np = served?.netProvisions ?? null;
  if (np && (Math.abs(np.charges) >= HALF_CENT || Math.abs(np.reversals) >= HALF_CENT)) {
    push("net_provisions", np.label.en, 0 - np.value, "step");
  }
  push("ebit", "EBIT", levels.ebit, "subtotal", levels.ebitRefusal);
  push("financial_income", "Financial income", finIncome, "step");
  push("interest_expense", "Interest expense", -interest, "step");
  push("other_financial_expense", "Other financial expense", -finOther, "step");
  push("pretax", "Profit Before Tax", levels.pbt, "subtotal", levels.pbtRefusal);
  push("tax", "Tax expense", -tax, "step");

  // ── the bridge to account 121 ─────────────────────────────────────────
  // Account 121 as filed when the period is anchored; the gap to the
  // result built from the accounts is the served "not explained" line —
  // printed with its amount, never folded into 711.
  const anchorStatus = apl ? (typeof apl.net_income_anchor_status === "string" ? apl.net_income_anchor_status : null) : null;
  const line121 = reconLine(recon, "account_121");
  const filedServed = sv("net_income_statutory");
  const anchored = apl
    ? (line121 ? line121.status === "anchored" : anchorStatus === "anchored" || anchorStatus === null) && filedServed !== null
    : false;
  const netResultBuilt = levels.netIncome;
  const netIncomeFiled = apl ? (anchored ? filedServed : null) : levels.netIncome;
  const notExplainedServed =
    finite(reconLine(recon, "not_explained")?.value) ?? sv("net_income_unexplained_vs_121");
  const notExplained =
    anchored && netIncomeFiled !== null && netResultBuilt !== null
      ? notExplainedServed ?? netIncomeFiled - netResultBuilt
      : null;
  const hasGap = notExplained !== null && Math.abs(notExplained) > HALF_CENT;
  if (hasGap) {
    push("net_result_built", NET_RESULT_BUILT_LABEL, netResultBuilt, "subtotal", refusal);
    push("not_explained", NOT_EXPLAINED_LABEL, notExplained, "step");
  }
  const notAnchored: ServedRefusal = {
    code: "account_121_not_anchored",
    text: {
      ro: "contul 121 nu este ancorat pentru această perioadă",
      en: "account 121 is not anchored for this period",
    },
  };
  // A net result the engine REFUSED carries ITS reason (the stock
  // variation, no account 121), not the generic "not anchored".
  const netRefusal = readRefusal(apl ? apl.net_income_refusal : null);
  push("net_income", NET_INCOME_FILED_LABEL, netIncomeFiled, "total", netRefusal ?? notAnchored);

  // ── the one-line bridge and the notes ─────────────────────────────────
  const parts = recon?.bridge.parts ?? [];
  // After EBITDA, outside it (R2): net provisions, the engine's label saying
  // so — the parts above still sum to EBITDA.
  const after = recon?.bridge.afterEbitda ?? [];
  const bridge =
    parts.length > 0
      ? [
          ...parts.map((p, i) => {
            const v = p.value === null ? "refused" : money(p.value);
            const lead = i === 0 ? "" : i === parts.length - 1 ? "= " : p.value !== null && p.value >= 0 ? "+ " : "";
            return `${lead}${p.label.en} ${v}`;
          }),
          ...after.map((p) => {
            const v = p.value === null ? "refused" : money(p.value);
            return `${p.value !== null && p.value >= 0 ? "+ " : ""}${p.label.en} ${v}`;
          }),
        ].join(" · ")
      : null;
  return {
    rows,
    bridge,
    bridgeParts: parts.map((p) => ({ key: p.key, label: p.label.en, value: p.value })),
    identityNote: recon?.identityNote?.en ?? inv?.identityNote?.en ?? null,
    splitAssumption: recon?.splitAssumption?.en ?? null,
    ebitdaRefusal: refusal,
    notExplained: hasGap ? notExplained : null,
    netIncomeFiled,
    netResultBuilt,
  };
}

/** The printed row by concept id. */
export function printedRow(p: PrintedPl, key: string): PrintedPlRow | null {
  return p.rows.find((r) => r.key === key) ?? null;
}
