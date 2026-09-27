// GATE refusal-carries (design A8) — A REFUSED 711 REFUSES EBITDA, EBIT AND
// EVERY MARGIN AND RATIO BUILT ON THEM, ON EVERY SURFACE, WITH THE ENGINE'S
// REASON. Never 0, never another definition, never a bare dash.
//
// OWNER RULING (2026-09-26) + design A3: "if net 711 is refused on a book
// with 711 activity, EBITDA, EBIT, gross profit and every margin/ratio built
// on them REFUSE with the same typed reason. Remove every fallback chain
// first (`?? ebitda ?? 0`, …)".
//
// INCIDENT. Before stage F2 the fallbacks that turned a refusal into a
// number were: `canonicalMetrics` (`ebitda_statutory ?? ebitda ?? 0` → the
// report §1 tile and the EBITDA-multiple card priced the company on 0),
// `deriveTotals` (the bucket build-up standing in for the refused figure on
// the workbook, the printed P&L, the learning popovers and the no-envelope
// credit model), `computeRatios`' `anchored()` falling through to the
// browser's EBITDA, the budget variance's `revenue − cogs` gross profit,
// the Comprehensive Report valuation's `?? metrics.ebitda`, the NAV
// cascade's `ebitda_statutory ?? 0` EV/EBITDA, and the no-envelope credit
// model's `safeDiv(x, null) = 0` read as "Below covenant".
//
// LAW. On the two refused CONSTRUCTED books (account 121 absent; its
// opening not cleared — both captured through the real route): every
// surface below states EBITDA as absent, and wherever a reason is printed
// it is the engine's (`ebitda_refusal.code` / `text_en` / `text_ro`).
//
// REDS ON (TC-11): a refused EBITDA / EBIT / gross profit / PBT / EBITDA
// margin / Debt-EBITDA / coverage / DSCR / EV-EBITDA / NOI turning into a
// number anywhere below, or its printed refusal losing the engine's reason.
// On the book with NO account 121 the NET RESULT is refused too (the
// build-up lacks the refused 711): the dashboard tile (even over a stale
// metric row), the canonical net profit, ROE / ROA / net margin, the
// printed net income row and the cash-flow statement carry the reason; with
// account 121 the filed figure stands (fixer round 1, 2026-09-27).
// TOTAL EQUITY SHORT BY THE REFUSED RESULT (critic fixer round 1, round 3
// here): on `unanchored_unbalanced` — the export with account 121 dropped,
// so the sheet does not balance without the year's result — the engine
// serves a completeness refusal beside total equity; the NAV cascade
// refuses Book NAV, Layers 1-3 and the hero, the engine Altman reader
// prints X2 refused, and the equity ratio and debt / equity refuse, all
// with the engine's reason. `unanchored` (rebuilt to balance) keeps them.
// EVERY OTHER READER OF TOTAL EQUITY (critic round 2, round 4 here): the
// report's §1 equity-ratio KPI ("Equity ratio 47.6 %") and §6 "Book equity
// (NAV floor) 200,000" under "stands alone", canonicalMetrics'
// `total_equity ?? 0`, the dashboard resolver and its cards, periodFacts'
// `mOr` falling back to the rows' sum, the Capsule fact index's derived
// equity ratio and the chat context all refuse with the engine's reason on
// `unanchored_unbalanced`, and keep their figures on `unanchored`.
// CANNOT SEE: whether the engine was right to refuse (net-711-rule);
// surfaces that do not print EBITDA; pixels.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";

// Each case renders the printed report and the workbook: slow under a
// loaded full-suite run (5 s default timed out once), never slow alone.
vi.setConfig({ testTimeout: 60_000 });
// The Comprehensive Report (round 2) resolves its period through auth and
// Supabase; the report tests of this repo stub those three the same way
// (comprehensiveReportAbsent / oneConceptOneValue). No other case here
// reaches them.
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
const stableToast = { toast: () => undefined };
vi.mock("@/hooks/use-toast", () => ({ useToast: () => stableToast }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: "p-report", status: "resolved" }),
}));
import * as XLSX from "xlsx";

import { deriveTotals, computeRatios, describeAbsence, type Ratio } from "@/lib/financialReport";
import { plLevelsOf, STOCK_VARIATION_NOT_MEASURED } from "@/lib/servedOneEbitda";
import { buildCanonicalMetricsFromInputs } from "@/lib/canonicalMetrics";
import { canonicalMarginsFrom, computeDashboardHeadline } from "@/lib/dashboardHeadline";
import { buildDashboardCanonical } from "@/lib/comparison/dashboardCanon";
import { buildActualLines } from "@/lib/comparison/buildVariance";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { resolveConceptValue } from "@/lib/dashboard/resolveConceptValue";
import { buildPeriodFacts } from "@/lib/periodFacts";
import { printedPl, printedRow } from "@/lib/printedPl";
import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import {
  computeCreditScore, multiPeriodGrowth, runDcf, PIOTROSKI_NO_CHECK_EVALUATED,
  type CreditEnvelope, type PiotroskiEnvelope,
} from "@/lib/financialValuation";
import { buildNavCascade } from "@/lib/buildNavCascade";
import { buildCashFlowStatement } from "@/lib/buildCashFlowStatement";
import { formulaInputRefusal, resolveFormulaInput } from "@/lib/resolveFormulaInput";
import { absenceSentence } from "@/components/cfo/ratioAbsenceI18n";
import type { ApiLineItem } from "@/lib/plStructure";
import type { Statements } from "@/lib/financialReport";
import type { ComparativesResponse } from "@/lib/comparatives";
import { renderWithProviders } from "@/test/renderWithProviders";
import { NavValuationView } from "@/components/cfo/NavValuationView";
import { CreditScoreCard, creditCardData } from "@/components/cfo/CreditScoreCard";
import { CashFlowStatementView } from "@/components/cfo/CashFlowStatementView";
import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import { RisksPanel } from "@/pages/cfo/FinancialStatements";
import ComprehensiveReport from "@/pages/cfo/ComprehensiveReport";
import { buildWorkspaceSnapshot } from "@/pages/cfo/Chat";
import { metricCardRefusal } from "@/components/dashboard/MetricCard";
import { buildFactIndex } from "@/lib/capsuleFactIndex";
import pairJson from "./fixtures/comparatives/pair_served.json";

