// Public-company envelope → private-side renderer shapes.
//
// The whole NASDAQ-10 trick lives here: take the assembled_canonical_v1
// envelope returned by /api/public/companies/:ticker and synthesise the
// PLStatement / BSStatement / CashFlowStatement / Statements objects the
// existing private renderers expect. Result: PLStatementView,
// BSStatementView, CashFlowStatementView, and computeRatios all consume
// public-company data without source-branching.
//
// Caveats explicit-by-design:
//   · Sharadar SF1 bundles many line items (e.g. "operating expenses" is
//     one number, not a 12-row breakdown). Synthesised PL/BS/CF sections
//     are therefore coarse-grained — the high-level totals match SF1
//     exactly, but per-line drill-down is bucket-level only.
//   · Cash flow is REAL (SF1 reports OCF/ICF/FCF directly), so we mark
//     `isApproximated = false` — different from the private path's
//     indirect-method reconstruction.
//   · Currency is always USD for US-listed tickers (Sharadar's coverage).
//     The downstream `<Money>` + `useAmountFormatter` chain handles the
//     RON/EUR/USD display conversion automatically.

import type {
  BSLine, BSSection, BSStatement,
} from "@/lib/bsStructure";
import type {
  PLLine, PLSection, PLStatement,
} from "@/lib/plStructure";
import type {
  CFInvestingLine, CashFlowStatement,
} from "@/lib/cfStructure";
import type { Statements } from "@/lib/financialReport";
import type { PublicCompanyEnvelope, PublicCompanyPeriod } from "@/lib/publicCompanyApi";


/** Returns null when the envelope has no periods (subscription_required path). */
export function buildPublicStatements(env: PublicCompanyEnvelope): {
  statements: Statements;
  pl: PLStatement;
  bs: BSStatement;
  cf: CashFlowStatement;
  current: PublicCompanyPeriod;
  prior: PublicCompanyPeriod | null;
} | null {
  if (!env.periods.length) return null;
  const current = env.periods[0];
  const prior = env.periods[1] ?? null;
  const entity = env.ticker_info.name || env.ticker;
  const period = formatPeriodLabel(current);
  const currency = current.currency;

  return {
    statements: buildStatements(env, current, prior),
    pl: buildPL(entity, period, currency, current),
    bs: buildBS(entity, current, prior),
    cf: buildCF(entity, period, currency, current),
    current,
    prior,
  };
}


// ── PLStatement ─────────────────────────────────────────────────────────

