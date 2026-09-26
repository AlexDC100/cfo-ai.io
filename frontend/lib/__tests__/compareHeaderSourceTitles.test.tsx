// THE COMPARE HEADERS NAME THE FILE EACH COLUMN HOLDS — on the balance
// sheet tab, the CFO Report and the workbook, not only the P&L tab.
//
// THE INCIDENT (2026-09-23). A period is a slot in a workspace, and
// `stage_persist`'s same-month replace re-pointed a client's Dec 2025
// slot at another company's balanță; the compare column then printed
// that book's figures under the client's month label with nothing on
// screen naming the file. The engine now serves each period's
// `source_document` on the comparatives document, and the P&L grid's
// header carried it as its title (plCompareColumn.test.tsx) — but the
// balance sheet's opening/closing headers, the report's column headers
// and the workbook's header cells did not (verifier P2, 2026-09-26): the
// commit that promised "compare headers carry each period's source file"
// delivered it on one tab. Every surface that prints two periods side by
// side now carries the same line, `sourceDocumentLine`.
//
// WHAT THESE RED ON, with the module correct (TC-11):
//   · a balance-sheet date header without the served filename as its
//     title under a comparative, or carrying the other period's file;
//   · the report's headline-figures, statement or ratio-comparison column
//     headers losing the title, or carrying it on the wrong column;
//   · the workbook's P&L / Balance Sheet header cells without the note,
//     or the three-column canonical Balance Sheet sheet growing a prior
//     note on a column it does not have;
//   · a title or note INVENTED when the engine served no filename;
//   · `statementsForExportOf` dropping either filename on its way to the
//     exporters.
//
// The pair is the committed corpus capture (agras beside carniprod — no
// client figure, name or code); the filenames are synthetic and set on a
// copy, since the corpus capture carries none.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import * as XLSX from "xlsx";

import { renderWithProviders } from "@/test/renderWithProviders";
import { BSStatementView } from "@/components/cfo/BSStatementView";
import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import { buildBSStatement } from "@/lib/buildBsStatement";
import { statementsForExportOf, type ComparativesResponse } from "@/lib/comparatives";
import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import type { CanonicalBs, Statements } from "@/lib/financialReport";
import { ratioSurfacesOf } from "@/lib/useRatioSurfaces";

import pairJson from "./fixtures/comparatives/pair_served.json";

const CURRENT_FILE = "balanta_2025_ledger.xls";
const PRIOR_FILE = "balanta_2024_extern.xlsx";

interface Pair {
  current_body: {
    assembled_metrics: Record<string, unknown>;
    statements: Statements & { periodLabel: string; canonical_bs: CanonicalBs };
    metrics: { name: string; value: number | null }[];
  };
  comparatives: ComparativesResponse;
}

/** The corpus pair with the two files named on a copy — or, `withFiles`
 *  false, with the engine serving none (`source_document: null`). */
function fresh(withFiles = true): Pair {
  const p = JSON.parse(JSON.stringify(pairJson)) as Pair;
  p.comparatives.current.source_document = withFiles
    ? { id: "doc-cur", filename: CURRENT_FILE, detected_type: "trial_balance" }
    : null;
  p.comparatives.prior.source_document = withFiles
    ? { id: "doc-pri", filename: PRIOR_FILE, detected_type: "trial_balance" }
    : null;
  return p;
}

/** The page's own join (ratioSurfacesOf → statementsForExportOf), as the
 *  export buttons run it. */
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

function reportOf(p: Pair): Document {
  const s = surfaces(p);
  const html = buildReportHtml(s.statementsForExport!, s.creditEnvelopes);
  return new DOMParser().parseFromString(html, "text/html");
}

function workbookOf(p: Pair): XLSX.WorkBook {
  const s = surfaces(p);
  return buildExcelWorkbook(s.statementsForExport!, undefined, s.creditEnvelopes);
}

/** The note on one header cell, or null when it carries none. */
function noteOn(wb: XLSX.WorkBook, sheet: string, addr: string): string | null {
  const cell = wb.Sheets[sheet]?.[addr] as XLSX.CellObject | undefined;
  const notes = cell?.c;
  return notes && notes.length > 0 ? notes.map((n) => n.t).join(" ") : null;
}

const currentLabel = (p: Pair) => p.current_body.statements.periodLabel;
const priorLabel = (p: Pair) => p.comparatives.prior.label;

afterEach(cleanup);

describe("the fixture is the subject", () => {
  it("the corpus capture names no file of its own — the names here are planted", () => {
    const raw = JSON.parse(JSON.stringify(pairJson)) as Pair;
    expect(raw.comparatives.current.source_document ?? null).toBeNull();
    expect(raw.comparatives.prior.source_document ?? null).toBeNull();
    expect(currentLabel(fresh())).not.toBe(priorLabel(fresh()));
  });
});

describe("statementsForExportOf carries the served filenames to the exporters", () => {
  it("this period's on the statements, the prior's on the prior block", () => {
    const p = fresh();
    const s = statementsForExportOf(p.current_body.statements, p.comparatives)!;
    expect(s.sourceDocument).toBe(CURRENT_FILE);
    expect(s.prior?.sourceDocument).toBe(PRIOR_FILE);
  });

  it("null, never invented, when the engine served none", () => {
    const p = fresh(false);
    const s = statementsForExportOf(p.current_body.statements, p.comparatives)!;
    expect(s.sourceDocument).toBeNull();
    expect(s.prior?.sourceDocument).toBeNull();
  });
});

