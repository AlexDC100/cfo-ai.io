// Build a structured P&L statement for the P&L tab — from the engine's
// SERVED figures, never a second opinion about them.
//
// THE ONE EBITDA (owner ruling 2026-09-26). Account 711 — "Variația
// stocurilor de produse" — sits INSIDE EBITDA and the operating result, with
// its sign, next to cost of sales: never as revenue, never inside cifra de
// afaceri. 72x (own work capitalised) the same way: operating, inside EBITDA,
// outside turnover. 767 (discounts received) is FINANCIAL. Margins divide by
// net turnover (70x − 709).
//
// On an engine period (a payload carrying `statements.assembled_pl`) every
// subtotal this file states — net turnover, EBITDA, EBIT, profit before tax,
// the net result — is the engine's served figure, read through
// lib/servedOneEbitda.ts. A refused figure is `null` with the engine's typed
// reason beside it: never 0, never a figure rebuilt here from other lines,
// never another definition. The rows between the subtotals are the served
// lines (aggregates) or the period's own leaves (line items); where the
// leaves do not reach a served total, the difference is a LABELLED row, so
// every section still adds up to the engine's figure.
//
// A payload the engine did not assemble (the fictional demo company) has no
// served figures; its statement is built from the payload's own income
// statement on the SAME definition, and refuses EBITDA if the payload says
// it has 711 activity it could not measure.
//
// Both builders place: NET TURNOVER → OTHER OPERATING INCOME → own work
// capitalised (72x) → OPERATING EXPENSES → the stock variation (711) → EBITDA
// (with the engine's reconciliation line under it) → D&A → NET PROVISIONS
// (owner ruling R2, 2026-09-28: 6812 + 6814 − 7812 − 7814, outside EBITDA,
// served) → EBIT → FINANCIAL ITEMS → profit before tax → tax → the net
// result, ending on account 121 where the trial balance carries it. Net
// turnover holds 7411 (R3): the engine places its leaves in the turnover
// bucket, so the family rows list it there.

import {
  ApiLineItem,
  PLLine,
  PLSection,
  PLStatement,
  PLKeyMargin,
  RoName,
  sumByExact,
  sumByPrefix,
} from "./plStructure";
import type { IncomeStatement, Statements } from "./financialReport";
import { marginRefusalOf } from "./marginMeaning";
import {
  STOCK_VARIATION_NOT_MEASURED,
  componentShown,
  readServedOneEbitda,
  reconLine,
  type Bilingual,
  type ServedComponent,
  type ServedOneEbitda,
  type ServedRefusal,
} from "./servedOneEbitda";


/** Drop nulls from a sparse line list, WITHOUT losing PLLine's literal types.
 *
 *  `const x: PLLine[] = [ … ].filter((l): l is PLLine => l !== null)` looks
 *  equivalent and is not: the annotation types the FILTER RESULT, never the
 *  array literal. With no contextual type the literal's `style: "item"`
 *  widens from `LineStyle` to `string`, the element type stops being a
 *  PLLine, and the predicate is then rejected outright (TS2677 — "a type
 *  predicate's type must be assignable to its parameter's type").
 *
 *  Passing the literal as an ARGUMENT restores contextual typing, so
 *  `style`, `sign` and `bucket` are checked against their unions again
 *  instead of being accepted as any string. That matters here: `style`
 *  picks a row's visual weight (an item silently typed as a subtotal reads
 *  as a total) and `sign` drives the ± prefix on a money amount. No cast —
 *  every field is still checked. */
function plLines(lines: Array<PLLine | null | undefined>): PLLine[] {
  return lines.filter((l): l is PLLine => l != null);
}

interface BuildArgs {
  /** Per-account line items from the backend (statement="PL" entries only). */
  lineItems: ApiLineItem[];
  /** Entity name + period label for the header. */
  entity: string;
  period: string;
  /** ISO period_end ("2025-12-31") — used for the month name. */
  periodEnd?: string;
  /** Currency code (defaults RON). */
  currency?: string;
  /**
   * F1.e — Optional engine-canonical margin pair (`calculated_metrics.
   * ebitda_margin` / `net_margin`, both over net turnover). A margin the
   * row does not carry falls back, per margin, to the served figure over
   * served turnover — and refuses when EBITDA is refused.
   */
  canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null };
  /** The period's SERVED `statements.assembled_pl` block — the one source of
   *  every subtotal on an engine period (see the file header). Absent: the
   *  payload is not an engine period and the statement is built from the
   *  leaves on the same definition. */
  servedPl?: unknown;
}

// Account-to-label table used to render the per-line labels next to the
// account code on the line-item view. These are English labels.
const ACCOUNT_LABELS: Record<string, string> = {
  // Net turnover (70x − 709 + 7411 — owner ruling R3, 2026-09-28: the
  // operating subsidies related to turnover sit inside it, F20 rd. 05)
  "701": "Sales of finished goods",
  "702": "Sales of semi-finished goods",
  "703": "Sales of residual products",
  "704": "Service revenue",
  "705": "Studies & research",
  "706": "Rental & lease income",
  "707": "Goods resold",
  "708": "Other activity revenue",
  "709": "Commercial discounts granted",
  // Other operating income
  "741": "Operating subsidies",
  "758": "Other operating income (758)",
  "781": "Provision reversals",
  // Operating expenses
  "6024": "Spare parts",
  "6051": "Energy",
  "605":  "Utilities",
  "611":  "Maintenance & repairs",
  "6123": "Rent",
  "612":  "Rent",
  "613":  "Insurance premiums",
  "622":  "Commissions & fees",
  "626":  "Postal & telecom",
  "627":  "Bank charges",
  "628":  "Other third-party services",
  "635":  "Other taxes & duties",
  "641":  "Salaries",
  "645":  "Social contributions",
  "6458": "Other social contributions",
  "6461": "Employer work insurance contrib.",
  // D&A
  "6811": "Depreciation & amortization",
  "6812": "Provisions for operations",
  // Financial items
  "7611": "Dividend income from affiliates",
  "7612": "Dividend income from associates",
  "762":  "Income from participations",
  "763":  "Income from long-term receivables",
  "7651": "FX gains",
  "766":  "Interest income",
  "767":  "Discounts received (767)",
  "6651": "FX losses",
  "666":  "Interest expense",
  // Tax
  "691":  "Income tax",
};

function labelFor(code: string): string {
  return ACCOUNT_LABELS[code] ?? code;
}

