// GATE one-ebitda (design A8) — EVERY FRONTEND SURFACE PRINTS THE ONE EBITDA.
//
// OWNER RULING (2026-09-26): account 711 ("Variația stocurilor de produse")
// and 72x are inside EBITDA and the operating result, outside turnover; one
// definition across dashboard, report, benchmark and forecast.
//
// INCIDENT. Before stage F2 the browser rebuilt EBITDA in a dozen places
// from the `incomeStatement` buckets — which carry neither the measured net
// 711 nor net 72x — so each rebuild was `ebitda_before_stock_variation`
// wearing the name EBITDA: agras 10,776,378.24 beside the served
// 11,848,065.27, the developer −29,038,838.12 beside +550,976.12. The
// workbook's P&L sheet, its cover, the printed report's P&L column, the
// ratio card's Debt / EBITDA (0.34× against the served 0.31×, because
// `bsOr` let the browser's division win), the multi-year growth table,
// the EBITDA bridge chart's prior bar and the no-envelope credit model all
// printed that second figure.
//
// LAW. On every book the engine SERVED an EBITDA for, every surface below
// prints `assembled_pl.ebitda` — the served field is the expectation;
// nothing here derives one:
//   deriveTotals · plLevelsOf · computeRatios (Debt / EBITDA recomputes on
//   it) · canonicalMetrics (report §1) · dashboard headline · dashboard
//   canon (scenarios / budget) · learning snapshot + resolver · period
//   facts (recommendations) · the printed P&L row and KPI tile · the
//   workbook's P&L sheet and cover · multi-year growth · the EBITDA bridge
//   chart · the NAV EV/EBITDA cross-check · the no-envelope credit model.
//
// REDS ON (TC-11): any of those surfaces printing a figure other than the
// served EBITDA on any served book — a second formula (the build-up
// before 711 / 72x, a bucket rebuild, a legacy alias) anywhere.
// CANNOT SEE: whether the served figure is right (net-711-rule); a refused
// EBITDA (refusal-carries); the denominator of a margin
// (turnover-denominator); pixels.
import { describe, expect, it, vi } from "vitest";

// Each case renders the printed report and the workbook: slow under a
// loaded full-suite run (5 s default timed out once), never slow alone.
vi.setConfig({ testTimeout: 60_000 });
import * as XLSX from "xlsx";

import { deriveTotals, computeRatios, type Ratio } from "@/lib/financialReport";
import { plLevelsOf } from "@/lib/servedOneEbitda";
import { buildCanonicalMetricsFromInputs } from "@/lib/canonicalMetrics";
import { canonicalMarginsFrom, computeDashboardHeadline } from "@/lib/dashboardHeadline";
import { buildDashboardCanonical } from "@/lib/comparison/dashboardCanon";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { resolveConceptValue } from "@/lib/dashboard/resolveConceptValue";
import { buildPeriodFacts } from "@/lib/periodFacts";
import { printedPl, printedRow } from "@/lib/printedPl";
import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import { computeCreditScore, multiPeriodGrowth } from "@/lib/financialValuation";
import { buildNavCascade } from "@/lib/buildNavCascade";
import { ebitdaBridge } from "@/lib/charts/reportCharts";
import type { ApiLineItem } from "@/lib/plStructure";

import { cardNamed, parsePrinted } from "./exportBooks";
import { metricRows, num, pairedWithItself, servedBooks, type SurfaceBook } from "./oneEbitdaSurfaceBooks";

const CENT = 0.005;
const BOOKS = servedBooks();

function everyRatio(b: SurfaceBook, withMetrics: boolean): Ratio[] {
  const r = computeRatios(b.statements, undefined, withMetrics ? b.metrics : undefined);
  return [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency].flat();
}

function sheetCell(wb: XLSX.WorkBook, sheet: string, label: string): unknown {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1 });
  const hit = rows.find((r) => String((r as unknown[])[0] ?? "") === label);
  return hit ? (hit as unknown[])[1] : undefined;
}

describe("one-ebitda — the witnesses exist", () => {
  it("covers eight served books, and on six of them the build-up before 711 / 72x differs from EBITDA", () => {
    expect(BOOKS.map((b) => b.name).sort()).toEqual(
      ["agras", "bridge_with_722", "carniprod", "closed_bridge", "closed_no_activity", "open", "realestate", "retail"],
    );
    // Non-vacuity: a surface that printed the build-up would print a
    // DIFFERENT number on these books — the law has something to catch.
    const differing = BOOKS.filter(
      (b) => Math.abs(num(b.apl.ebitda) - num(b.apl.ebitda_before_stock_variation)) > 1,
    ).map((b) => b.name);
    expect(differing.sort()).toEqual(["agras", "bridge_with_722", "carniprod", "closed_bridge", "open", "realestate"]);
  });
});