import { cardNamed, plRows } from "./exportBooks";
import {
  constructedBook, constructedCredit, pairedWithItself, refusedBooks, servedRefusal, type SurfaceBook,
} from "./oneEbitdaSurfaceBooks";

const BOOKS = refusedBooks();

const ratioNamed = (b: SurfaceBook, key: string): Ratio | undefined => {
  const r = computeRatios(b.statements);
  return [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency].flat().find((x) => x.key === key);
};

function sheetCell(wb: XLSX.WorkBook, sheet: string, label: string): unknown {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1 });
  const hit = rows.find((r) => String((r as unknown[])[0] ?? "") === label);
  return hit ? (hit as unknown[])[1] : undefined;
}

describe("refusal-carries — the witnesses exist", () => {
  it("covers the three refused books, and on each the buckets would rebuild a number", () => {
    expect(BOOKS.map((b) => b.name)).toEqual(["g6_uncleared", "unanchored", "unanchored_unbalanced"]);
    for (const b of BOOKS) {
      expect(b.apl.ebitda, `${b.name}: the engine did not refuse`).toBeNull();
      // Non-vacuity: a surface that fell back to the buckets would print this.
      expect(typeof b.apl.ebitda_before_stock_variation).toBe("number");
      expect(servedRefusal(b).code).toBeTruthy();
    }
  });
});

