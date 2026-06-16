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

  const operatingRevenueLines: PLLine[] = [
    revRental ? { accountCode: "706", label: labelFor("706"), amount: revRental, style: "item" } : null,
    revCapOwnWork ? { accountCode: "722", label: labelFor("722"), amount: revCapOwnWork, style: "item" } : null,
    revDiscounts ? { accountCode: "767", label: labelFor("767"), amount: revDiscounts, style: "item" } : null,
    revOther ? { accountCode: "708", label: labelFor("708"), amount: revOther, style: "item" } : null,
  ].filter((l): l is PLLine => l !== null);

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
  const opexCodes = [
    "6024", "6051", "605", "603", "604", "607",
    "611", "6123", "612", "613",
    "622", "626", "627", "628",
    "635",
    "641", "645", "6458", "6461",
  ];
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

  // ── EBITDA (operating view: revenue includes 722 + 767) ──────────────
  const ebitda = totalOperatingRevenue - totalOpexCash;

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

  const financialLines: PLLine[] = [
    finPos("7611", labelFor("7611"), dividendIncome),
    finPos("7651", labelFor("7651"), fxGain),
    finPos("766",  labelFor("766"),  interestIncome),
    finNeg("6651", labelFor("6651"), fxLoss),
    finNeg("666",  labelFor("666"),  interestExpense),
  ].filter((l): l is PLLine => l !== null);

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
    lines: [
      { label: "Profit before tax", amount: profitBeforeTax, style: "subtotal" },
      tax > 0
        ? { accountCode: "691", label: labelFor("691"), amount: tax, style: "item" }
        : null,
    ].filter((l): l is PLLine => l !== null),
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
  const keyMargins: PLKeyMargin[] = cm
    ? [
        {
          label: "EBITDA margin",
          value: cm.ebitdaMargin ?? 0,
          pct: true,
        },
        {
          label: "Net margin",
          value: cm.netMargin ?? 0,
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
  const longCodeCount = plItems.filter(
    (li) => typeof li.ro_account_code === "string" && li.ro_account_code.length > 4,
  ).length;
  const looksLikeSubAccountFormat = longCodeCount > plItems.length * 0.5;
  if (looksLikeSubAccountFormat) {
    return buildPLStatementFromAggregates(statements, args.canonicalMargins);
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
  // The engine's canonical `total_operating_revenue` includes account 706
  // (and equivalents) + 722 capitalized-own-work, but EXCLUDES account
  // 758 ("Alte venituri din exploatare"). EBITDA downstream uses this
  // exact figure, so we must keep `totalOperatingRevenue = revenue +
  // capOwnWork` UNCHANGED — adding 758 here would silently change the
  // EBITDA the rest of the app and the user reads.
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
      accountCode: "706",
      label: "Operating revenue (706/704/707 combined)",
      amount: revenue,
      style: "item",
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
    });
  }
  if (opex > 0) {
    opexLines.push({
      accountCode: "6xx",
      label: "Operating expenses (62x/63x/64x — incl. 628 third-party services)",
      amount: opex,
      style: "item",
    });
  }

  const totalOpexCash = cogs + opex;

  const operatingExpenses: PLSection = {
    header: "OPERATING EXPENSES (excl. D&A)",
    lines: opexLines,
    subtotalLabel: "Total operating expenses (cash)",
    subtotalAmount: totalOpexCash,
  };

  // ── EBITDA (operating view) ──────────────────────────────────────────
  const ebitda = totalOperatingRevenue - totalOpexCash;

  // ── D&A → EBIT ───────────────────────────────────────────────────────
  const depreciationSection: PLSection = {
    header: "",
    lines: dna > 0
      ? [{ accountCode: "6811", label: "Depreciation & amortization", amount: dna, style: "item" }]
      : [],
    subtotalLabel: "EBIT",
    subtotalAmount: ebitda - dna,
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
    lines: [
      { label: "Profit before tax", amount: profitBeforeTax, style: "subtotal" },
      tax > 0
        ? { accountCode: "691", label: "Income tax", amount: tax, style: "item" }
        : null,
    ].filter((l): l is PLLine => l !== null),
    subtotalLabel: "Net profit — operational (excl. 722)",
    subtotalAmount: netProfit,
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
  const keyMargins: PLKeyMargin[] = canonicalMargins
    ? [
        {
          label: "EBITDA margin",
          value: canonicalMargins.ebitdaMargin ?? 0,
          pct: true,
        },
        {
          label: "Net margin",
          value: canonicalMargins.netMargin ?? 0,
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
  };
}