function periodMonthName(isoDate?: string): string {
  if (!isoDate) return "the period";
  const m = isoDate.match(/^\d{4}-(\d{2})/);
  if (!m) return "the period";
  const months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  const idx = parseInt(m[1], 10) - 1;
  return idx >= 0 && idx < 12 ? months[idx] : "the period";
}

/** ONE EBITDA, AND IT IS THE ENGINE'S.
 *
 *  `assembled_pl.ebitda` is the figure every surface reads — the forecast's
 *  `PlHistory`, the ratios, the credit composite, the valuation. Since the
 *  owner's ruling of 2026-09-26 it is
 *
 *     net turnover + other operating income + net 72x
 *       − cost of sales − operating expenses + net 711
 *
 *  with 767 financial. This file used to derive its own EBITDA (first from
 *  `total_operating_revenue`, then from the leaves), and the P&L tab and the
 *  forecast stated two EBITDAs for one period — 27% apart on Scandia, of
 *  opposite sign on retail. It now prints the served figure, and a refused
 *  one as refused. The derivation survives only for a payload the engine did
 *  not assemble, on the same formula.
 *
 *  What the definition includes is stated here, not left to the reader. */
export const EBITDA_COMPOSITION_NOTE =
  "includes other operating income (758), own work capitalised (72x) and the stock variation (711); 767 is financial";

/** The exact account codes the LINE-ITEM P&L view knows how to place.
 *
 *  It is an EXACT-match table (`sumByExact`), so it silently omits any
 *  account it does not name. That is how a condensed 4-digit balanță came
 *  to serve three expense lines out of seventy: of its class-6 accounts
 *  only 6024, 6051 and 6458 appear below. Nothing may route to the
 *  line-item view without first measuring how much of the engine's
 *  assembled operating expense this list actually reaches. */
export const OPEX_CODES: readonly string[] = [
  "6024", "6051", "605", "603", "604", "607",
  "611", "6123", "612", "613",
  "622", "626", "627", "628",
  "635",
  "641", "645", "6458", "6461",
];

/** How much of the engine's operating expense the line-item view must
 *  reach before it may be used. Below this the aggregates are served —
 *  they are the engine's own totals. Measured: the condensed Scandia
 *  FY2024 book scores 0.014 (5,703,608.87 of 409,697,663.25); the analytic
 *  FY2025 book and every corpus book score at or near 1. */
export const OPEX_COVERAGE_FLOOR = 0.98;

/** THE routing decision: may the LINE-ITEM P&L view be used for this book?
 *
 *  ONE AUTHORITY, ON PURPOSE. `headlineProvenance.plBuiltFromLineItems`
 *  used to hold a SECOND COPY of this rule, and its own test existed to
 *  catch the two drifting apart. It caught it the moment the rule changed
 *  here — but two copies of one decision is the defect, and a test that
 *  watches them disagree is a smoke alarm, not a fix. Both callers now ask
 *  this function.
 *
 *  `statements` is required because coverage is measured against the
 *  engine's assembled operating expense: the line items alone cannot say
 *  whether the view they would produce is complete. */
export function plUsesLineItems(
  lineItems: readonly { statement?: string; ro_account_code?: string | null }[] | undefined,
  statements: unknown,
): boolean {
  const plItems = (lineItems ?? []).filter((li) => li?.statement === "PL");
  if (plItems.length === 0) return false;
  const assembledOpex = Math.abs(
    Number(
      (statements as { assembled_pl?: { total_operating_expense?: unknown } })
        ?.assembled_pl?.total_operating_expense ?? 0,
    ),
  );
  // Nothing to measure against — keep the pre-existing behaviour rather
  // than inventing a verdict from an absent total.
  if (!(assembledOpex > 0)) return true;
  const covered = Math.abs(
    OPEX_CODES.reduce(
      (sum, code) => sum + sumByExact(plItems as never, code),
      0,
    ),
  );
  return covered / assembledOpex >= OPEX_COVERAGE_FLOOR;
}

/** THE CODE CHIP OF THE AGGREGATES REVENUE ROW — read off the period's
 *  OWN leaves, never a hard-coded subset.
 *
 *  The row used to be labelled "Operating revenue (706/704/707 combined)"
 *  with account code "706" stamped on it, whatever the book held. On a
 *  manufacturer whose turnover is 99% account 701 that label named three
 *  families the row barely contained and left out the one it was made of;
 *  the "706" chip also fed the footnote's rental-dominance test, which then
 *  read every aggregates-path book as a landlord. The chip now lists the
 *  three-digit families the revenue bucket actually holds in this period
 *  ("701/704/706/707/709" on a goods seller, "706" on a landlord), and
 *  "70x" — the bucket, not a guess at its members — when no line items
 *  are available to read. Separators are stripped exactly as the engine's
 *  detail-level detector strips them, so "701.01" and "701" are one
 *  family. */
export function revenueFamiliesChip(
  items: readonly { statement?: string; bucket?: string; ro_account_code?: string | null }[] | undefined,
): string {
  const families = Object.keys(revenueFamilyAmounts(items));
  return families.length > 0 ? families.sort().join("/") : "70x";
}

/** REVENUE BY THREE-DIGIT ACCOUNT FAMILY, read off the period's OWN
 *  revenue-bucket leaves: "701" → sales of finished goods, "706" → rent
 *  and royalties, and so on. Separators are stripped exactly as the
 *  engine's detail-level detector strips them, so "706.01", "7061" and
 *  "706" are one family. Balance-sheet rows and rows outside the revenue
 *  bucket are ignored; a leaf without an amount still names its family
 *  (the chip lists it) at zero. The chip on the aggregates row and the
 *  line-item view's turnover rows both read this — one reading of the
 *  leaves, never a hard-coded code. */
export function revenueFamilyAmounts(
  items:
    | readonly { statement?: string; bucket?: string; ro_account_code?: string | null; amount?: number }[]
    | undefined,
): Record<string, number> {
  const families: Record<string, number> = {};
  for (const li of items ?? []) {
    if (li?.statement !== "PL" || li.bucket !== "revenue") continue;
    const digits = String(li.ro_account_code ?? "").replace(/[\s.\-/_]/g, "");
    if (!/^\d{3,}$/.test(digits)) continue;
    const family = digits.slice(0, 3);
    const amount = typeof li.amount === "number" && Number.isFinite(li.amount) ? li.amount : 0;
    families[family] = (families[family] ?? 0) + amount;
  }
  return families;
}

// ── The served figures both builders share ────────────────────────────

