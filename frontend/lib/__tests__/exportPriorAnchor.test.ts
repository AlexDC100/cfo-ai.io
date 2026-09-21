// THE EXPORTS' PRIOR SIDE IS THE PRIOR'S FILED / SERVED FIGURE, NOT A
// RECONSTRUCTION WEARING ITS NAME.
//
// Live on cfo-ai.io (Scandia Dec 2025 vs Dec 2024, CFO Report PDF page 4,
// "FIGURE / VS PRIOR PERIOD"):
//   Net income    RON 36,787,353  +7,511,697 (+25.7%)
//   Total assets  RON 292,906,385 +7,031,375 (+2.5%)
// The current side of that strip is account 121 as filed and the served
// canonical total; the prior side was `deriveTotals` over the prior's
// legacy buckets — the class-6/7 reconstruction (29,275,655.32, where
// account 121 closed at 32,108,059.51) and a bucket sum missing a
// 216,194.00 "Unclassified — debit side" row. The dashboard's own P&L and
// BS bridges already quoted the right priors. The workbook's "Net income
// (account 121, as filed)" row printed the reconstruction too: its reader
// looked for `prior.assembled_pl`, which `statementsForExportOf` never
// carried.
//
// This drives the page's own join (ratioSurfacesOf → statementsForExportOf)
// over the committed hermetic pair (agras Dec 2025 vs carniprod Dec 2024,
// both anchored: prior account 121 = 1,435,533.59, prior reconstruction =
// 1,248,684.06 under tb_parser_v6 — 5,843,449.04 before the 609/709
// contra-convention repair, as recaptured by the plan/2 merge) and reads
// the three deliverables' bytes.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  · a prior net income, anywhere in the strip model, the report's strip
//    row or the workbook's account-121 row, that is not the served bridge's
//    prior total (account 121 as filed);
//  · a prior total assets that is not the served prior canonical total
//    when the prior's legacy buckets do NOT foot to it (the live shape,
//    planted below by leaving 216,194.00 out of one bucket);
//  · a prior WITHOUT served figures (bare statements) losing its existing
//    deriveTotals reading — the fallback is unchanged, not removed.

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import type { Statements } from "@/lib/financialReport";
import { deriveTotals } from "@/lib/financialReport";
import { statementsForExportOf, type ComparativesResponse } from "@/lib/comparatives";
import { buildComparatives, formatVariance } from "@/lib/reportComparatives";
import { factsFrom } from "@/lib/servedFacts";
import { ratioSurfacesOf } from "@/lib/useRatioSurfaces";

import pairJson from "./fixtures/comparatives/pair_served.json";

interface Pair {
  current_body: {
    assembled_metrics: Record<string, unknown>;
    statements: Statements & { periodLabel: string };
    metrics: { name: string; value: number | null }[];
  };
  comparatives: ComparativesResponse;
}

const fresh = (): Pair => JSON.parse(JSON.stringify(pairJson)) as Pair;

/** The live defect's BS shape: the prior's canonical total carries a row
 *  its legacy buckets do not (Scandia's 216,194.00 Unclassified row). The
 *  served canonical total, its status and the served bridge are untouched. */
const UNCLASSIFIED = 216_194.0;
function withUnbucketedPriorRow(p: Pair): Pair {
  const ps = p.comparatives.prior_statements as unknown as Statements;
  ps.balanceSheet.otherCurrentAssets -= UNCLASSIFIED;
  return p;
}

function surfaces(p: Pair) {
  const metricsByName: Record<string, number | null> = {};
  for (const m of p.current_body.metrics) {
    metricsByName[m.name] = typeof m.value === "number" ? m.value : null;
  }
  return ratioSurfacesOf({
    assembledMetrics: p.current_body.assembled_metrics,
    statements: p.current_body.statements,
    metricsByName,
    currentLabel: p.current_body.statements.periodLabel,
    periodId: "period-agras-fy2025",
    priorId: "period-carniprod-fy2024",
    comparatives: { data: { kind: "ok", data: p.comparatives } },
  });
}

const priorPl = (p: Pair) =>
  (p.comparatives.prior_statements as { assembled_pl: Record<string, number> }).assembled_pl;
const currentPl = (p: Pair) =>
  (p.current_body.statements as unknown as { assembled_pl: Record<string, number> }).assembled_pl;

/** The overrides the report passes for the current side (financialReport
 *  `summaryOverrides`): account 121 and the gateway's totals. */
function reportOverrides(st: Statements) {
  const sf = factsFrom(st);
  return {
    net_income: (st as unknown as { assembled_pl: Record<string, number> }).assembled_pl.net_income_statutory,
    total_assets: sf.totalAssets(),
    total_equity: sf.totalEquity(),
  };
}

const cents = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 100));

function stripRow(html: string, key: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tr = doc.querySelector(`tr[data-tile="${key}"]`);
  expect(tr, `strip row ${key}`).not.toBeNull();
  return Array.from(tr!.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim());
}

function workbookRow(wb: XLSX.WorkBook, sheet: string, label: string): unknown[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1 });
  const hit = rows.find((r) => String((r as unknown[])[0] ?? "") === label);
  expect(hit, `${sheet} row "${label}"`).toBeDefined();
  return hit as unknown[];
}

