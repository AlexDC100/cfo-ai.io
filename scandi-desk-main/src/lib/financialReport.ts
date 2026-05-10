// Financial statement engine — types, ratios, recommendations, HTML report.
//
// Pure TypeScript: takes a Statements object (balance sheet + P&L + a few
// supplementary fields) and produces:
//   - computeRatios()           → liquidity / profitability / leverage / coverage / efficiency
//   - generateRecommendations() → prioritized actions (critical / high / medium)
//   - renderReportHtml()        → standalone HTML doc (board-pack template)
//
// The HTML renderer outputs a fully self-contained <!doctype html> string so
// the user can save the result as an .html file, open in a browser, and "Print
// to PDF" without any tooling. The visual language is a navy + neutral
// board-pack template designed for institutional financial reporting.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BalanceSheet {
  // Current assets
  cash: number;
  accountsReceivable: number;
  inventory: number;
  otherCurrentAssets: number;
  // Non-current assets
  propertyPlantEquipment: number;
  intangibles: number;
  otherNonCurrentAssets: number;
  // Current liabilities
  accountsPayable: number;
  shortTermDebt: number;
  otherCurrentLiabilities: number;
  // Non-current liabilities
  longTermDebt: number;
  otherNonCurrentLiabilities: number;
  // Equity
  shareCapital: number;
  retainedEarnings: number;
  otherEquity: number;
}

export interface IncomeStatement {
  revenue: number;
  costOfGoodsSold: number;
  operatingExpenses: number;
  depreciationAmortization: number;
  interestExpense: number;
  otherIncome: number;
  taxExpense: number;
  /** Non-operating financial income — dividends received, interest income, etc.
   *  Sits below EBIT (does not feed EBITDA). Optional for simple samples. */
  financialIncome?: number;
  /** Non-operating financial expense (excluding interest) — FX revaluation,
   *  bank fees, etc. Sits below EBIT. Optional for simple samples. */
  financialExpense?: number;
}

export interface SupplementaryData {
  /** Annual lease/rent obligations, used in adjusted DSCR. */
  annualLeaseExpense?: number;
  /** Property/asset market value, used in LTV. */
  propertyMarketValue?: number;
  /** Number of FTEs — drives revenue-per-employee. */
  employees?: number;
  /** Period-end day count (default 365). */
  periodDays?: number;
  /** Capex outflow for the period. Defaults to D&A if absent. */
  capex?: number;
  /** Risk-free rate for valuation (default 4.5%). */
  riskFreeRate?: number;
  /** Equity risk premium (default 5.5%). */
  equityRiskPremium?: number;
  /** Levered beta vs. market (default 1.0). */
  beta?: number;
  /** Effective cost of debt before tax (default = interest / total debt). */
  costOfDebt?: number;
  /** Effective tax rate (default = tax / PBT). */
  taxRate?: number;
  /** Long-term FCF growth rate for DCF terminal value (default 2.5%). */
  terminalGrowthRate?: number;
  /** Forecast horizon in years (default 5). */
  forecastYears?: number;
  /** Forecast FCF growth rate for the explicit horizon (default 5%). */
  forecastGrowthRate?: number;
  /** Outstanding shares, for per-share metrics. */
  sharesOutstanding?: number;
  /** Last close price per share, for valuation upside calc. */
  marketPricePerShare?: number;
}

export interface PriorPeriod {
  periodLabel: string;
  balanceSheet: BalanceSheet;
  incomeStatement: IncomeStatement;
}

export interface Statements {
  companyName: string;
  industry?: string;
  currency: string;
  periodLabel: string; // e.g. "FY 2025"
  balanceSheet: BalanceSheet;
  incomeStatement: IncomeStatement;
  supplementary: SupplementaryData;
  /** Optional prior-period statements for trend lines. */
  prior?: PriorPeriod;
  /** Optional multi-year history (oldest → newest, NOT including current). */
  historicalPeriods?: PriorPeriod[];
}

// ─── Derived totals ─────────────────────────────────────────────────────────

export interface DerivedTotals {
  totalCurrentAssets: number;
  totalNonCurrentAssets: number;
  totalAssets: number;
  totalCurrentLiabilities: number;
  totalNonCurrentLiabilities: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
  grossProfit: number;
  ebitda: number;
  ebit: number;
  netFinancialResult: number;
  pbt: number; // profit before tax
  netIncome: number;
  totalDebt: number;
  workingCapital: number;
  netDebt: number;
}

export function deriveTotals(s: Statements): DerivedTotals {
  const bs = s.balanceSheet;
  const is = s.incomeStatement;

  const totalCurrentAssets =
    bs.cash + bs.accountsReceivable + bs.inventory + bs.otherCurrentAssets;
  const totalNonCurrentAssets =
    bs.propertyPlantEquipment + bs.intangibles + bs.otherNonCurrentAssets;
  const totalAssets = totalCurrentAssets + totalNonCurrentAssets;

  const totalCurrentLiabilities =
    bs.accountsPayable + bs.shortTermDebt + bs.otherCurrentLiabilities;
  const totalNonCurrentLiabilities =
    bs.longTermDebt + bs.otherNonCurrentLiabilities;
  const totalLiabilities = totalCurrentLiabilities + totalNonCurrentLiabilities;
  const totalEquity = bs.shareCapital + bs.retainedEarnings + bs.otherEquity;

  const grossProfit = is.revenue - is.costOfGoodsSold;
  const ebitda = grossProfit - is.operatingExpenses + is.otherIncome;
  const ebit = ebitda - is.depreciationAmortization;
  const finIn = is.financialIncome ?? 0;
  const finEx = is.financialExpense ?? 0;
  const pbt = ebit + finIn - is.interestExpense - finEx;
  const netIncome = pbt - is.taxExpense;

  const totalDebt = bs.shortTermDebt + bs.longTermDebt;
  const workingCapital = totalCurrentAssets - totalCurrentLiabilities;
  const netDebt = totalDebt - bs.cash;

  return {
    totalCurrentAssets,
    totalNonCurrentAssets,
    totalAssets,
    totalCurrentLiabilities,
    totalNonCurrentLiabilities,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    grossProfit,
    ebitda,
    ebit,
    netFinancialResult: finIn - is.interestExpense - finEx,
    pbt,
    netIncome,
    totalDebt,
    workingCapital,
    netDebt,
  };
}

