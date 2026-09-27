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
//  §4  on ANY of the twelve ordered corpus pairs: a card whose headline
//      figure is not its served current cell, whose badge is not its "Band
//      now" cell, or whose benchmark does not print the served ladder — one
//      ratio, two ladders, one card (the four declared ladder divergences
//      bite on retail as the current period).
//  §5  the credit section without the prior letter, composite and Altman,
//      or with a movement the served composite row does not state.
//  §6  a prior that cannot be computed printed as a dash, a blank, a zero
//      or a number, on any surface, or without its reason IN THE CELL; a
//      report cell that differs from the workbook cell for the same state;
//      "no prior period" under a heading that names the prior period (the
//      production shape before B6: `prior` attached, no comparatives).
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
//  §11 a delta or band-movement cell (card, served-only table, crossing
//      line, credit movement, executive tile) whose tone is not the served
//      verdict's, or a stylesheet that paints improvement and deterioration
//      in the wrong colours.
//  §12 a served block of partial shape that throws out of an export instead
//      of degrading with a stated reason.
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
  computeRatios,
  printedRatioCells,
  printRatioCompareRow,
  priorRatioAbsence,
  ratioRowAbsence,
  serializeRatioCompareRow,
  servedLadderSentence,
  servedRatioKey,
  SERVED_RATIO_KEY_OF,
  verdictLabel,
  type Statements,
} from "@/lib/financialReport";
import { NO_COMPARATIVE_CELL, NO_COMPARATIVES_NOTE } from "@/lib/reportComparatives";
import { formatRatioBand, ratioCompareHeadingsFor, reasonText, type RatioCompareRow, type RatioComparisonV1 } from "@/lib/ratioTable";

import { metricsFor, statementsFor } from "./exportBooks";
import { ratioSurfacesOf } from "@/lib/useRatioSurfaces";
import { statementsForExportOf } from "@/lib/comparatives";
import {
  corpusPairEnvelopes,
  corpusPairKeys,
  corpusPairStatements,
  pairEnvelopes,
  pairStatements,
  pairStatementsWithoutComparatives,
  servedCorpusPairs,
  servedRatioPair,
  servedRatiosCopy,
} from "./servedRatioPair";

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
    // A demoted crossing is no longer natural on any corpus pair (the R2b
    // rulings gave every crossing an impact); the engine-planted variant
    // carries one, and §8 renders over it.
    const planted = servedCorpusPairs().demoted_planted.ratios;
    expect(planted.band_movements.findings.some((f) => (f as { demoted?: boolean }).demoted === true)).toBe(true);
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
    const wbRow = ratiosSheet(planted).find((r) => r[1] === "Current ratio") as string[];
    expect(wbRow.slice(2, 5)).toEqual(["4.56×", "9.87×", "-5.31× (+15.4%)"]);
  });

  it("the card HEADLINE prints the planted served string, not a figure of the statements", () => {
    const doc = reportDoc(planted);
    const card = doc.querySelector('.ratio-card table.ratio-cmp[data-ratio-cmp="current_ratio"]')?.closest(".ratio-card");
    expect(text(card?.querySelector(".value"))).toBe("4.56×");
  });

  it("the two executive ratio tiles print the served strings EXACTLY — a figure full precision cannot round to", () => {
    const tiles = servedRatiosCopy();
    const equity = tiles.rows.find((r) => r.key === "equity_ratio") as RatioCompareRow;
    const nde = tiles.rows.find((r) => r.key === "net_debt_to_ebitda") as RatioCompareRow;
    // 60.85% and a sub-turn net debt / EBITDA round to neither plant.
    expect(equity.current.value).not.toBeNull();
    equity.current.value_q = "12.3";
    equity.delta.value = "-72.6";
    expect(nde.current.value).not.toBeNull();
    nde.current.value_q = "7.77";
    nde.delta.value = "+6.66";
    const doc = reportDoc(tiles);
    for (const [tile, row] of [["equity_ratio", equity], ["net_debt_ebitda", nde]] as const) {
      const p = printRatioCompareRow(row, tile);
      const cells = Array.from(doc.querySelectorAll(`tr[data-tile="${tile}"] td`)).map(text);
      expect(cells[1], `${tile} current`).toBe(p.current);
      expect(cells[2], `${tile} change`).toBe(p.delta);
    }
  });
});

