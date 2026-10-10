// GATE turnover-denominator (design A8) — EVERY MARGIN AND EVERY GROWTH
// FIGURE DIVIDES NET TURNOVER.
//
// OWNER RULING (2026-09-26): "margins and growth use net turnover (701–708
// minus 709) as the denominator, per the Romanian statutory P&L". 711 and
// 72x are inside EBITDA, outside turnover.
//
// INCIDENT. The report's §1 tile and canonicalMetrics divided EBITDA by
// `total_operating_revenue` (turnover + other operating income + 72x), the
// dashboard's first tile and the chat context were called "operating
// revenue" and fed the same total, the recommendation facts' `revenue`
// was `total_operating_revenue`, the learning resolver divided whatever
// the snapshot called revenue, and the report and workbook headed the
// P&L "Revenue" / "Operating revenue" over a figure that added 722. A book
// with 72x or material other income then printed two EBITDA margins.
//
// LAW. On every served book whose margins the engine does not refuse, each
// surface's EBITDA margin is served EBITDA ÷ served `assembled_pl.turnover`
// (and gross margin gross profit ÷ turnover); the first P&L line / KPI
// tile / chat "revenue" / facts `revenue` / growth row IS turnover. The
// witnesses are the books where total operating revenue ≠ turnover
// (72x on `bridge_with_722`, other operating income on the firm books), so
// a surface dividing the total differs by more than a rounding.
//
// REDS ON (TC-11): any margin or growth denominator re-pointed to total
// operating revenue (or any figure other than net turnover), on any
// surface below; a first line that is not turnover.
// CANNOT SEE: whether turnover itself is read right (engine); a margin the
// engine refuses (refusal-carries / margin-meaning); pixels.
import { describe, expect, it, vi } from "vitest";

// Each case renders the printed report and the workbook: slow under a
// loaded full-suite run (5 s default timed out once), never slow alone.
vi.setConfig({ testTimeout: 60_000 });
import * as XLSX from "xlsx";

import { computeRatios, type Ratio } from "@/lib/financialReport";
import { plLevelsOf } from "@/lib/servedOneEbitda";
import { buildCanonicalMetricsFromInputs } from "@/lib/canonicalMetrics";
import { canonicalMarginsFrom, computeDashboardHeadline } from "@/lib/dashboardHeadline";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { resolveConceptValue } from "@/lib/dashboard/resolveConceptValue";
import { buildPeriodFacts } from "@/lib/periodFacts";
import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import { multiPeriodGrowth } from "@/lib/financialValuation";
import { workspaceBenchMetrics } from "@/components/public-companies/pciData";
import { marginRefusalOf } from "@/lib/marginMeaning";
import type { ApiLineItem } from "@/lib/plStructure";

import { cardNamed, parsePrinted } from "./exportBooks";
import { metricRows, num, pairedWithItself, servedBooks, type SurfaceBook } from "./oneEbitdaSurfaceBooks";

/** Served books whose margins the engine does not refuse. */
const BOOKS = servedBooks().filter((b) => marginRefusalOf(b.statements) === null);

const ratioNamed = (b: SurfaceBook, key: string): Ratio | undefined => {
  // No engine metric map: the surface's OWN division is the one printed.
  const r = computeRatios(b.statements);
  return [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency].flat().find((x) => x.key === key);
};

function sheetCell(wb: XLSX.WorkBook, sheet: string, label: string): unknown {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1 });
  const hit = rows.find((r) => String((r as unknown[])[0] ?? "") === label);
  return hit ? (hit as unknown[])[1] : undefined;
}

describe("turnover-denominator — the witnesses exist", () => {
  it("four books carry total operating revenue ≠ net turnover (72x or other operating income), so a wrong denominator shows", () => {
    expect(BOOKS.map((b) => b.name).sort()).toEqual(
      ["agras", "bridge_with_722", "carniprod", "closed_bridge", "closed_no_activity", "open", "retail"],
    );
    const witnesses = BOOKS.filter(
      (b) => Math.abs(num(b.apl.total_operating_revenue) - num(b.apl.turnover)) > 1000,
    ).map((b) => b.name);
    expect(witnesses.sort()).toEqual(["agras", "bridge_with_722", "carniprod", "retail"]);
  });
});

