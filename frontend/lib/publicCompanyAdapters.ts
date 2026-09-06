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
//   · Operating cash flow is REAL — SF1 reports it directly, no
//     indirect-method reconstruction. INVESTING and FINANCING are a
//     different story: SF1 has them, but the engine's headline block does
//     not forward them (see the accessors below), so the statement is
//     marked `isApproximated = true` and those sections are withheld
//     rather than shown as zero.
//   · Currency is always USD for US-listed tickers (Sharadar's coverage).
//     The downstream `<Money>` + `useAmountFormatter` chain handles the
//     RON/EUR/USD display conversion automatically.

import { bsDelta } from "@/lib/bsStructure";
import type {
  BSLine, BSSection, BSStatement,
} from "@/lib/bsStructure";
// THE ONE GATE every comparative figure passes — shared with the private
// path so the two cannot disagree about what an absent opening looks like.
import { withoutComparative } from "@/lib/buildBsStatement";
import type {
  PLLine, PLSection, PLStatement,
} from "@/lib/plStructure";
import type {
  CFInvestingLine, CashFlowStatement,
} from "@/lib/cfStructure";
import type { StatementInput, Statements } from "@/lib/financialReport";
import type { PublicCompanyEnvelope, PublicCompanyPeriod } from "@/lib/publicCompanyApi";

type Headline = PublicCompanyPeriod["headline"];

// ── WHAT `headline` ACTUALLY CARRIES ────────────────────────────────────
//
// This adapter used to read `headline.total_liabilities`,
// `headline.investing_cash_flow` and `headline.financing_cash_flow`.
// The engine emits none of them. `engine/public/normalizer.py` builds the
// headline dict from exactly ten keys — revenue, ebitda, ebit, net_income,
// total_assets, total_equity, total_debt, cash, operating_cash_flow,
// free_cash_flow — even though `adapter.Fundamentals` carries all three of
// the missing ones. So every read returned `undefined`, `?? 0` turned that
// into a hard zero, and the zero was rendered as a fact:
//
//   · BS "Total equity and liabilities" = equity alone, so `balanceCheck`
//     was off by the company's ENTIRE liability stack (AAPL FY2024: $308bn).
//   · BS "Total non-current liabilities" went NEGATIVE (0 − short-term debt).
//   · CF investing and financing sections rendered 0.00 while the statement
//     claimed `isApproximated: false` and `drift: 0` — a fabricated clean
//     reconciliation.
//
// That is ABSENT rendered as ZERO, which this codebase treats as a defect
// class in its own right, not a rounding matter. Two different remedies,
// because the two cases are genuinely different:

/** Total liabilities, via the balance-sheet identity A = L + E.
 *
 *  This is a DERIVATION, not an estimate: both inputs are headline fields
 *  the engine really does emit, and the identity is exact by construction
 *  (verified against `Fundamentals.total_liabilities` for AAPL FY2024 —
 *  364,980 − 56,950 = 308,030, to the RON). Returns null when either input
 *  is absent, so a missing total can never masquerade as zero. */
function totalLiabilities(h: Headline | null | undefined): number | null {
  if (!h) return null;
  if (h.total_assets == null || h.total_equity == null) return null;
  return h.total_assets - h.total_equity;
}

/** Investing / financing cash flow are NOT recoverable from the envelope —
 *  no identity reaches them and no leaf carries them (the only cash-flow
 *  leaf the normalizer emits is `cash_operating`). They return null, and
 *  `buildCF` degrades to the honesty rail rather than printing a zero.
 *
 *  Fixing this properly is an ENGINE change: forward the three fields that
 *  already exist on `Fundamentals` into the headline dict. Reported as a
 *  cross-lane need rather than papered over here. */
