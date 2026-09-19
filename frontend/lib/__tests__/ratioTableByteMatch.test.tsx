// GATE RATIOS-B8 — ONE ROW, THREE SURFACES, THE SAME BYTES.
//
// ── THE DEFECT CLASS ──────────────────────────────────────────────────
//
// The owner's brief: every ratio carries [current] [prior] [change] [band
// now] [band prior] [band movement] on the dashboard Ratios page AND in the
// exported report, "same columns, same numbers, byte-matching". B6 built the
// tab and B7 the exports on separate branches, and each held its own
// surfaces to a handle named `data-ratio-cmp-json` — with DIFFERENT
// contents (the tab embedded its printed row, the report the served row),
// so the one claim the brief makes across the two could not even be stated.
// Each surface also printed a turns row's change in its own shape. Every
// per-surface gate was green.
//
// ── THE FIXTURE (TC-1) ────────────────────────────────────────────────
//
// `fixtures/comparatives/pair_served.json`: the real GET /api/period body
// of the agras corpus book and the comparatives document for agras against
// carniprod, rebuilt from the committed corpus through the real router by
// `scripts/capture_comparatives_pair.py` (freshness:
// tests/engine/test_ratio_compare_fe_fixture.py; the same document is what
// the un-intercepted route serves: test_comparatives_route_real_app.py).
// `pair_prior_blocks.json` is the same pair with the prior's industry
// signal blocking sector bands. No Scandia data (ruling Q10).
//
// The surfaces are fed exactly as the page feeds them: `ratioSurfacesOf`
// (the dashboard's one join) gives the tab its view and the exports their
// statements and credit envelopes; the tab renders in English, the
// language the exports print.
//
// ── WHAT IT FAILS ON AFTER THE REPAIR (TC-11) ─────────────────────────
//
//  B1 any census row or composite whose six cells differ, by one byte,
//     between the Ratios tab table, the report (its card table or served-
//     only row, and every other report element embedding that row) and the
//     workbook Ratios sheet — a rounding, a unit, a sign, a reason sentence,
//     the join of a turns change and its percent;
//  B2 a surface's `data-ratio-cmp-json` that is not the served row
//     serialised, or a row missing from any of the three surfaces;
//  B3 the improved / deteriorated lists in a different order, or with
//     different cells, on the tab, in the report's executive summary and
//     in the workbook's Band movements block;
//  B4 non-vacuity: fewer than every served census row and composite
//     compared, no turns row with its percent, no refused prior, no numeric
//     prior Altman, an empty list;
//  B5 the NAME beside the six cells, or any of the six column headings,
//     differing by one byte between the tab, the report and the workbook —
//     or the tab's name not being the i18n label the one authority
//     (`ratioLabelForKey`) prints, or a heading not being its i18n word
//     ("Current Ratio" / "Current ratio", "Δ" / "Change", "Band now" /
//     "Band, 2025-12-31": the B8 verifier's 31 mismatched rows).
//
// ── WHAT IT CANNOT SEE ────────────────────────────────────────────────
//
// Whether the one formatter (`ratioTable.ts`) prints a figure correctly —
// every surface calls it, so a defect there moves all three together
// (ratioTableFormat.test.ts owns that); the Romanian tab (the exports are
// English only); the PDF (printed from this HTML); the tile and drawer
// beyond the handle ratioCompareTab.test.tsx already holds equal to the
// table row.

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { RatioComparisonTable } from "@/components/cfo/ratios/RatioComparisonTable";
import { BandMovementLists } from "@/components/cfo/ratios/BandMovementLists";
import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import {
  RATIO_CMP_CELL_IDS,
  altmanRatio,
  exportRatioBundle,
  servedRatioLabel,
  type Statements,
} from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import type { ComparativesResponse } from "@/lib/comparatives";
import { ratioSurfacesOf, type RatioSurfaces } from "@/lib/useRatioSurfaces";
import {
  ratioCompareHeadingsFor,
  ratioLabelForKey,
  serializeRatioCompareRow,
  type RatioCompareRow,
  type RatioComparisonV1,
} from "@/lib/ratioTable";