describe("refusal-carries — a refused EBITDA stays refused on every surface", () => {
  for (const b of BOOKS) {
    const r = servedRefusal(b);

    it(`${b.name}: the levels, deriveTotals, the headline, the canon, the variance and the facts`, () => {
      const lv = plLevelsOf(b.statements);
      expect([lv.ebitda, lv.ebit, lv.pbt, lv.grossProfit]).toEqual([null, null, null, null]);
      expect(lv.refusal?.code).toBe(r.code);
      const t = deriveTotals(b.statements);
      expect([t.ebitda, t.ebit, t.pbt, t.grossProfit, t.netIncome]).toEqual([null, null, null, null, null]);
      expect(t.plRefusal?.code).toBe(r.code);
      const canon = buildCanonicalMetricsFromInputs({
        assembled_pl: b.statements.assembled_pl as Record<string, number>,
        line_items: b.lineItems, period_id: `p-${b.name}`,
      })!;
      expect([canon.ebitda.reported, canon.ebitda.core, canon.headline.ebit]).toEqual([null, null, null]);
      expect([canon.ebitda.reported_margin_pct, canon.ebitda.core_margin_pct]).toEqual([null, null]);
      expect(canon.ebitda.refusal?.code).toBe(r.code);
      const headline = computeDashboardHeadline({
        statements: b.statements, lineItems: b.lineItems, metrics: [], entity: "E",
        canonicalMargins: canonicalMarginsFrom([]),
      });
      expect(headline.tileEbitdaRon).toBeNull();
      expect(headline.tileEbitdaRefusal?.code).toBe(r.code);
      const dc = buildDashboardCanonical(b.statements, b.lineItems, []);
      expect([dc.ebitda, dc.grossProfit]).toEqual([null, null]);
      expect(dc.ebitdaRefusal?.code).toBe(r.code);
      const actual = buildActualLines(buildReportingMetricsSnapshot(b.statements), dc);
      expect([actual.gross_profit, actual.ebitda, actual.ebit]).toEqual([null, null, null]);
      const facts = buildPeriodFacts({
        periodId: `p-${b.name}`, statements: b.statements,
        lineItems: b.lineItems as unknown as ApiLineItem[], valuation: null, industry: null,
      });
      expect([facts.pl.ebitda, facts.pl.ebit, facts.pl.profit_before_tax]).toEqual([null, null, null]);
      expect([facts.ratios.ebitda_margin_gross, facts.ratios.debt_to_ebitda]).toEqual([null, null]);
    });

    it(`${b.name}: the ratios, the learning resolver and the ratio drawer state the engine's reason`, () => {
      for (const key of ["ebitda_margin", "gross_margin", "debt_to_ebitda"]) {
        const row = ratioNamed(b, key);
        expect(row?.value, `${key} printed a number`).toBeNull();
        expect(row?.unavailable?.kind, `${key} is not refused with the engine's reason`).toBe("refused");
        expect(describeAbsence(row!.unavailable!)).toContain(r.text_en);
        const t = (k: string) => k;
        expect(absenceSentence(t, row!.unavailable!, "ro")).toContain(r.text_ro);
      }
      const snap = buildReportingMetricsSnapshot(b.statements);
      expect([snap.ebitda, snap.ebit, snap.grossProfit]).toEqual([undefined, undefined, undefined]);
      for (const c of ["ebitda", "ebit", "ebitda_margin", "ebit_margin", "gross_profit", "net_debt_ebitda"]) {
        expect(resolveConceptValue(c, snap).value, `resolver ${c}`).toBeNull();
      }
      expect(resolveFormulaInput("ebitda", b.statements)).toBeNull();
      expect(formulaInputRefusal("ebitda", b.statements)?.code).toBe(r.code);
    });

    it(`${b.name}: the printed report and the workbook print "refused" with the engine's reason`, () => {
      const pp = printedPl(b.statements);
      for (const key of ["gross_profit", "ebitda", "ebit", "pretax"]) {
        const row = printedRow(pp, key);
        expect(row?.value, `printed row ${key}`).toBeNull();
        expect(row?.refusal?.code).toBe(r.code);
      }
      const doc = new DOMParser().parseFromString(buildReportHtml(b.statements, {}), "text/html");
      for (const label of ["Gross Profit", "EBITDA", "EBIT", "Profit Before Tax"]) {
        const row = plRows(doc).find((x) => x.label === label);
        expect(row?.printed, `report row ${label}`).toBe(`refused — ${r.text_en}`);
      }
      expect(cardNamed(doc, "EBITDA").value).toBe("refused");
      expect(cardNamed(doc, "EBITDA").meta).toContain(r.text_en);
      const wb = buildExcelWorkbook(b.statements);
      expect(sheetCell(wb, "P&L", "EBITDA")).toBe(`refused — ${r.text_en}`);
      expect(sheetCell(wb, "Cover", "EBITDA")).toBe(`refused — ${r.text_en}`);
      expect(sheetCell(wb, "Cover", "EBIT")).toBe(`refused — ${r.text_en}`);
    });

    it(`${b.name}: growth, the credit model, the DCF and the NAV cascade refuse with it`, () => {
      const g = multiPeriodGrowth(pairedWithItself(b)).find((x) => x.metric === "EBITDA")!;
      for (const c of g.values) {
        expect(c.value, `growth ${c.period}`).toBeNull();
        expect(c.refusal?.code).toBe(r.code);
      }
      expect(g.cagr).toBeNull();
      const credit = computeCreditScore(b.statements);
      for (const label of ["Debt / EBITDA", "Interest coverage (EBIT / interest)", "~DSCR (EBITDA / est. debt service)"]) {
        const row = credit.components.find((c) => c.label === label)!;
        expect(row.value, label).toBeNull();
        expect(row.subscore, label).toBeNull();
        expect(row.refusal?.code, label).toBe(r.code);
        expect(row.refusal?.sentence, label).toContain(r.text_en);
      }
      expect(credit.score).toBeNull();
      expect(credit.rating).toBeNull();
      expect(runDcf(b.statements).evToEbitda).toBeNull();
      const nav = buildNavCascade({
        pl: b.statements.assembled_pl as Record<string, number>,
        bs: b.statements.assembled_bs as Record<string, number>,
        lineItems: [],
      });
      expect(nav.crossMethods.evEbitda).toBeNull();
      expect(nav.crossMethods.capRate).toBeNull();
    });
  }

  // THE NET RESULT (fixer round 1, 2026-09-27). With account 121 the filed
  // figure stands whatever 711 is (g6_uncleared). WITHOUT it (unanchored)
  // the net result is the class-6/7 build-up, which lacks the refused 711 —
  // the developer with its 121 rows dropped printed -30,391,418.38 on the
  // dashboard tile, ROE -75.4 % and ROA -36.4 % where 121 holds -801,604.14.
  // The engine refuses it; every surface states the refusal — never a
  // stale metric row, the builder's figure, or a 0.
  it("unanchored: the net result, ROE, ROA, the report and the cash flow refuse with the engine's reason", () => {
    const b = BOOKS.find((x) => x.name === "unanchored")!;
    const r = servedRefusal(b);
    expect((b.apl.net_income_refusal as { code?: string } | undefined)?.code).toBe(r.code);
    // A stored metric row written before the refusal existed must not stand in.
    const stale = [{ name: "net_income_statutory", value: 120000 }] as unknown as Parameters<
      typeof computeDashboardHeadline>[0]["metrics"];
    const headline = computeDashboardHeadline({
      statements: b.statements, lineItems: b.lineItems, metrics: stale, entity: "E",
      canonicalMargins: canonicalMarginsFrom([]),
    });
    expect(Number.isNaN(headline.tileNetProfitRon), `tile printed ${headline.tileNetProfitRon}`).toBe(true);
    expect(headline.tileNetProfitRefusal?.code).toBe(r.code);
    const canon = buildCanonicalMetricsFromInputs({
      assembled_pl: b.statements.assembled_pl as Record<string, number>,
      line_items: b.lineItems, period_id: `p-${b.name}`,
    })!;
    expect([canon.netProfit.statutory_account_121, canon.netProfit.reconstructed,
      canon.netProfit.reconciliation_gap]).toEqual([null, null, null]);
    expect(canon.netProfit.refusal?.code).toBe(r.code);
    for (const key of ["net_margin", "roe", "roa"]) {
      const row = ratioNamed(b, key);
      expect(row?.value, `${key} printed a number`).toBeNull();
      expect(row?.unavailable?.kind, `${key} is not refused`).toBe("refused");
    }
    const ni = printedRow(printedPl(b.statements), "net_income");
    expect(ni?.value).toBeNull();
    expect(ni?.refusal?.code).toBe(r.code);
    const cf = buildCashFlowStatement({
      pl: b.statements.assembled_pl as Record<string, number>,
      bs: b.statements.assembled_bs as Record<string, number>,
      cf: (b.statements as { assembled_cf?: Record<string, number> }).assembled_cf,
      entity: "E", period: "P",
    });
    expect(cf.refusal?.code).toBe(r.code);
    // THE BUILDER ITSELF RETURNS NO FIGURE for a refused statement (critic,
    // fixer round 1 of 2026-09-27): only the two views guarded it; a future
    // view reading `.operating.netProfit` would have printed 0.
    expect([cf.operating, cf.investing, cf.financing, cf.reconciliation]).toEqual(
      [undefined, undefined, undefined, undefined]);
    expect(JSON.stringify(cf)).not.toMatch(/netProfit|cashFromOperating|closingCash/);
  });

  it("g6_uncleared: WITH account 121 the filed net result stands, though 711 is refused", () => {
    const b = BOOKS.find((x) => x.name === "g6_uncleared")!;
    expect(b.apl.net_income_refusal).toBeUndefined();
    const headline = computeDashboardHeadline({
      statements: b.statements, lineItems: b.lineItems, metrics: [], entity: "E",
      canonicalMargins: canonicalMarginsFrom([]),
    });
    expect(headline.tileNetProfitRon).toBe(b.apl.net_income_statutory);
    expect(headline.tileNetProfitRefusal).toBeNull();
  });

  it("a payload the engine did not assemble, whose buckets show 711 activity, refuses the same way", () => {
    const b = constructedBook("closed_bridge");
    const payload = { ...b.statements, assembled_pl: undefined };
    const t = deriveTotals(payload);
    expect([t.ebitda, t.ebit, t.pbt, t.grossProfit]).toEqual([null, null, null, null]);
    expect(t.plRefusal).toEqual(STOCK_VARIATION_NOT_MEASURED);
  });
});

