// B7 — THE EXPORTS READ BOTH PERIODS' RATIOS OFF THE SERVED TABLE.
//
// The owner's brief: every ratio gets [current] [prior] [Δ] [band now]
// [band prior] [band movement] in the exported report as on the dashboard,
// same columns, same numbers; band movement is the headline, with improved
// and deteriorated lists in the executive summary; the prior exists for
// every ratio and composite (Altman, credit score, letter grade), and a
// prior that cannot be computed states why, never a dash.
//
// The engine serves all of it once (`GET /api/period/{id}/comparatives →
// ratios`, `src/engine/comparatives/ratio_compare.py`). This file renders
// the REAL report HTML (so the PDF, which is that HTML) and the REAL
// workbook over the served block captured from the composer
// (`tests/engine/fixtures/firm/served_ratio_pair.json`) and asserts, over
// the produced bytes, that every surface READS the served row.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  §1  a served ratio or composite that reaches neither a card nor a table
//      row of the document; a row in the document the served table does
//      not carry; an embedded `data-ratio-cmp-json` that is not the served
//      row serialised (a surface re-deriving or re-shaping the row).
//  §2  a printed cell whose digits are not the served quantized string —
//      an exporter formatting a value, a prior or a delta of its own; a
//      refused side printed as a dash, a blank or a zero.
//  §3  a planted served value that some surface (card, credit section,
//      executive summary, workbook) does not print: the surface computed
//      instead of reading.
//  §4  a card whose headline figure and served current cell disagree on
//      the committed pair — one ratio, two values, one card.
//  §5  the credit section without the prior letter, composite and Altman,
//      or with a movement the served composite row does not state.
//  §6  a prior that cannot be computed printed as a dash, a blank, a zero
//      or a number, on any surface, or without its reason.
//  §7  a document with no comparison that grows six-column tables or a
//      band-movement block claiming a comparison nobody supplied.
//  §8  the band-movement headline missing from the top of page one, out of
//      served order, shorter than the served lists (a demoted crossing
//      dropped), or with counts that are not the served counts.
//  §9  a workbook Ratios sheet without the six columns, with cells that
//      differ from the document's, or with a Band movements block in a
//      different order than the document's lists.
//  §10 `SERVED_RATIO_KEY_OF` drifting from the `fe_key` column of
//      `src/engine/ratios/table.py`.
//
// ── WHAT IT CANNOT SEE ────────────────────────────────────────────────
//  · whether the served figures are RIGHT — the engine gates
//    (`tests/engine/test_ratio_compare.py`) own that.
//  · the dashboard tile. Its byte-match against these same attributes is
//    batch B8's cross-surface gate, which needs the B6 tab.
//  · the PDF text layer, which `threeWayParity.test.ts` reads.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import {
  printedRatioCells,
  printRatioCompareRow,
  priorRatioAbsence,
  serializeRatioCompareRow,
  SERVED_RATIO_KEY_OF,
} from "@/lib/financialReport";
import { NO_COMPARATIVE_CELL, NO_COMPARATIVES_NOTE } from "@/lib/reportComparatives";
import { reasonText, type RatioCompareRow, type RatioComparisonV1 } from "@/lib/ratioTable";

import { metricsFor, statementsFor } from "./exportBooks";
import { pairEnvelopes, pairStatements, servedRatioPair, servedRatiosCopy } from "./servedRatioPair";

const DASHES = new Set(["—", "–", "-", "", "0", "0.00", "n/a", "N/A"]);
const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

function reportDoc(ratios?: RatioComparisonV1 | null): Document {
  const html = buildReportHtml(pairStatements(ratios), pairEnvelopes());
  return new DOMParser().parseFromString(html, "text/html");
}

