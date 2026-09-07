// G-L1 — THE RATIO LAYER: THE LADDER, THE LEASE, THE CASH.
//
// Everything below is asserted over the RENDERED EXPORT (TC-7) — the
// `<!doctype html>` string `buildReportHtml` writes, parsed back out.
// Not one assertion reads `computeRatios()`' return value to decide what
// the document should say; where a ladder object is read at all it is
// read as the SECOND opinion the printed band is checked against.
//
// The three defects it was written for were found by reading the owner's
// own deployed Agras report, and every one of them lived in the printed
// document while a green gate stood beside it:
//
//   N1  Long-term other debt (167)          RON 887,498
//       Adjusted DSCR (incl. lease)  7.43×  "no lease supplied —
//                                            identical to DSCR above"
//       — the same figure as the card above it, under a name claiming to
//       include a lease, declaring no lease on a book carrying a
//       finance-lease liability (`classification.yaml:107`, rule ro.167).
//
//   N2  Days Payables Outstanding  27 days  Critical
//       "Higher = better supplier float (within terms)"
//       — a distress verdict produced by cutoffs 60/45/30 that appear
//       nowhere on the card, on a scale that has no distress end, four
//       cards away from "Cash Conversion Cycle 31 days Healthy".
//
//   N3  Cash Ratio  0.09×  Critical  "cash / current liabilities"
//       — while RON 906,526 of short-term investments (RAS class 50)
//       sits in the same book's current assets. Counting them: 0.159×,
//       which is Watch. One band either side of an unstated choice.
//
// And one this lane found by measuring rather than reading: every
// PERCENTAGE ratio's on-card band chip was built from `assembled_bands`
// (fractions — `net_margin.healthy = 0.08`) while the badge above it was
// banded from `Ratio.ladder` (percents — `6.35`), so fourteen cards
// across these four books drew a marker in the STRONG zone under a badge
// reading Watch or Critical.
//
// ── WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11) ─────────────────
//  · a graded card whose printed band omits any rung of its own ladder,
//    or prints a comparator-anchored number that is not one of them
//    (TC-10: the cutoffs a reader sees are the cutoffs the word came
//    from, because they are RENDERED from that object)
//  · a graded card whose band carries no numbers at all
//  · the lease-adjusted card printing a figure on a book that supplies
//    no annual lease charge; printing the plain DSCR's figure under a
//    name claiming a lease; or saying anything about whether this
//    company holds leases
//  · a refusal naming its missing input in camelCase
//  · DPO grading below `watch` on any of the four books; its ladder
//    growing a `watch` rung back without the band sentence following;
//    its label losing the denominator that separates it from the
//    insight engine's differently-based DPO
//  · the cash-ratio card printing a formula that does not name what its
//    "cash" excludes, or a value that is not exactly cash ÷ current
//    liabilities (the words and the arithmetic must move together)
//  · a band chip whose marker lands in a zone the badge does not name —
//    read off the rendered SVG's own geometry, which is how the
//    fractions-vs-percents defect showed itself
//
// ── WHAT IT CANNOT SEE ───────────────────────────────────────────────
//  · whether a ladder's cutoffs are RIGHT. It pins that the ladder
//    applied is the ladder printed, never that 45 days is the correct
//    place for `healthy`. The DPO rungs in particular are general-SME
//    defaults calibrated on a cost-of-goods-sold denominator while this
//    figure divides by total operating cost; the card now says so, and
//    no gate can decide whether the caveat is enough.
//  · the UPPER end of DPO. The scale is still one-sided, so a company
//    stretching suppliers to 200 days would grade `strong` and nothing
//    here reds. Naming it rather than pretending otherwise.
//  · the on-screen `/report` page and the ratio drawer — different
//    surfaces, different harnesses.
//  · whether account 50 SHOULD be in the cash ratio. The served
//    `BalanceSheet` shape carries no short-term-investments field, so
//    this surface cannot include it either way; the gate holds the
//    disclosure, not the choice.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BOOKS,
  type Book,
  cardNamed,
  disputedBook,
  exportDoc,
  metricsFor,
  parsePrinted,
  ratioCards,
  statementsFor,
} from "./exportBooks";
import { computeRatios, ladderSentence, type Ratio } from "@/lib/financialReport";
import { getRatioKnowledge } from "@/lib/ratioKnowledge";

