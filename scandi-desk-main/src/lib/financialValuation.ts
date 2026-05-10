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
  const rf = sup.riskFreeRate ?? 0.045;
  const erp = sup.equityRiskPremium ?? 0.055;
  const beta = sup.beta ?? 1.0;
  const costOfEquity = rf + beta * erp;
  const impliedTaxRate = t.pbt > 0 ? s.incomeStatement.taxExpense / t.pbt : 0;
  const taxRate = sup.taxRate ?? Math.min(0.25, Math.max(0, impliedTaxRate));
  const impliedKd = t.totalDebt > 0 ? s.incomeStatement.interestExpense / t.totalDebt : 0;
  const kdPre = sup.costOfDebt ?? Math.max(0.03, impliedKd);
  const kdAfter = kdPre * (1 - taxRate);
  const debt = t.totalDebt;
  const equity = Math.max(t.totalEquity, 1);
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
}

export function runDcf(s: Statements): DcfResult {
  const cf = deriveCashFlow(s);
  const t = deriveTotals(s);
  const sup = s.supplementary;
  const k = computeCostOfCapital(s);
  const horizon = sup.forecastYears ?? 5;
  const g = sup.forecastGrowthRate ?? 0.05;
  const gT = sup.terminalGrowthRate ?? 0.025;
  // Floor base FCF at zero — DCF on negative FCF flips sign nonsensically.
  const baseFcf = Math.max(cf.fcf, 0);

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
  const equityValue = ev - t.netDebt;
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
    netDebt: t.netDebt,
    equityValue,
    intrinsicValuePerShare: intrinsicPerShare,
    marketPricePerShare: sup.marketPricePerShare,
    upside,
    evToEbitda,
    evToRevenue,
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
  const shares = s.supplementary.sharesOutstanding;
  const eps = shares && shares > 0 ? t.netIncome / shares : t.netIncome;
  const g = (s.supplementary.forecastGrowthRate ?? 0.05) * 100; // pct units
  const yPct = (s.supplementary.riskFreeRate ?? 0.045) * 100;
  const fairAggregate = (t.netIncome * (8.5 + 2 * g) * 4.4) / yPct;
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

// ─── Piotroski F-Score ─────────────────────────────────────────────────────
//
// 9 binary tests (1 point each), grouped into:
//   Profitability (4): positive NI, positive CFO, ROA improving, CFO > NI
//   Leverage / liquidity / source (3): debt declining, current ratio improving, no share dilution
//   Operating efficiency (2): gross margin improving, asset turnover improving

export interface PiotroskiCheck {
  key: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface PiotroskiResult {
  score: number;
  band: "Strong (8–9)" | "Solid (6–7)" | "Weak (3–5)" | "Distressed (0–2)";
  checks: PiotroskiCheck[];
}

export function runPiotroski(s: Statements): PiotroskiResult {
  const cur = deriveTotals(s);
  const cf = deriveCashFlow(s);
  const checks: PiotroskiCheck[] = [];

  const add = (key: string, label: string, pass: boolean, detail: string) =>
    checks.push({ key, label, pass, detail });

  // --- Profitability ---
  add("ni_positive", "Net income positive", cur.netIncome > 0, fmt(cur.netIncome, s.currency));
  add("cfo_positive", "Operating cash flow positive", cf.cfo > 0, fmt(cf.cfo, s.currency));

  if (s.prior) {
    const prior = priorTotals(s);
    const cfPrior = deriveCashFlow({
      ...s,
      balanceSheet: s.prior.balanceSheet,
      incomeStatement: s.prior.incomeStatement,
      periodLabel: s.prior.periodLabel,
      prior: undefined,
    });
    const roaCur = safeDiv(cur.netIncome, cur.totalAssets);
    const roaPrior = safeDiv(prior.netIncome, prior.totalAssets);
    add(
      "roa_improving",
      "ROA improving y/y",
      roaCur > roaPrior,
      `${(roaCur * 100).toFixed(2)}% vs ${(roaPrior * 100).toFixed(2)}%`,
    );
    add(
      "cfo_gt_ni",
      "Quality of earnings (CFO > NI)",
      cf.cfo > cur.netIncome,
      `CFO ${fmt(cf.cfo, s.currency)} vs NI ${fmt(cur.netIncome, s.currency)}`,
    );
    // --- Leverage / liquidity / source ---
    add(
      "debt_declining",
      "Long-term debt declining",
      s.balanceSheet.longTermDebt < s.prior.balanceSheet.longTermDebt,
      `${fmt(s.balanceSheet.longTermDebt, s.currency)} vs ${fmt(s.prior.balanceSheet.longTermDebt, s.currency)}`,
    );
    const curRatioCur = safeDiv(cur.totalCurrentAssets, cur.totalCurrentLiabilities);
    const curRatioPrior = safeDiv(prior.totalCurrentAssets, prior.totalCurrentLiabilities);
    add(
      "current_improving",
      "Current ratio improving",
      curRatioCur > curRatioPrior,
      `${curRatioCur.toFixed(2)}× vs ${curRatioPrior.toFixed(2)}×`,
    );
    add(
      "no_dilution",
      "No equity dilution",
      s.balanceSheet.shareCapital <= s.prior.balanceSheet.shareCapital,
      `Share capital ${fmt(s.balanceSheet.shareCapital, s.currency)}`,
    );
    // --- Operating efficiency ---
    const gmCur = safeDiv(cur.grossProfit, s.incomeStatement.revenue);
    const gmPrior = safeDiv(prior.grossProfit, s.prior.incomeStatement.revenue);
    add(
      "gm_improving",
      "Gross margin improving",
      gmCur > gmPrior,
      `${(gmCur * 100).toFixed(1)}% vs ${(gmPrior * 100).toFixed(1)}%`,
    );
    const atCur = safeDiv(s.incomeStatement.revenue, cur.totalAssets);
    const atPrior = safeDiv(s.prior.incomeStatement.revenue, prior.totalAssets);
    add(
      "at_improving",
      "Asset turnover improving",
      atCur > atPrior,
      `${atCur.toFixed(2)}× vs ${atPrior.toFixed(2)}×`,
    );
  } else {
    // Without a prior period we can't run y/y checks; record as failed with note.
    const notes = [
      "roa_improving",
      "cfo_gt_ni",
      "debt_declining",
      "current_improving",
      "no_dilution",
      "gm_improving",
      "at_improving",
    ];
    notes.forEach((k) =>
      add(k, k.replace(/_/g, " "), false, "Requires prior-period data"),
    );
  }

  const score = checks.filter((c) => c.pass).length;
  const band: PiotroskiResult["band"] =
    score >= 8 ? "Strong (8–9)" : score >= 6 ? "Solid (6–7)" : score >= 3 ? "Weak (3–5)" : "Distressed (0–2)";

  return { score, band, checks };
}

// ─── Composite credit score ────────────────────────────────────────────────
//
// 0–100 weighted blend of: Altman Z (40%), Piotroski (20%), Debt/EBITDA (15%),
// Interest coverage (10%), DSCR (10%), Cash ratio (5%). Banded into S&P-style
// letters for at-a-glance reading.

export interface CreditScoreResult {
  score: number; // 0–100
  rating: string; // AAA, AA, A, BBB, BB, B, CCC, CC, C, D
  components: { label: string; value: number; weight: number; contribution: number }[];
}

export function computeCreditScore(s: Statements): CreditScoreResult {
  const cur = deriveTotals(s);
  const piotroski = runPiotroski(s);
  const altmanZ = altmanZScore(s);
  const dte = safeDiv(cur.totalDebt, cur.ebitda);
  const intCov = safeDiv(cur.ebit, s.incomeStatement.interestExpense);
  const dscr = safeDiv(
    cur.ebitda,
    s.incomeStatement.interestExpense + s.balanceSheet.shortTermDebt,
  );
  const cashRatio = safeDiv(s.balanceSheet.cash, cur.totalCurrentLiabilities);

  const altmanScore = clamp01((altmanZ - 1) / 2.5) * 100; // Z=3.5+ → 100, Z=1 → 0
  const piotroskiScore = (piotroski.score / 9) * 100;
  const dteScore = (1 - clamp01(dte / 6)) * 100; // Debt/EBITDA 0 → 100, 6 → 0
  const intCovScore = clamp01(intCov / 8) * 100;
  const dscrScore = clamp01((dscr - 1) / 0.75) * 100;
  const cashRatioScore = clamp01(cashRatio / 0.5) * 100;

  const components = [
    { label: "Altman Z-Score", value: altmanZ, weight: 0.4, contribution: altmanScore * 0.4 },
    { label: "Piotroski F-Score", value: piotroski.score, weight: 0.2, contribution: piotroskiScore * 0.2 },
    { label: "Debt / EBITDA", value: dte, weight: 0.15, contribution: dteScore * 0.15 },
    { label: "Interest coverage", value: intCov, weight: 0.1, contribution: intCovScore * 0.1 },
    { label: "DSCR", value: dscr, weight: 0.1, contribution: dscrScore * 0.1 },
    { label: "Cash ratio", value: cashRatio, weight: 0.05, contribution: cashRatioScore * 0.05 },
  ];

  const score = Math.round(components.reduce((sum, c) => sum + c.contribution, 0));
  const rating = ratingFor(score);
  return { score, rating, components };
}

function ratingFor(score: number): string {
  if (score >= 90) return "AAA";
  if (score >= 80) return "AA";
  if (score >= 70) return "A";
  if (score >= 60) return "BBB";
  if (score >= 50) return "BB";
  if (score >= 40) return "B";
  if (score >= 30) return "CCC";
  if (score >= 20) return "CC";
  if (score >= 10) return "C";
  return "D";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function altmanZScore(s: Statements): number {
  const t = deriveTotals(s);
  return (
    1.2 * safeDiv(t.workingCapital, t.totalAssets) +
    1.4 * safeDiv(s.balanceSheet.retainedEarnings, t.totalAssets) +
    3.3 * safeDiv(t.ebit, t.totalAssets) +
    0.6 * safeDiv(t.totalEquity, t.totalLiabilities) +
    1.0 * safeDiv(s.incomeStatement.revenue, t.totalAssets)
  );
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
