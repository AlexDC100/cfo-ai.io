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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

// ── B6 ── the export-side served-row paths compute nothing (source gate) ──
//
// The B8 verifier's plant A8: the workbook's pp change recomputed in the
// browser as Number(current.value_q) − Number(prior.value_q), printed with
// toFixed(1) — the SAME bytes as the served cell, so B1–B5 above stay green
// and so does every other ratio gate. The rule "no FE arithmetic on served
// values" was enforced on the tab (ratioCompareTab G6, whole files) and on
// reportComparatives.ts (whole module), but the report and the workbook
// build their six cells inside closures of two very large files that DO
// compute elsewhere (`computeRatios`, the cash-flow walk), so a whole-file
// scan cannot hold them. This gate extracts exactly the served-row code
// paths — each closure's body by balanced braces from source with comments
// and quoted strings blanked (template literals are kept: their `${…}` are
// code) — and asserts no number is parsed, rounded, formatted or operated
// on inside them. Non-vacuity: every extracted body must be the real path
// (it prints through `printRatioCompareRow` / the served `printed` cells,
// and is longer than a stub).
//
// Reds on: `toFixed`, `toPrecision`, `Math.*`, `parseFloat`, `parseInt`,
// `Number(`, unary `+` coercion of a served value, `Intl.NumberFormat`,
// `toLocaleString`, or an arithmetic operator applied to a served `.value`
// / `.value_q`, a cast to `number`, or ANY binary `-` `*` `/` `%` between two
// operands (an alias of a served value carries no `.value` to match),
// anywhere inside `sixCells`, the workbook's whole Ratios-sheet builder, `ratioCmpCells`, `ratioCmpCardTable`, `servedOnlyRatioTable`,
// `bandMovementsBlock`, `ratioCmpBasisClause`, `creditMovementBlock` or
// `buildBandMovements`; a named path that no longer exists (renamed or
// inlined out of the scan). Cannot see: arithmetic in a helper these paths
// call from another module (ratioCompareView.ts is under G6; a new helper
// module would need adding here), or a recompute outside the named paths
// that is then fed in as a string.