import pairJson from "./fixtures/comparatives/pair_served.json";
import priorBlocksJson from "./fixtures/comparatives/pair_prior_blocks.json";

interface Pair {
  current_body: {
    assembled_metrics: Record<string, unknown>;
    statements: Statements & { periodLabel: string };
    metrics: { name: string; value: number | null }[];
  };
  comparatives: ComparativesResponse & { ratios: RatioComparisonV1 };
}

const DOCUMENTS: Record<string, () => Pair> = {
  "agras vs carniprod": () => JSON.parse(JSON.stringify(pairJson)) as Pair,
  "agras vs carniprod, the prior blocking sector bands": () => {
    const p = JSON.parse(JSON.stringify(pairJson)) as Pair;
    const priorStatements = p.comparatives.prior_statements;
    p.comparatives = JSON.parse(JSON.stringify((priorBlocksJson as { comparatives: unknown }).comparatives)) as Pair["comparatives"];
    // The committed prior-blocks document trims `prior_statements` (its
    // `_trimmed`): the prior is the same carniprod body, only its industry
    // signal differs, so the first fixture's prior statements are its own.
    // Without them the export join attaches no comparison at all.
    p.comparatives.prior_statements = priorStatements;
    return p;
  },
};

type Cells = string[];

interface Surfaces {
  served: Map<string, RatioCompareRow>;
  keys: string[];
  tab: Map<string, { handle: string | null; cells: Cells }>;
  report: Map<string, { handle: string | null; cells: Cells }[]>;
  reportHandles: { key: string; handle: string }[];
  workbook: Map<string, Cells>;
  lists: Record<"improved" | "deteriorated", { tab: ListItem[]; report: ListItem[]; workbook: ListItem[] }>;
  /** B5: the name printed beside the six cells, per surface. */
  labels: { tab: Map<string, string>; report: Map<string, string[]>; workbook: Map<string, string> };
  /** B5: the six column headings, per surface (the report's every
   *  heading set — one per card table and the served-only table). */
  headings: { tab: string[]; report: string[][]; workbook: string[] };
}

interface ListItem {
  key: string;
  handle: string | null;
  cells: Cells; // [prior, current, delta, movement]
}

const LIST_CELLS = ["prior", "current", "delta", "movement"] as const;

function metricsOf(p: Pair): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of p.current_body.metrics) out[m.name] = typeof m.value === "number" ? m.value : null;
  return out;
}

function pageSurfaces(p: Pair): RatioSurfaces & { metricsByName: Record<string, number | null> } {
  const metricsByName = metricsOf(p);
  const s = ratioSurfacesOf({
    assembledMetrics: p.current_body.assembled_metrics,
    statements: p.current_body.statements,
    metricsByName,
    currentLabel: p.current_body.statements.periodLabel,
    periodId: "period-agras-fy2025",
    priorId: "period-carniprod-fy2024",
    comparatives: { data: { kind: "ok", data: p.comparatives } },
  });
  return { ...s, metricsByName };
}

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

function cellsOf(el: Element, ids: readonly string[]): Cells {
  return ids.map((id) => {
    const cell = el.querySelector(`[data-cell="${id}"]`);
    return cell ? text(cell) : `<no ${id} cell>`;
  });
}

