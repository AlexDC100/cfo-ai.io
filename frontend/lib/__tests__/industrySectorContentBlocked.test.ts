/**
 * 0.1 — THE OWNER'S CASE, REPRODUCIBLE, AND THE BLOCK PROVEN OVER THE
 * PRINTED EXPORT.
 *
 * The owner read a LIVE Agras report whose workspace industry said
 * "Real estate · residential rental" over a book carrying 301 raw
 * materials, 341/345 own-produced stock, 371 merchandise and 70.5M of
 * cost of sales. `src/engine/industry/structural_signal.py` reads that
 * mix and disagrees; `renderReportHtml` already withheld the header
 * assertion and the profile-gated recommendations.
 *
 * WHY THIS GATE EXISTS AND `industryBlockExport.test.ts` WAS NOT ENOUGH.
 * That gate composes the disputed payload inside itself and asserts on
 * the header and the rule ids. It says so in its own TC-11 note:
 *
 *     WHAT IT CANNOT SEE: the benchmark strings in the ratio tables.
 *     "≤ 60 days for FMCG · varies by industry" is hardcoded … and does
 *     not read the workspace setting at all … It is reported, not
 *     repaired, in this wave.
 *
 * Measured on the disputed Agras export before the repair, the header
 * said, verbatim:
 *
 *     "Until then no sector benchmark, and no recommendation scoped to a
 *      sector, is included below"
 *
 * and §Efficiency, three screens down, printed
 *
 *     Days Inventory Outstanding   32 days   Healthy   ≤ 60 days for FMCG · varies by industry
 *
 * One document, two answers, and the promise was the one that was false.
 *
 * THE FIXTURE IS NOW COMMITTED, not composed. Every `saga_10_col_*.json`
 * carries `industry: null` — a setting that agrees with nothing and
 * disagrees with nothing — so the disagreement was reachable from no
 * artefact on disk. `tests/engine/fixtures/firm/workspace_industry.json`
 * records which workspace key each book agrees with and which it
 * disputes; `exportBooks.servedAs()` joins it with the real
 * `industry_signal.json` capture and the real book. All three sides are
 * engine output (TC-1).
 *
 * WHAT THIS GATE REDS ON AFTER THE REPAIR (TC-11)
 *   · a sector-calibrated band printed while the sector is disputed —
 *     the FMCG string, or any of the six rows whose healthy range the
 *     methodology itself gives as an industry range;
 *   · a VERDICT BADGE surviving on such a row. Withholding the sentence
 *     and keeping the badge banded off the same numbers would be TC-10
 *     backwards: the cutoff hidden from the conclusion it produced;
 *   · any sector idiom from the G9 lexicon appearing while disputed;
 *   · the header failing to name BOTH readings;
 *   · AND THE NEGATIVE — the same book under an agreeing setting losing
 *     any of it. A block that blocks unconditionally is not a block, it
 *     is a deletion, and it would pass every assertion above.
 *
 * WHAT IT CANNOT SEE
 *   · a sector-calibrated band whose row is not in
 *     `SECTOR_CALIBRATED_RATIOS`. The set is declared, not detected; the
 *     lexicon half below catches a NAMED sector, but a band silently
 *     calibrated on one sector without naming it ships unnoticed.
 *   · the on-screen `/report` page, which is a different renderer.
 *   · the workbook / CSV exports.
 */

import { describe, expect, it } from "vitest";

import {
  BOOKS,
  agreeingBook,
  disputedBook,
  exportDoc,
  exportHtml,
  metricsFor,
  ratioCards,
  workspaceKeys,
  type Book,
} from "./exportBooks";
import {
  SECTOR_CALIBRATED_RATIOS,
  SECTOR_BAND_WITHHELD,
  computeRatios,
} from "@/lib/financialReport";
import { readIndustrySignal } from "@/lib/industrySignal";

/** Sector idioms that belong to exactly one sector. Kept in step with
 *  `noWrongSectorLanguage.test.ts` (G9), which polices the same words in
 *  the no-industry case; this half polices the DISPUTED case. */
const SECTOR_IDIOMS = [
  "FMCG",
  "vacancy",
  "LTV",
  "loan-to-value",
  "single-tenant",
  "cap rate",
  "rent roll",
  "yield on cost",
  "like-for-like",
  "footfall",
  "same-store",
  "takt time",
];

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ");
}

/** The six rows whose labels the sector-calibrated set covers, as the
 *  document prints them — resolved from `computeRatios` rather than
 *  hard-typed, so a renamed row cannot silently leave the gate's sight. */
function sectorCalibratedLabels(book: Book): string[] {
  const r = computeRatios(disputedBook(book), undefined, metricsFor(book));
  return [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency]
    .flat()
    .filter((x) => SECTOR_CALIBRATED_RATIOS.has(x.key))
    .map((x) => x.label);
}

describe("0.1 — the committed fixture really is the owner's disagreement", () => {
  it.each(BOOKS)("%s: the disputed setting disagrees and blocks; the other agrees", (book: Book) => {
    const bad = readIndustrySignal(disputedBook(book).industry_signal);
    const good = readIndustrySignal(agreeingBook(book).industry_signal);
    expect(bad, `${book} disputed signal`).not.toBeNull();
    expect(good, `${book} agreeing signal`).not.toBeNull();
    expect(bad!.agreement, book).toBe("disagree");
    expect(bad!.block_sector_content, book).toBe(true);
    expect(good!.agreement, book).toBe("agree");
    expect(good!.block_sector_content, book).toBe(false);
    // and the settings are genuinely different, so the pair is a real
    // disagreement rather than the same key twice
    expect(workspaceKeys(book).agrees).not.toBe(workspaceKeys(book).disputes);
  });

  it("agras is served under exactly the setting the owner's report was", () => {
    expect(disputedBook("agras").industry).toBe("Real estate · residential rental");
    expect(readIndustrySignal(disputedBook("agras").industry_signal)!.display).toBe(
      "Manufacturing / production",
    );
  });

  it("is not vacuous: six rows are sector-calibrated and they are printed rows", () => {
    expect(SECTOR_CALIBRATED_RATIOS.size).toBe(6);
    for (const book of BOOKS) {
      const labels = sectorCalibratedLabels(book);
      expect(labels.length, book).toBe(6);
      const printed = ratioCards(exportDoc(book, agreeingBook(book))).map((c) => c.label);
      for (const l of labels) expect(printed, `${book} prints ${l}`).toContain(l);
    }
  });
});