describe("the balance sheet tab", () => {
  beforeEach(() => {
    localStorage.setItem("cfo-view-mode-v1", "pro");
  });

  const statementOf = (p: Pair) =>
    buildBSStatement({
      lineItems: [],
      entity: "agras",
      asOf: "Dec 2025",
      comparativeDate: "Dec 2024",
      currency: "RON",
      canonicalBs: p.current_body.statements.canonical_bs,
      priorCanonicalBs: p.comparatives.prior_canonical_bs,
    });

  const render = (p: Pair) =>
    renderWithProviders(
      <ComparativeProvider
        doc={p.comparatives}
        columns={{ prior: true, delta: true, deltaPct: true, share: true }}
        statement="BS"
        currency="RON"
      >
        <BSStatementView statement={statementOf(p)} hideGuide />
      </ComparativeProvider>,
    );

  it("the opening header names the prior's file and the closing header this period's", () => {
    render(fresh());
    expect(screen.getByTestId("bs-comparative-header").getAttribute("title")).toBe(PRIOR_FILE);
    expect(screen.getByTestId("bs-current-header").getAttribute("title")).toBe(CURRENT_FILE);
  });

  it("no title when the engine served no filename", () => {
    render(fresh(false));
    expect(screen.getByTestId("bs-comparative-header").getAttribute("title")).toBeNull();
    expect(screen.getByTestId("bs-current-header").getAttribute("title")).toBeNull();
  });
});

describe("the CFO Report", () => {
  it("headline figures: the period column names this file, the comparison column the prior's", () => {
    const p = fresh();
    const doc = reportOf(p);
    const heads = Array.from(doc.querySelectorAll("table.comparatives thead th"));
    expect(heads.length).toBeGreaterThanOrEqual(3);
    expect(heads[1].textContent?.trim()).toBe(currentLabel(p));
    expect(heads[1].getAttribute("title")).toBe(CURRENT_FILE);
    const comparison = heads.slice(2);
    expect(comparison.length).toBeGreaterThanOrEqual(1);
    for (const th of comparison) expect(th.getAttribute("title")).toBe(PRIOR_FILE);
  });

  it("the P&L and balance-sheet statement tables name this period's file on their period column", () => {
    const p = fresh();
    const doc = reportOf(p);
    const periodHeads = Array.from(doc.querySelectorAll("table.fin thead th")).filter(
      (th) => th.textContent?.trim() === currentLabel(p),
    );
    // The headline-figures table, the balance sheet and the P&L at least.
    expect(periodHeads.length).toBeGreaterThanOrEqual(3);
    for (const th of periodHeads) expect(th.getAttribute("title")).toBe(CURRENT_FILE);
  });

  it("ratio comparison: the current and prior heads name their files, the other four none", () => {
    const p = fresh();
    const doc = reportOf(p);
    const rowHeads = Array.from(doc.querySelectorAll("th[scope=row]"));
    const cur = rowHeads.filter((th) => th.textContent?.trim() === currentLabel(p));
    const pri = rowHeads.filter((th) => th.textContent?.trim() === priorLabel(p));
    expect(cur.length).toBeGreaterThan(0);
    expect(pri.length).toBeGreaterThan(0);
    for (const th of cur) expect(th.getAttribute("title")).toBe(CURRENT_FILE);
    for (const th of pri) expect(th.getAttribute("title")).toBe(PRIOR_FILE);
    const titled = rowHeads.filter((th) => th.getAttribute("title") !== null);
    expect(titled.length).toBe(cur.length + pri.length);
  });

  it("no title anywhere when the engine served no filename", () => {
    const p = fresh(false);
    const doc = reportOf(p);
    const named = Array.from(doc.querySelectorAll("th")).filter((th) =>
      [CURRENT_FILE, PRIOR_FILE].includes(th.getAttribute("title") ?? ""),
    );
    expect(named).toEqual([]);
    const heads = Array.from(doc.querySelectorAll("table.comparatives thead th"));
    expect(heads[1].getAttribute("title")).toBeNull();
  });
});

describe("the workbook", () => {
  it("P&L: B1 notes this period's file and C1 the prior's; the header text is unchanged", () => {
    const p = fresh();
    const wb = workbookOf(p);
    expect(noteOn(wb, "P&L", "B1")).toContain(CURRENT_FILE);
    expect(noteOn(wb, "P&L", "C1")).toContain(PRIOR_FILE);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["P&L"], { header: 1 });
    expect(rows[0]).toEqual(["Profit & Loss", currentLabel(p), priorLabel(p), "Δ Abs", "Δ %"]);
  });

  it("Balance Sheet (engine canonical, three columns): B1 notes this period's file and the Accounts column gets none", () => {
    const p = fresh();
    const wb = workbookOf(p);
    expect(noteOn(wb, "Balance Sheet", "B1")).toContain(CURRENT_FILE);
    expect(noteOn(wb, "Balance Sheet", "C1")).toBeNull();
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Balance Sheet"], { header: 1 });
    expect(rows[0]).toEqual(["Balance Sheet — engine canonical", currentLabel(p), "Accounts"]);
  });

  it("no note when the engine served no filename", () => {
    const wb = workbookOf(fresh(false));
    expect(noteOn(wb, "P&L", "B1")).toBeNull();
    expect(noteOn(wb, "P&L", "C1")).toBeNull();
    expect(noteOn(wb, "Balance Sheet", "B1")).toBeNull();
  });
});
