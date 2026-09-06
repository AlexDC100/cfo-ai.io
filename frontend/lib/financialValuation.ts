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

// ─── FCF / CFO ──────────────────────────────────────────────────────────────

export interface CashFlowSnapshot {
  netIncome: number;
  depreciationAmortization: number;
  workingCapitalChange: number;
  cfo: number;
  capex: number;
  fcf: number;
}

export function deriveCashFlow(s: Statements): CashFlowSnapshot {
  const t = deriveTotals(s);
  const wcChange = workingCapitalChange(s);
  const cfo = t.netIncome + s.incomeStatement.depreciationAmortization - wcChange;
  const capex = s.supplementary.capex ?? s.incomeStatement.depreciationAmortization;
  return {
    netIncome: t.netIncome,
    depreciationAmortization: s.incomeStatement.depreciationAmortization,
    workingCapitalChange: wcChange,
    cfo,
    capex,
    fcf: cfo - capex,
  };
}

function workingCapitalChange(s: Statements): number {
  if (!s.prior) return 0;
  const cur = deriveTotals(s);
  const priorTotals = deriveTotals({
    ...s,
    balanceSheet: s.prior.balanceSheet,
    incomeStatement: s.prior.incomeStatement,
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
  weightOfDebt: number;
  weightOfEquity: number;
  wacc: number;
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
  const impliedTaxRate = t.pbt > 0 ? s.incomeStatement.taxExpense / t.pbt : 0;
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
  const servedEquity = factsFrom(s).totalEquity();
  const equity = Math.max(servedEquity ?? t.totalEquity, 1);
  const wd = debt / (debt + equity);
  const we = 1 - wd;
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
    wacc: we * costOfEquity + wd * kdAfter,
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
  baseFcf: number;
  forecastYears: number;
  forecastGrowthRate: number;
  terminalGrowthRate: number;
  wacc: number;
  yearByYear: DcfYear[];
  terminalValueUndiscounted: number;
  terminalValuePresent: number;
  enterpriseValue: number;
  netDebt: number;
  equityValue: number;
  intrinsicValuePerShare?: number;
  marketPricePerShare?: number;
  upside?: number;
  evToEbitda: number;
  evToRevenue: number;
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
  const cfo = typeof canonicalCfo === "number" ? canonicalCfo : cf.cfo;
  const dep = typeof canonicalDep === "number"
    ? canonicalDep
    : s.incomeStatement.depreciationAmortization;
  const stabilizedFcf = cfo - dep;
  // Use stabilized FCF when positive; else floor at zero (DCF on a
  // genuinely loss-making company is undefined and falls to net debt).
  const baseFcf = Math.max(stabilizedFcf, 0);

  const years: DcfYear[] = [];
  let totalPv = 0;
  for (let y = 1; y <= horizon; y++) {
    const fcf = baseFcf * Math.pow(1 + g, y);
    const df = 1 / Math.pow(1 + k.wacc, y);
    const pv = fcf * df;
    years.push({ year: y, fcf, discountFactor: df, presentValue: pv });
    totalPv += pv;
  }

  // Gordon terminal: TV = FCF_{N+1} / (WACC - g_T). Falls back to a 12× FCF
  // exit multiple when WACC ≤ g_T (degenerate).
  const finalYearFcf = years[years.length - 1]?.fcf ?? baseFcf;
  const tvUndisc =
    k.wacc > gT
      ? (finalYearFcf * (1 + gT)) / (k.wacc - gT)
      : finalYearFcf * 12;
  const tvDf = 1 / Math.pow(1 + k.wacc, horizon);
  const tvPv = tvUndisc * tvDf;

  const ev = totalPv + tvPv;
  // Net debt — prefer canonical view, else legacy derivation.
  const canonicalDebt = s.assembled_bs?.total_debt;
  const canonicalCash = s.assembled_bs?.cash;
  const netDebtCanonical =
    typeof canonicalDebt === "number" && typeof canonicalCash === "number"
      ? canonicalDebt - canonicalCash
      : t.netDebt;
  const equityValue = ev - netDebtCanonical;
  const evToEbitda = t.ebitda > 0 ? ev / t.ebitda : 0;
  const evToRevenue = s.incomeStatement.revenue > 0 ? ev / s.incomeStatement.revenue : 0;

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
    { label: "Optimistic", ...dcfAt(Math.max(k.wacc - 0.01, gT + 0.005)) },
    { label: "Central", ...dcfAt(k.wacc) },
    { label: "Conservative", ...dcfAt(k.wacc + 0.015) },
  ];

  return {
    baseFcf,
    forecastYears: horizon,
    forecastGrowthRate: g,
    terminalGrowthRate: gT,
    wacc: k.wacc,
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
  eps: number;
  growthRate: number;
  bondYield: number;
  intrinsicValuePerShare?: number;
  intrinsicEquityValue: number;
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
  const netIncome = typeof canonicalNi === "number" ? canonicalNi : t.netIncome;
  const shares = s.supplementary.sharesOutstanding;
  const eps = shares && shares > 0 ? netIncome / shares : netIncome;
  const g = (s.supplementary.forecastGrowthRate ?? 0.05) * 100; // pct units
  const yPct = (s.supplementary.riskFreeRate ?? 0.045) * 100;
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
  netIncomeStatutory: number;
  ebitStatutory: number;
  ebitdaStatutory: number;
  cfo: number;
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
  // Statutory net income includes 722; operational view doesn't.
  const netIncomeStatutory =
    typeof pl.net_income_statutory === "number" ? pl.net_income_statutory : t.netIncome;
  const ebitStatutory =
    typeof pl.operating_ebit === "number"
      ? pl.operating_ebit
      : typeof pl.ebitda_statutory === "number"
        ? pl.ebitda_statutory - (pl.depreciation ?? s.incomeStatement.depreciationAmortization)
        : t.ebit;
  const ebitdaStatutory =
    typeof pl.ebitda_statutory === "number" ? pl.ebitda_statutory : t.ebitda;
  const cfo =
    typeof cf.cash_from_operating === "number"
      ? cf.cash_from_operating
      : netIncomeStatutory + (pl.depreciation ?? s.incomeStatement.depreciationAmortization);
  return {
    netIncomeStatutory,
    ebitStatutory,
    ebitdaStatutory,
    cfo,
    totalAssets: sf.totalAssets(),
    totalLiabilities: sf.totalLiabilities(),
    totalEquity: sf.totalEquity(),
    totalCurrentAssets: sf.currentAssets(),
    totalCurrentLiabilities: sf.currentLiabilities(),
    workingCapital: sf.workingCapital(),
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
  score: number;
  band: "Strong (8–9)" | "Solid (6–7)" | "Weak (3–5)" | "Distressed (0–2)";
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
    c.netIncomeStatutory > 0 ? "pass" : "fail",
    fmt(c.netIncomeStatutory, s.currency),
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
    c.cfo > 0 ? "pass" : "fail",
    fmt(c.cfo, s.currency),
  );

  // 4. CFO > NI — earnings cash-backed.
  add(
    "cfo_gt_ni",
    "Quality of earnings (CFO > NI)",
    c.cfo > c.netIncomeStatutory ? "pass" : "fail",
    c.cfo > c.netIncomeStatutory
      ? `CFO ${fmt(c.cfo, s.currency)} > NI ${fmt(c.netIncomeStatutory, s.currency)} — cash-backed`
      : `NI ${fmt(c.netIncomeStatutory, s.currency)} > CFO ${fmt(c.cfo, s.currency)} — possible accrual inflation`,
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
    // 8. Operating margin improving (EBIT / revenue)
    if (priorRevenue > 0 && c.revenue > 0) {
      const margin = safeDiv(c.ebitStatutory, c.revenue);
      const priorEbit =
        typeof priorPl.operating_ebit === "number" ? priorPl.operating_ebit : prior.ebit;
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
  const score = passCount;
  const band: PiotroskiResult["band"] =
    score >= 8 ? "Strong (8–9)" : score >= 6 ? "Solid (6–7)" : score >= 3 ? "Weak (3–5)" : "Distressed (0–2)";

  return { score, band, checks, passCount, failCount, uncertainCount, unresolvedCount };
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
  }>;
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
export interface CreditEnvelope {
  composite_score?: number | null;
  letter_grade?: string | null;
  letter_grade_bands?: Array<{ min: number; grade: string }> | null;
  altman_z_score?: number | null;
  altman_variant?: string | null;
  altman_components?: {
    x1?: number | null; x2?: number | null; x3?: number | null; x4?: number | null;
  } | null;
  composite_weights?: {
    altman?: number | null; profitability?: number | null; leverage?: number | null;
    coverage?: number | null; dscr?: number | null; liquidity?: number | null; equity?: number | null;
  } | null;
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
  const score = env.score ?? passCount;
  const band: PiotroskiResult["band"] =
    score >= 8 ? "Strong (8–9)" :
    score >= 6 ? "Solid (6–7)" :
    score >= 3 ? "Weak (3–5)" :
    "Distressed (0–2)";
  return { score, band, checks, uncertainCount, unresolvedCount, passCount, failCount };
}

// F2.4 — Generate a one-line "read" for a subscore value (0-100).
//
// ⚠ NULL IN, NULL OUT. This used to be called as
// `readForSubscore("Leverage", subs.leverage ?? 0)`, and `0` is finite,
// so an ABSENT sub-score produced the sentence "Leverage component:
// weak" — six such rows rendered under a headline that still read 82 /
// A. There is no sentence for a component that was never emitted.
function readForSubscore(label: string, value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= 75) return `${label} component: strong`;
  if (value >= 50) return `${label} component: adequate`;
  if (value >= 25) return `${label} component: watch zone`;
  return `${label} component: weak`;
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
  if (merged.altman_z_score !== null) return altmanReaderOf(merged);
  // No engine score. Emit the components the engine DID send (so the
  // breakdown table still shows what is known) with no score and no zone.
  return altmanReaderOf(merged, /* refuseScore */ true);
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

/** ONE constructor for the six weighted sub-score rows, so a value, its
 *  contribution and its "read" cannot disagree about whether the
 *  component exists — they are all derived from the same `numOrNull`. */
function subscoreRow(
  label: string,
  readLabel: string,
  raw: number | null | undefined,
  rawWeight: number | null | undefined,
  defaultWeight: number,
): CreditScoreResult["components"][number] {
  const value = numOrNull(raw);
  const weight = numOrNull(rawWeight) ?? defaultWeight;
  return {
    label,
    value,
    // On these six rows the displayed value IS the weighted input.
    subscore: value,
    weight,
    contribution: contributionOf(value, weight),
    read: readForSubscore(readLabel, value),
  };
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
    const weights = e.composite_weights ?? {};

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
    const components: CreditScoreResult["components"] = [
      {
        label: `Altman ${altman.variant}-Score`,
        value: altmanValue,
        // The Z" is what the row DISPLAYS; the engine's 0–100
        // `subscores.altman` is what the composite consumes.
        subscore: numOrNull(subs.altman),
        weight: numOrNull(weights.altman) ?? 0.30,
        contribution: contributionOf(numOrNull(subs.altman), numOrNull(weights.altman) ?? 0.30),
        read:
          altmanValue === null || altmanZone === null
            ? null
            : altmanZone === "safe"
              ? `Safe zone (${altman.thresholds.safe}+ threshold, score ${altmanValue.toFixed(2)})`
              : altmanZone === "grey"
                ? `Grey zone — elevated bankruptcy risk`
                : `Distress zone — immediate action required`,
      },
      subscoreRow("Profitability (ROE + Net Margin)", "Profitability", subs.profitability, weights.profitability, 0.20),
      subscoreRow("Leverage (Net Debt / EBITDA)", "Leverage", subs.leverage, weights.leverage, 0.15),
      subscoreRow("Interest Coverage (EBIT / Interest)", "Interest coverage", subs.coverage, weights.coverage, 0.10),
      subscoreRow("DSCR (EBITDA / debt service)", "DSCR", subs.dscr, weights.dscr, 0.10),
      subscoreRow("Liquidity (Current + Quick + Cash blend)", "Liquidity", subs.liquidity, weights.liquidity, 0.10),
      subscoreRow("Equity ratio", "Equity ratio", subs.equity, weights.equity, 0.05),
    ];

    const engineScore = numOrNull(e.composite_score);
    // ONE LADDER, AND IT IS THE ENGINE'S. `e.letter_grade ?? null` threw
    // away the `letter_grade_bands` the engine ships beside it, so an
    // envelope carrying the ladder but not the letter refused a verdict
    // it had everything to state. `engineLetterGrade` is the same
    // function `/report`'s card calls, so the two surfaces cannot mint
    // different letters from the same envelope.
    const engineLetter = engineLetterGrade(e, engineScore);
    const engineBands = Array.isArray(e.letter_grade_bands) ? e.letter_grade_bands : null;
    return {
      model: "engine-canonical-v1",
      // COMPOSED FROM THE BANDS THE LETTER WAS BANDED WITH — the same
      // array `engineLetterGrade` above just used, and the same weights
      // the seven rows above carry. A re-band moves the sentence.
      modelLabel: creditModelLabel("engine-canonical-v1", engineBands, components),
      score: engineScore,
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
  const dte = safeDiv(c.totalDebt, c.ebitdaStatutory);
  const intCov = safeDiv(c.ebitdaStatutory, c.interestExpense);
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
  const dteScore = scoreDebtEbitda(dte, isCre);
  const intCovScore = scoreInterestCoverage(intCov);
  const dscrScore = scoreDscr(dscr);
  const cashRatioScore = scoreCashRatio(cashRatio);

  const components: CreditScoreResult["components"] = [
    {
      label: `Altman ${altman.variant}-Score`,
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
        piotroski.unresolvedCount > 0
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
      value: dte,
      subscore: dteScore,
      weight: 0.15,
      contribution: dteScore * 0.15,
      read: isCre
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
      label: "Interest coverage (EBITDA / Interest)",
      value: intCov,
      subscore: intCovScore,
      weight: 0.1,
      contribution: intCovScore * 0.1,
      read:
        intCov >= 4 ? "Strong" : intCov >= 2 ? "Adequate" : intCov >= 1 ? "Tight" : "Below covenant",
    },
    {
      // "~" marks the approximation: the principal in the denominator is an
      // ESTIMATE (10% of debt — see principalProxy above), not a real
      // amortization schedule from the upload. FE-fallback path only; the
      // engine-canonical branch above bypasses this entirely.
      label: "~DSCR (EBITDA / est. debt service)",
      value: dscr,
      subscore: dscrScore,
      weight: 0.1,
      contribution: dscrScore * 0.1,
      read:
        (dscr >= 1.4
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

export interface GrowthRow {
  metric: string;
  values: { period: string; value: number }[];
  cagr: number; // compound annual growth across the series
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
  });
  return series;
}

export function multiPeriodGrowth(s: Statements): GrowthRow[] {
  const series = periodSeries(s);
  if (series.length < 2) return [];
  const metrics: { name: string; pick: (p: PriorPeriod) => number }[] = [
    { name: "Revenue", pick: (p) => p.incomeStatement.revenue },
    {
      name: "EBITDA",
      pick: (p) =>
        p.incomeStatement.revenue -
        p.incomeStatement.costOfGoodsSold -
        p.incomeStatement.operatingExpenses +
        (p.incomeStatement.otherIncome ?? 0),
    },
    {
      name: "Net income",
      pick: (p) => {
        const t = deriveTotals({
          companyName: "",
          currency: "",
          periodLabel: "",
          balanceSheet: p.balanceSheet,
          incomeStatement: p.incomeStatement,
          supplementary: {},
        });
        return t.netIncome;
      },
    },
    {
      name: "Total assets",
      pick: (p) => {
        const t = deriveTotals({
          companyName: "",
          currency: "",
          periodLabel: "",
          balanceSheet: p.balanceSheet,
          incomeStatement: p.incomeStatement,
          supplementary: {},
        });
        return t.totalAssets;
      },
    },
    {
      name: "Total debt",
      pick: (p) => p.balanceSheet.shortTermDebt + p.balanceSheet.longTermDebt,
    },
    { name: "Equity", pick: (p) => p.balanceSheet.shareCapital + p.balanceSheet.retainedEarnings + p.balanceSheet.otherEquity },
  ];

  return metrics.map((m) => {
    const values = series.map((p) => ({ period: p.periodLabel, value: m.pick(p) }));
    const first = values[0].value;
    const last = values[values.length - 1].value;
    const years = values.length - 1;
    const cagr =
      first > 0 && last > 0 && years > 0
        ? Math.pow(last / first, 1 / years) - 1
        : 0;
    return { metric: m.name, values, cagr };
  });
}