/** Half a cent: below it a money amount is a zero (the engine's floor). */
const HALF_CENT = 0.005;

/** Re-exported: the refusal lives with the one reader (servedOneEbitda). */
export { STOCK_VARIATION_NOT_MEASURED };

const EBIT_NOT_SERVED: ServedRefusal = {
  code: "operating_result_not_served",
  text: {
    ro: "motorul nu a servit rezultatul din exploatare pentru această perioadă",
    en: "the engine served no operating result for this period",
  },
};

const PRETAX_NOT_SERVED: ServedRefusal = {
  code: "pretax_not_served",
  text: {
    ro: "motorul nu a servit profitul înainte de impozit pentru această perioadă",
    en: "the engine served no profit before tax for this period",
  },
};

const NET_RESULT_NOT_SERVED: ServedRefusal = {
  code: "net_result_not_served",
  text: {
    ro: "motorul nu a servit rezultatul net pentru această perioadă",
    en: "the engine served no net result for this period",
  },
};

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A served reconciliation label as a Romanian name with its English gloss
 *  (no gloss when the two languages say the same word, e.g. "EBITDA"). */
function roNameOf(label: Bilingual | null | undefined): RoName | undefined {
  if (!label) return undefined;
  return { ro: label.ro, glossEn: label.en !== label.ro ? label.en : null };
}

/** The row for a served measured component (net 711 or net 72x): the
 *  engine's Romanian name and English gloss, its provenance sentence, and
 *  either its value or its refusal — never a zero standing in for one. */
function componentLine(c: ServedComponent, bucket: string): PLLine {
  const name = c.nameRo ?? c.accounts;
  const line: PLLine = {
    accountCode: c.accounts,
    label: c.glossEn ? `${name} — ${c.glossEn}` : name,
    roName: { ro: name, glossEn: c.glossEn },
    style: "item",
    bucket,
    ...(c.provenance ? { provenance: { key: c.provenance, label: c.provenanceLabel } } : {}),
  };
  if (c.value === null) return c.refusal ? { ...line, refusal: c.refusal } : line;
  return { ...line, amount: c.value };
}

/** "Variația stocurilor de produse" — signed as its effect on the result:
 *  + a stock increase (the period's production cost carried to the balance
 *  sheet), − a decrease. */
function stockVariationSection(served: ServedOneEbitda | null): PLSection | null {
  const c = served?.inventoryVariation;
  if (!componentShown(c)) return null;
  const line = componentLine(c, "inventoryVariation");
  const signed: PLLine =
    c.value === null
      ? line
      : {
          ...line,
          sign: c.value > 0 ? "positive" : "negative",
          stockDirection: c.value > 0 ? "increase" : "decrease",
        };
  return { role: "stockVariation", header: "", lines: [signed] };
}

/** NET PROVISIONS (owner ruling R2, 2026-09-28): the ruled charges (6812,
 *  6814) less the ruled reversals (7812, 7814), OUTSIDE EBITDA, printed
 *  between EBITDA and the operating result beside D&A — the engine's name,
 *  its accounts in the chip. The amount is the served figure as the engine
 *  signs it — a charge, like D&A beside it — and it PRINTS as D&A prints:
 *  no effect sign, no colour; a net charge unsigned, a net release with
 *  its minus ("6812 + 6814 − 7812 − 7814", as the label says). The row's
 *  prior and Δ cells (`pl.net_provisions` off the comparatives endpoint)
 *  are charge-signed too, so the three cells of the row read on ONE
 *  convention (deploy-readiness review, 2026-09-29: the current cell
 *  printed the effect sign — a net charge "−", a release "+" — beside a
 *  charge-signed prior and Δ, and the signs flipped within the row). Null
 *  on a payload the engine did not assemble under the ruling (its D&A
 *  still holds the charges, its EBITDA the reversals) and on a period that
 *  posted to none of the four accounts. */
export function netProvisionsLine(served: ServedOneEbitda | null): PLLine | null {
  const np = served?.netProvisions;
  if (!np) return null;
  if (Math.abs(np.charges) < HALF_CENT && Math.abs(np.reversals) < HALF_CENT) return null;
  return {
    accountCode: np.accounts,
    label: np.name.en,
    roName: roNameOf(np.name),
    amount: np.value,
    style: "item",
    bucket: "netProvisions",
  };
}

/** The D&A row's chip: the accounts the engine's reconciliation names for
 *  it ("68x excl. 6812, 6814" since R2), else the bucket. */
function depreciationChip(served: ServedOneEbitda | null, fallback: string): string {
  const l = reconLine(served?.reconciliation, "depreciation");
  return l?.accountsEn ?? l?.accounts ?? fallback;
}

/** Own work capitalised (72x): an operating line OUTSIDE turnover. On an
 *  engine period, the served component; a served block without it (an
 *  older capture) states the served scalar; a payload the engine did not
 *  assemble, its own figure. */
function capitalizedOwnWorkSection(
  served: ServedOneEbitda | null,
  servedScalar: number | null,
  payloadAmount: number,
): PLSection | null {
  const c = served?.capitalizedOwnWork;
  if (c) {
    return componentShown(c)
      ? { role: "capitalizedOwnWork", header: "", lines: [componentLine(c, "capitalizedOwnWork")] }
      : null;
  }
  const amount = served ? (servedScalar ?? 0) : payloadAmount;
  if (Math.abs(amount) < HALF_CENT) return null;
  return {
    role: "capitalizedOwnWork",
    header: "",
    lines: [{ accountCode: "72x", label: "Own work capitalised (72x)", amount, style: "item", bucket: "capitalizedOwnWork" }],
  };
}

/** The operating subtotals after EBITDA: EBIT and profit before tax. On an
 *  engine period both are the served figures (refused with EBITDA, or "not
 *  served" when the block does not carry them); on a payload the engine did
 *  not assemble they are built on the same definition. */
function operatingTail(
  served: ServedOneEbitda | null,
  ebitda: number | null,
  ebitdaRefusal: ServedRefusal | null,
  dna: number,
  netFinancialResult: number,
): { ebit: number | null; ebitRefusal: ServedRefusal | null; pbt: number | null; pbtRefusal: ServedRefusal | null } {
  if (served) {
    const ebit = served.ebit;
    const pbt = served.pretax;
    return {
      ebit,
      ebitRefusal: ebit === null ? served.refusal ?? EBIT_NOT_SERVED : null,
      pbt,
      pbtRefusal: pbt === null ? served.refusal ?? PRETAX_NOT_SERVED : null,
    };
  }
  if (ebitda === null) {
    return { ebit: null, ebitRefusal: ebitdaRefusal, pbt: null, pbtRefusal: ebitdaRefusal };
  }
  const ebit = ebitda - dna;
  return { ebit, ebitRefusal: null, pbt: ebit + netFinancialResult, pbtRefusal: null };
}