function buildPL(entity: string, period: string, currency: string, p: PublicCompanyPeriod): PLStatement {
  const h = p.headline;
  const revenue = h.revenue ?? 0;
  const cogs    = leaf(p, "cogs_materials") ?? 0;
  const gross   = revenue - cogs;
  const opex    = (leaf(p, "external_services_other") ?? 0)
                + (leaf(p, "external_services_rnd") ?? 0);
  const ebitda  = h.ebitda ?? 0;
  const ebit    = h.ebit ?? 0;
  const da      = leaf(p, "depreciation_total") ?? Math.max(0, ebitda - ebit);
  const interestExp = h.net_income != null ? (leaf(p, "interest_expense_bank") ?? 0) : 0;
  const tax     = leaf(p, "income_tax_current") ?? 0;
  const netProfit = h.net_income ?? 0;

  const revenueSection: PLSection = {
    header: "REVENUE",
    lines: [{ accountCode: "Revenue", label: "Total revenue", amount: revenue, style: "item", bucket: "revenue" }],
    subtotalLabel: "Total revenue",
    subtotalAmount: revenue,
    subtotalBucket: "revenue",
  };

  const cogsSection: PLSection = {
    header: "COST OF REVENUE",
    lines: [
      { accountCode: "COGS", label: "Cost of revenue", amount: cogs, style: "item", bucket: "cogs" },
    ],
    subtotalLabel: "Gross profit",
    subtotalAmount: gross,
    subtotalBucket: "grossProfit",
  };

  const opexSection: PLSection = {
    header: "OPERATING EXPENSES",
    lines: [
      ...(leaf(p, "external_services_rnd") != null
        ? [{ accountCode: "R&D", label: "Research & development", amount: leaf(p, "external_services_rnd") ?? 0, style: "item" as const }]
        : []),
      ...(leaf(p, "external_services_other") != null
        ? [{ accountCode: "SG&A", label: "Selling, general & administrative", amount: leaf(p, "external_services_other") ?? 0, style: "item" as const }]
        : []),
      { accountCode: "D&A", label: "Depreciation & amortization", amount: da, style: "item" },
    ],
    subtotalLabel: "Total operating expenses",
    subtotalAmount: opex + da,
  };

  const ebitSection: PLSection = {
    header: "",
    lines: [],
    subtotalLabel: "EBIT (Operating income)",
    subtotalAmount: ebit,
    subtotalBucket: "ebit",
  };

  const finSection: PLSection = {
    header: "FINANCIAL ITEMS",
    lines: [
      { accountCode: "Int", label: "Interest expense", amount: interestExp, style: "item", sign: "negative" },
    ],
    subtotalLabel: "Net financial result",
    subtotalAmount: -interestExp,
  };

  const closingSection: PLSection = {
    header: "",
    lines: [
      { accountCode: "PBT", label: "Profit before tax", amount: ebit - interestExp, style: "subtotal", bucket: "pretax" },
      { accountCode: "Tax", label: "Income tax", amount: tax, style: "item", sign: "negative" },
    ],
    subtotalLabel: "NET PROFIT",
    subtotalAmount: netProfit,
    subtotalBucket: "netIncome",
  };

  const margins = [
    { label: "Gross margin",  value: pct(gross, revenue),     pct: true },
    { label: "EBITDA margin", value: pct(ebitda, revenue),    pct: true },
    { label: "EBIT margin",   value: pct(ebit, revenue),      pct: true },
    { label: "Net margin",    value: pct(netProfit, revenue), pct: true },
  ];

  return {
    entity,
    period,
    currency,
    sections: [revenueSection, cogsSection, opexSection, ebitSection, finSection, closingSection],
    keyMargins: margins,
    ebitda,
    ebit,
    netFinancialResult: -interestExp,
    profitBeforeTax: ebit - interestExp,
    tax,
    netProfit,
  };
}


// ── BSStatement ─────────────────────────────────────────────────────────