function ratiosSheet(ratios?: RatioComparisonV1 | null, s = pairStatements(ratios)): string[][] {
  const wb = buildExcelWorkbook(s, undefined, pairEnvelopes());
  return (XLSX.utils.sheet_to_json(wb.Sheets.Ratios, { header: 1, raw: false, defval: "" }) as unknown[][]).map((r) =>
    r.map((c) => String(c ?? "")),
  );
}

function servedRows(ratios: RatioComparisonV1 = servedRatioPair().ratios): Map<string, RatioCompareRow> {
  return new Map([...ratios.rows, ...ratios.composites].map((r) => [r.key, r]));
}

/** Every element carrying a served row, with the key it names. */
function embedded(doc: Document): Array<{ key: string; json: string; el: Element }> {
  return Array.from(doc.querySelectorAll("[data-ratio-cmp-json]")).map((el) => {
    const json = el.getAttribute("data-ratio-cmp-json") as string;
    return { key: (JSON.parse(json) as { key: string }).key, json, el };
  });
}

/** The six cells of the card table (or table row) for one served key. */
function cardCells(doc: Document, key: string): string[] {
  const table = doc.querySelector(`.ratio-card table.ratio-cmp[data-ratio-cmp="${key}"]`);
  if (table) return Array.from(table.querySelectorAll("td")).map(text);
  const tr = doc.querySelector(`table.ratio-cmp-served-only tr[data-ratio-cmp="${key}"]`);
  if (tr) return Array.from(tr.querySelectorAll("td")).slice(1).map(text);
  throw new Error(`the document carries no six-column row for ${key}`);
}

// ── §0 non-vacuity ─────────────────────────────────────────────────────

describe("§0 the served pair has something to bite on", () => {
  it("crossings both ways, a refused prior, a not-comparable composite and a demoted finding", () => {
    const r = servedRatioPair().ratios;
    expect(r.band_movements.improved.length).toBeGreaterThan(0);
    expect(r.band_movements.deteriorated.length).toBeGreaterThan(0);
    expect(r.rows.some((row) => row.prior.value_q === null && row.current.value_q !== null)).toBe(true);
    expect(r.band_movements.not_comparable.length).toBeGreaterThan(0);
    expect(r.band_movements.findings.some((f) => (f as { demoted?: boolean }).demoted === true)).toBe(true);
    expect(r.composites.map((c) => c.key)).toEqual(["altman_z", "credit_composite", "letter_grade"]);
    for (const c of r.composites) expect(c.prior.value_q, `${c.key} prior`).not.toBeNull();
  });
});

// ── §1 every served row, embedded byte for byte ────────────────────────

describe("§1 every served ratio and composite reaches the document with its served row", () => {
  const doc = reportDoc();
  const served = servedRows();
  const found = embedded(doc);

  it("coverage both ways: every served key is embedded, nothing unserved is", () => {
    const keys = new Set(found.map((f) => f.key));
    expect([...served.keys()].filter((k) => !keys.has(k)), "served rows missing from the document").toEqual([]);
    expect([...keys].filter((k) => !served.has(k)), "rows the served table does not carry").toEqual([]);
    expect(keys.size).toBe(31); // 28 census rows + 3 composites
  });

  it("every embedded string IS the served row, serialised canonically", () => {
    for (const f of found) {
      const row = served.get(f.key) as RatioCompareRow;
      expect(JSON.parse(f.json), `${f.key}: the embedded row is not the served row`).toEqual(row);
      expect(f.json, `${f.key}: a second serialisation`).toBe(serializeRatioCompareRow(row));
    }
  });

  it("the serialisation sorts keys at every depth and drops nothing", () => {
    const row = served.get("current_ratio") as RatioCompareRow;
    const json = serializeRatioCompareRow(row);
    expect(Object.keys(JSON.parse(json))).toEqual(Object.keys(row).sort());
    expect(json).not.toMatch(/\s/);
  });
});

// ── §2 printed cells are the served strings ────────────────────────────