/** A subtotal-style row that states a figure or its refusal. */
function figureLine(
  base: Omit<PLLine, "amount" | "refusal">,
  amount: number | null,
  refusal: ServedRefusal | null,
): PLLine {
  if (amount !== null) return { ...base, amount };
  return refusal ? { ...base, refusal } : base;
}

/** PROFIT BEFORE TAX → TAX → THE NET RESULT, ENDING ON ACCOUNT 121.
 *
 *  On an engine period the closing lines are the engine's reconciliation
 *  (design A5): where the result built from the accounts IS account 121
 *  (every bridge book — the 711 line is derived from 121, so the chain
 *  closes by construction — and every book whose lines explain it), one
 *  line states it. Where they differ — a closed book with no 711 postings
 *  and a 121 remainder, or a refused build — the build, the part "not
 *  explained by the revenue and expense accounts" and account 121 each get
 *  their own line: the remainder is shown, never folded into 711. With no
 *  account 121 in the trial balance, the build is the result and says so.
 *
 *  The retired "+ capitalized own work (722) → statutory" step is gone: 72x
 *  is inside EBITDA now, so there is nothing to add back. */
function closingSection(
  served: ServedOneEbitda | null,
  pbt: number | null,
  pbtRefusal: ServedRefusal | null,
  tax: number,
  taxLine: PLLine | null,
): { section: PLSection; netProfit: number | null } {
  const lines: PLLine[] = plLines([
    figureLine({ label: "Profit before tax", style: "subtotal", bucket: "pretax" }, pbt, pbtRefusal),
    taxLine,
  ]);
  const base = { role: "closing" as const, header: "", subtotalBucket: "netIncomeStatutory" };

  if (!served) {
    const net = pbt === null ? null : pbt - tax;
    return {
      section: {
        ...base,
        lines,
        subtotalLabel: "Net profit",
        ...(net !== null ? { subtotalAmount: net } : pbtRefusal ? { subtotalRefusal: pbtRefusal } : {}),
      },
      netProfit: net,
    };
  }

  const recon = served.reconciliation;
  const acc = reconLine(recon, "account_121");
  const build = reconLine(recon, "net_result");
  const gap = reconLine(recon, "not_explained");
  const buildRefusal = build?.refusal ?? served.refusal ?? NET_RESULT_NOT_SERVED;

  if (!recon || !acc) {
    // A served block without the reconciliation (an older capture): the
    // engine's net result, or its absence — never pbt − tax rebuilt here.
    const net = served.netIncomeStatutory;
    return {
      section: {
        ...base,
        lines,
        subtotalLabel: "Net profit",
        ...(net !== null ? { subtotalAmount: net } : { subtotalRefusal: NET_RESULT_NOT_SERVED }),
      },
      netProfit: net,
    };
  }

  if (acc.status !== "anchored") {
    const net = build?.value ?? null;
    return {
      section: {
        ...base,
        lines,
        subtotalLabel: "Net result — built from the accounts (no account 121 in the trial balance)",
        subtotalRoName: roNameOf(build?.label),
        ...(net !== null ? { subtotalAmount: net } : { subtotalRefusal: buildRefusal }),
      },
      netProfit: net,
    };
  }

  // Anchored: the engine's account-121 line states the filed figure.
  const filed = acc.value;
  const identity =
    build?.value != null && gap?.value != null && Math.abs(gap.value) < HALF_CENT;
  if (!identity) {
    lines.push(
      figureLine(
        {
          label: build?.label.en ?? "Net result (built from the accounts)",
          roName: roNameOf(build?.label),
          style: "subtotal",
        },
        build?.value ?? null,
        buildRefusal,
      ),
      figureLine(
        {
          label: gap?.label.en ?? "Not explained by the revenue and expense accounts",
          roName: roNameOf(gap?.label),
          style: "item",
          sign: "neutral",
        },
        gap?.value ?? null,
        buildRefusal,
      ),
    );
  }
  return {
    section: {
      ...base,
      lines,
      subtotalLabel: identity ? "Net profit (account 121)" : "= Net result, account 121 (closing balance)",
      subtotalRoName: roNameOf(acc.label),
      ...(filed !== null ? { subtotalAmount: filed } : { subtotalRefusal: NET_RESULT_NOT_SERVED }),
    },
    netProfit: filed,
  };
}

/** A margin refused because the figure over it is: said once above (the
 *  stock-variation row and the EBITDA line carry the engine's sentence). */
export const REFUSED_WITH_EBITDA: Bilingual = {
  ro: "refuzată odată cu EBITDA — motivul este mai sus",
  en: "refused with EBITDA — the reason is stated above",
};

/** KEY MARGINS — both over NET TURNOVER. The engine's metric row first; a
 *  row the period does not carry falls back, per margin, to the statement's
 *  own served figure over served turnover. A refused EBITDA refuses its
 *  margin — and a refused net result its — whatever a metric row says:
 *  never 0.00%, never a percent over a figure the statement refused. */
function keyMarginsFor(
  cm: { ebitdaMargin: number | null; netMargin: number | null } | undefined,
  ebitda: number | null,
  ebitdaRefusal: ServedRefusal | null,
  netProfit: number | null,
  netProfitRefused: boolean,
  turnover: number,
): PLKeyMargin[] {
  const over = (canonical: number | null | undefined, numerator: number | null): number | null => {
    if (typeof canonical === "number" && Number.isFinite(canonical)) return canonical;
    if (numerator !== null && Number.isFinite(numerator) && Number.isFinite(turnover) && turnover > 0) {
      return numerator / turnover;
    }
    return null;
  };
  const ebitdaMargin: PLKeyMargin =
    ebitda === null
      ? { label: "EBITDA margin", value: null, pct: true, ...(ebitdaRefusal ? { refusal: REFUSED_WITH_EBITDA } : {}) }
      : { label: "EBITDA margin", value: over(cm?.ebitdaMargin, ebitda), pct: true };
  const netMargin: PLKeyMargin =
    netProfit === null && netProfitRefused
      ? { label: "Net margin", value: null, pct: true, refusal: REFUSED_WITH_EBITDA }
      : { label: "Net margin", value: over(cm?.netMargin, netProfit), pct: true };
  return [ebitdaMargin, netMargin];
}

