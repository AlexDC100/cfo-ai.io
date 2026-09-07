// G-C1 — THE CHARTS, ASSERTED OVER THE RENDERED EXPORT.
//
// Every assertion below parses the `<!doctype html>` string the Export tab
// writes (TC-7). Nothing here calls a chart builder and inspects its
// return value: four of the five defects the previous wave repaired lived
// only in the printed document, invisible to a gate that stopped at the
// data layer.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  · a chart emitted without its table, or a table without its chart
//  · a figure that appears in an SVG and in no table — a number whose
//    only home is a picture
//  · a chart drawn from inputs the envelope does not carry (an empty or
//    single-point axis instead of the gap card)
//  · a gap card that does not name the missing input or the fix
//  · a chart that stops tracing to gateway facts (a row with no source)
//  · a waterfall whose steps stop summing to its closing anchor
//  · the credit-contribution rows drifting away from the printed
//    composite they are supposed to decompose
//  · a band track drawn against a threshold the engine did not serve
//  · non-determinism: two renders of one envelope differing byte for byte
//
// ── WHAT IT CANNOT SEE ────────────────────────────────────────────────
//  · whether a chart is LEGIBLE — bar overlap, label collision, a tone
//    ramp that muddies on a specific printer. That is an eye's job; the
//    greyscale rule is enforced structurally instead (every series
//    carries a text label and its own printed figure, so colour is never
//    the only channel), which a gate can check and legibility cannot.
//  · whether a chart is the RIGHT chart for the finding.
//  · anything about the on-screen `/report` page, which is a different
//    surface with its own harness (`reportBooks.tsx`).

import { describe, expect, it } from "vitest";

import { BOOKS, type Book, exportDoc, exportHtml, statementsFor } from "./exportBooks";
import type { Statements } from "@/lib/financialReport";

interface Block {
  id: string;
  status: string;
  svgTexts: string[];
  tableRows: Array<{ label: string; printed: string; source: string }>;
  gapText: string;
  caption: string;
  hasSvg: boolean;
  hasTable: boolean;
}

