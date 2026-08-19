// Multi-sheet Excel export for the Financial Statement Intelligence report.
//
// Produces a single .xlsx workbook with these tabs:
//   1. Cover                — company, period, currency, generation timestamp
//   2. P&L                  — income statement (current vs prior)
//   3. Balance Sheet        — current vs prior with Δ
//   4. Ratios               — all ratio groups with verdict + benchmark
//   5. Cash Flow            — CFO, capex, FCF
//   6. Valuation            — WACC, DCF year-by-year, Graham, EV multiples
//   7. Credit & Risk        — Altman Z, Piotroski F, composite credit score
//   8. Recommendations      — prioritized actions
//
// Uses the xlsx library (already in package.json).

import * as XLSX from "xlsx";
import {
  canonicalBsSectionMeta,
  computeRatios,
  deriveTotals,
  generateRecommendations,
  formatRatio,
  verdictLabel,
  type Statements,
} from "./financialReport";
// servedFacts gateway — BS totals + the balance-status wording. The Excel
// status cell calls the SAME presentStatus the BS chip and the HTML export
// footer use; this file carries no status wording of its own.
import { factsFrom } from "./servedFacts";
import {
  computeCostOfCapital,
  computeCreditScore,
  deriveCashFlow,
  multiPeriodGrowth,
  runDcf,
  runGraham,
  runPiotroski,
} from "./financialValuation";

/** Currency context for export — captured at the moment the user
 *  clicks "Export". The export embeds the display currency + the FX
 *  rate it used so the recipient knows what they're reading.
 *  Optional for back-compat; absent → defaults to the storage currency
 *  with no conversion note. */
export interface ExportCurrencyContext {
  /** Currency the user was viewing when they hit Export. */
  display: "RON" | "EUR" | "USD";
  /** Rate used to convert from canonical (EUR base) → display. */
  rate: number;
  /** Source of the rate: "BNR" | "fallback". */
  source: string;
  /** ISO date the upstream rate provider published. */
  asOf: string;
}

