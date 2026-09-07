/**
 * THE EXECUTIVE SUMMARY MODEL — page one, as data.
 *
 * Four blocks: the verdict with the facts that produced it; six KPI
 * tiles carrying their variances (or the stated absence of one); the top
 * five insights from lane A's block; and WHAT WOULD CHANGE THE VERDICT —
 * the rungs this company is nearest to crossing.
 *
 * THE ONE THAT NEEDED A TYPE CHANGE. "What would change the verdict"
 * cannot be written without the band edges, and `row()` in
 * `computeRatios` used to consume its `bands` object and throw it away.
 * The only surviving trace of "healthy starts at 1.5×" was English in
 * `benchmark`, so any distance-to-threshold model would have had to
 * re-type the cutoffs somewhere else — a second copy of a ladder beside
 * a verdict computed from the first, which is precisely TC-10's
 * prohibition. `Ratio.ladder` now carries the SAME object
 * `verdictFromBands` read.
 *
 * WHAT THIS GATE REDS ON (TC-11)
 *   · a threshold in `wouldChange` that is not on the ratio's own
 *     ladder — i.e. a re-typed cutoff;
 *   · a distance that disagrees with |value − threshold|;
 *   · a rung offered for the band the ratio is ALREADY in (a distance of
 *     "how far to where you are" is noise);
 *   · a sector-calibrated row contributing a rung while the sector is
 *     disputed — the cutoff the card refused to print reappearing in
 *     the summary through a side door;
 *   · a verdict fact drawn from a ratio with no value, or from one whose
 *     badge is a refusal;
 *   · a tile whose variance is a number on a book with no prior period.
 *
 * TWO GUARDS, AND EITHER ONE ALONE HOLDS. The withheld-cutoff assertion
 * is defended twice — the `ungraded` row carries NO `ladder` at all
 * (`computeRatios`' `row()`), and `distancesFor` skips an `ungraded`
 * verdict besides. Planting each away on its own leaves this file GREEN,
 * because the other catches it; only planting BOTH reds it, with
 * `gross_margin @ 40`, `asset_turnover @ 0.8` and `dso @ 45` quoted back
 * out of a summary whose cards had refused to print them. Recorded here
 * rather than left implied: a future engineer who deletes one of the two
 * will see no red and must know that is expected.
 *
 * WHAT IT CANNOT SEE
 *   · the RENDER. Lane C draws this; a renderer that receives
 *     `wouldChangeAbsence` and prints nothing at all is invisible here.
 *   · the insight block, on these books: nothing yet attaches lane A's
 *     `build_insights` output to the served envelope, so `insights` is
 *     empty on all four and `insightsAbsence` is what is asserted. The
 *     day it is wired, the assertion below flips by itself and says so.
 */

import { describe, expect, it } from "vitest";

import { BOOKS, agreeingBook, disputedBook, metricsFor, statementsFor, type Book } from "./exportBooks";
import { buildExecutiveSummary, SUMMARY_TILE_KEYS } from "@/lib/executiveSummary";
import { computeCreditScore } from "@/lib/financialValuation";
import { SECTOR_CALIBRATED_RATIOS, altmanRatio, computeRatios } from "@/lib/financialReport";
import type { Statements } from "@/lib/financialReport";

function summaryFor(book: Book, s: Statements = statementsFor(book)) {
  const metrics = metricsFor(book);
  const credit = computeCreditScore(s, undefined, undefined, metrics);
  const ratios = computeRatios(s, undefined, metrics);
  return buildExecutiveSummary(s, ratios, credit, [altmanRatio(credit)]);
}

describe("executive summary — the verdict and the facts behind it", () => {
  it.each(BOOKS)("%s: every fact is a real, graded ratio printed elsewhere", (book: Book) => {
    const es = summaryFor(book);
    expect(es.verdict.facts.length).toBeGreaterThanOrEqual(1);
    expect(es.verdict.facts.length).toBeLessThanOrEqual(3);
    for (const f of es.verdict.facts) {
      expect(["strong", "healthy", "watch", "critical"], `${book}/${f.key}`).toContain(f.verdict);
      expect(f.printed, `${book}/${f.key} prints nothing`).not.toBe("");
      expect(f.printed, `${book}/${f.key} quotes a refused figure`).not.toBe("not reported");
      expect(f.benchmark, `${book}/${f.key} states no band`).not.toBe("");
    }
  });

  it.each(BOOKS)("%s: the facts are the WORST ones — a reader arguing with a grade needs those", (book: Book) => {
    const order = ["critical", "watch", "healthy", "strong"];
    const seen = summaryFor(book).verdict.facts.map((f) => order.indexOf(f.verdict));
    expect([...seen].sort((a, b) => a - b), book).toEqual(seen);
  });

  it.each(BOOKS)("%s: a letter is either stated with its model, or refused with a reason", (book: Book) => {
    const v = summaryFor(book).verdict;
    if (v.letter === null) expect(v.unavailable, book).toBeTruthy();
    else {
      expect(v.unavailable, book).toBeNull();
      expect(v.model, book).not.toBe("");
    }
  });
});