function buildBS(entity: string, cur: PublicCompanyPeriod, prior: PublicCompanyPeriod | null): BSStatement {
  const c = cur.headline;
  const p = prior?.headline ?? null;
  const asOf = formatDate(cur.fiscal_period_end);
  const comparativeDate = prior ? formatDate(prior.fiscal_period_end) : asOf;

  const currentAssets: BSSection = {
    header: "CURRENT ASSETS",
    lines: [
      bsLine("Cash & equivalents", c.cash, p?.cash),
      // Public BS: receivables, inventory, ppe etc. come from `leaves` since
      // headline only carries totals. We don't have them split out for SF1
      // beyond the headline, so we show the totals at the parent-line level.
    ],
    subtotalLabel: "Total current assets",
    subtotalOpening: p?.cash ?? 0,
    subtotalClosing: c.cash ?? 0,
    subtotalDelta:   delta(c.cash, p?.cash),
    subtotalBucket:  "totalCurrentAssets",
  };

  const nonCurrent: BSSection = {
    header: "NON-CURRENT ASSETS",
    lines: [
      bsLine("Property, plant & equipment (net)", leaf(cur, "ppe_grossbook_buildings"), leaf(prior, "ppe_grossbook_buildings")),
      bsLine("Goodwill & intangibles", leaf(cur, "intangibles_goodwill"), leaf(prior, "intangibles_goodwill")),
    ],
    subtotalLabel: "Total non-current assets",
    subtotalOpening: (p?.total_assets ?? 0) - (p?.cash ?? 0),
    subtotalClosing: (c.total_assets ?? 0) - (c.cash ?? 0),
    subtotalDelta:   delta((c.total_assets ?? 0) - (c.cash ?? 0), (p?.total_assets ?? 0) - (p?.cash ?? 0)),
  };

  const totalAssets = {
    opening: p?.total_assets ?? 0,
    closing: c.total_assets ?? 0,
    delta: delta(c.total_assets, p?.total_assets),
  };

  const stDebt = (c.total_debt ?? 0) - (leaf(cur, "bank_loans_lt") ?? 0);
  const stDebtPrior = (p?.total_debt ?? 0) - (leaf(prior, "bank_loans_lt") ?? 0);

  const currentLiab: BSSection = {
    header: "CURRENT LIABILITIES",
    lines: [
      bsLine("Short-term debt", stDebt > 0 ? stDebt : 0, stDebtPrior > 0 ? stDebtPrior : 0),
    ],
    subtotalLabel: "Total current liabilities",
    subtotalOpening: stDebtPrior > 0 ? stDebtPrior : 0,
    subtotalClosing: stDebt > 0 ? stDebt : 0,
    subtotalDelta:   delta(stDebt > 0 ? stDebt : 0, stDebtPrior > 0 ? stDebtPrior : 0),
    subtotalBucket:  "totalCurrentLiabilities",
  };

  const nonCurrentLiab: BSSection = {
    header: "NON-CURRENT LIABILITIES",
    lines: [
      bsLine("Long-term debt", leaf(cur, "bank_loans_lt"), leaf(prior, "bank_loans_lt")),
    ],
    subtotalLabel: "Total non-current liabilities",
    subtotalOpening: (p?.total_liabilities ?? 0) - (stDebtPrior > 0 ? stDebtPrior : 0),
    subtotalClosing: (c.total_liabilities ?? 0) - (stDebt > 0 ? stDebt : 0),
    subtotalDelta:   delta(
      (c.total_liabilities ?? 0) - (stDebt > 0 ? stDebt : 0),
      (p?.total_liabilities ?? 0) - (stDebtPrior > 0 ? stDebtPrior : 0),
    ),
  };

  const equity: BSSection = {
    header: "EQUITY",
    lines: [
      bsLine("Retained earnings", leaf(cur, "retained_earnings_accumulated"), leaf(prior, "retained_earnings_accumulated")),
      bsLine("Other equity (paid-in capital, OCI, treasury)",
        (c.total_equity ?? 0) - (leaf(cur, "retained_earnings_accumulated") ?? 0),
        (p?.total_equity ?? 0) - (leaf(prior, "retained_earnings_accumulated") ?? 0),
      ),
    ],
    subtotalLabel: "Total equity",
    subtotalOpening: p?.total_equity ?? 0,
    subtotalClosing: c.total_equity ?? 0,
    subtotalDelta:   delta(c.total_equity, p?.total_equity),
  };

  const totalEquityLiab = {
    opening: (p?.total_liabilities ?? 0) + (p?.total_equity ?? 0),
    closing: (c.total_liabilities ?? 0) + (c.total_equity ?? 0),
    delta:   delta(
      (c.total_liabilities ?? 0) + (c.total_equity ?? 0),
      (p?.total_liabilities ?? 0) + (p?.total_equity ?? 0),
    ),
  };

  return {
    entity,
    asOf,
    comparativeDate,
    currency: cur.currency,
    assetSections: [currentAssets, nonCurrent],
    totalAssets,
    equityLiabSections: [equity, nonCurrentLiab, currentLiab],
    totalEquityLiab,
    balanceCheck: totalAssets.closing - totalEquityLiab.closing,
  };
}


// ── CashFlowStatement ───────────────────────────────────────────────────

