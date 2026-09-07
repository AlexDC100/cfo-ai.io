// G-C3 — R7: THE SAME FIGURE IN EVERY FORMAT THIS REPO CAN PRODUCE.
//
// ── WHICH FORMATS EXIST, MEASURED ─────────────────────────────────────
// `package.json` was read before anything was built. What is available:
//
//   HTML   — produced here (`buildReportHtml`). Interactive, offline,
//            print-grade. No dependency.
//   XLSX   — produced here (`buildExcelWorkbook`) on `xlsx@0.18.5`,
//            already a dependency. Ten sheets, one per section.
//   PDF    — produced by PRINTING the HTML. There is no PDF library in
//            `dependencies` (no jspdf, no pdfmake, no puppeteer) and none
//            was added. Parity with the screen is therefore not a
//            comparison but an identity: the PDF is that document,
//            paginated by the `@page` rules G-C2c asserts. A programmatic
//            PDF would need a new dependency; that decision is the
//            owner's, not this lane's.
//   PPTX   — NOT PRODUCED. There is no pptx library in the tree
//            (`pptxgenjs` is absent). `fflate` is present and a .pptx is
//            a zip of OOXML parts, so it could be hand-rolled — that is a
//            new format implementation, not a wiring job, and it is
//            handed over rather than started. There is no board-cut deck
//            in this repo today and this gate does not pretend otherwise.
//
// So R7 is asserted where there are two real artefacts to compare: the
// printed HTML and the workbook. And it is asserted the only way that
// stays true — both are built from ONE call (`reportChartBlocks`), so the
// gate is checking that the shared construction is still shared, not
// patching two derivations into agreement.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  · a chart figure spelled differently in the workbook than in the
//    document (a second money formatter entering either file)
//  · a chart present in one artefact and missing from the other
//  · a gap card that travels to the HTML but is dropped from the workbook
//    — a period that looks like it had five fewer open questions
//  · a section losing its sheet
//
// ── WHAT IT CANNOT SEE ────────────────────────────────────────────────
//  · the PDF, because nothing in this repo renders one; and the PPTX,
//    because it does not exist.
//  · whether the workbook OPENS correctly in Excel proper — SheetJS
//    round-trips through its own reader here.

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { buildExcelWorkbook } from "@/lib/financialExports";
import { BOOKS, type Book, exportDoc, metricsFor, statementsFor } from "./exportBooks";

function workbook(b: Book): XLSX.WorkBook {
  return buildExcelWorkbook(statementsFor(b), undefined, { metricsByName: metricsFor(b) });
}

function sheetRows(wb: XLSX.WorkBook, name: string): string[][] {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`the workbook has no sheet ${name}; it has: ${wb.SheetNames.join(", ")}`);
  return (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) as string[][]).map((r) =>
    r.map((c) => String(c ?? "").replace(/\s+/g, " ").trim()),
  );
}

interface HtmlChart {
  title: string;
  status: string;
  rows: Array<[string, string, string]>;
}

function htmlCharts(b: Book): HtmlChart[] {
  const doc = exportDoc(b);
  return Array.from(doc.querySelectorAll("[data-chart-block]")).map((f) => ({
    title: (
      f.querySelector("svg.chart title")?.textContent ??
      (f.querySelector(".chart-gap-h")?.textContent ?? "").replace(/ . not charted$/, "")
    ).trim(),
    status: f.getAttribute("data-chart-status") ?? "",
    rows: Array.from(f.querySelectorAll("table.chart-table tbody tr")).map((tr) => {
      const td = Array.from(tr.querySelectorAll("td")).map((x) =>
        (x.textContent ?? "").replace(/\s+/g, " ").trim(),
      );
      return [td[0] ?? "", td[1] ?? "", td[2] ?? ""] as [string, string, string];
    }),
  }));
}

describe("G-C3 — the workbook and the document print the same figures", () => {
  it.each(BOOKS)("%s: one sheet per section, including Charts", (b: Book) => {
    const wb = workbook(b);
    expect(wb.SheetNames).toContain("Charts");
    for (const need of [
      "Cover",
      "P&L",
      "Balance Sheet",
      "Ratios",
      "Credit & Risk",
      "Recommendations",
    ]) {
      expect(wb.SheetNames, `sheet ${need}`).toContain(need);
    }
    expect(wb.SheetNames.length).toBeGreaterThanOrEqual(9);
  });

  it.each(BOOKS)("%s: every drawn chart row is in the workbook, spelled identically", (b: Book) => {
    const rows = sheetRows(workbook(b), "Charts");
    const flat = rows.map((r) => r.join(""));
    for (const chart of htmlCharts(b)) {
      if (chart.status !== "drawn") continue;
      for (const [label, printed, source] of chart.rows) {
        const key = [label, printed, source].join("");
        const found = flat.some((line) => line.startsWith(key));
        expect(found, `"${label}" prints ${printed} in the document and nowhere in the workbook`).toBe(
          true,
        );
      }
    }
  });

  it.each(BOOKS)("%s: the gap cards travel to the workbook too", (b: Book) => {
    const rows = sheetRows(workbook(b), "Charts");
    const text = rows.map((r) => r.join(" ")).join("\n");
    const absent = htmlCharts(b).filter((c) => c.status === "absent");
    expect(absent.length, "no gap cards on this book: the assertion would be vacuous").toBeGreaterThan(0);
    for (const chart of absent) {
      expect(text, `${chart.title} is a gap in the document and silence in the workbook`).toContain(
        chart.title,
      );
    }
    expect(text).toContain("Missing");
    expect(text).toContain("To produce it");
  });

  it.each(BOOKS)("%s: every chart is named in both artefacts", (b: Book) => {
    const text = sheetRows(workbook(b), "Charts")
      .map((r) => r.join(" "))
      .join("\n");
    for (const chart of htmlCharts(b)) {
      expect(text, `chart "${chart.title}" is in the document and not in the workbook`).toContain(
        chart.title,
      );
    }
  });
});
