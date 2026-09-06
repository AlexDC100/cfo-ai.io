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
  altmanRatio,
  renderReportHtml,
  VERDICT_UNAVAILABLE_NOTE,
  saveHtmlReport,
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
  type CreditEnvelope,
  type CreditScoreResult,
  type PiotroskiEnvelope,
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

/** The engine's own verdict for this period, threaded through to the
 *  export so THE WORKBOOK AND THE SCREEN CANNOT PRINT DIFFERENT LETTERS.
 *
 *  ⚠ MEASURED, ON THE INTACT SCANDIA CORPUS, BEFORE THIS EXISTED. The
 *  app showed CC / 24.4 (engine model) and the workbook the user
 *  forwarded showed CCC / 36 (client fallback), because
 *  `buildExcelWorkbook` called `computeCreditScore(s)` with no envelopes
 *  and `Statements` does not carry `assembled_metrics`. Same company,
 *  same period, same file — two letters, one of them in the document
 *  that leaves the building. */
export interface CreditEnvelopes {
  credit?: CreditEnvelope;
  piotroski?: PiotroskiEnvelope;
  /** `calculated_metrics` by name — the Altman map the engine reader
   *  prefers over the credit envelope's own components. */
  metricsByName?: Record<string, number | null>;
}

export function buildExcelWorkbook(
  s: Statements,
  currencyCtx?: ExportCurrencyContext,
  envelopes?: CreditEnvelopes,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  // servedFacts gateway (docs/CANONICAL_BS_V2_CONTRACT.md + served_envelope
  // schema) — BS totals, the presence branch, and the balance status all
  // come from `factsFrom`; this file never reads `s.canonical_bs` or
  // recomputes a BS total. deriveTotals survives for the P&L-side KPIs and
  // the debt decomposition (not carried by canonical_bs).
  const sf = factsFrom(s);
  const cbs = sf.canonicalForRender();
  const t = deriveTotals(s);
  // ── THE RATIOS SHEET READ A DIFFERENT BOOK THAN THE APP ────────────
  //
  // `computeRatios(s)` — no engine metric map — recomputes FE-side every
  // ratio the engine already emitted as a `calculated_metrics` row,
  // while every on-screen caller passes the map. Measured on the real
  // Scandia period, reading the workbook back from the bytes on disk,
  // two of twenty-three rows moved:
  //
  //     Interest Coverage   1.46×  Critical   →  2.58×  Watch
  //     Altman Z″-Score     0.19   Critical   →  0.22   Critical
  //
  // A "Critical" interest-coverage verdict that exists only in the file
  // the user forwards. The map is threaded through, so the sheet quotes
  // the engine wherever the engine spoke — exactly as the screen does.
  const ratios = computeRatios(s, undefined, envelopes?.metricsByName);
  const recs = generateRecommendations(s, ratios);
  const cf = deriveCashFlow(s);
  const wacc = computeCostOfCapital(s);
  const dcf = runDcf(s);
  const graham = runGraham(s);
  const credit = computeCreditScore(
    s,
    envelopes?.credit,
    envelopes?.piotroski,
    envelopes?.metricsByName,
  );
  // ONE PIOTROSKI, THE ONE THAT BELONGS TO THE LETTER. This file used to
  // call `runPiotroski(s)` separately, so on any period scored by the
  // engine the sheet would have printed the ENGINE's letter above the FE
  // model's 9-check screen — two models in one sheet with nothing saying
  // so. `credit.piotroski` is whichever screen the chosen model ran, and
  // it is NULL when the engine sent no Piotroski envelope (the sheet then
  // says the block is unavailable rather than substituting the other
  // model's).
  const piotroski = credit.piotroski;
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
    ["Total assets", cell(sf.totalAssets())],
    ["Total debt", t.totalDebt],
    ["Net debt", t.netDebt],
    ["Total equity", cell(sf.totalEquity())],
    [],
    // PROVENANCE — the served envelope's own words, only when it carries
    // them. A cell can hold a note (unlike CSV, which has no comment
    // syntax); an envelope that names no sheet or method yields no row,
    // never a dash. Same fields the on-screen affordance shows.
    ...(cbs
      ? ([
          ["PROVENANCE"],
          ...(cbs.extraction?.sheet ? [["Source sheet", cbs.extraction.sheet]] : []),
          ...(cbs.extraction?.method ? [["Extraction method", cbs.extraction.method]] : []),
          ...(cbs.extraction?.parser_version ? [["Parser", cbs.extraction.parser_version]] : []),
          ...(cbs.mapping_version ? [["Mapping pack", cbs.mapping_version]] : []),
          ["Balance-sheet rows carry their account codes on the Balance Sheet sheet."],
          [],
        ] as (string | number)[][])
      : []),
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
      ["Total assets", cell(sf.totalAssets())],
      ["Total equity", cell(sf.totalEquity())],
      ["Total liabilities", cell(sf.totalLiabilities())],
      ["Total equity + liabilities", cell(sf.equityPlusLiabilities())],
      ["Difference (assets − equity − liabilities)", cell(sf.difference())],
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
  // ── `ratios.bankruptcy` IS NOT IN THIS LIST, AND THAT IS THE FIX ───
  //
  // ONE WORKBOOK MUST NOT CARRY TWO ALTMANS. Measured on the real
  // Scandia period, read back from a file written by `XLSX.writeFile`
  // and re-parsed from its bytes, envelopes intact:
  //
  //     sheet "Credit & Risk"   Altman Z"-Score  0.22   30%   2.4
  //     sheet "Ratios"          Altman Z″-Score  0.19   Critical
  //                             "… distress zone. Action required."
  //
  // Two numbers for one measure in one file — and the DIVERGENT one
  // carried the verdict words a lender reads, while the authority's own
  // number carried none. Three separate arithmetics claim the name
  // "Altman Z″ (1995 EM)" in this codebase: the engine's 0.22,
  // `altmanZScore()`'s 0.20131 and `computeRatios`'s inline fallback's
  // 0.19. Even the two frontend ones disagree, so THREADING THE ENGINE
  // METRIC MAP IS NOT ENOUGH — it makes them agree only while a
  // particular row happens to arrive (measured: delete only
  // `calculated_metrics.altman_z_score` and the sheets split 0.22 /
  // 0.19 again).
  //
  // So the Bankruptcy group is not exported from `computeRatios` at all.
  // The workbook's ONE Altman is the credit reader's — the same
  // `AltmanResult` the Credit & Risk sheet, the Risks tab and the hero
  // card read — emitted here with the reader's own label, its own zone
  // and its own sentence. They cannot diverge because there is now only
  // one of them.
  const groups: [string, typeof ratios.liquidity][] = [
    ["Liquidity", ratios.liquidity],
    ["Profitability", ratios.profitability],
    ["Leverage", ratios.leverage],
    ["Coverage", ratios.coverage],
    ["Efficiency", ratios.efficiency],
  ];
  for (const [groupName, group] of groups) {
    for (const r of group) {
      ratioRows.push([groupName, r.label, formatRatio(r), verdictLabel(r.verdict), r.benchmark, r.commentary]);
    }
  }
  ratioRows.push(altmanRowFor(credit));
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
  // ── THE SHEET A LENDER READS ────────────────────────────────────────
  // This printed `Rating  B` and `Altman Z"-Score  0.00` with no cell
  // saying anything was unavailable, off an envelope that was simply
  // missing its BS totals. `cell()` spells the absence; `fixedCell()`
  // does the same for the formatted component columns, which used to
  // call `.toFixed(2)` straight onto a substituted 0.
  const creditRows: (string | number)[][] = [
    ["Composite Credit Score"],
    ["Score (0–100)", cell(credit.score)],
    ["Rating", credit.rating ?? EXPORT_UNREPORTED],
    // ── THE LETTER NEVER TRAVELS WITHOUT ITS MODEL ──────────────────
    // There are two scoring models behind this cell and they disagree:
    // on the real Scandia period the engine says CC / 24.4 and the
    // client fallback says CCC / 36. A forwarded workbook is read by
    // someone who cannot ask which one ran, so the id and the sentence
    // ship in the sheet, always — on the engine path too, so the reader
    // learns the distinction exists before they ever meet the other one.
    ["Scoring model", credit.model],
    ["Model", credit.modelLabel],
    // A workbook is forwarded; the reason a verdict is missing has to
    // travel with it, because the recipient cannot ask the app.
    ...(credit.score === null || credit.rating === null
      ? [[EXPORT_UNAVAILABLE_NOTE]]
      : []),
    [],
    // ── THE VERDICT WORDS BELONG BESIDE THE AUTHORITY'S NUMBER ──────
    // This table shipped value / weight / contribution and dropped
    // `read` — so the sheet holding the authoritative Altman printed it
    // with NO verdict at all, while the Ratios sheet printed a
    // divergent one WITH "distress zone. Action required." The reader
    // who wanted the words had to take them from the wrong number.
    ["Component", "Value", "Weight", "Contribution", "Read"],
    ...credit.components.map((c) => [
      c.label,
      fixedCell(c.value, 2),
      c.weight === null ? EXPORT_UNREPORTED : `${(c.weight * 100).toFixed(0)}%`,
      fixedCell(c.contribution, 1),
      // A component with no number has no sentence — never the intact
      // period's words over an absent figure.
      c.read ?? EXPORT_UNREPORTED,
    ]),
    [],
    ["Piotroski F-Score"],
    // ABSENT ≠ ZERO, AND ABSENT ≠ THE OTHER MODEL'S SCREEN. Null here
    // means the engine scored this period but sent no Piotroski
    // envelope; the sheet says so instead of quietly running the client
    // model's nine checks under the engine's letter.
    ...(piotroski === null
      ? ([
          ["Score (0–9)", EXPORT_UNREPORTED],
          [EXPORT_PIOTROSKI_ABSENT_NOTE],
        ] as (string | number)[][])
      : ([
          ["Score (0–9)", piotroski.score],
          ["Band", piotroski.band],
          ...(piotroski.unresolvedCount > 0
            ? [[EXPORT_PIOTROSKI_UNRESOLVED_NOTE]]
            : []),
          [],
          ["Check", "Result", "Detail"],
          ...piotroski.checks.map((c) => [
            c.label,
            c.result === "pass" ? "✓" : c.result === "fail" ? "✗" : "?",
            c.detail,
          ]),
        ] as (string | number)[][])),
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

/** The word an EXPORT CELL carries where a figure would have gone.
 *
 *  A blank cell in a workbook reads as zero to a spreadsheet and as an
 *  oversight to a reader; both are wrong. The servedFacts totals are
 *  `number | null` now, so an absent grand total must be spelled. */
const EXPORT_UNREPORTED = "not reported";

/** The sentence that travels with an absent VERDICT (a score, a rating,
 *  a zone) — as opposed to an absent figure. A recipient who opens this
 *  workbook cannot ask the app why a cell is empty, so the reason ships
 *  in the sheet.
 *
 *  ⚠ NOT A LOCAL STRING ANY MORE. The printed HTML document needs the
 *  identical sentence, and two byte-identical literals in two files are
 *  two spellings of one refusal waiting to drift. One constant,
 *  `VERDICT_UNAVAILABLE_NOTE` in financialReport.ts, for both. */
const EXPORT_UNAVAILABLE_NOTE = VERDICT_UNAVAILABLE_NOTE;

/** The engine scored the period but sent no Piotroski screen. Spelled
 *  out because the alternative — running the client model's nine checks
 *  and printing them under the engine's letter — is two models in one
 *  sheet with nothing to tell them apart. */
const EXPORT_PIOTROSKI_ABSENT_NOTE =
  "The Piotroski screen was not reported for this period. It is not scored here, " +
  "and the composite credit score above does not include it.";

/** A check that could not be RUN, as distinct from one that failed. */
const EXPORT_PIOTROSKI_UNRESOLVED_NOTE =
  "One or more checks could not be evaluated because a figure they need was not " +
  "reported for this period. They are marked '?' below, not '✗' — this is a limit " +
  "of the extraction, NOT a finding about the company.";

/** THE workbook's Altman row, for the Ratios sheet, built from the ONE
 *  reader that also produces the Credit & Risk sheet's Altman.
 *
 *  It deliberately reuses `credit.components[0].label` rather than
 *  spelling a label of its own: the two sheets used to disagree even
 *  about the NAME — `Altman Z"-Score` (U+0022) on one and
 *  `Altman Z″-Score` (U+2033, double prime) on the other — which reads
 *  as two measures to anyone scanning the file, and made the divergent
 *  pair marginally easier to mistake for two different things. They are
 *  not two different things, so they get one name.
 *
 *  The zone, the threshold text and the sentence all come off the same
 *  `AltmanResult`, so a number here cannot carry another number's
 *  verdict. The model rides along, because the value differs BY MODEL
 *  (engine 0.22 vs client fallback 0.20131 on this same period) and a
 *  forwarded workbook cannot ask which one ran. */
function altmanRowFor(credit: CreditScoreResult): (string | number)[] {
  // ⚠ THIS USED TO SPELL THE ROW ITSELF — label, zone word, threshold
  // string and sentence, all assembled here from `credit.altman`. That was
  // correct and it still produced a SECOND SPELLING of one row, because
  // the printed HTML document and the Ratios tab each had their own. The
  // shared projection is `altmanRatio(credit)` in financialReport.ts, so
  // the workbook cell, the on-screen card and the printed document are now
  // three renderings of ONE object rather than three descriptions of it.
  const r = altmanRatio(credit);
  const zoneWord =
    credit.altman.zone === "safe" ? "Safe"
    : credit.altman.zone === "grey" ? "Grey"
    : credit.altman.zone === "distress" ? "Distress"
    : EXPORT_UNREPORTED;
  return [
    "Bankruptcy",
    r.label,
    fixedCell(r.value, 2),
    zoneWord,
    r.benchmark,
    // Value and sentence agree about existence — a score the reader
    // refused has no verdict prose, and never the other model's.
    r.commentary,
  ];
}

/** A cell value for a possibly-absent figure. */
function cell(v: number | null | undefined): string | number {
  return typeof v === "number" && Number.isFinite(v) ? v : EXPORT_UNREPORTED;
}

/** A cell for a figure the sheet formats to fixed decimals. The naive
 *  `v.toFixed(n)` prints "0.00" for a substituted absence, which in a
 *  spreadsheet is indistinguishable from a measured zero. */
function fixedCell(v: number | null | undefined, digits: number): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : EXPORT_UNREPORTED;
}

function plRow(
  label: string,
  current: number | null,
  prior?: number | null,
): (string | number)[] {
  // An ABSENT current figure has no delta and no percentage: `null −
  // prior` is `−prior`, which would paint the whole prior balance as
  // this period's movement.
  if (typeof current !== "number" || !Number.isFinite(current)) {
    return [label, EXPORT_UNREPORTED, prior ?? "—", "", ""];
  }
  if (prior === undefined || prior === null) return [label, current, "—", "", ""];
  const delta = current - prior;
  const pct = prior !== 0 ? (delta / Math.abs(prior)) * 100 : 0;
  return [label, current, prior, delta, prior !== 0 ? `${pct.toFixed(1)}%` : "—"];
}

// ─── The OTHER deliverable, composed at the SAME point ──────────────────
//
// ⚠ THE DEFECT THIS CLOSES, MEASURED IN THE PRODUCED BYTES. The Export
// tab's HTML card called `downloadReport(statements)` — one argument. That
// reached `renderReportHtml(s)`, which called `computeRatios(s)` with no
// engine metric map and had no credit reader at all. Same period, same
// click, one card apart on the same screen:
//
//     Risks tab / hero / /report / workbook   Z″ 0.22   Distress   CC
//     HTML report → PDF                       Z″ 0.19   badge v-critical
//                                             "Bankruptcy risk: distress
//                                              zone. Action required."
//
// and the document carried no letter, no composite and no model anywhere
// in it. Planting an engine re-band moved every screen and the workbook;
// the document did not move, because it had nothing in it that could.
//
// The composition lives HERE, next to the workbook's, so both deliverables
// are built from ONE `CreditEnvelopes` object by ONE reader. `envelopes` is
// REQUIRED — an omitted argument is how the first divergence happened, and
// a caller with genuinely no engine envelope passes `{}`, which is a
// decision the client-fallback model then names in the document itself.
export function buildReportHtml(s: Statements, envelopes: CreditEnvelopes): string {
  const credit = computeCreditScore(
    s,
    envelopes.credit,
    envelopes.piotroski,
    envelopes.metricsByName,
  );
  return renderReportHtml(s, credit, envelopes.metricsByName);
}

/** Browser-side helper: renders the board-pack HTML and saves it. */
export function downloadHtmlReport(s: Statements, envelopes: CreditEnvelopes): void {
  saveHtmlReport(buildReportHtml(s, envelopes), s);
}

export function downloadExcelReport(s: Statements, envelopes?: CreditEnvelopes): void {
  // `envelopes` is optional so every existing caller keeps compiling, but
  // the ONE caller in the app passes them — an export that silently omits
  // them is an export scored by the other model. See `CreditEnvelopes`.
  const wb = buildExcelWorkbook(s, undefined, envelopes);
  const safeName = s.companyName.replace(/[^a-z0-9]+/gi, "_");
  const filename = `${safeName}_Financial_Analysis_${s.periodLabel.replace(/\s+/g, "_")}.xlsx`;
  XLSX.writeFile(wb, filename);
}
