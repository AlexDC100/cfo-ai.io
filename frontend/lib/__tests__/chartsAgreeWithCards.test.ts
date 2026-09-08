// G-S — ONE DOCUMENT, ONE FORMULA, ONE LADDER (R1 ACROSS SURFACES).
//
// Everything here parses the `<!doctype html>` the Export tab writes
// (TC-7). The charts and the ratio cards are DIFFERENT RENDERERS reading
// one envelope, they sit inches apart on the printed page, and both
// defects below were live in the document the owner forwarded.
//
// ── §A. THE CHART AND THE CARD STATED DIFFERENT FORMULAS ─────────────
//
// `charts/reportCharts.ts` typed its own source strings:
//
//     inventory ÷ cost of sales × days
//     payables  ÷ cost of sales × days
//
// while the ratio cards ~30 lines above in the same document read
//
//     inventory ÷ TOTAL operating expense (COGS + opex + D&A) × 365 days
//     — not narrow COGS
//
// which is what `computeRatios` divides by. Measured on the agras export:
// a reader recomputing from the chart's stated formula gets DIO 46.21 days
// and DPO 39.08 days against the 31.5 and 26.6 printed beside them. On the
// realestate book cost of goods sold is NIL, and the chart still printed
// "845.4 days | inventory ÷ cost of sales × days" — a stated formula that
// is a division by zero for the figure next to it.
//
// ── §B. THE BAND RAIL AND THE CARD DISAGREED, UNDER A CAPTION SAYING
//        THEY COULD NOT ────────────────────────────────────────────────
//
// `ratioBandTracks` banded from `assembled_bands`; the cards band from
// `Ratio.ladder`. Measured on all four committed books, CCC: card
// `watch: 100`, engine `watch: 90`. Plant `ccc = 95` and the badge reads
// "Watch" while the marker is drawn inside the CRITICAL zone — beneath a
// caption reading "each track is one ratio placed on the bands its
// verdict was decided by".
//
// Both band gates that existed queried `.ratio-card` only
// (`reportCharts.test.ts` "the card chip draws no numerals", "the chip and
// the full track name the same zones" — the latter only checks that the
// chip's `<desc>` mentions SOME zone word). Neither touched
// `#chart-band-tracks` geometry, so both were vacuous for this surface by
// construction. This file reads the RECTANGLES.
//
// ── WHAT THIS REDS ON, AFTER THE REPAIR (TC-11) ──────────────────────
//
// §A1  a working-capital chart row whose stated arithmetic is not, byte
//      for byte, the arithmetic the ratio card for that same row states
// §A2  any drawn chart naming a denominator ("cost of sales", "COGS")
//      that no ratio card in the document names
// §A3  a formula drawn INSIDE an SVG — the drawing carries a pointer to
//      the table, and PLANT 9 (a 195-character label past the viewBox) is
//      the reason
// §B1  a band-rail marker sitting in a zone whose name is not the verdict
//      word printed on that ratio's own card
// §B2  a rail threshold that does not appear in the card's printed band
//      sentence — the rail quoting a ladder the card did not print
// §B3  a rail track drawn for a ratio the document declined to grade
//      ("Not reported" / "Not graded")
//
// ── WHAT IT CANNOT SEE ───────────────────────────────────────────────
//
// * Whether the LADDER is right. §B holds the rail to the card; if the
//   card's rungs are wrong, both are wrong together and this stays green.
//   The drift between the FE ladder and the engine's served definition is
//   surfaced in the rail's own caption instead, and §B4 pins that the
//   caption names it rather than hiding it.
// * Legibility. jsdom does not lay out; §A3's character cap is the proxy.
// * The on-screen `/report` page — a different renderer with its own
//   harness (`reportBooks.tsx`).

import { describe, expect, it } from "vitest";

import { BOOKS, type Book, exportDoc, metricsFor, statementsFor } from "./exportBooks";
import { computeRatios, type Statements } from "@/lib/financialReport";