describe("B6 the export-side served-row paths print the served row and compute nothing (source gate)", () => {
  const REPO = resolve(__dirname, "../../..");
  const read = (rel: string): string => readFileSync(resolve(REPO, rel), "utf8");

  /** Comments and quoted strings blanked. A template literal keeps its
   *  `${…}` expressions (they are code) and loses its TEXT (markup like
   *  `data-ratio-key`, `</td>` is not arithmetic). */
  function codeOnly(src: string): string {
    return scan(src, 0, false).out;
  }

  /** Scans from `start`; when `inExpr`, stops at the `}` closing a `${`. */
  function scan(src: string, start: number, inExpr: boolean): { out: string; end: number } {
    let out = "";
    let i = start;
    let depth = 0;
    while (i < src.length) {
      const two = src.slice(i, i + 2);
      if (src[i] === "`") {
        // template literal: keep only its expressions
        i += 1;
        out += "`";
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "$" && src[i + 1] === "{") {
            const inner = scan(src, i + 2, true);
            out += "${" + inner.out + "}";
            i = inner.end + 1;
            continue;
          }
          i += 1;
        }
        i += 1;
        out += "`";
        continue;
      }
      if (inExpr && src[i] === "{") depth += 1;
      if (inExpr && src[i] === "}") {
        if (depth === 0) return { out, end: i };
        depth -= 1;
      }
      if (two === "//") {
        while (i < src.length && src[i] !== "\n") i += 1;
        continue;
      }
      if (two === "/*") {
        const end = src.indexOf("*/", i + 2);
        i = end === -1 ? src.length : end + 2;
        continue;
      }
      const ch = src[i];
      if (ch === '"' || ch === "'") {
        i += 1;
        while (i < src.length && src[i] !== ch && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
        i += 1;
        out += '""';
        continue;
      }
      out += ch;
      i += 1;
    }
    return { out, end: i };
  }

  /** The `{…}` body starting at the first `{` at or after `from`, by balanced braces. */
  function braced(code: string, from: number, what: string): string {
    const open = code.indexOf("{", from);
    expect(open, `${what}: no body`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) return code.slice(open, i + 1);
      }
    }
    throw new Error(`${what}: unbalanced braces`);
  }

  /** The body of `const <name> = (…) => {…}`. */
  function closure(code: string, name: string): string {
    const at = code.indexOf(`const ${name} = (`);
    expect(at, `${name}: the closure is gone from the scan (renamed or inlined?)`).toBeGreaterThan(-1);
    const arrow = code.indexOf("=>", at);
    expect(arrow, `${name}: not an arrow closure`).toBeGreaterThan(at);
    return braced(code, arrow, name);
  }

  /** The code between two anchors (both must exist, in order). */
  function region(code: string, from: string, to: string, what: string): string {
    const a = code.indexOf(from);
    expect(a, `${what}: start anchor gone`).toBeGreaterThan(-1);
    const b = code.indexOf(to, a);
    expect(b, `${what}: end anchor gone`).toBeGreaterThan(a);
    return code.slice(a, b);
  }

  const ARITHMETIC: readonly RegExp[] = [
    /\.toFixed\(/,
    /\.toPrecision\(/,
    /\bMath\.\w+\(/,
    /\bparseFloat\(/,
    /\bparseInt\(/,
    /\bNumber\(/,
    /\bIntl\.NumberFormat\b/,
    /\.toLocaleString\(/,
    // a served value operated on: `x.value - y.value`, `row.delta.value * 100`
    /\.value(?:_q)?\s*[-+*/%](?!=)/,
    /[-+*/%]\s*[\w.]*\.value(?:_q)?\b/,
    // unary-plus coercion of a served string: `+row.current.value_q`
    /[(=,?:]\s*\+[\w.]+\.value(?:_q)?\b/,
    // AN ALIAS GETS PAST `.value` RULES (repair-round plant A8-alias:
    // `const cq = row.current.value_q as unknown as number; cq * 1 - pq * 1`).
    // So: nothing is cast to a number, and no binary `-`, `*`, `/` or `%`
    // stands between two operands anywhere in a served-row path. (`+` is
    // left to the rules above: these paths concatenate strings.)
    /\bas\s+(?:unknown\s+as\s+)?number\b/,
    /[\w)\]]\s*[-*/%]\s*[\w(]/,
    // ALIAS ARITHMETIC WITHOUT A BINARY MINUS (surfaces re-verify plant:
    // `const cq: any = row.current.value_q; const d = +cq + (-pq);` then
    // `String(d).slice(0, 3)` - 144 passed with the pp change recomputed).
    // So: no unary `+` / `-` on a name or a parenthesis, no `+` of a
    // negated operand, nothing typed or cast to `any` (the door every
    // alias walks through), and no String()/slice() re-printing of a value.
    /(?:[(=,?:]|\breturn)\s*[+-]\s*[A-Za-z_(]/,
    /\+\s*\(?\s*-\s*[\w(]/,
    /:\s*any\b/,
    /\bas\s+any\b/,
    // (`String(u.band ?? "")` names a band and is left alone; a String()
    // whose result is then cut or rewritten is a re-print.)
    /\bString\([^)]*\)\s*\./,
    /\.slice\(/,
    /\.substring\(/,
  ];

  const exportsCode = codeOnly(read("frontend/lib/financialExports.ts"));
  const reportCode = codeOnly(read("frontend/lib/financialReport.ts"));
  const summaryCode = codeOnly(read("frontend/lib/executiveSummary.ts"));

  const PATHS: Record<string, string> = {
    "financialExports.ts sixCells": closure(exportsCode, "sixCells"),
    // THE WHOLE Ratios-sheet builder, not two pieces of it: the served-only
    // census loop and the credit_composite / letter_grade loop print served
    // rows too, and sat between the two scanned pieces (repair-round plant
    // X_b6gap: the pp change recomputed in the served-only loop, all green).
    "financialExports.ts Ratios-sheet builder": region(
      exportsCode,
      "const ratioCmp = servedRatioComparison(s);",
      'XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ratioRows), "")',
      "workbook Ratios sheet",
    ),
    "financialReport.ts ratioCmpCells": closure(reportCode, "ratioCmpCells"),
    "financialReport.ts ratioCmpCardTable": closure(reportCode, "ratioCmpCardTable"),
    "financialReport.ts servedOnlyRatioTable": closure(reportCode, "servedOnlyRatioTable"),
    "financialReport.ts bandMovementsBlock": closure(reportCode, "bandMovementsBlock"),
    "financialReport.ts ratioCmpBasisClause": closure(reportCode, "ratioCmpBasisClause"),
    "financialReport.ts creditMovementBlock": closure(reportCode, "creditMovementBlock"),
    "executiveSummary.ts buildBandMovements": braced(
      summaryCode,
      summaryCode.indexOf("export function buildBandMovements("),
      "buildBandMovements",
    ),
  };

  it("B6 non-vacuity: every named path is extracted whole and is the real served-row path", () => {
    expect(Object.keys(PATHS).length).toBe(9);
    for (const [name, body] of Object.entries(PATHS)) {
      expect(body.length, `${name}: too short to be the real path`).toBeGreaterThan(200);
      expect(
        /printRatioCompareRow\(|printedRatioCells\(|ratioCmpCells\(|\.printed\b|ratioCmpRows\.get\(|ratioCmp\.(stamps|rows)|band_movements|servedMovableRows\(/.test(body),
        `${name}: does not read the served row`,
      ).toBe(true);
    }
  });

  it.each(Object.entries(PATHS))("B6 %s parses, rounds, formats and operates on no number", (name, body) => {
    for (const rx of ARITHMETIC) {
      const hit = body.match(rx);
      expect(hit, `${name}: browser arithmetic on a served value — ${rx} matched ${JSON.stringify(hit?.[0])}`).toBeNull();
    }
  });
});