describe("§2 each of the six cells prints the served string, never a figure of its own", () => {
  const doc = reportDoc();
  it("value_q, the prior's value_q and delta.value appear verbatim; refusals are sentences", () => {
    let figures = 0;
    let refusals = 0;
    for (const row of servedRows().values()) {
      const [cur, pri, delta, bandNow, bandPrior, movement] = cardCells(doc, row.key);
      for (const [cell, side, name] of [
        [cur, row.current, "current"],
        [pri, row.prior, "prior"],
      ] as const) {
        if (side.value_q !== null) {
          expect(cell, `${row.key} ${name}`).toContain(side.value_q);
          figures += 1;
        } else {
          expect(cell, `${row.key} ${name} refused`).toBe(reasonText(side.reason?.code, "en", side.reason?.inputs));
          expect(DASHES.has(cell), `${row.key} ${name} is a dash`).toBe(false);
          refusals += 1;
        }
      }
      if (row.delta.value !== null) expect(delta, `${row.key} delta`).toContain(row.delta.value);
      else expect(delta, `${row.key} delta refused`).toBe(reasonText(row.delta.reason_code, "en"));
      for (const cell of [bandNow, bandPrior, movement]) {
        expect(DASHES.has(cell), `${row.key}: a band cell is a dash`).toBe(false);
      }
      if (row.movement.status === "crossed_up" || row.movement.status === "crossed_down") {
        expect(movement, `${row.key} movement`).toContain("→");
      }
    }
    expect(figures).toBeGreaterThan(40);
    expect(refusals).toBeGreaterThan(0);
  });
});

// ── §3 a planted served value is what every surface prints ─────────────

describe("§3 plant one served row: every export surface prints the plant", () => {
  const planted = servedRatiosCopy();
  const row = planted.rows.find((r) => r.key === "current_ratio") as RatioCompareRow;
  // Values no statement of either book produces: a surface that computed
  // the ratio would print 2.10× / 1.82× instead.
  row.current.value_q = "4.56";
  row.prior.value_q = "9.87";
  row.delta.value = "-5.31";
  const altman = planted.composites.find((r) => r.key === "altman_z") as RatioCompareRow;
  altman.prior.value_q = "1.23";

  it("the card, the executive summary, the credit section and the workbook", () => {
    const doc = reportDoc(planted);
    expect(cardCells(doc, "current_ratio").slice(0, 3)).toEqual(["4.56×", "9.87×", "-5.31× (+15.4%)"]);
    const li = doc.querySelector('[data-band-crossing="current_ratio"]');
    expect(text(li)).toContain("9.87×");
    expect(text(li)).toContain("4.56×");
    expect(text(doc.querySelector('[data-credit-movement="altman_z"]'))).toContain("1.23");
    expect(cardCells(doc, "altman_z")[1]).toBe("1.23");
    const wbRow = ratiosSheet(planted).find((r) => r[1] === "Current Ratio") as string[];
    expect(wbRow.slice(2, 5)).toEqual(["4.56×", "9.87×", "-5.31× (+15.4%)"]);
  });
});

// ── §4 the headline and the served current cell are one value ──────────

describe("§4 a card never prints one figure in its headline and another in its table", () => {
  it("every card with a six-column table, on the committed pair", () => {
    const doc = reportDoc();
    let checked = 0;
    for (const card of Array.from(doc.querySelectorAll(".ratio-card"))) {
      const table = card.querySelector("table.ratio-cmp[data-ratio-cmp-json]");
      if (!table) continue;
      const headline = text(card.querySelector(".value")).replace(/ \/ 100$/, "");
      const current = text(table.querySelector('td[data-cell="current"]'));
      const row = JSON.parse(table.getAttribute("data-ratio-cmp-json") as string) as RatioCompareRow;
      if (row.current.value_q === null) {
        expect(headline, `${row.key}: the served current is refused, the card prints a figure`).toBe("not reported");
      } else {
        expect(current, `${row.key}: card headline ${headline}, served current ${current}`).toBe(headline);
      }
      checked += 1;
    }
    expect(checked).toBe(25); // 22 computeRatios cards + composite + letter + Altman
  });
});