describe("turnover-denominator — every margin and every growth figure divides net turnover", () => {
  for (const b of BOOKS) {
    it(`${b.name}: the first line, the margins, the facts, the report, the workbook and growth`, () => {
      const T = num(b.apl.turnover);
      const E = num(b.apl.ebitda);
      const GP = num(b.apl.gross_profit);
      const failures: string[] = [];
      const near = (where: string, v: unknown, want: number, tol: number) => {
        if (typeof v !== "number" || Math.abs(v - want) > tol) failures.push(`${where}: ${String(v)}, want ${want}`);
      };
      // The first line IS turnover.
      near("plLevelsOf.turnover", plLevelsOf(b.statements).turnover, T, 0.005);
      const rows = metricRows(b.metrics);
      const headline = computeDashboardHeadline({
        statements: b.statements, lineItems: b.lineItems, metrics: rows, entity: "E",
        canonicalMargins: canonicalMarginsFrom(rows),
      });
      near("dashboard headline netTurnover", headline.netTurnover, T, 0.005);
      const canon = buildCanonicalMetricsFromInputs({
        assembled_pl: b.statements.assembled_pl as Record<string, number>,
        line_items: b.lineItems, period_id: `p-${b.name}`,
      })!;
      near("canonicalMetrics.headline.revenue", canon.headline.revenue, T, 0.005);
      // Margins — EBITDA ÷ turnover, never ÷ total operating revenue.
      near("canonicalMetrics reported margin", canon.ebitda.reported_margin_pct, (E / T) * 100, 1e-6);
      near("computeRatios EBITDA margin", ratioNamed(b, "ebitda_margin")?.value, (E / T) * 100, 1e-6);
      near("computeRatios gross margin", ratioNamed(b, "gross_margin")?.value, (GP / T) * 100, 1e-6);
      const snap = buildReportingMetricsSnapshot(b.statements);
      near("learning snapshot revenue", snap.revenue, T, 0.005);
      near("configurable-dashboard EBITDA margin", resolveConceptValue("ebitda_margin", snap).value, E / T, 1e-9);
      near("'Compania ta' overlay EBITDA margin", workspaceBenchMetrics(b.statements)?.ebitda_margin_pct, (E / T) * 100, 1e-6);
      const facts = buildPeriodFacts({
        periodId: `p-${b.name}`, statements: b.statements,
        lineItems: b.lineItems as unknown as ApiLineItem[], valuation: null, industry: null,
      });
      near("recommendation facts revenue", facts.pl.revenue, T, 0.005);
      near("recommendation facts EBITDA margin", facts.ratios.ebitda_margin_gross, E / T, 1e-9);
      // The printed report's first KPI card and the workbook's first line.
      const doc = new DOMParser().parseFromString(buildReportHtml(b.statements, { metricsByName: b.metrics }), "text/html");
      near("report 'Net turnover' card", parsePrinted(cardNamed(doc, "Net turnover").value), T, 0.5 + 0.005);
      const wb = buildExcelWorkbook(b.statements, undefined, { metricsByName: b.metrics });
      near("workbook cover net turnover", sheetCell(wb, "Cover", "Net turnover (70x − 709 + 7411)"), T, 0.005);
      near("workbook P&L net turnover", sheetCell(wb, "P&L", "Net turnover (70x − 709 + 7411)"), T, 0.005);
      // Growth is over net turnover.
      const g = multiPeriodGrowth(pairedWithItself(b)).find((r) => r.metric === "Net turnover");
      expect(g, `${b.name}: no net-turnover growth row`).toBeTruthy();
      for (const c of g!.values) near(`growth ${c.period}`, c.value, T, 0.005);
      expect(failures).toEqual([]);
    });
  }
});