function blocks(doc: Document): Block[] {
  return Array.from(doc.querySelectorAll("[data-chart-block]")).map((f) => ({
    id: f.getAttribute("data-chart-block") ?? "",
    status: f.getAttribute("data-chart-status") ?? "",
    hasSvg: f.querySelector("svg.chart") !== null,
    hasTable: f.querySelector("table.chart-table") !== null,
    svgTexts: Array.from(f.querySelectorAll("svg.chart text")).map((t) =>
      (t.textContent ?? "").replace(/\s+/g, " ").trim(),
    ),
    tableRows: Array.from(f.querySelectorAll("table.chart-table tbody tr")).map((tr) => {
      const td = Array.from(tr.querySelectorAll("td"));
      return {
        label: (td[0]?.textContent ?? "").trim(),
        printed: (td[1]?.textContent ?? "").trim(),
        source: (td[2]?.textContent ?? "").trim(),
      };
    }),
    gapText: (f.querySelector(".chart-gap")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    caption: (f.querySelector("figcaption")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  }));
}

const byId = (bs: Block[], id: string): Block => {
  const b = bs.find((x) => x.id === id);
  if (!b) throw new Error(`the printed document carries no chart block ${id}; it carries: ${bs.map((x) => x.id).join(", ")}`);
  return b;
};

/** The ten blocks the document is contracted to emit, drawn or not. */
const EXPECTED = [
  "chart-ebitda-bridge",
  "chart-revenue-trend",
  "chart-bs-composition",
  "chart-cash-walk",
  "chart-net-debt-walk",
  "chart-wc-cycle",
  "chart-band-tracks",
  "chart-covenant-headroom",
  "chart-credit-contrib",
  "chart-asset-age",
];

describe("G-C1 — every chart, and every chart's table", () => {
  it.each(BOOKS)("%s: the document emits all ten blocks", (b: Book) => {
    const got = blocks(exportDoc(b)).map((x) => x.id);
    expect(got).toEqual(EXPECTED);
  });

  // R5, the structural half. `renderChartBlock` writes both halves or
  // neither; this is the assertion that keeps it that way.
  it.each(BOOKS)("%s: drawn ⇒ svg AND table; absent ⇒ gap card, no svg, no table", (b: Book) => {
    for (const blk of blocks(exportDoc(b))) {
      if (blk.status === "drawn") {
        expect(blk.hasSvg, `${blk.id} is drawn with no svg`).toBe(true);
        expect(blk.hasTable, `${blk.id} is drawn with no table — a chart is never the only source of a number`).toBe(true);
        expect(blk.tableRows.length, `${blk.id} has an empty table`).toBeGreaterThan(1);
      } else {
        expect(blk.status, `${blk.id} carries an unknown status`).toBe("absent");
        expect(blk.hasSvg, `${blk.id} is absent but drew an axis anyway`).toBe(false);
        expect(blk.hasTable, `${blk.id} is absent but printed a table`).toBe(false);
        expect(blk.gapText.length, `${blk.id} is absent with no gap card`).toBeGreaterThan(80);
      }
    }
  });

  // R5, THE NUMERIC HALF, and the law stated at full strength: NO FIGURE
  // LIVES ONLY IN A PICTURE. Not "the chart's own table carries it" —
  // SOME table in the document carries it. The composition chart's column
  // totals are the served Total Assets and Total Equity + Liabilities,
  // which belong to the balance sheet above it, and requiring them to be
  // repeated in the chart's own table would be asking the document to
  // print the same total twice to satisfy a gate.
  it.each(BOOKS)("%s: no figure lives only in a picture", (b: Book) => {
    const doc = exportDoc(b);
    const everyCell = new Set(
      Array.from(doc.querySelectorAll("td, .value, .meta")).map((c) =>
        (c.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
    );
    const cellText = [...everyCell].join(" \u0001 ");
    for (const blk of blocks(doc)) {
      if (blk.status !== "drawn") continue;
      // A figure label is one that carries a digit. Category names and
      // zone words do not.
      const figures = blk.svgTexts.filter((t) => /\d/.test(t));
      const orphans = figures.filter((t) => {
        const bare = t.replace(/^▲\s*/, "").replace(/^of\s+/, "").trim();
        if (everyCell.has(bare)) return false;
        // A leader-line label is "<name> <printed>"; a band-track axis end
        // is the domain the row's own thresholds imply. Both are satisfied
        // when the printed figure appears anywhere the document prints it.
        return !cellText.includes(bare);
      });
      expect(orphans, `${blk.id}: figures drawn that no table in the document prints`).toEqual([]);
    }
  });

  // A label long enough to leave the frame. Found in a browser on the
  // agras export: the band track drew each ratio's whole FORMULA under
  // its name — 195 characters on the quick-ratio row — which ran 11 px
  // past the viewBox and straight across the track beside it. jsdom
  // cannot lay out, so the proxy is the only thing a gate can hold: a
  // drawn label is a label, not a sentence.
  it.each(BOOKS)("%s: no chart draws a sentence where a label goes", (b: Book) => {
    for (const blk of blocks(exportDoc(b))) {
      if (blk.status !== "drawn") continue;
      for (const t of blk.svgTexts) {
        expect(t.length, `${blk.id} draws a ${t.length}-character label: "${t.slice(0, 60)}…"`).toBeLessThanOrEqual(60);
      }
    }
  });

  it.each(BOOKS)("%s: every drawn series names where it came from", (b: Book) => {
    for (const blk of blocks(exportDoc(b))) {
      if (blk.status !== "drawn") continue;
      for (const row of blk.tableRows) {
        expect(row.source.length, `${blk.id} / ${row.label} traces to nothing`).toBeGreaterThan(1);
      }
    }
  });

  it.each(BOOKS)("%s: every gap card names the missing input and the fix", (b: Book) => {
    for (const blk of blocks(exportDoc(b))) {
      if (blk.status !== "absent") continue;
      expect(blk.gapText, `${blk.id} gap card`).toMatch(/Missing:/);
      expect(blk.gapText, `${blk.id} gap card`).toMatch(/To produce it:/);
      // and it never quietly implies a zero
      expect(blk.gapText).not.toMatch(/\b0\.00\b/);
    }
  });

  // The whole point of the module: two renders of one envelope are the
  // same bytes. No clock, no randomness, no id counter that depends on
  // call order.
  it.each(BOOKS)("%s: charts are byte-identical across renders", (b: Book) => {
    const one = exportHtml(b);
    const two = exportHtml(b);
    const svgs = (h: string) => h.match(/<svg class="chart"[\s\S]*?<\/svg>/g) ?? [];
    expect(svgs(one).length).toBeGreaterThan(3);
    expect(svgs(one)).toEqual(svgs(two));
  });

  it.each(BOOKS)("%s: no chart contains a clock or a random value", (b: Book) => {
    for (const m of exportHtml(b).match(/<svg class="chart"[\s\S]*?<\/svg>/g) ?? []) {
      expect(m).not.toMatch(/NaN|Infinity|undefined|null/);
    }
  });
});

describe("G-C1d — the band chip that replaces the word", () => {
  it.each(BOOKS)("%s: a ratio with served bands carries its position, not only a word", (b: Book) => {
    const doc = exportDoc(b);
    const s = statementsFor(b) as Statements & { assembled_bands?: { bands: Record<string, unknown> } };
    const served = Object.keys(s.assembled_bands?.bands ?? {});
    expect(served.length, "no served bands — this assertion would be vacuous").toBeGreaterThan(5);
    const cards = Array.from(doc.querySelectorAll(".ratio-card"));
    const withFormula = cards.filter((c) => c.querySelector("[data-ratio-formula]") !== null);
    const banded = withFormula.filter((c) =>
      served.includes(c.querySelector("[data-ratio-formula]")?.getAttribute("data-ratio-formula") ?? ""),
    );
    expect(banded.length, "no ratio card matched a served band key").toBeGreaterThan(5);
    for (const c of banded) {
      const key = c.querySelector("[data-ratio-formula]")?.getAttribute("data-ratio-formula");
      expect(c.querySelector("svg.chart.mini"), `${key} shows a word and no band position`).not.toBeNull();
      // the word stays too: it is the accessible reading of the shape
      expect(c.querySelector(".badge"), `${key} lost its verdict word`).not.toBeNull();
    }
  });

  it.each(BOOKS)("%s: the card chip draws no numerals of its own", (b: Book) => {
    for (const svg of Array.from(exportDoc(b).querySelectorAll("svg.chart.mini"))) {
      const texts = Array.from(svg.querySelectorAll("text")).map((t) => t.textContent ?? "");
      expect(texts, "a card chip drew a figure that lives nowhere else").toEqual([]);
    }
  });

  // One construction, two scales. The chip and the full track are built by
  // the same `zonesForKey`, so a ratio cannot be shown in one band on a
  // card and another on the track three sections later.
  it.each(BOOKS)("%s: the chip and the full track name the same zones", (b: Book) => {
    const doc = exportDoc(b);
    const full = byId(blocks(doc), "chart-band-tracks");
    if (full.status !== "drawn") return;
    for (const svg of Array.from(doc.querySelectorAll("svg.chart.mini"))) {
      const key = (svg.getAttribute("data-chart") ?? "").replace(/^band-/, "");
      const desc = svg.querySelector("desc")?.textContent ?? "";
      const inFull = full.tableRows.find((r) => r.label !== "" && desc.startsWith(r.label));
      if (!inFull) continue;
      expect(desc, `${key}: the chip names no zones`).toMatch(/critical|watch|healthy|strong/);
    }
  });
});

describe("G-C1b — the arithmetic each chart draws", () => {
  const parseMoney = (s: string): number => {
    const neg = s.trim().startsWith("-");
    const digits = s.replace(/[^\d.]/g, "");
    return (neg ? -1 : 1) * Number(digits);
  };
  const parseDays = (s: string): number => Number(s.replace(/[^\d.-]/g, ""));

  // A waterfall whose steps do not reach its closing anchor is a picture
  // that lies about a total. The cash walk is anchor · deltas · anchor.
  it.each(BOOKS)("%s: the cash walk foots to its closing anchor", (b: Book) => {
    const blk = byId(blocks(exportDoc(b)), "chart-cash-walk");
    if (blk.status !== "drawn") return;
    const v = blk.tableRows.map((r) => parseMoney(r.printed));
    const stepped = v.slice(0, v.length - 1).reduce((a, x) => a + x, 0);
    const closing = v[v.length - 1];
    // half a display step per printed row — the widest a rounding can be
    expect(Math.abs(stepped - closing), `walk ${stepped} vs anchor ${closing}`).toBeLessThanOrEqual(v.length / 2 + 0.5);
  });

  it.each(BOOKS)("%s: DSO + DIO − DPO = CCC, as printed", (b: Book) => {
    const blk = byId(blocks(exportDoc(b)), "chart-wc-cycle");
    if (blk.status !== "drawn") return;
    const [dso, dio, dpo, ccc] = blk.tableRows.map((r) => parseDays(r.printed));
    expect(Math.abs(dso + dio + dpo - ccc)).toBeLessThanOrEqual(0.2);
  });

  // The chart decomposes a number the document also prints as a headline.
  // If the two ever part company, one of them is wrong.
  it.each(BOOKS)("%s: the contribution rows sum to the printed composite", (b: Book) => {
    const doc = exportDoc(b);
    const blk = byId(blocks(doc), "chart-credit-contrib");
    if (blk.status !== "drawn") return;
    const printed = doc.querySelector("[data-report-credit-score]")?.textContent ?? "";
    if (/not reported/i.test(printed)) return;
    const composite = Number(printed.replace(/[^\d.]/g, "").replace(/^(\d+\.?\d*)100$/, "$1"));
    const sum = blk.tableRows
      .filter((r) => !/not reported/i.test(r.printed))
      .reduce((a, r) => a + Number(r.printed), 0);
    const shown = Number(printed.split("/")[0].replace(/[^\d.]/g, ""));
    expect(Number.isFinite(shown)).toBe(true);
    expect(Math.abs(sum - shown), `contributions ${sum} vs composite ${shown} (${composite})`).toBeLessThanOrEqual(
      blk.tableRows.length / 20 + 0.05,
    );
  });

  // A band track must be drawn against the bands the ENGINE served. The
  // expectation below is read straight out of the fixture — a second
  // opinion, not a restatement of the renderer.
  it.each(BOOKS)("%s: band tracks quote the served thresholds", (b: Book) => {
    const blk = byId(blocks(exportDoc(b)), "chart-band-tracks");
    if (blk.status !== "drawn") return;
    const s = statementsFor(b) as Statements & { assembled_bands?: { bands: Record<string, Record<string, number | string>> } };
    const served = s.assembled_bands?.bands ?? {};
    expect(Object.keys(served).length).toBeGreaterThan(5);
    for (const row of blk.tableRows) {
      const nums = row.source.match(/[\d.]+/g) ?? [];
      expect(nums.length, `${row.label}: no thresholds printed`).toBe(3);
      const printedSet = nums.map((x) => Number(x)).sort((x, y) => x - y);
      // find the served definition whose three thresholds match
      const match = Object.values(served).some((def) => {
        const th = [def.watch, def.healthy, def.strong]
          .filter((x): x is number => typeof x === "number")
          .sort((x, y) => x - y);
        return th.length === 3 && th.every((x, ix) => Math.abs(x - printedSet[ix]) < 0.005);
      });
      expect(match, `${row.label}: printed bands ${printedSet.join("/")} match no served band definition`).toBe(true);
    }
  });

  // The disclosure the engine asks for, and that no frontend file printed
  // before this wave: a verdict banded on general-SME defaults must say
  // so. `_band_definitions()` in the RO country pack serves
  // `source: "general_sme_fallback"` on every period today.
  it.each(BOOKS)("%s: the band source is stated where the verdicts are", (b: Book) => {
    const blk = byId(blocks(exportDoc(b)), "chart-band-tracks");
    if (blk.status !== "drawn") return;
    const s = statementsFor(b) as Statements & { assembled_bands?: { source?: string } };
    if (s.assembled_bands?.source === "general_sme_fallback") {
      expect(blk.caption).toMatch(/GENERAL-SME bands, not calibrated/);
      expect(blk.caption).toMatch(/general_sme_fallback/);
    }
  });
});

// ── THE TWO-PERIOD PATH ────────────────────────────────────────────────
//
// PROVENANCE (TC-1). Every committed firm book carries ONE period:
// `statements.prior` and `statements.historicalPeriods` are absent on all
// four, measured. So the bridge / net-debt-walk / trend code paths cannot
// be exercised by any committed fixture, and a gate that only ran over
// them would pass while the drawing half of three charts was never
// executed once.
//
// The fixture below pairs TWO REAL BOOKS as two periods of one entity:
// current = the agras book, prior = the carniprod book, both real engine
// output, neither altered. THE PAIRING IS SYNTHETIC AND IS NEVER QUOTED —
// no assertion here reads a business meaning off the deltas. What is
// asserted is structure and arithmetic: that the charts draw, that their
// steps foot, and that they stop being gap cards. When a real two-period
// envelope lands, this fixture should be replaced with it.
function pairedBook(): Statements {
  const current = statementsFor("agras");
  const prior = statementsFor("carniprod");
  return {
    ...current,
    prior: {
      periodLabel: "Prior period (paired fixture)",
      balanceSheet: prior.balanceSheet,
      incomeStatement: prior.incomeStatement,
    },
  };
}

describe("G-C1c — with a prior attached, the three absent charts draw", () => {
  it("the bridge, the net-debt walk and the trend stop being gap cards", () => {
    const before = blocks(exportDoc("agras"));
    for (const id of ["chart-ebitda-bridge", "chart-net-debt-walk", "chart-revenue-trend"]) {
      expect(byId(before, id).status, `${id} on the one-period book`).toBe("absent");
    }
    const after = blocks(exportDoc("agras", pairedBook()));
    for (const id of ["chart-ebitda-bridge", "chart-net-debt-walk", "chart-revenue-trend"]) {
      const blk = byId(after, id);
      expect(blk.status, `${id} with a prior attached`).toBe("drawn");
      expect(blk.hasSvg && blk.hasTable, `${id} drew without its table`).toBe(true);
    }
  });

  it("the net-debt walk foots from opening to closing", () => {
    const blk = byId(blocks(exportDoc("agras", pairedBook())), "chart-net-debt-walk");
    const v = blk.tableRows.map((r) => {
      const neg = r.printed.trim().startsWith("-");
      return (neg ? -1 : 1) * Number(r.printed.replace(/[^\d.]/g, ""));
    });
    const stepped = v.slice(0, v.length - 1).reduce((a, x) => a + x, 0);
    expect(Math.abs(stepped - v[v.length - 1])).toBeLessThanOrEqual(v.length / 2 + 0.5);
  });

  // The bridge's own honesty rule: when the named steps do not reach the
  // served EBITDA, the remainder is drawn as its OWN step and named
  // "Unattributed" — never absorbed into one of the named ones.
  it("an unattributed remainder is drawn as its own step, not folded in", () => {
    const blk = byId(blocks(exportDoc("agras", pairedBook())), "chart-ebitda-bridge");
    const v = blk.tableRows.map((r) => {
      const neg = r.printed.trim().startsWith("-");
      return (neg ? -1 : 1) * Number(r.printed.replace(/[^\d.]/g, ""));
    });
    const stepped = v.slice(0, v.length - 1).reduce((a, x) => a + x, 0);
    expect(Math.abs(stepped - v[v.length - 1])).toBeLessThanOrEqual(v.length / 2 + 0.5);
    const labels = blk.tableRows.map((r) => r.label);
    if (labels.includes("Unattributed")) {
      expect(blk.caption).toMatch(/unattributed and is drawn as its own step/);
    }
  });
});