const DPO_LABEL = "Days Payables Outstanding (on total operating cost)";
const ADJ_DSCR_LABEL = "Adjusted DSCR (incl. lease)";

function ratiosOf(book: Book): Ratio[] {
  const r = computeRatios(statementsFor(book), undefined, metricsFor(book));
  return [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency].flat();
}

/** Every ratio card in the document, joined to the row that produced it
 *  by the `data-ratio-formula` key the card already carries. */
function cardsWithRows(book: Book): Array<{ key: string; card: Element; row: Ratio }> {
  const doc = exportDoc(book);
  const rows = new Map(ratiosOf(book).map((r) => [r.key, r] as const));
  const out: Array<{ key: string; card: Element; row: Ratio }> = [];
  for (const card of Array.from(doc.querySelectorAll(".ratio-card"))) {
    const key = card.querySelector("[data-ratio-formula]")?.getAttribute("data-ratio-formula");
    if (!key) continue;
    const row = rows.get(key);
    if (!row) continue; // altman_z comes off the credit reader, not computeRatios
    out.push({ key, card, row });
  }
  return out;
}

const metaOf = (card: Element): string =>
  (card.querySelector(".meta")?.textContent ?? "").replace(/\s+/g, " ").trim();

// ── 1. TC-10 — THE PRINTED BAND IS THE LADDER, RENDERED ──────────────

describe("G-L1a — every cutoff that produced a word is printed, from the same object", () => {
  it.each(BOOKS)("%s: the band a card prints is its own ladder, rendered", (book: Book) => {
    const graded = cardsWithRows(book).filter((c) => c.row.ladder !== undefined);
    expect(graded.length, "no graded card — this assertion would be vacuous").toBeGreaterThan(10);
    const failures: string[] = [];
    for (const { key, card, row } of graded) {
      const spelled = ladderSentence(row.ladder!, row.unit);
      if (!metaOf(card).includes(spelled)) {
        failures.push(
          `${book}/${key}: the card prints ${JSON.stringify(metaOf(card))} and its ladder ` +
            `renders as ${JSON.stringify(spelled)} — the badge and the printed cutoffs came ` +
            `from different objects`,
        );
      }
    }
    expect(failures, `${book}: a printed band is not this row's own ladder`).toEqual([]);
  });

  it.each(BOOKS)("%s: every rung of the ladder reaches the page", (book: Book) => {
    const failures: string[] = [];
    for (const { key, card, row } of cardsWithRows(book)) {
      if (!row.ladder) continue;
      const printed = metaOf(card);
      for (const [name, v] of Object.entries(row.ladder.bands)) {
        if (typeof v !== "number") continue;
        // The rung's own digits, however the sentence chose to spell it.
        const digits = String(v).replace(/^(\d+)\.0+$/, "$1");
        if (!printed.includes(digits)) {
          failures.push(`${book}/${key}: rung ${name}=${v} decided the badge and is not printed`);
        }
      }
    }
    expect(failures, `${book}: a cutoff decided a verdict without being shown`).toEqual([]);
  });

  it.each(BOOKS)("%s: no graded card states a threshold that is not a rung", (book: Book) => {
    const failures: string[] = [];
    for (const { key, card, row } of cardsWithRows(book)) {
      if (!row.ladder) continue;
      const rungs = Object.values(row.ladder.bands).filter((x): x is number => typeof x === "number");
      // A THRESHOLD IS A NUMBER WITH A SIDE. Prose numbers that carry no
      // comparator ("10-year amortization proxy", "RAS class 50") are
      // identifiers, not cutoffs, and are not the thing TC-10 forbids.
      const stated = Array.from(metaOf(card).matchAll(/[≥≤<>]\s*(-?\d+(?:\.\d+)?)/g)).map((m) =>
        Number(m[1]),
      );
      expect(stated.length, `${book}/${key}: a graded card printed no threshold at all`).toBeGreaterThan(0);
      for (const n of stated) {
        if (!rungs.some((r) => Math.abs(r - n) < 1e-9)) {
          failures.push(
            `${book}/${key}: the card states a cutoff of ${n}, and this row's ladder is ` +
              `${JSON.stringify(rungs)} — a threshold written beside a verdict it did not decide`,
          );
        }
      }
    }
    expect(failures, `${book}: a printed threshold is not on the row's own ladder`).toEqual([]);
  });

  it("a ladder with no watch rung says so, and one with a watch rung names the critical side", () => {
    // The renderer itself, at both shapes — so the sentence in the
    // document above is not the only evidence the distinction exists.
    expect(ladderSentence({ bands: { strong: 60, healthy: 45 }, higherIsBetter: true }, "days")).toBe(
      "strong ≥ 60 d · healthy ≥ 45 d · no critical rung on this scale",
    );
    expect(
      ladderSentence({ bands: { strong: 2, healthy: 1.5, watch: 1 }, higherIsBetter: true }, "x"),
    ).toBe("strong ≥ 2× · healthy ≥ 1.5× · watch ≥ 1× · critical < 1×");
    expect(
      ladderSentence({ bands: { strong: 30, healthy: 60, watch: 100 }, higherIsBetter: false }, "days"),
    ).toBe("strong ≤ 30 d · healthy ≤ 60 d · watch ≤ 100 d · critical > 100 d");
  });
});