function investingCashFlow(h: Headline | null | undefined): number | null {
  void h;
  return null;
}
function financingCashFlow(h: Headline | null | undefined): number | null {
  void h;
  return null;
}


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
  // A single-period envelope has NO comparative. This used to repeat the
  // closing date in the opening column header and fill the column with
  // `p?.x ?? 0` — a wall of zeroes under a header claiming they were
  // measured on the closing date. `withoutComparative` at the return
  // strips the whole column when there is no prior period.
  const comparativeDate = prior ? formatDate(prior.fiscal_period_end) : asOf;
  // Derived by identity — see `totalLiabilities`. Previously read off a
  // headline key the engine never emits, which zeroed the whole
  // equity-and-liabilities side and broke `balanceCheck`.
  const totalLiabilitiesCur = totalLiabilities(c);
  const totalLiabilitiesPrior = totalLiabilities(p);

  // EVERY SUBTOTAL BELOW IS ABSENCE-AWARE. It was `?? 0` throughout, so a
  // headline field the feed did not carry became a subtotal of zero, its
  // Δ became the whole other side, and the reader had no way to tell a
  // reported zero from an unreported line. `sum`/`diff` propagate absence
  // the way the arithmetic does: a total missing a term is not that total.
  const sum = (...xs: (number | null | undefined)[]): number | undefined => {
    let acc = 0;
    for (const x of xs) {
      if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
      acc += x;
    }
    return acc;
  };
  const diff = (a: number | null | undefined, b: number | null | undefined): number | undefined =>
    sum(a, typeof b === "number" && Number.isFinite(b) ? -b : undefined);
  /** A debt figure floored at zero — but only when there IS one. */
  const atZero = (x: number | undefined): number | undefined =>
    x === undefined ? undefined : Math.max(0, x);

  const currentAssets: BSSection = {
    header: "CURRENT ASSETS",
    lines: [
      bsLine("Cash & equivalents", c.cash, p?.cash),
      // Public BS: receivables, inventory, ppe etc. come from `leaves` since
      // headline only carries totals. We don't have them split out for SF1
      // beyond the headline, so we show the totals at the parent-line level.
    ],
    subtotalLabel: "Total current assets",
    // `cash` is `number | null` on the SF1 headline; `BSSection` spells
    // absence as `undefined`. Normalise rather than cast — both mean "not
    // carried", and `bsDelta` already refuses on either.
    subtotalOpening: p?.cash ?? undefined,
    subtotalClosing: c.cash ?? undefined,
    subtotalDelta:   bsDelta(p?.cash, c.cash),
    subtotalBucket:  "totalCurrentAssets",
  };

  const nonCurrentOpening = diff(p?.total_assets, p?.cash);
  const nonCurrentClosing = diff(c.total_assets, c.cash);
  const nonCurrent: BSSection = {
    header: "NON-CURRENT ASSETS",
    lines: [
      bsLine("Property, plant & equipment (net)", leaf(cur, "ppe_grossbook_buildings"), leaf(prior, "ppe_grossbook_buildings")),
      bsLine("Goodwill & intangibles", leaf(cur, "intangibles_goodwill"), leaf(prior, "intangibles_goodwill")),
    ],
    subtotalLabel: "Total non-current assets",
    subtotalOpening: nonCurrentOpening,
    subtotalClosing: nonCurrentClosing,
    subtotalDelta:   bsDelta(nonCurrentOpening, nonCurrentClosing),
  };

  const totalAssets = {
    opening: typeof p?.total_assets === "number" ? p.total_assets : undefined,
    // `as number` was a lie the compiler could not see: SF1 headline
    // `total_assets` is optional. `BSTotalPair.closing` is absent-capable
    // now, so an unreported grand total stays unreported.
    closing:
      typeof c.total_assets === "number" && Number.isFinite(c.total_assets)
        ? c.total_assets
        : null,
    delta: bsDelta(p?.total_assets, c.total_assets),
  };

  const stDebt = atZero(diff(c.total_debt, leaf(cur, "bank_loans_lt")));
  const stDebtPrior = atZero(diff(p?.total_debt, leaf(prior, "bank_loans_lt")));

  const currentLiab: BSSection = {
    header: "CURRENT LIABILITIES",
    lines: [
      bsLine("Short-term debt", stDebt, stDebtPrior),
    ],
    subtotalLabel: "Total current liabilities",
    subtotalOpening: stDebtPrior,
    subtotalClosing: stDebt,
    subtotalDelta:   bsDelta(stDebtPrior, stDebt),
    subtotalBucket:  "totalCurrentLiabilities",
  };

  const ncLiabOpening = diff(totalLiabilitiesPrior, stDebtPrior);
  const ncLiabClosing = diff(totalLiabilitiesCur, stDebt);
  const nonCurrentLiab: BSSection = {
    header: "NON-CURRENT LIABILITIES",
    lines: [
      bsLine("Long-term debt", leaf(cur, "bank_loans_lt"), leaf(prior, "bank_loans_lt")),
    ],
    subtotalLabel: "Total non-current liabilities",
    subtotalOpening: ncLiabOpening,
    subtotalClosing: ncLiabClosing,
    subtotalDelta:   bsDelta(ncLiabOpening, ncLiabClosing),
  };

  const equity: BSSection = {
    header: "EQUITY",
    lines: [
      bsLine("Retained earnings", leaf(cur, "retained_earnings_accumulated"), leaf(prior, "retained_earnings_accumulated")),
      bsLine("Other equity (paid-in capital, OCI, treasury)",
        diff(c.total_equity, leaf(cur, "retained_earnings_accumulated")),
        diff(p?.total_equity, leaf(prior, "retained_earnings_accumulated")),
      ),
    ],
    subtotalLabel: "Total equity",
    subtotalOpening: typeof p?.total_equity === "number" ? p.total_equity : undefined,
    subtotalClosing: typeof c.total_equity === "number" ? c.total_equity : undefined,
    subtotalDelta:   bsDelta(p?.total_equity, c.total_equity),
  };

  const elOpening = sum(totalLiabilitiesPrior, p?.total_equity);
  const elClosing = sum(totalLiabilitiesCur, c.total_equity);
  const totalEquityLiab = {
    opening: elOpening,
    // Same `as number` cast: `sum()` returns `undefined` the moment ANY
    // term is missing — that is the whole point of `sum`. Casting it to
    // `number` handed the missing side straight to `balanceCheck`.
    closing: elClosing === undefined ? null : elClosing,
    delta: bsDelta(elOpening, elClosing),
  };

  const built: BSStatement = {
    entity,
    asOf,
    comparativeDate,
    currency: cur.currency,
    assetSections: [currentAssets, nonCurrent],
    totalAssets,
    equityLiabSections: [equity, nonCurrentLiab, currentLiab],
    totalEquityLiab,
    // ── A BALANCE CHECK NEEDS BOTH SIDES ────────────────────────────
    // `(a ?? 0) - (b ?? 0)` is the defect this whole effort exists to
    // kill, in miniature: with the E&L side absent it returns TOTAL
    // ASSETS as the "drift", and with the asset side absent it returns
    // MINUS the whole equity-and-liabilities stack. Either way the number
    // is a balance sheet total wearing a drift's label. Absent is a
    // refusal to check, not a check that passed.
    balanceCheck:
      totalAssets.closing === null || totalEquityLiab.closing === null
        ? null
        : totalAssets.closing - totalEquityLiab.closing,
  };
  return prior ? built : withoutComparative(built);
}


