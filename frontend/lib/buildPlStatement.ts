// Build a structured P&L statement from the backend's flat line-items list.
//
// CONVENTION: "OPERATING VIEW" (the reference used by Romanian SME CFOs).
//   - Account 706 + 722 + 767 → operating revenue (all included)
//   - Account 628 → operating expense (included in opex)
//   - Net P&L effect of 722/628 ≈ zero (they offset), but both are surfaced
//     as line items for traceability.
//   - This produces EBITDA = 2,149,571 for EEI Dec 2025 (matches the
//     reference target).
//
// The audit.json reference supports both views (operating + financial);
// this builder defaults to operating view. Add a `view: "financial"` arg
// later if you want to switch behavior.

import {
  ApiLineItem,
  PLLine,
  PLSection,
  PLStatement,
  PLKeyMargin,
  sumByExact,
  sumByPrefix,
} from "./plStructure";
import type { IncomeStatement, Statements } from "./financialReport";


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
  /** ISO period_end ("2025-12-31") — used for the footnote's month name. */
  periodEnd?: string;
  /** Currency code (defaults RON). */
  currency?: string;
  /**
   * F1.e — Optional engine-canonical margin pair. When provided, the Key
   * Margins block collapses from the legacy 3-row dual-basis presentation
   * (EBITDA / EBITDA excl 722 / Net on statutory NP) to the two canonical
   * rows the engine emits via `calculated_metrics.ebitda_margin` and
   * `calculated_metrics.net_margin`. The dual-basis comparison still lives
   * on the Comprehensive Report Overview REPORTED/CORE tiles and the
   * EBITDA Reconciliation panel (intentional dual-view surfaces).
   */
  canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null };
  /** `assembled_pl.ebitda` — the engine's figure. See
   *  EBITDA_COMPOSITION_NOTE: one metric name, one formula, everywhere. */
  servedEbitda?: number | null;
}