// ── FIXER ROUND 2 (2026-09-27) ────────────────────────────────────────────
// Round 1 refused the net result on a book with no account 121 and a
// refused 711. Four surfaces still turned that refusal into a figure:
//   · the NAV cascade's Graham row read `net_income_statutory ?? 0` —
//     "Graham intrinsic value 0" and a convergence band starting at 0 on
//     the developer (NavValuationView);
//   · Piotroski: the engine served `score: 0` with nine uncertain checks and
//     `score ?? passCount` banded it "Distressed (0–2)" — the Risks tab
//     printed "0 / 0 confirmed · Distressed (0–2)";
//   · the report's balance sheet printed the build-up as "Current-year P&L"
//     (the engine closed it into equity);
//   · a comparative cash flow whose PRIOR period is refused printed that
//     statement's net profit 0 and the CFO / CFF / net change built on it.
// REDS ON: any of those printing a figure (a 0 above all) or a band for the
// refused book, or losing the engine's reason. The book WITH account 121
// (g6_uncleared) keeps every one of them — asserted beside it.
describe("refusal-carries — round 2: Graham, Piotroski, the report's balance sheet, a refused prior cash flow", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const U = () => BOOKS.find((x) => x.name === "unanchored")!;
  const G6 = () => BOOKS.find((x) => x.name === "g6_uncleared")!;
  const navOf = (b: SurfaceBook) => buildNavCascade({
    pl: b.statements.assembled_pl as Record<string, number>,
    bs: b.statements.assembled_bs as Record<string, number>,
    lineItems: [],
  });

  it("unanchored: the NAV cascade has no Graham figure and no band built on it — the page prints the reason", () => {
    const b = U();
    const r = servedRefusal(b);
    const nav = navOf(b);
    expect(nav.crossMethods.graham, "Graham on a refused net result").toBeNull();
    expect(nav.crossMethods.grahamRefusal?.code).toBe(r.code);
    expect(nav.crossMethods.convergentMethods).toEqual(["nnnav"]);
    expect(nav.crossMethods.convergenceBand, "a band with one method (or a refused one)").toBeNull();
    expect(nav.crossMethods.convergenceConfidence).toBeNull();
    renderWithProviders(<NavValuationView cascade={nav} entity="E" period="P" currency="RON" />);
    expect(screen.getByTestId("nav-graham").textContent).toBe(`refused — ${r.text_en}`);
    expect(screen.getByTestId("nav-convergence-band").textContent).toMatch(/^not computed/);
  });

  it("g6_uncleared: WITH account 121 Graham computes and bounds the band", () => {
    const b = G6();
    const nav = navOf(b);
    expect(typeof nav.crossMethods.graham).toBe("number");
    expect(nav.crossMethods.grahamRefusal).toBeNull();
    expect(nav.crossMethods.convergentMethods).toContain("graham");
    expect(nav.crossMethods.convergenceBand).not.toBeNull();
  });

  it("unanchored: no Piotroski score or band off nine uncertain checks — served, or a block stored before the engine refused it", () => {
    const b = U();
    const r = servedRefusal(b);
    const served = (b.statements as { assembled_piotroski?: PiotroskiEnvelope }).assembled_piotroski!;
    expect(served.score, "the engine served a score").toBeNull();
    expect(served.refusal?.code).toBe(r.code);
    // A block persisted before the engine refused the score: score 0, no
    // reason, nine uncertain checks — still no verdict off nothing.
    const stale: PiotroskiEnvelope = { ...served, score: 0, refusal: undefined };
    for (const [label, env, code] of [["served", served, r.code], ["stale", stale, PIOTROSKI_NO_CHECK_EVALUATED.code]] as const) {
      const p = computeCreditScore(b.statements, {} as CreditEnvelope, env)!.piotroski!;
      expect(p.score, `${label}: score`).toBeNull();
      expect(p.band, `${label}: band`).toBeNull();
      expect(p.refusal?.code, `${label}: reason`).toBe(code);
    }
    const { unmount } = renderWithProviders(
      <RisksPanel statements={b.statements} creditEnvelope={{} as CreditEnvelope} piotroskiEnvelope={served} />);
    expect(screen.getByTestId("piotroski-refused-reason").textContent).toContain(r.text_en);
    expect(document.body.textContent ?? "").not.toMatch(/Distressed|0 \/ 0/);
    // The per-check list stays under the refusal (critic, fixer round 1
    // of 2026-09-27): every check, each "?" with its own detail.
    const reader = computeCreditScore(b.statements, {} as CreditEnvelope, served)!.piotroski!;
    const rows = Array.from(screen.getByTestId("piotroski-refused-checks").querySelectorAll("tbody tr"));
    expect(rows.length, "the refused tile dropped its checks").toBe(reader.checks.length);
    expect(rows.length).toBe(9);
    rows.forEach((tr, i) => {
      const tds = Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim());
      expect(tds[0]).toBe(reader.checks[i].label);
      expect(tds[1], reader.checks[i].key).toBe("?");
      expect(tds[2]).toBe(reader.checks[i].detail);
      expect(tds[2].length, `${reader.checks[i].key}: no detail`).toBeGreaterThan(0);
    });
    unmount();
    renderWithProviders(
      <RisksPanel statements={b.statements} creditEnvelope={{} as CreditEnvelope} piotroskiEnvelope={stale} />);
    expect(screen.getByTestId("piotroski-refused-reason").textContent).toContain(PIOTROSKI_NO_CHECK_EVALUATED.text.en);
  });

  it("g6_uncleared: WITH account 121 the evaluated checks are scored and banded", () => {
    const b = G6();
    const env = (b.statements as { assembled_piotroski?: PiotroskiEnvelope }).assembled_piotroski!;
    const p = computeCreditScore(b.statements, {} as CreditEnvelope, env)!.piotroski!;
    expect(p.score).toBe(4);
    expect(p.band).toBe("Weak (3–5)");
    expect(p.refusal).toBeNull();
  });

  const reportBody = (b: SurfaceBook, statements: Statements) => ({
    period: { id: `p-${b.name}`, period_end: "2025-12-31", currency: "RON",
      source_document: { filename: `${b.name}.xlsx`, id: `d-${b.name}` } },
    statements, metrics: [], line_items: b.lineItems, alerts: [], recommendations: [],
  });
  const mountReportFor = async (b: SurfaceBook, statements: Statements) => {
    const body = reportBody(b, statements);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
    renderWithProviders(<ComprehensiveReport />, { route: `/report?period=p-${b.name}` });
    const root = await screen.findByTestId("comprehensive-report");
    const bs = root.querySelector('[data-testid="report-section-3-bs"]')!;
    return Array.from(bs.querySelectorAll("tr"))
      .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim()))
      .find((tds) => tds[0] === "Current-year P&L");
  };

  it("unanchored: the report's balance sheet prints the reason on the current-year row — served, or stored with the build-up", async () => {
    const b = U();
    const r = servedRefusal(b);
    expect((b.statements.assembled_bs as Record<string, unknown>).current_year_pnl, "the engine served a figure").toBeNull();
    const row = await mountReportFor(b, b.statements);
    expect(row?.[1]).toBe(`refused — ${r.text_en}`);
    cleanup();
    // A period stored before the engine stopped closing the build-up into
    // equity: its P&L refusal still refuses the row.
    const stale = JSON.parse(JSON.stringify(b.statements)) as Statements;
    const sbs = stale.assembled_bs as Record<string, unknown>;
    sbs.current_year_pnl = b.apl.net_income_operational;
    delete sbs.current_year_pnl_refusal;
    const staleRow = await mountReportFor(b, stale);
    expect(staleRow?.[1]).toBe(`refused — ${r.text_en}`);
  });

  it("g6_uncleared: WITH account 121 the report's current-year row prints the filed result", async () => {
    const b = G6();
    const row = await mountReportFor(b, b.statements);
    expect(row?.[1]).not.toMatch(/refused/);
    expect(row?.[1]).toMatch(/250/);
  });

  const cfOf = (b: SurfaceBook) => buildCashFlowStatement({
    pl: b.statements.assembled_pl as Record<string, number>,
    bs: b.statements.assembled_bs as Record<string, number>,
    cf: (b.statements as { assembled_cf?: Record<string, number> }).assembled_cf,
    entity: "E", period: b.name,
  });
  const renderCf = (current: SurfaceBook, prior: SurfaceBook) => renderWithProviders(
    <ComparativeProvider doc={(pairJson as unknown as { comparatives: ComparativesResponse }).comparatives}
      columns={{ prior: true, delta: true, deltaPct: false, share: false }} statement="PL" currency="RON">
      <CashFlowStatementView statement={cfOf(current)} prior={cfOf(prior)} hideGuide />
    </ComparativeProvider>);

  it("a comparative cash flow whose PRIOR period is refused prints no prior figure and no delta — the reason instead", () => {
    const prior = U();
    const r = servedRefusal(prior);
    expect(cfOf(prior).refusal?.code).toBe(r.code);
    const { container } = renderCf(constructedBook("closed_bridge"), prior);
    expect(container.querySelectorAll(".cmp-cell--prior").length, "a prior figure printed").toBe(0);
    expect(screen.getByTestId("cf-prior-refused").textContent).toContain(r.text_en);
    // Every compare row the view renders (Simple mode shows the key rows)
    // carries "refused" in BOTH the prior and the delta cell.
    const refusedCells = container.querySelectorAll("[data-cmp-refused]");
    const cmpRows = container.querySelectorAll('[data-cmp="cf"]');
    expect(cmpRows.length).toBeGreaterThan(0);
    expect(refusedCells.length).toBe(2 * cmpRows.length);
    for (const c of Array.from(refusedCells)) expect(c.getAttribute("title")).toContain(r.text_en);
  });

  it("…and a prior period that is NOT refused prints its column", () => {
    const { container } = renderCf(constructedBook("closed_bridge"), G6());
    expect(screen.queryByTestId("cf-prior-refused")).toBeNull();
    expect(container.querySelectorAll(".cmp-cell--prior").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-cmp-refused]").length).toBe(0);
  });
});