describe("executive summary — six tiles, each carrying its comparative", () => {
  it.each(BOOKS)("%s: exactly the six, and none repeats a card the document already has", (book: Book) => {
    const es = summaryFor(book);
    expect(es.tiles.map((t) => t.key)).toEqual([...SUMMARY_TILE_KEYS]);
    expect(new Set(es.tiles.map((t) => t.key)).size).toBe(6);
    // Altman and ROE have their own cards further down; a tile
    // repeating one would print a concept twice on one page.
    expect(es.tiles.map((t) => t.key)).not.toContain("altman_z");
    expect(es.tiles.map((t) => t.key)).not.toContain("roe");
  });

  it.each(BOOKS)("%s: on a book with no prior, every tile's variance is a stated gap", (book: Book) => {
    const es = summaryFor(book);
    expect(es.comparatives.available, book).toBe(false);
    expect(es.comparatives.degradedNote).toBe(
      "No comparatives — position report, not performance report",
    );
    for (const tile of es.tiles) {
      expect(tile.line, `${book}/${tile.key} has no comparative line at all`).not.toBeNull();
      for (const kind of ["prior_period", "prior_year"] as const) {
        expect(tile.line!.vs[kind].absolute, `${book}/${tile.key}/${kind}`).toBeNull();
        expect(tile.line!.vs[kind].unavailable, `${book}/${tile.key}/${kind}`).toBeTruthy();
      }
    }
  });

  it.each(BOOKS)("%s: the tile still carries the CURRENT figure", (book: Book) => {
    for (const tile of summaryFor(book).tiles) {
      if (tile.key === "net_debt_ebitda") continue; // undefined when EBITDA is 0
      expect(tile.value, `${book}/${tile.key}`).not.toBeNull();
    }
  });
});

describe("executive summary — what would change the verdict", () => {
  it.each(BOOKS)("%s: every rung is on the ratio's OWN ladder, and the distance checks", (book: Book) => {
    const metrics = metricsFor(book);
    const s = statementsFor(book);
    const credit = computeCreditScore(s, undefined, undefined, metrics);
    const ratios = computeRatios(s, undefined, metrics);
    const all = [
      ...ratios.liquidity, ...ratios.profitability, ...ratios.leverage,
      ...ratios.coverage, ...ratios.efficiency, altmanRatio(credit),
    ];
    const es = buildExecutiveSummary(s, ratios, credit, [altmanRatio(credit)]);
    expect(es.wouldChange.length, book).toBeGreaterThan(0);
    expect(es.wouldChangeAbsence, book).toBeNull();
    expect(es.wouldChangeBasis, book).toContain("same band object");
    for (const d of es.wouldChange) {
      const r = all.find((x) => x.key === d.ratioKey);
      expect(r, `${book}: ${d.ratioKey} is not a printed ratio`).toBeDefined();
      const rungs = Object.values(r!.ladder!.bands).filter((x): x is number => typeof x === "number");
      expect(rungs, `${book}/${d.ratioKey}: ${d.threshold} is not on its ladder`).toContain(d.threshold);
      expect(d.value, `${book}/${d.ratioKey} value`).toBe(r!.value);
      expect(d.distance).toBeCloseTo(Math.abs(r!.value! - d.threshold), 9);
      expect(d.toVerdict, `${book}/${d.ratioKey} offers the band it is already in`).not.toBe(r!.verdict);
      if (d.distancePctOfThreshold !== null) {
        expect(d.distancePctOfThreshold).toBeCloseTo((d.distance / Math.abs(d.threshold)) * 100, 6);
      }
    }
  });

  it.each(BOOKS)("%s: nearest first, by the basis it prints", (book: Book) => {
    const ranked = summaryFor(book).wouldChange
      .map((d) => d.distancePctOfThreshold)
      .filter((x): x is number => x !== null);
    expect([...ranked].sort((a, b) => a - b), book).toEqual(ranked);
  });

  it.each(BOOKS)("%s: a WITHHELD sector cutoff does not come back through the summary", (book: Book) => {
    // The card refused to print "≤ 60 days for FMCG" while the sector is
    // disputed. A distance-to-threshold row quoting 60 would be the same
    // cutoff, restated, one page earlier.
    const s = disputedBook(book);
    const metrics = metricsFor(book);
    const credit = computeCreditScore(s, undefined, undefined, metrics);
    const es = buildExecutiveSummary(s, computeRatios(s, undefined, metrics), credit);
    const leaked = es.wouldChange.filter((d) => SECTOR_CALIBRATED_RATIOS.has(d.ratioKey));
    expect(
      leaked.map((d) => `${d.ratioKey} @ ${d.threshold}`),
      `${book}: a sector cutoff the card withheld is quoted in the summary`,
    ).toEqual([]);
  });

  it.each(BOOKS)("%s: NON-VACUITY — with the sector agreeing, those rows DO offer rungs", (book: Book) => {
    const s = agreeingBook(book);
    const metrics = metricsFor(book);
    const credit = computeCreditScore(s, undefined, undefined, metrics);
    const es = buildExecutiveSummary(s, computeRatios(s, undefined, metrics), credit, [], 200);
    expect(
      es.wouldChange.some((d) => SECTOR_CALIBRATED_RATIOS.has(d.ratioKey)),
      `${book}: no sector-calibrated row offers a rung even when the sector agrees — ` +
        `the guard above would pass for the wrong reason`,
    ).toBe(true);
  });
});

describe("executive summary — the insights block", () => {
  it.each(BOOKS)("%s: absent today, and SAID to be absent rather than shown as empty", (book: Book) => {
    const es = summaryFor(book);
    if (es.insights.length === 0) {
      expect(es.insightsAbsence, book).toBeTruthy();
    } else {
      expect(es.insights.length).toBeLessThanOrEqual(5);
      expect(es.insightsAbsence, book).toBeNull();
      const ranks = es.insights.map((i) => i.rank);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });
});
