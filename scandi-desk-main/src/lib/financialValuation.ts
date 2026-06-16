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
  // Prefer canonical book equity / debt from the assembled BS view.
  const canonBs = s.assembled_bs ?? {};
  const debt = typeof canonBs.total_debt === "number" ? canonBs.total_debt : t.totalDebt;
  const equity = Math.max(
    typeof canonBs.total_equity === "number" ? canonBs.total_equity : t.totalEquity,
    1,
  );
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
  // ── Mature CRE / rental-business growth assumptions ───────────────
  // Forecast 3.5% per year (CPI indexation + modest lease-up).
  // Terminal 3.0% (matches mature CRE indexation; below RON inflation).
  // Replaces the prior 5.0% / 2.5% defaults that overstated 5-year
  // growth and produced an inconsistent perpetuity convergence.
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

function canonical(s: Statements): {
  netIncomeStatutory: number;
  ebitStatutory: number;
  ebitdaStatutory: number;
  cfo: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  totalCurrentAssets: number;
  totalCurrentLiabilities: number;
  workingCapital: number;
  retainedEarningsPlusCurrent: number;
  shareCapital: number;
  totalDebt: number;
  cash: number;
  revenue: number;
  depreciation: number;
  interestExpense: number;
} {
  const t = deriveTotals(s);
  const pl = s.assembled_pl ?? {};
  const bs = s.assembled_bs ?? {};
  const cf = s.assembled_cf ?? {};
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
    totalAssets: typeof bs.total_assets === "number" ? bs.total_assets : t.totalAssets,
    totalLiabilities: typeof bs.total_liabilities === "number" ? bs.total_liabilities : t.totalLiabilities,
    totalEquity: typeof bs.total_equity === "number" ? bs.total_equity : t.totalEquity,
    totalCurrentAssets: t.totalCurrentAssets,
    totalCurrentLiabilities: t.totalCurrentLiabilities,
    workingCapital: t.workingCapital,
    // Z" needs retained earnings + current-year P&L (the cumulative book).
    retainedEarningsPlusCurrent:
      (typeof bs.retained_earnings === "number" ? bs.retained_earnings : s.balanceSheet.retainedEarnings)
      + (typeof bs.current_year_pnl === "number" ? bs.current_year_pnl : 0),
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
}