// ── ROUND 3 (critic fixer round 1, 2026-09-27): TOTAL EQUITY SHORT BY THE
// REFUSED RESULT ─────────────────────────────────────────────────────────
// `unanchored` was rebuilt to balance WITHOUT account 121, so its equity
// is complete and it could not see a surface reading the missing result as
// 0. `unanchored_unbalanced` is the export with the 121 row dropped (sheet
// short by 170,000.00). Measured before the fix: the NAV cascade printed
// Book NAV 200,000 (Layers 2-3 and the hero on it), the credit card X2
// 0.2381, the ratio card Equity Ratio 47.6 % — on equity missing the year.
// REDS ON: any of them printing a figure (or a bare dash) instead of the
// engine's reason; the balanced witness losing its figures (vacuity).
describe("refusal-carries — round 3: total equity short by the refused result", () => {
  afterEach(() => { cleanup(); });
  const UB = () => BOOKS.find((x) => x.name === "unanchored_unbalanced")!;
  const U = () => BOOKS.find((x) => x.name === "unanchored")!;
  const equityRefusalOf = (b: SurfaceBook) =>
    (b.statements.assembled_bs as Record<string, unknown>).total_equity_refusal as
      { code: string; text_en: string; text_ro: string } | undefined;
  const navOf = (b: SurfaceBook) => buildNavCascade({
    pl: b.statements.assembled_pl as Record<string, number>,
    bs: b.statements.assembled_bs as Record<string, number>,
    lineItems: [],
  });

  it("unanchored_unbalanced: the engine serves the completeness refusal beside total equity", () => {
    const b = UB();
    const r = servedRefusal(b);
    const er = equityRefusalOf(b)!;
    expect(er.code).toBe(r.code);
    expect(er.text_en).toContain(r.text_en);
    expect(typeof (b.statements.assembled_bs as Record<string, unknown>).total_equity).toBe("number");
    expect(equityRefusalOf(U()), "a sheet that balances has complete equity").toBeUndefined();
  });

  it("unanchored_unbalanced: Book NAV, Layers 1-3, the sensitivity grid and the hero refuse — the page prints the reason", () => {
    const b = UB();
    const er = equityRefusalOf(b)!;
    const nav = navOf(b);
    for (const layer of nav.layers) {
      expect(layer.value, `layer ${layer.layer}`).toBeNull();
      expect(layer.refusal?.code, `layer ${layer.layer}`).toBe(er.code);
    }
    expect(nav.bookNavRefusal?.text.en).toBe(er.text_en);
    expect(nav.sensitivityNnnav.every((c) => c.nnnav === null)).toBe(true);
    expect(nav.crossMethods.convergentMethods).not.toContain("nnnav");
    expect(nav.crossMethods.convergenceBand).toBeNull();
    renderWithProviders(<NavValuationView cascade={nav} entity="E" period="P" currency="RON" />);
    expect(screen.getByTestId("nav-hero-refused").textContent).toBe(`refused — ${er.text_en}`);
    for (const id of [1, 2, 3]) {
      expect(screen.getByTestId(`nav-layer-${id}-refused`).textContent).toContain(er.text_en);
    }
    expect(screen.getByTestId("nav-convergence-nnnav").textContent).toContain(er.text_en);
    expect(screen.getByTestId("nav-hero-refused-reason").textContent).toContain(er.text_en);
  });

  it("unanchored (sheet balances): Book NAV is the served total equity", () => {
    const b = U();
    const nav = navOf(b);
    expect(nav.layers[0].value).toBe((b.statements.assembled_bs as Record<string, number>).total_equity);
    expect(nav.bookNavRefusal).toBeNull();
    expect(nav.crossMethods.convergentMethods).toContain("nnnav");
  });

  it("unanchored_unbalanced: the engine Altman reader prints X2 refused, the equity sub-score refuses with the reason", () => {
    const b = UB();
    const r = servedRefusal(b);
    const credit = constructedCredit(b.name) as CreditEnvelope;
    const result = computeCreditScore(b.statements, credit);
    expect(result.altman.components.x2_re_to_assets, "X2 printed").toBeNull();
    expect(result.altman.componentRefusals?.x2?.code).toBe(r.code);
    expect(result.altman.componentRefusals?.x2?.text.en).toContain(r.text_en);
    const equity = result.components.find((c) => c.label.startsWith("Equity-ratio sub-score"))!;
    expect(equity.subscore).toBeNull();
    expect(equity.refusal?.sentence).toContain(r.text_en);
    const data = creditCardData(result)!;
    expect(data.altmanX2Refusal).toContain(r.text_en);
    renderWithProviders(<CreditScoreCard data={data} />);
    expect(screen.getByTestId("report-altman-x2").textContent).toContain(r.text_en);
  });

  it("unanchored (sheet balances): X2 is served by the engine reader", () => {
    const b = U();
    const result = computeCreditScore(b.statements, constructedCredit(b.name) as CreditEnvelope);
    expect(typeof result.altman.components.x2_re_to_assets).toBe("number");
    expect(result.altman.componentRefusals?.x2 ?? null).toBeNull();
  });

  it("unanchored_unbalanced: the equity ratio and debt / equity refuse with the engine's reason; balanced, they compute", () => {
    const b = UB();
    const er = equityRefusalOf(b)!;
    for (const key of ["equity_ratio", "debt_to_equity"]) {
      const row = ratioNamed(b, key);
      expect(row?.value, `${key} printed a number`).toBeNull();
      expect(row?.unavailable?.kind, key).toBe("refused");
      expect(describeAbsence(row!.unavailable!)).toContain(er.text_en);
      // A stored metric row written before the refusal must not stand in.
      const withStale = computeRatios(b.statements, undefined, { equity_ratio: 0.4762, debt_to_equity: 0 } as never);
      const stale = [withStale.liquidity, withStale.profitability, withStale.leverage, withStale.coverage,
        withStale.efficiency].flat().find((x) => x.key === key);
      expect(stale?.value, `${key} from a stale metric row`).toBeNull();
    }
    for (const key of ["equity_ratio", "debt_to_equity"]) {
      expect(typeof ratioNamed(U(), key)?.value, `${key} on the balanced book`).toBe("number");
    }
  });
});