/** Everything the gate compares, read off the three rendered surfaces. */
function readSurfaces(p: Pair): Surfaces {
  const s = pageSurfaces(p);
  const view = s.ratioCompareView;
  if (!view || !view.comparison) throw new Error("the page join built no comparison view");
  const cmp = view.comparison;
  const served = new Map<string, RatioCompareRow>([...cmp.rows, ...cmp.composites].map((r) => [r.key, r]));
  const keys = [...served.keys()];

  // ── the Ratios tab ──
  const { unmount } = renderWithProviders(
    <>
      <RatioComparisonTable view={view} />
      <BandMovementLists view={view} />
    </>,
  );
  const tab = new Map<string, { handle: string | null; cells: Cells }>();
  const tabLabels = new Map<string, string>();
  for (const tr of Array.from(document.querySelectorAll('[data-testid="ratio-compare-row"]'))) {
    tab.set(tr.getAttribute("data-ratio-key") as string, {
      handle: tr.getAttribute("data-ratio-cmp-json"),
      cells: cellsOf(tr, RATIO_CMP_CELL_IDS),
    });
    tabLabels.set(tr.getAttribute("data-ratio-key") as string, text(tr.querySelector('th[scope="row"] > div:first-child')));
  }
  const tabHeadings = Array.from(
    document.querySelectorAll('[data-testid="ratio-compare-table"] thead th'),
  ).map((th) => text(th)).slice(1);
  const tabList = (kind: "improved" | "deteriorated"): ListItem[] => {
    const section = document.querySelector(`[data-testid="band-movements"]`);
    const lists = section ? Array.from(section.querySelectorAll("ol")) : [];
    const ol = lists[kind === "improved" ? 0 : 1];
    return ol
      ? Array.from(ol.querySelectorAll('[data-testid="band-movement-item"]')).map((li) => ({
          key: li.getAttribute("data-ratio-key") as string,
          handle: li.getAttribute("data-ratio-cmp-json"),
          cells: cellsOf(li, LIST_CELLS),
        }))
      : [];
  };
  const tabLists = { improved: tabList("improved"), deteriorated: tabList("deteriorated") };
  unmount();

  // ── the report ──
  const statements = s.statementsForExport;
  if (!statements) throw new Error("the page join built no export statements");
  const doc = new DOMParser().parseFromString(buildReportHtml(statements, s.creditEnvelopes), "text/html");
  const report = new Map<string, { handle: string | null; cells: Cells }[]>();
  const reportLabels = new Map<string, string[]>();
  const reportHeadings: string[][] = [];
  for (const el of Array.from(doc.querySelectorAll("[data-ratio-cmp]"))) {
    const key = el.getAttribute("data-ratio-cmp") as string;
    const list = report.get(key) ?? [];
    list.push({ handle: el.getAttribute("data-ratio-cmp-json"), cells: cellsOf(el, RATIO_CMP_CELL_IDS) });
    report.set(key, list);
    // The name beside the cells: the card's headline for a card table, the
    // first cell for a served-only row. The headings: the card table's row
    // headings, or the served-only table's column headings.
    const card = el.closest(".ratio-card");
    if (card) {
      reportLabels.set(key, [...(reportLabels.get(key) ?? []), text(card.querySelector(".label"))]);
      reportHeadings.push(Array.from(el.querySelectorAll('th[scope="row"]')).map((th) => text(th)));
    } else if (el.tagName === "TR") {
      reportLabels.set(key, [...(reportLabels.get(key) ?? []), text(el.querySelector("td"))]);
      const head = el.closest("table")?.querySelector("thead tr");
      if (head) reportHeadings.push(Array.from(head.querySelectorAll("th")).map((th) => text(th)).slice(1));
    } else {
      reportLabels.set(key, [...(reportLabels.get(key) ?? []), `<no name beside ${key}>`]);
    }
  }
  const reportHandles = Array.from(doc.querySelectorAll("[data-ratio-cmp-json]")).map((el) => {
    const handle = el.getAttribute("data-ratio-cmp-json") as string;
    return { key: (JSON.parse(handle) as { key: string }).key, handle };
  });
  const reportList = (kind: "improved" | "deteriorated"): ListItem[] =>
    Array.from(doc.querySelectorAll(`ul[data-band-list="${kind}"] li`)).map((li) => ({
      key: li.getAttribute("data-band-crossing") as string,
      handle: li.getAttribute("data-ratio-cmp-json"),
      cells: cellsOf(li, LIST_CELLS),
    }));

  // ── the workbook ──
  const wb = buildExcelWorkbook(statements, undefined, s.creditEnvelopes);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Ratios, { header: 1, raw: true, defval: "" });
  const cut = rows.findIndex((r) => r.length > 0 && r[0] === "Band movements");
  if (cut < 0) throw new Error("the Ratios sheet has no Band movements block");
  const bundle = exportRatioBundle(statements, s.creditEnvelopes.metricsByName);
  const credit = computeCreditScore(
    statements,
    s.creditEnvelopes.credit,
    s.creditEnvelopes.piotroski,
    s.creditEnvelopes.metricsByName,
  );
  const altmanLabel = altmanRatio(credit).label;
  const byLabel = new Map<string, Cells[]>();
  for (const r of rows.slice(1, cut)) {
    const label = String(r[1] ?? "");
    byLabel.set(label, [...(byLabel.get(label) ?? []), r.slice(2, 8).map((c) => String(c))]);
  }
  const workbook = new Map<string, Cells>();
  const workbookLabels = new Map<string, string>();
  for (const key of keys) {
    const hits = byLabel.get(servedRatioLabel(key, bundle, altmanLabel)) ?? [];
    if (hits.length === 1) {
      workbook.set(key, hits[0]);
      workbookLabels.set(key, servedRatioLabel(key, bundle, altmanLabel));
    }
  }
  const workbookHeadings = rows[0].slice(2, 8).map((c) => String(c));
  const labelToKey = new Map(keys.map((k) => [servedRatioLabel(k, bundle, altmanLabel), k]));
  const workbookList = (title: string): ListItem[] =>
    rows
      .slice(cut)
      .filter((r) => r[0] === title && labelToKey.has(String(r[1])))
      .map((r) => ({
        key: labelToKey.get(String(r[1])) as string,
        handle: null,
        // [list, ratio, current, prior, Δ, movement, rung, finding]
        cells: [String(r[3]), String(r[2]), String(r[4]), String(r[5])],
      }));

  return {
    served,
    keys,
    tab,
    report,
    reportHandles,
    workbook,
    lists: {
      improved: { tab: tabLists.improved, report: reportList("improved"), workbook: workbookList("Improved") },
      deteriorated: {
        tab: tabLists.deteriorated,
        report: reportList("deteriorated"),
        workbook: workbookList("Deteriorated"),
      },
    },
    labels: { tab: tabLabels, report: reportLabels, workbook: workbookLabels },
    headings: { tab: tabHeadings, report: reportHeadings, workbook: workbookHeadings },
  };
}