// ── §5 the credit section carries the prior and the movement ───────────

describe("§5 credit section — prior letter, composite and Altman, and what moved", () => {
  it("each composite line quotes the served prior, current, change and movement", () => {
    const doc = reportDoc();
    const block = doc.querySelector('[data-report-credit-movement="served"]');
    expect(block, "the credit section states no prior").toBeTruthy();
    for (const row of servedRatioPair().ratios.composites) {
      const li = doc.querySelector(`[data-credit-movement="${row.key}"]`);
      const p = printRatioCompareRow(row, row.key);
      expect(text(li), row.key).toContain(`${servedRatioPair().prior_label} ${p.prior}`);
      expect(text(li), row.key).toContain(`${servedRatioPair().current_label} ${p.current}`);
      expect(text(li), row.key).toContain(p.delta);
      expect(text(li), row.key).toContain(p.movement);
    }
    expect(text(doc.querySelector('[data-credit-movement="letter_grade"]'))).toContain("A → AA");
    expect(cardCells(doc, "letter_grade")).toEqual(["AA", "A", "+1 notch", "AA", "A", "A → AA"]);
  });
});

// ── §6 a prior that cannot be computed states why ──────────────────────

describe("§6 a prior that cannot be computed states why — never a dash", () => {
  it("a served refused prior: the sentence, on the card and in the workbook", () => {
    const doc = reportDoc();
    const row = servedRows().get("interest_coverage") as RatioCompareRow;
    expect(row.prior.value_q).toBeNull();
    const sentence = reasonText(row.prior.reason?.code, "en", row.prior.reason?.inputs);
    expect(cardCells(doc, "interest_coverage")[1]).toBe(sentence);
    const wb = ratiosSheet().find((r) => r[1] === "Interest Coverage (EBITDA / Interest)") as string[];
    expect(wb[3]).toBe(sentence);
  });

  it("a served refused prior COMPOSITE: the credit section says so", () => {
    const planted = servedRatiosCopy();
    const altman = planted.composites.find((r) => r.key === "altman_z") as RatioCompareRow;
    altman.prior = { ...altman.prior, value: null, value_q: null, band: null, band_status: "refused",
      ladder: null, ladder_floor: null, reason: { code: "credit_inputs_absent", inputs: [] } };
    const doc = reportDoc(planted);
    const li = text(doc.querySelector('[data-credit-movement="altman_z"]'));
    expect(li).toContain(reasonText("credit_inputs_absent", "en"));
    expect(cardCells(doc, "altman_z")[1]).toBe(reasonText("credit_inputs_absent", "en"));
  });

  it("a comparison that reached the export without its table: every prior cell states the reason", () => {
    const s = pairStatements(null);
    const reason = priorRatioAbsence(s);
    expect(reason).toMatch(/without/);
    const doc = new DOMParser().parseFromString(buildReportHtml(s, pairEnvelopes()), "text/html");
    const tables = Array.from(doc.querySelectorAll('table.ratio-cmp[data-ratio-cmp-absent="table"]'));
    expect(tables.length).toBe(25);
    for (const t of tables) {
      const cells = Array.from(t.querySelectorAll("td"));
      for (const i of [1, 2, 4, 5]) {
        expect(text(cells[i])).toBe(NO_COMPARATIVE_CELL);
        expect(cells[i].getAttribute("title")).toBe(reason);
      }
      expect(DASHES.has(text(cells[0]))).toBe(false);
    }
    expect(text(doc.querySelector('[data-report-credit-movement="absent"]'))).toContain(reason);
    expect(text(doc.querySelector('[data-band-movements="absent"]'))).toContain(reason);
    expect(doc.querySelector("[data-ratio-cmp-json]")).toBeNull();
    for (const r of ratiosSheet(null, s).filter((row) => row[0] === "Liquidity")) {
      expect([r[3], r[4], r[6], r[7]]).toEqual([reason, reason, reason, reason]);
    }
  });
});

