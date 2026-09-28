// Valuation + credit-quality engine.
//
// Pure-TypeScript companion to financialReport.ts. Adds:
//   • Free cash flow estimation (CFO + FCF, with capex assumption)
//   • DCF intrinsic valuation (WACC, explicit-horizon + Gordon terminal)
//   • Graham intrinsic value (classic v=EPS×(8.5+2g) formula, normalized)
//   • Piotroski F-score (9-point quality screen)
//   • Composite credit score (0–100 banded into "AAA" → "D")
//   • EV / EBITDA, EV / Revenue, FCF yield (when market price provided)
//
// The functions below are non-destructive and operate on Statements alone, so
// they fit cleanly behind a tab and a "Download Excel" / "Download PDF" action.

import {
  deriveTotals,
  type Statements,
  type DerivedTotals,
  type PriorPeriod,
} from "./financialReport";
// servedFacts gateway — every BS grand total below (assets / equity /
// liabilities / current splits / working capital) reads the SERVED
// envelope. ⚠ THE ONE INTENTIONAL NUMBER CHANGE of the gateway rollout
// lands in this file: valuation equity (WACC weights, Altman X4, credit
// components, book-equity floors) is now the ADJUSTED
// (reconciliation-inclusive) figure, never raw canonical totals — on
// RECONCILED periods the Valuation tab agrees with the BS tab and both
// exports. deriveTotals survives for P&L concepts and the debt/cash
// decomposition, which canonical_bs does not carry.
import { factsFrom } from "./servedFacts";
import {
  equityRefusalOf, netIncomeRefusalOf, plLevelsOf, readNetProvisions, readRefusal, type ServedRefusal,
} from "./servedOneEbitda";
import { ratioLabelForKey } from "./ratioTable";
import { readCreditRegime, type CreditRegime } from "./creditRegime";

/** The Altman row's name: the one label authority ("Altman Z″", what the
 *  Ratios tab, the report cards and the workbook Ratios sheet print) for
 *  the Z″ variant the engine serves; the variant-spelled fallback for any
 *  other. Two spellings of one measure — `Altman Z"-Score` (U+0022) on one
 *  sheet, `Altman Z″` (U+2033) on another — read as two measures. */