// i18n must be English before collection renders anything.
await i18n.changeLanguage("en");

for (const [name, make] of Object.entries(DOCUMENTS)) {
  const read = readSurfaces(make());
  const served = make().comparatives.ratios;
  const keys = [...served.rows, ...served.composites].map((r) => r.key);

  describe(`ratio byte-match — ${name}`, () => {
    it("B4 non-vacuity: every census row and composite is compared, with the cases that bite", () => {
      expect(keys.length).toBe(served.rows.length + served.composites.length);
      expect(served.rows.length).toBeGreaterThanOrEqual(27);
      expect(served.composites.map((c) => c.key)).toEqual(["altman_z", "credit_composite", "letter_grade"]);
      const altman = served.composites.find((c) => c.key === "altman_z") as RatioCompareRow;
      expect(altman.prior.value_q).not.toBeNull();
      expect(Number.isFinite(Number(altman.prior.value_q))).toBe(true);
      expect(served.rows.some((r) => r.delta.unit === "turns" && r.delta.pct_change !== null)).toBe(true);
      expect(served.rows.some((r) => r.prior.value_q === null)).toBe(true);
      expect(served.band_movements.improved.length).toBeGreaterThan(0);
      expect(served.band_movements.deteriorated.length).toBeGreaterThan(0);
    });

    it.each(keys)("B1/B2 %s: the tab, the report and the workbook print the same six cells and embed the same served row", (key) => {
      const row = read.served.get(key) as RatioCompareRow;
      const handle = serializeRatioCompareRow(row);
      const tab = read.tab.get(key);
      expect(tab, `${key}: no row on the Ratios tab`).toBeDefined();
      expect(tab!.handle, `${key}: the tab's handle is not the served row`).toBe(handle);
      const inReport = read.report.get(key) ?? [];
      expect(inReport.length, `${key}: no six-column row in the report`).toBeGreaterThan(0);
      for (const r of inReport) {
        expect(r.handle, `${key}: a report handle is not the served row`).toBe(handle);
        expect(r.cells, `${key}: the report's six cells differ from the tab's`).toEqual(tab!.cells);
      }
      const wb = read.workbook.get(key);
      expect(wb, `${key}: no single row in the workbook Ratios sheet`).toBeDefined();
      expect(wb, `${key}: the workbook's six cells differ from the tab's`).toEqual(tab!.cells);
      for (const cell of tab!.cells) {
        expect(cell, `${key}: a blank or dash cell`).not.toMatch(/^(|—|-|–)$/);
      }
    });

    it.each(keys)("B5 %s: the same name beside the six cells on the tab, in the report and in the workbook — the i18n label", (key) => {
      const authority = ratioLabelForKey(key, "en");
      expect(authority, `${key}: the one label authority names no label for a served key`).not.toBeNull();
      expect(read.labels.tab.get(key), `${key}: the tab's name is not the authority's`).toBe(authority);
      const inReport = read.labels.report.get(key) ?? [];
      expect(inReport.length, `${key}: no name beside the six cells in the report`).toBeGreaterThan(0);
      for (const name of inReport) expect(name, `${key}: the report's name differs from the tab's`).toBe(authority);
      expect(read.labels.workbook.get(key), `${key}: the workbook's name differs from the tab's`).toBe(authority);
    });

    it("B5 the six column headings are one string on the tab, in the report and in the workbook — the i18n words", () => {
      const authority = ratioCompareHeadingsFor(served.current_label, served.prior_label, "en");
      expect(authority[2]).toBe(i18n.getFixedT("en")("statements.ratioCmp.ui.colChange"));
      expect(authority.every((h) => h.length > 0)).toBe(true);
      expect(read.headings.tab).toEqual(authority);
      expect(read.headings.workbook).toEqual(authority);
      expect(read.headings.report.length, "no heading set in the report").toBeGreaterThanOrEqual(keys.length);
      for (const set of read.headings.report) expect(set, "a report heading set differs from the tab's").toEqual(authority);
    });

    it("B2 every report element embedding a served row embeds it byte for byte", () => {
      expect(read.reportHandles.length).toBeGreaterThanOrEqual(keys.length);
      for (const { key, handle } of read.reportHandles) {
        expect(read.served.has(key), `${key}: the report embeds a row the comparison does not serve`).toBe(true);
        expect(handle, key).toBe(serializeRatioCompareRow(read.served.get(key) as RatioCompareRow));
        expect(handle, key).toBe(read.tab.get(key)?.handle);
      }
    });

    it.each(["improved", "deteriorated"] as const)(
      "B3 the %s list: the served order and the same cells on the tab, in the report summary and in the workbook",
      (kind) => {
        const want = served.band_movements[kind];
        const l = read.lists[kind];
        expect(l.tab.map((e) => e.key)).toEqual(want);
        expect(l.report.map((e) => e.key)).toEqual(want);
        expect(l.workbook.map((e) => e.key)).toEqual(want);
        for (let i = 0; i < want.length; i += 1) {
          const handle = serializeRatioCompareRow(read.served.get(want[i]) as RatioCompareRow);
          expect(l.tab[i].handle, want[i]).toBe(handle);
          expect(l.report[i].handle, want[i]).toBe(handle);
          expect(l.report[i].cells, `${want[i]}: report summary vs tab list`).toEqual(l.tab[i].cells);
          expect(l.workbook[i].cells, `${want[i]}: workbook Band movements vs tab list`).toEqual(l.tab[i].cells);
          // …and the list's cells are the table row's cells
          const t = read.tab.get(want[i])!.cells;
          expect(l.tab[i].cells, `${want[i]}: list vs table`).toEqual([t[1], t[0], t[2], t[5]]);
        }
      },
    );
  });
}