/** Lines that must add up to a SERVED total: when the itemised rows fall
 *  short of it, the difference is a labelled row of its own — the section
 *  still states the engine's figure, and still adds up. */
function withRemainder(
  lines: PLLine[],
  servedTotal: number | null,
  remainder: { accountCode: string; label: string; signed?: boolean },
): PLLine[] {
  if (servedTotal === null) return lines;
  const itemised = lines.reduce((s, l) => s + (l.sign === "negative" ? -(l.amount ?? 0) : (l.amount ?? 0)), 0);
  const diff = servedTotal - itemised;
  if (Math.abs(diff) < HALF_CENT) return lines;
  const row: PLLine = remainder.signed
    ? { accountCode: remainder.accountCode, label: remainder.label, amount: Math.abs(diff), style: "item",
        sign: diff >= 0 ? "positive" : "negative" }
    : { accountCode: remainder.accountCode, label: remainder.label, amount: diff, style: "item" };
  return [...lines, row];
}

function sumAmounts(lines: readonly PLLine[]): number {
  return lines.reduce((s, l) => s + (l.amount ?? 0), 0);
}

/** A payload the engine did not assemble: its EBITDA on the one definition,
 *  unless it says it has 711 activity it did not measure. */
function payloadEbitda(
  has711Activity: boolean,
  turnover: number,
  otherIncome: number,
  capitalized: number,
  costs: number,
): { ebitda: number | null; refusal: ServedRefusal | null } {
  if (has711Activity) return { ebitda: null, refusal: STOCK_VARIATION_NOT_MEASURED };
  return { ebitda: turnover + otherIncome + capitalized - costs, refusal: null };
}

// ────────────────────────────────────────────────────────────────────────
// LINE-ITEM BUILDER — per-account rows off the period's own leaves, every
// subtotal the served one (see the file header).
// ────────────────────────────────────────────────────────────────────────