// ─── Ratios ─────────────────────────────────────────────────────────────────

export type RatioVerdict = "strong" | "healthy" | "watch" | "critical";

export interface Ratio {
  key: string;
  label: string;
  value: number;
  unit: "x" | "%" | "days" | "ratio";
  verdict: RatioVerdict;
  benchmark: string;
  commentary: string;
}

export interface RatioBundle {
  liquidity: Ratio[];
  profitability: Ratio[];
  leverage: Ratio[];
  coverage: Ratio[];
  efficiency: Ratio[];
  bankruptcy: Ratio[];
}

const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b);
const pct = (a: number, b: number): number => safeDiv(a, b) * 100;

function verdictFromBands(
  value: number,
  bands: { critical?: number; watch?: number; healthy?: number; strong?: number },
  higherIsBetter = true,
): RatioVerdict {
  // Bands are thresholds. higherIsBetter=true means values ≥ threshold are
  // at least that good. Walk from best → worst.
  if (higherIsBetter) {
    if (bands.strong !== undefined && value >= bands.strong) return "strong";
    if (bands.healthy !== undefined && value >= bands.healthy) return "healthy";
    if (bands.watch !== undefined && value >= bands.watch) return "watch";
    return "critical";
  }
  if (bands.strong !== undefined && value <= bands.strong) return "strong";
  if (bands.healthy !== undefined && value <= bands.healthy) return "healthy";
  if (bands.watch !== undefined && value <= bands.watch) return "watch";
  return "critical";
}