describe("0.1 — while the sector is disputed the printed export withholds sector content", () => {
  it.each(BOOKS)("%s: the header names BOTH readings and asserts neither", (book: Book) => {
    const s = disputedBook(book);
    const signal = readIndustrySignal(s.industry_signal)!;
    const text = visibleText(exportHtml(book, s));
    expect(text).toContain("unconfirmed");
    expect(text).toContain(signal.display!);
    expect(text).toContain(signal.workspace.display!);
  });

  it.each(BOOKS)("%s: no sector-calibrated band is printed, and none is graded", (book: Book) => {
    const cards = ratioCards(exportDoc(book, disputedBook(book)));
    for (const label of sectorCalibratedLabels(book)) {
      const card = cards.find((c) => c.label === label);
      expect(card, `${book}: the export prints no card "${label}"`).toBeDefined();
      expect(
        card!.meta,
        `${book}: "${label}" still prints a sector band while the sector is disputed`,
      ).toContain(SECTOR_BAND_WITHHELD);
      for (const badge of ["Strong", "Healthy", "Watch", "Critical"]) {
        expect(
          card!.meta,
          `${book}: "${label}" is still graded "${badge}" off the ladder whose cutoff ` +
            `this same card refused to print`,
        ).not.toContain(badge);
      }
    }
  });

  it.each(BOOKS)("%s: no sector idiom appears anywhere in the document", (book: Book) => {
    const text = visibleText(exportHtml(book, disputedBook(book))).toLowerCase();
    const leaked = SECTOR_IDIOMS.filter((w) => text.includes(w.toLowerCase()));
    expect(
      leaked,
      `${book}: the header promises no sector benchmark below, and the document says ${leaked.join(", ")}`,
    ).toEqual([]);
  });

  it.each(BOOKS)("%s: the sector-NEUTRAL bands are untouched", (book: Book) => {
    // The block is not a deletion. Liquidity, leverage and coverage
    // ladders are one number for every business in the methodology's own
    // table, so they still grade.
    const cards = ratioCards(exportDoc(book, disputedBook(book)));
    const neutral = cards.filter(
      (c) => !sectorCalibratedLabels(book).includes(c.label) && c.meta !== "",
    );
    expect(neutral.length, book).toBeGreaterThanOrEqual(8);
    expect(
      neutral.some((c) => /Strong|Healthy|Watch|Critical/.test(c.meta)),
      `${book}: every card lost its verdict — the block deleted the report instead of scoping it`,
    ).toBe(true);
  });
});

describe("0.1 — THE NEGATIVE: with the sector agreeing, all of it renders", () => {
  it.each(BOOKS)("%s: every sector-calibrated band is printed and graded", (book: Book) => {
    const cards = ratioCards(exportDoc(book, agreeingBook(book)));
    for (const label of sectorCalibratedLabels(book)) {
      const card = cards.find((c) => c.label === label);
      expect(card, `${book} card "${label}"`).toBeDefined();
      expect(
        card!.meta,
        `${book}: "${label}" withholds its band even though the mix seconds the setting`,
      ).not.toContain(SECTOR_BAND_WITHHELD);
      // ── "Not graded" IS ALLOWED HERE, AND THE LINE ABOVE IS WHY ─────
      //
      // This gate's content is the assertion directly above: on an
      // agreeing book, NO row may be withheld for a SECTOR reason. A row
      // may still be ungraded for a reason that has nothing to do with
      // sector, and one is: `realestate` reports a cost of sales of
      // 0.00, so its Gross Margin is 100.0% by construction and the
      // ladder ("≥ 40% strong") is grading the absence of a cost line.
      // That row prints its figure and states its own reason.
      //
      // Widening the word list without the `SECTOR_BAND_WITHHELD`
      // assertion above would gut the gate; with it, the sector block
      // still cannot hide behind a second kind of withholding, because
      // a sector withholding carries the sector sentence and reds.
      expect(
        /Strong|Healthy|Watch|Critical|Not reported|Not graded/.test(card!.meta),
        `${book}: "${label}" carries no verdict on an agreeing book: ${JSON.stringify(card!.meta)}`,
      ).toBe(true);
    }
  });

  it.each(BOOKS)("%s: the header states the setting plainly", (book: Book) => {
    const s = agreeingBook(book);
    // Scoped to the header line, not the whole document: the withheld-
    // band sentence itself ends "…the sector is unconfirmed", so a
    // document-wide search for that word would red for the right
    // OUTCOME and the wrong REASON.
    const header = (
      exportDoc(book, s).querySelector(".header-info")?.textContent ?? ""
    ).replace(/\s+/g, " ");
    expect(header).toContain(`Industry: ${s.industry}`);
    expect(header).not.toContain("unconfirmed");
  });

  it("the FMCG band — the exact string the owner saw — comes back on a food book", () => {
    const card = ratioCards(exportDoc("agras", agreeingBook("agras"))).find(
      (c) => c.label === "Days Inventory Outstanding",
    );
    expect(card!.meta).toContain("≤ 60 days for FMCG");
  });
});
