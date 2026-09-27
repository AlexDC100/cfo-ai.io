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
// CANNOT SEE: whether the engine was right to refuse (net-711-rule);
// surfaces that do not print EBITDA; pixels.
import { describe, expect, it } from "vitest";
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
import { computeCreditScore, multiPeriodGrowth, runDcf } from "@/lib/financialValuation";
import { buildNavCascade } from "@/lib/buildNavCascade";
import { formulaInputRefusal, resolveFormulaInput } from "@/lib/resolveFormulaInput";
import { absenceSentence } from "@/components/cfo/ratioAbsenceI18n";
import type { ApiLineItem } from "@/lib/plStructure";

import { cardNamed, plRows } from "./exportBooks";
import { constructedBook, pairedWithItself, refusedBooks, servedRefusal, type SurfaceBook } from "./oneEbitdaSurfaceBooks";

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
  it("covers the two refused books, and on both the buckets would rebuild a number", () => {
    expect(BOOKS.map((b) => b.name)).toEqual(["g6_uncleared", "unanchored"]);
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

  it("a payload the engine did not assemble, whose buckets show 711 activity, refuses the same way", () => {
    const b = constructedBook("closed_bridge");
    const payload = { ...b.statements, assembled_pl: undefined };
    const t = deriveTotals(payload);
    expect([t.ebitda, t.ebit, t.pbt, t.grossProfit]).toEqual([null, null, null, null]);
    expect(t.plRefusal).toEqual(STOCK_VARIATION_NOT_MEASURED);
  });
});