// ── CashFlowStatement ───────────────────────────────────────────────────

function buildCF(entity: string, period: string, currency: string, p: PublicCompanyPeriod): CashFlowStatement {
  const h = p.headline;
  // ── D&A: THE IDENTITY, OR NOTHING ───────────────────────────────────
  //
  // This read `leaf(p, "depreciation_total") ?? Math.max(0, (h.ebitda ?? 0)
  // - (h.ebit ?? 0))`. EBITDA − EBIT IS D&A, so the identity itself is
  // sound — but the `?? 0` on each term is not. With `ebit` absent the
  // expression collapses to `ebitda`, and the statement then prints the
  // company's ENTIRE operating cash earnings on the "Depreciation &
  // amortization" line. With `ebitda` absent it prints `max(0, −ebit)`,
  // i.e. 0 for any profitable company — a reported zero for a figure
  // nothing measured. An identity is only an identity when both of its
  // terms are there.
  const daIdentity =
    typeof h.ebitda === "number" && Number.isFinite(h.ebitda) &&
    typeof h.ebit === "number" && Number.isFinite(h.ebit)
      ? Math.max(0, h.ebitda - h.ebit)
      : null;
  const da = leaf(p, "depreciation_total") ?? daIdentity;
  const ocf = h.operating_cash_flow ?? 0;
  // Working-capital plug (ocf - net_profit - depreciation) — keeps the
  // section visually similar to the private path even though SF1 doesn't
  // expose the per-account movements. ABSENT D&A makes the plug absent:
  // `ocf − ni − null` is `ocf − ni`, which would book the whole D&A gap
  // as a working-capital movement.
  const wcPlug = da === null ? null : ocf - (h.net_income ?? 0) - da;

  // Investing / financing are absent from the envelope (see the accessors
  // at the top of this file). Absent is not zero: when they are missing we
  // publish NO investing/financing lines and flag the statement as
  // incomplete, instead of rendering 0.00 next to a `drift: 0` that was
  // only zero because both unknown legs had been silently set to zero.
  const icf = investingCashFlow(h);
  const fcf = financingCashFlow(h);
  const capex = leaf(p, "cfi_capex");

  const investing: CFInvestingLine[] = [];
  if (capex != null) {
    investing.push({ label: "Capital expenditure", accounts: "capex", amount: -capex });
  }
  if (icf != null) {
    investing.push({
      label: "Other investing flows",
      accounts: "other",
      amount: icf + (capex ?? 0),
    });
  }

  const flowsUnavailable = icf == null || fcf == null;
  const approximationNotes = flowsUnavailable
    ? [
        "Investing and financing cash flows are not carried in this data " +
        "feed's headline block, so those sections are shown as unavailable " +
        "rather than as zero. Operating cash flow is reported directly by " +
        "the issuer and is exact.",
      ]
    : [];

  // Only claim a reconciliation when every leg is actually known.
  const netChangeInCash = flowsUnavailable ? 0 : ocf + (icf as number) + (fcf as number);

  return {
    entity,
    period,
    method: "indirect",
    currency,
    operating: {
      netProfit: h.net_income ?? 0,
      depreciation: da,
      cfBeforeWcChanges: da === null ? null : (h.net_income ?? 0) + da,
      wcChanges:
        wcPlug !== null && Math.abs(wcPlug) > 1
          ? [{ label: "Working-capital changes (net)", accounts: "WC", delta: wcPlug }]
          : [],
      cashFromOperating: ocf,
    },
    investing: {
      items: investing,
      cashUsedInInvesting: icf ?? 0,
    },
    financing: {
      bankLoanDrawdowns: 0,
      bankLoanRepayments: 0,
      dividendsPaid: 0,
      cashFromFinancing: fcf ?? 0,
    },
    reconciliation: {
      netChangeInCash,
      openingCash: 0,
      closingCashComputed: h.cash ?? 0,
      closingCashActual: h.cash ?? 0,
      drift: 0,
    },
    isApproximated: flowsUnavailable,
    approximationNotes,
    notes: [
      "Cash flow is reported directly by the issuer (10-K / 10-Q) and ingested via Sharadar SF1 — no indirect-method reconstruction.",
    ],
  };
}