describe("one-ebitda — every surface prints the served EBITDA", () => {
  for (const b of BOOKS) {
    it(`${b.name}: the levels, the headline, the canon, the learning snapshot and the facts`, () => {
      const E = num(b.apl.ebitda);
      const failures: string[] = [];
      const check = (where: string, v: unknown) => {
        if (typeof v !== "number" || Math.abs(v - E) > CENT) failures.push(`${where} prints ${String(v)}, served ${E}`);
      };
      check("plLevelsOf", plLevelsOf(b.statements).ebitda);
      check("deriveTotals", deriveTotals(b.statements).ebitda);
      const canon = buildCanonicalMetricsFromInputs({
        assembled_pl: b.statements.assembled_pl as Record<string, number>,
        assembled_bs: b.statements.assembled_bs as Record<string, number>,
        line_items: b.lineItems, period_id: `p-${b.name}`,
      });
      check("canonicalMetrics.reported", canon?.ebitda.reported);
      const rows = metricRows(b.metrics);
      check(
        "dashboard headline",
        computeDashboardHeadline({
          statements: b.statements, lineItems: b.lineItems, metrics: rows, entity: "E",
          canonicalMargins: canonicalMarginsFrom(rows),
        }).tileEbitdaRon,
      );
      check("dashboard canon (scenarios / budget)", buildDashboardCanonical(b.statements, b.lineItems, rows).ebitda);
      const snap = buildReportingMetricsSnapshot(b.statements);
      check("learning snapshot", snap.ebitda);
      check("configurable-dashboard resolver", resolveConceptValue("ebitda", snap).value);
      check(
        "period facts (recommendations)",
        buildPeriodFacts({
          periodId: `p-${b.name}`, statements: b.statements,
          lineItems: b.lineItems as unknown as ApiLineItem[], valuation: null, industry: null,
        }).pl.ebitda,
      );
      expect(failures).toEqual([]);
    });

    it(`${b.name}: the printed report, the workbook and the charts`, () => {
      const E = num(b.apl.ebitda);
      const failures: string[] = [];
      const check = (where: string, v: unknown, tol = CENT) => {
        if (typeof v !== "number" || Math.abs(v - E) > tol) failures.push(`${where} prints ${String(v)}, served ${E}`);
      };
      check("printed P&L row", printedRow(printedPl(b.statements), "ebitda")?.value);
      const html = buildReportHtml(b.statements, { metricsByName: b.metrics });
      const doc = new DOMParser().parseFromString(html, "text/html");
      // The KPI card prints whole units.
      check("report KPI tile", parsePrinted(cardNamed(doc, "EBITDA").value), 0.5 + CENT);
      const wb = buildExcelWorkbook(b.statements, undefined, { metricsByName: b.metrics });
      check("workbook P&L sheet", sheetCell(wb, "P&L", "EBITDA"));
      check("workbook cover", sheetCell(wb, "Cover", "EBITDA"));
      // Multi-year growth over a like-for-like pair (the book as its own
      // prior): both cells are the served EBITDA, never a bucket rebuild.
      const growth = multiPeriodGrowth(pairedWithItself(b)).find((r) => r.metric === "EBITDA");
      for (const c of growth?.values ?? []) check(`growth ${c.period}`, c.value);
      // The bridge chart: both anchors are the served EBITDA.
      const blk = ebitdaBridge({
        s: pairedWithItself(b), ratios: computeRatios(b.statements), credit: computeCreditScore(b.statements),
        money: (v) => String(v), sectorBlocked: false,
      });
      expect(blk.status, `${b.name}: the bridge is not drawn`).toBe("drawn");
      check("bridge prior bar", blk.rows.find((r) => r.key === "prior")?.value);
      check("bridge current bar", blk.rows.find((r) => r.key === "cur")?.value);
      // The NAV cross-check multiplies the one EBITDA.
      const nav = buildNavCascade({
        pl: b.statements.assembled_pl as Record<string, number>,
        bs: b.statements.assembled_bs as Record<string, number>,
        lineItems: [],
      });
      const bs = b.statements.assembled_bs as Record<string, number>;
      const netDebt = (bs.total_debt ?? 0) - (bs.cash ?? 0);
      if (nav.crossMethods.evEbitda === null) failures.push("NAV EV/EBITDA refused on a served EBITDA");
      else if (Math.abs((nav.crossMethods.evEbitda + netDebt) / 10.5 - E) > 0.01)
        failures.push(`NAV EV/EBITDA multiplies ${(nav.crossMethods.evEbitda + netDebt) / 10.5}, served ${E}`);
      expect(failures).toEqual([]);
    });

    it(`${b.name}: Debt / EBITDA and the no-envelope credit model divide the served EBITDA`, () => {
      const E = num(b.apl.ebitda);
      // No engine metric map: computeRatios' own division is the one printed
      // (it is `bsOr`, so the division wins over the metric too).
      const dte = everyRatio(b, false).find((r) => r.key === "debt_to_ebitda");
      const debt = (b.statements.balanceSheet.shortTermDebt ?? 0) + (b.statements.balanceSheet.longTermDebt ?? 0);
      if (debt > 0 && E !== 0) {
        expect(dte?.value, `${b.name}: Debt / EBITDA refused on a served EBITDA`).not.toBeNull();
        expect(Math.abs((dte!.value as number) * E - debt), `${b.name}: Debt / EBITDA × EBITDA ≠ debt`).toBeLessThan(0.01 * Math.max(1, Math.abs(debt)));
      }
      const credit = computeCreditScore(b.statements);
      const row = credit.components.find((c) => c.label === "Debt / EBITDA");
      if (row?.value !== null && row?.value !== undefined && E !== 0) {
        const cdebt = (b.statements.assembled_bs as Record<string, number>)?.total_debt;
        if (typeof cdebt === "number" && cdebt > 0) {
          expect(Math.abs((row.value as number) * E - cdebt)).toBeLessThan(0.01 * cdebt);
        }
      }
    });
  }
});