export function computeRatios(s: Statements): RatioBundle {
  const t = deriveTotals(s);
  const bs = s.balanceSheet;
  const is = s.incomeStatement;
  const sup = s.supplementary;
  const days = sup.periodDays ?? 365;

  // Liquidity ────────────────────────────────────────────────────────────────
  const currentRatio = safeDiv(t.totalCurrentAssets, t.totalCurrentLiabilities);
  const quickRatio = safeDiv(
    bs.cash + bs.accountsReceivable,
    t.totalCurrentLiabilities,
  );
  const cashRatio = safeDiv(bs.cash, t.totalCurrentLiabilities);

  // Profitability ────────────────────────────────────────────────────────────
  const grossMargin = pct(t.grossProfit, is.revenue);
  const ebitdaMargin = pct(t.ebitda, is.revenue);
  const netMargin = pct(t.netIncome, is.revenue);
  const roa = pct(t.netIncome, t.totalAssets);
  const roe = pct(t.netIncome, t.totalEquity);

  // Leverage ─────────────────────────────────────────────────────────────────
  const debtToEbitda = safeDiv(t.totalDebt, t.ebitda);
  const debtToEquity = safeDiv(t.totalDebt, t.totalEquity);
  const equityRatio = pct(t.totalEquity, t.totalAssets);
  const ltv = sup.propertyMarketValue
    ? pct(t.totalDebt, sup.propertyMarketValue)
    : pct(t.totalDebt, t.totalAssets);

  // Coverage ─────────────────────────────────────────────────────────────────
  const interestCoverage = safeDiv(t.ebit, is.interestExpense);
  const dscr = safeDiv(t.ebitda, is.interestExpense + bs.shortTermDebt);
  const adjustedDscr = sup.annualLeaseExpense
    ? safeDiv(
        t.ebitda + sup.annualLeaseExpense,
        is.interestExpense + bs.shortTermDebt + sup.annualLeaseExpense,
      )
    : dscr;

  // Efficiency ───────────────────────────────────────────────────────────────
  const dso = safeDiv(bs.accountsReceivable, is.revenue) * days;
  const dio = safeDiv(bs.inventory, is.costOfGoodsSold) * days;
  const dpo = safeDiv(bs.accountsPayable, is.costOfGoodsSold) * days;
  const ccc = dso + dio - dpo;
  const assetTurnover = safeDiv(is.revenue, t.totalAssets);

  // Bankruptcy — Altman Z-Score (manufacturing/general) ─────────────────────
  // Z = 1.2·(WC/TA) + 1.4·(RE/TA) + 3.3·(EBIT/TA) + 0.6·(Equity/TL) + 1.0·(Sales/TA)
  const z =
    1.2 * safeDiv(t.workingCapital, t.totalAssets) +
    1.4 * safeDiv(bs.retainedEarnings, t.totalAssets) +
    3.3 * safeDiv(t.ebit, t.totalAssets) +
    0.6 * safeDiv(t.totalEquity, t.totalLiabilities) +
    1.0 * safeDiv(is.revenue, t.totalAssets);

  return {
    liquidity: [
      {
        key: "current_ratio",
        label: "Current Ratio",
        value: currentRatio,
        unit: "x",
        verdict: verdictFromBands(currentRatio, { strong: 2, healthy: 1.5, watch: 1 }),
        benchmark: "≥ 1.5× healthy · ≥ 2.0× strong",
        commentary:
          currentRatio >= 1.5
            ? "Comfortable short-term cushion against current obligations."
            : currentRatio >= 1
              ? "Tight but covered — monitor working capital weekly."
              : "Current liabilities exceed current assets — liquidity stress.",
      },
      {
        key: "quick_ratio",
        label: "Quick Ratio",
        value: quickRatio,
        unit: "x",
        verdict: verdictFromBands(quickRatio, { strong: 1.5, healthy: 1, watch: 0.7 }),
        benchmark: "≥ 1.0× healthy",
        commentary:
          quickRatio >= 1
            ? "Cash + receivables alone cover current liabilities."
            : "Reliance on inventory liquidation to meet short-term obligations.",
      },
      {
        key: "cash_ratio",
        label: "Cash Ratio",
        value: cashRatio,
        unit: "x",
        verdict: verdictFromBands(cashRatio, { strong: 0.5, healthy: 0.2, watch: 0.1 }),
        benchmark: "≥ 0.2× healthy",
        commentary:
          cashRatio >= 0.2
            ? "Adequate cash buffer for operating shocks."
            : "Limited dry cash — exposed to revenue interruption.",
      },
    ],
    profitability: [
      {
        key: "gross_margin",
        label: "Gross Margin",
        value: grossMargin,
        unit: "%",
        verdict: verdictFromBands(grossMargin, { strong: 40, healthy: 25, watch: 15 }),
        benchmark: "Industry-dependent · ≥ 25% healthy",
        commentary: `${grossMargin.toFixed(1)}% gross margin on ${formatCurrency(is.revenue, s.currency)} revenue.`,
      },
      {
        key: "ebitda_margin",
        label: "EBITDA Margin",
        value: ebitdaMargin,
        unit: "%",
        verdict: verdictFromBands(ebitdaMargin, { strong: 25, healthy: 15, watch: 8 }),
        benchmark: "≥ 15% healthy · ≥ 25% strong",
        commentary: `${formatCurrency(t.ebitda, s.currency)} EBITDA — operating cash generation.`,
      },
      {
        key: "net_margin",
        label: "Net Margin",
        value: netMargin,
        unit: "%",
        verdict: verdictFromBands(netMargin, { strong: 15, healthy: 8, watch: 3 }),
        benchmark: "≥ 8% healthy",
        commentary: `${formatCurrency(t.netIncome, s.currency)} bottom-line profit after all costs.`,
      },
      {
        key: "roa",
        label: "Return on Assets",
        value: roa,
        unit: "%",
        verdict: verdictFromBands(roa, { strong: 10, healthy: 5, watch: 2 }),
        benchmark: "≥ 5% healthy",
        commentary:
          roa >= 5
            ? "Assets generating solid returns."
            : "Asset base under-earning — review utilization.",
      },
      {
        key: "roe",
        label: "Return on Equity",
        value: roe,
        unit: "%",
        verdict: verdictFromBands(roe, { strong: 20, healthy: 12, watch: 6 }),
        benchmark: "≥ 12% healthy",
        commentary:
          roe >= 12
            ? "Capital deployed efficiently for shareholders."
            : "Equity returns below cost-of-capital benchmark.",
      },
    ],
    leverage: [
      {
        key: "debt_to_ebitda",
        label: "Debt / EBITDA",
        value: debtToEbitda,
        unit: "x",
        verdict: verdictFromBands(
          debtToEbitda,
          { strong: 2, healthy: 3, watch: 4.5 },
          false,
        ),
        benchmark: "≤ 3× healthy · ≤ 2× strong",
        commentary:
          debtToEbitda <= 3
            ? "Debt service comfortably aligned with cash generation."
            : debtToEbitda <= 4.5
              ? "Elevated leverage — refinancing risk if EBITDA contracts."
              : "Stretched balance sheet — covenant risk likely.",
      },
      {
        key: "debt_to_equity",
        label: "Debt / Equity",
        value: debtToEquity,
        unit: "x",
        verdict: verdictFromBands(
          debtToEquity,
          { strong: 0.5, healthy: 1, watch: 2 },
          false,
        ),
        benchmark: "≤ 1.0× healthy",
        commentary:
          debtToEquity <= 1
            ? "Conservatively capitalized."
            : "Leverage exceeds equity cushion.",
      },
      {
        key: "equity_ratio",
        label: "Equity Ratio",
        value: equityRatio,
        unit: "%",
        verdict: verdictFromBands(equityRatio, { strong: 50, healthy: 30, watch: 15 }),
        benchmark: "≥ 30% healthy",
        commentary: `${equityRatio.toFixed(1)}% of assets funded by equity.`,
      },
      {
        key: "ltv",
        label: sup.propertyMarketValue ? "Loan-to-Value" : "Debt-to-Assets",
        value: ltv,
        unit: "%",
        verdict: verdictFromBands(ltv, { strong: 50, healthy: 65, watch: 80 }, false),
        benchmark: "≤ 65% healthy",
        commentary:
          ltv <= 65
            ? "Asset coverage of debt is comfortable."
            : "Limited equity headroom against pledged assets.",
      },
    ],
    coverage: [
      {
        key: "interest_coverage",
        label: "Interest Coverage",
        value: interestCoverage,
        unit: "x",
        verdict: verdictFromBands(
          interestCoverage,
          { strong: 6, healthy: 3, watch: 1.5 },
        ),
        benchmark: "≥ 3× healthy",
        commentary:
          interestCoverage >= 3
            ? "Earnings comfortably absorb interest load."
            : "Interest taking a meaningful bite of operating profit.",
      },
      {
        key: "dscr",
        label: "DSCR (interest + ST debt)",
        value: dscr,
        unit: "x",
        verdict: verdictFromBands(dscr, { strong: 1.5, healthy: 1.25, watch: 1 }),
        benchmark: "≥ 1.25× covenant-typical",
        commentary:
          dscr >= 1.25
            ? "Annual cash service comfortably covered."
            : "Debt service consumes most operating cash.",
      },
      {
        key: "adjusted_dscr",
        label: "Adjusted DSCR (incl. lease)",
        value: adjustedDscr,
        unit: "x",
        verdict: verdictFromBands(
          adjustedDscr,
          { strong: 1.5, healthy: 1.25, watch: 1 },
        ),
        benchmark: "≥ 1.25× including lease commitments",
        commentary: sup.annualLeaseExpense
          ? "Adds lease obligation to fixed charges — lender-style view."
          : "No lease component — same as DSCR.",
      },
    ],
    efficiency: [
      {
        key: "dso",
        label: "Days Sales Outstanding",
        value: dso,
        unit: "days",
        verdict: verdictFromBands(dso, { strong: 30, healthy: 45, watch: 75 }, false),
        benchmark: "≤ 45 days healthy",
        commentary: `Average ${dso.toFixed(0)}-day collection cycle on receivables.`,
      },
      {
        key: "dio",
        label: "Days Inventory Outstanding",
        value: dio,
        unit: "days",
        verdict: verdictFromBands(dio, { strong: 30, healthy: 60, watch: 100 }, false),
        benchmark: "≤ 60 days for FMCG · varies by industry",
        commentary: `Inventory turns every ${dio.toFixed(0)} days.`,
      },
      {
        key: "dpo",
        label: "Days Payables Outstanding",
        value: dpo,
        unit: "days",
        verdict: verdictFromBands(dpo, { strong: 60, healthy: 45, watch: 30 }),
        benchmark: "Higher = better supplier float (within terms)",
        commentary: `${dpo.toFixed(0)}-day average to settle suppliers.`,
      },
      {
        key: "ccc",
        label: "Cash Conversion Cycle",
        value: ccc,
        unit: "days",
        verdict: verdictFromBands(ccc, { strong: 30, healthy: 60, watch: 100 }, false),
        benchmark: "Lower is better — cash speed",
        commentary: `${ccc.toFixed(0)}-day gap between cash out and cash in.`,
      },
      {
        key: "asset_turnover",
        label: "Asset Turnover",
        value: assetTurnover,
        unit: "x",
        verdict: verdictFromBands(
          assetTurnover,
          { strong: 1.5, healthy: 0.8, watch: 0.4 },
        ),
        benchmark: "≥ 0.8× healthy (industry-dependent)",
        commentary: `${assetTurnover.toFixed(2)}× revenue per unit of assets.`,
      },
    ],
    bankruptcy: [
      {
        key: "altman_z",
        label: "Altman Z-Score",
        value: z,
        unit: "ratio",
        verdict: verdictFromBands(z, { strong: 3, healthy: 2.6, watch: 1.8 }),
        benchmark: "≥ 2.6 safe · 1.8–2.6 grey · < 1.8 distress",
        commentary:
          z >= 2.6
            ? "Bankruptcy risk: low. Balance sheet structurally sound."
            : z >= 1.8
              ? "Bankruptcy risk: grey zone. Monitor leverage and cash flow."
              : "Bankruptcy risk: distress zone. Action required.",
      },
    ],
  };
}