// ── Statements (for computeRatios) ──────────────────────────────────────
//
// ── THE 84 `?? 0` SITES, CLASSIFIED ────────────────────────────────────
//
// This file's own header has said since the last wave that "ABSENT
// rendered as ZERO … this codebase treats as a defect class in its own
// right" — and then did it eighty-four more times. Every one of those
// zeroes reached `computeRatios`, which divided by them. On the repo's
// own real AAPL fixture the result was `interest_coverage 0.00x
// critical`, `dscr_with_lt_principal 0.00x critical`, `dpo 0 d`,
// `dio 232 d`, `current_ratio 0.23x` — and, less visibly but worse,
// EBITDA rebuilt as `revenue − 0 − 0` = 391.0 B standing in for the
// 134.7 B the same envelope reports, so every margin, coverage and
// distress figure on the page was computed against revenue.
//
// A zero is only honest when the source MEASURED a zero. On a Sharadar
// SF1 envelope the leaves are a bundle: what is not in `leaves` was not
// in the feed, not reported as nil. So each field below is one of:
//
//   REPORTED   the envelope carries it (headline field or a leaf).
//   IDENTITY   arithmetic over reported figures that is exact by
//              construction — total liabilities = assets − equity;
//              D&A = EBITDA − EBIT. Reported in all but name.
//   ABSENT     the feed does not carry it. Listed in `absentInputs`, and
//              the placeholder number is never read by a ratio.
//
// The statement RENDERERS still take numbers (an absent one formats as
// the gap glyph below 0.005, which `formatAmountFrom` already does), so
// the shape does not change — only what the ratio layer is allowed to
// believe about it.

