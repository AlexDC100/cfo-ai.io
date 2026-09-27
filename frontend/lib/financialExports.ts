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
  exportRatioBundle,
  deriveTotals,
  generateRecommendations,
  formatRatio,
  ratioBadgeLabel,
  altmanRatio,
  renderReportHtml,
  reportChartBlocks,
  VERDICT_UNAVAILABLE_NOTE,
  saveHtmlReport,
  ALTMAN_RATIO_KEY,
  RATIO_CMP_EXPORT_LOCALE,
  printedRatioCells,
  printRatioCompareRow,
  priorColumnHeading,
  priorRatioAbsence,
  ratioRowAbsence,
  ratioCompareHeadings,
  servedMovableRows,
  servedRatioComparison,
  servedRatioKey,
  servedRatioLabel,
  type Statements,
} from "./financialReport";
// The band-movement headline, read off the served two-period table — the
// SAME model the report's executive summary renders, so the workbook's
// improved / deteriorated lists cannot differ from the document's.
import { buildBandMovements } from "./executiveSummary";
import { ratioCompareHeadingsFor, type RatioCompareRow } from "./ratioTable";
// servedFacts gateway — BS totals + the balance-status wording. The Excel
// status cell calls the SAME presentStatus the BS chip and the HTML export
// footer use; this file carries no status wording of its own.
import { factsFrom } from "./servedFacts";
import { plLevelsOf } from "./servedOneEbitda";
import { printedPl, printedRow, type PrintedPlRow } from "./printedPl";
// ONE sentence for "there is nothing to compare against", shared with
// the report model — so the workbook and the printed document cannot
// describe the same absence two different ways.
import { NO_COMPARATIVE_CELL } from "./reportComparatives";
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
  // THE PRINTED P&L — the same rows, in the same order, with the same
  // served figures as the document's P&L table (`printedPl`).
  const ppl = printedPl(s);
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
  // …and, with a served two-period table, every row it carries is read off
  // the served current side, as the document's cards are.
  const ratios = exportRatioBundle(s, envelopes?.metricsByName);
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
    // Net turnover (70x − 709) and THE ONE EBITDA / EBIT (711 and 72x
    // inside) — the printed P&L's own rows; a refused figure says so.
    ["Net turnover (70x − 709)", printedCell(printedRow(ppl, "turnover"))],
    ["EBITDA", printedCell(printedRow(ppl, "ebitda"))],
    ["EBIT", printedCell(printedRow(ppl, "ebit"))],
    // The COVER quotes the same figure the KPI card and the printed P&L's
    // last row quote — account 121's close, not the reconstruction. See
    // `statutoryNetIncome`.
    [NET_INCOME_LABEL, printedCell(printedRow(ppl, "net_income"))],
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
  // ONE ROW MODEL WITH THE DOCUMENT (`printedPl`): net turnover, cost of
  // sales with "Variația stocurilor de produse" (711) beside it, gross
  // profit, operating costs, 72x as its own operating line, THE ONE EBITDA,
  // EBIT, the financial block, PBT, tax, and account 121 — every subtotal
  // the sum of the rows above it, and the not-explained gap (never 711)
  // printed with its amount. The prior column is the prior's OWN printed
  // P&L, and only when it sits on the same EBITDA definition: a prior
  // served under another definition prints no EBITDA-family cell.
  const priorShell: Statements | null = s.prior
    ? {
        ...s,
        balanceSheet: s.prior.balanceSheet,
        incomeStatement: s.prior.incomeStatement,
        assembled_pl: s.prior.assembled_pl,
        periodLabel: s.prior.periodLabel,
        prior: undefined,
      }
    : null;
  const priorPpl = priorShell ? printedPl(priorShell) : null;
  /** The prior's balance-sheet totals, for the BS sheet's prior column. */
  const priorT = priorShell ? deriveTotals(priorShell) : null;
  const sameDefinition =
    priorShell !== null &&
    plLevelsOf(priorShell).definition === plLevelsOf(s).definition;
  const DEFINITION_KEYS = new Set([
    "inventory_variation", "capitalized_own_work", "gross_profit", "ebitda", "ebit", "pretax", "net_result_built",
  ]);
  const priorValueOf = (key: string): number | null | undefined => {
    if (!priorPpl) return undefined;
    if (!sameDefinition && DEFINITION_KEYS.has(key)) return undefined;
    const r = printedRow(priorPpl, key);
    return r ? r.value : undefined;
  };
  const plRows: (string | number)[][] = [
    // The comparison column is HEADED with what it holds. "—" as a
    // header made the whole column ambiguous before a single cell was
    // read; the sentence says the column is empty because there is no
    // period behind it, not because nothing moved.
    ["Profit & Loss", s.periodLabel, priorColumnHeading(s), "Δ Abs", "Δ %"],
    ...ppl.rows.map((r) => {
      const row = plRow(SHEET_LABEL[r.key] ?? r.label, r.value, priorValueOf(r.key));
      // A refused figure states the engine's reason in the cell, never
      // the bare word — the reader of a forwarded workbook has no popover.
      if (r.value === null && r.refusal) row[1] = `refused — ${r.refusal.text.en}`;
      // The measured lines (711 / 72x) carry the engine's gloss and
      // provenance sentence in a sixth column, as the document prints it
      // under the row.
      if (r.note) row.push(r.note);
      return row;
    }),
    ...(ppl.bridge ? [[], [`EBITDA includes the stock variation: ${ppl.bridge}`]] : []),
    ...(ppl.identityNote ? [[ppl.identityNote]] : []),
    ...(ppl.splitAssumption ? [[ppl.splitAssumption]] : []),
    ...(ppl.ebitdaRefusal
      ? [[`EBITDA refused: ${ppl.ebitdaRefusal.text.en}. EBITDA, EBIT, profit before tax and every margin and ratio built on them are refused with it.`]]
      : []),
  ];
  const plSheet = XLSX.utils.aoa_to_sheet(plRows);
  noteSourceFiles(plSheet, s.sourceDocument, s.prior?.sourceDocument);
  XLSX.utils.book_append_sheet(wb, plSheet, "P&L");

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
    const bsSheet = XLSX.utils.aoa_to_sheet(canonRows);
    // Three columns and no comparison column (comparativesDegradeHonestly):
    // the current period's file, on its own header cell only.
    noteSourceFiles(bsSheet, s.sourceDocument, null);
    XLSX.utils.book_append_sheet(wb, bsSheet, "Balance Sheet");
  } else {
    const bs = s.balanceSheet;
    const bsP = s.prior?.balanceSheet;
    const bsRows: (string | number)[][] = [
      ["Balance Sheet", s.periodLabel, priorColumnHeading(s), "Δ Abs", "Δ %"],
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
    const bsSheet = XLSX.utils.aoa_to_sheet(bsRows);
    noteSourceFiles(bsSheet, s.sourceDocument, s.prior?.sourceDocument);
    XLSX.utils.book_append_sheet(wb, bsSheet, "Balance Sheet");
  }

  // ─ Ratios ────────────────────────────────────────────────────────────────
  //
  // THE SIX COLUMNS — [current] [prior] [Δ] [band now] [band prior] [band
  // movement] — read off the served two-period table and printed by the one
  // formatter, the same cells the report's cards print. The value column is
  // still the one right after the ratio's name, so every reader that takes
  // "the figure after the label" reads the current figure, as before.
  //
  // With no served table: current and band from the row the sheet has
  // always printed, and the four prior-dependent cells state why there is
  // nothing to print ("no prior period", or the reason a comparison reached
  // this export without its table). Never a dash, never a blank.
  const ratioCmp = servedRatioComparison(s);
  const ratioCmpRows = new Map<string, RatioCompareRow>(
    ratioCmp ? servedMovableRows(ratioCmp).map((row) => [row.key, row]) : [],
  );
  const cmpHeadings = ratioCmp
    ? ratioCompareHeadings(ratioCmp)
    : ratioCompareHeadingsFor(s.periodLabel, priorColumnHeading(s), RATIO_CMP_EXPORT_LOCALE);
  // A prior attached, a document attached, or a comparison requested and
  // refused / failed / pending: the four cells state the reason.
  const outcomeKind = s.comparison?.kind ?? "none";
  const cmpAbsent =
    ratioCmp === null && (s.prior !== undefined || (s.comparatives ?? null) !== null || outcomeKind !== "none")
      ? priorRatioAbsence(s)
      : null;
  const sixCells = (key: string, label: string, figure: string | number, band: string): (string | number)[] => {
    const row = ratioCmpRows.get(key);
    if (row) return printedRatioCells(printRatioCompareRow(row, label));
    // THE SAME SENTENCE THE REPORT CELL PRINTS (`ratioRowAbsence`,
    // `priorRatioAbsence`), so the two documents are byte-identical here.
    const why = ratioCmp ? ratioRowAbsence(label) : (cmpAbsent ?? NO_COMPARATIVE_CELL);
    return [figure, why, why, band, why, why];
  };
  const ratioRows: (string | number)[][] = [
    ["Group", "Ratio", ...cmpHeadings, "Benchmark", "Commentary"],
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
      // `r.label` is the one label authority (the `row` helper in
      // financialReport.ts resolves it from the i18n table the tab reads),
      // so this cell, the report card and the tab print one name.
      ratioRows.push([
        groupName,
        r.label,
        ...sixCells(servedRatioKey(r.key), r.label, formatRatio(r), ratioBadgeLabel(r)),
        r.benchmark,
        r.commentary,
      ]);
    }
  }
  // The census rows the engine serves with no `computeRatios` row: they
  // exist only in the served table, so they are listed only when one was
  // served — with the same six columns.
  if (ratioCmp) {
    const carded = new Set(groups.flatMap(([, g]) => g.map((r) => servedRatioKey(r.key))));
    for (const row of ratioCmp.rows) {
      if (carded.has(row.key)) continue;
      const label = servedRatioLabel(row.key, ratios, null);
      ratioRows.push([
        GROUP_WORD[row.group] ?? row.group,
        label,
        ...printedRatioCells(printRatioCompareRow(row, label)),
        "served by the engine from its metric rows; no card in the document",
        "",
      ]);
    }
  }
  ratioRows.push(altmanRowFor(credit, sixCells));
  // THE TWO CREDIT COMPOSITES, beside the Altman, when a table was served:
  // their prior, change and movement are the engine's (points, notches).
  if (ratioCmp) {
    for (const key of ["credit_composite", "letter_grade"]) {
      const row = ratioCmpRows.get(key);
      if (!row) continue;
      const label = servedRatioLabel(key, ratios, null);
      ratioRows.push(["Credit", label, ...printedRatioCells(printRatioCompareRow(row, label)), credit.model, credit.modelLabel]);
    }
  }

  // ── BAND MOVEMENTS — the headline, the same model the document prints ─
  const altmanLabel = altmanRatio(credit).label;
  const bands = buildBandMovements(s, ratios, altmanLabel);
  ratioRows.push([], ["Band movements"]);
  if (!bands.available) {
    ratioRows.push([bands.absence ?? NO_COMPARATIVE_CELL]);
  } else {
    ratioRows.push([`${bands.priorLabel} → ${bands.currentLabel}`], [bands.basis ?? ""]);
    const counts =
      `${bands.bothSides === null ? "The served table states no count of" : bands.bothSides} ratios and composites valued in both periods: ` +
      `moved up a band ${bands.improved.length}, moved down ${bands.deteriorated.length}, ` +
      `held their band ${bands.unchanged.length}, not comparable ${bands.notComparable.length}`;
    ratioRows.push([counts]);
    // Column order keeps the current figure right after the name, as in
    // the table above: [list, ratio, current, prior, Δ, movement, rung,
    // finding].
    ratioRows.push(["List", "Ratio", cmpHeadings[0], cmpHeadings[1], cmpHeadings[2], cmpHeadings[5], "Rung crossed", "Finding"]);
    for (const [title, entries, absence] of [
      ["Improved", bands.improved, bands.improvedAbsence],
      ["Deteriorated", bands.deteriorated, bands.deterioratedAbsence],
    ] as const) {
      if (entries.length === 0) {
        ratioRows.push([title, absence ?? ""]);
        continue;
      }
      for (const e of entries) {
        ratioRows.push([
          title,
          e.label,
          e.printed.current,
          e.printed.prior,
          e.printed.delta,
          e.printed.movement,
          e.rung ?? "no rung named",
          e.findingStatus === "surfaced"
            ? (e.findingTitle ?? "")
            : e.findingStatus === "demoted"
              ? `listed as a check: the finding is missing ${e.findingMissing.join(", ") || "an element it does not name"}`
              : "no finding row was served for this crossing",
        ]);
      }
    }
    for (const n of bands.notComparable) ratioRows.push(["Not comparable", n.label, n.reason]);
    for (const n of bands.refused) ratioRows.push(["Not compared", n.label, n.reason]);
    if (bands.unlisted.length > 0) {
      ratioRows.push(["Unlisted", `the served lists name ${bands.unlisted.join(", ")}, which the served table carries no row for`]);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ratioRows), "Ratios");

  // ─ Cash flow ─────────────────────────────────────────────────────────────
  const cfRows: (string | number)[][] = [
    ["Cash Flow Snapshot", s.periodLabel],
    // NAMED FOR WHAT IT IS. `deriveCashFlow` starts its walk from
    // `deriveTotals(s).netIncome`, the class-6/7 reconstruction, and the
    // three rows below it are that figure's arithmetic — so relabelling
    // is the honest repair here and substituting the filed figure under
    // the old name would leave the column not adding up. That
    // `deriveCashFlow` starts from the reconstruction at all is a
    // question for `financialValuation.ts`, recorded rather than silently
    // patched from this file.
    ["Net income — reconstructed (class 6/7 movements)", cf.netIncome],
    ["+ Depreciation & amortization", cf.depreciationAmortization],
    ["- Δ Working capital", cf.workingCapitalChange],
    ["= Cash flow from operations (CFO)", cf.cfo],
    ["- Capex", cf.capex],
    ["= Free cash flow (FCF)", cf.fcf],
  ];
  if (growth.length) {
    cfRows.push([], ["Multi-period growth"], ["Metric", ...growth[0].values.map((v) => v.period), "CAGR"]);
    for (const row of growth) {
      cfRows.push([
        row.metric,
        ...row.values.map((v) =>
          v.value !== null ? v.value : v.refusal ? `refused — ${v.refusal.text.en}` : EXPORT_UNREPORTED),
        row.cagr === null ? "no CAGR — an end of the series is refused, not positive, or on another definition" : `${(row.cagr * 100).toFixed(1)}%`,
      ]);
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
    ["EV / EBITDA", dcf.evToEbitda === null
      ? (t.ebitda === null ? `refused — EBITDA refused: ${t.plRefusal?.text.en ?? "not served"}` : "not meaningful — EBITDA is not positive")
      : dcf.evToEbitda.toFixed(2) + "×"],
    ["EV / Revenue", dcf.evToRevenue.toFixed(2) + "×"],
    [],
    ["Graham Intrinsic Value"],
    ["Formula", graham.formula],
    // `runGraham` already capitalises the STATUTORY figure (its own
    // comment says so); the label now says which one it is, so no sheet
    // in this workbook prints a bare "Net income" whose meaning the
    // reader has to guess.
    [NET_INCOME_LABEL, graham.eps * (s.supplementary.sharesOutstanding ?? 1)],
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
    // R-COMPOSITE: a refused composite ships its reason and the refused
    // components; the extraction note is for a period the engine never scored.
    ...(credit.score === null || credit.rating === null
      ? credit.compositeRefusal?.stated
        ? [["Composite and rating refused", credit.compositeRefusal.sentence]]
        : [[EXPORT_UNAVAILABLE_NOTE]]
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
      c.weight === null ? (c.refusal ? "refused" : EXPORT_UNREPORTED) : `${(c.weight * 100).toFixed(0)}%`,
      fixedCell(c.contribution, 1),
      // A component with no number has no sentence — never the intact
      // period's words over an absent figure.
      c.read ?? c.refusal?.sentence ?? EXPORT_UNREPORTED,
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

  // ── CHARTS — the same rows the document draws (R7) ─────────────────
  //
  // Not a picture of a chart and not a second derivation: the blocks come
  // from `reportChartBlocks`, the SAME call `renderReportHtml` makes, so
  // every `printed` string in this sheet is the identical string the HTML
  // prints. A workbook that re-derived them would agree until the day one
  // of the two files was edited alone.
  //
  // The GAP CARDS travel too. A workbook that silently omitted the five
  // charts this period could not produce would read as a period with five
  // fewer questions in it.
  const chartBlocks = reportChartBlocks(s, credit, envelopes?.metricsByName);
  const chartRows: (string | number)[][] = [
    [`${s.companyName} — chart data`, "", "", ""],
    [`${s.periodLabel} · ${s.currency}`, "", "", ""],
    [],
  ];
  for (const blk of chartBlocks) {
    chartRows.push([blk.title, blk.status === "drawn" ? "charted" : "not charted", "", ""]);
    if (blk.status === "drawn") {
      chartRows.push(["Series", "Value", "Source", ""]);
      for (const row of blk.rows) chartRows.push([row.label, row.printed, row.source, ""]);
    } else if (blk.absence) {
      chartRows.push(["Missing", blk.absence.missing.join("; "), "", ""]);
      chartRows.push(["Why", blk.absence.because, "", ""]);
      chartRows.push(["To produce it", blk.absence.toFix, "", ""]);
    }
    chartRows.push(["Note", blk.caption, "", ""]);
    chartRows.push([]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(chartRows), "Charts");

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
/** The served group word for a census row with no `computeRatios` row. */
const GROUP_WORD: Readonly<Record<string, string>> = {
  liquidity: "Liquidity",
  profitability: "Profitability",
  leverage: "Leverage",
  coverage: "Coverage",
  efficiency: "Efficiency",
  distress: "Bankruptcy",
  credit: "Credit",
};

function altmanRowFor(
  credit: CreditScoreResult,
  sixCells: (key: string, label: string, figure: string | number, band: string) => (string | number)[],
): (string | number)[] {
  // ⚠ THIS USED TO SPELL THE ROW ITSELF — label, zone word, threshold
  // string and sentence, all assembled here from `credit.altman`. That was
  // correct and it still produced a SECOND SPELLING of one row, because
  // the printed HTML document and the Ratios tab each had their own. The
  // shared projection is `altmanRatio(credit)` in financialReport.ts, so
  // the workbook cell, the on-screen card and the printed document are now
  // three renderings of ONE object rather than three descriptions of it.
  const r = altmanRatio(credit);
  // With a served two-period table, the six cells are the served
  // `altman_z` composite row; without one, the reader's value and the SAME
  // band word the document's Altman card prints in its "Band now" cell
  // (`ratioBadgeLabel`: safe zone → Healthy, grey → Watch, distress →
  // Critical — the words the served Altman ladder uses). It used to print
  // the zone word "Safe" here while the document printed "Healthy" in the
  // same cell for the same state; the zones stay spelled in the benchmark.
  // `r.label` is the reader's label, which is the one label authority
  // (i18n "Altman Z″" — `altmanLabelOf` in financialValuation.ts), so the
  // Ratios sheet, the Credit & Risk sheet, the card and the tab print one
  // name.
  return [
    "Bankruptcy",
    r.label,
    ...sixCells(ALTMAN_RATIO_KEY, r.label, fixedCell(r.value, 2), ratioBadgeLabel(r)),
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

// ── ONE NAME FOR THE COMPANY'S PROFIT, AND ONE FIGURE BEHIND IT ───────
//
// Account 121's closing balance is the statutory net profit (CLAUDE.md
// Appendix A §3), served as `assembled_pl.net_income_statutory`. Every
// sheet reads it through `printedPl` (the same row the document ends on);
// the helpers that used to read it here a fourth time are retired.

/** A cover cell for a printed P&L row: the figure, or the refusal with
 *  the engine's reason — never a zero and never a bare dash. */
function printedCell(r: PrintedPlRow | null): string | number {
  if (!r) return EXPORT_UNREPORTED;
  if (r.value === null) return r.refusal ? `refused — ${r.refusal.text.en}` : EXPORT_UNREPORTED;
  return r.value;
}

/** Where the workbook's label for a concept differs from the document's
 *  (the pairing `threeWayParity` holds, one concept, two spellings). */
const SHEET_LABEL: Readonly<Record<string, string>> = {
  gross_profit: "Gross profit",
  other_operating_income: "Other operating income",
  other_financial_expense: "Financial expense",
  pretax: "Profit before tax",
  // The same string as NET_INCOME_LABEL below (declared after this map).
  net_income: "Net income (account 121, as filed)",
};

/** What every sheet calls the filed figure, so no sheet can call it
 *  something else. The document's own row label, word for word. */
const NET_INCOME_LABEL = "Net income (account 121, as filed)";

/** THE HEADER CELLS NAME THE FILE BEHIND EACH COLUMN, as a cell note —
 *  the workbook's `title`, the same line the dashboard's compare headers
 *  and the report's column headers carry (`comparatives.sourceDocumentLine`).
 *  B1 is the current period's column, C1 the prior's; a sheet built
 *  without a served filename gets no note, never an invented one. */
function noteSourceFiles(
  ws: XLSX.WorkSheet,
  current: string | null | undefined,
  prior: string | null | undefined,
): void {
  const note = (addr: string, file: string | null | undefined): void => {
    const cell = ws[addr] as XLSX.CellObject | undefined;
    const name = typeof file === "string" ? file.trim() : "";
    if (!cell || !name) return;
    cell.c = [{ a: "CFO AI", t: `Source file: ${name}` }];
  };
  note("B1", current);
  note("C1", prior);
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
  // AN ABSENT PRIOR PERIOD IS SAID, NOT DASHED. This used to write "—"
  // into the prior column and leave both delta cells EMPTY, under a
  // column header that was itself "—" (`s.prior?.periodLabel ?? "—"`).
  // In a spreadsheet an empty delta cell and a zero delta cell read the
  // same at a glance, and "—" beside a figure reads as "no change" at
  // least as often as "no data". Every book the private path serves is
  // in exactly this state — nothing populates `statements.prior` for a
  // trial-balance upload — so this is the cell the owner actually sees.
  if (prior === undefined || prior === null) {
    return [label, current, NO_COMPARATIVE_CELL, NO_COMPARATIVE_CELL, NO_COMPARATIVE_CELL];
  }
  const delta = current - prior;
  // A percentage change from zero is undefined — not 0, not 100%. The
  // absolute delta still carries the whole move, so the row is not
  // silent about it.
  return [
    label,
    current,
    prior,
    delta,
    prior !== 0 ? `${((delta / Math.abs(prior)) * 100).toFixed(1)}%` : "no % — prior is zero",
  ];
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