// ─── Recommendations ────────────────────────────────────────────────────────

export type RecommendationPriority = "critical" | "high" | "medium" | "info";

export interface Recommendation {
  id: string;
  priority: RecommendationPriority;
  title: string;
  rationale: string;
  action: string;
  /** Estimated annual cash impact, in the company's currency. */
  estimatedImpact?: number;
}

export function generateRecommendations(
  s: Statements,
  ratios?: RatioBundle,
): Recommendation[] {
  const r = ratios ?? computeRatios(s);
  const t = deriveTotals(s);
  const out: Recommendation[] = [];

  // Helper to fetch ratio by key across all groups.
  const get = (key: string): Ratio | undefined => {
    for (const group of Object.values(r))
      for (const x of group) if (x.key === key) return x;
    return undefined;
  };

  // Liquidity -----------------------------------------------------------------
  const cur = get("current_ratio")!;
  if (cur.value < 1) {
    out.push({
      id: "liquidity_critical",
      priority: "critical",
      title: "Address near-term liquidity gap",
      rationale: `Current ratio of ${cur.value.toFixed(2)}× means current liabilities exceed current assets by ${formatCurrency(Math.abs(t.workingCapital), s.currency)}.`,
      action:
        "Negotiate extended supplier terms (target 60+ days), accelerate receivables via early-pay discounts, and arrange a working capital facility before quarter end.",
      estimatedImpact: Math.abs(t.workingCapital) * 0.3,
    });
  } else if (cur.value < 1.5) {
    out.push({
      id: "liquidity_watch",
      priority: "high",
      title: "Strengthen working capital cushion",
      rationale: `Current ratio of ${cur.value.toFixed(2)}× is positive but provides limited buffer.`,
      action:
        "Build cash reserve to 60 days of operating expenses through targeted DSO reduction and inventory rationalization.",
    });
  }

  // Cash conversion cycle ----------------------------------------------------
  const ccc = get("ccc")!;
  if (ccc.value > 90) {
    out.push({
      id: "ccc_high",
      priority: "high",
      title: `Compress cash conversion cycle (${ccc.value.toFixed(0)} days)`,
      rationale:
        "Long CCC ties up working capital that could fund growth or reduce debt.",
      action:
        "Target 20-day reduction: tighten credit terms on slowest-paying customers, run an inventory cleanse on dead stock, extend supplier payment cycles where relationship allows.",
      estimatedImpact: (s.incomeStatement.revenue / 365) * 20,
    });
  }

  // Leverage -----------------------------------------------------------------
  const dte = get("debt_to_ebitda")!;
  if (dte.value > 4.5) {
    out.push({
      id: "leverage_critical",
      priority: "critical",
      title: "Reduce structural leverage",
      rationale: `Debt/EBITDA of ${dte.value.toFixed(2)}× is well above prudent threshold (≤ 3.0×). Refinancing and covenant risk is elevated.`,
      action:
        "Initiate covenant-relief discussions with primary lender, accelerate debt amortization with surplus cash flow, and consider non-core asset disposal to crystallize equity.",
    });
  } else if (dte.value > 3) {
    out.push({
      id: "leverage_watch",
      priority: "high",
      title: "De-lever toward target ratio",
      rationale: `Debt/EBITDA of ${dte.value.toFixed(2)}× exceeds the 3.0× healthy benchmark.`,
      action:
        "Apply 60% of free cash flow to debt repayment until ratio falls below 3.0×. Defer discretionary capex.",
    });
  }

  // Coverage -----------------------------------------------------------------
  const dscr = get("dscr")!;
  if (dscr.value < 1.25) {
    out.push({
      id: "dscr_critical",
      priority: "critical",
      title: "Restore debt service coverage",
      rationale: `DSCR of ${dscr.value.toFixed(2)}× is below the 1.25× covenant-typical threshold.`,
      action:
        "Restructure debt to lengthen amortization, apply for covenant waiver in advance, and protect EBITDA via discretionary cost reductions.",
    });
  }

  // Profitability ------------------------------------------------------------
  const em = get("ebitda_margin")!;
  if (em.value < 8) {
    out.push({
      id: "ebitda_low",
      priority: "high",
      title: "Restore operating profitability",
      rationale: `EBITDA margin of ${em.value.toFixed(1)}% sits below sustainable threshold for the industry.`,
      action:
        "Run a top-down opex review on SG&A line items > 2% of revenue, renegotiate top 5 supplier contracts, and exit unprofitable SKUs/customers.",
      estimatedImpact: s.incomeStatement.revenue * 0.03,
    });
  }

  const gm = get("gross_margin")!;
  if (gm.value < 20) {
    out.push({
      id: "gm_low",
      priority: "high",
      title: "Improve gross margin",
      rationale: `${gm.value.toFixed(1)}% gross margin leaves little operating headroom.`,
      action:
        "Re-price the bottom-quartile SKU portfolio, consolidate suppliers for volume discounts, and pass through input-cost inflation explicitly to customers.",
    });
  }

  // Bankruptcy risk ----------------------------------------------------------
  const z = get("altman_z")!;
  if (z.value < 1.8) {
    out.push({
      id: "altman_distress",
      priority: "critical",
      title: "Stabilize against distress signals",
      rationale: `Altman Z of ${z.value.toFixed(2)} sits in the distress zone (< 1.8).`,
      action:
        "Convene board financial review. Engage restructuring advisor. Build 13-week cash forecast with weekly variance tracking.",
    });
  } else if (z.value < 2.6) {
    out.push({
      id: "altman_grey",
      priority: "medium",
      title: "Move out of grey-zone risk",
      rationale: `Altman Z of ${z.value.toFixed(2)} is in the grey zone (1.8–2.6) — not distress, but not safe either.`,
      action:
        "Build retained earnings (limit dividends), reduce debt, or improve working capital to strengthen score.",
    });
  }

  // LTV (real estate / asset-heavy) ------------------------------------------
  const ltv = get("ltv")!;
  if (ltv.value > 80) {
    out.push({
      id: "ltv_high",
      priority: "high",
      title: "Reduce loan-to-value exposure",
      rationale: `LTV of ${ltv.value.toFixed(0)}% leaves limited equity buffer against asset-value movements.`,
      action:
        "Apply surplus cash to principal reduction. If property revaluation is overdue, consider an updated valuation to refresh the LTV calculation.",
    });
  }

  // If everything is healthy — give them an info note rather than silence.
  if (out.length === 0) {
    out.push({
      id: "all_healthy",
      priority: "info",
      title: "Financials are in healthy range across all dimensions",
      rationale: "No critical or high-priority items detected.",
      action:
        "Maintain current discipline. Consider strategic capital deployment: growth investment, dividend, or buyback.",
    });
  }

  // Sort by priority (critical → info).
  const order: Record<RecommendationPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    info: 3,
  };
  out.sort((a, b) => order[a.priority] - order[b.priority]);
  return out;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