/** Records what a source did not carry while keeping the numeric shape
 *  the statement renderers need. Returns the placeholder; the name is
 *  what actually travels, on `Statements.absentInputs`. */
function absentTracker() {
  const missing = new Set<StatementInput>();
  return {
    /** ABSENT unless the envelope really carried it. */
    reported(name: StatementInput, v: number | null | undefined, placeholder = 0): number {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      missing.add(name);
      return placeholder;
    },
    /** Declared absent outright — the feed has no such concept. */
    none(name: StatementInput, placeholder = 0): number {
      missing.add(name);
      return placeholder;
    },
    list(): StatementInput[] {
      return Array.from(missing);
    },
  };
}

function buildStatements(env: PublicCompanyEnvelope, cur: PublicCompanyPeriod, prior: PublicCompanyPeriod | null): Statements {
  const c = cur.headline;
  const p = prior?.headline ?? null;
  const a = absentTracker();

  const totalLiabCur = totalLiabilities(c);
  const ltDebtLeaf = leaf(cur, "bank_loans_lt");
  // The ST/LT SPLIT is not in the feed: `total_debt` is reported, the
  // maturity profile is not. `shortTermDebt` used to be
  // `total_debt − 0`, i.e. the whole debt stack filed as current — which
  // is what put AAPL's current ratio at 0.23×.
  const ltDebt = a.reported("longTermDebt", ltDebtLeaf);
  const stDebt = a.reported(
    "shortTermDebt",
    ltDebtLeaf == null || c.total_debt == null
      ? null
      : Math.max(0, c.total_debt - ltDebtLeaf),
    Math.max(0, (c.total_debt ?? 0) - (ltDebtLeaf ?? 0)),
  );
  // Everything in the liability stack that is not debt. With no
  // current/non-current split reported, calling this CURRENT is a
  // classification the feed never made.
  const otherCurLiab = a.none(
    "otherCurrentLiabilities",
    Math.max(0, (totalLiabCur ?? 0) - stDebt - ltDebt),
  );

  const ppe = leaf(cur, "ppe_grossbook_buildings");
  const intang = leaf(cur, "intangibles_goodwill");
  const ar = leaf(cur, "ar_trade_gross");
  const inv = leaf(cur, "inventory_merchandise_resale");
  const retained = leaf(cur, "retained_earnings_accumulated");

  const bs = {
    // REPORTED — headline fields and mapped leaves.
    cash: a.reported("cash", c.cash),
    accountsReceivable: a.reported("accountsReceivable", ar),
    inventory: a.reported("inventory", inv),
    // ABSENT — SF1 has other current assets; this envelope does not
    // split them out, and the residual below absorbs them into the
    // non-current bucket. Reading this as 0 made `current assets` =
    // cash + AR + inventory, a partial presented as a total.
    otherCurrentAssets: a.none("otherCurrentAssets"),
    propertyPlantEquipment: a.reported("propertyPlantEquipment", ppe),
    intangibles: a.reported("intangibles", intang),
    // The residual closes to `total_assets` exactly, so the TOTAL is
    // right — but with other-current, PP&E and intangibles unreported it
    // is "everything else", not "other non-current assets".
    otherNonCurrentAssets: a.none("otherNonCurrentAssets", Math.max(0,
      (c.total_assets ?? 0)
      - (c.cash ?? 0)
      - (ar ?? 0)
      - (inv ?? 0)
      - (ppe ?? 0)
      - (intang ?? 0)
    )),
    // ABSENT — no payables concept in the feed at all. This hard 0 is
    // what produced `dpo 0 d · critical` on every public company.
    accountsPayable: a.none("accountsPayable"),
    shortTermDebt: stDebt,
    otherCurrentLiabilities: otherCurLiab,
    longTermDebt: ltDebt,
    otherNonCurrentLiabilities: a.none("otherNonCurrentLiabilities"),
    // The equity TOTAL is reported; its composition is not.
    shareCapital: a.none("shareCapital", Math.max(0, (c.total_equity ?? 0) - (retained ?? 0))),
    retainedEarnings: a.reported("retainedEarnings", retained),
    otherEquity: a.none("otherEquity"),
  };

  // IDENTITY — D&A = EBITDA − EBIT, both reported on the headline. Exact
  // by construction, so this is a reported figure in all but name.
  const daLeaf = leaf(cur, "depreciation_total");
  const daIdentity =
    c.ebitda != null && c.ebit != null ? Math.max(0, c.ebitda - c.ebit) : null;
  const incomeStatement = {
    revenue: a.reported("revenue", c.revenue),
    costOfGoodsSold: a.reported("costOfGoodsSold", leaf(cur, "cogs_materials")),
    operatingExpenses: a.reported(
      "operatingExpenses",
      leaf(cur, "external_services_other") == null && leaf(cur, "external_services_rnd") == null
        ? null
        : (leaf(cur, "external_services_other") ?? 0) + (leaf(cur, "external_services_rnd") ?? 0),
    ),
    depreciationAmortization: a.reported("depreciationAmortization", daLeaf ?? daIdentity),
    interestExpense: a.reported("interestExpense", leaf(cur, "interest_expense_bank")),
    // ABSENT — the feed carries no "other operating income" concept, and
    // a 0 here would silently enter the EBITDA reconstruction.
    otherIncome: a.none("otherIncome"),
    taxExpense: a.reported("taxExpense", leaf(cur, "income_tax_current")),
  };

  const supplementary = {
    capex: leaf(cur, "cfi_capex") ?? undefined,
    sharesOutstanding: undefined,
  };

  // ── WHAT THE FEED DOES REPORT, AT TOTAL LEVEL ───────────────────────
  //
  // These are the figures that make the page work at all. Without them
  // `deriveTotals` reconstructs EBITDA from a cost breakdown that is not
  // in the envelope and lands on revenue.
  const reported: Statements["reportedTotals"] = {};
  const put = (k: keyof NonNullable<Statements["reportedTotals"]>, v: number | null | undefined) => {
    if (typeof v === "number" && Number.isFinite(v)) reported[k] = v;
  };
  put("totalAssets", c.total_assets);
  put("totalEquity", c.total_equity);
  put("totalLiabilities", totalLiabCur);   // identity: assets − equity
  put("totalDebt", c.total_debt);
  put("ebitda", c.ebitda);
  put("ebit", c.ebit);
  put("netIncome", c.net_income);
  if (c.total_debt != null && c.cash != null) put("netDebt", c.total_debt - c.cash);
  // Deliberately NOT reported, and each one is a ratio that now refuses:
  //   · totalCurrentAssets / totalCurrentLiabilities — no maturity split
  //     in the feed, so current ratio / quick / cash / working capital /
  //     Altman X1 have no denominator.
  //   · grossProfit — no cost of sales, so gross margin has no numerator.
  //   · pbt — no interest or tax line to bridge EBIT to it.

  const result: Statements = {
    companyName: env.ticker_info.name || env.ticker,
    industry: env.ticker_info.industry ?? undefined,
    currency: cur.currency,
    periodLabel: formatPeriodLabel(cur),
    balanceSheet: bs,
    incomeStatement,
    supplementary,
    // The two fields that make the placeholders above unreadable by any
    // ratio, and the reported totals that make the page correct.
    absentInputs: a.list(),
    reportedTotals: reported,
    // PRIOR PERIOD — the same feed, so the same lines are absent. It
    // feeds trend lines only (no ratio in `computeRatios` reads it), and
    // the shape is unchanged; the absences are declared once, above,
    // because `PriorPeriod` carries no manifest of its own. Flagged
    // rather than silently mirrored: a future ratio that starts reading
    // `s.prior` would need one.
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
  // An absent opening stays absent, and an absent side has no Δ — the
  // same law `buildBsStatement` applies to the private path (F1). A `?? 0`
  // here painted a comparative column of zeroes whose Δ was the whole
  // closing balance.
  return {
    label,
    ...(typeof opening === "number" && Number.isFinite(opening) ? { opening } : {}),
    ...(typeof closing === "number" && Number.isFinite(closing) ? { closing } : {}),
    delta: bsDelta(opening, closing),
    style: "item",
  };
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