// Account-to-label table used to render the per-line labels next to the
// account code. These are English labels — they match the reference output.
const ACCOUNT_LABELS: Record<string, string> = {
  // Revenue
  "701": "Sales of finished goods",
  "704": "Service revenue",
  "706": "Rental & lease income",
  "707": "Goods resold",
  "708": "Other operating income",
  "722": "Capitalized own work (CIP)",
  "758": "Other operating income (758)",
  "767": "Discounts received",
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
  "767__": "(handled as revenue)",
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
 *  `assembled_pl.ebitda` is the figure every other surface reads — the
 *  forecast's `PlHistory`, the ratios, the credit composite, the
 *  valuation. Measured on three real books, it equals
 *  `revenue − cogs − opex + other_operating_income` to the cent.
 *
 *  This file used to derive its own, from `total_operating_revenue`,
 *  which EXCLUDES account 758. So the dashboard P&L and the forecast
 *  stated two EBITDAs for one period — 42,797,225.01 against
 *  54,443,833.33 on Scandia, every EBITDA ratio 27% apart. On the retail
 *  book the two differ in SIGN: the engine serves +220,162.84 and the
 *  derivation gives −506,705.80.
 *
 *  The served figure wins. The derivation survives only as the fallback
 *  for a payload that carries no `ebitda` key, and it now uses the SAME
 *  formula, so the two cannot disagree even then.
 *
 *  Whether 758 BELONGS in EBITDA is a separate question, deliberately not
 *  answered here: non-trading income inside EBITDA is already surfaced by
 *  the earnings-quality detector, which is where that analysis belongs.
 *  One definition first; the definition itself is revisited after launch.
 */
export const EBITDA_COMPOSITION_NOTE = "includes other operating income (758)";

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
 *  footnote's rental-dominance test both read this — one reading of the
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

function oneEbitda(
  served: number | null | undefined,
  totalOperatingRevenue: number,
  totalOpexCash: number,
  otherOperatingIncome: number,
): number {
  if (typeof served === "number" && Number.isFinite(served)) return served;
  return totalOperatingRevenue - totalOpexCash + otherOperatingIncome;
}

export function buildPLStatement(args: BuildArgs): PLStatement {
  const items = args.lineItems.filter((li) => li.statement === "PL");
  const currency = args.currency ?? "RON";

  // ── OPERATING REVENUE (706 + 722 + 767 + 708) ────────────────────────
  // Same sectioning principle as `buildPLStatementFromAggregates` below:
  // account 758 (other operating income) is presented in its OWN
  // sub-section, not summed into the operating-revenue subtotal (which
  // drives EBITDA). This keeps every section internally consistent —
  // displayed lines always equal their subtotal — without re-classifying
  // any engine value.
  const revRental = sumByExact(items, "706");
  const revCapOwnWork = sumByPrefix(items, "721", "722", "725");
  const revDiscounts = sumByExact(items, "767");
  const revOther = sumByExact(items, "708");
  const revOtherOperating = sumByExact(items, "758");

  const operatingRevenueLines: PLLine[] = plLines([
    revRental ? { accountCode: "706", label: labelFor("706"), amount: revRental, style: "item" } : null,
    revCapOwnWork ? { accountCode: "722", label: labelFor("722"), amount: revCapOwnWork, style: "item" } : null,
    revDiscounts ? { accountCode: "767", label: labelFor("767"), amount: revDiscounts, style: "item" } : null,
    revOther ? { accountCode: "708", label: labelFor("708"), amount: revOther, style: "item" } : null,
  ]);

  const totalOperatingRevenue = revRental + revCapOwnWork + revDiscounts + revOther;

  const operatingRevenue: PLSection = {
    header: "OPERATING REVENUE",
    lines: operatingRevenueLines,
    subtotalLabel: "Total operating revenue",
    subtotalAmount: totalOperatingRevenue,
    subtotalBucket: "revenue",
  };

  // ── OTHER OPERATING INCOME (758) ─────────────────────────────────────
  // Displayed separately for transparency; explicitly excluded from
  // EBITDA per the engine's canonical operating-revenue definition.
  const otherOperatingIncomeLines: PLLine[] = revOtherOperating !== 0
    ? [{ accountCode: "758", label: labelFor("758"), amount: revOtherOperating, style: "item" }]
    : [];
  const otherOperatingIncomeSection: PLSection = {
    header: "OTHER OPERATING INCOME",
    lines: otherOperatingIncomeLines,
    subtotalLabel: "Total other operating income (excluded from operating revenue / EBITDA above)",
    subtotalAmount: revOtherOperating,
  };

  // ── OPERATING EXPENSES (excl D&A, interest, FX, tax) ─────────────────
  // The same table `plUsesLineItems` measures coverage against — if these
  // two ever differed, the router would admit a book this builder cannot
  // actually render.
  const opexCodes = OPEX_CODES;
  const opexLines: PLLine[] = opexCodes
    .map((code) => ({ code, amount: sumByExact(items, code) }))
    .filter((x) => Math.abs(x.amount) > 0)
    .map(({ code, amount }) => ({
      accountCode: code,
      label: labelFor(code),
      amount,
      style: "item" as const,
    }));

  const totalOpexCash = opexLines.reduce((s, l) => s + (l.amount ?? 0), 0);

  const operatingExpenses: PLSection = {
    header: "OPERATING EXPENSES (excl. D&A)",
    lines: opexLines,
    subtotalLabel: "Total operating expenses (cash)",
    subtotalAmount: totalOpexCash,
  };

  // ── EBITDA — the engine's figure, see EBITDA_COMPOSITION_NOTE ────────
  const ebitda = oneEbitda(
    args.servedEbitda, totalOperatingRevenue, totalOpexCash, revOtherOperating);

  // ── D&A → EBIT ───────────────────────────────────────────────────────
  const depreciation = sumByPrefix(items, "6811", "6812");

  const depreciationSection: PLSection = {
    header: "",
    lines: depreciation
      ? [{ accountCode: "6811", label: labelFor("6811"), amount: depreciation, style: "item", bucket: "depreciationAmortization" }]
      : [],
    subtotalLabel: "EBIT",
    subtotalAmount: ebitda - depreciation,
    subtotalBucket: "ebit",
  };

  const ebit = ebitda - depreciation;

  // ── FINANCIAL ITEMS ──────────────────────────────────────────────────
  const dividendIncome = sumByPrefix(items, "7611", "7612", "762", "763");
  const fxGain = sumByExact(items, "7651");
  const interestIncome = sumByExact(items, "766");
  const fxLoss = sumByExact(items, "6651");
  const interestExpense = sumByExact(items, "666");

  const finPos = (code: string, label: string, amt: number): PLLine | null =>
    Math.abs(amt) > 0
      ? { accountCode: code, label, amount: amt, style: "item", sign: "positive" }
      : null;
  const finNeg = (code: string, label: string, amt: number): PLLine | null =>
    Math.abs(amt) > 0
      ? { accountCode: code, label, amount: amt, style: "item", sign: "negative" }
      : null;

  const financialLines: PLLine[] = plLines([
    finPos("7611", labelFor("7611"), dividendIncome),
    finPos("7651", labelFor("7651"), fxGain),
    finPos("766",  labelFor("766"),  interestIncome),
    finNeg("6651", labelFor("6651"), fxLoss),
    finNeg("666",  labelFor("666"),  interestExpense),
  ]);

  const netFinancialResult =
    dividendIncome + fxGain + interestIncome - fxLoss - interestExpense;

  const financialItems: PLSection = {
    header: "FINANCIAL ITEMS",
    lines: financialLines,
    subtotalLabel: "Net financial result",
    subtotalAmount: netFinancialResult,
  };

  // ── PBT → NET PROFIT ─────────────────────────────────────────────────
  // Two valid views of "net profit" coexist in Romanian books:
  //   · netProfit (operational)  — excludes 722 capitalized own-work
  //   · netProfitStatutory       — includes 722, matches account 121
  //                                closing balance (legally filed)
  // The HEADLINE row is OPERATIONAL — that's the figure the dashboard
  // surfaces everywhere (KPI tile, briefing, P&L) for one consistent
  // screen-wide net-profit value. The statutory ct-121 view is shown
  // below the headline as an explicit operational → +722 → statutory
  // BRIDGE rendered by PLStatementView (`PLReconciliationBridge`).
  // Treating statutory as the headline previously caused the on-screen
  // contradiction "Net profit 1.43M" (operational tile) versus "NET
  // PROFIT 3.59M" (statutory subtotal) for the same company — board
  // readers see one company / two net-profit numbers and stop trusting
  // the document.
  const profitBeforeTax = ebit + netFinancialResult;
  const tax = sumByPrefix(items, "691");
  const netProfit = profitBeforeTax - tax;                        // operational
  const netProfitStatutory = netProfit + revCapOwnWork;           // includes 722

  const closingSection: PLSection = {
    header: "",
    lines: plLines([
      { label: "Profit before tax", amount: profitBeforeTax, style: "subtotal" },
      tax > 0
        ? { accountCode: "691", label: labelFor("691"), amount: tax, style: "item" }
        : null,
    ]),
    // OPERATIONAL is the headline subtotal. The 722 bridge to statutory
    // ct-121 is rendered by PLReconciliationBridge in PLStatementView,
    // visually subordinated to this headline (it's a reconciliation, not
    // a competing total).
    subtotalLabel: "Net profit — operational (excl. 722)",
    subtotalAmount: netProfit,
    subtotalBucket: "netIncomeOperational",
  };

  // ── KEY MARGINS ──────────────────────────────────────────────────────
  // Operating-view EBITDA margin uses total operating revenue (incl 722, 767)
  // as denominator. Clean view excludes capitalized own-work from both sides.
  const operatingRevenueExclCIP =
    revRental + revDiscounts + revOther;
  const ext_serv_other = sumByExact(items, "628");
  const cleanEbitda =
    ebitda - revCapOwnWork + ext_serv_other - ext_serv_other; // net effect: ebitda - revCapOwnWork
  // The 628/722 offset means the clean view drops revenue AND opex by the
  // same amount — net effect on EBITDA is roughly zero (within rounding).

  // F1.e — Key Margins: two canonical rows when the engine-canonical pair
  // is provided (the only path that fires in the post-F1.e UI). The legacy
  // 3-row dual-basis presentation is preserved as a fallback for callers
  // that haven't been migrated yet — but every active caller in
  // FinancialStatements.tsx / ComprehensiveReport.tsx supplies the canonical
  // pair, so the fallback is back-compat only and shouldn't fire in prod.
  // The `cleanEbitda` and `operatingRevenueExclCIP` locals are still scoped
  // above for the fallback path.
  void cleanEbitda;
  void operatingRevenueExclCIP;
  const cm = args.canonicalMargins;
  // PER MARGIN, NOT PER OBJECT (2026-09-21). `canonicalMargins` is a memo that
  // always returns an OBJECT whose fields may be null, so `cm ? canonical :
  // arithmetic` always took the canonical branch and the arithmetic branch
  // below was dead code — the real fallback was `?? 0`, and an absent margin
  // rendered as 0.00%. Each margin now falls back on its own, and refuses
  // (null) when neither the engine row nor the operands are there.
  const marginOrNull = (canonical: number | null | undefined,
                        numerator: number, denominator: number): number | null => {
    if (typeof canonical === "number" && Number.isFinite(canonical)) return canonical;
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator;
    }
    return null;
  };
  const keyMargins: PLKeyMargin[] = cm
    ? [
        {
          label: "EBITDA margin",
          value: marginOrNull(cm.ebitdaMargin, ebitda, totalOperatingRevenue),
          pct: true,
        },
        {
          label: "Net margin",
          value: marginOrNull(cm.netMargin, netProfitStatutory, totalOperatingRevenue),
          pct: true,
        },
      ]
    : [
        {
          label: "EBITDA margin (on total operating revenue)",
          value: totalOperatingRevenue > 0 ? ebitda / totalOperatingRevenue : 0,
          pct: true,
        },
        {
          label: "EBITDA margin excl. capitalized own work",
          value: operatingRevenueExclCIP > 0 ? cleanEbitda / operatingRevenueExclCIP : 0,
          pct: true,
        },
        {
          label: "Net margin (on statutory net profit)",
          value: totalOperatingRevenue > 0 ? netProfitStatutory / totalOperatingRevenue : 0,
          pct: true,
        },
      ];

  return {
    entity: args.entity,
    period: args.period,
    currency,
    sections: [
      operatingRevenue,
      ...(otherOperatingIncomeLines.length > 0 ? [otherOperatingIncomeSection] : []),
      operatingExpenses,
      depreciationSection,
      financialItems,
      closingSection,
    ],
    keyMargins,
    ebitda,
    ebit,
    netFinancialResult,
    profitBeforeTax,
    tax,
    netProfit,
    netProfitStatutory,
    capitalizedOwnWorkMemo: revCapOwnWork,
    extServOther: ext_serv_other,
    periodMonth: periodMonthName(args.periodEnd),
    revenueFamilyAmounts: revenueFamilyAmounts(items),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Aggregates-only builder — works when only the assembled Statements blob
// is available (no per-account line items). Produces the same reference
// layout, just with category-level lines instead of per-account rows.
//
// Operating-view convention: 722 (capitalized own-work memo) is INCLUDED
// in operating revenue here. The reference target produces EBITDA =
// 2,149,571 for EEI Dec 2025; this aggregates-only path gets to the same
// number using `incomeStatement.capitalizedOwnWork` + `operatingExpenses`.
// ────────────────────────────────────────────────────────────────────────

interface IncomeStatementCanonical extends IncomeStatement {
  capitalizedOwnWork?: number;
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
 * Heuristic: if more than half of the PL line items have codes longer than
 * 4 characters, fall back to the aggregates-from-bucket-sums builder which
 * reads from `statements.incomeStatement.*` (the backend already summed
 * everything into the right buckets server-side).
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
     * + calculated_metrics.net_margin). When provided, both builder
     * branches collapse Key Margins to 2 canonical rows.
     */
    canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null };
  },
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
    return buildPLStatementFromAggregates(statements, args.canonicalMargins, undefined, {
      revenueChip: revenueFamiliesChip(items),
      revenueFamilies: revenueFamilyAmounts(items),
    });
  }
  return buildPLStatement({
    lineItems: items,
    entity: args.entity ?? "Entity",
    period: (args.period ?? "") as string,
    currency: args.currency ?? "RON",
    periodEnd: args.periodEnd,
    canonicalMargins: args.canonicalMargins,
  });
}

