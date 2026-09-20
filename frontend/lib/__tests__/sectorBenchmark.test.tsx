// Company vs sector — THE LAW at the frontend boundary, and one printer
// for the page and the report.
//
// The fixture is what GET /api/period/{id}/sector-benchmark serves for the
// corpus pair (tests/engine/test_sector_benchmark_route_real_app.py holds
// it byte-for-byte to the route).
//
// WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):
//   · a sector figure printed (page, report, ratio-card line, movement
//     item) when its n, year or source is missing, or when n is under the
//     served minimum — the row must turn into words and lose its bar;
//   · a refused row printing a number, a bar, or a dash instead of its
//     reason; an absent company figure printed as a number;
//   · the page row and the report row printing different bytes for the
//     same cell (label, company, median, middle half, n, year, position);
//   · the ratio card writing the band source inside `ratio-ladder`, or
//     calling a general ladder "sector";
//   · an EN/RO key missing on either side, or a numeral typed into a
//     sector string (every figure is an interpolation).
// WHAT IT CANNOT SEE: whether the served medians are right (engine gates),
// and the fetch itself (the route is exercised un-intercepted in pytest).

import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";

import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { renderWithProviders } from "@/test/renderWithProviders";
import { SectorBenchmarkView } from "@/components/cfo/benchmark/SectorBenchmarkSection";
import {
  bandSourceText,
  lawfulFigure,
  printSectorMovements,
  printSectorRows,
  readSectorBenchmark,
  sectorReportSectionHtml,
  type SectorBenchmarkDoc,
} from "@/lib/sectorBenchmark";

import served from "./fixtures/sectorBenchmark/served_pair.json";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const DOC = (): SectorBenchmarkDoc => readSectorBenchmark(clone(served.with_prior))!;
const DOC_NO_PRIOR = (): SectorBenchmarkDoc => readSectorBenchmark(clone(served.without_prior))!;
const CELLS = ["label", "company", "median", "iqr", "n", "fy", "position"] as const;

describe("the served document", () => {
  it("is read, and every row of the fixture is lawful", () => {
    const doc = DOC();
    expect(doc.status).toBe("ok");
    expect(doc.rows.length).toBeGreaterThanOrEqual(9);
    for (const r of doc.rows) expect(lawfulFigure(r.sector, doc.min_peers), r.key).not.toBeNull();
    expect(readSectorBenchmark({ schema: "something/else" })).toBeNull();
  });
});