// ── ROUND 4 (critic round 2, 2026-09-27): EVERY OTHER READER OF TOTAL
// EQUITY ───────────────────────────────────────────────────────────────
// Round 3 held computeRatios, the NAV cascade and the credit card; the
// report it already mounted still printed "Equity ratio 47.6 %" (§1, off
// `canonicalMetrics.balance.equity = total_equity ?? 0`) and "Book equity
// (NAV floor) 200,000" under "book equity (NAV floor) stands alone" (§6);
// periodFacts' `mOr` fell back to the rows' sum once the engine rows were
// refused (equity ratio 0.476, debt / equity 0), the dashboard resolver and
// the Capsule fact index derived the equity ratio, and the chat context
// handed the assistant "Total equity 200,000".
// REDS ON: any of them printing a figure (or a bare dash) instead of the
// engine's reason on `unanchored_unbalanced`; the balanced `unanchored`
// losing its figures (vacuity).
describe("refusal-carries — round 4: every reader of total equity", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const UB = () => BOOKS.find((x) => x.name === "unanchored_unbalanced")!;
  const U = () => BOOKS.find((x) => x.name === "unanchored")!;
  const erOf = (b: SurfaceBook) =>
    (b.statements.assembled_bs as Record<string, unknown>).total_equity_refusal as
      { code: string; text_en: string; text_ro: string } | undefined;
  const teOf = (b: SurfaceBook) => (b.statements.assembled_bs as Record<string, number>).total_equity;
  const canonOf = (b: SurfaceBook) => buildCanonicalMetricsFromInputs({
    assembled_pl: b.statements.assembled_pl as Record<string, number>,
    assembled_bs: b.statements.assembled_bs as Record<string, number>,
    line_items: b.lineItems, period_id: `p-${b.name}`,
  })!;
  const mountReport = async (b: SurfaceBook) => {
    const body = {
      period: { id: `p-${b.name}`, period_end: "2025-12-31", currency: "RON",
        source_document: { filename: `${b.name}.xlsx`, id: `d-${b.name}` } },
      statements: b.statements, metrics: [], line_items: b.lineItems, alerts: [], recommendations: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
    renderWithProviders(<ComprehensiveReport />, { route: `/report?period=p-${b.name}` });
    return screen.findByTestId("comprehensive-report");
  };
  const valuationRow = (root: HTMLElement) => Array.from(root.querySelectorAll("tr"))
    .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim()))
    .find((tds) => tds[0] === "Book equity (NAV floor)");

  it("unanchored_unbalanced: canonicalMetrics carries no total equity — the engine's refusal instead", () => {
    const er = erOf(UB())!;
    const c = canonOf(UB());
    expect(c.balance.equity, "canonical total equity").toBeNull();
    expect(c.balance.equity_refusal?.code).toBe(er.code);
    expect(c.balance.equity_refusal?.text.en).toBe(er.text_en);
    const cu = canonOf(U());
    expect(cu.balance.equity).toBe(teOf(U()));
    expect(cu.balance.equity_refusal).toBeNull();
  });

  it("unanchored_unbalanced: the report's §1 Equity ratio and §6 Book equity print the reason — never 47.6 % or 200,000", async () => {
    const b = UB();
    const er = erOf(b)!;
    const root = await mountReport(b);
    expect(screen.getByTestId("report-kpi-equity-ratio-refused").textContent).toBe(`refused — ${er.text_en}`);
    expect(root.textContent, "the §1 KPI printed the short equity ratio").not.toMatch(/47[.,]6\s*%/);
    expect(screen.getByTestId("report-valuation-book-equity-refused").textContent).toBe(`refused — ${er.text_en}`);
    expect(valuationRow(root)?.[2]).toBe(`refused — ${er.text_en}`);
    const banner = screen.getByTestId("report-valuation-ebitda-refused").textContent ?? "";
    expect(banner).not.toContain("stands alone");
    expect(banner).toContain(er.text_en);
  });

  it("unanchored (sheet balances): §1 prints the equity ratio and §6 the book equity", async () => {
    const b = U();
    const root = await mountReport(b);
    expect(screen.queryByTestId("report-kpi-equity-ratio-refused")).toBeNull();
    expect(screen.queryByTestId("report-valuation-book-equity-refused")).toBeNull();
    expect(valuationRow(root)?.[2]).toMatch(/200/);
    expect(screen.getByTestId("report-valuation-ebitda-refused").textContent).toContain("stands alone");
  });

  it("unanchored_unbalanced: periodFacts refuses total equity and every ratio on it — no `mOr` fallback, no stale row", () => {
    const b = UB();
    const er = erOf(b)!;
    const stale = { equity_ratio: 0.4762, debt_to_equity: 0, roe: 0.1 };
    for (const metricsByName of [undefined, stale]) {
      const facts = buildPeriodFacts({
        periodId: `p-${b.name}`, statements: b.statements,
        lineItems: b.lineItems as unknown as ApiLineItem[], valuation: null, industry: null,
        metricsByName,
      } as Parameters<typeof buildPeriodFacts>[0]);
      expect(facts.bs.total_equity, "periodFacts total equity").toBeNull();
      expect(facts.bs.total_equity_refusal?.code).toBe(er.code);
      expect([facts.ratios.equity_ratio, facts.ratios.debt_to_equity, facts.ratios.roe]).toEqual([null, null, null]);
    }
    const fu = buildPeriodFacts({
      periodId: `p-${U().name}`, statements: U().statements,
      lineItems: U().lineItems as unknown as ApiLineItem[], valuation: null, industry: null,
    });
    expect(fu.bs.total_equity).toBe(teOf(U()));
    expect(typeof fu.ratios.equity_ratio).toBe("number");
    expect(typeof fu.ratios.debt_to_equity).toBe("number");
  });

  it("unanchored_unbalanced: the dashboard resolver forms no equity ratio / debt to equity, and the card prints the reason", () => {
    const b = UB();
    const er = erOf(b)!;
    const snap = buildReportingMetricsSnapshot(b.statements);
    expect(snap.shareholdersEquity).toBeUndefined();
    const refusal = { code: er.code, text: { ro: er.text_ro, en: er.text_en } };
    for (const c of ["total_equity", "shareholders_equity", "equity_ratio", "debt_to_equity"]) {
      const v = resolveConceptValue(c, snap).value;
      expect(v, `resolver ${c}`).toBeNull();
      expect(metricCardRefusal(c, v, { equityRefusal: refusal })?.en ?? "(the card printed no refusal)", `card ${c}`)
        .toContain(er.text_en);
    }
    // The card states the refusal whatever the resolver was handed.
    expect(metricCardRefusal("equity_ratio", 0.4925, { equityRefusal: refusal })?.en ?? "(the card printed 0.4925)")
      .toContain(er.text_en);
    const su = buildReportingMetricsSnapshot(U().statements);
    for (const c of ["total_equity", "equity_ratio", "debt_to_equity"]) {
      expect(typeof resolveConceptValue(c, su).value, `resolver ${c} on the balanced book`).toBe("number");
    }
    expect(metricCardRefusal("equity_ratio", 0.8, { equityRefusal: null })).toBeNull();
  });

  it("unanchored_unbalanced: the Capsule fact index carries no equity and derives no equity ratio", () => {
    const factsOf = (b: SurfaceBook, metrics: Record<string, number | null> | null = null) => buildFactIndex({
      periods: [{ periodId: `p-${b.name}`, periodLabel: "December 2025", statements: b.statements, metrics }],
      activePeriodId: `p-${b.name}`,
    } as Parameters<typeof buildFactIndex>[0]).facts.map((f) => f.factKey);
    const refused = factsOf(UB());
    expect(refused).not.toContain("equity");
    expect(refused).not.toContain("equity_ratio");
    expect(factsOf(UB(), { equity_ratio: 0.4762 }), "a stale engine row").not.toContain("equity_ratio");
    const served = factsOf(U());
    expect(served).toContain("equity");
    expect(served).toContain("equity_ratio");
  });

  it("unanchored_unbalanced: the chat context states the refusal — never 'Total equity 200,000'", () => {
    const snap = (b: SurfaceBook) => buildWorkspaceSnapshot({
      id: `p-${b.name}`, label: "FY2025", statements: b.statements, lineItems: b.lineItems,
      metrics: [], industry: null, briefing: null, recommendations: [], alerts: [], source: "upload",
    } as unknown as Parameters<typeof buildWorkspaceSnapshot>[0]) ?? "";
    const er = erOf(UB())!;
    const text = snap(UB());
    expect(text).toContain(`Total equity: REFUSED — ${er.text_en}`);
    expect(text).not.toMatch(/Total equity: 200/);
    expect(snap(U())).toMatch(/Total equity: 200/);
  });
});