// ── §7 no comparison at all ────────────────────────────────────────────

describe("§7 a book with no comparison claims none", () => {
  it("no six-column tables, no band block, no credit movement; the workbook says no prior period", () => {
    const doc = new DOMParser().parseFromString(
      buildReportHtml(statementsFor("agras"), { metricsByName: metricsFor("agras") }),
      "text/html",
    );
    expect(doc.querySelector("table.ratio-cmp, [data-band-movements], [data-report-credit-movement]")).toBeNull();
    const wb = buildExcelWorkbook(statementsFor("agras"), undefined, { metricsByName: metricsFor("agras") });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets.Ratios, { header: 1, raw: false, defval: "" }) as string[][];
    expect(rows[0].slice(2, 8)).toEqual(["Imported period", NO_COMPARATIVES_NOTE, "Δ", "Band now", "Band prior", "Band movement"]);
    const current = rows.find((r) => r[1] === "Current Ratio") as string[];
    expect([current[3], current[4], current[6], current[7]]).toEqual(Array(4).fill(NO_COMPARATIVE_CELL));
    expect(rows.some((r) => r[0] === "no prior period was supplied with this book")).toBe(true);
  });
});

// ── §8 the headline on page one ────────────────────────────────────────

describe("§8 executive summary — band movement is the headline, in served order", () => {
  const served = servedRatioPair().ratios;

  it("the block opens the executive summary, above the overall verdict", () => {
    const doc = reportDoc();
    const body = doc.querySelector("#sec-exec .rsec-body") as Element;
    const first = Array.from(body.children)[0];
    expect(first.getAttribute("data-band-movements")).toBe("served");
    expect(text(body).indexOf("Band movements")).toBeLessThan(text(body).indexOf("Overall verdict"));
  });

  it("improved and deteriorated lists are the served lists, whole and in order", () => {
    const doc = reportDoc();
    const keys = (kind: string) =>
      Array.from(doc.querySelectorAll(`ul[data-band-list="${kind}"] li`)).map((li) => li.getAttribute("data-band-crossing"));
    expect(keys("improved")).toEqual(served.band_movements.improved);
    expect(keys("deteriorated")).toEqual(served.band_movements.deteriorated);
    const demoted = Array.from(doc.querySelectorAll('[data-finding-status="demoted"]'));
    expect(demoted.length).toBe(served.band_movements.findings.filter((f) => (f as { demoted?: boolean }).demoted).length);
    for (const li of demoted) expect(text(li)).toContain("listed as a check: the finding is missing");
  });

  it("the counts are the served partition", () => {
    const bm = served.band_movements;
    expect(bm.improved.length + bm.deteriorated.length + bm.unchanged.length + bm.not_comparable.length).toBe(
      served.coverage.both_sides,
    );
    const basis = text(reportDoc().querySelector("[data-band-basis]"));
    expect(basis).toContain(`${served.coverage.both_sides} ratios and composites are valued in both periods`);
    expect(basis).toContain(`moved up a band ${bm.improved.length}, moved down ${bm.deteriorated.length}`);
    expect(basis).toContain(`held their band ${bm.unchanged.length}, not comparable ${bm.not_comparable.length}`);
  });

  it("plant: the served order reversed is the order printed — the document never re-ranks", () => {
    const planted = servedRatiosCopy();
    planted.band_movements.improved = [...planted.band_movements.improved].reverse();
    const doc = reportDoc(planted);
    expect(
      Array.from(doc.querySelectorAll('ul[data-band-list="improved"] li')).map((li) => li.getAttribute("data-band-crossing")),
    ).toEqual(planted.band_movements.improved);
  });

  it("plant: an empty served list prints the non-vacuous absence, not an empty heading", () => {
    const planted = servedRatiosCopy();
    planted.band_movements.deteriorated = [];
    const doc = reportDoc(planted);
    expect(text(doc.querySelector('[data-band-list="deteriorated"][data-band-list-empty]'))).toBe(
      "no ratio moved down a band between Dec 2024 and Dec 2025.",
    );
  });

  it("the two ratio tiles read the served row: current and change", () => {
    const doc = reportDoc();
    for (const [tile, key] of [["equity_ratio", "equity_ratio"], ["net_debt_ebitda", "net_debt_to_ebitda"]]) {
      const row = servedRows().get(key) as RatioCompareRow;
      const cells = Array.from(doc.querySelectorAll(`tr[data-tile="${tile}"] td`)).map(text);
      expect(cells[1], tile).toContain(row.current.value_q as string);
      expect(cells[2], tile).toContain(row.delta.value as string);
    }
  });
});