// ── §4 one card, one ladder — on every corpus pair ─────────────────────

/** Every six-column card of a rendered document, with what it prints. */
function cardsOf(doc: Document): Array<{ row: RatioCompareRow; headline: string; badge: string; meta: string; current: string; bandNow: string }> {
  const out = [];
  for (const card of Array.from(doc.querySelectorAll(".ratio-card"))) {
    const table = card.querySelector("table.ratio-cmp[data-ratio-cmp-json]");
    if (!table) continue;
    out.push({
      row: JSON.parse(table.getAttribute("data-ratio-cmp-json") as string) as RatioCompareRow,
      headline: text(card.querySelector(".value")).replace(/ \/ 100$/, ""),
      badge: text(card.querySelector(".meta .badge")),
      meta: text(card.querySelector(".meta")),
      current: text(table.querySelector('td[data-cell="current"]')),
      bandNow: text(table.querySelector('td[data-cell="band-now"]')),
    });
  }
  return out;
}

describe("§4 a card never prints one figure, verdict or ladder in its headline and another in its table", () => {
  const CENSUS_CARDS = 22;

  it("every card on every ordered corpus pair: headline = current cell, badge = Band now, benchmark = served ladder", () => {
    const pairs = corpusPairKeys();
    expect(pairs.length).toBe(12);
    let checked = 0;
    let laddersChecked = 0;
    let refusedChecked = 0;
    for (const [cur, pri] of pairs) {
      const doc = new DOMParser().parseFromString(
        buildReportHtml(corpusPairStatements(cur, pri), corpusPairEnvelopes(cur)),
        "text/html",
      );
      const cards = cardsOf(doc);
      expect(cards.length, `${cur}|${pri}`).toBe(CENSUS_CARDS + 3);
      for (const c of cards) {
        const where = `${cur}|${pri} ${c.row.key}`;
        // A refused served current: the headline is the served REASON,
        // the very string the card's current cell prints — never
        // "not reported" above a table that states why (B8 verifier,
        // adjusted_dscr). A valued one: the served figure.
        if (c.row.current.value_q === null) {
          expect(c.headline, `${where}: served current refused, the headline is not the current cell`).toBe(c.current);
          expect(c.headline, `${where}: served current refused, the headline is the bare word`).not.toBe("not reported");
          refusedChecked += 1;
        } else {
          expect(c.headline, `${where}: headline ${c.headline}, served current ${c.current}`).toBe(c.current);
        }
        // The census cards carry a band badge; the credit cards carry none.
        if (c.row.group !== "distress" && c.row.group !== "credit") {
          expect(c.badge, `${where}: badge ${c.badge}, Band now ${c.bandNow}`).toBe(c.bandNow);
          const sentence = servedLadderSentence(c.row);
          if (sentence !== null) {
            expect(c.meta, `${where}: the benchmark does not print the served ladder`).toContain(sentence);
            laddersChecked += 1;
          }
        }
        checked += 1;
      }
    }
    expect(checked).toBe(12 * (CENSUS_CARDS + 3));
    expect(laddersChecked).toBeGreaterThan(12 * 10);
    expect(refusedChecked, "non-vacuity: no corpus pair serves a refused current").toBeGreaterThan(0);
    // Bounded by its WORK (12 pairs x 25 cards, ~0.7 s alone), not vitest's
    // 5 s default: under the full suite's parallel load it ran 7.5 s and was
    // reported as a timeout with every assertion green.
  }, 30_000);

  it("non-vacuity: the FE ladders really disagree with the served band on these pairs", () => {
    // Without the served overlay the card's badge is computeRatios' verdict.
    // Count the cards where that word differs from the served Band now — the
    // cards this gate exists for. Retail as the current period is one.
    const fx = servedCorpusPairs();
    const disagreements: string[] = [];
    for (const [cur, pri] of corpusPairKeys()) {
      const rows = new Map(fx.pairs[`${cur}|${pri}`].rows.map((r) => [r.key, r]));
      const b = computeRatios(statementsFor(cur), undefined, metricsFor(cur));
      for (const rt of [b.liquidity, b.profitability, b.leverage, b.coverage, b.efficiency].flat()) {
        const row = rows.get(servedRatioKey(rt.key));
        if (row && verdictLabel(rt.verdict) !== formatRatioBand(row.current, "en")) {
          disagreements.push(`${cur}|${pri} ${row.key}`);
        }
      }
    }
    expect(disagreements).toContain("retail|agras debt_to_assets");
    expect(disagreements.length).toBeGreaterThan(3);
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
    const wb = ratiosSheet().find((r) => r[1] === "Interest coverage (EBIT / interest)") as string[];
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

  /** The absent-table assertions, shared by the two production shapes. */
  const assertStatedInEveryCell = (s: Statements, tablesAbsentAs: string) => {
    const reason = priorRatioAbsence(s);
    const doc = new DOMParser().parseFromString(buildReportHtml(s, pairEnvelopes()), "text/html");
    const wb = ratiosSheet(null, s);
    const priorLabel = s.prior?.periodLabel as string;
    const tables = Array.from(doc.querySelectorAll(`table.ratio-cmp[data-ratio-cmp-absent="${tablesAbsentAs}"]`));
    expect(tables.length).toBe(25);
    for (const t of tables) {
      const heads = Array.from(t.querySelectorAll("th")).map(text);
      expect(heads[1], "the prior column names the prior period").toBe(priorLabel);
      const cells = Array.from(t.querySelectorAll("td")).map(text);
      for (const i of [1, 2, 4, 5]) {
        expect(cells[i], `${t.getAttribute("data-ratio-cmp")} cell ${i}`).toBe(reason);
        expect(cells[i]).not.toBe(NO_COMPARATIVE_CELL);
      }
      expect(DASHES.has(cells[0])).toBe(false);
      // THE SAME CELLS IN THE WORKBOOK, for the same row.
      const card = t.closest(".ratio-card");
      const label = text(card?.querySelector(".label"));
      const wbRow = wb.find((r) => r[1] === label);
      if (wbRow) expect(wbRow.slice(2, 8), `${label}: report and workbook differ`).toEqual(cells);
    }
    // Nowhere under a heading that names the prior period does the document
    // say there is no prior period.
    for (const td of Array.from(doc.querySelectorAll("table.ratio-cmp td"))) {
      expect(text(td)).not.toBe(NO_COMPARATIVE_CELL);
    }
    expect(text(doc.querySelector('[data-report-credit-movement="absent"]'))).toContain(reason);
    expect(text(doc.querySelector('[data-band-movements="absent"]'))).toContain(reason);
    expect(doc.querySelector("[data-ratio-cmp-json]")).toBeNull();
    for (const r of wb.filter((row) => row[0] === "Liquidity")) {
      expect([r[3], r[4], r[6], r[7]]).toEqual([reason, reason, reason, reason]);
    }
    // THE EXECUTIVE RATIO TILES print the reason too, beside money tiles that
    // print a real change against the same prior.
    for (const tile of ["equity_ratio", "net_debt_ebitda"]) {
      const cells = Array.from(doc.querySelectorAll(`tr[data-tile="${tile}"] td`)).map(text);
      expect(cells.length).toBeGreaterThan(2);
      for (const c of cells.slice(2)) {
        expect(c, `${tile}: "no prior period" beside a prior the money tiles compare against`).not.toBe(NO_COMPARATIVE_CELL);
        expect(c.length).toBeGreaterThan(20);
      }
      expect(cells[2], tile).toBe(reason);
    }
    const money = Array.from(doc.querySelectorAll('tr[data-tile="total_assets"] td')).map(text);
    expect(money[2], "the money tile compares against the same prior").toMatch(/\d/);
    return reason;
  };

  it("a comparison document that reached the export without its table: the reason IS every prior cell", () => {
    const reason = assertStatedInEveryCell(pairStatements(null), "table");
    expect(reason).toMatch(/comparison document reached this export without its two-period ratio table/);
  });

  it("THE PRODUCTION SHAPE BEFORE B6 — prior attached, no comparatives document: the reason IS every prior cell", () => {
    const s = pairStatementsWithoutComparatives();
    expect(s.comparatives).toBeUndefined();
    const reason = assertStatedInEveryCell(s, "table");
    expect(reason).toBe(
      "the comparison period Dec 2024 reached this export without the served two-period ratio table, so no ratio's prior, change or band movement is stated",
    );
  });

  it("a served table with no row for a card's ratio: the row sentence, in the report and the workbook", () => {
    const planted = servedRatiosCopy();
    planted.rows = planted.rows.filter((r) => r.key !== "quick_ratio");
    planted.band_movements.unchanged = planted.band_movements.unchanged.filter((u) => u.key !== "quick_ratio");
    const doc = reportDoc(planted);
    const t = doc.querySelector('table.ratio-cmp[data-ratio-cmp="quick_ratio"][data-ratio-cmp-absent="row"]') as Element;
    const cells = Array.from(t.querySelectorAll("td")).map(text);
    const reason = ratioRowAbsence("Quick ratio");
    expect([cells[1], cells[2], cells[4], cells[5]]).toEqual([reason, reason, reason, reason]);
    const wb = ratiosSheet(planted).find((r) => r[1] === "Quick ratio") as string[];
    expect(wb.slice(2, 8)).toEqual(cells);
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
    expect(rows[0].slice(2, 8)).toEqual(ratioCompareHeadingsFor("Imported period", NO_COMPARATIVES_NOTE, "en"));
    const current = rows.find((r) => r[1] === "Current ratio") as string[];
    expect([current[3], current[4], current[6], current[7]]).toEqual(Array(4).fill(NO_COMPARATIVE_CELL));
    expect(rows.some((r) => r[0] === "no prior period was supplied with this book")).toBe(true);
  });
});

// ── §7b the comparison exists and is unavailable — say which ───────────
//
// statementsForExportOf(statements, null) used to hand the exports
// `comparatives: null` whether no prior was chosen or the engine REFUSED
// the comparison / the request FAILED / it was still LOADING — so the
// report printed "No comparatives — position report" and the workbook
// "no prior period was supplied with this book" while the Ratios tab, at
// the same moment, stated the refusal (B8 verifier low b). The page's join
// (`ratioSurfacesOf`) now carries the outcome into `StatementsForExport
// .comparison`, and every prior-dependent cell prints it.

describe("§7b a comparison that was refused, failed or is pending is stated as such — never as a missing prior", () => {
  const CASES: [string, { data?: unknown; isError?: boolean }, RegExp, string][] = [
    // The refusal is stated as the sentence for its CODE, never as the
    // engine's message (lib/comparisonRefusal.ts): here a code the route
    // does not use, so the general sentence.
    [
      "refused by the engine",
      { data: { kind: "refused", code: "prior_not_servable", message: "the prior period carries no statements block" } },
      /the engine refused the comparison \(prior_not_servable\): these two periods can't be compared/,
      "comparison refused",
    ],
    [
      "refused as another company's period",
      { data: { kind: "refused", code: "period_not_in_workspace", message: "period '5ea50000-0000-4000-8000-0000000051f5' is not in this workspace" } },
      /the engine refused the comparison \(period_not_in_workspace\): the comparison period belongs to another company/,
      "comparison refused",
    ],
    ["failed with a status", { data: { kind: "error", status: 502 } }, /the comparison request failed \(HTTP 502\)/, "comparison failed"],
    ["failed with no response", { data: undefined, isError: true }, /the comparison request failed \(HTTP 0, no response\)/, "comparison failed"],
    ["not yet answered", { data: undefined, isError: false }, /the comparison had not been answered when this export was built/, "comparison pending"],
  ];

  it.each(CASES)("%s: the report's prior cells, band block and credit block, and the workbook, state it", (_name, query, rx, heading) => {
    const surfaces = ratioSurfacesOf({
      assembledMetrics: {},
      statements: statementsFor("agras"),
      metricsByName: metricsFor("agras"),
      currentLabel: "Dec 2025",
      periodId: "period-agras-fy2025",
      priorId: "period-carniprod-fy2024",
      comparatives: query as Parameters<typeof ratioSurfacesOf>[0]["comparatives"],
    });
    const st = surfaces.statementsForExport!;
    expect(st.comparison.kind, "the page join carried no outcome").not.toBe("none");
    expect(st.comparatives).toBeNull();

    const html = buildReportHtml(st, surfaces.creditEnvelopes);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tables = Array.from(doc.querySelectorAll("table.ratio-cmp"));
    expect(tables.length, "no six-column tables for a requested comparison").toBeGreaterThan(20);
    for (const t of tables) {
      for (const id of ["prior", "delta", "band-prior", "movement"]) {
        expect(text(t.querySelector(`[data-cell="${id}"]`)), `${t.getAttribute("data-ratio-cmp")} ${id}`).toMatch(rx);
      }
    }
    expect(text(doc.querySelector('[data-band-movements="absent"]'))).toMatch(rx);
    expect(text(doc.querySelector('[data-report-credit-movement="absent"]'))).toMatch(rx);
    expect(html).not.toContain("no prior period was supplied");
    expect(html).not.toContain(NO_COMPARATIVES_NOTE);
    // The engine's message never reaches the report: a raw period id is not a sentence.
    expect(html).not.toContain("5ea50000-0000-4000-8000-0000000051f5");

    const wb = buildExcelWorkbook(st, undefined, surfaces.creditEnvelopes);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets.Ratios, { header: 1, raw: false, defval: "" }) as string[][];
    expect(rows[0].slice(2, 8)).toEqual(ratioCompareHeadingsFor(statementsFor("agras").periodLabel, heading, "en"));
    const current = rows.find((r) => r[1] === "Current ratio") as string[];
    for (const i of [3, 4, 6, 7]) expect(current[i]).toMatch(rx);
    const bandBlock = rows.slice(rows.findIndex((r) => r[0] === "Band movements"));
    expect(bandBlock.some((r) => rx.test(String(r[0])))).toBe(true);
    for (const sheet of ["Ratios", "P&L", "Balance Sheet"]) {
      const all = (XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: "" }) as string[][]).flat().join("\n");
      expect(all, sheet).not.toContain("no prior period was supplied");
      expect(all, sheet).not.toContain(NO_COMPARATIVES_NOTE);
      expect(all, sheet).not.toContain("5ea50000-0000-4000-8000-0000000051f5");
    }
    const pl = XLSX.utils.sheet_to_json(wb.Sheets["P&L"], { header: 1, raw: false, defval: "" }) as string[][];
    expect(pl[0][2]).toBe(heading);
  });

  it("no comparison requested: the outcome is none and the sentences are the no-prior ones", () => {
    const st = statementsForExportOf(statementsFor("agras"), null)!;
    expect(st.comparison).toEqual({ kind: "none" });
    expect(priorRatioAbsence(st)).toBe("no prior period was supplied with this book");
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
  });

  it("a crossing the composer demoted stays listed, as a check naming what its finding is missing", () => {
    const planted = servedCorpusPairs().demoted_planted.ratios;
    const doc = reportDoc(planted);
    const expected = planted.band_movements.findings.filter((f) => (f as { demoted?: boolean }).demoted).length;
    expect(expected).toBeGreaterThan(0);
    const demoted = Array.from(doc.querySelectorAll('[data-finding-status="demoted"]'));
    expect(demoted.length).toBe(expected);
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
      "Group", "Ratio", ...ratioCompareHeadingsFor("Dec 2025", "Dec 2024", "en"), "Benchmark", "Commentary",
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

// ── §11 direction, painted from the served verdicts ───────────────────

const DELTA_TONE: Record<string, string> = { improved: "success", deteriorated: "alert", none: "neutral" };

function expectedDeltaTone(row: RatioCompareRow): string {
  const fav = row.delta.favourable ?? "none";
  const zero = typeof row.delta.value === "string" && /^[+-]?0+(\.0+)?$/.test(row.delta.value);
  if (zero && fav !== "none") return "caution";
  return DELTA_TONE[fav] ?? "caution";
}

function expectedMovementTone(row: RatioCompareRow): string {
  const m = row.movement;
  if (m.status === "crossed_up") return m.rungs_crossed > 0 ? "success" : "caution";
  if (m.status === "crossed_down") return m.rungs_crossed < 0 ? "alert" : "caution";
  if (m.status === "same_band") return m.rungs_crossed === 0 ? "neutral" : "caution";
  return m.status === "not_comparable" ? "neutral" : "caution";
}

describe("§11 every delta and band-movement cell carries the served direction", () => {
  it("cards, the served-only table, crossing lines, credit lines and executive tiles", () => {
    const doc = reportDoc();
    const tally: Record<string, number> = {};
    let sameBandDeteriorated = 0;
    for (const holder of Array.from(doc.querySelectorAll("[data-ratio-cmp-json]"))) {
      const row = JSON.parse(holder.getAttribute("data-ratio-cmp-json") as string) as RatioCompareRow;
      const cellsOf = (id: string) =>
        holder.matches(`[data-cell="${id}"]`) ? [holder] : Array.from(holder.querySelectorAll(`[data-cell="${id}"]`));
      const deltas = cellsOf("delta");
      expect(deltas.length, `${row.key}: a delta with no tone holder`).toBeGreaterThan(0);
      for (const d of deltas) {
        expect(d.getAttribute("data-tone"), `${row.key} delta (${row.delta.favourable})`).toBe(expectedDeltaTone(row));
        tally[`delta:${d.getAttribute("data-tone")}`] = (tally[`delta:${d.getAttribute("data-tone")}`] ?? 0) + 1;
        if (row.movement.status === "same_band" && row.delta.favourable === "deteriorated") sameBandDeteriorated += 1;
      }
      for (const m of cellsOf("movement")) {
        expect(m.getAttribute("data-tone"), `${row.key} movement (${row.movement.status})`).toBe(expectedMovementTone(row));
        tally[`move:${m.getAttribute("data-tone")}`] = (tally[`move:${m.getAttribute("data-tone")}`] ?? 0) + 1;
      }
    }
    expect(tally["delta:success"]).toBeGreaterThan(0);
    expect(tally["delta:alert"]).toBeGreaterThan(0);
    expect(tally["move:success"]).toBeGreaterThan(0);
    expect(tally["move:alert"]).toBeGreaterThan(0);
    expect(sameBandDeteriorated, "a same-band deterioration carries a direction").toBeGreaterThan(0);
    const exec = doc.querySelector('tr[data-tile="equity_ratio"] td[data-cell="delta"]');
    expect(exec?.getAttribute("data-tone")).toBe("alert");
  });

  it("the stylesheet paints success green, alert red and caution amber — and nothing keyed on a status alone", () => {
    const html = buildReportHtml(pairStatements(), pairEnvelopes());
    const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/g) ?? []).join("\n");
    const colourOf = (tone: string) =>
      css.match(new RegExp(`\\[data-tone="${tone}"\\]\\s*\\{\\s*color:\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toUpperCase();
    expect(colourOf("success")).toBe("#0A6154");
    expect(colourOf("alert")).toBe("#7A1F1F");
    expect(colourOf("caution")).toBe("#8A5A00");
    expect(css).not.toMatch(/data-movement="crossed_(up|down)"\][^{]*\{[^}]*color/);
  });
});

// ── §12 a partial served block degrades with a reason, never throws ────

describe("§12 a malformed served block is absent-with-a-reason on every surface", () => {
  const shapes: Array<[string, (r: RatioComparisonV1) => void, RegExp]> = [
    ["no composites", (r) => { delete (r as { composites?: unknown }).composites; }, /no list of composites/],
    ["a row without its delta", (r) => { delete (r.rows[0] as { delta?: unknown }).delta; }, /the current_ratio row carries no delta/],
    ["rows not a list", (r) => { (r as unknown as { rows: unknown }).rows = {}; }, /no list of rows/],
    ["a band list not a list", (r) => { (r.band_movements as unknown as { improved: unknown }).improved = "roe"; }, /improved is not a list/],
  ];
  for (const [name, plant, why] of shapes) {
    it(name, () => {
      const planted = servedRatiosCopy();
      plant(planted);
      const s = pairStatements(planted);
      const reason = priorRatioAbsence(s);
      expect(reason).toMatch(/could not be read/);
      expect(reason).toMatch(why);
      let html = "";
      expect(() => { html = buildReportHtml(s, pairEnvelopes()); }).not.toThrow();
      expect(() => buildExcelWorkbook(s, undefined, pairEnvelopes())).not.toThrow();
      const doc = new DOMParser().parseFromString(html, "text/html");
      expect(doc.querySelector("[data-ratio-cmp-json]")).toBeNull();
      const t = doc.querySelector('table.ratio-cmp[data-ratio-cmp="current_ratio"]') as Element;
      expect(text(t.querySelectorAll("td")[1])).toBe(reason);
      expect(text(doc.querySelector('[data-band-movements="absent"]'))).toContain(reason);
      const wb = ratiosSheet(planted, s).find((r) => r[1] === "Current ratio") as string[];
      expect(wb[3]).toBe(reason);
    });
  }
});