// ── 2. N1 — THE LEASE ────────────────────────────────────────────────

describe("G-L1b — an absent lease input is never a finding about the company", () => {
  it.each(BOOKS)("%s: the lease-adjusted card refuses, and refuses in words", (book: Book) => {
    const doc = exportDoc(book);
    const card = cardNamed(doc, ADJ_DSCR_LABEL);
    expect(
      statementsFor(book).supplementary.annualLeaseExpense,
      `${book} supplies a lease charge — this assertion would be testing the wrong branch`,
    ).toBeUndefined();
    expect(parsePrinted(card.value), `${book}: a lease-adjusted figure with no lease charge supplied`).toBeNull();
    expect(card.meta).toContain("an annual lease expense");
    // A refusal a reader cannot act on is a broken refusal, and one
    // spelled in camelCase was written for the code, not the reader.
    expect(card.meta).not.toContain("annualLeaseExpense");
  });

  it.each(BOOKS)("%s: the document never declares this book lease-free", (book: Book) => {
    const html = exportDoc(book).documentElement.outerHTML;
    for (const claim of ["no lease supplied", "No lease component", "no leases"]) {
      expect(
        html.includes(claim),
        `${book}: the document states ${JSON.stringify(claim)} — a conclusion about the ` +
          `company drawn from the absence of a user input, contradicted on the agras book by ` +
          `RON 887,498 in account 167`,
      ).toBe(false);
    }
  });

  it.each(BOOKS)("%s: no card restates the plain DSCR under a name claiming a lease", (book: Book) => {
    const doc = exportDoc(book);
    const plain = cardNamed(doc, "DSCR (interest + ST debt)").value;
    const adjusted = cardNamed(doc, ADJ_DSCR_LABEL).value;
    const both = parsePrinted(plain) !== null && parsePrinted(adjusted) !== null;
    expect(
      both && plain === adjusted,
      `${book}: “${ADJ_DSCR_LABEL}” prints ${adjusted}, the same figure as the card above it`,
    ).toBe(false);
  });

  it("supplied a lease charge, the card computes — and is NOT the plain DSCR", () => {
    // The other branch, so the refusal above is a refusal and not a
    // permanently dead row. `annualLeaseExpense` is user input by
    // definition; no captured book can carry one.
    const s = statementsFor("agras");
    const withLease = { ...s, supplementary: { ...s.supplementary, annualLeaseExpense: 900_000 } };
    const rows = computeRatios(withLease, undefined, metricsFor("agras"));
    const adj = rows.coverage.find((r) => r.key === "adjusted_dscr")!;
    const dscr = rows.coverage.find((r) => r.key === "dscr")!;
    expect(adj.value).not.toBeNull();
    expect(adj.formula).toContain("(EBITDA + annual lease expense)");
    expect(adj.formula).not.toContain("not computed");
    expect(Math.abs(adj.value! - dscr.value!)).toBeGreaterThan(0.01);
  });
});