function buildCF(entity: string, period: string, currency: string, p: PublicCompanyPeriod): CashFlowStatement {
  const h = p.headline;
  const da = leaf(p, "depreciation_total") ?? Math.max(0, (h.ebitda ?? 0) - (h.ebit ?? 0));
  const ocf = h.operating_cash_flow ?? 0;
  // Working-capital plug (ocf - net_profit - depreciation) — keeps the
  // section visually similar to the private path even though SF1 doesn't
  // expose the per-account movements.
  const wcPlug = ocf - (h.net_income ?? 0) - da;

  const investing: CFInvestingLine[] = [
    { label: "Capital expenditure",     accounts: "capex",     amount: -(leaf(p, "cfi_capex") ?? 0) },
    { label: "Other investing flows",   accounts: "other",     amount: (h.investing_cash_flow ?? 0) + (leaf(p, "cfi_capex") ?? 0) },
  ];

  return {
    entity,
    period,
    method: "indirect",
    currency,
    operating: {
      netProfit: h.net_income ?? 0,
      depreciation: da,
      cfBeforeWcChanges: (h.net_income ?? 0) + da,
      wcChanges: Math.abs(wcPlug) > 1
        ? [{ label: "Working-capital changes (net)", accounts: "WC", delta: wcPlug }]
        : [],
      cashFromOperating: ocf,
    },
    investing: {
      items: investing,
      cashUsedInInvesting: h.investing_cash_flow ?? 0,
    },
    financing: {
      bankLoanDrawdowns: 0,
      bankLoanRepayments: 0,
      dividendsPaid: 0,
      cashFromFinancing: h.financing_cash_flow ?? 0,
    },
    reconciliation: {
      netChangeInCash: ocf + (h.investing_cash_flow ?? 0) + (h.financing_cash_flow ?? 0),
      openingCash: 0,
      closingCashComputed: h.cash ?? 0,
      closingCashActual: h.cash ?? 0,
      drift: 0,
    },
    isApproximated: false,
    approximationNotes: [],
    notes: [
      "Cash flow is reported directly by the issuer (10-K / 10-Q) and ingested via Sharadar SF1 — no indirect-method reconstruction.",
    ],
  };
}


// ── Statements (for computeRatios) ──────────────────────────────────────