export function buildPLStatement(args: BuildArgs): PLStatement {
  const items = args.lineItems.filter((li) => li.statement === "PL");
  const currency = args.currency ?? "RON";
  const served = readServedOneEbitda(args.servedPl);
  const apl = asRec(args.servedPl);
  const sv = (field: string): number | null => finite(apl?.[field]);

  // ── NET TURNOVER (70x − 709), one row per account family ─────────────
  const families = revenueFamilyAmounts(items);
  const familyLines: PLLine[] = Object.keys(families)
    .sort()
    .filter((f) => Math.abs(families[f]) >= HALF_CENT)
    .map((f) => ({ accountCode: f, label: labelFor(f), amount: families[f], style: "item" as const }));
  const turnover = served?.turnover ?? sumAmounts(familyLines);
  const operatingRevenue: PLSection = {
    role: "operatingRevenue",
    header: "NET TURNOVER",
    lines: withRemainder(familyLines, served ? turnover : null, {
      accountCode: "70x", label: "Net turnover not itemised by account",
    }),
    subtotalLabel: "Total net turnover",
    subtotalAmount: turnover,
    subtotalBucket: "revenue",
  };

  // ── OTHER OPERATING INCOME (74x / 75x / 77x / 78x) ───────────────────
  // The otherIncome bucket's leaves, WITHOUT 711 (the line items carry its
  // gross credit turnover there — the production stocked, not the
  // variation), without 72x (own work capitalised has its own line) and
  // without the reversals the engine placed OUTSIDE EBITDA (R2: the served
  // net-provisions block names them — 7812, 7814 — never typed here).
  const outsideEbitda = served?.netProvisions?.reversalPrefixes ?? [];
  const otherFamilies: Record<string, number> = {};
  for (const li of items) {
    if (li.bucket !== "otherIncome") continue;
    const code = String(li.ro_account_code ?? "").replace(/[\s.\-/_]/g, "");
    if (!/^\d{3,}$/.test(code) || code.startsWith("711") || code.startsWith("72")) continue;
    if (outsideEbitda.some((p) => code.startsWith(p))) continue;
    // A leaf with no amount is read as nothing — never as a zero row.
    if (typeof li.amount !== "number" || !Number.isFinite(li.amount)) continue;
    const family = code.slice(0, 3);
    otherFamilies[family] = (otherFamilies[family] ?? 0) + li.amount;
  }
  const otherLines: PLLine[] = Object.keys(otherFamilies)
    .sort()
    .filter((f) => Math.abs(otherFamilies[f]) >= HALF_CENT)
    .map((f) => ({
      accountCode: f,
      label: labelFor(f),
      amount: otherFamilies[f],
      style: "item" as const,
      // Comparatives key: the 758 family IS the engine's 758 line.
      ...(f === "758" ? { bucket: "otherOperatingIncome" } : {}),
    }));
  const otherIncome = sv("other_operating_income") ?? sumAmounts(otherLines);
  const otherIncomeLines = withRemainder(otherLines, apl ? otherIncome : null, {
    accountCode: "7xx", label: "Other operating income not itemised by account",
  });
  const otherOperatingIncomeSection: PLSection | null =
    Math.abs(otherIncome) >= HALF_CENT
      ? {
          role: "otherOperatingIncome",
          header: "OTHER OPERATING INCOME",
          lines: otherIncomeLines,
          subtotalLabel: "Total other operating income",
          subtotalAmount: otherIncome,
          subtotalBucket: "otherOperatingIncomeTotal",
        }
      : null;

  // ── OWN WORK CAPITALISED (72x) — operating, outside turnover ─────────
  const payloadCapitalized = sumByPrefix(items, "721", "722", "725");
  const capitalizedSection = capitalizedOwnWorkSection(
    served, sv("capitalized_own_work_memo"), payloadCapitalized);
  const capitalized = served
    ? served.capitalizedOwnWork?.value ?? sv("capitalized_own_work_memo") ?? 0
    : payloadCapitalized;

  // ── OPERATING EXPENSES (excl. D&A) ───────────────────────────────────
  // The same table `plUsesLineItems` measures coverage against — if these
  // two ever differed, the router would admit a book this builder cannot
  // actually render. What the table does not reach of the served costs is
  // a labelled row, so the section states the engine's total.
  const opexLines: PLLine[] = OPEX_CODES
    .map((code) => ({ code, amount: sumByExact(items, code) }))
    .filter((x) => Math.abs(x.amount) > 0)
    .map(({ code, amount }) => ({
      accountCode: code,
      label: labelFor(code),
      amount,
      style: "item" as const,
      // Comparatives key: 628 is the engine's third-party-services line.
      ...(code === "628" ? { bucket: "opexThirdParty" } : {}),
    }));
  const servedOpex = sv("opex_total") ?? sv("opex_excluding_cogs_and_da");
  const servedCosts = apl && (sv("cogs") !== null || servedOpex !== null)
    ? (sv("cogs") ?? 0) + (servedOpex ?? 0)
    : null;
  const costLines = withRemainder(opexLines, servedCosts, {
    accountCode: "6xx", label: "Other operating expenses not itemised by account",
  });
  const totalCosts = sumAmounts(costLines);
  const operatingExpenses: PLSection = {
    role: "operatingExpenses",
    header: "OPERATING EXPENSES (excl. D&A)",
    lines: costLines,
    subtotalLabel: "Total operating expenses",
    subtotalAmount: totalCosts,
  };

  // ── THE STOCK VARIATION (711) and THE ONE EBITDA ─────────────────────
  const stockSection = stockVariationSection(served);
  const has711 = items.some(
    (li) => String(li.ro_account_code ?? "").startsWith("711") && Math.abs(li.amount) >= HALF_CENT);
  const { ebitda, refusal: ebitdaRefusal } = served
    ? { ebitda: served.ebitda, refusal: served.refusal }
    : payloadEbitda(has711, turnover, otherIncome, capitalized, totalCosts);

  // ── D&A → NET PROVISIONS → EBIT ──────────────────────────────────────
  // D&A as served — since R2 (2026-09-28) without the 6812 / 6814 charges,
  // which sit with their reversals on the net-provisions row below it.
  const depreciation = sv("depreciation") ?? sumByPrefix(items, "6811", "6812");
  const provisionsLine = netProvisionsLine(served);
  const depreciationLines: PLLine[] = [
    ...(depreciation
      ? [{ accountCode: apl ? depreciationChip(served, "681x") : "6811", label: labelFor("6811"), amount: depreciation, style: "item" as const, bucket: "depreciationAmortization" }]
      : []),
    ...(provisionsLine ? [provisionsLine] : []),
  ];

  // ── FINANCIAL ITEMS (767 discounts received is financial) ────────────
  const dividendIncome = sumByPrefix(items, "7611", "7612", "762", "763");
  const fxGain = sumByExact(items, "7651");
  const interestIncome = sumByExact(items, "766");
  const discountsReceived = sumByPrefix(items, "767");
  const fxLoss = sumByExact(items, "6651");
  const interestExpense = sv("interest_expense") ?? sumByExact(items, "666");

  // `bucket` is the comparatives key (PL_ROW_TO_KEY) where the engine
  // serves the same line: interest income (766) and expense (666).
  const finPos = (code: string, label: string, amt: number, bucket?: string): PLLine | null =>
    Math.abs(amt) > 0
      ? { accountCode: code, label, amount: amt, style: "item", sign: "positive", ...(bucket ? { bucket } : {}) }
      : null;
  const finNeg = (code: string, label: string, amt: number, bucket?: string): PLLine | null =>
    Math.abs(amt) > 0
      ? { accountCode: code, label, amount: amt, style: "item", sign: "negative", ...(bucket ? { bucket } : {}) }
      : null;

  const financialItemLines: PLLine[] = plLines([
    finPos("7611", labelFor("7611"), dividendIncome),
    finPos("7651", labelFor("7651"), fxGain),
    finPos("766",  labelFor("766"),  interestIncome, "interestIncome"),
    finPos("767",  labelFor("767"),  discountsReceived),
    finNeg("6651", labelFor("6651"), fxLoss),
    finNeg("666",  labelFor("666"),  interestExpense, "interestExpense"),
  ]);
  const netFinancialResult =
    sv("net_financial_result") ??
    dividendIncome + fxGain + interestIncome + discountsReceived - fxLoss - interestExpense;
  const financialLines = withRemainder(financialItemLines, apl ? netFinancialResult : null, {
    accountCode: "76x/66x", label: "Other financial items not itemised by account", signed: true,
  });
  const financialItems: PLSection = {
    role: "financialItems",
    header: "FINANCIAL ITEMS",
    lines: financialLines,
    subtotalLabel: "Net financial result",
    subtotalAmount: netFinancialResult,
    subtotalBucket: "netFinancialResult",
  };

  const { ebit, ebitRefusal, pbt, pbtRefusal } = operatingTail(
    served, ebitda, ebitdaRefusal, depreciation, netFinancialResult);
  const depreciationSection: PLSection = {
    role: "depreciation",
    header: "",
    lines: depreciationLines,
    subtotalLabel: "EBIT",
    ...(ebit !== null ? { subtotalAmount: ebit } : ebitRefusal ? { subtotalRefusal: ebitRefusal } : {}),
    subtotalBucket: "ebit",
  };

  // ── PBT → NET RESULT → ACCOUNT 121 ───────────────────────────────────
  const tax = sv("tax") ?? sumByPrefix(items, "691");
  const taxLine: PLLine | null = tax > 0
    ? { accountCode: "691", label: labelFor("691"), amount: tax, style: "item", bucket: "taxExpense" }
    : null;
  const { section: closing, netProfit } = closingSection(served, pbt, pbtRefusal, tax, taxLine);

  return {
    entity: args.entity,
    period: args.period,
    currency,
    sections: [
      operatingRevenue,
      ...(otherOperatingIncomeSection ? [otherOperatingIncomeSection] : []),
      ...(capitalizedSection ? [capitalizedSection] : []),
      operatingExpenses,
      ...(stockSection ? [stockSection] : []),
      depreciationSection,
      financialItems,
      closing,
    ],
    keyMargins: keyMarginsFor(
      args.canonicalMargins, ebitda, ebitdaRefusal, netProfit, closing.subtotalRefusal !== undefined, turnover),
    ebitda,
    ebitdaRefusal,
    ebit,
    netFinancialResult,
    profitBeforeTax: pbt,
    tax,
    netProfit,
    ...(served ? { netProfitStatutory: served.netIncomeStatutory } : {}),
    capitalizedOwnWorkMemo: capitalized,
    periodMonth: periodMonthName(args.periodEnd),
    served,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Aggregates-only builder — the engine's served lines, one row per bucket,
// when the leaves cannot be placed account by account.
// ────────────────────────────────────────────────────────────────────────

interface IncomeStatementCanonical extends IncomeStatement {
  capitalizedOwnWork?: number;
  /** The GROSS credit turnover of 711 (the legacy mirror). Read ONLY to know
   *  that a payload the engine did not assemble HAS 711 activity — never as
   *  the variation. */
  inventoryVariationMemo?: number;
}

/**
 * Pick the right P&L builder for the available data.
 *
 * The line-items builder (`buildPLStatement`) expects 3-4 digit Romanian
 * account codes (SAGA/CIEL convention). Crystal Reports / SAP-style ERPs
 * emit 6-digit sub-account codes (e.g. `701201` for "Venit vanz.mezeluri")
 * which the exact-match `sumByExact(items, "706")` lookups can't find, so
 * revenue/opex tiles end up at 0.
 *
 * The router measures COVERAGE (see `plUsesLineItems`); both builders take
 * the SERVED `assembled_pl` block for every subtotal.
 */
export function pickPLBuilder(
  args: {
    lineItems?: ApiLineItem[];
    entity?: string;
    period?: unknown;
    currency?: string;
    periodEnd?: string;
    /**
     * F1.e — Engine-canonical margin pair (calculated_metrics.ebitda_margin
     * + calculated_metrics.net_margin), both over net turnover.
     */
    canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null };
  },
  statements: Statements,
): PLStatement {
  return withMarginRefusal(pickPLBuilderUnjudged(args, statements), statements);
}

/** THE KEY MARGINS OVER A NEGLIGIBLE TURNOVER. When the ENGINE ruled the
 *  period's margins not meaningful (`statements.margin_meaning`, the one
 *  rule in engine.ratios.margin_meaning), every Key Margins row refuses with
 *  the engine's sentence. Measured on the `realestate` book: "EBITDA margin
 *  −17,884.9%". A payload with no verdict keeps its margins. */
function withMarginRefusal(pl: PLStatement, statements: Statements): PLStatement {
  const refusal = marginRefusalOf(statements);
  if (!refusal) return pl;
  return {
    ...pl,
    keyMargins: pl.keyMargins.map((m) => ({ ...m, value: null, refusal })),
  };
}

function pickPLBuilderUnjudged(
  args: Parameters<typeof pickPLBuilder>[0],
  statements: Statements,
): PLStatement {
  const items = args.lineItems ?? [];
  const plItems = items.filter((li) => li.statement === "PL");
  if (plItems.length === 0) {
    return buildPLStatementFromAggregates(statements, args.canonicalMargins);
  }
  // ROUTE ON COVERAGE, NOT ON CODE SHAPE.
  //
  // This used to guess from the LENGTH of the account codes: if most were
  // longer than 4 characters it called the book "sub-account format" and
  // used the engine's aggregates, otherwise it built from line items.
  //
  // A CONDENSED EXTERNAL balanță — 4-digit synthetic codes, an entirely
  // normal Romanian disclosure level — therefore took the line-item
  // branch, and `OPEX_CODES` names only three of its seventy class-6
  // accounts. Dec 2024 served operating expenses of 5,703,608.87 against a
  // book carrying 409,697,663.25, with revenue rendering as nothing at
  // all. The engine had stored all 220 line items correctly; an exact-match
  // table has no way to say "I did not recognise this account", so 67 of
  // them vanished without a word.
  if (!plUsesLineItems(items, statements)) {
    return buildPLStatementFromAggregates(statements, args.canonicalMargins, {
      revenueChip: revenueFamiliesChip(items),
    });
  }
  return buildPLStatement({
    lineItems: items,
    entity: args.entity ?? "Entity",
    period: (args.period ?? "") as string,
    currency: args.currency ?? "RON",
    periodEnd: args.periodEnd,
    canonicalMargins: args.canonicalMargins,
    servedPl: statements.assembled_pl,
  });
}

export function buildPLStatementFromAggregates(
  statements: Statements,
  canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null },
  opts: {
    /** The account-family chip for the turnover row — see
     *  `revenueFamiliesChip`. Defaults to "70x", the bucket itself. */
    revenueChip?: string;
  } = {},
): PLStatement {
  return withMarginRefusal(
    buildPLStatementFromAggregatesUnjudged(statements, canonicalMargins, opts),
    statements,
  );
}