// ── 3. N2 — DPO ──────────────────────────────────────────────────────

describe("G-L1c — DPO is supplier float, and it is named by its denominator", () => {
  it.each(BOOKS)("%s: paying suppliers is never graded as distress", (book: Book) => {
    const doc = exportDoc(book);
    const card = cardNamed(doc, DPO_LABEL);
    expect(
      card.meta.startsWith("Critical"),
      `${book}: “${DPO_LABEL}” prints ${card.value} and grades it Critical — settling suppliers ` +
        `is not a solvency failure`,
    ).toBe(false);
    expect(card.meta).toContain("no critical rung on this scale");
    const row = ratiosOf(book).find((r) => r.key === "dpo")!;
    expect(row.ladder?.bands.watch, "a watch rung is a declared distress floor; this scale has none").toBeUndefined();
  });

  it.each(BOOKS)("%s: the low end reads below-benchmark, not distress", (book: Book) => {
    const row = ratiosOf(book).find((r) => r.key === "dpo")!;
    expect(row.value).not.toBeNull();
    // Non-vacuous: at least one of the four books is under the healthy
    // rung, which is exactly where the old ladder said "Critical".
    if (row.value! < 45) expect(row.verdict).toBe("watch");
  });

  it("at least one committed book sits under the healthy rung", () => {
    const under = BOOKS.filter((b) => (ratiosOf(b).find((r) => r.key === "dpo")?.value ?? 99) < 45);
    expect(under.length, "no book exercises the low end — the assertion above is vacuous").toBeGreaterThan(0);
  });

  // R1 ACROSS SURFACES. The insight engine's `trade_float` detector
  // computes DPO on cost of goods sold over a narrower payables base.
  // Both blocks are contracted to render in one document. This reads the
  // engine's OWN committed capture, so the disagreement is measured here
  // rather than assumed.
  it("the two DPOs in this product genuinely differ, so the name must not be shared", () => {
    const insights = JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../tests/engine/fixtures/firm/insights.json"),
        "utf-8",
      ),
    ) as Record<string, { insights: Array<{ id: string; measures: Array<{ key: string; value: number | null }> }> }>;
    const engineDpo = insights.agras.insights
      .find((i) => i.id === "trade_float")
      ?.measures.find((m) => m.key === "dpo")?.value;
    const printed = ratiosOf("agras").find((r) => r.key === "dpo")!.value;
    expect(engineDpo, "the insight capture carries no trade_float DPO").not.toBeNull();
    expect(
      Math.abs((engineDpo as number) - (printed as number)),
      "the two surfaces now agree — if that is real, this label may go back to being bare",
    ).toBeGreaterThan(1);
  });

  it.each(BOOKS)("%s: the printed DPO label states its denominator", (book: Book) => {
    const labels = ratioCards(exportDoc(book)).map((c) => c.label);
    expect(labels).toContain(DPO_LABEL);
    expect(
      labels.includes("Days Payables Outstanding"),
      `${book}: a bare "Days Payables Outstanding" is back, beside an insight block that ` +
        `computes a different DPO on a different base`,
    ).toBe(false);
  });
});

// ── 4. N3 — THE CASH RATIO'S EXCLUSION ───────────────────────────────