export interface PiotroskiResult {
  score: number;
  band: "Strong (8–9)" | "Solid (6–7)" | "Weak (3–5)" | "Distressed (0–2)";
  checks: PiotroskiCheck[];
  uncertainCount: number;
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
  ) => checks.push({ key, label, result, pass: result === "pass", detail, requiresPriorPeriod });

  // 1. Net income positive — STATUTORY view.
  add(
    "ni_positive",
    "Net income positive",
    c.netIncomeStatutory > 0 ? "pass" : "fail",
    fmt(c.netIncomeStatutory, s.currency),
  );

  // 2. Return on assets positive — sanity check on the same NI.
  const roa = safeDiv(c.netIncomeStatutory, c.totalAssets);
  add(
    "roa_positive",
    "Return on assets positive",
    roa > 0 ? "pass" : "fail",
    `${(roa * 100).toFixed(2)}% on ${fmt(c.totalAssets, s.currency)} total assets`,
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

    // 5. ROA improving y/y
    const roaPrior = safeDiv(priorNi, priorAssets);
    add(
      "roa_improving",
      "ROA improving year-over-year",
      roa > roaPrior ? "pass" : "fail",
      `${(roaPrior * 100).toFixed(2)}% → ${(roa * 100).toFixed(2)}%`,
      true,
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
    if (priorRevenue > 0 && priorAssets > 0 && c.revenue > 0 && c.totalAssets > 0) {
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
      add(
        "at_improving",
        "Asset turnover improving",
        "uncertain",
        "Prior-period turnover not available",
        true,
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
  const score = passCount;
  const band: PiotroskiResult["band"] =
    score >= 8 ? "Strong (8–9)" : score >= 6 ? "Solid (6–7)" : score >= 3 ? "Weak (3–5)" : "Distressed (0–2)";

  return { score, band, checks, passCount, failCount, uncertainCount };
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

export interface AltmanResult {
  variant: AltmanVariant;
  components: {
    x1_wc_to_assets: number;
    x2_re_to_assets: number;
    x3_ebit_to_assets: number;
    x4_equity_to_liabilities: number;
    x5_sales_to_assets?: number; // F2.2 — no longer populated; kept on type for back-compat
  };
  weightedComponents: Array<{ label: string; coefficient: number; value: number; weighted: number }>;
  score: number;
  zone: "safe" | "grey" | "distress";
  thresholds: { safe: number; distress: number };
  methodologyNote: string;
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

  // Z" thresholds (locked — single variant).
  const Z_DOUBLE_PRIME_THRESHOLDS = { safe: 2.6, distress: 1.1 };
  const Z_DOUBLE_PRIME_METHODOLOGY =
    `Altman Z" (1995) is the variant designed for non-manufacturing companies — real estate, ` +
    `services, SaaS, and emerging markets. It drops the sales/total-assets term that ` +
    `systematically penalizes asset-heavy rental businesses (where the property book is large ` +
    `relative to annual rental income by definition). Coefficients refit on a broader cross-` +
    `industry sample. Thresholds: > 2.60 safe, 1.10–2.60 grey, < 1.10 distress. ` +
    `Engine emits this as the canonical variant for all RAS-based fixtures (F2.2).`;

  // F2.2 — Engine canonical path (preferred).
  const engineScore = m("altman_z_score");
  if (engineScore !== null) {
    const x1 = m("altman_x1") ?? 0;
    const x2 = m("altman_x2") ?? 0;
    const x3 = m("altman_x3") ?? 0;
    const x4 = m("altman_x4") ?? 0;
    const weighted = [
      { label: "Working capital / Total assets", coefficient: 6.56, value: x1, weighted: 6.56 * x1 },
      { label: "(Retained earnings + Current NP) / Total assets", coefficient: 3.26, value: x2, weighted: 3.26 * x2 },
      { label: "EBIT / Total assets", coefficient: 6.72, value: x3, weighted: 6.72 * x3 },
      { label: "Book equity / Total liabilities", coefficient: 1.05, value: x4, weighted: 1.05 * x4 },
    ];
    return {
      variant: 'Z"',
      components: {
        x1_wc_to_assets: x1,
        x2_re_to_assets: x2,
        x3_ebit_to_assets: x3,
        x4_equity_to_liabilities: x4,
      },
      weightedComponents: weighted,
      score: engineScore,
      zone:
        engineScore > Z_DOUBLE_PRIME_THRESHOLDS.safe
          ? "safe"
          : engineScore > Z_DOUBLE_PRIME_THRESHOLDS.distress
            ? "grey"
            : "distress",
      thresholds: Z_DOUBLE_PRIME_THRESHOLDS,
      methodologyNote: Z_DOUBLE_PRIME_METHODOLOGY,
    };
  }

  // F2.2 — FE fallback: compute Z" inline (single variant, no industry
  // switch). Used only when engine row is absent.
  const c = canonical(s);
  const x1 = safeDiv(c.workingCapital, c.totalAssets);
  // Z" uses (retained earnings + current-year P&L) / total assets — the
  // cumulative book of retained profits, not just the carry-forward
  // retained earnings line.
  const x2 = safeDiv(c.retainedEarningsPlusCurrent, c.totalAssets);
  const x3 = safeDiv(c.ebitStatutory, c.totalAssets); // STATUTORY EBIT — never operational
  const x4 = safeDiv(c.totalEquity, c.totalLiabilities); // book equity / total liab for Z"

  const weighted = [
    { label: "Working capital / Total assets", coefficient: 6.56, value: x1, weighted: 6.56 * x1 },
    { label: "(Retained earnings + Current NP) / Total assets", coefficient: 3.26, value: x2, weighted: 3.26 * x2 },
    { label: "EBIT / Total assets", coefficient: 6.72, value: x3, weighted: 6.72 * x3 },
    { label: "Book equity / Total liabilities", coefficient: 1.05, value: x4, weighted: 1.05 * x4 },
  ];
  const score = weighted.reduce((s, c) => s + c.weighted, 0);
  return {
    variant: 'Z"',
    components: { x1_wc_to_assets: x1, x2_re_to_assets: x2, x3_ebit_to_assets: x3, x4_equity_to_liabilities: x4 },
    weightedComponents: weighted,
    score,
    zone:
      score > Z_DOUBLE_PRIME_THRESHOLDS.safe
        ? "safe"
        : score > Z_DOUBLE_PRIME_THRESHOLDS.distress
          ? "grey"
          : "distress",
    thresholds: Z_DOUBLE_PRIME_THRESHOLDS,
    methodologyNote: Z_DOUBLE_PRIME_METHODOLOGY,
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

export interface CreditScoreResult {
  score: number; // 0–100
  rating: string; // AA, BBB+, BBB, BB+, BB, B+, B, B-, CCC, CC, C, D
  grade: string; // investment_grade | boundary | speculative | distress …
  components: { label: string; value: number; weight: number; contribution: number; read: string }[];
  altman: AltmanResult; // surfaced so the UI can render the methodology note
  piotroski: PiotroskiResult;
  caveat: string;
}

// F2.4 — Engine assembled_metrics envelope shape (subset consumed here).
// When supplied, computeCreditScore becomes a thin reader of the engine
// canonical (composite_score, letter_grade, subscores, composite_weights,
// altman_*). The parallel FE system (RATING_BANDS + 40/20/15/10/10/5
// weights + FE Piotroski + "investment strong" descriptors) is bypassed
// entirely on the engine-canonical path.
export interface CreditEnvelope {
  composite_score?: number;
  letter_grade?: string;
  letter_grade_bands?: Array<{ min: number; grade: string }>;
  altman_z_score?: number;
  altman_variant?: string;
  altman_components?: { x1?: number; x2?: number; x3?: number; x4?: number };
  composite_weights?: {
    altman?: number; profitability?: number; leverage?: number;
    coverage?: number; dscr?: number; liquidity?: number; equity?: number;
  };
  subscores?: {
    altman?: number; profitability?: number; leverage?: number;
    coverage?: number; dscr?: number; liquidity?: number; equity?: number;
  };
}
export interface PiotroskiEnvelope {
  score?: number;
  score_max?: number;
  has_prior_period?: boolean;
  checks?: Array<{ key: string; label: string; result: "pass" | "fail" | "uncertain"; detail?: string }>;
  disclosure?: string;
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
  }));
  const passCount = checks.filter((c) => c.result === "pass").length;
  const failCount = checks.filter((c) => c.result === "fail").length;
  const uncertainCount = checks.filter((c) => c.result === "uncertain").length;
  const score = env.score ?? passCount;
  const band: PiotroskiResult["band"] =
    score >= 8 ? "Strong (8–9)" :
    score >= 6 ? "Solid (6–7)" :
    score >= 3 ? "Weak (3–5)" :
    "Distressed (0–2)";
  return { score, band, checks, uncertainCount, passCount, failCount };
}

// F2.4 — Generate a one-line "read" for a subscore value (0-100).
function readForSubscore(label: string, value: number): string {
  if (!Number.isFinite(value)) return `${label}: not computable`;
  if (value >= 75) return `${label} component: strong`;
  if (value >= 50) return `${label} component: adequate`;
  if (value >= 25) return `${label} component: watch zone`;
  return `${label} component: weak`;
}

export function computeCreditScore(
  s: Statements,
  // F2.4 — Engine canonical envelopes. When both supplied, computeCreditScore
  // returns engine canonical (30/20/15/10/10/10/5 weights, engine letter_grade,
  // engine subscores, engine Piotroski). FE arithmetic fallback below is
  // preserved for sample data without an engine envelope.
  creditEnvelope?: CreditEnvelope,
  piotroskiEnvelope?: PiotroskiEnvelope,
  metricsByName?: Record<string, number | null>,
): CreditScoreResult {
  // ── F2.4 ENGINE-CANONICAL PATH ──────────────────────────────────────
  if (creditEnvelope && piotroskiEnvelope && typeof creditEnvelope.composite_score === "number") {
    const e = creditEnvelope;
    const piotroski = piotroskiFromEngine(piotroskiEnvelope);
    const altman = altmanZScore(s, metricsByName);
    const subs = e.subscores ?? {};
    const weights = e.composite_weights ?? {};

    // 7-component breakdown matching the engine's 30/20/15/10/10/10/5 weights.
    // (Was 6 components on the parallel system with 40/20/15/10/10/5.)
    const components: CreditScoreResult["components"] = [
      {
        label: `Altman ${altman.variant}-Score`,
        value: e.altman_z_score ?? altman.score,
        weight: weights.altman ?? 0.30,
        contribution: (subs.altman ?? 0) * (weights.altman ?? 0.30),
        read:
          altman.zone === "safe"
            ? `Safe zone (${altman.thresholds.safe}+ threshold, score ${(e.altman_z_score ?? altman.score).toFixed(2)})`
            : altman.zone === "grey"
              ? `Grey zone — elevated bankruptcy risk`
              : `Distress zone — immediate action required`,
      },
      {
        label: "Profitability (ROE + Net Margin)",
        value: subs.profitability ?? 0,
        weight: weights.profitability ?? 0.20,
        contribution: (subs.profitability ?? 0) * (weights.profitability ?? 0.20),
        read: readForSubscore("Profitability", subs.profitability ?? 0),
      },
      {
        label: "Leverage (Net Debt / EBITDA)",
        value: subs.leverage ?? 0,
        weight: weights.leverage ?? 0.15,
        contribution: (subs.leverage ?? 0) * (weights.leverage ?? 0.15),
        read: readForSubscore("Leverage", subs.leverage ?? 0),
      },
      {
        label: "Interest Coverage (EBIT / Interest)",
        value: subs.coverage ?? 0,
        weight: weights.coverage ?? 0.10,
        contribution: (subs.coverage ?? 0) * (weights.coverage ?? 0.10),
        read: readForSubscore("Interest coverage", subs.coverage ?? 0),
      },
      {
        label: "DSCR (EBITDA / debt service)",
        value: subs.dscr ?? 0,
        weight: weights.dscr ?? 0.10,
        contribution: (subs.dscr ?? 0) * (weights.dscr ?? 0.10),
        read: readForSubscore("DSCR", subs.dscr ?? 0),
      },
      {
        label: "Liquidity (Current + Quick + Cash blend)",
        value: subs.liquidity ?? 0,
        weight: weights.liquidity ?? 0.10,
        contribution: (subs.liquidity ?? 0) * (weights.liquidity ?? 0.10),
        read: readForSubscore("Liquidity", subs.liquidity ?? 0),
      },
      {
        label: "Equity ratio",
        value: subs.equity ?? 0,
        weight: weights.equity ?? 0.05,
        contribution: (subs.equity ?? 0) * (weights.equity ?? 0.05),
        read: readForSubscore("Equity ratio", subs.equity ?? 0),
      },
    ];

    return {
      score: e.composite_score,
      rating: e.letter_grade ?? "—",
      // F2.4 — `grade` becomes a mirror of letter_grade (no separate tier
      // descriptor — "investment_strong" / "speculative" disappear per
      // F2 kickoff Decision). RisksPanel's `gradeLabel` render will show
      // the letter; the visible "· investment strong" phrase is gone.
      grade: e.letter_grade ?? "—",
      components,
      altman,
      piotroski,
      caveat:
        "Engine canonical credit score (Romanian SME calibration). 30/20/15/10/10/10/5 weights with Altman Z″ as the dominant signal. The letter grade follows the locked F1.h ladder (AAA ≥ 90, AA ≥ 80, A ≥ 70, BBB ≥ 60, BB ≥ 50, B ≥ 40, CCC ≥ 25, CC < 25). Not a regulated rating — defensible analytical anchor for lender conversations.",
    };
  }

  // ── FE FALLBACK PATH (legacy, for pre-v2.1 sample data) ────────────
  // The block below was F2.4's deletion target. Retained as a back-compat
  // safety net for sample fixtures that lack the engine envelope. Engine-
  // canonical periods bypass it entirely via the early-return above.
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
  const cashRatio = safeDiv(c.cash, c.totalCurrentLiabilities);

  const altmanScore = scoreAltman(altman);
  const piotroskiScore = scorePiotroski(piotroski);
  const dteScore = scoreDebtEbitda(dte, isCre);
  const intCovScore = scoreInterestCoverage(intCov);
  const dscrScore = scoreDscr(dscr);
  const cashRatioScore = scoreCashRatio(cashRatio);

  const components = [
    {
      label: `Altman ${altman.variant}-Score`,
      value: altman.score,
      weight: 0.4,
      contribution: altmanScore * 0.4,
      read:
        altman.zone === "safe"
          ? `Safe zone (${altman.thresholds.safe}+ threshold, score ${altman.score.toFixed(2)})`
          : altman.zone === "grey"
            ? `Grey zone — elevated bankruptcy risk`
            : `Distress zone — immediate action required`,
    },
    {
      label: "Piotroski F-Score",
      value: piotroski.score,
      weight: 0.2,
      contribution: piotroskiScore * 0.2,
      read:
        piotroski.uncertainCount > 0
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
      weight: 0.1,
      contribution: intCovScore * 0.1,
      read:
        intCov >= 4 ? "Strong" : intCov >= 2 ? "Adequate" : intCov >= 1 ? "Tight" : "Below covenant",
    },
    {
      label: "DSCR (EBITDA / debt service)",
      value: dscr,
      weight: 0.1,
      contribution: dscrScore * 0.1,
      read:
        dscr >= 1.4
          ? "Inside typical 1.20× covenant with modest headroom"
          : dscr >= 1.2
            ? "At covenant floor — limited shock absorption"
            : "Below typical covenant",
    },
    {
      label: "Cash ratio (cash / current liabilities)",
      value: cashRatio,
      weight: 0.05,
      contribution: cashRatioScore * 0.05,
      read:
        cashRatio >= 0.5
          ? "Strong near-term liquidity"
          : cashRatio >= 0.2
            ? "Healthy near-term liquidity"
            : "Thin cash buffer",
    },
  ];

  const score = Math.round(components.reduce((sum, c) => sum + c.contribution, 0) * 10) / 10;
  const { rating, grade } = ratingBand(score);

  return {
    score,
    rating,
    grade,
    components,
    altman,
    piotroski,
    caveat:
      "This is a quantitative model output, not a regulated credit rating. A formal lender " +
      "internal rating or BNR-supervised model may weight other factors (sector outlook, " +
      "management quality, parent-group support, ESG) and produce a different result. The " +
      "score above is a defensible analytical anchor for negotiating with the bank, " +
      "evaluating refinancing offers, and tracking internal performance — not a substitute " +
      "for a formal rating opinion.",
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

function scoreAltman(altman: AltmanResult): number {
  const { score, zone } = altman;
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

function scorePiotroski(p: PiotroskiResult): number {
  // Score over CONFIRMED checks (not over 9) when some are uncertain —
  // gives a fair reading when prior-period data is absent.
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

function scoreCashRatio(cr: number): number {
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

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
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