// ── §9 the workbook ────────────────────────────────────────────────────

describe("§9 workbook — the six columns and the band movements, same as the document", () => {
  const rows = ratiosSheet();
  const doc = reportDoc();

  it("the header names both served periods and the four movement columns", () => {
    expect(rows[0]).toEqual([
      "Group", "Ratio", "Dec 2025", "Dec 2024", "Δ", "Band now", "Band prior", "Band movement", "Benchmark", "Commentary",
    ]);
  });

  it("every ratio row's six cells equal the document's six cells, key for key", () => {
    let matched = 0;
    for (const row of servedRows().values()) {
      const docCells = cardCells(doc, row.key);
      const hit = rows.filter((r) => r[1] !== "" && r.slice(2, 8).join("|") === docCells.join("|"));
      expect(hit.length, `${row.key}: the workbook prints ${JSON.stringify(docCells)} nowhere`).toBeGreaterThan(0);
      expect(docCells).toEqual(printedRatioCells(printRatioCompareRow(row, row.key)));
      matched += 1;
    }
    expect(matched).toBe(31);
  });

  it("the Band movements block lists the document's crossings in the document's order", () => {
    const start = rows.findIndex((r) => r[0] === "Band movements");
    expect(start).toBeGreaterThan(0);
    const block = rows.slice(start);
    const labelsOf = (kind: string) => block.filter((r) => r[0] === kind).map((r) => r[1]);
    const docLabels = (kind: string) =>
      Array.from(doc.querySelectorAll(`ul[data-band-list="${kind}"] li strong`)).map(text);
    expect(labelsOf("Improved")).toEqual(docLabels("improved"));
    expect(labelsOf("Deteriorated")).toEqual(docLabels("deteriorated"));
    expect(labelsOf("Improved").length).toBe(servedRatioPair().ratios.band_movements.improved.length);
  });

  it("the Altman row is the served composite row", () => {
    const altman = rows.find((r) => r[0] === "Bankruptcy") as string[];
    const row = servedRows().get("altman_z") as RatioCompareRow;
    expect(altman.slice(2, 8)).toEqual(printedRatioCells(printRatioCompareRow(row, "")));
  });
});

// ── §10 the key mirror ─────────────────────────────────────────────────

describe("§10 SERVED_RATIO_KEY_OF mirrors the engine census", () => {
  it("every _Spec whose fe_key differs from its key, and no other", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/engine/ratios/table.py"), "utf-8");
    const specs = [...src.matchAll(/_Spec\("([a-z_]+)",\s*"[a-z]+",\s*"[a-z]+",\s*(?:True|False),\s*(None|"([a-z_]+)")/g)];
    expect(specs.length).toBe(28);
    const differing: Record<string, string> = {};
    for (const m of specs) if (m[3] && m[3] !== m[1]) differing[m[3]] = m[1];
    expect(SERVED_RATIO_KEY_OF).toEqual(differing);
  });
});