function altmanLabelOf(variant: string): string {
  const fallback = `Altman ${variant}-Score`;
  return variant.replace(/"/g, "″") === "Z″" ? (ratioLabelForKey("altman_z", "en") ?? fallback) : fallback;
}

// ─── FCF / CFO ──────────────────────────────────────────────────────────────

export interface CashFlowSnapshot {
  /** The result built from the accounts (pretax − tax, the one definition);
   *  on a period whose EBITDA the engine refused, the served net income
   *  (account 121). `null` — never NaN, never 0 — when the engine REFUSED
   *  the net result (no account 121, net 711 refused): `refusal` says why,
   *  and CFO and FCF, which walk from it, are refused with it. */
  netIncome: number | null;
  depreciationAmortization: number;
  workingCapitalChange: number;
  cfo: number | null;
  capex: number;
  fcf: number | null;
  refusal: ServedRefusal | null;
}

/** A payload carrying no net result and no refusal of it (no engine period
 *  and no adapter is — stated, never NaN). */
export const NET_RESULT_NOT_SERVED: ServedRefusal = {
  code: "net_income_not_served",
  text: {
    ro: "motorul nu a servit rezultatul net pentru această perioadă",
    en: "the engine served no net result for this period",
  },
};

export function deriveCashFlow(s: Statements): CashFlowSnapshot {
  const t = deriveTotals(s);
  const wcChange = workingCapitalChange(s);
  // A refused EBITDA refuses the build-up of the result too; the served
  // net income (independent of the 711 measurement on an anchored book)
  // is the figure this approximation starts from then. NaN only for a
  // payload carrying neither — which no engine period and no adapter is.
  const servedNi = s.assembled_pl?.net_income_statutory;
  const netIncome =
    t.netIncome ?? (typeof servedNi === "number" && Number.isFinite(servedNi) ? servedNi : null);
  const capex = s.supplementary.capex ?? s.incomeStatement.depreciationAmortization;
  // A REFUSED net result (critic round 3, 2026-09-28) printed NaN down the
  // walk — "CFO NaN", "FCF NaN" in the workbook, a "Cash burning" verdict
  // on the tab. It is refused, with the engine's reason, and so is
  // everything walked from it.
  const refusal = netIncome === null ? (netIncomeRefusalOf(s) ?? NET_RESULT_NOT_SERVED) : null;
  const cfo = netIncome === null ? null : netIncome + s.incomeStatement.depreciationAmortization - wcChange;
  return {
    netIncome,
    depreciationAmortization: s.incomeStatement.depreciationAmortization,
    workingCapitalChange: wcChange,
    cfo,
    capex,
    fcf: cfo === null ? null : cfo - capex,
    refusal,
  };
}

function workingCapitalChange(s: Statements): number {
  if (!s.prior) return 0;
  const cur = deriveTotals(s);
  const priorTotals = deriveTotals({
    ...s,
    balanceSheet: s.prior.balanceSheet,
    incomeStatement: s.prior.incomeStatement,
    // The prior's OWN served P&L (or none) — never the current period's,
    // which `...s` would otherwise carry into the prior's P&L levels.
    assembled_pl: s.prior.assembled_pl,
    periodLabel: s.prior.periodLabel,
    prior: undefined,
  });
  // ΔWC = (current.WC - prior.WC). Positive ΔWC = cash absorbed.
  return cur.workingCapital - priorTotals.workingCapital;
}

// ─── WACC ──────────────────────────────────────────────────────────────────

export interface CostOfCapital {
  riskFreeRate: number;
  equityRiskPremium: number;
  beta: number;
  costOfEquity: number;
  costOfDebtPreTax: number;
  costOfDebtAfterTax: number;
  taxRate: number;
  /** `null` with `refusal` when the engine refused total equity as the
   *  company's book equity (it excludes a refused year's result): the
   *  capital structure — and the WACC weighted on it — is not formed on
   *  the short figure (critic round 3: "Weight equity 100.0 %"). */
  weightOfDebt: number | null;
  weightOfEquity: number | null;
  wacc: number | null;
  refusal: ServedRefusal | null;
}

export function computeCostOfCapital(s: Statements): CostOfCapital {
  const t = deriveTotals(s);
  const sup = s.supplementary;
  // ── ROMANIA-CORRECTED WACC INPUTS (2025-26) ────────────────────────
  // Rf  = 6.75% — Romanian 10Y sovereign in RON
  // ERP = 7.50% — Romania mature EM premium (Damodaran)
  // These replace the prior Western European defaults (4.5% / 5.5%)
  // which produced WACC ~6.26% — materially under-discounting the
  // perpetuity for any RON-denominated entity. Cost of equity at
  // these inputs lands at 14.25%, WACC around 8.5-9% with book
  // capital structure.
  const rf = sup.riskFreeRate ?? 0.0675;
  const erp = sup.equityRiskPremium ?? 0.075;
  const beta = sup.beta ?? 1.0;
  const costOfEquity = rf + beta * erp;
  const impliedTaxRate = t.pbt !== null && t.pbt > 0 ? s.incomeStatement.taxExpense / t.pbt : 0;
  const taxRate = sup.taxRate ?? Math.min(0.25, Math.max(0, impliedTaxRate));
  const impliedKd = t.totalDebt > 0 ? s.incomeStatement.interestExpense / t.totalDebt : 0;
  // Pre-tax Kd floor 5.0% — accounts for currency-risk premium when the
  // lender carries EUR debt against RON cash flow (the EEI pattern).
  const kdPre = sup.costOfDebt ?? Math.max(0.05, impliedKd);
  const kdAfter = kdPre * (1 - taxRate);
  // Book equity via the servedFacts gateway — the ADJUSTED
  // (reconciliation-inclusive) served figure, the documented intentional
  // change of the gateway rollout. Debt keeps the assembled_bs bucket
  // read (canonical_bs carries no debt decomposition).
  const canonBs = s.assembled_bs ?? {};
  const debt = typeof canonBs.total_debt === "number" ? canonBs.total_debt : t.totalDebt;
  // ABSENT equity ≠ equity of 1. `Math.max(null, 1)` is 1, which would
  // put the whole capital structure on debt (wd → 1) and quietly hand the
  // WACC the cost of debt alone. When the envelope carried no equity
  // total, fall back to the aggregated book value rather than to a
  // one-currency-unit company.
  const equityRefusal = equityRefusalOf(s);
  const servedEquity = factsFrom(s).totalEquity();
  const equity = Math.max(servedEquity ?? t.totalEquity, 1);
  const wd = equityRefusal ? null : debt / (debt + equity);
  const we = wd === null ? null : 1 - wd;
  return {
    riskFreeRate: rf,
    equityRiskPremium: erp,
    beta,
    costOfEquity,
    costOfDebtPreTax: kdPre,
    costOfDebtAfterTax: kdAfter,
    taxRate,
    weightOfDebt: wd,
    weightOfEquity: we,
    wacc: we === null || wd === null ? null : we * costOfEquity + wd * kdAfter,
    refusal: equityRefusal,
  };
}

// ─── DCF ───────────────────────────────────────────────────────────────────

export interface DcfYear {
  year: number;
  fcf: number;
  discountFactor: number;
  presentValue: number;
}

export interface DcfResult {
  /** Every figure below is `null` (never NaN) when the DCF is REFUSED —
   *  `refusal` then carries the engine's reason: the net result it walks
   *  from, or the equity its WACC weighs, was refused. */
  refusal: ServedRefusal | null;
  baseFcf: number | null;
  forecastYears: number;
  forecastGrowthRate: number;
  terminalGrowthRate: number;
  wacc: number | null;
  yearByYear: DcfYear[];
  terminalValueUndiscounted: number | null;
  terminalValuePresent: number | null;
  enterpriseValue: number | null;
  netDebt: number;
  equityValue: number | null;
  intrinsicValuePerShare?: number;
  marketPricePerShare?: number;
  upside?: number;
  /** null: EBITDA refused by the engine, or not positive — no multiple. */
  evToEbitda: number | null;
  /** null: the DCF is refused (no enterprise value), or no positive turnover. */
  evToRevenue: number | null;
  /** 3-scenario sensitivity table — Optimistic (−100 bps), Central
   *  (computed), Conservative (+150 bps). Each entry carries its WACC,
   *  enterprise value, and equity value so the Valuation tab can render
   *  the methodology spread directly. */
  scenarios?: Array<{
    label: "Optimistic" | "Central" | "Conservative";
    wacc: number;
    enterpriseValue: number;
    netDebt: number;
    equityValue: number;
  }>;
}

export function runDcf(s: Statements): DcfResult {
  const cf = deriveCashFlow(s);
  const t = deriveTotals(s);
  const sup = s.supplementary;
  const k = computeCostOfCapital(s);
  const horizon = sup.forecastYears ?? 5;
  // ── Default growth assumptions (standing defaults, NOT company-derived) ──
  // Forecast 3.5% per year, terminal 3.0% — conservative RO-market defaults
  // (roughly CPI indexation). A trial balance carries no forward growth data,
  // so unless supplementary.forecastGrowthRate/terminalGrowthRate are set,
  // these apply to every company. UI surfaces that render this DCF must label
  // it an illustrative cross-check (see ValuationPanel + exports), never the
  // primary valuation. Replaces the prior 5.0% / 2.5% defaults that
  // overstated 5-year growth and produced inconsistent perpetuity convergence.
  const g = sup.forecastGrowthRate ?? 0.035;
  const gT = sup.terminalGrowthRate ?? 0.030;
  // ── STABILIZED FCF for the perpetuity ───────────────────────────────
  // The previous bug used `cf.fcf` (one-period FCF) as the perpetuity
  // base. For a development-phase company that includes one-time CIP
  // capex, that produces a negative number → Math.max(_, 0) → 0 → the
  // table rendered Year 1-5 as RON 0 and the DCF "equity value" was
  // just minus-net-debt.
  //
  // DCF needs the recurring run-rate. Stabilized FCF = CFO − maintenance
  // capex; for a stable asset, maintenance capex ≈ D&A. So:
  //     stabilized_fcf = cfo − D&A
  // In the steady state this also equals net income (positive when the
  // statutory P&L is profitable).
  //
  // Prefer the canonical views (`assembled_cf` / `assembled_pl`) when
  // the backend supplied them. Fall back to client-side derivations
  // only when canonical isn't available (sample mode).
  const canonicalCfo = s.assembled_cf?.cash_from_operating;
  const canonicalDep = s.assembled_pl?.depreciation;
  const cfo = typeof canonicalCfo === "number" && Number.isFinite(canonicalCfo) ? canonicalCfo : cf.cfo;
  const dep = typeof canonicalDep === "number"
    ? canonicalDep
    : s.incomeStatement.depreciationAmortization;
  // Net debt — prefer canonical view, else legacy derivation.
  const canonicalDebt = s.assembled_bs?.total_debt;
  const canonicalCash = s.assembled_bs?.cash;
  const netDebtCanonical =
    typeof canonicalDebt === "number" && typeof canonicalCash === "number"
      ? canonicalDebt - canonicalCash
      : t.netDebt;
  // REFUSED (critic round 3, 2026-09-28): no CFO to stabilise (the net
  // result it walks from is refused) or no WACC (the equity it weighs is
  // refused). Every figure is null with the reason — the tab printed
  // "EV / Revenue NaN×" and the workbook twenty NaN cells.
  const dcfRefusal = cfo === null ? (cf.refusal ?? NET_RESULT_NOT_SERVED)
    : k.wacc === null ? k.refusal : null;
  if (dcfRefusal !== null || cfo === null || k.wacc === null) {
    return {
      refusal: dcfRefusal ?? NET_RESULT_NOT_SERVED,
      baseFcf: null, forecastYears: horizon, forecastGrowthRate: g, terminalGrowthRate: gT,
      wacc: k.wacc, yearByYear: [], terminalValueUndiscounted: null, terminalValuePresent: null,
      enterpriseValue: null, netDebt: netDebtCanonical, equityValue: null,
      marketPricePerShare: sup.marketPricePerShare, evToEbitda: null, evToRevenue: null, scenarios: [],
    };
  }
  const waccCentral = k.wacc;
  const stabilizedFcf = cfo - dep;
  // Use stabilized FCF when positive; else floor at zero (DCF on a
  // genuinely loss-making company is undefined and falls to net debt).
  const baseFcf = Math.max(stabilizedFcf, 0);

  const years: DcfYear[] = [];
  let totalPv = 0;
  for (let y = 1; y <= horizon; y++) {
    const fcf = baseFcf * Math.pow(1 + g, y);
    const df = 1 / Math.pow(1 + waccCentral, y);
    const pv = fcf * df;
    years.push({ year: y, fcf, discountFactor: df, presentValue: pv });
    totalPv += pv;
  }

  // Gordon terminal: TV = FCF_{N+1} / (WACC - g_T). Falls back to a 12× FCF
  // exit multiple when WACC ≤ g_T (degenerate).
  const finalYearFcf = years[years.length - 1]?.fcf ?? baseFcf;
  const tvUndisc =
    waccCentral > gT
      ? (finalYearFcf * (1 + gT)) / (waccCentral - gT)
      : finalYearFcf * 12;
  const tvDf = 1 / Math.pow(1 + waccCentral, horizon);
  const tvPv = tvUndisc * tvDf;

  const ev = totalPv + tvPv;
  const equityValue = ev - netDebtCanonical;
  // EV / EBITDA over the ONE EBITDA; null — printed with its reason, never
  // as 0.00× — when the engine refused EBITDA or it is not positive.
  const evToEbitda = t.ebitda !== null && t.ebitda > 0 ? ev / t.ebitda : null;
  // null (never 0.00×) without a positive turnover to divide.
  const evToRevenue = s.incomeStatement.revenue > 0 ? ev / s.incomeStatement.revenue : null;

  let intrinsicPerShare: number | undefined;
  let upside: number | undefined;
  if (sup.sharesOutstanding && sup.sharesOutstanding > 0) {
    intrinsicPerShare = equityValue / sup.sharesOutstanding;
    if (sup.marketPricePerShare && sup.marketPricePerShare > 0) {
      upside = intrinsicPerShare / sup.marketPricePerShare - 1;
    }
  }

  // ── 3-scenario sensitivity table ─────────────────────────────────
  // Optimistic (−100 bps WACC), Central (computed), Conservative
  // (+150 bps). For a Romania-corrected central WACC ~8.5%, this
  // brackets the spread that drives the equity value materially.
  const dcfAt = (waccArg: number) => {
    const wacc = waccArg <= gT ? gT + 0.005 : waccArg;
    let pv = 0;
    let lastFcf = baseFcf;
    for (let y = 1; y <= horizon; y++) {
      const fcf = baseFcf * Math.pow(1 + g, y);
      pv += fcf / Math.pow(1 + wacc, y);
      lastFcf = fcf;
    }
    const termUndisc = (lastFcf * (1 + gT)) / (wacc - gT);
    const termPv = termUndisc / Math.pow(1 + wacc, horizon);
    const evScenario = pv + termPv;
    return {
      wacc,
      enterpriseValue: evScenario,
      netDebt: netDebtCanonical,
      equityValue: evScenario - netDebtCanonical,
    };
  };
  const scenarios: DcfResult["scenarios"] = [
    { label: "Optimistic", ...dcfAt(Math.max(waccCentral - 0.01, gT + 0.005)) },
    { label: "Central", ...dcfAt(waccCentral) },
    { label: "Conservative", ...dcfAt(waccCentral + 0.015) },
  ];

  return {
    refusal: null,
    baseFcf,
    forecastYears: horizon,
    forecastGrowthRate: g,
    terminalGrowthRate: gT,
    wacc: waccCentral,
    yearByYear: years,
    terminalValueUndiscounted: tvUndisc,
    terminalValuePresent: tvPv,
    enterpriseValue: ev,
    netDebt: netDebtCanonical,
    equityValue,
    intrinsicValuePerShare: intrinsicPerShare,
    marketPricePerShare: sup.marketPricePerShare,
    upside,
    evToEbitda,
    evToRevenue,
    scenarios,
  };
}

// ─── Graham intrinsic ──────────────────────────────────────────────────────

export interface GrahamResult {
  /** `null` with `refusal` (never NaN) when the engine refused the net
   *  result Graham capitalises. */
  refusal: ServedRefusal | null;
  eps: number | null;
  growthRate: number;
  bondYield: number;
  intrinsicValuePerShare?: number;
  intrinsicEquityValue: number | null;
  marketCap?: number;
  upside?: number;
  formula: string;
}

/**
 * Graham revised: V = (EPS × (8.5 + 2g) × 4.4) / Y
 * where 4.4 is Graham's reference AAA bond yield (1962) and Y is the current
 * AAA / treasury yield. Falls back to the rate provided in supplementary.
 */
export function runGraham(s: Statements): GrahamResult {
  const t = deriveTotals(s);
  // ── STATUTORY NET INCOME for Graham ────────────────────────────────
  // Graham capitalizes the recurring earnings stream. For Romanian
  // books, that's `net_income_statutory` (includes account 722 capitalized
  // own-work). The legacy `deriveTotals(s).netIncome` reads from the
  // aggregated incomeStatement which is the OPERATIONAL view (excludes
  // 722) — produces -RON 739K for EEI and flips Graham negative.
  //
  // Prefer the canonical statutory NI; fall back to legacy only when
  // canonical isn't present (sample mode).
  const canonicalNi = s.assembled_pl?.net_income_statutory;
  const netIncome =
    typeof canonicalNi === "number" && Number.isFinite(canonicalNi) ? canonicalNi : t.netIncome;
  const shares = s.supplementary.sharesOutstanding;
  const g = (s.supplementary.forecastGrowthRate ?? 0.05) * 100; // pct units
  const yPct = (s.supplementary.riskFreeRate ?? 0.045) * 100;
  if (netIncome === null) {
    // The net result is REFUSED (critic round 3): no NaN capitalised.
    return {
      refusal: netIncomeRefusalOf(s) ?? NET_RESULT_NOT_SERVED,
      eps: null, growthRate: g / 100, bondYield: yPct / 100, intrinsicEquityValue: null,
      formula: "V = (NI × (8.5 + 2g) × 4.4) / Y",
    };
  }
  const eps = shares && shares > 0 ? netIncome / shares : netIncome;
  const fairAggregate = (netIncome * (8.5 + 2 * g) * 4.4) / yPct;
  let perShare: number | undefined;
  let upside: number | undefined;
  let marketCap: number | undefined;
  if (shares && shares > 0) {
    perShare = fairAggregate / shares;
    if (s.supplementary.marketPricePerShare && s.supplementary.marketPricePerShare > 0) {
      marketCap = s.supplementary.marketPricePerShare * shares;
      upside = perShare / s.supplementary.marketPricePerShare - 1;
    }
  }
  return {
    refusal: null,
    eps,
    growthRate: g / 100,
    bondYield: yPct / 100,
    intrinsicValuePerShare: perShare,
    intrinsicEquityValue: fairAggregate,
    marketCap,
    upside,
    formula: "V = (NI × (8.5 + 2g) × 4.4) / Y",
  };
}

// ─── Canonical-view accessors ──────────────────────────────────────────────
//
// Every credit-risk computation below reads from these helpers, not from
// deriveTotals(s).netIncome directly. The legacy aggregated view is the
// OPERATIONAL net income (excludes 722) — using it here is what produces
// the screenshot's 0/9 Piotroski + 0.53 Altman + CC composite. Statutory
// values from `assembled_pl` / `assembled_bs` / `assembled_cf` win when
// the backend populated them (real EEI data path); legacy is the fallback
// for sample-mode without canonical views.

// BS grand totals inside this accessor now flow through the servedFacts
// gateway (see the import note at the top of the file): the equity that
// feeds Altman X4, the credit-score components and every book-equity
// floor is the ADJUSTED served figure — identical to the BS tab, both
// exports and periodFacts to the cent. P&L statutory picks and the
// bucket-level fields (cash, debt, retained earnings) keep their
// assembled_* reads.
/** Did the SOURCE declare this line unreported?
 *
 *  `Statements.absentInputs` is the feed's own manifest of what it does
 *  not carry. `computeRatios` reads it at every leaf; this file did not,
 *  which is how two frontend Altmans came to disagree about whether a
 *  company could be scored at all. One manifest, read by both. */
function declaredAbsent(s: Statements, key: string): boolean {
  return (s.absentInputs ?? []).some((k) => k === key);
}

function canonical(s: Statements): {
  // ── THE P&L LEVELS ARE ABSENT-CAPABLE (the one-EBITDA ruling) ───────
  // On a period whose EBITDA the engine refused (the stock variation could
  // not be measured), EBIT / EBITDA are NULL with the engine's reason on
  // `plRefusal`, and every component that divides them refuses — never a
  // `safeDiv` zero read as "Below covenant".
  netIncomeStatutory: number | null;
  ebitStatutory: number | null;
  /** THE COVERAGE OPERAND — the EBIT the P&L prints (`assembled_pl.ebit`,
   *  the line `ebit + net financial result` foots to pretax from) and the
   *  one the engine's `interest_coverage` row and coverage sub-score divide
   *  (`credit_model.operating_profit`). NOT `ebitStatutory` wherever the
   *  engine served its EBIT: that is `operating_ebit`, the operating VIEW,
   *  which also carries 722 capitalized own work and 767 discounts
   *  received. See `intCov`. */
  ebitCoverage: number | null;
  ebitdaStatutory: number | null;
  cfo: number | null;
  /** The engine's refusal of EBITDA, when it refused it. */
  plRefusal: import("./servedOneEbitda").ServedRefusal | null;
  // ── THE SIX GATEWAY TOTALS ARE ABSENT-CAPABLE ──────────────────────
  // `servedFacts` returns `number | null`; these were typed `number`, so
  // an absent total entered the credit/valuation arithmetic as whatever
  // JavaScript made of it. Typed honestly, every consumer is forced
  // through `safeDiv`'s absent arm (or named by the null-boundary gate).
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  totalCurrentAssets: number | null;
  totalCurrentLiabilities: number | null;
  workingCapital: number | null;
  /** ── ONE AUTHORITY, AND NO `+ 0` ────────────────────────────────────
   *  Absent-capable because BOTH of its terms are. Measured on the real
   *  Scandia corpus, before this was `number`:
   *
   *    delete assembled_bs.current_year_pnl  → Z" 0.20131 → 0.19070
   *    delete assembled_bs.retained_earnings → Z" 0.20131 → 0.18591
   *
   *  Two different Z" scores off the same company and the same book,
   *  produced by which field survived. The first was `+ (… : 0)`: a
   *  substituted zero straight into Altman X2. The second was worse — a
   *  fall-through to `s.balanceSheet.retainedEarnings`, a DIFFERENT
   *  measurement of the same concept (−1,707,355.47 against
   *  −1,956,642.47 on this period), so the deletion did not lose a
   *  number, it swapped one. */
  retainedEarningsPlusCurrent: number | null;
  shareCapital: number;
  totalDebt: number;
  cash: number;
  revenue: number;
  depreciation: number;
  interestExpense: number;
} {
  const t = deriveTotals(s);
  const sf = factsFrom(s);
  const pl = s.assembled_pl ?? {};
  const bs = s.assembled_bs ?? {};
  const cf = s.assembled_cf ?? {};
  /** ── DID THE ENGINE SPEAK FOR THIS PERIOD AT ALL? ──────────────────
   *
   *  The BS-concept authority, chosen ONCE — and deliberately not from
   *  `assembled_bs` alone. Found by the widened gate sweep: with
   *  `assembled_bs` keyed on itself, deleting THE WHOLE OBJECT (a cache
   *  miss, a rebuild that dropped the block) fell through to the
   *  FE-parsed `s.balanceSheet` and moved Z" from 0.20131 to 0.17530 on
   *  the real Scandia corpus, and from 5.33129 to 5.19156 on the
   *  balanced fixture. One level up from the leaf that was already
   *  fixed, same defect.
   *
   *  If ANY engine book arrived, this is an engine-scored period and its
   *  BS concepts come from the engine's BS — a block the engine did not
   *  send makes the concept ABSENT. If NO engine book arrived (sample
   *  datasets, pre-engine periods), `s.balanceSheet` is the only book
   *  there is and it is the authority, complete on its own. That is what
   *  keeps those periods' verdicts intact instead of blanking them. */
  const hasEngineBook =
    (s.assembled_bs !== undefined && s.assembled_bs !== null)
    || (s.canonical_bs !== undefined && s.canonical_bs !== null)
    || (s.assembled_pl !== undefined && s.assembled_pl !== null)
    || (s.assembled_cf !== undefined && s.assembled_cf !== null);
  const hasAssembledBs = s.assembled_bs !== undefined && s.assembled_bs !== null;
  // ── THE FEED'S ABSENCE MANIFEST APPLIES TO X1 TOO ──────────────────
  //
  // `s.absentInputs` was honoured here for ONE line, `retainedEarnings`
  // (below), and for nothing else — so the current side of the book came
  // from `factsFrom(s)`, whose bucket sums add the placeholders the
  // manifest says are unreported. Nobody noticed because the missing
  // retained earnings refused X2 first, and a refused X2 refuses the
  // score. The day retained earnings was read correctly off the public
  // feed, this is what the reader minted for Apple's real FY2024 body:
  //
  //     X1 = −0.650  →  working capital −237 B  →  Z" 2.745, SAFE,
  //     composite 66.6, letter BB+
  //
  // over a "current liabilities" that was the ENTIRE 308 B liability
  // stack (the feed reports no maturity split) and a "current assets"
  // of cash + receivables + inventory with the rest declared absent.
  // Apple's actual working capital that year is about −23 B. A letter
  // on that X1 is a rating built on a placeholder — the fabrication the
  // completeness law exists to refuse. So: when the SOURCE declares
  // absences, a current-side total is the reported total if the feed
  // gave one, else NULL the moment any of its inputs is on the manifest,
  // and working capital needs both sides. The private path declares no
  // manifest — a trial balance is complete by construction — so its
  // numbers do not move. Same shape as `computeRatios`' `gate()`.
  const manifest = new Set<string>(s.absentInputs ?? []);
  const sourceDeclaresAbsence = manifest.size > 0 || s.reportedTotals !== undefined;
  const reportedTotal = (k: "totalCurrentAssets" | "totalCurrentLiabilities"): number | null => {
    const v = s.reportedTotals?.[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const manifestTotal = (
    k: "totalCurrentAssets" | "totalCurrentLiabilities",
    inputs: readonly string[],
    read: () => number | null,
  ): number | null => {
    if (!sourceDeclaresAbsence) return read();
    const reported = reportedTotal(k);
    if (reported !== null) return reported;
    return inputs.some((i) => manifest.has(i)) ? null : read();
  };
  const currentSideAssets = manifestTotal(
    "totalCurrentAssets",
    ["cash", "accountsReceivable", "inventory", "otherCurrentAssets"],
    () => sf.currentAssets(),
  );
  const currentSideLiabilities = manifestTotal(
    "totalCurrentLiabilities",
    ["accountsPayable", "shortTermDebt", "otherCurrentLiabilities"],
    () => sf.currentLiabilities(),
  );
  const currentSide = {
    assets: currentSideAssets,
    liabilities: currentSideLiabilities,
    workingCapital: !sourceDeclaresAbsence
      ? sf.workingCapital()
      : currentSideAssets === null || currentSideLiabilities === null
        ? null
        : currentSideAssets - currentSideLiabilities,
  };
  // A P&L LEVEL THE FEED REPORTS IS READ, NOT REBUILT. `deriveTotals`
  // reconstructs EBITDA as revenue - COGS - opex, and the public feed
  // carries no cost breakdown: on the real AAPL FY2024 body that is an
  // "EBIT" of 379.6 B against the 123.2 B the same envelope reports.
  // `computeRatios` has honoured `reportedTotals` since the absent-not-zero
  // lane; this model had not, and nothing showed it because interest
  // expense was (wrongly) absent on every public ticker, so no coverage
  // was ever measured. The day the shelved `interest_expense` was bridged,
  // coverage read 129.3x instead of 42.0x. Order: engine P&L, then the
  // feed's reported level, then the reconstruction (private books, whose
  // breakdown is complete by construction and which carry no reportedTotals).
  const reportedLevel = (k: "ebit" | "ebitda" | "netIncome"): number | null => {
    const v = s.reportedTotals?.[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  // Statutory net income includes 722; operational view doesn't.
  const netIncomeStatutory =
    typeof pl.net_income_statutory === "number"
      ? pl.net_income_statutory
      : reportedLevel("netIncome") ?? t.netIncome;
  // Net provisions (owner ruling R2, 2026-09-28): outside EBITDA, between it
  // and the operating result; its charges are non-cash like D&A. 0 on a
  // block assembled before the ruling (its D&A still held the charges).
  const servedProvisions = readNetProvisions(s.assembled_pl);
  const netProvisions = servedProvisions?.value ?? 0;
  const provisionCharges = servedProvisions?.charges ?? 0;
  const ebitStatutory =
    typeof pl.operating_ebit === "number"
      ? pl.operating_ebit
      : typeof pl.ebitda_statutory === "number"
        ? pl.ebitda_statutory - (pl.depreciation ?? s.incomeStatement.depreciationAmortization) - netProvisions
        : reportedLevel("ebit") ?? t.ebit;
  const ebitdaStatutory =
    typeof pl.ebitda_statutory === "number"
      ? pl.ebitda_statutory
      : reportedLevel("ebitda") ?? t.ebitda;
  // The engine's own EBIT; else the engine's own arithmetic for it
  // (`ebit = ebitda − depreciation − net provisions`, chart_of_accounts)
  // when the served
  // operands are on the wire; else — a P&L block that carries neither, so
  // the engine's operand is simply not on this payload — the same ladder
  // `ebitStatutory` walks. That last rung never reaches a real engine
  // envelope (every assembled_pl carries `ebit`); it exists so a payload
  // without the field keeps the verdict it had instead of being rebuilt
  // from statement leaves an absent input would silently move (the
  // completeness law, financialCompletenessLaw.test.tsx, served_balanced).
  const ebitCoverage =
    typeof pl.ebit === "number"
      ? pl.ebit
      : typeof pl.ebitda === "number" && typeof pl.depreciation === "number"
        ? pl.ebitda - pl.depreciation - netProvisions
        : ebitStatutory;
  const cfo =
    typeof cf.cash_from_operating === "number"
      ? cf.cash_from_operating
      : netIncomeStatutory === null
        ? null
        : netIncomeStatutory + (pl.depreciation ?? s.incomeStatement.depreciationAmortization) + provisionCharges;
  return {
    plRefusal: t.plRefusal,
    netIncomeStatutory,
    ebitStatutory,
    ebitCoverage,
    ebitdaStatutory,
    cfo,
    totalAssets: sf.totalAssets(),
    totalLiabilities: sf.totalLiabilities(),
    totalEquity: sf.totalEquity(),
    totalCurrentAssets: currentSide.assets,
    totalCurrentLiabilities: currentSide.liabilities,
    workingCapital: currentSide.workingCapital,
    // Z" needs retained earnings + current-year P&L (the cumulative book).
    //
    // THE AUTHORITY IS CHOSEN ONCE. When the engine sent an
    // `assembled_bs` at all, that object IS the balance-sheet authority
    // for this period and both terms must come from it; a term it did
    // not carry makes the cumulative book UNKNOWN, which refuses X2 and
    // therefore refuses Z" — it does not borrow the FE-parsed
    // `s.balanceSheet` figure, which is a different measurement, and it
    // does not complete the sum with a zero.
    //
    // When there is no `assembled_bs` (sample datasets, pre-engine
    // periods), `s.balanceSheet` is the authority and its
    // `retainedEarnings` is already the cumulative book — complete on
    // its own, with no second term to miss. Those periods keep their
    // full verdict, which is why this is an authority rule and not a
    // blanket refusal.
    retainedEarningsPlusCurrent: hasEngineBook
      ? (hasAssembledBs
          ? addOrNull(numOrNull(bs.retained_earnings), numOrNull(bs.current_year_pnl))
          // The engine spoke for this period but sent no balance sheet:
          // the cumulative book is UNKNOWN. Reading the FE-parsed figure
          // here is not a smaller answer, it is a second measurement
          // (−1,707,355.47 against −1,956,642.47 on the real corpus).
          : null)
      // ⚠ AND THE SOURCE'S OWN ABSENCE MANIFEST IS PART OF "COMPLETE ON
      // ITS OWN". `s.absentInputs` is how a feed says which lines it did
      // not report; `computeRatios` has honoured it since the absent-aware
      // rewrite (`B("retainedEarnings")` returns `absent`), and this
      // function did not — so the two FE Altmans disagreed about whether
      // the company could be scored AT ALL. Measured on the repo's own
      // AAPL fixture, which declares `retainedEarnings` absent:
      //
      //     computeRatios' inline Z″   REFUSED (value null, verdict unknown)
      //     altmanZScore(s)            2.9163597  →  SAFE ZONE
      //
      // — a safe-zone distress verdict computed over a placeholder zero
      // for a line the filing never carried. The inline Z″ is deleted, so
      // the survivor has to be the honest one: a declared-absent line is
      // absent here too, and X2 (and therefore the score, and therefore
      // the zone) refuses. The private path sets no manifest — a trial
      // balance is complete by construction — so its numbers do not move.
      : declaredAbsent(s, "retainedEarnings")
        ? null
        : numOrNull(s.balanceSheet.retainedEarnings),
    shareCapital:
      typeof bs.share_capital === "number" ? bs.share_capital : s.balanceSheet.shareCapital,
    totalDebt: typeof bs.total_debt === "number" ? bs.total_debt : t.totalDebt,
    cash: typeof bs.cash === "number" ? bs.cash : s.balanceSheet.cash,
    revenue: typeof pl.revenue === "number" ? pl.revenue : s.incomeStatement.revenue,
    depreciation:
      typeof pl.depreciation === "number" ? pl.depreciation : s.incomeStatement.depreciationAmortization,
    interestExpense:
      typeof pl.interest_expense === "number" ? pl.interest_expense : s.incomeStatement.interestExpense,
  };
}

// ─── Piotroski F-Score ─────────────────────────────────────────────────────
//
// 9 binary tests grouped into:
//   Profitability (4): positive NI, positive ROA, positive CFO, CFO > NI
//   Leverage / liquidity / source (3): debt declining, current ratio improving, no share dilution
//   Operating efficiency (2): gross margin improving, asset turnover improving
//
// 5 of 9 can be evaluated from current-period facts alone (NI / ROA / CFO
// / CFO>NI / share-dilution-vs-opening). 4 require prior-period data —
// when that's missing, those checks return `uncertain` (not `fail`), so
// the F-score reflects only confirmed positives.

export type PiotroskiResult_t = "pass" | "fail" | "uncertain";

export interface PiotroskiCheck {
  key: string;
  label: string;
  result: PiotroskiResult_t;
  /** @deprecated use `result`. Kept for legacy renderers. */
  pass: boolean;
  detail: string;
  requiresPriorPeriod: boolean;
  /** TRUE when the check is `uncertain` because a CURRENT-PERIOD operand
   *  was never filed — an extraction gap, not the documented
   *  prior-period gap. The two are spelled apart because the model
   *  handles them differently: a prior-period gap is disclosed and the
   *  F-score is rescaled over the confirmed checks; an extraction gap
   *  means the screen could not be run and must not be scored. */
  unresolved: boolean;
}

export interface PiotroskiResult {
  /** NULL — with `refusal` — when no check was evaluated (every one
   *  uncertain) or the engine refused the score (a refused net result).
   *  A count of passes over nothing evaluated is not a 0 / 9. */
  score: number | null;
  band: "Strong (8–9)" | "Solid (6–7)" | "Weak (3–5)" | "Distressed (0–2)" | null;
  refusal: { code: string; text: { en: string; ro: string } } | null;
  checks: PiotroskiCheck[];
  uncertainCount: number;
  /** Subset of `uncertainCount` caused by an absent current-period
   *  operand. Non-zero => this F-score must not be weighted into a
   *  composite (see `scorePiotroski`). */
  unresolvedCount: number;
  passCount: number;
  failCount: number;
}

export function runPiotroski(s: Statements): PiotroskiResult {
  const c = canonical(s);
  const checks: PiotroskiCheck[] = [];

  const add = (
    key: string,
    label: string,
    result: PiotroskiResult_t,
    detail: string,
    requiresPriorPeriod = false,
    unresolved = false,
  ) =>
    checks.push({
      key,
      label,
      result,
      pass: result === "pass",
      detail,
      requiresPriorPeriod,
      unresolved,
    });

  // 1. Net income positive — STATUTORY view.
  add(
    "ni_positive",
    "Net income positive",
    c.netIncomeStatutory === null ? "uncertain" : c.netIncomeStatutory > 0 ? "pass" : "fail",
    c.netIncomeStatutory === null
      ? "Net income was not served for this period — the check cannot be evaluated"
      : fmt(c.netIncomeStatutory, s.currency),
    false,
    c.netIncomeStatutory === null,
  );

  // 2. Return on assets positive — sanity check on the same NI.
  //
  // ⚠ AN UNFILED TOTAL IS NOT A FAILING COMPANY. `safeDiv` returns 0 for
  // an absent denominator, and `0 > 0` is false, so deleting
  // `canonical_bs.totals.assets` printed "Return on assets positive ✗ —
  // 0.00% on an unreported total assets" and moved the F-score 5 → 4.
  // Half of that row was already honest ("an unreported"), which is what
  // makes the ✗ beside it worse: the sentence says the figure is missing
  // and the mark says the company failed. An operand the extraction
  // never produced makes the check UNRESOLVED, which is a different word
  // from `fail` and a different word from the prior-period `uncertain`
  // below (see `unresolvedCount`).
  const roa = ratioOrNull(c.netIncomeStatutory, c.totalAssets);
  add(
    "roa_positive",
    "Return on assets positive",
    roa === null ? "uncertain" : roa > 0 ? "pass" : "fail",
    // `c.totalAssets` is re-tested rather than asserted: the compiler
    // cannot know that `roa !== null` implies it, and an assertion here
    // is exactly the shape (`as number`, `!`) that lets an absent
    // denominator print as `RON 0` further down the line.
    roa === null || c.totalAssets === null
      ? "Total assets were not reported for this period — the ratio cannot be evaluated"
      : `${(roa * 100).toFixed(2)}% on ${fmt(c.totalAssets, s.currency)} total assets`,
    false,
    roa === null,
  );

  // 3. Operating cash flow positive — from canonical CF view (NI + D&A
  //    when prior-period WC deltas aren't threaded; positive for EEI).
  add(
    "cfo_positive",
    "Operating cash flow positive",
    c.cfo === null ? "uncertain" : c.cfo > 0 ? "pass" : "fail",
    c.cfo === null
      ? "Operating cash flow was not served for this period — the check cannot be evaluated"
      : fmt(c.cfo, s.currency),
    false,
    c.cfo === null,
  );

  // 4. CFO > NI — earnings cash-backed.
  add(
    "cfo_gt_ni",
    "Quality of earnings (CFO > NI)",
    c.cfo === null || c.netIncomeStatutory === null
      ? "uncertain"
      : c.cfo > c.netIncomeStatutory ? "pass" : "fail",
    c.cfo === null || c.netIncomeStatutory === null
      ? "Operating cash flow or net income was not served — the check cannot be evaluated"
      : c.cfo > c.netIncomeStatutory
        ? `CFO ${fmt(c.cfo, s.currency)} > NI ${fmt(c.netIncomeStatutory, s.currency)} — cash-backed`
        : `NI ${fmt(c.netIncomeStatutory, s.currency)} > CFO ${fmt(c.cfo, s.currency)} — possible accrual inflation`,
    false,
    c.cfo === null || c.netIncomeStatutory === null,
  );

  // ── Prior-period comparisons (4 of 9) ───────────────────────────────
  // When `s.prior` is populated (multi-period uploads), we can run the
  // year-over-year checks. For trial-balance extraction without a
  // prior-period Statements snapshot we mark them `uncertain` — never
  // `fail`, which was the bug that produced 0/9 in the screenshot.

  if (s.prior) {
    const prior = priorTotals(s);
    const priorPl = (s.prior as any).assembled_pl ?? {};
    const priorBs = (s.prior as any).assembled_bs ?? {};
    const priorNi =
      typeof priorPl.net_income_statutory === "number"
        ? priorPl.net_income_statutory
        : prior.netIncome;
    const priorAssets =
      typeof priorBs.total_assets === "number" ? priorBs.total_assets : prior.totalAssets;
    const priorRevenue =
      typeof priorPl.revenue === "number" ? priorPl.revenue : s.prior.incomeStatement.revenue;
    const priorDebt =
      typeof priorBs.total_debt === "number"
        ? priorBs.total_debt
        : s.prior.balanceSheet.longTermDebt + s.prior.balanceSheet.shortTermDebt;
    const priorShareCapital =
      typeof priorBs.share_capital === "number"
        ? priorBs.share_capital
        : s.prior.balanceSheet.shareCapital;

    // 5. ROA improving y/y — needs BOTH ratios. `null > x` is false, so
    //    an unreported current-period total-assets used to read as "ROA
    //    got worse" here too, off the same missing field as check 2.
    const roaPrior = ratioOrNull(priorNi, priorAssets);
    add(
      "roa_improving",
      "ROA improving year-over-year",
      roa === null || roaPrior === null ? "uncertain" : roa > roaPrior ? "pass" : "fail",
      roa === null || roaPrior === null
        ? "Total assets were not reported for one of the two periods"
        : `${(roaPrior * 100).toFixed(2)}% → ${(roa * 100).toFixed(2)}%`,
      true,
      // Unresolved only when THIS period's operand is the missing one —
      // a prior-period gap is the model's documented, disclosed
      // condition, not an extraction failure.
      roa === null,
    );
    // 6. Long-term debt declining
    add(
      "debt_declining",
      "Long-term debt declining",
      c.totalDebt < priorDebt ? "pass" : "fail",
      `${fmt(priorDebt, s.currency)} → ${fmt(c.totalDebt, s.currency)}`,
      true,
    );
    // 7. No share dilution
    add(
      "no_dilution",
      "No equity dilution",
      c.shareCapital <= priorShareCapital ? "pass" : "fail",
      `Share capital ${
        c.shareCapital === priorShareCapital ? "unchanged at" : "changed to"
      } ${fmt(c.shareCapital, s.currency)}`,
    );
    // 8. Operating margin improving (EBIT / net turnover). Both EBITs on
    //    the ONE definition, or no comparison: a prior served under a
    //    different EBITDA definition, or a refused EBIT on either side,
    //    leaves the check unresolved rather than grading a mixed pair.
    const priorEbit: number | null =
      typeof priorPl.ebit === "number" ? priorPl.ebit : prior.ebit;
    const sameDef =
      (typeof priorPl.ebitda_definition === "string" ? priorPl.ebitda_definition : null) ===
      (typeof (s.assembled_pl as Record<string, unknown> | undefined)?.ebitda_definition === "string"
        ? (s.assembled_pl as Record<string, unknown>).ebitda_definition
        : null);
    if (c.ebitStatutory === null || priorEbit === null || !sameDef) {
      add(
        "margin_improving",
        "Operating margin improving",
        "uncertain",
        c.ebitStatutory === null
          ? `Operating result refused for this period — ${c.plRefusal?.text.en ?? "not served"}`
          : priorEbit === null
            ? "Prior-period operating result not available"
            : "The prior period's operating result is on a different EBITDA definition",
        true,
        c.ebitStatutory === null,
      );
    } else if (priorRevenue > 0 && c.revenue > 0) {
      const margin = safeDiv(c.ebitStatutory, c.revenue);
      const priorMargin = safeDiv(priorEbit, priorRevenue);
      add(
        "margin_improving",
        "Operating margin improving",
        margin > priorMargin ? "pass" : "fail",
        `${(priorMargin * 100).toFixed(1)}% → ${(margin * 100).toFixed(1)}%`,
        true,
      );
    } else {
      add(
        "margin_improving",
        "Operating margin improving",
        "uncertain",
        "Prior-period revenue not available",
        true,
      );
    }
    // 9. Asset turnover improving (revenue / total assets)
    if (priorRevenue > 0 && priorAssets > 0 && c.revenue > 0 && (c.totalAssets ?? 0) > 0) {
      const turnover = safeDiv(c.revenue, c.totalAssets);
      const priorTurnover = safeDiv(priorRevenue, priorAssets);
      add(
        "at_improving",
        "Asset turnover improving",
        turnover > priorTurnover ? "pass" : "fail",
        `${priorTurnover.toFixed(3)}× → ${turnover.toFixed(3)}×`,
        true,
      );
    } else {
      // The reason matters: an absent CURRENT-period total-assets is an
      // extraction gap and lands in `unresolvedCount`; everything else
      // here is the ordinary prior-period gap this model discloses.
      const currentAssetsMissing = c.totalAssets === null;
      add(
        "at_improving",
        "Asset turnover improving",
        "uncertain",
        currentAssetsMissing
          ? "Total assets were not reported for this period"
          : "Prior-period turnover not available",
        true,
        currentAssetsMissing,
      );
    }
  } else {
    // 7. No share dilution — when there's no prior period at all, the
    //    book usually carries opening = closing for share capital (no
    //    AGM resolution to issue shares). Mark pass when the closing
    //    matches the canonical share_capital and there's no other
    //    evidence; cite that the assumption is conservative.
    add(
      "no_dilution",
      "No equity dilution",
      "pass",
      `Share capital ${fmt(c.shareCapital, s.currency)} (no prior-period evidence of change)`,
    );
    // 5/6/8/9 require a prior period to compute.
    add("roa_improving", "ROA improving year-over-year", "uncertain", "Prior-period data required", true);
    add("debt_declining", "Long-term debt declining", "uncertain", "Prior-period data required", true);
    add("margin_improving", "Operating margin improving", "uncertain", "Prior-period data required", true);
    add("at_improving", "Asset turnover improving", "uncertain", "Prior-period data required", true);
  }

  // Sort 1..9 — number them in the order added.
  const passCount = checks.filter((c) => c.result === "pass").length;
  const failCount = checks.filter((c) => c.result === "fail").length;
  const uncertainCount = checks.filter((c) => c.result === "uncertain").length;
  const unresolvedCount = checks.filter((c) => c.unresolved).length;
  // No check evaluated → no score and no band (never "Distressed" off 0/0).
  const refusal = passCount + failCount === 0 ? PIOTROSKI_NO_CHECK_EVALUATED : null;
  const score = refusal ? null : passCount;
  const band = piotroskiBand(score);

  return { score, band, refusal, checks, passCount, failCount, uncertainCount, unresolvedCount };
}

/** The refusal a screen with NO evaluated check carries when the engine
 *  sent no reason of its own. */
export const PIOTROSKI_NO_CHECK_EVALUATED: NonNullable<PiotroskiResult["refusal"]> = {
  code: "piotroski_no_check_evaluated",
  text: {
    en: "None of the 9 Piotroski checks could be evaluated for this period — there is no score.",
    ro: "Niciuna dintre cele 9 verificări Piotroski nu a putut fi evaluată pentru această perioadă — nu există un scor.",
  },
};

function piotroskiBand(score: number | null): PiotroskiResult["band"] {
  if (score === null) return null;
  return score >= 8 ? "Strong (8–9)" : score >= 6 ? "Solid (6–7)" : score >= 3 ? "Weak (3–5)" : "Distressed (0–2)";
}

// ─── Altman Z-Score — single canonical variant (F2.2) ────────────────────
//
// F2.2 — The previous Z / Z' / Z" industry-switch path is DELETED. Single
// canonical variant: Z" (1995 EM). Engine emits `altman_z_score` as Z" for
// every period per SPEC §10 (Romanian SME market, RAS-based books).
// Industry-switch logic and Z' (1983 private mfg) branch removed entirely.
//
// Z" (1995) uses 4 components (no sales/assets X5 term that systematically
// penalizes asset-heavy rental businesses), coefficients refit on a broader
// cross-industry sample. Thresholds: > 2.60 safe, 1.10–2.60 grey, < 1.10
// distress.
//
// AltmanVariant type retained as `"Z\""` literal (the only value F2.2 emits)
// for downstream consumers (computeCreditScore in this file, the
// Comprehensive Report's credit card display) that branch on variant
// string. The variant FIELD stays in AltmanResult so the type contract is
// stable — F2.4 consumers don't need to change.

export type AltmanVariant = "Z\"";

/** The zone a score lands in — or NULL when there is no score to place.
 *
 *  A zone is a VERDICT. `null` is the only honest value when the inputs
 *  the zone would be read off never arrived; "distress" is not the
 *  conservative default, it is a different claim about the company. */
export type AltmanZone = "safe" | "grey" | "distress";

export interface AltmanResult {
  variant: AltmanVariant;
  // ── ENGINE-EMITTED, THEREFORE ABSENT-CAPABLE ────────────────────────
  // Every field below is a function of envelope completeness. Typed
  // `number` they took `?? 0` at the boundary, which printed a component
  // row of 0.00 under an unchanged headline (F2) and a 0.0000 score
  // labelled "distress" off totals the envelope never carried. Typed
  // `number | null`, the typechecker names every consumer.
  components: {
    x1_wc_to_assets: number | null;
    x2_re_to_assets: number | null;
    x3_ebit_to_assets: number | null;
    x4_equity_to_liabilities: number | null;
    x5_sales_to_assets?: number | null; // F2.2 — no longer populated; kept on type for back-compat
  };
  weightedComponents: Array<{
    label: string;
    coefficient: number;
    value: number | null;
    weighted: number | null;
    /** Why this row has no value, when the ENGINE refused it — printed in
     *  the value and weighted cells, never a bare dash. */
    refusal?: { code: string; text: { en: string; ro: string } } | null;
  }>;
  /** A component the ENGINE refused, with its typed reason: X2 when total
   *  equity excludes a refused year's result (no account 121, net 711
   *  refused, the sheet short by the missing result); X3 when the
   *  operating result is refused, and X4 (withheld with Z'') when the
   *  Altman component is refused — the engine's sentence (critic round 3,
   *  2026-09-28: the Risks tab printed a bare "—" and the report "not
   *  reported"). The reader prints "refused — <reason>". */
  componentRefusals?: {
    x2?: { code: string; text: { en: string; ro: string } } | null;
    x3?: { code: string; text: { en: string; ro: string } } | null;
    x4?: { code: string; text: { en: string; ro: string } } | null;
  };
  /** NULL when neither the engine row nor a complete FE fallback exists. */
  score: number | null;
  /** NULL exactly when `score` is null — and ALWAYS derived from THAT
   *  score. F3 was a row whose number came from the credit envelope and
   *  whose sentence came from a different (FE-fallback) computation, so
   *  it printed 3.09 labelled "Distress zone". One source, always. */
  zone: AltmanZone | null;
  thresholds: { safe: number; distress: number };
  methodologyNote: string;
}

// Z" thresholds — now in the leaf `creditModel.ts`, for the same reason
// the ladder spelling is: `ratioKnowledge.ts` (the drawer that EXPLAINS
// the row) spelled "2.60" and "1.10" as prose, so a moved threshold left
// the explanation frozen one click from the number. Every reader and
// every sentence reads the SAME object.
const ALTMAN_ZPP_THRESHOLDS = ALTMAN_ZPP_THRESHOLDS_SHARED;
const ALTMAN_ZPP_METHODOLOGY =
  `Altman Z" (1995) is the variant designed for non-manufacturing companies — real estate, ` +
  `services, SaaS, and emerging markets. It drops the sales/total-assets term that ` +
  `systematically penalizes asset-heavy rental businesses (where the property book is large ` +
  `relative to annual rental income by definition). Coefficients refit on a broader cross-` +
  `industry sample. Thresholds: > 2.60 safe, 1.10–2.60 grey, < 1.10 distress. ` +
  `Engine emits this as the canonical variant for all RAS-based fixtures (F2.2).`;

/** Place a score in its zone, or refuse. The ONE mapping — every zone in
 *  this file comes from here, so a number and its sentence cannot
 *  disagree. */
function zoneFor(
  score: number | null,
  thresholds: { safe: number; distress: number },
): AltmanZone | null {
  if (score === null || !Number.isFinite(score)) return null;
  return score > thresholds.safe ? "safe" : score > thresholds.distress ? "grey" : "distress";
}

/** THE zone mapping, for surfaces that hold a Z" but not an
 *  `AltmanResult` — `/report`'s credit card being the one.
 *
 *  ⚠ IT HAD ITS OWN. `CreditScoreCard.altmanZone()` re-implemented this
 *  with `>=` where the methodology (and `zoneFor`) use `>`, so the two
 *  ladders disagreed on the boundary values themselves. Measured:
 *
 *      Z" = 2.60 exactly   /report "Safe"    Risks tab "Grey"
 *      Z" = 1.10 exactly   /report "Grey"    Risks tab "Distress"
 *
 *  Appendix A is explicit — `Z" > 2.60 → SAFE`, `1.10 ≤ Z" ≤ 2.60 →
 *  GREY` — so the card was the wrong one, on the exact values a reader
 *  is most likely to be looking at when the word matters. One mapping,
 *  one threshold object, one boundary. */
export function altmanZoneOf(score: number | null): AltmanZone | null {
  return zoneFor(score, ALTMAN_ZPP_THRESHOLDS);
}

/** THE engine-canonical Altman construction — the only place an
 *  `AltmanResult` is built out of engine-emitted fields.
 *
 *  ABSENT COMPONENT ≠ COMPONENT OF ZERO. The reads here used to be
 *  `m("altman_x1") ?? 0`, which printed four 0.0000 rows under an
 *  unchanged 3.09 total: a reader saw a company with no working capital,
 *  no retained earnings, no EBIT and no equity, beneath a headline
 *  saying it was safe. A component the envelope did not carry has no
 *  row, and a score it did not carry has no zone.
 *
 *  `refuseScore` renders the known components with NO score and NO zone
 *  — used when the engine sent components but no Z". */
function altmanReaderOf(
  metrics: Record<string, number | null>,
  refuseScore = false,
): AltmanResult {
  const x1 = metrics.altman_x1 ?? null;
  const x2 = metrics.altman_x2 ?? null;
  const x3 = metrics.altman_x3 ?? null;
  const x4 = metrics.altman_x4 ?? null;
  const score = refuseScore ? null : (metrics.altman_z_score ?? null);
  return {
    variant: 'Z"',
    components: {
      x1_wc_to_assets: x1,
      x2_re_to_assets: x2,
      x3_ebit_to_assets: x3,
      x4_equity_to_liabilities: x4,
    },
    weightedComponents: [
      { label: "Working capital / Total assets", coefficient: 6.56, value: x1, weighted: weigh(6.56, x1) },
      { label: "(Retained earnings + Current NP) / Total assets", coefficient: 3.26, value: x2, weighted: weigh(3.26, x2) },
      { label: "EBIT / Total assets", coefficient: 6.72, value: x3, weighted: weigh(6.72, x3) },
      { label: "Book equity / Total liabilities", coefficient: 1.05, value: x4, weighted: weigh(1.05, x4) },
    ],
    score,
    zone: zoneFor(score, ALTMAN_ZPP_THRESHOLDS),
    thresholds: ALTMAN_ZPP_THRESHOLDS,
    methodologyNote: ALTMAN_ZPP_METHODOLOGY,
  };
}

export function altmanZScore(
  s: Statements,
  // F2.2 — Optional engine-canonical metric map. When supplied AND
  // `altman_z_score` is present, the function becomes a thin reader of
  // engine canonical: score + X1-X4 + zone all sourced from
  // `calculated_metrics`. FE arithmetic stays as a fallback ONLY when
  // engine row is absent (pre-v2.1 cached periods) — and that fallback
  // computes Z" inline (single variant; no industry switch).
  metricsByName?: Record<string, number | null>,
): AltmanResult {
  const m = (name: string): number | null => {
    if (!metricsByName) return null;
    const v = metricsByName[name];
    return typeof v === "number" ? v : null;
  };

  // F2.2 — Engine canonical path (preferred). One reader, shared with
  // `altmanFromEngine` so the credit tab and this entry point can never
  // construct the figure two different ways.
  if (m("altman_z_score") !== null) {
    return altmanReaderOf({
      altman_z_score: m("altman_z_score"),
      altman_x1: m("altman_x1"),
      altman_x2: m("altman_x2"),
      altman_x3: m("altman_x3"),
      altman_x4: m("altman_x4"),
    });
  }

  // F2.2 — FE fallback: compute Z" inline (single variant, no industry
  // switch). Used only when engine row is absent.
  // ⚠ THE HEADLINE DEFECT OF THIS LANE LIVED ON THE NEXT FOUR LINES.
  // These used `safeDiv`, whose absent arm returns 0 — so deleting only
  // `totals.assets` from the envelope moved this company from Z 5.3313 /
  // SAFE / rating A to Z 1.6451 / GREY / BB+, and emptying `totals`
  // moved it to Z 0.0000 / DISTRESS / B. Not even monotone: dropping
  // `totals.equity` alone read UNCHANGED, i.e. safer than dropping
  // everything. A verdict must not be a function of envelope
  // completeness, so an absent operand refuses the RATIO, and a refused
  // ratio refuses the SCORE — it does not contribute a zero to it.
  const c = canonical(s);
  const x1 = ratioOrNull(c.workingCapital, c.totalAssets);
  // Z" uses (retained earnings + current-year P&L) / total assets — the
  // cumulative book of retained profits, not just the carry-forward
  // retained earnings line.
  const x2 = ratioOrNull(c.retainedEarningsPlusCurrent, c.totalAssets);
  const x3 = ratioOrNull(c.ebitStatutory, c.totalAssets); // STATUTORY EBIT — never operational
  const x4 = ratioOrNull(c.totalEquity, c.totalLiabilities); // book equity / total liab for Z"

  const weighted = [
    { label: "Working capital / Total assets", coefficient: 6.56, value: x1, weighted: weigh(6.56, x1) },
    { label: "(Retained earnings + Current NP) / Total assets", coefficient: 3.26, value: x2, weighted: weigh(3.26, x2) },
    { label: "EBIT / Total assets", coefficient: 6.72, value: x3, weighted: weigh(6.72, x3) },
    { label: "Book equity / Total liabilities", coefficient: 1.05, value: x4, weighted: weigh(1.05, x4) },
  ];
  // A sum over a missing term is not a smaller sum, it is no sum.
  const score = weighted.some((w) => w.weighted === null)
    ? null
    : weighted.reduce((acc, w) => acc + (w.weighted as number), 0);
  return {
    variant: 'Z"',
    components: { x1_wc_to_assets: x1, x2_re_to_assets: x2, x3_ebit_to_assets: x3, x4_equity_to_liabilities: x4 },
    weightedComponents: weighted,
    score,
    zone: zoneFor(score, ALTMAN_ZPP_THRESHOLDS),
    thresholds: ALTMAN_ZPP_THRESHOLDS,
    methodologyNote: ALTMAN_ZPP_METHODOLOGY,
  };
}

// F2.2 — Deleted: Z'(1983) private-manufacturing branch + industry-switch
// routing. The two Sets `_Z_DOUBLE_PRIME_INDUSTRIES` and
// `_Z_PRIME_INDUSTRIES` are removed. Single canonical variant. The
// historical Z' code (with 0.717 / 0.847 / 3.107 / 0.42 / 0.998
// coefficients and 2.90 / 1.23 thresholds) is preserved in git history
// for retrospective; future regression prevented by architecture.

// ─── Composite credit score ────────────────────────────────────────────────
//
// 0–100 weighted blend of: Altman Z (40%), Piotroski (20%), Debt/EBITDA (15%),
// Interest coverage (10%), DSCR (10%), Cash ratio (5%). Banded into S&P-style
// letters for at-a-glance reading.
//
// Industry-aware scoring: CRE gets the SME-CRE credit-committee thresholds
// for Debt/EBITDA (8× watch, 12× critical) rather than the generic operating-
// business thresholds (3-4× watch). Otherwise the rating would penalize any
// real-estate vehicle just for being a real-estate vehicle.

// ─── THERE ARE TWO SCORING MODELS. WHICH ONE SPOKE IS PART OF THE ANSWER ──
//
// Measured on the real Scandia corpus, before this type existed:
//
//   envelope                          rating  composite  Z"       model
//   intact                            CC      24.4       0.22     engine
//   assembled_piotroski absent        CCC     36         0.2013   FE
//   assembled_metrics.credit absent   CCC     36         0.2013   FE
//
// Two different weight vectors (30/20/15/10/10/10/5 against
// 40/20/15/10/10/5), two different band ladders (engine AAA≥90…CC<25
// against FE A≥85…CC≥0), two different letters — selected by whether a
// field happened to arrive. CLAUDE.md §14 records `assembled_piotroski`
// returning null on EVERY period in production for weeks after F1.j;
// throughout that window this file silently answered with the other
// model and printed a different letter than the engine would have.
//
// THE ARCHITECTURE, one sentence: THE AUTHORITY IS CHOSEN ONCE, FROM
// WHETHER THE ENGINE SPOKE AT ALL. Once chosen, a missing leaf inside
// that authority yields ABSENCE — never a fall-through to the other
// authority, never a substituted zero. And the chosen model is NAMED in
// the result, so no surface can print a letter without saying which
// model minted it. The parallel FE model is retained (sample datasets
// and pre-engine periods have no envelope and would otherwise lose their
// verdict entirely) but it can no longer be reached silently.
// ── THE BAND-SENTENCE COMPOSER LIVES IN `creditModel.ts` ────────────
//
// Moved out to a LEAF module so `financialReport.ts` — which renders the
// printed document and must spell the SAME ladder the letter was banded
// with — can import the one spelling without a runtime cycle (this file
// imports values from that one). Re-exported here so every existing
// consumer keeps its import path.
export {
  CREDIT_MODEL_NAME,
  spellLadder,
  spellWeights,
  creditModelLabel,
  creditCaveat,
} from "./creditModel";
export type { CreditModelId } from "./creditModel";
export { ALTMAN_ZPP_THRESHOLDS_SHARED } from "./creditModel";
import {
  creditModelLabel,
  creditCaveat,
  ALTMAN_ZPP_THRESHOLDS_SHARED,
  type CreditModelId,
} from "./creditModel";

export interface CreditScoreResult {
  /** WHICH MODEL MINTED THE LETTER. Never inferred by a consumer from
   *  the shape of the result — the one place that chooses also states
   *  the choice. */
  model: CreditModelId;
  /** `creditModelLabel(model, letterBands, components)`, carried so an
   *  export that cannot call the composer still ships the sentence — and
   *  so the sentence is composed from the SAME bands `rating` was banded
   *  with, on the same result object. */
  modelLabel: string;
  /** NULL when the engine emitted no composite and the FE fallback could
   *  not complete one. A lender reads this number; 0 is not "unknown". */
  score: number | null;
  /** WHY `score` and `rating` are null on an engine period (R-COMPOSITE,
   *  R-RANGE): a refused component (every one listed), a composite outside
   *  the model's declared range (re-checked here, C9.4), or a model that
   *  did not run. Null beside a score; absent on the client fallback. */
  compositeRefusal?: CreditCompositeRefusalRead | null;
  /** NULL when there is no score to band. Never "—" as a value — the
   *  render layer decides how to SPELL an absence, this layer decides
   *  whether there IS one. */
  rating: string | null;
  grade: string | null;
  /** THE LADDER THE LETTER WAS BANDED WITH — carried on the result so a
   *  surface can PRINT the ladder without reaching past this reader into
   *  the raw envelope. The card at `/report` used to reach past it (it
   *  takes `assembled_metrics.credit` as a second argument purely to read
   *  `letter_grade_bands`), which is how a surface ends up holding two
   *  authorities. On the engine path this is the engine's own
   *  `letter_grade_bands`; on the client fallback it is that model's
   *  `RATING_BANDS`, so a printed document always shows WHICH ladder
   *  produced the letter beside it. NULL when the authority shipped none. */
  letterBands: Array<{ min: number; grade: string }> | null;
  /** THE CREDIT REGIME the engine composed this grade under (credit model
   *  revision 5, owner ruling R1): the stock-build regime — leverage,
   *  coverage and DSCR on cash from operations, X3 before the stock
   *  variation, the regime's weights — with its trigger figures and the
   *  finding, as served (`assembled_metrics.credit.regime`). NULL under the
   *  standard model and on the client fallback. Every surface that prints
   *  the grade prints this ONCE (`CreditRegimeNote`). */
  regime?: CreditRegime | null;
  components: {
    label: string;
    /** NULL when the envelope carried no sub-score for this component. */
    value: number | null;
    /** The 0–100 WEIGHTED INPUT to the composite for this row — the term
     *  that is actually multiplied by `weight`.
     *
     *  On five of the six FE-fallback rows, and on six of the seven
     *  engine rows, this equals `value`. On the ALTMAN row it does not:
     *  `value` is the Z" itself (0.22), the number a reader recognises,
     *  while the composite consumes the engine's `subscores.altman`
     *  (7.9). `/report`'s card renders the 0–100 bars, so it needs THIS,
     *  and it needs it stated rather than recovered by dividing the
     *  contribution back out by the weight. */
    subscore: number | null;
    weight: number | null;
    /** NULL whenever `value` is: `null * weight` is 0, a term that looks
     *  like it contributed nothing on purpose. */
    contribution: number | null;
    /** SET WHEN THE ENGINE SCORED THE COMPOSITE WITHOUT THIS SUB-SCORE
     *  (credit model revision 2: a sub-score whose base is not positive
     *  refuses and the composite renormalises over the rest). `weight` is
     *  then NULL — the row carried no weight, and the model's table weight
     *  printed beside it made the printed vector sum past 100% while the
     *  composite beside it summed over fewer terms. `subject` is the short
     *  name the model sentence lists; `sentence` is what the row prints in
     *  place of a read. Absent / null on every row that was scored, and on
     *  every client-fallback row. */
    refusal?: CreditSubscoreRefusal | null;
    /** R-D1/D2/D3: the row's score was STATED by a declared rule, not
     *  measured; the served label says why. Null on a measured row. */
    declaredRung?: { score: number; label: string; source: string; file: string } | null;
    /** NULL when there is no value to read. A "read" sentence is a
     *  verdict; six rows reading "weak" off absent sub-scores, under a
     *  headline that still said 82 / A, is what this lane removed. */
    read: string | null;
  }[];
  altman: AltmanResult; // surfaced so the UI can render the methodology note
  /** NULL on the ENGINE path when the engine sent no Piotroski envelope.
   *
   *  It used to be non-nullable, which is why the guard below required
   *  BOTH envelopes: with no Piotroski to show, the whole function fell
   *  to the other model rather than showing one block less. Absent is a
   *  block that is not rendered — not a reason to change the letter, and
   *  not a reason to compute the engine's Piotroski here (that would be
   *  the FE model's 9-check screen wearing the engine's name). */
  piotroski: PiotroskiResult | null;
  caveat: string;
}

// F2.4 — Engine assembled_metrics envelope shape (subset consumed here).
// When supplied, computeCreditScore becomes a thin reader of the engine
// canonical (composite_score, letter_grade, subscores, composite_weights,
// altman_*). The parallel FE system (RATING_BANDS + 40/20/15/10/10/5
// weights + FE Piotroski + "investment strong" descriptors) is bypassed
// entirely on the engine-canonical path.
//
// ⚠ EVERY FIELD BELOW IS ENGINE-EMITTED AND THEREFORE ABSENT-CAPABLE.
// They are typed `number | null` (not `number | undefined`) so that a
// JSON `null` from the engine is as loud as a missing key, and so the
// typechecker refuses `?? 0` at every read. This is the boundary the
// completeness law is enforced at: widen HERE, and tsc enumerates the
// consumers instead of a human auditing call sites.
/** The seven sub-scores of the engine's composite, in the model's order. */
export type CreditSubscoreKey =
  | "altman" | "profitability" | "leverage" | "coverage" | "dscr" | "liquidity" | "equity";

/** A sub-score the engine scored the composite without, as the reader
 *  states it on the row. */
export interface CreditSubscoreRefusal {
  /** The engine's reason code; NULL when the served weights omit the
   *  sub-score but no reason was served with them. */
  code: string | null;
  /** Short name listed in the model sentence ("Altman Z″", "liquidity"). */
  subject: string;
  /** The row's printed reason, in place of a read. */
  sentence: string;
}

export interface CreditEnvelope {
  /** Credit model revision 5: the stock-build regime block, or null
   *  (the standard model). Read by `readCreditRegime`, never here. */
  regime?: unknown;
  /** Revision 5: what Altman X3 was computed on under the regime. */
  altman_x3_basis?: { ro?: string | null; en?: string | null } | null;
  composite_score?: number | null;
  letter_grade?: string | null;
  letter_grade_bands?: Array<{ min: number; grade: string }> | null;
  altman_z_score?: number | null;
  altman_variant?: string | null;
  altman_components?: {
    x1?: number | null; x2?: number | null; x3?: number | null; x4?: number | null;
  } | null;
  /** The components the engine REFUSED, each with its typed reason (X2
   *  when total equity excludes a refused year's result). */
  altman_component_refusals?: {
    x2?: { code?: string | null; cause?: string | null; text_ro?: string | null; text_en?: string | null } | null;
  } | null;
  /** THE MODEL'S WEIGHT TABLE — the only weights a composite is ever
   *  multiplied by. NEVER renormalised (R-COMPOSITE): with a refused
   *  component the engine serves no composite and no letter, and this
   *  reader mints none. An earlier cut of revision 2 served renormalised
   *  weights here; that shape is refused below, never re-weighted. */
  composite_weights?: {
    altman?: number | null; profitability?: number | null; leverage?: number | null;
    coverage?: number | null; dscr?: number | null; liquidity?: number | null; equity?: number | null;
  } | null;
  /** Revision 2: each sub-score the model refused, with the engine's code,
   *  inputs and sentence. Any entry means no composite and no letter. */
  refused_subscores?: Partial<Record<CreditSubscoreKey, {
    code?: string | null; inputs?: string[] | null; text?: string | null;
  } | null>> | null;
  /** Why the composite and the letter are absent (every refused component
   *  listed), or null beside a composite. */
  reason?: {
    code?: string | null; inputs?: string[] | null; text?: string | null; range?: string | null;
    components?: Array<{ component?: string | null; code?: string | null; cause?: string | null;
                         text?: string | null; inputs?: string[] | null }> | null;
  } | null;
  /** Sub-scores STATED by declared rule rather than measured (R-D1/D2/D3),
   *  each with its label, source and pack file. */
  declared_rungs?: Partial<Record<CreditSubscoreKey, {
    rung?: string | null; score?: number | null; when?: string | null; label?: string | null;
    source?: string | null; file?: string | null;
  } | null>> | null;
  /** R-D2: the disclosed net-margin-only profitability variant, when used. */
  profitability_disclosure?: { formula?: string | null; label?: string | null; source?: string | null; file?: string | null } | null;
  /** The pack-declared ranges every served figure was read against
   *  (R-RANGE). The reader re-checks the composite and the sub-scores
   *  against these before rendering (C9.4). */
  ranges?: {
    subscore?: { min?: number | null; max?: number | null } | null;
    composite?: { min?: number | null; max?: number | null } | null;
    /** R-D4 / R-RANGE: the Altman figures' declared bounds. `altman_z.bound`
     *  is derived per book (its own X2 and X3), so it exists only as served. */
    altman_x1?: { max?: number | null } | null;
    altman_x4?: { max?: number | null } | null;
    altman_z?: { bound?: number | null } | null;
  } | null;
  /** The credit model revision that produced this envelope's composite. */
  credit_model_revision?: number | null;
  /** Which rows this envelope was read off: the serve-time model
   *  ("serve") or the persisted rows ("as_filed"). An envelope that states
   *  a basis is under the revision-2 serving contract, which ALWAYS serves
   *  `ranges` beside a figure (engine: ratios/credit_boundary.py). */
  basis?: "serve" | "as_filed" | null;
  subscores?: {
    altman?: number | null; profitability?: number | null; leverage?: number | null;
    coverage?: number | null; dscr?: number | null; liquidity?: number | null; equity?: number | null;
  } | null;
}
export interface PiotroskiEnvelope {
  score?: number | null;
  score_max?: number | null;
  has_prior_period?: boolean | null;
  checks?: Array<{ key: string; label: string; result: "pass" | "fail" | "uncertain"; detail?: string | null }> | null;
  disclosure?: string | null;
  /** Why `score` is null: the net result's own reason, or
   *  `piotroski_no_check_evaluated` (engine, fixer round 2). */
  refusal?: { code?: string | null; text_en?: string | null; text_ro?: string | null } | null;
}

// F2.4 — Build a FE-shaped PiotroskiResult from the engine's assembled_piotroski.
// Preserves the CreditScoreResult.piotroski contract so RisksPanel renders
// without changes to its render code.
function piotroskiFromEngine(env: PiotroskiEnvelope): PiotroskiResult {
  const checks: PiotroskiCheck[] = (env.checks ?? []).map((c) => ({
    key: c.key,
    label: c.label,
    result: c.result,
    pass: c.result === "pass",
    detail: c.detail ?? "",
    requiresPriorPeriod: !env.has_prior_period && c.result === "uncertain",
    // The engine ran the screen and reported this check's own result;
    // nothing here is an FE extraction gap. `unresolved` is the FE
    // path's word, and on this path it is always false.
    unresolved: false,
  }));
  const passCount = checks.filter((c) => c.result === "pass").length;
  const failCount = checks.filter((c) => c.result === "fail").length;
  const uncertainCount = checks.filter((c) => c.result === "uncertain").length;
  const unresolvedCount = 0;
  // NO SCORE WITHOUT AN EVALUATED CHECK (fixer round 2, 2026-09-27). The
  // engine served `score: 0` with all nine checks uncertain on a refused
  // net result, and `score ?? passCount` banded it "Distressed (0–2)" —
  // a distress verdict read off zero evaluated checks. A null engine
  // score, or nothing evaluated, is no score and no band, with the
  // engine's reason (or the no-check reason).
  const engineRefusal = readRefusal(env.refusal);
  const refused =
    engineRefusal !== null || env.score === null || passCount + failCount === 0;
  const refusal = refused ? engineRefusal ?? PIOTROSKI_NO_CHECK_EVALUATED : null;
  const score = refused ? null : env.score ?? passCount;
  const band = piotroskiBand(score);
  return { score, band, refusal, checks, uncertainCount, unresolvedCount, passCount, failCount };
}

// F2.4 — Generate a one-line "read" for a subscore value (0-100).
//
// ⚠ NULL IN, NULL OUT. This used to be called as
// `readForSubscore("Leverage", subs.leverage ?? 0)`, and `0` is finite,
// so an ABSENT sub-score produced the sentence "Leverage component:
// weak" — six such rows rendered under a headline that still read 82 /
// A. There is no sentence for a component that was never emitted.
//
// ⚠ IT NO LONGER REPEATS THE METRIC'S NAME. It used to open with the
// bare concept — "Interest coverage component: strong", "Equity ratio
// component: strong" — beside a Value column holding the 0–100
// SUB-SCORE, three screens under ratio cards printing the ratios
// themselves. Measured on all four books, one document each:
//
//   Equity Ratio                              60.9%    (ratio card)
//   Equity ratio                             100.00    (credit row)
//   Interest Coverage (EBITDA / Interest)     66.28×   (ratio card)
//   Interest Coverage (EBIT / Interest)       95.00    (credit row)
//
// The row above is not 95× of coverage; EBIT ÷ interest on that book is
// 55.64×. 95.00 is the score the model banded that ratio into. A name
// that promises an arithmetic beside a number that is not its output is
// the R1 defect in its sharpest form, so the row labels now say
// "sub-score 0–100" and this sentence bands the scale, not the metric.
function readForSubscore(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const band =
    value >= 75 ? "strong" : value >= 50 ? "adequate" : value >= 25 ? "watch zone" : "weak";
  return `${band} on the model's 0–100 component scale`;
}

/** value × weight, absent-propagating — `null * 0.3` is 0 in JavaScript,
 *  a contribution that reads as "this component pulled the score to
 *  nothing" when in truth it was never measured. */
function contributionOf(value: number | null, weight: number | null): number | null {
  return value === null || weight === null ? null : value * weight;
}

/** A number the engine may have omitted. Normalises `undefined` and
 *  JSON `null` to the same absence, so no read has to remember which
 *  shape the envelope used. */
function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── THE ENGINE HAS TWO MOUTHS, AND ONLY ONE OF THEM WAS LISTENED TO ──
//
// ⚠ F2 — ONE PERIOD, TWO COMPOSITES. `stage_compute` persists the credit
// figures TWICE: as `assembled_metrics.credit` (the envelope) and as
// `calculated_metrics` rows (`credit_composite`, `altman_z_score`,
// `altman_x1..x4`, `credit_subscore_*`). The model selector below asked
// only "is there an envelope object", so the exact production shape
// CLAUDE.md §14 documents — envelope null on every period for weeks,
// `calculated_metrics` intact — sent the two surfaces to two models.
// Measured on the real Scandia period with `assembled_metrics.credit`
// and `.piotroski` deleted and `calculated_metrics` untouched:
//
//   /report Section 7   composite 24.4   Z" 0.22       no letter, NO MODEL
//   dashboard / hero    composite 36     Z" 0.20131    CCC, client-fallback-v1
//
// One company, one period, one screen apart: two composites, two
// Altmans, and the page showing the ENGINE's numbers was the one that
// named no model at all.
//
// `calculated_metrics` IS the engine speaking. A period it spoke about is
// an engine period whichever mouth it used, so the selector reads both —
// and the two are merged in ONE place, in the precedence `altmanFromEngine`
// already documents (`calculated_metrics` first, envelope second), so no
// surface holds a precedence of its own.
//
// What the metric rows do NOT carry is a letter or a band ladder. A
// period known only through them therefore yields a composite, an Altman,
// a zone and NO LETTER — which is the settled rule ("a missing engine
// envelope invents no letter anywhere") rather than a new refusal.

/** The `calculated_metrics` rows that ARE the engine's credit claim. */
const ENGINE_CREDIT_METRIC_KEYS = [
  "credit_composite",
  "altman_z_score",
  "altman_x1", "altman_x2", "altman_x3", "altman_x4",
  "credit_subscore_altman", "credit_subscore_profitability", "credit_subscore_leverage",
  "credit_subscore_coverage", "credit_subscore_dscr", "credit_subscore_liquidity",
  "credit_subscore_equity",
] as const;

/** Did the engine speak about credit for this period through the metric
 *  rows? One finite row is a claim; an empty map is not. */
export function engineSpokeInMetrics(
  metricsByName?: Record<string, number | null>,
): boolean {
  if (!metricsByName) return false;
  return ENGINE_CREDIT_METRIC_KEYS.some((k) => numOrNull(metricsByName[k]) !== null);
}

/** ONE merged engine view, in ONE precedence. `calculated_metrics` first,
 *  the envelope second — for EVERY engine-emitted field, not just the
 *  Altman. `letter_grade`, `letter_grade_bands` and `composite_weights`
 *  exist only on the envelope, so they pass through untouched. */
function mergeEngineEnvelope(
  e: CreditEnvelope | undefined,
  m?: Record<string, number | null>,
): CreditEnvelope {
  const pick = (metric: string, fromEnvelope: number | null | undefined): number | null =>
    numOrNull(m?.[metric]) ?? numOrNull(fromEnvelope);
  const subs = e?.subscores ?? {};
  const comps = e?.altman_components ?? {};
  return {
    ...e,
    composite_score: pick("credit_composite", e?.composite_score),
    altman_z_score: pick("altman_z_score", e?.altman_z_score),
    altman_components: {
      x1: pick("altman_x1", comps?.x1),
      x2: pick("altman_x2", comps?.x2),
      x3: pick("altman_x3", comps?.x3),
      x4: pick("altman_x4", comps?.x4),
    },
    subscores: {
      altman: pick("credit_subscore_altman", subs?.altman),
      profitability: pick("credit_subscore_profitability", subs?.profitability),
      leverage: pick("credit_subscore_leverage", subs?.leverage),
      coverage: pick("credit_subscore_coverage", subs?.coverage),
      dscr: pick("credit_subscore_dscr", subs?.dscr),
      liquidity: pick("credit_subscore_liquidity", subs?.liquidity),
      equity: pick("credit_subscore_equity", subs?.equity),
    },
  };
}

/** The Altman reader for an ENGINE period: engine fields only.
 *
 *  Precedence within the engine's own emissions — `calculated_metrics`
 *  first (the per-metric rows, which the FE has always preferred), then
 *  the credit envelope's `altman_z_score` / `altman_components`. Both are
 *  the engine's; neither is a re-derivation. When the engine emitted
 *  neither, the result REFUSES rather than falling back to the FE model,
 *  because a score computed by a different model off different operands
 *  is a different claim about the company. */
/** The first served Altman figure outside the range the envelope declares
 *  for it (`ranges.altman_x1.max`, `ranges.altman_x4.max`,
 *  `ranges.altman_z.bound`), or a non-finite one; null when all are in
 *  range. The bounds are PACK DATA and are read only as served (TC-10),
 *  never against a constant kept in the browser: with NO served bound on
 *  an envelope that owes one (`rangeIsOwed`) the figure has not been read
 *  against its range and is a breach (R-RANGE is absolute). Mirrors
 *  credit_model.altman_out_of_range. */
/** True when this envelope OWES a range beside every figure: it states a
 *  `basis`, so it left the engine under the revision-2 serving contract,
 *  whose boundary serves `ranges` with any credit figure. A figure on such
 *  an envelope with no range beside it was not read against its range and
 *  does not render. An envelope with no `basis` (a body cached before the
 *  contract) is checked for finiteness alone - never against a constant
 *  kept in the browser (TC-10). */
function rangeIsOwed(e: CreditEnvelope): boolean {
  return e.basis === "serve" || e.basis === "as_filed";
}

function altmanRangeBreachOf(
  e: CreditEnvelope,
  metricsByName?: Record<string, number | null>,
): "altman_x1" | "altman_x4" | "altman_z_score" | null {
  const raw = (name: string, env: unknown): unknown => {
    const m = metricsByName?.[name];
    return m !== null && m !== undefined ? m : env;
  };
  const figures: Array<["altman_x1" | "altman_x4" | "altman_z_score", unknown, number | null]> = [
    ["altman_x1", raw("altman_x1", e.altman_components?.x1), numOrNull(e.ranges?.altman_x1?.max)],
    ["altman_x4", raw("altman_x4", e.altman_components?.x4), numOrNull(e.ranges?.altman_x4?.max)],
    ["altman_z_score", raw("altman_z_score", e.altman_z_score), numOrNull(e.ranges?.altman_z?.bound)],
  ];
  for (const [name, v, max] of figures) {
    if (typeof v !== "number") continue;
    // No served bound -> the figure was not read against its range, and an
    // unread figure does not render (mirrors credit_model: a Z″ with no
    // derivable bound is withheld). A persisted Z″ 1584.89 on an envelope
    // without `ranges` rendered here as "Altman Z″ 1584.89, safe zone".
    if (!Number.isFinite(v) || (max === null ? rangeIsOwed(e) : v > max)) return name;
  }
  return null;
}

function altmanFromEngine(
  e: CreditEnvelope,
  metricsByName?: Record<string, number | null>,
): AltmanResult {
  const merged: Record<string, number | null> = {
    altman_z_score: numOrNull(metricsByName?.altman_z_score) ?? numOrNull(e.altman_z_score),
    altman_x1: numOrNull(metricsByName?.altman_x1) ?? numOrNull(e.altman_components?.x1),
    altman_x2: numOrNull(metricsByName?.altman_x2) ?? numOrNull(e.altman_components?.x2),
    altman_x3: numOrNull(metricsByName?.altman_x3) ?? numOrNull(e.altman_components?.x3),
    altman_x4: numOrNull(metricsByName?.altman_x4) ?? numOrNull(e.altman_components?.x4),
  };
  // R-RANGE, on the reader: a served Z″, X1 or X4 outside the range the
  // SAME envelope declares is withheld here whatever else was served (the
  // 1-RON-liabilities shape: Z″ 10416.74 / X4 10000 rendered "Altman Z″
  // 10416.74, sub-score 100" beside `ranges.altman_z.bound` 114.83).
  const breach = altmanRangeBreachOf(e, metricsByName);
  if (breach !== null) {
    merged.altman_z_score = null;
    if (breach !== "altman_z_score") merged[breach] = null;
  }
  // A component the engine REFUSED is absent here too, with its reason —
  // never a metric row (written before the refusal existed) standing in.
  const x2Ref = e.altman_component_refusals?.x2;
  const x2Refusal = x2Ref && (x2Ref.text_en || x2Ref.text_ro)
    ? {
      code: String(x2Ref.cause ?? x2Ref.code ?? "refused"),
      text: { en: String(x2Ref.text_en ?? x2Ref.text_ro), ro: String(x2Ref.text_ro ?? x2Ref.text_en) },
    }
    : null;
  if (x2Refusal) merged.altman_x2 = null;
  const out = merged.altman_z_score !== null
    ? altmanReaderOf(merged)
    // No engine score. Emit the components the engine DID send (so the
    // breakdown table still shows what is known) with no score and no zone.
    : altmanReaderOf(merged, /* refuseScore */ true);
  // X3 and X4 absent beside the engine's refusal of the Altman component
  // carry that sentence (X4 on equity short by the refused result carries
  // X2's: equity is its numerator).
  const altRef = e.refused_subscores?.altman;
  const altText = typeof altRef?.text === "string" && altRef.text.trim() ? altRef.text.trim() : null;
  const altRefusal = altText
    ? { code: String(altRef?.code ?? "refused"), text: { en: altText, ro: altText } }
    : null;
  const refusals = {
    x2: x2Refusal,
    x3: merged.altman_x3 === null ? altRefusal : null,
    x4: merged.altman_x4 === null ? (x2Refusal ?? altRefusal) : null,
  };
  if (!refusals.x2 && !refusals.x3 && !refusals.x4) return out;
  const byRow = [null, refusals.x2, refusals.x3, refusals.x4];
  return {
    ...out,
    weightedComponents: out.weightedComponents.map((w, i) =>
      w.value === null && byRow[i] ? { ...w, refusal: byRow[i] } : w),
    componentRefusals: Object.fromEntries(Object.entries(refusals).filter(([, v]) => v)) as AltmanResult["componentRefusals"],
  };
}

// ── THE LADDER. ONE OF THEM, AND IT BELONGS TO THE ENGINE ───────────
//
// ⚠ THERE WAS A SECOND ONE, HARDCODED IN A COMPONENT.
// `CreditScoreCard.compositeToGrade()` re-implemented the F1.h band
// table in the frontend and `/report` minted its letter with it —
// reading `calculated_metrics.credit_composite` and never once looking
// at `assembled_metrics.credit.letter_grade` or at the envelope's own
// `letter_grade_bands`. A replica ladder is a second model by another
// name: it agrees with the engine only for as long as nobody re-bands,
// and F1.h IS a re-banding that already happened once. Measured on the
// real Scandia envelope with the engine re-banded to letter_grade "B"
// and its own bands shipped alongside:
//
//     /dashboard Risks tab · hero · workbook   B   (engine ladder)
//     /report Section 7                        CC  (frontend replica)
//
// The replica is deleted. These two functions are the only place a
// composite becomes a letter on the engine path, and they read the
// ladder the ENGINE sent rather than a copy of it, so a re-band moves
// every surface on the same deploy.

/** Band a composite with the ENGINE'S OWN ladder. Highest `min` that the
 *  composite reaches wins, so the array's order is not load-bearing.
 *
 *  Refuses (null) rather than guessing: no ladder, no composite, or a
 *  composite below every band means there is no letter — never a
 *  frontend default ladder standing in for one the engine did not send. */
export function letterFromEngineBands(
  bands: Array<{ min: number; grade: string }> | null | undefined,
  composite: number | null,
): string | null {
  if (!Array.isArray(bands) || bands.length === 0) return null;
  if (composite === null || !Number.isFinite(composite)) return null;
  let best: { min: number; grade: string } | null = null;
  for (const b of bands) {
    if (typeof b?.min !== "number" || !Number.isFinite(b.min) || typeof b?.grade !== "string") continue;
    if (composite >= b.min && (best === null || b.min > best.min)) best = b;
  }
  return best?.grade ?? null;
}

/** THE letter for an engine period: the engine's own `letter_grade` when
 *  it sent one, else its own `letter_grade_bands` applied to the
 *  composite the reader is looking at, else nothing.
 *
 *  `composite` is passed in rather than read off the envelope so the
 *  letter is always banded from the NUMBER ON SCREEN — a letter banded
 *  from a composite the surface is not displaying is the same class of
 *  defect as a sentence computed off a different score. */
export function engineLetterGrade(
  e: CreditEnvelope,
  composite: number | null,
): string | null {
  const stated = typeof e.letter_grade === "string" && e.letter_grade.length > 0 ? e.letter_grade : null;
  return stated ?? letterFromEngineBands(e.letter_grade_bands, composite);
}

/** The engine model's weight table (credit_model.CREDIT_COMPOSITE_WEIGHTS),
 *  used for an envelope that carries no `composite_weights` object (it
 *  predates the served weights). The weights are CONSTANTS of the model —
 *  never renormalised (R-COMPOSITE) — so a served object carries these
 *  same seven numbers; a served object is still read verbatim. */
const ENGINE_MODEL_WEIGHTS: Record<CreditSubscoreKey, number> = {
  altman: 0.30, profitability: 0.20, leverage: 0.15, coverage: 0.10, dscr: 0.10, liquidity: 0.10, equity: 0.05,
};

/** The composite refusal as this reader states it. */
export interface CreditCompositeRefusalRead {
  code: string;
  sentence: string;
  /** The refused components' subjects, in the model's order. */
  components: string[];
  /** TRUE when the ENGINE stated the refusal (a served reason, a served
   *  refused component, a row the model emitted with no value, a served
   *  composite withheld here for range or for sitting beside a refused
   *  component). FALSE when the envelope simply carries no composite and
   *  names nothing — the engine said nothing about credit, which is the
   *  one case a surface may treat as "no card" rather than "refused". */
  stated: boolean;
}

/** The range a served score is re-checked against before it renders
 *  (C9.4): the envelope's pack range, AS SERVED. There is no browser
 *  constant behind it (TC-10: a range is pack data) — this once fell back
 *  to a literal [0, 100], so an envelope that served no `ranges` had its
 *  figures "checked" against a number the engine never sent. NULL when the
 *  envelope serves no usable range: on an envelope that owes one
 *  (`rangeIsOwed`) the figure has then not been read against its range,
 *  and R-RANGE is absolute — an unread figure does not render
 *  (`outOfRange` below). */
function scoreRangeOf(
  e: CreditEnvelope,
  which: "subscore" | "composite",
): { min: number; max: number } | null {
  const r = e.ranges?.[which];
  const min = numOrNull(r?.min);
  const max = numOrNull(r?.max);
  return min !== null && max !== null && min < max ? { min, max } : null;
}

/** True when a served figure may NOT render: it is not finite, it lies
 *  outside the served range, or no range was served to read it against on
 *  an envelope that owes one. */
function outOfRange(
  v: number | null,
  r: { min: number; max: number } | null,
  owed: boolean,
): boolean {
  if (v === null) return false;
  if (r === null) return owed || !Number.isFinite(v);
  return !Number.isFinite(v) || v < r.min || v > r.max;
}

const SUBSCORE_SUBJECT: Record<CreditSubscoreKey, string> = {
  altman: "Altman Z″",
  profitability: "profitability",
  leverage: "leverage",
  coverage: "interest coverage",
  dscr: "DSCR",
  liquidity: "liquidity",
  equity: "equity ratio",
};

/** Why the engine refused a sub-score, in words — used ONLY when the
 *  envelope served a code without its sentence. A served `text` wins. A
 *  code this reader does not know still states the refusal and names the
 *  code rather than guessing. */
const REFUSAL_BECAUSE: Record<string, string> = {
  total_liabilities_below_materiality:
    "total liabilities are below the model's materiality share of total assets, so Altman X4 (equity ÷ liabilities) is not defined",
  current_liabilities_not_positive:
    "current liabilities are not positive, so the current, quick and cash ratios have no base",
  revenue_not_positive: "revenue is not positive, so net margin and the profitability blend are not defined",
  interest_expense_not_positive:
    "interest expense is not positive and the no-interest-bearing-debt rule does not apply, so coverage is not measured",
  credit_out_of_range: "the figure lies outside the range the model declares for it",
  credit_inputs_absent: "the model's inputs for it were not filed",
};

const COMPOSITE_REFUSED_TAIL = "; with a component unscored there is no composite and no letter.";

/** The weight a row carried and, when the engine scored the composite
 *  without it, the refusal — from the ENVELOPE ONLY.
 *
 *  ⚠ THIS WAS `numOrNull(weights.x) ?? <model default>`. Credit model
 *  revision 2 serves renormalised weights with no entry for a refused
 *  sub-score, and the default filled the hole: measured on the served
 *  `saga_compact_6_col` envelope, the rows printed 30/33/25/17/17/10/8
 *  (140%) beside a composite of 97.5 that was summed over five terms.
 *
 *  Precedence: a served refusal wins; else a served weights object is
 *  authoritative (a missing key beside an absent sub-score is a refusal
 *  whose reason was not served; beside a present one it is simply an
 *  unreported weight); only with NO weights object does the model table
 *  apply — and only when `weightBasisOf` says the composite could have
 *  been multiplied by it. */
function engineWeightOf(
  e: CreditEnvelope,
  key: CreditSubscoreKey,
  subscore: number | null,
  basis: "served" | "model_table",
  metricsByName?: Record<string, number | null>,
): { weight: number | null; refusal: CreditSubscoreRefusal | null } {
  const refused = e.refused_subscores?.[key];
  const weights = e.composite_weights ?? {};
  // THE WEIGHT IS A CONSTANT OF THE MODEL and it stays on the row, refused
  // or not (R-COMPOSITE: never renormalised). What a refused row loses is
  // its contribution and, with it, the composite.
  const weight = basis === "served" ? numOrNull(weights[key]) : ENGINE_MODEL_WEIGHTS[key];
  const rangeBreach =
    outOfRange(subscore, scoreRangeOf(e, "subscore"), rangeIsOwed(e)) ||
    (key === "altman" && altmanRangeBreachOf(e, metricsByName) !== null);
  // A REFUSAL IS SOMETHING THE ENGINE SAID, not a hole in the envelope:
  //   · a served `refused_subscores` entry;
  //   · a served weights object that OMITS this key — the renormalised
  //     shape an earlier cut served, refused here, never re-weighted;
  //   · the model's own row (`credit_subscore_<key>`, revision 2 or later)
  //     PRESENT with no value: revision 2 emits every row, so a null row is
  //     the model's refusal even when its reason was not persisted;
  //   · a served sub-score outside its declared range (withheld here).
  // A sub-score that is simply absent from BOTH emissions is an envelope
  // gap: the row prints no figure and no verdict, and the served
  // composite is NOT withheld for it (the completeness law: a headline
  // must not move because a field failed to arrive).
  const metricName = `credit_subscore_${key}`;
  const revision = numOrNull(metricsByName?.credit_model_revision) ?? numOrNull(e.credit_model_revision);
  const rowSaysRefused =
    subscore === null &&
    revision !== null && revision >= 2 &&
    metricsByName !== undefined && metricName in metricsByName && numOrNull(metricsByName[metricName]) === null;
  const weightsOmit = basis === "served" && subscore === null && numOrNull(weights[key]) === null;
  if (refused || rowSaysRefused || weightsOmit || rangeBreach) {
    const code =
      typeof refused?.code === "string" && refused.code.length > 0
        ? refused.code
        : rangeBreach
          ? "credit_out_of_range"
          : null;
    const served = typeof refused?.text === "string" && refused.text.trim().length > 0 ? refused.text.trim() : null;
    const because =
      served !== null
        ? served
        : code === null
          ? weightsOmit && !rowSaysRefused
            ? "the served weights omit it (a renormalised table), so the model did not score it"
            : "the model served no score for it and its reason was not persisted"
          : REFUSAL_BECAUSE[code] ?? `the engine refused it (${code})`;
    return {
      weight,
      refusal: {
        code,
        subject: SUBSCORE_SUBJECT[key],
        sentence: served !== null ? `Not scored — ${served}` : `Not scored — ${because}${COMPOSITE_REFUSED_TAIL}`,
      },
    };
  }
  return { weight, refusal: null };
}

/** Which weight table the rows print: the served `composite_weights`
 *  verbatim when the envelope carries the object, else the model table
 *  (every envelope before the served weights; revision-2 rows read off
 *  `calculated_metrics` alone). Both are the same seven constants. */
function weightBasisOf(e: CreditEnvelope): "served" | "model_table" {
  const w = e.composite_weights;
  return w !== null && w !== undefined && typeof w === "object" ? "served" : "model_table";
}

/** The composite's refusal as the reader states it (R-COMPOSITE, R-RANGE,
 *  C9.4). Order of authority: a served composite outside its declared
 *  range is withheld here whatever the engine said; a served composite
 *  beside a refused component is withheld (an as-filed composite computed
 *  under an older model, or a renormalised one, must never render); a
 *  null composite states the served `reason`, else the refused rows. */
function compositeRefusalOf(
  e: CreditEnvelope,
  score: number | null,
  components: CreditScoreResult["components"],
): { score: number | null; refusal: CreditCompositeRefusalRead | null } {
  const refusedSubjects = components.filter((c) => c.refusal).map((c) => c.refusal!.subject);
  const range = scoreRangeOf(e, "composite");
  if (score !== null && outOfRange(score, range, rangeIsOwed(e))) {
    const also =
      refusedSubjects.length > 0
        ? ` ${joinSubjects(refusedSubjects)} ${refusedSubjects.length === 1 ? "was" : "were"} not scored either.`
        : "";
    return {
      score: null,
      refusal: {
        code: "credit_out_of_range",
        sentence:
          range === null
            ? `No composite and no letter: the composite was served with no declared range to read it against, so it is withheld.${also}`
            : `No composite and no letter: the served composite ${score} lies outside the model's declared range [${range.min}, ${range.max}], so it is withheld.${also}`,
        components: refusedSubjects,
        stated: true,
      },
    };
  }
  if (score !== null && refusedSubjects.length > 0) {
    return {
      score: null,
      refusal: {
        code: "credit_component_undefined",
        sentence:
          `No composite and no letter: the served composite ${score} was scored beside unscored ` +
          `${joinSubjects(refusedSubjects)}; the model's weights are never redistributed over the ` +
          `components that scored, so a composite computed without them is withheld.`,
        components: refusedSubjects,
        stated: true,
      },
    };
  }
  if (score !== null) return { score, refusal: null };
  const served = e.reason;
  const servedCode = typeof served?.code === "string" && served.code.length > 0 ? served.code : null;
  const servedText = typeof served?.text === "string" && served.text.trim().length > 0 ? served.text.trim() : null;
  if (refusedSubjects.length > 0) {
    return {
      score: null,
      refusal: {
        code: servedCode ?? "credit_component_undefined",
        sentence:
          servedText ??
          `No composite and no letter: ${joinSubjects(refusedSubjects)} ${refusedSubjects.length === 1 ? "was" : "were"} not scored for this period, and the model's weights are never redistributed over the components that scored.`,
        components: refusedSubjects,
        stated: true,
      },
    };
  }
  return {
    score: null,
    refusal: {
      code: servedCode ?? "credit_inputs_absent",
      sentence: servedText ?? "No composite and no letter: the engine served no credit composite for this period and named no refused component.",
      components: [],
      stated: servedCode !== null,
    },
  };
}

function joinSubjects(subjects: string[]): string {
  return subjects.length <= 1
    ? subjects.join("")
    : `${subjects.slice(0, -1).join(", ")} and ${subjects[subjects.length - 1]}`;
}

/** ONE constructor for the six weighted sub-score rows, so a value, its
 *  contribution and its "read" cannot disagree about whether the
 *  component exists — they are all derived from the same `numOrNull`. */
function subscoreRow(
  label: string,
  e: CreditEnvelope,
  key: CreditSubscoreKey,
  basis: "served" | "model_table",
  metricsByName?: Record<string, number | null>,
): CreditScoreResult["components"][number] {
  const served = numOrNull(e.subscores?.[key]);
  const { weight, refusal } = engineWeightOf(e, key, served, basis, metricsByName);
  // A refused row carries NO value: an out-of-range served figure is
  // withheld here, not printed beside its refusal.
  const value = refusal ? null : served;
  const rung = declaredRungOf(e, key, value);
  return {
    label,
    value,
    // On these six rows the displayed value IS the weighted input — a
    // 0–100 sub-score, NOT the ratio the model banded to get it. The
    // label says so; see `readForSubscore` for what that cost.
    subscore: value,
    weight,
    contribution: contributionOf(value, weight),
    refusal,
    declaredRung: rung,
    read: rung ? `Declared rung ${rung.score}, not measured — ${rung.label}` : readForSubscore(value),
  };
}

/** The served declared rung for a scored row (R-D1/D2/D3), or null. Only
 *  a rung whose score is the served sub-score is honoured: a label beside
 *  a different number would be a second authority. */
function declaredRungOf(
  e: CreditEnvelope,
  key: CreditSubscoreKey,
  value: number | null,
): CreditScoreResult["components"][number]["declaredRung"] {
  const r = e.declared_rungs?.[key];
  const score = numOrNull(r?.score);
  if (!r || value === null || score === null || score !== value) return null;
  const label = typeof r.label === "string" && r.label.length > 0 ? r.label : "declared by rule";
  return { score, label, source: r.source ?? "", file: r.file ?? "" };
}

/** THE ENGINE-CANONICAL READER — the whole engine path, on its own, and
 *  the ONE function every surface that can show an engine verdict calls.
 *
 *  It takes NO `Statements`, and that is the point: the engine branch
 *  never read the served statements, so a surface that holds only the
 *  engine's emissions (`/report`, which fetches a loose `/api/period`
 *  shape and has no `Statements` to build) can call exactly this instead
 *  of holding a reader of its own. `/report`'s card used to be that
 *  second reader — its own precedence, its own refusal rule, and (before
 *  the earlier wave) its own band ladder.
 *
 *  Returns NULL when the engine did not speak about credit for this
 *  period through EITHER emission path, which is the one case the client
 *  fallback exists for. */
export function engineCreditResult(
  creditEnvelope?: CreditEnvelope,
  piotroskiEnvelope?: PiotroskiEnvelope,
  metricsByName?: Record<string, number | null>,
): CreditScoreResult | null {
  // ── F2.4 ENGINE-CANONICAL PATH ──────────────────────────────────────
  //
  // ⚠ FOUND BY THE COMPLETENESS-LAW GATE. The guard used to require
  // `typeof creditEnvelope.composite_score === "number"`, so an engine
  // period that emitted a credit envelope WITHOUT a composite fell
  // through to the FE parallel model below — a DIFFERENT weighting
  // (40/20/15/10/10/5 against the engine's 30/20/15/10/10/10/5), a
  // DIFFERENT band ladder, and therefore a DIFFERENT LETTER. Measured on
  // the real Scandia envelope: deleting only `composite_score` moved the
  // rating from CC to CCC — a rating that is a function of envelope
  // completeness, which is the exact thing this file must not do.
  //
  // An engine period is now read by the engine reader, whatever it
  // omitted: a missing composite yields NO composite (and the engine's
  // own letter, if it sent one), never a second opinion computed here.
  // The FE fallback stays for sample data with no engine envelope at all.
  // ── THE MODEL IS SELECTED BY ONE THING: DID THE ENGINE SPEAK? ──────
  //
  // ⚠ THIS GUARD READ `creditEnvelope && piotroskiEnvelope`. The second
  // conjunct is not a model selector — the Piotroski envelope feeds a
  // DISPLAY BLOCK below and contributes nothing to the composite, the
  // weights or the letter. Requiring it meant that a period whose credit
  // envelope arrived complete (composite 24.4, letter CC, all seven
  // sub-scores) but whose Piotroski envelope did not was answered by the
  // OTHER MODEL: CCC / 36 / Z" 0.2013, off different weights and a
  // different band ladder. CLAUDE.md §14 records exactly that field
  // returning null on every production period for weeks.
  //
  // A credit envelope — even an EMPTY one — is the engine's credit
  // claim for this period, and it is the only thing that chooses the
  // model. An empty one refuses (score null, rating null), which is the
  // correct answer and is asserted by the completeness gate; what it
  // must never do is hand the question to a second model.
  //
  // ⚠ AND "DID THE ENGINE SPEAK" IS NOT "IS THERE AN ENVELOPE OBJECT".
  // See `engineSpokeInMetrics` above: `calculated_metrics` is the engine's
  // second emission path, and a period known only through it was being
  // answered by the OTHER model here while `/report` printed the engine's
  // own composite off the same rows. One period, two composites (24.4
  // against 36) and two Altmans (0.22 against 0.20131). The selector now
  // asks whether the engine spoke AT ALL, and the merge below gives every
  // surface one view of what it said.
  if (!creditEnvelope && !engineSpokeInMetrics(metricsByName)) return null;
  {
    const e = mergeEngineEnvelope(creditEnvelope, metricsByName);
    const piotroski = piotroskiEnvelope ? piotroskiFromEngine(piotroskiEnvelope) : null;
    // ⚠ ONE AUTHORITY FOR THE ALTMAN FIGURE. This used to call
    // `altmanZScore(s, metricsByName)` while the row below took its
    // `value` from `e.altman_z_score` — two sources for one number, which
    // is F3: measured, deleting only `calculated_metrics.altman_z_score`
    // left the credit envelope's 0.22 on the row while the sentence beside
    // it was computed from a re-derived 0.2013, and with a healthier
    // envelope the same split printed 3.09 labelled "Distress zone".
    // `e.altman_components` was declared on the type and read by nothing.
    //
    // The engine path now reads ONLY engine-emitted Altman inputs, in
    // one merged map. If the engine sent a credit envelope but no Altman,
    // the answer is "no Altman" — never the FE's own arithmetic, which is
    // a different model and would make the score a function of which
    // fields survived.
    const altman = altmanFromEngine(e, metricsByName);
    const subs = e.subscores ?? {};
    const weightBasis = weightBasisOf(e);
    const altmanWeight = engineWeightOf(e, "altman", numOrNull(subs.altman), weightBasis, metricsByName);
    const altmanSubscore = altmanWeight.refusal ? null : numOrNull(subs.altman);

    // ── F1 — THE SEVEN SUBSTITUTIONS ────────────────────────────────
    // Each row below carried THREE `?? 0`s: on the value, on the
    // contribution, and inside the "read". Measured on the real Scandia
    // envelope with `subscores` deleted, all six non-Altman rows printed
    // 0.00 / "weak" under an unchanged composite of 24.4 and an
    // unchanged letter grade. The rows now refuse; the weight is a
    // CONSTANT of the model, so it survives, but a weight with no value
    // yields no contribution.
    //
    // The Altman row is F3: its `value` came from the credit envelope
    // and its `read` from `altman.zone`, which on a period without
    // `metricsByName` is computed off a DIFFERENT (FE-fallback)
    // arithmetic — measured printing value 3.09 beside the sentence
    // "Distress zone — immediate action required". Both now come from
    // ONE score, and the zone comes from `zoneFor` applied to THAT score.
    //
    // ⚠ AND THE ROW ITSELF WAS STILL A SECOND ALTMAN. `numOrNull(
    // e.altman_z_score) ?? altman.score` preferred the ENVELOPE, while
    // `altmanFromEngine` — whose result the Risks tab renders as
    // `data-testid="altman-score"` and whose zone paints the chip beside
    // it — prefers `calculated_metrics`. Two engine-emitted inputs, two
    // different precedences, one measure. Measured on the real Scandia
    // envelope with the two inputs split (envelope 0.22, metrics 3.09):
    //
    //     Risks tab  altman-score  3.09   zone chip  SAFE
    //     same panel, component row 0.22   read       "Distress zone —
    //                                                  immediate action
    //                                                  required"
    //
    // one panel, one company, a SAFE chip beside a DISTRESS sentence.
    // `altmanFromEngine` is now the ONLY Altman authority on this path:
    // the row's value IS `altman.score`, and its zone IS `altman.zone`
    // (derived from that same score against the same module-scope
    // thresholds), so the number, the chip and the sentence cannot come
    // apart. Precedence lives in ONE place — `altmanFromEngine`'s
    // documented `calculated_metrics` → envelope order.
    const altmanValue = altman.score;
    const altmanZone = altman.zone;
    // Revision 5: the regime this grade was composed under, as served.
    const regime = readCreditRegime(e.regime);
    const components: CreditScoreResult["components"] = [
      {
        label: altmanLabelOf(altman.variant),
        value: altmanValue,
        // The Z" is what the row DISPLAYS; the engine's 0–100
        // `subscores.altman` is what the composite consumes.
        subscore: altmanSubscore,
        weight: altmanWeight.weight,
        contribution: contributionOf(altmanSubscore, altmanWeight.weight),
        refusal: altmanWeight.refusal,
        read:
          altmanValue === null || altmanZone === null
            ? null
            : altmanZone === "safe"
              ? `Safe zone (${altman.thresholds.safe}+ threshold, score ${altmanValue.toFixed(2)})`
              : altmanZone === "grey"
                ? `Grey zone — elevated bankruptcy risk`
                : `Distress zone — immediate action required`,
      },
      // ── THESE ARE SUB-SCORES AND THE LABEL NOW SAYS SO ─────────────
      // Every one of these rows prints a 0–100 number in a column headed
      // "Value", next to a Weight and a Contribution. Six of them used
      // to wear the NAME OF A RATIO — "Equity ratio", "Interest Coverage
      // (EBIT / Interest)" — while the ratio tables above printed those
      // same names against the ratios themselves: 60.9% and 100.00 for
      // one concept, 66.28× and 95.00 for another, in one document, on
      // all four books. The basis stays in the label because the reader
      // still needs to know WHICH coverage was banded (the ratio card
      // states the EBITDA basis; the model bands the EBIT one, and they
      // are 66.28× against 55.64× on agras) — but the name is now the
      // sub-score's, so no name carries two arithmetics.
      subscoreRow("Profitability sub-score 0–100 (ROE + net margin)", e, "profitability", weightBasis, metricsByName),
      // Under the stock-build regime (revision 5) the three cash components
      // divide cash from operations: the label prints the SERVED basis.
      subscoreRow(`Leverage sub-score 0–100 (${regime?.componentBases.leverage?.en ?? "net debt ÷ EBITDA"})`, e, "leverage", weightBasis, metricsByName),
      subscoreRow(`Interest-coverage sub-score 0–100 (${regime?.componentBases.coverage?.en ?? "EBIT ÷ interest"})`, e, "coverage", weightBasis, metricsByName),
      subscoreRow(`DSCR sub-score 0–100 (${regime?.componentBases.dscr?.en ?? "EBITDA ÷ debt service"})`, e, "dscr", weightBasis, metricsByName),
      subscoreRow("Liquidity sub-score 0–100 (current + quick + cash)", e, "liquidity", weightBasis, metricsByName),
      subscoreRow("Equity-ratio sub-score 0–100", e, "equity", weightBasis, metricsByName),
    ];

    // THE COMPOSITE IS RE-CHECKED BEFORE IT RENDERS (R-RANGE, C9.4): out
    // of its declared range, or served beside a refused component, it is
    // withheld with the reason; a null composite states the served reason
    // listing every refused component (R-COMPOSITE).
    const { score: engineScore, refusal: compositeRefusal } = compositeRefusalOf(
      e, numOrNull(e.composite_score), components,
    );
    // ONE LADDER, AND IT IS THE ENGINE'S. `e.letter_grade ?? null` threw
    // away the `letter_grade_bands` the engine ships beside it, so an
    // envelope carrying the ladder but not the letter refused a verdict
    // it had everything to state. `engineLetterGrade` is the same
    // function `/report`'s card calls, so the two surfaces cannot mint
    // different letters from the same envelope. NO SCORE, NO LETTER: a
    // served letter beside a withheld composite is not repeated.
    const engineLetter = engineScore === null ? null : engineLetterGrade(e, engineScore);
    const engineBands = Array.isArray(e.letter_grade_bands) ? e.letter_grade_bands : null;
    return {
      model: "engine-canonical-v1",
      // COMPOSED FROM THE BANDS THE LETTER WAS BANDED WITH — the same
      // array `engineLetterGrade` above just used, and the same weights
      // the seven rows above carry. A re-band moves the sentence.
      modelLabel: creditModelLabel("engine-canonical-v1", engineBands, components),
      score: engineScore,
      compositeRefusal,
      rating: engineLetter,
      // F2.4 — `grade` becomes a mirror of letter_grade (no separate tier
      // descriptor — "investment_strong" / "speculative" disappear per
      // F2 kickoff Decision). RisksPanel's `gradeLabel` render will show
      // the letter; the visible "· investment strong" phrase is gone.
      // A dash is a RENDERING of an absence, not an absence. Deciding
      // how to spell it here forced every consumer — the workbook
      // included — to treat "—" as a real grade.
      grade: engineLetter,
      letterBands: engineBands,
      regime,
      components,
      altman,
      piotroski,
      // COMPOSED, NOT FROZEN. This string used to spell the locked F1.h
      // ladder longhand, two lines under a letter banded with a different
      // one. Same two inputs as `modelLabel`, so the three can never
      // disagree inside one section.
      caveat: creditCaveat("engine-canonical-v1", engineBands, components, altman.variant),
    };
  }
}

export function computeCreditScore(
  s: Statements,
  // F2.4 — Engine canonical envelopes. When either the envelope OR the
  // engine's `calculated_metrics` credit rows are present, this is a thin
  // wrapper over `engineCreditResult` — the same function `/report`'s card
  // calls, so the two surfaces cannot hold two readers. The FE arithmetic
  // fallback below is preserved for sample data and pre-engine periods,
  // where the engine spoke through neither path.
  creditEnvelope?: CreditEnvelope,
  piotroskiEnvelope?: PiotroskiEnvelope,
  metricsByName?: Record<string, number | null>,
): CreditScoreResult {
  const engine = engineCreditResult(creditEnvelope, piotroskiEnvelope, metricsByName);
  if (engine) return engine;

  // ── FE FALLBACK PATH — A SECOND MODEL, AND IT SAYS SO ──────────────
  //
  // Reached ONLY when no credit envelope exists for the period at all
  // (sample datasets, pre-engine cached periods). It is a genuinely
  // different model — different weights, a different band ladder, a
  // different Altman derivation — so it returns a different
  // `model` id and a `modelLabel` that every surface prints beside the
  // letter. Retained rather than deleted because deleting it would blank
  // the verdict on every sample and pre-engine period; made loud rather
  // than silent because a letter whose model the reader cannot see is
  // the defect this lane closed.
  //
  // ⚠ THE COMPLETENESS LAW APPLIES HERE TOO — AND THIS IS THE PATH EVERY
  // EXPORTED WORKBOOK USED TO TAKE. Before this block was reworked, only
  // the Altman row could refuse; every other operand absence produced a
  // plausible substitute. Measured on the real Scandia corpus:
  //
  //   delete canonical_bs.totals.assets              Piotroski 5 → 4
  //                                                  ("ROA positive ✗ —
  //                                                   0.00% on an
  //                                                   unreported total")
  //   delete canonical_bs.totals.current_liabilities cash ratio 0.0433 → 0
  //                                                  ("Thin cash buffer")
  //   delete assembled_bs.current_year_pnl           Z" 0.20131 → 0.19070
  //   delete assembled_bs.retained_earnings          Z" 0.20131 → 0.18591
  const c = canonical(s);
  const industry = (s.industry ?? "").toLowerCase();
  const isCre = industry.startsWith("real_estate");
  const piotroski = runPiotroski(s);
  const altman = altmanZScore(s);

  // Inputs — STATUTORY EBIT/EBITDA, full current liabilities for cash ratio.
  // DSCR uses interest + an estimated principal (10% of LT debt) when the
  // book doesn't carry an explicit annual principal schedule — matches the
  // SME-CRE convention used by Romanian banks for 10-year amortizing loans.
  // ── A REFUSED EBITDA REFUSES EVERY COMPONENT THAT DIVIDES IT ────────
  // The one-EBITDA ruling: when the engine could not measure the stock
  // variation (711), EBITDA, EBIT and everything built on them are
  // refused with its typed reason. `safeDiv(x, null)` is 0 — which read
  // "Strong" leverage and "Below covenant" coverage on a figure nobody
  // computed. Leverage, coverage and DSCR refuse instead, and the
  // completeness law below then mints no composite and no letter.
  const ebitdaRefused = c.ebitdaStatutory === null || c.ebitCoverage === null;
  const plRefusalRow = (subject: string): CreditSubscoreRefusal => ({
    code: c.plRefusal?.code ?? "ebitda_not_served",
    subject,
    sentence: `Not scored — EBITDA refused: ${c.plRefusal?.text.en ?? "the engine served no EBITDA for this period"}`,
  });
  const dte = safeDiv(c.totalDebt, c.ebitdaStatutory);
  // Interest coverage = EBIT / interest (the methodology, CLAUDE.md
  // Appendix A section 5) — the basis the engine's coverage sub-score bands
  // on and, since 2026-09-19, the engine's `interest_coverage` row too.
  //
  // THE SAME EBIT THE ENGINE DIVIDES (the 0.32 / 0.3257 seam, repaired
  // 2026-09-21). This row divided `ebitStatutory` (`operating_ebit`, the
  // operating view with 722 + 767 folded in) while the engine's row and the
  // P&L's printed EBIT line are `assembled_pl.ebit`. On the retail book
  // under tb_parser_v6 the two EBITs are 1,923.78 apart (786,579.83 against
  // 788,503.61, over interest 2,421,110.34), so this card printed 0.33×
  // beside the engine's 0.32× and G4's own recomputation. One operand now.
  const intCov = safeDiv(c.ebitCoverage, c.interestExpense);
  // DSCR — EBITDA / (interest + principal). Principal proxy: 10% of LT debt
  // (typical 10-year amortizing CRE term).
  const principalProxy = c.totalDebt * 0.10;
  const dscr = safeDiv(c.ebitdaStatutory, c.interestExpense + principalProxy);
  // ⚠ `safeDiv` HERE WAS A PRINTED ZERO, NOT A SILENCE. Unlike the three
  // ratios above — whose operands are never absent (`canonical` completes
  // debt/EBITDA/interest from `deriveTotals`), so a 0 there means a
  // genuinely zero denominator and the reads below say so — this one
  // divides by `totalCurrentLiabilities`, which IS `number | null`.
  // Deleting `canonical_bs.totals.current_liabilities` printed cash ratio
  // 0.00 with the sentence "Thin cash buffer" in the Risks table and in
  // the forwarded workbook. `ratioOrNull` refuses instead.
  const cashRatio = ratioOrNull(c.cash, c.totalCurrentLiabilities);

  const altmanScore = scoreAltman(altman);
  const piotroskiScore = scorePiotroski(piotroski);
  const dteScore: number | null = ebitdaRefused ? null : scoreDebtEbitda(dte, isCre);
  // ── ABSENT IS NEVER ZERO, HERE TOO (owner floors ruling, 2026-09-18) ──
  // `safeDiv(ebit, 0)` is 0, and 0 read "Below covenant", sub-score 15: a
  // book with no debt and no interest (carniprod) scored 67.8 BB+ against
  // the engine's labelled-rung 79.3 A, and a public filing that reports no
  // interest expense was rated on a coverage of zero. This model now does
  // exactly what the engine does (credit_model.component_refusals /
  // declared_rungs, R-D1):
  //   measured   interest expense reported and > 0  -> banded as before;
  //   declared   debt == 0, interest == 0, EBIT > 0, ALL THREE REPORTED
  //              -> the top rung, labelled as declared, never as measured;
  //   otherwise  the component REFUSES - and the completeness law below
  //              then mints no composite and no letter.
  const interestReported = !declaredAbsent(s, "interestExpense");
  // Debt is REPORTED when the two legs are, OR when the feed reports the
  // TOTAL itself (`reportedTotals.totalDebt`, SF1 `debt` on the public
  // headline). Coverage, DSCR and the debt-free declaration all read the
  // total, never the maturity split - and the public feed's split is
  // shelved for every ticker (`bank_loans_lt` has no schema-v1 bucket), so
  // reading only the legs meant a listed company reporting total debt 0
  // could never take the declared rung. `deriveTotals` already reads
  // `c.totalDebt` from that same reported total.
  const reportedTotalDebt = s.reportedTotals?.totalDebt;
  const debtReported =
    (typeof reportedTotalDebt === "number" && Number.isFinite(reportedTotalDebt)) ||
    (!declaredAbsent(s, "shortTermDebt") && !declaredAbsent(s, "longTermDebt"));
  const coverageMeasured = !ebitdaRefused && interestReported && c.interestExpense > 0;
  const dscrMeasured = !ebitdaRefused && interestReported && debtReported && c.interestExpense + principalProxy > 0;
  const declaredDebtFree =
    !ebitdaRefused && interestReported && debtReported && c.totalDebt === 0
    && (typeof reportedTotalDebt !== "number" || reportedTotalDebt === 0)
    && c.interestExpense === 0 && (c.ebitCoverage ?? 0) > 0;
  const coverageRefusal: CreditSubscoreRefusal | null = ebitdaRefused
    ? plRefusalRow("interest coverage")
    : coverageMeasured || declaredDebtFree
    ? null
    : {
        code: interestReported ? "interest_expense_not_positive" : "credit_inputs_absent",
        subject: "interest coverage",
        sentence: interestReported
          ? "Not scored — interest expense is not positive, so EBIT / interest is undefined"
          : "Not scored — interest expense is not reported, so EBIT / interest cannot be read",
      };
  const dscrRefusal: CreditSubscoreRefusal | null = ebitdaRefused
    ? plRefusalRow("DSCR")
    : dscrMeasured || declaredDebtFree
    ? null
    : {
        code: interestReported && debtReported ? "interest_expense_not_positive" : "credit_inputs_absent",
        subject: "DSCR",
        sentence: interestReported && debtReported
          ? "Not scored — interest plus estimated principal is not positive, so debt service coverage is undefined"
          : "Not scored — interest expense or debt is not reported, so debt service coverage cannot be read",
      };
  const intCovScore: number | null = coverageMeasured
    ? scoreInterestCoverage(intCov)
    : declaredDebtFree ? COVERAGE_TOP_RUNG : null;
  const dscrScore: number | null = dscrMeasured
    ? scoreDscr(dscr)
    : declaredDebtFree ? DSCR_TOP_RUNG : null;
  const cashRatioScore = scoreCashRatio(cashRatio);

  const components: CreditScoreResult["components"] = [
    {
      label: altmanLabelOf(altman.variant),
      value: altman.score,
      subscore: altmanScore,
      weight: 0.4,
      contribution: contributionOf(altmanScore, 0.4),
      // Value and sentence from ONE score, as in the engine path above.
      read:
        altman.score === null || altman.zone === null
          ? null
          : altman.zone === "safe"
            ? `Safe zone (${altman.thresholds.safe}+ threshold, score ${altman.score.toFixed(2)})`
            : altman.zone === "grey"
              ? `Grey zone — elevated bankruptcy risk`
              : `Distress zone — immediate action required`,
    },
    {
      label: "Piotroski F-Score",
      // ⚠ A REDUCED COUNT IS STILL A MOVED VERDICT. `score` is
      // `passCount`, so a check that could not be RUN drops the printed
      // F-score exactly as a FAILED one does — measured, deleting only
      // `canonical_bs.totals.assets` printed 4 where the intact book
      // prints 5, on both fixtures. As an INPUT TO A COMPOSITE, a screen
      // that did not complete is absent, not lower. (The panel's own
      // Piotroski block still shows the confirmed count with its
      // "N confirmed" framing and marks the unrun check "?", so nothing
      // is hidden — it is just not scored.)
      value: piotroski.unresolvedCount > 0 ? null : piotroski.score,
      subscore: piotroski.unresolvedCount > 0 ? null : piotroskiScore,
      weight: 0.2,
      // NULL when a check could not be RUN. `scorePiotroski` rescales
      // over confirmed checks for the documented prior-period gap, which
      // is fair; it refuses when a CURRENT-period operand was never
      // filed, because rescaling there would let an extraction gap raise
      // the score (5/9 = 55.6 becoming 5/8 = 62.5 off a deleted field).
      contribution: contributionOf(piotroskiScore, 0.2),
      read:
        // The old sentence blamed "prior-period data missing" for EVERY
        // uncertain, including the ones caused by an unfiled current
        // total. A reader who then goes looking for the prior period is
        // being sent to the wrong place.
        // Value and sentence agree about existence, as on every other
        // row: an unrun screen has no number here and therefore no read.
        // The reason travels with the Piotroski block itself (each
        // unrun check is marked "?" and says which figure was missing)
        // and, in the workbook, with its own note row.
        piotroski.unresolvedCount > 0 || piotroski.score === null
          ? null
          : piotroski.uncertainCount > 0
            ? `${piotroski.score} / ${9 - piotroski.uncertainCount} confirmed (${piotroski.uncertainCount} uncertain — prior-period data missing)`
            : piotroski.score >= 7
              ? "Strong quality signals"
              : piotroski.score >= 4
                ? "Mixed quality signals"
                : "Quality indicators failing",
    },
    {
      label: "Debt / EBITDA",
      value: ebitdaRefused ? null : dte,
      subscore: dteScore,
      weight: 0.15,
      contribution: contributionOf(dteScore, 0.15),
      refusal: ebitdaRefused ? plRefusalRow("Debt / EBITDA") : null,
      read: ebitdaRefused ? null : isCre
        ? dte <= 0 || !Number.isFinite(dte)
          ? "Non-positive EBITDA — leverage ratio undefined"
          : dte < 6
            ? "Acceptable for CRE; would be stretched for an operating business"
            : dte < 10
              ? "Above typical CRE comfort zone — monitor covenants"
              : "Materially above CRE comfort — covenant pressure likely"
        : dte < 3
          ? "Strong"
          : dte < 5
            ? "Acceptable"
            : "Elevated",
    },
    {
      label: "Interest coverage (EBIT / interest)",
      value: coverageMeasured ? intCov : null,
      subscore: intCovScore,
      weight: 0.1,
      contribution: contributionOf(intCovScore, 0.1),
      refusal: coverageRefusal,
      declaredRung: !coverageMeasured && declaredDebtFree ? declaredDebtFreeRung(COVERAGE_TOP_RUNG) : null,
      read: coverageMeasured
        ? intCov >= 4 ? "Strong" : intCov >= 2 ? "Adequate" : intCov >= 1 ? "Tight" : "Below covenant"
        : declaredDebtFree ? DECLARED_DEBT_FREE_READ : null,
    },
    {
      // "~" marks the approximation: the principal in the denominator is an
      // ESTIMATE (10% of debt — see principalProxy above), not a real
      // amortization schedule from the upload. FE-fallback path only; the
      // engine-canonical branch above bypasses this entirely.
      label: "~DSCR (EBITDA / est. debt service)",
      value: dscrMeasured ? dscr : null,
      subscore: dscrScore,
      weight: 0.1,
      contribution: contributionOf(dscrScore, 0.1),
      refusal: dscrRefusal,
      declaredRung: !dscrMeasured && declaredDebtFree ? declaredDebtFreeRung(DSCR_TOP_RUNG) : null,
      read: !dscrMeasured
        ? declaredDebtFree ? DECLARED_DEBT_FREE_READ : null
        : (dscr >= 1.4
          ? "Inside typical 1.20× covenant with modest headroom"
          : dscr >= 1.2
            ? "At covenant floor — limited shock absorption"
            : "Below typical covenant") +
        " · principal estimated at 10% of debt (no amortization schedule in the trial balance)",
    },
    {
      label: "Cash ratio (cash / current liabilities)",
      value: cashRatio,
      subscore: cashRatioScore,
      weight: 0.05,
      contribution: contributionOf(cashRatioScore, 0.05),
      // Value and sentence from ONE number, and both absent together —
      // "Thin cash buffer" over an unreported current-liabilities total
      // is a verdict about the extraction wearing the company's name.
      read:
        cashRatio === null
          ? null
          : cashRatio >= 0.5
            ? "Strong near-term liquidity"
            : cashRatio >= 0.2
              ? "Healthy near-term liquidity"
              : "Thin cash buffer",
    },
  ];

  // ── THE COMPLETENESS LAW, AT THE ONE PLACE A RATING IS MINTED ──────
  // `sum + null` is the sum unchanged, so a component that could not be
  // computed used to shrink the composite silently and the band below
  // turned that smaller number into a WORSE LETTER. Measured on the
  // balanced corpus fixture: intact → 88.80 / A; `totals` emptied →
  // 52.30 / B, off the same statements and the same line items. A
  // composite missing a term is not a lower composite, it is no
  // composite — and no composite means no rating and no grade.
  const missing = components.filter((c) => c.contribution === null);
  const score =
    missing.length > 0
      ? null
      : Math.round(components.reduce((sum, c) => sum + (c.contribution as number), 0) * 10) / 10;
  const band = score === null ? null : ratingBand(score);

  // This model's OWN ladder, exposed the same way the engine's is, so a
  // printed document shows which of the two produced the letter it is
  // carrying rather than leaving the reader to assume there is only one.
  // It is also the array BOTH sentences below are composed from — the
  // fallback carried its own frozen prose ladder ("bands A ≥ 85 … CC ≥ 0")
  // for exactly the same reason the engine path did.
  const fallbackBands = RATING_BANDS.map((b) => ({ min: b.min, grade: b.rating }));
  return {
    model: "client-fallback-v1",
    modelLabel: creditModelLabel("client-fallback-v1", fallbackBands, components),
    score,
    rating: band?.rating ?? null,
    grade: band?.grade ?? null,
    letterBands: fallbackBands,
    components,
    altman,
    piotroski,
    caveat: creditCaveat("client-fallback-v1", fallbackBands, components, altman.variant),
  };
}

interface RatingBand {
  min: number;
  rating: string;
  grade: string;
}

const RATING_BANDS: RatingBand[] = [
  { min: 85, rating: "A", grade: "investment_strong" },
  { min: 75, rating: "BBB", grade: "investment_grade" },
  { min: 65, rating: "BB+", grade: "boundary" },
  { min: 55, rating: "BB", grade: "speculative" },
  { min: 40, rating: "B", grade: "highly_speculative" },
  { min: 25, rating: "CCC", grade: "substantial_risk" },
  { min: 0, rating: "CC", grade: "distress" },
];

function ratingBand(score: number): { rating: string; grade: string } {
  const band = RATING_BANDS.find((b) => score >= b.min) ?? RATING_BANDS[RATING_BANDS.length - 1];
  return { rating: band.rating, grade: band.grade };
}

// Component scoring functions — each returns 0–100.

/** NULL when there is no Z" to score. Returning a number here — 15, the
 *  distress value — is precisely how "the parser missed a line" became
 *  "this company is distressed": the composite absorbed it at 40% weight
 *  and the letter grade fell out the other end looking computed. */
function scoreAltman(altman: AltmanResult): number | null {
  const { score, zone } = altman;
  if (score === null || zone === null) return null;
  if (zone === "distress") return 15;
  if (zone === "grey") {
    // Smooth interpolation across the grey band.
    if (score > 2.0) return 55;
    if (score > 1.5) return 45;
    return 30;
  }
  // Safe zone — score 70+ with smooth scaling above 2.60.
  if (score > 4.0) return 90;
  if (score > 3.0) return 80;
  return 70;
}

function scorePiotroski(p: PiotroskiResult): number | null {
  // A check that could not be RUN is not a check that was scaled away.
  // Rescaling over confirmed checks is right for the model's disclosed
  // prior-period gap; applying the same rescale to an EXTRACTION gap
  // makes a deleted field IMPROVE the reading — 5 passes over 9 is
  // 55.6, and losing one denominator to an unfiled total-assets makes it
  // 5 over 8 = 62.5 off the identical company.
  if (p.unresolvedCount > 0) return null;
  // Nothing evaluated → no sub-score (it was 0 / max(0, 1) = 0).
  if (p.score === null || p.passCount + p.failCount === 0) return null;
  const denom = Math.max(9 - p.uncertainCount, 1);
  return Math.min((p.passCount / denom) * 100, 100);
}

function scoreDebtEbitda(dte: number, isCre: boolean): number {
  if (!Number.isFinite(dte) || dte <= 0) return 30;
  // Industry-aware thresholds.
  const t = isCre
    ? { strong: 4, healthy: 6, watch: 8, critical: 10 }
    : { strong: 2, healthy: 3, watch: 4, critical: 6 };
  if (dte <= t.strong) return 90;
  if (dte <= t.healthy) return 70;
  if (dte <= t.watch) return 55;
  if (dte <= t.critical) return 35;
  return 15;
}

/** The top rung of each coverage ladder below - what R-D1 DECLARES for a
 *  book with no interest-bearing debt, no interest expense and a positive
 *  EBIT, all three reported. Read off the ladders themselves, never typed
 *  a second time. */
const COVERAGE_TOP_RUNG = scoreInterestCoverage(Number.MAX_VALUE);
const DSCR_TOP_RUNG = scoreDscr(Number.MAX_VALUE);
const DECLARED_DEBT_FREE_READ =
  "No interest-bearing debt and no interest expense on a positive EBIT: scored at the top rung by declared rule, not measured";
function declaredDebtFreeRung(score: number): { score: number; label: string; source: string; file: string } {
  return { score, label: DECLARED_DEBT_FREE_READ, source: "client-fallback-v1 R-D1", file: "frontend/lib/financialValuation.ts" };
}

function scoreInterestCoverage(ic: number): number {
  if (!Number.isFinite(ic)) return 30;
  if (ic >= 6) return 95;
  if (ic >= 4) return 85;
  if (ic >= 3) return 65;
  if (ic >= 2) return 50;
  if (ic >= 1.5) return 35;
  if (ic >= 1.0) return 25;
  return 15;
}

function scoreDscr(dscr: number): number {
  if (!Number.isFinite(dscr)) return 30;
  if (dscr >= 1.5) return 90;
  if (dscr >= 1.4) return 75;
  if (dscr >= 1.25) return 60;
  if (dscr >= 1.1) return 45;
  if (dscr >= 1.0) return 30;
  return 15;
}

function scoreCashRatio(cr: number | null): number | null {
  // NULL IN, NULL OUT. `cr` is `ratioOrNull` now, and returning the
  // 25-point "thin buffer" score for an absent ratio is how a missing
  // current-liabilities total used to enter the composite as a finding.
  if (cr === null) return null;
  if (!Number.isFinite(cr) || cr < 0) return 25;
  if (cr >= 0.5) return 85;
  if (cr >= 0.3) return 75;
  if (cr >= 0.2) return 60;
  if (cr >= 0.1) return 40;
  return 25;
}

function priorTotals(s: Statements): DerivedTotals {
  return deriveTotals({
    ...s,
    balanceSheet: s.prior!.balanceSheet,
    incomeStatement: s.prior!.incomeStatement,
    // The prior's own served P&L, never the current one `...s` carries.
    assembled_pl: s.prior!.assembled_pl,
    periodLabel: s.prior!.periodLabel,
    prior: undefined,
  });
}

/** a / b, absent-safe.
 *
 *  ⚠ THE `null` ARM IS LOAD-BEARING. The servedFacts gateway now returns
 *  `number | null` for every BS total, and in JavaScript `x / null` is
 *  `Infinity`, not 0 — `b === 0` alone does not catch it. An `Infinity`
 *  reaching Altman X4 or a coverage subscore reads as PERFECT health off
 *  a total the envelope never carried, which is the same class of lie as
 *  the −1 X4 this gateway change removed (a missing `totals.liabilities`
 *  used to be completed as `0 − equity`, so `equity / liabilities` was
 *  exactly −1). Absent lands on the same 0 a zero denominator does.
 *
 *  RESIDUAL RESOLVED (completeness-law lane): the residual this comment
 *  used to state — "a 0 here still renders as a COMPONENT VALUE in the FE
 *  Altman fallback" — is closed. `AltmanResult.score` and `.zone` are
 *  nullable now and the Altman fallback reads `ratioOrNull` below, so an
 *  absent total refuses the score instead of scoring it 0. `safeDiv`
 *  survives only where a 0 is a rule-engine SILENCE (the FE-fallback
 *  credit sub-scores, each of which is separately absent-guarded), never
 *  where the number is shown to a reader. */
function safeDiv(a: number | null | undefined, b: number | null | undefined): number {
  if (typeof a !== "number" || !Number.isFinite(a)) return 0;
  if (typeof b !== "number" || !Number.isFinite(b) || b === 0) return 0;
  return a / b;
}

/** a / b, REFUSING rather than substituting.
 *
 *  The difference from `safeDiv` is the whole point of this lane: a
 *  ratio whose operand the envelope never carried is `null`, and null
 *  propagates into the score, the zone and the rating instead of being
 *  quietly rounded to a plausible 0. Every live wrong shape is caught
 *  here: `n / null` is `Infinity` (reads as PERFECT health), `null / n`
 *  is 0 (reads as total absence of the thing), `null / 100` is 0 (the
 *  balance-check zero). */
export function ratioOrNull(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (typeof a !== "number" || !Number.isFinite(a)) return null;
  if (typeof b !== "number" || !Number.isFinite(b) || b === 0) return null;
  const q = a / b;
  return Number.isFinite(q) ? q : null;
}

/** a + b, REFUSING rather than treating an absent term as zero.
 *
 *  `x + null` is `x` in JavaScript, so a sum missing a term is not a
 *  smaller sum — it is a DIFFERENT sum that looks complete. Measured:
 *  deleting `assembled_bs.current_year_pnl` moved Altman X2's numerator
 *  by the whole current-year result and Z" from 0.20131 to 0.19070,
 *  under an unchanged CCC. */
export function addOrNull(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (typeof a !== "number" || !Number.isFinite(a)) return null;
  if (typeof b !== "number" || !Number.isFinite(b)) return null;
  return a + b;
}

/** coefficient × component, absent-propagating. `k * null` is 0 in
 *  JavaScript — a weighted term that silently contributes nothing while
 *  looking like it contributed. */
function weigh(coefficient: number, value: number | null): number | null {
  return value === null ? null : coefficient * value;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function fmt(n: number, currency: string): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${currency} ${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${currency} ${(abs / 1_000).toFixed(0)}K`;
  return `${sign}${currency} ${abs.toFixed(0)}`;
}

// ─── Multi-period growth rates ──────────────────────────────────────────────
//
// THE ONE EBITDA, PERIOD BY PERIOD. This table used to rebuild EBITDA as
// `revenue − COGS − opex + other income` for every period — a second
// EBITDA without the measured stock variation (711) and own work
// capitalised (72x), and a "Revenue" row that was whatever the bucket held.
// Each period now prints its SERVED levels (`plLevelsOf` over that
// period's own `assembled_pl`), a refused EBITDA stays a refusal (null,
// with the engine's reason), and growth is over NET TURNOVER. A CAGR runs
// only between two figures on the same EBITDA definition.

export interface GrowthCell {
  period: string;
  /** null = not stated for this period (`refusal` says why). */
  value: number | null;
  refusal: import("./servedOneEbitda").ServedRefusal | null;
}

export interface GrowthRow {
  metric: string;
  values: GrowthCell[];
  /** Compound annual growth across the series; null when either end is
   *  refused / not positive, or the ends sit on different definitions. */
  cagr: number | null;
}

export function periodSeries(s: Statements): PriorPeriod[] {
  // Combine historicalPeriods (oldest first) + prior + current (newest last)
  const series: PriorPeriod[] = [];
  if (s.historicalPeriods?.length) series.push(...s.historicalPeriods);
  if (s.prior && !series.find((p) => p.periodLabel === s.prior!.periodLabel)) {
    series.push(s.prior);
  }
  series.push({
    periodLabel: s.periodLabel,
    balanceSheet: s.balanceSheet,
    incomeStatement: s.incomeStatement,
    // The current period's OWN served P&L — each period reads its own.
    assembled_pl: s.assembled_pl,
  });
  return series;
}

export function multiPeriodGrowth(s: Statements): GrowthRow[] {
  const series = periodSeries(s);
  if (series.length < 2) return [];
  const levels = series.map((p) => plLevelsOf(p));
  const bsTotals = series.map((p) =>
    deriveTotals({
      companyName: "",
      currency: "",
      periodLabel: "",
      balanceSheet: p.balanceSheet,
      incomeStatement: p.incomeStatement,
      assembled_pl: p.assembled_pl,
      supplementary: {},
    }),
  );
  const cell = (i: number, value: number | null, refusal: GrowthCell["refusal"] = null): GrowthCell => ({
    period: series[i].periodLabel,
    value,
    refusal: value === null ? refusal : null,
  });
  /** Account 121 as filed when the period serves it, else the result
   *  built from the accounts. */
  const netResult = (i: number): number | null => {
    const filed = series[i].assembled_pl?.net_income_statutory;
    return typeof filed === "number" && Number.isFinite(filed) ? filed : levels[i].netIncome;
  };
  const rows: Array<{ name: string; cells: GrowthCell[]; sameDefinition: boolean }> = [
    { name: "Net turnover", cells: levels.map((l, i) => cell(i, l.turnover)), sameDefinition: true },
    {
      name: "EBITDA",
      cells: levels.map((l, i) => cell(i, l.ebitda, l.refusal)),
      sameDefinition: levels.every((l) => l.definition === levels[levels.length - 1].definition),
    },
    { name: "Net income", cells: levels.map((l, i) => cell(i, netResult(i), l.refusal)), sameDefinition: true },
    { name: "Total assets", cells: bsTotals.map((t, i) => cell(i, t.totalAssets)), sameDefinition: true },
    {
      name: "Total debt",
      cells: series.map((p, i) => cell(i, p.balanceSheet.shortTermDebt + p.balanceSheet.longTermDebt)),
      sameDefinition: true,
    },
    {
      name: "Equity",
      cells: series.map((p, i) =>
        cell(i, p.balanceSheet.shareCapital + p.balanceSheet.retainedEarnings + p.balanceSheet.otherEquity)),
      sameDefinition: true,
    },
  ];
  return rows.map(({ name, cells, sameDefinition }) => {
    const first = cells[0].value;
    const last = cells[cells.length - 1].value;
    const years = cells.length - 1;
    const cagr =
      sameDefinition && first !== null && last !== null && first > 0 && last > 0 && years > 0
        ? Math.pow(last / first, 1 / years) - 1
        : null;
    return { metric: name, values: cells, cagr };
  });
}