// ── the printed document, in the two shapes this file needs ──────────

interface ChartBlockDom {
  id: string;
  status: string;
  rows: Array<{ label: string; printed: string; source: string }>;
  caption: string;
  svg: Element | null;
}

function chartBlock(doc: Document, id: string): ChartBlockDom {
  const f = doc.querySelector(`[data-chart-block="${id}"]`);
  if (!f) throw new Error(`the printed document carries no chart block ${id}`);
  return {
    id,
    status: f.getAttribute("data-chart-status") ?? "",
    rows: Array.from(f.querySelectorAll("table.chart-table tbody tr")).map((tr) => {
      const td = Array.from(tr.querySelectorAll("td"));
      return {
        label: (td[0]?.textContent ?? "").trim(),
        printed: (td[1]?.textContent ?? "").trim(),
        source: (td[2]?.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    }),
    caption: (f.querySelector("figcaption")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    svg: f.querySelector("svg.chart"),
  };
}

interface CardDom {
  label: string;
  value: string;
  /** `data-prov-formula` — the arithmetic `computeRatios` states for the
   *  figure on the card, carried into the document rather than retyped. */
  formula: string;
  /** The `.meta` line: the rendered ladder sentence plus the benchmark. */
  meta: string;
  /** The verdict word, from the badge — "Strong" / "Healthy" / "Watch" /
   *  "Critical" / "Not reported" / "Not graded". */
  verdict: string;
}

function cards(doc: Document): CardDom[] {
  return Array.from(doc.querySelectorAll(".ratio-card")).map((c) => ({
    label: (c.querySelector(".label")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    value: (c.querySelector(".value")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    formula: c.querySelector(".value")?.getAttribute("data-prov-formula") ?? "",
    meta: (c.querySelector(".meta")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    verdict: (c.querySelector(".badge")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  }));
}

/** The ratio card for a chart row, matched on the label the chart prints.
 *  The working-capital rows carry the ratio KEY as their label ("DSO",
 *  "plus DIO"), the rail carries the ratio's full label. */
const WC_ROW_TO_CARD: Record<string, string> = {
  DSO: "Days Sales Outstanding",
  "plus DIO": "Days Inventory Outstanding",
  "less DPO": "Days Payables Outstanding (on total operating cost)",
  "equals CCC": "Cash Conversion Cycle",
};

// ══════════════════════════════════════════════════════════════════════
// §A — the chart states the card's formula, or no formula at all
// ══════════════════════════════════════════════════════════════════════

describe("§A the arithmetic is spelled once per document", () => {
  it.each(BOOKS)("%s: every working-capital row cites its own card's formula", (b: Book) => {
    const doc = exportDoc(b);
    const blk = chartBlock(doc, "chart-wc-cycle");
    if (blk.status !== "drawn") return;
    const byLabel = new Map(cards(doc).map((c) => [c.label, c] as const));
    expect(blk.rows.length).toBe(4);
    for (const row of blk.rows) {
      const cardLabel = WC_ROW_TO_CARD[row.label];
      expect(
        cardLabel,
        `${b}: the cycle chart printed a row labelled "${row.label}", which maps to no ` +
          `ratio card. Either the chart grew a row or a card was renamed; either way the ` +
          `two surfaces can no longer be compared.`,
      ).toBeTruthy();
      const card = byLabel.get(cardLabel);
      expect(card, `${b}: no ratio card labelled "${cardLabel}" in the document`).toBeTruthy();
      expect(
        row.source,
        `${b}: the ${row.label} row of the cycle chart states\n` +
          `      "${row.source}"\n` +
          `  while the "${cardLabel}" card two inches above states\n` +
          `      "${card!.formula}"\n` +
          `  for the same figure (${row.printed} / ${card!.value}). A reader recomputing ` +
          `from the chart's spelling gets a different number, which is how the agras ` +
          `export printed DIO 31.5 days beside "inventory ÷ cost of sales × days" (46.21).`,
      ).toBe(card!.formula);
    }
  });

  it.each(BOOKS)("%s: no chart names a denominator no card names", (b: Book) => {
    const doc = exportDoc(b);
    const cardFormulas = cards(doc)
      .map((c) => c.formula.toLowerCase())
      .join(" | ");
    // The two spellings the charts used to carry on their own. Narrow
    // COGS is a real basis — it is simply not the one this product
    // divides by for DIO/DPO — so the check is "some card says it too",
    // not "the words are banned".
    const SUSPECT = ["cost of sales", "cost of goods sold"];
    for (const blockId of ["chart-wc-cycle", "chart-cash-walk", "chart-bs-composition", "chart-band-tracks", "chart-credit-contrib"]) {
      const blk = chartBlock(doc, blockId);
      if (blk.status !== "drawn") continue;
      for (const row of blk.rows) {
        for (const word of SUSPECT) {
          if (!row.source.toLowerCase().includes(word)) continue;
          expect(
            cardFormulas.includes(word),
            `${b}: ${blockId} / "${row.label}" divides by "${word}" and no ratio card in ` +
              `this document does. On the realestate book cost of goods sold is nil, and ` +
              `the chart still printed a day count against it.`,
          ).toBe(true);
        }
      }
    }
  });

  it.each(BOOKS)("%s: the drawing carries a pointer, not a formula", (b: Book) => {
    const doc = exportDoc(b);
    const blk = chartBlock(doc, "chart-wc-cycle");
    if (blk.status !== "drawn" || !blk.svg) return;
    for (const t of Array.from(blk.svg.querySelectorAll("text"))) {
      const s = (t.textContent ?? "").trim();
      expect(
        /÷|×/.test(s),
        `${b}: the cycle drawing carries "${s}" — an arithmetic set at 8 px under a ` +
          `149 px bar slot, which is the shape PLANT 9 caught running past the viewBox. ` +
          `The formula belongs in the table, once.`,
      ).toBe(false);
      expect(s.length).toBeLessThanOrEqual(60);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// §B — the rail is drawn on the ladder the badge was banded with
// ══════════════════════════════════════════════════════════════════════

interface RailRow {
  /** zone rectangles, left to right */
  zones: Array<{ x0: number; x1: number }>;
  /** centre of the value marker, or null when the value is absent */
  marker: number | null;
}

/**
 * The rail's GEOMETRY, read out of the SVG.
 *
 * `bandTracks` lays out row `i` at `y = 14 + 56i`; the four zone
 * rectangles sit at `y + 8` with height 18, and the value marker at
 * `y + 3` with width 3.2. Nothing else in the drawing has those
 * coordinates, so a rect census recovers the rows without the renderer
 * having to annotate itself for the benefit of a test.
 */
function railRows(svg: Element, count: number): RailRow[] {
  const rects = Array.from(svg.querySelectorAll("rect")).map((r) => ({
    x: Number(r.getAttribute("x")),
    y: Number(r.getAttribute("y")),
    w: Number(r.getAttribute("width")),
    fill: r.getAttribute("fill") ?? "",
  }));
  const out: RailRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const y = 14 + i * 56;
    const zones = rects
      .filter((r) => Math.abs(r.y - (y + 8)) < 0.51 && r.fill !== "none")
      .sort((a, b) => a.x - b.x)
      .map((r) => ({ x0: r.x, x1: r.x + r.w }));
    const mk = rects.find((r) => Math.abs(r.y - (y + 3)) < 0.51 && Math.abs(r.w - 3.2) < 0.51);
    out.push({ zones, marker: mk ? mk.x + mk.w / 2 : null });
  }
  return out;
}

/** The zone vocabulary, in drawing order, for a track's direction. It is
 *  the same list `zonesForKey` names its zones from; the DIRECTION is
 *  read out of the printed source column rather than assumed. */
const ZONE_NAMES = {
  higher: ["critical", "watch", "healthy", "strong"],
  lower: ["strong", "healthy", "watch", "critical"],
};

describe("§B the band rail and the badge cannot disagree", () => {
  it.each(BOOKS)("%s: every marker sits in the zone its badge names", (b: Book) => {
    const doc = exportDoc(b);
    const blk = chartBlock(doc, "chart-band-tracks");
    if (blk.status !== "drawn" || !blk.svg) return;
    const byLabel = new Map(cards(doc).map((c) => [c.label, c] as const));
    const rows = railRows(blk.svg, blk.rows.length);
    expect(rows.length).toBe(blk.rows.length);
    blk.rows.forEach((row, i) => {
      const card = byLabel.get(row.label);
      expect(card, `${b}: the rail draws "${row.label}" and no ratio card carries that label`).toBeTruthy();
      const geom = rows[i];
      expect(
        geom.zones.length,
        `${b}: the "${row.label}" track drew ${geom.zones.length} zones; the vocabulary ` +
          `names four (${ZONE_NAMES.higher.join(", ")}).`,
      ).toBe(4);
      if (geom.marker === null) {
        expect(
          card!.verdict,
          `${b}: the rail drew no marker for "${row.label}" while the card grades it ` +
            `"${card!.verdict}".`,
        ).toMatch(/Not reported|Not graded/);
        return;
      }
      const higher = /higher is better/.test(row.source);
      const names = higher ? ZONE_NAMES.higher : ZONE_NAMES.lower;
      // Half the marker's own width, so a value sitting exactly on a rung
      // is not reported as being on the wrong side of it.
      const tol = 1.7;
      const hit = geom.zones
        .map((z, zi) => ({ name: names[zi], z }))
        .filter(({ z }) => (geom.marker as number) >= z.x0 - tol && (geom.marker as number) <= z.x1 + tol)
        .map(({ name }) => name);
      expect(
        hit,
        `${b}: the "${row.label}" marker for ${row.printed} landed in no zone at all ` +
          `(zones ${geom.zones.map((z) => `${z.x0.toFixed(1)}–${z.x1.toFixed(1)}`).join(", ")}, ` +
          `marker ${geom.marker.toFixed(1)}).`,
      ).not.toEqual([]);
      expect(
        hit,
        `${b}: the card for "${row.label}" prints ${card!.value} and badges it ` +
          `"${card!.verdict}", while the rail draws the marker inside the ` +
          `${hit.join("/")} zone. The rail's own caption says each track is "the bands ` +
          `its verdict was decided by" — measured on all four books, the rail used to ` +
          `band CCC off the engine's watch=90 while the card banded off watch=100.`,
      ).toContain(card!.verdict.toLowerCase());
    });
  });

  it.each(BOOKS)("%s: every rail threshold is a threshold the card printed", (b: Book) => {
    const doc = exportDoc(b);
    const blk = chartBlock(doc, "chart-band-tracks");
    if (blk.status !== "drawn") return;
    const byLabel = new Map(cards(doc).map((c) => [c.label, c] as const));
    for (const row of blk.rows) {
      const card = byLabel.get(row.label);
      expect(card).toBeTruthy();
      // "bands: 1.00× / 1.25× / 1.50× (higher is better)" → the numerals.
      const nums = (row.source.match(/-?[\d.]+/g) ?? []).map((x) => Number(x));
      expect(
        nums.length,
        `${b}: the "${row.label}" rail row printed no thresholds`,
      ).toBe(3);
      // The card's meta carries the rendered ladder sentence. A rung the
      // rail draws that the card never printed is a second ladder.
      const cardNums = new Set(
        (card!.meta.match(/-?[\d.]+/g) ?? []).map((x) => Number(x).toString()),
      );
      for (const n of nums) {
        expect(
          cardNums.has(n.toString()),
          `${b}: the rail places "${row.label}" against ${n}, and the card's own printed ` +
            `band sentence — "${card!.meta}" — never states it. Two ladders, one ratio, ` +
            `one page.`,
        ).toBe(true);
      }
    }
  });

  it.each(BOOKS)("%s: no track is drawn for a ratio the document declined to grade", (b: Book) => {
    const doc = exportDoc(b);
    const blk = chartBlock(doc, "chart-band-tracks");
    if (blk.status !== "drawn") return;
    const byLabel = new Map(cards(doc).map((c) => [c.label, c] as const));
    for (const row of blk.rows) {
      const card = byLabel.get(row.label);
      expect(
        card!.verdict,
        `${b}: the rail drew a track for "${row.label}", whose card carries no verdict ` +
          `("${card!.verdict}"). A track explains a verdict; there is none to explain, ` +
          `and the bands it would be drawn on are the ones the card withheld.`,
      ).not.toMatch(/Not reported|Not graded/);
    }
  });

  // The drift the repair does NOT resolve, stated rather than buried.
  // `financialReport.ts` bands CCC at watch=100; the engine serves 90.
  // The rail follows the card, because the card produced the printed
  // word — and the caption has to say which row moved.
  it.each(BOOKS)("%s: a rung the engine and the card disagree on is named", (b: Book) => {
    const doc = exportDoc(b);
    const blk = chartBlock(doc, "chart-band-tracks");
    if (blk.status !== "drawn") return;
    const s = statementsFor(b) as Statements & {
      assembled_bands?: { bands: Record<string, Record<string, number | string>> };
    };
    const served = s.assembled_bands?.bands ?? {};
    const byLabel = new Map(cards(doc).map((c) => [c.label, c] as const));
    // ⚠ THE COMPARISON IS PER KEY, AND THAT IS THE WHOLE POINT.
    // `reportCharts.test.ts`'s own band gate asks whether the printed
    // rungs match SOME served definition, over all 27 of them — and CCC's
    // 30 / 60 / 100 happens to be another key's definition, so removing
    // this disclosure entirely left that gate green. A ladder belongs to
    // ONE ratio; matching it against the wrong ratio's rungs is not a
    // check.
    const keyOf = new Map(
      [
        computeRatios(s, undefined, metricsFor(b)).liquidity,
        computeRatios(s, undefined, metricsFor(b)).profitability,
        computeRatios(s, undefined, metricsFor(b)).leverage,
        computeRatios(s, undefined, metricsFor(b)).coverage,
        computeRatios(s, undefined, metricsFor(b)).efficiency,
      ]
        .flat()
        .map((r) => [r.label, r.key] as const),
    );
    const drifted: string[] = [];
    for (const row of blk.rows) {
      const card = byLabel.get(row.label);
      const railNums = (row.source.match(/-?[\d.]+/g) ?? []).map(Number).sort((x, y) => x - y);
      const def = served[keyOf.get(row.label) ?? ""];
      const th = def
        ? [def.watch, def.healthy, def.strong]
            .filter((x): x is number => typeof x === "number")
            .sort((x, y) => x - y)
        : [];
      const agrees =
        th.length === 3 && th.every((x, ix) => Math.abs(x - railNums[ix]) < 0.005);
      if (!agrees) {
        drifted.push(
          `${card!.label} (rail ${railNums.join(" / ")} vs engine ${th.join(" / ") || "no definition"})`,
        );
      }
    }
    if (drifted.length === 0) return;
    expect(
      blk.caption,
      `${b}: ${drifted.join(", ")} is drawn on rungs that match no served band ` +
        `definition, and the caption does not say so. The card is the authority — it ` +
        `produced the printed word — but a reader comparing this document to the ` +
        `engine's own definitions has to be told which row moved.`,
    ).toMatch(/differs from the engine's served definition/);
  });
});