export function buildExcelWorkbook(s: Statements, currencyCtx?: ExportCurrencyContext): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  // servedFacts gateway (docs/CANONICAL_BS_V2_CONTRACT.md + served_envelope
  // schema) — BS totals, the presence branch, and the balance status all
  // come from `factsFrom`; this file never reads `s.canonical_bs` or
  // recomputes a BS total. deriveTotals survives for the P&L-side KPIs and
  // the debt decomposition (not carried by canonical_bs).
  const sf = factsFrom(s);
  const cbs = sf.canonicalForRender();
  const t = deriveTotals(s);
  const ratios = computeRatios(s);
  const recs = generateRecommendations(s, ratios);
  const cf = deriveCashFlow(s);
  const wacc = computeCostOfCapital(s);
  const dcf = runDcf(s);
  const graham = runGraham(s);
  const piotroski = runPiotroski(s);
  const credit = computeCreditScore(s);
  const growth = multiPeriodGrowth(s);

  // ─ Cover ─────────────────────────────────────────────────────────────────
  const cover: (string | number)[][] = [
    [s.companyName],
    ["Comprehensive Financial Analysis"],
    [],
    ["Period", s.periodLabel],
    ["Currency", s.currency],
    ["Industry", s.industry ?? "—"],
    ["Generated", new Date().toLocaleString("en-GB")],
    [],
    ["Headline KPIs"],
    ["Revenue", s.incomeStatement.revenue],
    ["EBITDA", t.ebitda],
    ["EBIT", t.ebit],
    ["Net income", t.netIncome],
    // BS headline KPIs come from the servedFacts gateway (adjusted figures
    // on RECONCILED periods) so the Cover can never quote a different book
    // than the Balance Sheet sheet — no presence branch here.
    ["Total assets", sf.totalAssets()],
    ["Total debt", t.totalDebt],
    ["Net debt", t.netDebt],
    ["Total equity", sf.totalEquity()],
    [],
    ["AUDIT FOOTER"],
    // Currency conversion note — only when display ≠ canonical (EUR).
    ...(currencyCtx && currencyCtx.display !== "EUR"
      ? [
          [
            `All figures shown in ${currencyCtx.display}. Conversion rate: 1 EUR = ${currencyCtx.rate.toFixed(4)} ${currencyCtx.display} (${currencyCtx.source}, ${currencyCtx.asOf}).`,
          ],
          [
            `Underlying values stored in source-document currency (typically RON for Romanian filings). Conversion applied at display + export time only.`,
          ],
          [],
        ]
      : []),
    ["EXTRACTION QUALITY"],
    ["This workbook was generated from automated trial-balance extraction."],
    ["Per-document extraction confidence is computed at upload time and"],
    ["surfaced in the app's post-upload quality panel. Verify headline"],
    ["figures (revenue, EBITDA, net profit, total assets, total debt,"],
    ["total equity) against your source trial balance before using this"],
    ["report for external purposes — including board reports, bank"],
    ["submissions, investor pitches, due diligence packages, or audit"],
    ["materials."],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cover), "Cover");

  // ─ P&L ───────────────────────────────────────────────────────────────────
  const priorIs = s.prior?.incomeStatement;
  const priorT = s.prior
    ? deriveTotals({
        ...s,
        balanceSheet: s.prior.balanceSheet,
        incomeStatement: s.prior.incomeStatement,
        periodLabel: s.prior.periodLabel,
        prior: undefined,
      })
    : null;
  const plRows: (string | number)[][] = [
    ["Profit & Loss", s.periodLabel, s.prior?.periodLabel ?? "—", "Δ Abs", "Δ %"],
    plRow("Revenue", s.incomeStatement.revenue, priorIs?.revenue),
    plRow("Cost of goods sold", -s.incomeStatement.costOfGoodsSold, priorIs ? -priorIs.costOfGoodsSold : undefined),
    plRow("Gross profit", t.grossProfit, priorT?.grossProfit),
    plRow("Operating expenses", -s.incomeStatement.operatingExpenses, priorIs ? -priorIs.operatingExpenses : undefined),
    plRow("Other operating income", s.incomeStatement.otherIncome, priorIs?.otherIncome),
    plRow("EBITDA", t.ebitda, priorT?.ebitda),
    plRow("Depreciation & amortization", -s.incomeStatement.depreciationAmortization, priorIs ? -priorIs.depreciationAmortization : undefined),
    plRow("EBIT", t.ebit, priorT?.ebit),
    plRow("Financial income", s.incomeStatement.financialIncome ?? 0, priorIs?.financialIncome ?? 0),
    plRow("Interest expense", -s.incomeStatement.interestExpense, priorIs ? -priorIs.interestExpense : undefined),
    plRow("Financial expense", -(s.incomeStatement.financialExpense ?? 0), priorIs ? -(priorIs.financialExpense ?? 0) : undefined),
    plRow("Net financial result", t.netFinancialResult, priorT?.netFinancialResult),
    plRow("Profit before tax", t.pbt, priorT?.pbt),
    plRow("Tax expense", -s.incomeStatement.taxExpense, priorIs ? -priorIs.taxExpense : undefined),
    plRow("Net income", t.netIncome, priorT?.netIncome),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(plRows), "P&L");

  // ─ Balance sheet ─────────────────────────────────────────────────────────
  // canonical_bs v2 path — the sheet serializes the engine's rows, section
  // subtotals, totals and balance status verbatim (contract "Consumption
  // rules"); nothing on this branch is recomputed FE-side. The deriveTotals
  // sheet below it stays as the legacy fallback for pre-bs_v2 periods.
  if (cbs) {
    const canonRows: (string | number)[][] = [
      ["Balance Sheet — engine canonical", s.periodLabel, "Accounts"],
    ];
    for (const sec of cbs.sections) {
      const meta = canonicalBsSectionMeta(sec.id);
      const rows = cbs.rows.filter((row) => row.section === sec.id);
      if (rows.length === 0 && sec.subtotal === 0) continue;
      canonRows.push([meta.header, "", ""]);
      for (const row of rows) {
        canonRows.push([`  ${row.label}`, row.amount, row.account_codes.join(", ")]);
      }
      canonRows.push([meta.subtotalLabel, sec.subtotal, ""]);
    }
    // Totals + status through the gateway — the status cell is the
    // presenter's machine token (RECONCILED is machine-distinct from
    // BALANCED; a reconciled workbook can never claim the pristine
    // verdict), and the wording lines are the presenter's, shared with
    // the BS chip and the HTML footer.
    const p = sf.presentStatus(s.currency);
    canonRows.push(
      [],
      ["Total assets", sf.totalAssets()],
      ["Total equity", sf.totalEquity()],
      ["Total liabilities", sf.totalLiabilities()],
      ["Total equity + liabilities", sf.equityPlusLiabilities()],
      ["Difference (assets − equity − liabilities)", sf.difference()],
      ["Balance status", p.exportStatusCell],
    );
    if (p.exportDetail || p.band !== "balanced") {
      canonRows.push([], [p.exportHeadline]);
      if (p.exportDetail) canonRows.push([p.exportDetail]);
    }
    if (p.band === "material_imbalance") {
      // The workbook must carry the defect, not hide it: a materially
      // imbalanced statement exports with the engine's diagnosis attached.
      for (const d of cbs.diagnosis ?? []) canonRows.push([d.code, d.detail]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(canonRows), "Balance Sheet");
  } else {
    const bs = s.balanceSheet;
    const bsP = s.prior?.balanceSheet;
    const bsRows: (string | number)[][] = [
      ["Balance Sheet", s.periodLabel, s.prior?.periodLabel ?? "—", "Δ Abs", "Δ %"],
      plRow("Cash & equivalents", bs.cash, bsP?.cash),
      plRow("Accounts receivable", bs.accountsReceivable, bsP?.accountsReceivable),
      plRow("Inventory", bs.inventory, bsP?.inventory),
      plRow("Other current assets", bs.otherCurrentAssets, bsP?.otherCurrentAssets),
      // Current-period totals via the servedFacts gateway (envelope truth);
      // the prior column keeps deriveTotals — prior periods carry no served
      // envelope on this payload shape.
      plRow("Total current assets", sf.currentAssets(), priorT?.totalCurrentAssets),
      plRow("Property, plant & equipment", bs.propertyPlantEquipment, bsP?.propertyPlantEquipment),
      plRow("Intangibles", bs.intangibles, bsP?.intangibles),
      plRow("Other non-current assets", bs.otherNonCurrentAssets, bsP?.otherNonCurrentAssets),
      plRow("Total non-current assets", sf.nonCurrentAssets(), priorT?.totalNonCurrentAssets),
      plRow("Total assets", sf.totalAssets(), priorT?.totalAssets),
      plRow("Accounts payable", bs.accountsPayable, bsP?.accountsPayable),
      plRow("Short-term debt", bs.shortTermDebt, bsP?.shortTermDebt),
      plRow("Other current liabilities", bs.otherCurrentLiabilities, bsP?.otherCurrentLiabilities),
      plRow("Total current liabilities", sf.currentLiabilities(), priorT?.totalCurrentLiabilities),
      plRow("Long-term debt", bs.longTermDebt, bsP?.longTermDebt),
      plRow("Other non-current liabilities", bs.otherNonCurrentLiabilities, bsP?.otherNonCurrentLiabilities),
      plRow("Total non-current liabilities", sf.nonCurrentLiabilities(), priorT?.totalNonCurrentLiabilities),
      plRow("Total liabilities", sf.totalLiabilities(), priorT?.totalLiabilities),
      plRow("Share capital", bs.shareCapital, bsP?.shareCapital),
      plRow("Retained earnings", bs.retainedEarnings, bsP?.retainedEarnings),
      plRow("Other equity", bs.otherEquity, bsP?.otherEquity),
      plRow("Total equity", sf.totalEquity(), priorT?.totalEquity),
      plRow("Total liabilities + equity", sf.equityPlusLiabilities(), priorT?.totalLiabilitiesAndEquity),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bsRows), "Balance Sheet");
  }

  // ─ Ratios ────────────────────────────────────────────────────────────────
  const ratioRows: (string | number)[][] = [
    ["Group", "Ratio", "Value", "Verdict", "Benchmark", "Commentary"],
  ];
  const groups: [string, typeof ratios.liquidity][] = [
    ["Liquidity", ratios.liquidity],
    ["Profitability", ratios.profitability],
    ["Leverage", ratios.leverage],
    ["Coverage", ratios.coverage],
    ["Efficiency", ratios.efficiency],
    ["Bankruptcy", ratios.bankruptcy],
  ];
  for (const [groupName, group] of groups) {
    for (const r of group) {
      ratioRows.push([groupName, r.label, formatRatio(r), verdictLabel(r.verdict), r.benchmark, r.commentary]);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ratioRows), "Ratios");

  // ─ Cash flow ─────────────────────────────────────────────────────────────
  const cfRows: (string | number)[][] = [
    ["Cash Flow Snapshot", s.periodLabel],
    ["Net income", cf.netIncome],
    ["+ Depreciation & amortization", cf.depreciationAmortization],
    ["- Δ Working capital", cf.workingCapitalChange],
    ["= Cash flow from operations (CFO)", cf.cfo],
    ["- Capex", cf.capex],
    ["= Free cash flow (FCF)", cf.fcf],
  ];
  if (growth.length) {
    cfRows.push([], ["Multi-period growth"], ["Metric", ...growth[0].values.map((v) => v.period), "CAGR"]);
    for (const row of growth) {
      cfRows.push([row.metric, ...row.values.map((v) => v.value), `${(row.cagr * 100).toFixed(1)}%`]);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cfRows), "Cash Flow");

  // ─ Valuation ─────────────────────────────────────────────────────────────
  const valRows: (string | number)[][] = [
    // Honesty note (2026-07-25): market inputs (Rf/ERP/beta, growth, bond
    // yield) are standing RO-market defaults unless supplied — a trial
    // balance carries no market data. Everything else derives from the upload.
    ["Note: market inputs (risk-free rate, ERP, beta, growth, bond yield) are standing defaults, not derived from the uploaded trial balance. Illustrative cross-check."],
    [],
    ["Cost of Capital"],
    ["Risk-free rate", `${(wacc.riskFreeRate * 100).toFixed(2)}%`],
    ["Equity risk premium", `${(wacc.equityRiskPremium * 100).toFixed(2)}%`],
    ["Beta", wacc.beta],
    ["Cost of equity", `${(wacc.costOfEquity * 100).toFixed(2)}%`],
    ["Cost of debt (pre-tax)", `${(wacc.costOfDebtPreTax * 100).toFixed(2)}%`],
    ["Tax rate", `${(wacc.taxRate * 100).toFixed(2)}%`],
    ["Cost of debt (after tax)", `${(wacc.costOfDebtAfterTax * 100).toFixed(2)}%`],
    ["Weight of equity", `${(wacc.weightOfEquity * 100).toFixed(1)}%`],
    ["Weight of debt", `${(wacc.weightOfDebt * 100).toFixed(1)}%`],
    ["WACC", `${(wacc.wacc * 100).toFixed(2)}%`],
    [],
    ["DCF Forecast (5-year explicit + Gordon terminal)"],
    ["Year", "FCF", "Discount factor", "Present value"],
    ...dcf.yearByYear.map((y) => [y.year, y.fcf, y.discountFactor.toFixed(4), y.presentValue]),
    ["Terminal value (undiscounted)", "", "", dcf.terminalValueUndiscounted],
    ["Terminal value (PV)", "", "", dcf.terminalValuePresent],
    ["Enterprise value", "", "", dcf.enterpriseValue],
    ["Less: net debt", "", "", -dcf.netDebt],
    ["Equity value", "", "", dcf.equityValue],
    [],
    ["Multiples"],
    ["EV / EBITDA", dcf.evToEbitda.toFixed(2) + "×"],
    ["EV / Revenue", dcf.evToRevenue.toFixed(2) + "×"],
    [],
    ["Graham Intrinsic Value"],
    ["Formula", graham.formula],
    ["Net income", graham.eps * (s.supplementary.sharesOutstanding ?? 1)],
    ["Growth rate (g)", `${(graham.growthRate * 100).toFixed(1)}%`],
    ["AAA bond yield (Y)", `${(graham.bondYield * 100).toFixed(2)}%`],
    ["Intrinsic equity value", graham.intrinsicEquityValue],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(valRows), "Valuation");

  // ─ Credit & risk ─────────────────────────────────────────────────────────
  const creditRows: (string | number)[][] = [
    ["Composite Credit Score"],
    ["Score (0–100)", credit.score],
    ["Rating", credit.rating],
    [],
    ["Component", "Value", "Weight", "Contribution"],
    ...credit.components.map((c) => [c.label, c.value.toFixed(2), `${(c.weight * 100).toFixed(0)}%`, c.contribution.toFixed(1)]),
    [],
    ["Piotroski F-Score"],
    ["Score (0–9)", piotroski.score],
    ["Band", piotroski.band],
    [],
    ["Check", "Result", "Detail"],
    ...piotroski.checks.map((c) => [
      c.label,
      c.result === "pass" ? "✓" : c.result === "fail" ? "✗" : "?",
      c.detail,
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(creditRows), "Credit & Risk");

  // ─ Recommendations ───────────────────────────────────────────────────────
  const recRows: (string | number)[][] = [
    ["Priority", "Title", "Why", "Action", "Estimated annual impact"],
    ...recs.map((r) => [
      r.priority,
      r.title,
      r.rationale,
      r.action,
      r.estimatedImpact ? r.estimatedImpact : "",
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(recRows), "Recommendations");

  return wb;
}

function plRow(label: string, current: number, prior?: number | null): (string | number)[] {
  if (prior === undefined || prior === null) return [label, current, "—", "", ""];
  const delta = current - prior;
  const pct = prior !== 0 ? (delta / Math.abs(prior)) * 100 : 0;
  return [label, current, prior, delta, prior !== 0 ? `${pct.toFixed(1)}%` : "—"];
}

export function downloadExcelReport(s: Statements): void {
  const wb = buildExcelWorkbook(s);
  const safeName = s.companyName.replace(/[^a-z0-9]+/gi, "_");
  const filename = `${safeName}_Financial_Analysis_${s.periodLabel.replace(/\s+/g, "_")}.xlsx`;
  XLSX.writeFile(wb, filename);
}