describe("G-L1d — the cash ratio says which cash", () => {
  it.each(BOOKS)("%s: the printed formula names what it leaves out", (book: Book) => {
    const el = exportDoc(book).querySelector('[data-ratio-formula="cash_ratio"]');
    const formula = (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(formula).toContain("short-term investments");
    expect(formula).toContain("class 50");
    expect(
      formula === "cash ÷ current liabilities",
      `${book}: the formula is back to the bare form that let a Critical badge stand over an ` +
        `undisclosed exclusion`,
    ).toBe(false);
  });

  it.each(BOOKS)("%s: the words match the arithmetic actually performed", (book: Book) => {
    // The claim is "cash and bank balances only". Recomputed here from
    // the served envelope, independently of `computeRatios`.
    const s = statementsFor(book);
    const bs = s.assembled_bs ?? {};
    const cash = bs.cash;
    const cl = bs.total_current_liabilities;
    expect(typeof cash, `${book}: the envelope carries no cash`).toBe("number");
    const rendered = parsePrinted(cardNamed(exportDoc(book), "Cash Ratio").value);
    expect(rendered).not.toBeNull();
    expect(Math.abs(rendered! - cash / cl)).toBeLessThan(0.006);
  });

  it("counting short-term investments would move the agras verdict — the choice is material", () => {
    // Why the disclosure is required rather than merely tidy. The
    // short-term investment balance is not on the served `BalanceSheet`
    // shape, so it is read here from the engine's own canonical capture
    // of the same book; the point of the assertion is the BAND MOVE.
    const s = statementsFor("agras");
    const bs = s.assembled_bs ?? {};
    const asPrinted = bs.cash / bs.total_current_liabilities;
    const stInvestments = 906_526;
    const asIfCounted = (bs.cash + stInvestments) / bs.total_current_liabilities;
    const row = ratiosOf("agras").find((r) => r.key === "cash_ratio")!;
    const watch = row.ladder!.bands.watch!;
    expect(asPrinted).toBeLessThan(watch); // critical, as printed
    expect(asIfCounted).toBeGreaterThan(watch); // watch, if counted
  });
});

// ── 5. THE DRAWER'S FORMULA IS THE ONE THAT PRODUCED THE NUMBER ──────

describe("G-L1f — the textbook formula is not the computed one, and the product says so", () => {
  it("ratioKnowledge's DPO formula disagrees with the arithmetic actually performed", () => {
    // NOT a hypothetical. `ratioKnowledge.ts:413` spells DPO as
    // "(Payables ÷ COGS) × 365"; the served figure divides by TOTAL
    // operating expense. On agras those are 39.1 days and 26.6 days.
    // `RatioDetailDrawer` used to print ONLY the knowledge string under
    // a heading reading "Formula · live numbers", beside the value the
    // other formula produced. It now prints `Ratio.formula` as the
    // authority; this assertion is what keeps that necessary — if the
    // two ever agree, it reds and the extra line can go.
    const knowledge = getRatioKnowledge(ratiosOf("agras").find((r) => r.key === "dpo")!);
    expect(knowledge?.formula).toBeDefined();
    const printed = ratiosOf("agras").find((r) => r.key === "dpo")!.formula;
    expect(
      knowledge!.formula.replace(/\s+/g, " ").toLowerCase(),
      "the two spellings now agree — the drawer's second line is no longer load-bearing",
    ).not.toBe(printed.replace(/\s+/g, " ").toLowerCase());
    expect(knowledge!.formula).toContain("COGS");
    expect(printed).toContain("TOTAL operating expense");
  });

  it("every ratio carries the formula the drawer will print as the authority", () => {
    for (const book of BOOKS) {
      for (const r of ratiosOf(book)) {
        expect(r.formula.length, `${book}/${r.key}: an empty formula`).toBeGreaterThan(10);
      }
    }
  });
});

// ── 6. THE SAME LAWS UNDER THE OWNER'S ACTUAL SETTING ────────────────
//
// Every assertion above runs the book as captured, whose `industry` is
// null. The owner's live case was a meat book served under "Real estate ·
// residential rental", which withholds six ladders — a state in which a
// card carries a value and NO ladder. The three repairs must hold there
// too, and the withheld rows must not leak the cutoff they refused.

describe("G-L1g — under a disputed sector, nothing leaks and nothing regresses", () => {
  it.each(BOOKS)("%s: a withheld band states no threshold", (book: Book) => {
    const doc = exportDoc(book, disputedBook(book));
    const failures: string[] = [];
    for (const card of ratioCards(doc)) {
      if (!card.meta.startsWith("Not graded")) continue;
      const leaked = Array.from(card.meta.matchAll(/[≥≤<>]\s*(-?\d+(?:\.\d+)?)/g)).map((m) => m[0]);
      if (leaked.length > 0) {
        failures.push(`${book}/${card.label}: withheld its band and printed ${leaked.join(", ")}`);
      }
    }
    expect(failures, `${book}: a refused ladder printed a cutoff anyway`).toEqual([]);
    // Non-vacuous: the disputed setting must actually withhold something.
    expect(
      ratioCards(doc).filter((c) => c.meta.startsWith("Not graded")).length,
      `${book}: nothing was withheld — this assertion would be vacuous`,
    ).toBeGreaterThan(0);
  });

  it.each(BOOKS)("%s: the three repairs survive the disputed setting", (book: Book) => {
    const doc = exportDoc(book, disputedBook(book));
    expect(parsePrinted(cardNamed(doc, ADJ_DSCR_LABEL).value)).toBeNull();
    expect(cardNamed(doc, DPO_LABEL).meta.startsWith("Critical")).toBe(false);
    const formula = (
      doc.querySelector('[data-ratio-formula="cash_ratio"]')?.textContent ?? ""
    ).replace(/\s+/g, " ").trim();
    expect(formula).toContain("short-term investments");
    expect(doc.documentElement.outerHTML.includes("no lease supplied")).toBe(false);
  });
});

// ── 7. THE CHIP AND THE BADGE ARE ONE LADDER ─────────────────────────

describe("G-L1e — the band chip lands where the word says", () => {
  /** The rendered chip, read off its own geometry. Zone rects are drawn
   *  at y=4 h=8 in zone order; the value marker at y=1 h=14. The zone
   *  NAMES are in the `<desc>` the chip writes for a screen reader. */
  function chipZoneOf(card: Element): string | null {
    const svg = card.querySelector("svg.chart.mini");
    if (!svg) return null;
    const desc = (svg.querySelector("desc")?.textContent ?? "").trim();
    const names = desc.replace(/^.*placed on its bands:\s*/, "").replace(/\.$/, "").split(", ");
    const rects = Array.from(svg.querySelectorAll("rect"));
    // The track's outline is drawn at the same y/height as the zones and
    // is the only one with no fill — dropping it by geometry alone would
    // silently make this reader count one zone too many.
    const zones = rects.filter(
      (r) =>
        r.getAttribute("y") === "4" &&
        r.getAttribute("height") === "8" &&
        r.getAttribute("fill") !== "none",
    );
    const marker = rects.find((r) => r.getAttribute("y") === "1" && r.getAttribute("height") === "14");
    if (!marker || zones.length !== names.length) return null;
    const mx = Number(marker.getAttribute("x")) + Number(marker.getAttribute("width")) / 2;
    for (let i = 0; i < zones.length; i++) {
      const x = Number(zones[i].getAttribute("x"));
      const w = Number(zones[i].getAttribute("width"));
      if (mx >= x - 0.001 && mx <= x + w + 0.001) return names[i];
    }
    return names[mx < 0 ? 0 : names.length - 1];
  }

  it.each(BOOKS)("%s: no card draws its marker in a zone its badge does not name", (book: Book) => {
    const failures: string[] = [];
    let checked = 0;
    for (const { key, card, row } of cardsWithRows(book)) {
      const zone = chipZoneOf(card);
      if (zone === null) continue;
      checked++;
      if (zone !== row.verdict) {
        failures.push(
          `${book}/${key} (${row.unit}): the badge says ${row.verdict} and the chip draws the ` +
            `marker in the ${zone} zone — two ladders, one card`,
        );
      }
    }
    expect(checked, `${book}: no chip was readable — this assertion would be vacuous`).toBeGreaterThan(10);
    expect(failures, `${book}: a card contradicts itself`).toEqual([]);
  });

  it.each(BOOKS)("%s: a scale with no critical rung draws no critical zone", (book: Book) => {
    for (const { key, card, row } of cardsWithRows(book)) {
      if (row.ladder && row.ladder.bands.watch === undefined) {
        expect(
          card.querySelector("svg.chart.mini"),
          `${book}/${key} declares no critical rung and drew a track that names one`,
        ).toBeNull();
      }
    }
  });
});