function buildPLStatementFromAggregatesUnjudged(
  statements: Statements,
  canonicalMargins: { ebitdaMargin: number | null; netMargin: number | null } | undefined,
  opts: { revenueChip?: string },
): PLStatement {
  const is = (statements.incomeStatement ?? {}) as IncomeStatementCanonical;
  const served = readServedOneEbitda(statements.assembled_pl);
  const apl = asRec(statements.assembled_pl);
  // A served line, else the engine's own bucket mirror on `incomeStatement`
  // (the same persisted sum) — never a figure rebuilt from other lines.
  const line = (field: string, mirror: number | undefined): number =>
    finite(apl?.[field]) ?? (typeof mirror === "number" && Number.isFinite(mirror) ? mirror : 0);

  const turnover = served?.turnover ?? line("revenue", is.revenue);
  const cogs = line("cogs", is.costOfGoodsSold);
  const opex = finite(apl?.opex_total) ?? line("opex_excluding_cogs_and_da", is.operatingExpenses);
  const otherIncome = line("other_operating_income", is.otherIncome);
  const dna = line("depreciation", is.depreciationAmortization);
  const interestExpense = line("interest_expense", is.interestExpense);
  const finIncome = line("financial_income", is.financialIncome);
  const finExpense = line("financial_expense", is.financialExpense);
  const tax = line("tax", is.taxExpense);
  const payloadCapitalized = is.capitalizedOwnWork ?? 0;
  const capitalized = served
    ? served.capitalizedOwnWork?.value ?? finite(apl?.capitalized_own_work_memo) ?? 0
    : payloadCapitalized;

  // ── NET TURNOVER ─────────────────────────────────────────────────────
  // Cifra de afaceri netă (70x − 709) and nothing else: 72x has its own
  // line below, 767 is financial, 711 sits beside the costs.
  const operatingRevenueLines: PLLine[] = [];
  if (Math.abs(turnover) >= HALF_CENT) {
    operatingRevenueLines.push({
      // The chip names the families THIS book's revenue bucket holds (or
      // the bucket, "70x") — never a subset written into the code.
      accountCode: opts.revenueChip ?? "70x",
      label: "Net turnover",
      amount: turnover,
      style: "item",
      // Comparatives key (lib/comparatives.ts PL_ROW_TO_KEY): this row IS
      // the engine's net turnover.
      bucket: "revenueTurnover",
    });
  }
  const operatingRevenue: PLSection = {
    role: "operatingRevenue",
    header: "NET TURNOVER",
    lines: operatingRevenueLines,
    subtotalLabel: "Total net turnover",
    subtotalAmount: turnover,
    subtotalBucket: "revenue",
  };

  // ── OTHER OPERATING INCOME ───────────────────────────────────────────
  // The served other-operating-income line — the addend the engine's
  // EBITDA uses (758, 781 reversals, 74x subsidies, …). It IS inside
  // EBITDA; the old subtotal label saying it was excluded was wrong.
  const otherOperatingIncomeSection: PLSection | null =
    Math.abs(otherIncome) >= HALF_CENT
      ? {
          role: "otherOperatingIncome",
          header: "OTHER OPERATING INCOME",
          lines: [{
            accountCode: reconLine(served?.reconciliation, "other_operating_income")?.accountsEn
              ?? reconLine(served?.reconciliation, "other_operating_income")?.accounts ?? "758",
            label: "Other operating income",
            amount: otherIncome,
            style: "item",
            bucket: "otherOperatingIncome",
          }],
          subtotalLabel: "Total other operating income",
          subtotalAmount: otherIncome,
          subtotalBucket: "otherOperatingIncomeTotal",
        }
      : null;

  // ── OWN WORK CAPITALISED (72x) ───────────────────────────────────────
  const capitalizedSection = capitalizedOwnWorkSection(
    served, finite(apl?.capitalized_own_work_memo), payloadCapitalized);

  // ── OPERATING EXPENSES ───────────────────────────────────────────────
  const opexLines: PLLine[] = [];
  if (Math.abs(cogs) >= HALF_CENT) {
    opexLines.push({
      accountCode: "60x",
      label: "Cost of goods sold (601/602/607)",
      amount: cogs,
      style: "item",
      bucket: "cogs",
    });
  }
  if (Math.abs(opex) >= HALF_CENT) {
    opexLines.push({
      accountCode: "6xx",
      label: "Operating expenses (62x/63x/64x — incl. 628 third-party services)",
      amount: opex,
      style: "item",
      bucket: "opexTotal",
    });
  }
  const operatingExpenses: PLSection = {
    role: "operatingExpenses",
    header: "OPERATING EXPENSES (excl. D&A)",
    lines: opexLines,
    subtotalLabel: "Total operating expenses",
    subtotalAmount: cogs + opex,
  };

  // ── THE STOCK VARIATION (711) and THE ONE EBITDA ─────────────────────
  const stockSection = stockVariationSection(served);
  const { ebitda, refusal: ebitdaRefusal } = served
    ? { ebitda: served.ebitda, refusal: served.refusal }
    : payloadEbitda(
        Math.abs(is.inventoryVariationMemo ?? 0) >= HALF_CENT,
        turnover, otherIncome, capitalized, cogs + opex);

  // ── FINANCIAL ITEMS ──────────────────────────────────────────────────
  // Comparatives keys: financial income and interest expense are the
  // engine's `pl.financial_income` / `pl.interest_expense` by definition
  // (the same buckets). The third row is NOT keyed: the engine's
  // `pl.financial_expense` includes interest, this row excludes it.
  const financialLines: PLLine[] = [];
  if (finIncome > 0) {
    financialLines.push({
      accountCode: "76x",
      label: "Financial income (dividends, interest, FX gain, discounts received 767)",
      amount: finIncome,
      style: "item",
      sign: "positive",
      bucket: "financialIncomeTotal",
    });
  }
  if (interestExpense > 0) {
    financialLines.push({
      accountCode: "666",
      label: "Interest expense",
      amount: interestExpense,
      style: "item",
      sign: "negative",
      bucket: "interestExpense",
    });
  }
  if (finExpense > 0) {
    financialLines.push({
      accountCode: "6651",
      label: "FX losses & other financial expense",
      amount: finExpense,
      style: "item",
      sign: "negative",
    });
  }
  const netFinancialResult =
    finite(apl?.net_financial_result) ?? finIncome - interestExpense - finExpense;
  const financialItems: PLSection = {
    role: "financialItems",
    header: "FINANCIAL ITEMS",
    lines: financialLines,
    subtotalLabel: "Net financial result",
    subtotalAmount: netFinancialResult,
    subtotalBucket: "netFinancialResult",
  };

  // ── D&A → NET PROVISIONS → EBIT ──────────────────────────────────────
  const { ebit, ebitRefusal, pbt, pbtRefusal } = operatingTail(
    served, ebitda, ebitdaRefusal, dna, netFinancialResult);
  const provisionsLine = netProvisionsLine(served);
  const depreciationSection: PLSection = {
    role: "depreciation",
    header: "",
    lines: [
      ...(dna > 0
        ? [{ accountCode: depreciationChip(served, "6811"), label: "Depreciation & amortization", amount: dna, style: "item" as const, bucket: "depreciationAmortization" }]
        : []),
      ...(provisionsLine ? [provisionsLine] : []),
    ],
    subtotalLabel: "EBIT",
    ...(ebit !== null ? { subtotalAmount: ebit } : ebitRefusal ? { subtotalRefusal: ebitRefusal } : {}),
    subtotalBucket: "ebit",
  };

  // ── PBT → NET RESULT → ACCOUNT 121 ───────────────────────────────────
  const taxLine: PLLine | null = tax > 0
    ? { accountCode: "691", label: "Income tax", amount: tax, style: "item", bucket: "taxExpense" }
    : null;
  const { section: closing, netProfit } = closingSection(served, pbt, pbtRefusal, tax, taxLine);

  return {
    entity: statements.companyName ?? "Entity",
    period: statements.periodLabel,
    currency: statements.currency,
    sections: [
      operatingRevenue,
      ...(otherOperatingIncomeSection ? [otherOperatingIncomeSection] : []),
      ...(capitalizedSection ? [capitalizedSection] : []),
      operatingExpenses,
      ...(stockSection ? [stockSection] : []),
      depreciationSection,
      financialItems,
      closing,
    ],
    keyMargins: keyMarginsFor(
      canonicalMargins, ebitda, ebitdaRefusal, netProfit, closing.subtotalRefusal !== undefined, turnover),
    ebitda,
    ebitdaRefusal,
    ebit,
    netFinancialResult,
    profitBeforeTax: pbt,
    tax,
    netProfit,
    ...(served ? { netProfitStatutory: served.netIncomeStatutory } : {}),
    capitalizedOwnWorkMemo: capitalized,
    periodMonth: "the period",
    served,
  };
}