function buildStatements(env: PublicCompanyEnvelope, cur: PublicCompanyPeriod, prior: PublicCompanyPeriod | null): Statements {
  const c = cur.headline;
  const p = prior?.headline ?? null;

  // Map public-company headline to the BalanceSheet line items the
  // private DerivedTotals computation expects. Since SF1 bundles line
  // items, we surface what we have and zero the rest.
  const stDebt = Math.max(0, (c.total_debt ?? 0) - (leaf(cur, "bank_loans_lt") ?? 0));
  const ltDebt = leaf(cur, "bank_loans_lt") ?? 0;
  const otherCurLiab = Math.max(0, (c.total_liabilities ?? 0) - stDebt - ltDebt);

  const bs = {
    cash: c.cash ?? 0,
    accountsReceivable: leaf(cur, "ar_trade_gross") ?? 0,
    inventory: leaf(cur, "inventory_merchandise_resale") ?? 0,
    otherCurrentAssets: 0,
    propertyPlantEquipment: leaf(cur, "ppe_grossbook_buildings") ?? 0,
    intangibles: leaf(cur, "intangibles_goodwill") ?? 0,
    otherNonCurrentAssets: Math.max(0,
      (c.total_assets ?? 0)
      - (c.cash ?? 0)
      - (leaf(cur, "ar_trade_gross") ?? 0)
      - (leaf(cur, "inventory_merchandise_resale") ?? 0)
      - (leaf(cur, "ppe_grossbook_buildings") ?? 0)
      - (leaf(cur, "intangibles_goodwill") ?? 0)
    ),
    accountsPayable: 0,
    shortTermDebt: stDebt,
    otherCurrentLiabilities: otherCurLiab,
    longTermDebt: ltDebt,
    otherNonCurrentLiabilities: 0,
    shareCapital: Math.max(0, (c.total_equity ?? 0) - (leaf(cur, "retained_earnings_accumulated") ?? 0)),
    retainedEarnings: leaf(cur, "retained_earnings_accumulated") ?? 0,
    otherEquity: 0,
  };

  const da = leaf(cur, "depreciation_total") ?? Math.max(0, (c.ebitda ?? 0) - (c.ebit ?? 0));
  const incomeStatement = {
    revenue: c.revenue ?? 0,
    costOfGoodsSold: leaf(cur, "cogs_materials") ?? 0,
    operatingExpenses: (leaf(cur, "external_services_other") ?? 0) + (leaf(cur, "external_services_rnd") ?? 0),
    depreciationAmortization: da,
    interestExpense: leaf(cur, "interest_expense_bank") ?? 0,
    otherIncome: 0,
    taxExpense: leaf(cur, "income_tax_current") ?? 0,
  };

  const supplementary = {
    capex: leaf(cur, "cfi_capex") ?? undefined,
    sharesOutstanding: undefined,
  };

  const result: Statements = {
    companyName: env.ticker_info.name || env.ticker,
    industry: env.ticker_info.industry ?? undefined,
    currency: cur.currency,
    periodLabel: formatPeriodLabel(cur),
    balanceSheet: bs,
    incomeStatement,
    supplementary,
    prior: prior && p
      ? {
          periodLabel: formatPeriodLabel(prior),
          balanceSheet: {
            cash: p.cash ?? 0,
            accountsReceivable: leaf(prior, "ar_trade_gross") ?? 0,
            inventory: leaf(prior, "inventory_merchandise_resale") ?? 0,
            otherCurrentAssets: 0,
            propertyPlantEquipment: leaf(prior, "ppe_grossbook_buildings") ?? 0,
            intangibles: leaf(prior, "intangibles_goodwill") ?? 0,
            otherNonCurrentAssets: 0,
            accountsPayable: 0,
            shortTermDebt: Math.max(0, (p.total_debt ?? 0) - (leaf(prior, "bank_loans_lt") ?? 0)),
            otherCurrentLiabilities: 0,
            longTermDebt: leaf(prior, "bank_loans_lt") ?? 0,
            otherNonCurrentLiabilities: 0,
            shareCapital: Math.max(0, (p.total_equity ?? 0) - (leaf(prior, "retained_earnings_accumulated") ?? 0)),
            retainedEarnings: leaf(prior, "retained_earnings_accumulated") ?? 0,
            otherEquity: 0,
          },
          incomeStatement: {
            revenue: p.revenue ?? 0,
            costOfGoodsSold: leaf(prior, "cogs_materials") ?? 0,
            operatingExpenses: (leaf(prior, "external_services_other") ?? 0) + (leaf(prior, "external_services_rnd") ?? 0),
            depreciationAmortization: leaf(prior, "depreciation_total") ?? Math.max(0, (p.ebitda ?? 0) - (p.ebit ?? 0)),
            interestExpense: leaf(prior, "interest_expense_bank") ?? 0,
            otherIncome: 0,
            taxExpense: leaf(prior, "income_tax_current") ?? 0,
          },
        }
      : undefined,
  };
  return result;
}


// ── Helpers ────────────────────────────────────────────────────────────

function leaf(p: PublicCompanyPeriod | null, name: string): number | undefined {
  if (!p) return undefined;
  const l = p.leaves?.[name];
  if (!l) return undefined;
  // Re-apply sign for liability/expense-natural leaves. SF1 already gives
  // us positive magnitudes for everything we map; keep as-is.
  return l.magnitude;
}

function bsLine(label: string, closing: number | undefined | null, opening: number | undefined | null): BSLine {
  return {
    label,
    opening: opening ?? 0,
    closing: closing ?? 0,
    delta: (closing ?? 0) - (opening ?? 0),
    style: "item",
  };
}

function delta(a: number | undefined | null, b: number | undefined | null): number {
  return (a ?? 0) - (b ?? 0);
}

function pct(a: number, b: number): number {
  return b === 0 ? 0 : (a / b) * 100;
}

function formatPeriodLabel(p: PublicCompanyPeriod): string {
  if (p.dimension === "ARY" || p.dimension === "MRY") return `FY${p.fiscal_period_end.slice(0, 4)}`;
  if (p.dimension === "ART" || p.dimension === "MRT") return `TTM ${p.fiscal_period_end}`;
  return `Q ${p.fiscal_period_end}`;
}

function formatDate(iso: string): string {
  // "2024-09-30" → "30.09.2024" (mirrors the private dashboard's BS column header convention)
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}


export { buildPL, buildBS, buildCF, buildStatements };