export function buildPLStatementFromAggregates(
  statements: Statements,
  // F1.e — see BuildArgs.canonicalMargins for the full rationale. Mirrored
  // here so the aggregates-path caller can supply the same canonical pair.
  canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null },
  servedEbitda?: number | null,
  opts: {
    /** The account-family chip for the revenue row — see
     *  `revenueFamiliesChip`. Defaults to "70x", the bucket itself. */
    revenueChip?: string;
    /** Revenue by family, read off the same leaves as the chip — see
     *  `revenueFamilyAmounts`. Absent when no leaves were available. */
    revenueFamilies?: Record<string, number>;
  } = {},
): PLStatement {
  const is = statements.incomeStatement as IncomeStatementCanonical;
  const revenue = is.revenue;
  const cogs = is.costOfGoodsSold;
  const opex = is.operatingExpenses;
  const otherIncome = is.otherIncome ?? 0;
  const dna = is.depreciationAmortization;
  const interestExpense = is.interestExpense;
  const finIncome = is.financialIncome ?? 0;
  const finExpense = is.financialExpense ?? 0;
  const tax = is.taxExpense ?? 0;
  const capOwnWork = is.capitalizedOwnWork ?? 0;

  // ── OPERATING REVENUE ────────────────────────────────────────────────
  // `total_operating_revenue` includes 706 + 722 and EXCLUDES 758. That
  // stays true and this subtotal stays as it is.
  //
  // What used to be written here — "EBITDA downstream uses this exact
  // figure" — was NOT true: the engine's own `assembled_pl.ebitda`
  // includes 758, so the sentence justified a derivation that disagreed
  // with the engine on every book. EBITDA no longer comes from this
  // subtotal at all; see EBITDA_COMPOSITION_NOTE.
  //
  // The previous bug rendered 758 visually INSIDE this section but
  // omitted it from the subtotal, producing a section whose listed
  // lines did not foot to its own total. The fix splits 758 out into
  // its own correctly-labelled section below (see "OTHER OPERATING
  // INCOME" further down) so:
  //   · OPERATING REVENUE lines and total agree (only 706 + 722).
  //   · 758 still appears, in its own footed section, plainly labelled.
  //   · EBITDA / EBIT / PBT / Net profit are byte-identical to before.
  // This is display-sectioning only; no engine value recomputed.
  const operatingRevenueLines: PLLine[] = [];
  if (revenue) {
    operatingRevenueLines.push({
      // The chip names the families THIS book's revenue bucket holds (or
      // the bucket, "70x") — never a subset written into the code. See
      // `revenueFamiliesChip` for the label this replaced and why.
      accountCode: opts.revenueChip ?? "70x",
      label: "Operating revenue (net turnover)",
      amount: revenue,
      style: "item",
      // Comparatives key (lib/comparatives.ts PL_ROW_TO_KEY): this row IS
      // the engine's net turnover — measured equal to the cent.
      bucket: "revenueTurnover",
    });
  }
  if (capOwnWork > 0) {
    operatingRevenueLines.push({
      accountCode: "722",
      label: "Capitalized own work (CIP)",
      amount: capOwnWork,
      style: "item",
    });
  }

  const totalOperatingRevenue = revenue + capOwnWork;

  const operatingRevenue: PLSection = {
    header: "OPERATING REVENUE",
    lines: operatingRevenueLines,
    subtotalLabel: "Total operating revenue",
    subtotalAmount: totalOperatingRevenue,
    subtotalBucket: "revenue",
  };

  // ── OTHER OPERATING INCOME (758) ─────────────────────────────────────
  // Account 758 ("Alte venituri din exploatare") is reported here as a
  // separate one-line section. It is excluded from the EBITDA-driving
  // operating-revenue subtotal above, per the engine's canonical
  // classification. Showing it on its own line, in its own footed
  // section, gives the board reader complete visibility WITHOUT the
  // misleading layout where 758 sat under a subtotal that excluded it.
  const otherOperatingIncomeLines: PLLine[] = [];
  if (otherIncome !== 0) {
    otherOperatingIncomeLines.push({
      accountCode: "758",
      label: "Other operating income (758)",
      amount: otherIncome,
      style: "item",
    });
  }
  const otherOperatingIncomeSection: PLSection = {
    header: "OTHER OPERATING INCOME",
    lines: otherOperatingIncomeLines,
    subtotalLabel: "Total other operating income (excluded from operating revenue / EBITDA above)",
    subtotalAmount: otherIncome,
  };

  // ── OPERATING EXPENSES ───────────────────────────────────────────────
  const opexLines: PLLine[] = [];
  if (cogs > 0) {
    opexLines.push({
      accountCode: "60x",
      label: "Cost of goods sold (601/602/607)",
      amount: cogs,
      style: "item",
      bucket: "cogs",
    });
  }
  if (opex > 0) {
    opexLines.push({
      accountCode: "6xx",
      label: "Operating expenses (62x/63x/64x — incl. 628 third-party services)",
      amount: opex,
      style: "item",
      bucket: "opexTotal",
    });
  }

  const totalOpexCash = cogs + opex;

  const operatingExpenses: PLSection = {
    header: "OPERATING EXPENSES (excl. D&A)",
    lines: opexLines,
    subtotalLabel: "Total operating expenses (cash)",
    subtotalAmount: totalOpexCash,
  };

  // ── EBITDA — the engine's figure, see EBITDA_COMPOSITION_NOTE ────────
  const ebitda = oneEbitda(
    servedEbitda ?? (is as { ebitda?: number | null }).ebitda,
    totalOperatingRevenue, totalOpexCash, otherIncome);

  // ── D&A → EBIT ───────────────────────────────────────────────────────
  const depreciationSection: PLSection = {
    header: "",
    lines: dna > 0
      ? [{ accountCode: "6811", label: "Depreciation & amortization", amount: dna, style: "item", bucket: "depreciationAmortization" }]
      : [],
    subtotalLabel: "EBIT",
    subtotalAmount: ebitda - dna,
    subtotalBucket: "ebit",
  };

  const ebit = ebitda - dna;

  // ── FINANCIAL ITEMS ──────────────────────────────────────────────────
  const financialLines: PLLine[] = [];
  if (finIncome > 0) {
    financialLines.push({
      accountCode: "76x",
      label: "Financial income (dividends, interest, FX gain, discounts)",
      amount: finIncome,
      style: "item",
      sign: "positive",
    });
  }
  if (interestExpense > 0) {
    financialLines.push({
      accountCode: "666",
      label: "Interest expense",
      amount: interestExpense,
      style: "item",
      sign: "negative",
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

  const netFinancialResult = finIncome - interestExpense - finExpense;

  const financialItems: PLSection = {
    header: "FINANCIAL ITEMS",
    lines: financialLines,
    subtotalLabel: "Net financial result",
    subtotalAmount: netFinancialResult,
    subtotalBucket: "netFinancialResult",
  };

  // ── PBT → NET PROFIT ─────────────────────────────────────────────────
  // Same operational-headline treatment as the line-items variant above.
  // The headline subtotal is OPERATIONAL net profit (excl. 722); the
  // statutory ct-121 view is rendered below by PLReconciliationBridge
  // as an explicit bridge, never as a competing total. One company →
  // one screen-wide net-profit figure.
  const profitBeforeTax = ebit + netFinancialResult;
  const netProfit = profitBeforeTax - tax;                  // operational
  const netProfitStatutory = netProfit + capOwnWork;        // includes 722

  const closingSection: PLSection = {
    header: "",
    lines: plLines([
      { label: "Profit before tax", amount: profitBeforeTax, style: "subtotal", bucket: "pretax" },
      tax > 0
        ? { accountCode: "691", label: "Income tax", amount: tax, style: "item", bucket: "taxExpense" }
        : null,
    ]),
    subtotalLabel: "Net profit — operational (excl. 722)",
    subtotalAmount: netProfit,
    subtotalBucket: "netIncomeOperational",
  };

  // ── KEY MARGINS ──────────────────────────────────────────────────────
  // Clean EBITDA strips the capitalized own-work (revenue) and the matching
  // portion of opex (assumed to mirror 722 — i.e. the 628/722 wash).
  const cleanEbitda = ebitda - capOwnWork;  // revenue drops; opex offset assumed
  // Same single-source convention as `totalOperatingRevenue` above —
  // never adds `otherIncome` to the headline number (711 was the bug).
  const operatingRevExclCIP = revenue;

  // F1.e — see the BuildArgs.canonicalMargins comment in buildPLStatement.
  // Aggregates-path mirror.
  void cleanEbitda;
  void operatingRevExclCIP;
  // Per margin, not per object — see the same repair in buildPLStatement above.
  const marginOrNullAgg = (canonical: number | null | undefined,
                           numerator: number, denominator: number): number | null => {
    if (typeof canonical === "number" && Number.isFinite(canonical)) return canonical;
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator;
    }
    return null;
  };
  const keyMargins: PLKeyMargin[] = canonicalMargins
    ? [
        {
          label: "EBITDA margin",
          value: marginOrNullAgg(canonicalMargins.ebitdaMargin, ebitda, totalOperatingRevenue),
          pct: true,
        },
        {
          label: "Net margin",
          value: marginOrNullAgg(canonicalMargins.netMargin, netProfitStatutory, totalOperatingRevenue),
          pct: true,
        },
      ]
    : [
        {
          label: "EBITDA margin (on total operating revenue)",
          value: totalOperatingRevenue > 0 ? ebitda / totalOperatingRevenue : 0,
          pct: true,
        },
        {
          label: "EBITDA margin excl. capitalized own work",
          value: operatingRevExclCIP > 0 ? cleanEbitda / operatingRevExclCIP : 0,
          pct: true,
        },
        {
          label: "Net margin (on statutory net profit)",
          value: totalOperatingRevenue > 0 ? netProfitStatutory / totalOperatingRevenue : 0,
          pct: true,
        },
      ];

  return {
    entity: statements.companyName ?? "Entity",
    period: statements.periodLabel,
    currency: statements.currency,
    sections: [
      operatingRevenue,
      // 758 sits between operating revenue and operating expenses,
      // visually distinct, with a subtotal label that names the
      // exclusion explicitly. EBITDA below stays computed off
      // `totalOperatingRevenue` only (engine's canonical view).
      ...(otherOperatingIncomeLines.length > 0 ? [otherOperatingIncomeSection] : []),
      operatingExpenses,
      depreciationSection,
      financialItems,
      closingSection,
    ],
    keyMargins,
    ebitda,
    ebit,
    netFinancialResult,
    profitBeforeTax,
    tax,
    netProfit,
    netProfitStatutory,
    capitalizedOwnWorkMemo: capOwnWork,
    extServOther: opex,  // proxy — the actual 628 is hidden in opex aggregate
    periodMonth: "the period",
    ...(opts.revenueFamilies ? { revenueFamilyAmounts: opts.revenueFamilies } : {}),
  };
}