describe("the fixture is the anchored pair this gate is about", () => {
  it("prior account 121 differs from the prior reconstruction, and the served bridges quote account 121", () => {
    const p = fresh();
    expect(priorPl(p).net_income_anchor_status).toBe("anchored");
    expect(priorPl(p).net_income_statutory).toBe(1_435_533.59);
    expect(priorPl(p).net_income_reconstructed).toBe(1_248_684.06);
    expect(p.comparatives.bridges.pl.prior_total).toBe(priorPl(p).net_income_statutory);
    const pcb = (p.comparatives.prior_statements as { canonical_bs: { totals: { assets: number }; status: string } })
      .canonical_bs;
    expect(pcb.status).toBe("BALANCED");
    expect(p.comparatives.bridges.bs_assets.prior_total).toBe(pcb.totals.assets);
  });
});

describe("statementsForExportOf carries the prior's served figures", () => {
  it("net income is account 121; total assets / equity are the gateway's served totals", () => {
    const p = withUnbucketedPriorRow(fresh());
    const st = surfaces(p).statementsForExport!;
    expect(st.prior?.served?.net_income).toBe(p.comparatives.bridges.pl.prior_total);
    expect(st.prior?.served?.total_assets).toBe(p.comparatives.bridges.bs_assets.prior_total);
    expect(st.prior?.served?.total_equity).toBe(
      (p.comparatives.prior_statements as { canonical_bs: { totals: { equity: number } } }).canonical_bs.totals.equity,
    );
    expect(st.prior?.assembled_pl?.net_income_statutory).toBe(1_435_533.59);
    // The prior's BS blocks do not ride along — only the resolved totals.
    expect((st.prior as unknown as Record<string, unknown>).assembled_bs).toBeUndefined();
    expect((st.prior as unknown as Record<string, unknown>).canonical_bs).toBeUndefined();
  });
});

describe("the strip model compares like with like", () => {
  it("net income and total assets: current served − prior served, on both comparison kinds", () => {
    const p = withUnbucketedPriorRow(fresh());
    const st = surfaces(p).statementsForExport!;
    const cmp = buildComparatives(st, reportOverrides(st));
    const ni = cmp.lines.find((l) => l.key === "net_income")!;
    const ta = cmp.lines.find((l) => l.key === "total_assets")!;
    const expectNi = currentPl(p).net_income_statutory - p.comparatives.bridges.pl.prior_total!;
    const expectTa = p.comparatives.bridges.bs_assets.current_total! - p.comparatives.bridges.bs_assets.prior_total!;
    for (const kind of ["prior_period", "prior_year"] as const) {
      expect(cents(ni.vs[kind].absolute), `net income vs ${kind}`).toBe(cents(expectNi));
      expect(cents(ta.vs[kind].absolute), `total assets vs ${kind}`).toBe(cents(expectTa));
    }
    // And never the reconstruction / the bucket sum it used to read.
    const reconstructedMove = currentPl(p).net_income_statutory - priorPl(p).net_income_reconstructed;
    expect(cents(ni.vs.prior_period.absolute)).not.toBe(cents(reconstructedMove));
  });

  it("a prior without served figures keeps the deriveTotals reading (fallback unchanged)", () => {
    const p = fresh();
    const st = surfaces(p).statementsForExport!;
    const bare: Statements = {
      ...st,
      prior: {
        periodLabel: st.prior!.periodLabel,
        balanceSheet: st.prior!.balanceSheet,
        incomeStatement: st.prior!.incomeStatement,
      },
    };
    const cmp = buildComparatives(bare, reportOverrides(st));
    const ni = cmp.lines.find((l) => l.key === "net_income")!;
    const priorT = deriveTotals({ ...st, ...bare.prior!, prior: undefined });
    expect(cents(ni.vs.prior_period.absolute)).toBe(cents(currentPl(p).net_income_statutory - priorT.netIncome));
  });
});

describe("the three deliverables print the served prior", () => {
  it("report strip rows: net income and total assets move by the served bridges' amounts", () => {
    const p = withUnbucketedPriorRow(fresh());
    const s = surfaces(p);
    const html = buildReportHtml(s.statementsForExport!, s.creditEnvelopes);
    const niCells = stripRow(html, "net_income");
    const taCells = stripRow(html, "total_assets");
    const niMove = currentPl(p).net_income_statutory - p.comparatives.bridges.pl.prior_total!;
    const taMove = p.comparatives.bridges.bs_assets.current_total! - p.comparatives.bridges.bs_assets.prior_total!;
    const printed = (absolute: number, prior: number) =>
      formatVariance(
        {
          absolute,
          percent: (absolute / Math.abs(prior)) * 100,
          direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat",
          unavailable: null,
        },
        "money",
      );
    expect(niCells[2]).toBe(printed(niMove, p.comparatives.bridges.pl.prior_total!));
    expect(taCells[2]).toBe(printed(taMove, p.comparatives.bridges.bs_assets.prior_total!));
    expect(niCells[2]).toBe("+6,098,142 (+424.8%)");
  });

  it("workbook P&L: the account-121 row's prior cell is the prior's account 121", () => {
    const p = fresh();
    const s = surfaces(p);
    const wb = buildExcelWorkbook(s.statementsForExport!, undefined, s.creditEnvelopes);
    const row = workbookRow(wb, "P&L", "Net income (account 121, as filed)");
    expect(row[1]).toBe(currentPl(p).net_income_statutory);
    expect(row[2]).toBe(p.comparatives.bridges.pl.prior_total);
    // The reconstruction keeps its own, named row.
    const rec = workbookRow(wb, "P&L", "Net profit — reconstructed (class 6/7 movements)");
    expect(cents(rec[2] as number)).toBe(cents(priorPl(p).net_income_reconstructed));
  });
});