export function formatCurrency(n: number, currency: string): string {
  const abs = Math.abs(n);
  let formatted: string;
  if (abs >= 1_000_000_000) formatted = `${(n / 1_000_000_000).toFixed(2)}B`;
  else if (abs >= 1_000_000) formatted = `${(n / 1_000_000).toFixed(2)}M`;
  else if (abs >= 1_000) formatted = `${(n / 1_000).toFixed(0)}K`;
  else formatted = n.toFixed(0);
  return `${currency} ${formatted}`;
}

export function formatNumber(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatRatio(r: Ratio): string {
  switch (r.unit) {
    case "x":
      return `${r.value.toFixed(2)}×`;
    case "%":
      return `${r.value.toFixed(1)}%`;
    case "days":
      return `${r.value.toFixed(0)} days`;
    case "ratio":
      return r.value.toFixed(2);
  }
}

export function verdictColor(v: RatioVerdict): { bg: string; text: string } {
  switch (v) {
    case "strong":
      return { bg: "#ecfdf5", text: "#047857" };
    case "healthy":
      return { bg: "#eff6ff", text: "#1d4ed8" };
    case "watch":
      return { bg: "#fef3c7", text: "#92400e" };
    case "critical":
      return { bg: "#fee2e2", text: "#991b1b" };
  }
}

export function verdictLabel(v: RatioVerdict): string {
  return v === "strong"
    ? "Strong"
    : v === "healthy"
      ? "Healthy"
      : v === "watch"
        ? "Watch"
        : "Critical";
}

// ─── HTML report renderer ───────────────────────────────────────────────────

export function renderReportHtml(s: Statements): string {
  const t = deriveTotals(s);
  const r = computeRatios(s);
  const recs = generateRecommendations(s, r);

  // ─ Style block ─ board-pack visual language: navy headers, neutral body,
  // semantic callout boxes.
  const css = `
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11pt;
      line-height: 1.55;
      color: #1f2937;
      margin: 0;
      padding: 24px;
      background: #ffffff;
      max-width: 980px;
      margin: 0 auto;
    }
    h1 {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 28pt;
      color: #003366;
      margin: 0 0 8px;
      border-bottom: 3px solid #003366;
      padding-bottom: 12px;
    }
    h2 {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 14pt;
      background: #003366;
      color: #ffffff;
      padding: 10px 14px;
      margin: 32px 0 16px;
      border-radius: 2px;
    }
    h3 {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 12pt;
      color: #003366;
      margin: 24px 0 12px;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 6px;
    }
    .header-info {
      background: #f7f9fc;
      border-left: 4px solid #003366;
      padding: 12px 16px;
      margin: 12px 0 24px;
      font-size: 10.5pt;
    }
    .header-info p { margin: 4px 0; }
    .grid { display: grid; gap: 12px; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
    .grid-4 { grid-template-columns: 1fr 1fr 1fr 1fr; }
    .ratio-card {
      background: #f7f9fc;
      padding: 14px 16px;
      border-left: 4px solid #003366;
      border-radius: 2px;
    }
    .ratio-card .label {
      font-size: 9pt;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 6px;
    }
    .ratio-card .value {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 20pt;
      color: #003366;
      font-weight: 600;
      line-height: 1.1;
    }
    .ratio-card .meta { font-size: 9pt; color: #6b7280; margin-top: 6px; }
    .badge {
      display: inline-block;
      font-size: 8.5pt;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 9999px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .commentary { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 12px 0; font-size: 10.5pt; }
    .risk       { background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px; margin: 12px 0; font-size: 10.5pt; }
    .action     { background: #f0fdf4; border-left: 4px solid #16a34a; padding: 12px 16px; margin: 12px 0; font-size: 10.5pt; }
    .insight    { background: #003366; color: #ffffff; padding: 16px 20px; margin: 16px 0; border-left: 4px solid #fbbf24; }
    .insight strong { color: #fbbf24; }
    .savings-box {
      background: #003366;
      color: #ffffff;
      padding: 18px 22px;
      margin: 16px 0;
      text-align: center;
      border-radius: 2px;
    }
    .savings-box .number {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 26pt;
      font-weight: 700;
      display: block;
      margin: 4px 0;
    }
    table.fin {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 10.5pt;
    }
    table.fin th, table.fin td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    table.fin th {
      background: #f7f9fc;
      color: #003366;
      font-weight: 600;
      font-size: 9.5pt;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    table.fin td.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.fin tr.total td { font-weight: 700; border-top: 2px solid #003366; border-bottom: 2px solid #003366; }
    table.fin tr.subtotal td { font-weight: 600; background: #f7f9fc; }
    table.fin tr.indent td:first-child { padding-left: 28px; color: #6b7280; }
    .priority-pill {
      display: inline-block;
      font-size: 8.5pt;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-right: 8px;
    }
    .priority-critical { background: #dc2626; color: #ffffff; }
    .priority-high     { background: #f59e0b; color: #ffffff; }
    .priority-medium   { background: #2563eb; color: #ffffff; }
    .priority-info     { background: #6b7280; color: #ffffff; }
    .rec {
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      padding: 16px 18px;
      margin: 12px 0;
      background: #ffffff;
    }
    .rec h4 { margin: 0 0 8px; font-family: 'Playfair Display', Georgia, serif; font-size: 12pt; color: #003366; }
    .rec p { margin: 6px 0; font-size: 10.5pt; }
    .rec .impact { background: #f0fdf4; color: #166534; font-size: 10pt; padding: 6px 12px; border-radius: 4px; display: inline-block; margin-top: 8px; }
    .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 9pt; color: #6b7280; text-align: center; }
    @media print {
      body { padding: 0; }
      h2 { page-break-after: avoid; }
      .rec, .ratio-card, .insight, .savings-box { page-break-inside: avoid; }
    }
  `;

  const today = new Date().toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Build executive summary block.
  const criticalCount = recs.filter((r) => r.priority === "critical").length;
  const highCount = recs.filter((r) => r.priority === "high").length;
  const overallVerdict =
    criticalCount > 0
      ? `Action required — ${criticalCount} critical item${criticalCount === 1 ? "" : "s"} flagged.`
      : highCount > 0
        ? `Generally healthy with ${highCount} priority area${highCount === 1 ? "" : "s"} to strengthen.`
        : "Financials in healthy range across all dimensions.";

  // ─ Per-section renderers ──────────────────────────────────────────────────
  const ratioCard = (rt: Ratio): string => {
    const colors = verdictColor(rt.verdict);
    return `
      <div class="ratio-card">
        <div class="label">${escapeHtml(rt.label)}</div>
        <div class="value">${escapeHtml(formatRatio(rt))}</div>
        <div class="meta">
          <span class="badge" style="background:${colors.bg};color:${colors.text}">
            ${escapeHtml(verdictLabel(rt.verdict))}
          </span>
          &nbsp;${escapeHtml(rt.benchmark)}
        </div>
      </div>
    `;
  };

  const ratioGroup = (title: string, group: Ratio[]): string => `
    <h3>${escapeHtml(title)}</h3>
    <div class="grid grid-3">${group.map(ratioCard).join("")}</div>
    ${group
      .filter((rt) => rt.verdict === "watch" || rt.verdict === "critical")
      .map(
        (rt) =>
          `<div class="${rt.verdict === "critical" ? "risk" : "commentary"}">
            <strong>${escapeHtml(rt.label)}:</strong> ${escapeHtml(rt.commentary)}
          </div>`,
      )
      .join("")}
  `;

  const balanceSheetTable = (): string => {
    const bs = s.balanceSheet;
    return `
      <table class="fin">
        <thead><tr><th>Balance Sheet</th><th class="num">${escapeHtml(s.periodLabel)}</th></tr></thead>
        <tbody>
          <tr class="subtotal"><td>Current Assets</td><td class="num">${money(t.totalCurrentAssets, s.currency)}</td></tr>
          <tr class="indent"><td>Cash & equivalents</td><td class="num">${money(bs.cash, s.currency)}</td></tr>
          <tr class="indent"><td>Accounts receivable</td><td class="num">${money(bs.accountsReceivable, s.currency)}</td></tr>
          <tr class="indent"><td>Inventory</td><td class="num">${money(bs.inventory, s.currency)}</td></tr>
          <tr class="indent"><td>Other current assets</td><td class="num">${money(bs.otherCurrentAssets, s.currency)}</td></tr>
          <tr class="subtotal"><td>Non-Current Assets</td><td class="num">${money(t.totalNonCurrentAssets, s.currency)}</td></tr>
          <tr class="indent"><td>Property, plant & equipment</td><td class="num">${money(bs.propertyPlantEquipment, s.currency)}</td></tr>
          <tr class="indent"><td>Intangibles</td><td class="num">${money(bs.intangibles, s.currency)}</td></tr>
          <tr class="indent"><td>Other non-current assets</td><td class="num">${money(bs.otherNonCurrentAssets, s.currency)}</td></tr>
          <tr class="total"><td>Total Assets</td><td class="num">${money(t.totalAssets, s.currency)}</td></tr>

          <tr class="subtotal"><td>Current Liabilities</td><td class="num">${money(t.totalCurrentLiabilities, s.currency)}</td></tr>
          <tr class="indent"><td>Accounts payable</td><td class="num">${money(bs.accountsPayable, s.currency)}</td></tr>
          <tr class="indent"><td>Short-term debt</td><td class="num">${money(bs.shortTermDebt, s.currency)}</td></tr>
          <tr class="indent"><td>Other current liabilities</td><td class="num">${money(bs.otherCurrentLiabilities, s.currency)}</td></tr>
          <tr class="subtotal"><td>Non-Current Liabilities</td><td class="num">${money(t.totalNonCurrentLiabilities, s.currency)}</td></tr>
          <tr class="indent"><td>Long-term debt</td><td class="num">${money(bs.longTermDebt, s.currency)}</td></tr>
          <tr class="indent"><td>Other non-current liabilities</td><td class="num">${money(bs.otherNonCurrentLiabilities, s.currency)}</td></tr>
          <tr class="subtotal"><td>Total Liabilities</td><td class="num">${money(t.totalLiabilities, s.currency)}</td></tr>
          <tr class="indent"><td>Share capital</td><td class="num">${money(bs.shareCapital, s.currency)}</td></tr>
          <tr class="indent"><td>Retained earnings</td><td class="num">${money(bs.retainedEarnings, s.currency)}</td></tr>
          <tr class="indent"><td>Other equity</td><td class="num">${money(bs.otherEquity, s.currency)}</td></tr>
          <tr class="subtotal"><td>Total Equity</td><td class="num">${money(t.totalEquity, s.currency)}</td></tr>
          <tr class="total"><td>Total Liabilities + Equity</td><td class="num">${money(t.totalLiabilitiesAndEquity, s.currency)}</td></tr>
        </tbody>
      </table>
    `;
  };

  const incomeStatementTable = (): string => {
    const is = s.incomeStatement;
    return `
      <table class="fin">
        <thead><tr><th>Profit & Loss</th><th class="num">${escapeHtml(s.periodLabel)}</th></tr></thead>
        <tbody>
          <tr><td>Revenue</td><td class="num">${money(is.revenue, s.currency)}</td></tr>
          <tr class="indent"><td>Cost of goods sold</td><td class="num">(${money(is.costOfGoodsSold, s.currency)})</td></tr>
          <tr class="subtotal"><td>Gross Profit</td><td class="num">${money(t.grossProfit, s.currency)}</td></tr>
          <tr class="indent"><td>Operating expenses</td><td class="num">(${money(is.operatingExpenses, s.currency)})</td></tr>
          <tr class="indent"><td>Other income</td><td class="num">${money(is.otherIncome, s.currency)}</td></tr>
          <tr class="subtotal"><td>EBITDA</td><td class="num">${money(t.ebitda, s.currency)}</td></tr>
          <tr class="indent"><td>Depreciation & amortization</td><td class="num">(${money(is.depreciationAmortization, s.currency)})</td></tr>
          <tr class="subtotal"><td>EBIT</td><td class="num">${money(t.ebit, s.currency)}</td></tr>
          <tr class="indent"><td>Interest expense</td><td class="num">(${money(is.interestExpense, s.currency)})</td></tr>
          <tr class="subtotal"><td>Profit Before Tax</td><td class="num">${money(t.pbt, s.currency)}</td></tr>
          <tr class="indent"><td>Tax expense</td><td class="num">(${money(is.taxExpense, s.currency)})</td></tr>
          <tr class="total"><td>Net Income</td><td class="num">${money(t.netIncome, s.currency)}</td></tr>
        </tbody>
      </table>
    `;
  };

  const recommendationCard = (rec: Recommendation): string => `
    <div class="rec">
      <h4>
        <span class="priority-pill priority-${rec.priority}">${rec.priority}</span>
        ${escapeHtml(rec.title)}
      </h4>
      <p><strong>Why:</strong> ${escapeHtml(rec.rationale)}</p>
      <p><strong>Action:</strong> ${escapeHtml(rec.action)}</p>
      ${
        rec.estimatedImpact
          ? `<div class="impact">Estimated impact: ${escapeHtml(formatCurrency(rec.estimatedImpact, s.currency))} / year</div>`
          : ""
      }
    </div>
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(s.companyName)} — Financial Analysis ${escapeHtml(s.periodLabel)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>${css}</style>
</head>
<body>
  <h1>${escapeHtml(s.companyName)}</h1>
  <div class="header-info">
    <p><strong>Comprehensive Financial Analysis</strong></p>
    <p>Period: ${escapeHtml(s.periodLabel)} &nbsp;·&nbsp; Currency: ${escapeHtml(s.currency)}${s.industry ? ` &nbsp;·&nbsp; Industry: ${escapeHtml(s.industry)}` : ""}</p>
    <p>Report generated: ${escapeHtml(today)}</p>
  </div>

  <h2>Executive Summary</h2>
  <div class="insight">
    <strong>Overall verdict:</strong> ${escapeHtml(overallVerdict)}
  </div>
  <div class="grid grid-4">
    <div class="ratio-card">
      <div class="label">Revenue</div>
      <div class="value">${money(s.incomeStatement.revenue, s.currency)}</div>
    </div>
    <div class="ratio-card">
      <div class="label">EBITDA</div>
      <div class="value">${money(t.ebitda, s.currency)}</div>
      <div class="meta">${(safeDiv(t.ebitda, s.incomeStatement.revenue) * 100).toFixed(1)}% margin</div>
    </div>
    <div class="ratio-card">
      <div class="label">Net Income</div>
      <div class="value">${money(t.netIncome, s.currency)}</div>
      <div class="meta">${(safeDiv(t.netIncome, s.incomeStatement.revenue) * 100).toFixed(1)}% margin</div>
    </div>
    <div class="ratio-card">
      <div class="label">Total Debt</div>
      <div class="value">${money(t.totalDebt, s.currency)}</div>
      <div class="meta">${safeDiv(t.totalDebt, t.ebitda).toFixed(2)}× EBITDA</div>
    </div>
  </div>

  <h2>Financial Statements</h2>
  ${balanceSheetTable()}
  ${incomeStatementTable()}

  <h2>Liquidity & Working Capital</h2>
  ${ratioGroup("Liquidity", r.liquidity)}
  ${ratioGroup("Working Capital Cycle", r.efficiency)}

  <h2>Profitability</h2>
  ${ratioGroup("Margin & Returns", r.profitability)}

  <h2>Leverage & Coverage</h2>
  ${ratioGroup("Capital Structure", r.leverage)}
  ${ratioGroup("Debt Coverage", r.coverage)}

  <h2>Bankruptcy Risk</h2>
  ${ratioGroup("Distress Models", r.bankruptcy)}

  <h2>Recommendations</h2>
  ${recs.map(recommendationCard).join("")}

  <div class="footer">
    Generated by CFO AI · Financial Statement Intelligence · ${escapeHtml(today)}<br/>
    AI-assisted analysis. Final decisions remain with management.
  </div>
</body>
</html>`;
}

// ─── Local helpers ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(n: number, currency: string): string {
  // Render full number with thousands separators (e.g. "2,300,000 RON")
  // — board-pack reports show precise figures, not abbreviated.
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${currency} ${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// Browser-side helper: triggers a download of the rendered HTML report.
export function downloadReport(s: Statements): void {
  const html = renderReportHtml(s);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = s.companyName.replace(/[^a-z0-9]+/gi, "_");
  a.href = url;
  a.download = `${safeName}_Financial_Analysis_${s.periodLabel.replace(/\s+/g, "_")}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