describe("THE LAW: no source, year or n — no figure", () => {
  for (const field of ["n", "year", "source"] as const) {
    it(`a row without ${field} prints words, no number and no bar`, () => {
      const doc = DOC();
      const target = doc.rows.find((r) => r.key === "net_margin")!;
      delete (target.sector as Record<string, unknown>)[field];
      const printed = printSectorRows(doc, "en").find((r) => r.key === "net_margin")!;
      expect(printed.status).toBe("refused");
      expect(printed.median).toBe("");
      expect(printed.iqr).toBe("");
      expect(printed.bar).toBeNull();
      expect(printed.reason).toBe(en.benchmarkPage.sector.reason.figure_withheld);

      renderWithProviders(<SectorBenchmarkView doc={doc} />);
      const row = screen.getAllByTestId("sector-row").find((el) => el.getAttribute("data-sector-row") === "net_margin")!;
      expect(row.getAttribute("data-status")).toBe("refused");
      expect(within(row).queryByTestId("sector-range-bar")).toBeNull();
      expect(row.querySelector('[data-cell="median"]')).toBeNull();
      expect(row.querySelector('[data-cell="reason"]')!.textContent).toContain(en.benchmarkPage.sector.reason.figure_withheld);

      const html = sectorReportSectionHtml(doc, "en");
      const tr = new DOMParser().parseFromString(html, "text/html").querySelector('tr[data-sector-row="net_margin"]')!;
      expect(tr.getAttribute("data-status")).toBe("refused");
      expect(tr.querySelector('[data-cell="median"]')).toBeNull();
    });
  }

  it("fewer peers than the served minimum is words, never a median", () => {
    const doc = DOC();
    const target = doc.rows.find((r) => r.key === "roa")!;
    target.status = "insufficient_peers";
    target.position = null;
    target.vs_sector = null;
    target.reason = { code: "insufficient_peers", inputs: { n: 4, min: doc.min_peers } };
    target.sector = { n: 4, year: target.sector!.year, source: target.sector!.source, filed_lines: target.sector!.filed_lines };
    const printed = printSectorRows(doc, "en").find((r) => r.key === "roa")!;
    expect(printed.status).toBe("refused");
    expect(printed.reason).toBe(`Insufficient peers (n=4, minimum ${doc.min_peers}).`);
    expect(printed.median).toBe("");
    expect(printed.bar).toBeNull();
    // and a median smuggled onto a thin cell is still not a figure
    expect(lawfulFigure({ median: 0.1, p25: 0.0, p75: 0.2, n: 4, year: 2024, source: "x" }, doc.min_peers)).toBeNull();
  });

  it("an absent company figure prints its reason, never a number", () => {
    const doc = DOC_NO_PRIOR();
    const printed = printSectorRows(doc, "en").find((r) => r.key === "revenue_growth")!;
    expect(printed.status).toBe("refused");
    expect(printed.company).toBe("");
    expect(printed.reason).toBe(en.benchmarkPage.sector.reason.prior_period_absent);
  });

  it("a movement item without its citation does not print", () => {
    const doc = DOC();
    expect(printSectorMovements(doc, "en").improved.length).toBe(doc.movements.improved.length);
    expect(doc.movements.improved.length).toBeGreaterThan(0);
    delete doc.movements.improved[0].n;
    expect(printSectorMovements(doc, "en").improved.length).toBe(doc.movements.improved.length - 1);
    const none = printSectorMovements(DOC_NO_PRIOR(), "en");
    expect(none.status).toBe("refused");
    expect(none.reason).toBe(en.benchmarkPage.sector.reason.prior_period_absent);
  });
});

describe("page rows and report rows are the same bytes", () => {
  for (const locale of ["en", "ro"] as const) {
    it(`every cell, ${locale}`, async () => {
      const doc = DOC();
      const { i18n } = renderWithProviders(<SectorBenchmarkView doc={doc} />) as unknown as { i18n?: { changeLanguage: (l: string) => Promise<unknown> } };
      void i18n;
      const printed = printSectorRows(doc, locale);
      const report = new DOMParser().parseFromString(sectorReportSectionHtml(doc, locale), "text/html");
      expect(printed.length).toBe(doc.rows.length);
      for (const p of printed) {
        const tr = report.querySelector(`tr[data-sector-row="${p.key}"]`)!;
        expect(tr, p.key).not.toBeNull();
        const cellsOfPrinter: Record<string, string> = {
          label: p.label, company: p.company, median: p.median, iqr: p.iqr, n: p.n, fy: p.fy, position: p.position };
        for (const c of CELLS) {
          const td = tr.querySelector(`[data-cell="${c}"]`)!;
          // the label cell also holds the note line; compare its first text node
          const text = c === "label" ? (td.firstChild?.textContent ?? "") : td.textContent;
          expect(text, `${p.key}.${c}`).toBe(cellsOfPrinter[c]);
        }
      }
      if (locale === "en") {
        for (const p of printed) {
          const row = screen.getAllByTestId("sector-row").find((el) => el.getAttribute("data-sector-row") === p.key)!;
          const tr = report.querySelector(`tr[data-sector-row="${p.key}"]`)!;
          for (const c of CELLS) {
            const onPage = row.querySelector(`[data-cell="${c}"]`)!.textContent;
            const td = tr.querySelector(`[data-cell="${c}"]`)!;
            const inReport = c === "label" ? (td.firstChild?.textContent ?? "") : td.textContent;
            expect(onPage, `${p.key}.${c}`).toBe(inReport);
          }
          // SOURCE, YEAR and N are visible text on every sourced row
          expect(row.querySelector('[data-cell="source"]')!.textContent).toBe(p.source);
        }
      }
    });
  }

  it("the source line, the size-band cut-offs and the year are printed from the document", () => {
    const doc = DOC();
    renderWithProviders(<SectorBenchmarkView doc={doc} />);
    const ctx = screen.getByTestId("sector-context").textContent!;
    expect(ctx).toContain(`CAEN ${doc.caen}`);
    expect(ctx).toContain(new Intl.NumberFormat("en-US").format(doc.size_band!.min_ron));
    expect(ctx).toContain(`FY${doc.year}`);
    expect(screen.getByTestId("sector-source").textContent).toContain(doc.source!);
    expect(screen.getByTestId("sector-refused").textContent).toContain("Gross margin");
  });
});

describe("the ratio card's band-source line", () => {
  it("names the sector band with caen, size band, n, FY and source — or says general, and why", () => {
    const doc = DOC();
    const sector = bandSourceText(doc, "net_margin", "en");
    const card = doc.ratio_cards.net_margin as { n: number; year: number; source: string; sector_caen: string };
    for (const piece of [`n=${card.n}`, `FY${card.year}`, card.source, `CAEN ${card.sector_caen}`, "general SME ladder"]) {
      expect(sector).toContain(piece);
    }
    expect(bandSourceText(doc, "dio", "en")).toBe(
      `General SME band. No sector band: ${en.benchmarkPage.sector.reason.definition_differs}`);
    expect(bandSourceText(doc, "gross_margin", "en")).toContain(en.benchmarkPage.sector.reason.not_in_filed_summary);
    expect(bandSourceText(null, "net_margin", "en")).toBe(en.benchmarkPage.sector.bandGeneral);
  });

  it("a sector card without n falls back to the general sentence", () => {
    const doc = DOC();
    delete (doc.ratio_cards.net_margin as Record<string, unknown>).n;
    expect(bandSourceText(doc, "net_margin", "en")).toBe(en.benchmarkPage.sector.bandGeneral);
  });
});

describe("strings", () => {
  const flat = (o: unknown, p = ""): Record<string, string> =>
    Object.entries(o as Record<string, unknown>).reduce((acc, [k, v]) =>
      typeof v === "string" ? { ...acc, [p + k]: v } : { ...acc, ...flat(v, `${p}${k}.`) }, {} as Record<string, string>);

  it("EN and RO carry the same keys, and no numeral is typed into either", () => {
    const e = flat(en.benchmarkPage.sector);
    const r = flat(ro.benchmarkPage.sector);
    expect(Object.keys(r).sort()).toEqual(Object.keys(e).sort());
    for (const [k, v] of [...Object.entries(e), ...Object.entries(r)]) {
      expect(/\d/.test(v.replace(/\{\{[^}]+\}\}/g, "")), `${k}: ${v}`).toBe(false);
    }
  });

  it("every served reason code and ratio key has a sentence", () => {
    const e = en.benchmarkPage.sector as unknown as { reason: Record<string, string>; ratio: Record<string, string> };
    for (const doc of [DOC(), DOC_NO_PRIOR()]) {
      for (const r of doc.rows) {
        expect(e.ratio[r.key], r.key).toBeTruthy();
        if (r.reason) expect(e.reason[r.reason.code], r.reason.code).toBeTruthy();
      }
      for (const c of Object.values(doc.ratio_cards)) {
        if (c.band_source === "general") expect(e.reason[c.reason!.code], c.reason!.code).toBeTruthy();
      }
    }
  });
});

describe("refused ratios", () => {
  it("every served refused key has a label in both languages", () => {
    const e = (en.benchmarkPage.sector as unknown as { refusedRatio: Record<string, string> }).refusedRatio;
    const r = (ro.benchmarkPage.sector as unknown as { refusedRatio: Record<string, string> }).refusedRatio;
    for (const item of DOC().refused) {
      expect(e[item.key], item.key).toBeTruthy();
      expect(r[item.key], item.key).toBeTruthy();
    }
  });
});
