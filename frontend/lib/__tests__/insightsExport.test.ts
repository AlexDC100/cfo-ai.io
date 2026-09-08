// THE FINDINGS, IN THE PRINTED DOCUMENT — parsed back out of its own bytes.
//
// WHAT THIS GATE EXISTS FOR (TC-11, the honest version).
//
// `src/engine/insights/` runs eight detectors, `pipeline.py` attaches the
// block to `statements.insights`, `insights.ts` reads it and
// `executiveSummary.ts` ranks the top five. All of it was built, tested
// and served — and imported by NO RENDERER. Measured on 2026-09-07
// against HEAD d31a6da: `buildReportHtml` produced 133,472 bytes for the
// agras book WITH the insights block and 133,472 bytes WITHOUT it. Not a
// figure moved, not a word. The document printed "Financials in healthy
// range across all dimensions" over a book on which the engine had
// graded five separate findings `high`, and the owner read the deployed
// report and said nothing had changed. He was right.
//
// So this file asserts over the RENDERED EXPORT (TC-7) — the `<!doctype
// html>` string the Export tab writes to disk, parsed as a document —
// because the screen and the export are different renderers and the
// block reaching one says nothing about the other.
//
// WHAT IT REDS ON, once the renderer is correct:
//   · the section disappearing, or any single insight's card going
//     missing from it (G-R1, G-R2)
//   · the five `high` agras findings not being in the printed bytes —
//     the exact defect the owner met (G-R3)
//   · a card that names no accounts, or names them without balances:
//     the traceability the laws require has to be IN the artefact (G-R4)
//   · a severity level printed without the basis it was scaled against —
//     "High" against what? (G-R5)
//   · the ladder not rendering, or rendering without marking the rung
//     this book actually sits on (G-R6, TC-10)
//   · an ABSENT block producing anything at all: no empty section, no
//     "no findings" line, no dead contents anchor (G-R7)
//   · a null measure printed as a number instead of "not reported" (G-R8)
//   · `not_fired` being dropped — a detector that ran and found nothing
//     is a result, and dropping it is the ABSENT≠ZERO surface (G-R9)
//   · the executive summary losing the top five, the comparatives
//     degrading to a dash or a zero instead of a sentence, or "what
//     would change the verdict" vanishing (G-R10..G-R12)
//   · the KPI strip printing a SECOND net income / EBITDA beside the
//     cards' — the R1 defect this wave repaired, in a new place (G-R13)
//   · a figure printed under one name at two values with nothing on the
//     page saying so. Rendering this section put the ratio table and the
//     detectors in one document for the first time, and on three of the
//     four books they disagree about days payables outstanding (27 vs
//     37.2 on agras — the card divides by total operating cost, the
//     detector by cost of goods sold). The renderer cannot reconcile two
//     arithmetics; it must refuse to let the contradiction be silent, and
//     G-R14 reds both ways — a missing note where the figures differ, and
//     a note where they agree, so it can never become decoration.
//
// WHAT IT CANNOT SEE:
//   · whether the engine's own numbers are right. Every figure asserted
//     here is compared against the committed block, not recomputed — if
//     `insights.json` is captured off the wrong seam (v3-punchlist P1),
//     this gate goes green over the wrong numbers and the capture's own
//     gate is what has to catch it.
//   · the on-screen `/report` surface. Different renderer, different
//     gate (`reportBooks.tsx`).
//   · whether a detector SHOULD have fired. `not_fired` is rendered as
//     the engine states it; nothing here second-guesses the detector.
//   · a dropped SECTION with the executive summary intact. G-R3 stays
//     green in that state, because the top five also print on page one —
//     G-R1/G-R2/G-R4/G-R5/G-R6/G-R9 are what red on it. Measured: with
//     `${insightsSection()}` removed from the document, 22 of 48 red and
//     G-R3 was not among them.

import { describe, expect, it } from "vitest";

import {
  BOOKS,
  exportDoc,
  exportHtml,
  insightsFixture,
  statementsFor,
  withInsights,
  parsePrinted,
  type Book,
} from "./exportBooks";
import {
  formatAmount,
  formatMeasure,
  readInsights,
  severityCaption,
  severityLadder,
  type Insight,
} from "@/lib/insights";

const text = (el: Element | null): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

function insightsOf(book: Book): Insight[] {
  const block = readInsights(withInsights(book));
  expect(block, `insights.json carries no readable block for ${book}`).not.toBeNull();
  return (block as NonNullable<typeof block>).insights;
}

function cardFor(doc: Document, id: string): Element {
  const card = doc.querySelector(`.insight-card[data-insight-id="${id}"]`);
  if (!card) {
    throw new Error(
      `the printed document carries no insight card for ${JSON.stringify(id)}; it carries: ` +
        Array.from(doc.querySelectorAll(".insight-card"))
          .map((c) => JSON.stringify(c.getAttribute("data-insight-id")))
          .join(", "),
    );
  }
  return card;
}

// ── G-R1 — THE SECTION IS IN THE DOCUMENT ─────────────────────────────

describe("G-R1 · the findings section is printed", () => {
  it.each(BOOKS)("%s carries section#insights, titled and linked", (book) => {
    const doc = exportDoc(book, withInsights(book));
    const section = doc.querySelector("section#insights");
    expect(section, `${book}: the printed document carries no section#insights`).toBeTruthy();
    expect(text(section!.querySelector("h2"))).toBe("What the numbers say");
    // …and the contents rail links to it, so a reader can reach it.
    expect(
      doc.querySelectorAll('a[href="#insights"]').length,
      `${book}: nothing in the document links to the findings section`,
    ).toBeGreaterThan(0);
  });

  it("the block changes the bytes at all — the defect was that it did not", () => {
    const without = exportHtml("agras");
    const with_ = exportHtml("agras", withInsights("agras"));
    expect(
      with_.length,
      "the printed export is the same size with and without the insights block — " +
        "nothing renders it, which is exactly the state the owner met",
    ).toBeGreaterThan(without.length);
  });
});

// ── G-R2 — EVERY INSIGHT THE ENGINE EMITTED HAS A CARD ────────────────

describe("G-R2 · every emitted insight is printed, none dropped", () => {
  it.each(BOOKS)("%s prints one card per insight, in rank order", (book) => {
    const doc = exportDoc(book, withInsights(book));
    const emitted = insightsOf(book);
    const printed = Array.from(
      doc.querySelectorAll("section#insights .insight-card"),
    ).map((c) => c.getAttribute("data-insight-id"));
    expect(printed).toEqual(emitted.map((i) => i.id));
    for (const i of emitted) {
      const card = cardFor(doc, i.id);
      expect(card.getAttribute("data-severity")).toBe(i.severity.level);
      expect(text(card.querySelector(".insight-title"))).toBe(i.title);
      // The ENGINE's claim string, verbatim: the renderer formats, it
      // does not re-render the sentence with its own arithmetic.
      expect(text(card.querySelector(".insight-claim"))).toBe(i.claim);
      expect(text(card.querySelector(".insight-formula"))).toContain(i.formula);
    }
  });
});

// ── G-R3 — THE OWNER'S CASE ───────────────────────────────────────────

describe("G-R3 · the five HIGH agras findings are in the printed bytes", () => {
  const HIGH_ON_AGRAS = [
    "asset_age",
    "liquidity_quality",
    "reconstruction_gap",
    "related_party_exposure",
    "unclassified_balances",
  ] as const;

  it("the fixture still grades exactly these five high", () => {
    const high = insightsOf("agras")
      .filter((i) => i.severity.level === "high")
      .map((i) => i.id)
      .sort();
    expect(high).toEqual([...HIGH_ON_AGRAS].sort());
  });

  it("each one's title and claim appear in the document's own bytes", () => {
    const html = exportHtml("agras", withInsights("agras"));
    const byId = new Map(insightsOf("agras").map((i) => [i.id, i]));
    // These are raw BYTES, not a parsed document — "P&L" reaches disk as
    // "P&amp;L", so the search string is escaped the way the renderer
    // escapes it. Reading the bytes is the point: a defect that lives in
    // the export and not on the screen is only visible here.
    const asWritten = (t: string): string =>
      t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    for (const id of HIGH_ON_AGRAS) {
      const i = byId.get(id)!;
      expect(html, `${id}: its title is nowhere in the printed document`).toContain(
        asWritten(i.title),
      );
      expect(html, `${id}: its claim is nowhere in the printed document`).toContain(
        asWritten(i.claim),
      );
    }
  });

  it("and they reach page one, not only the section at the back", () => {
    const doc = exportDoc("agras", withInsights("agras"));
    const onPageOne = Array.from(
      doc.querySelectorAll("#sec-exec ul.summary-insights li[data-insight-id]"),
    ).map((li) => li.getAttribute("data-insight-id"));
    expect(onPageOne).toEqual([...HIGH_ON_AGRAS]);
  });
});

// ── G-R4 — THE ACCOUNTS, WITH THEIR BALANCES ──────────────────────────

describe("G-R4 · each card names the accounts it read, with balances", () => {
  it.each(BOOKS)("%s prints every account of every insight", (book) => {
    const doc = exportDoc(book, withInsights(book));
    const block = readInsights(withInsights(book))!;
    for (const i of block.insights) {
      if (i.accounts.length === 0) continue;
      const rows = Array.from(
        cardFor(doc, i.id).querySelectorAll("table.insight-accounts tbody tr"),
      );
      expect(rows.length, `${book}/${i.id}: account rows printed`).toBe(i.accounts.length);
      rows.forEach((tr, n) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        expect(text(tds[0])).toBe(i.accounts[n].code);
        // `text()` collapses runs of whitespace, and several of these
        // account names carry double spaces in the book itself; the
        // comparison collapses both sides rather than pretending the
        // renderer altered the name.
        expect(text(tds[1])).toBe(i.accounts[n].name.replace(/\s+/g, " ").trim());
        // The balance, printed by the one formatter and readable back.
        expect(text(tds[2])).toBe(formatAmount(i.accounts[n].amount, block.currency));
        expect(parsePrinted(text(tds[2]))).toBeCloseTo(i.accounts[n].amount, 2);
      });
    }
  });
});

// ── G-R5 — A LEVEL NEVER PRINTS WITHOUT ITS BASIS ─────────────────────

describe("G-R5 · the severity chip carries the basis it was scaled against", () => {
  it.each(BOOKS)("%s: every chip states level AND basis", (book) => {
    const doc = exportDoc(book, withInsights(book));
    for (const i of insightsOf(book)) {
      const chipEl = cardFor(doc, i.id).querySelector(".insight-severity")!;
      const chip = text(chipEl);
      expect(chip, `${book}/${i.id}: bare level with no basis beside it`).toBe(
        severityCaption(i),
      );
      // The chip carries its own level, and does NOT borrow the ratio
      // badge palette: `v-watch` in this stylesheet is byte-identical to
      // `v-healthy`, so a `high` finding wearing it would print in the
      // colour the document reserves for "this is fine".
      expect(chipEl.getAttribute("data-level")).toBe(i.severity.level);
      for (const borrowed of ["v-healthy", "v-watch", "v-strong", "v-unknown"]) {
        expect(
          chipEl.classList.contains(borrowed),
          `${book}/${i.id}: the severity chip borrows .badge.${borrowed}`,
        ).toBe(false);
      }
      // A bare word is what R4 exists to stop: the chip must say what the
      // magnitude was measured against, or that the scale was missing.
      expect(chip.length).toBeGreaterThan(("Critical").length + 3);
      const basis = text(cardFor(doc, i.id).querySelector(".insight-basis"));
      expect(basis).toContain(i.severity.basis_label);
      expect(basis).toContain(formatAmount(i.severity.basis_value, "RON"));
    }
  });
});

// ── G-R6 — THE LADDER, RENDERED FROM THE DATA THE VERDICT USED ────────

describe("G-R6 · TC-10 — the cutoffs are printed, not described", () => {
  it.each(BOOKS)("%s: every rung renders, and this book's rung is marked", (book) => {
    const doc = exportDoc(book, withInsights(book));
    for (const i of insightsOf(book)) {
      const rungs = severityLadder(i);
      if (rungs.length === 0) continue;
      const rows = Array.from(
        cardFor(doc, i.id).querySelectorAll("table.insight-ladder tbody tr"),
      );
      expect(rows.length, `${book}/${i.id}: ladder rows`).toBe(rungs.length);
      rows.forEach((tr, n) => {
        expect(text(tr.querySelector("td"))).toBe(rungs[n].label);
      });
      const active = rows.filter((tr) => tr.classList.contains("active-rung"));
      expect(active.length, `${book}/${i.id}: exactly one rung marked as this book's`).toBe(1);
      expect(text(active[0].querySelector("td"))).toBe(
        rungs.find((rung) => rung.active)!.label,
      );
    }
  });
});

// ── G-R7 — AN ABSENT BLOCK RENDERS NOTHING ────────────────────────────

describe("G-R7 · absence is absence — never an empty findings section", () => {
  it.each(BOOKS)("%s served without the block prints no section, no anchor", (book) => {
    const doc = exportDoc(book, statementsFor(book));
    expect(
      doc.querySelector("section#insights"),
      `${book}: a findings section rendered for a period that carries no findings block — ` +
        "an empty section asserts the book is clean, which is a claim nobody made",
    ).toBeNull();
    expect(doc.querySelectorAll(".insight-card").length).toBe(0);
    expect(doc.querySelectorAll(".insight-not-fired").length).toBe(0);
    // …and page one gains nothing either: no findings list, and no
    // sentence claiming the detectors were run and came back quiet.
    expect(doc.querySelectorAll("ul.summary-insights").length).toBe(0);
    // Nor a line REPORTING the absence. "This period was served without
    // an insights block" is true, and it is still the wrong thing to
    // print on every legacy period: the reader did not ask, and a
    // document that narrates its own missing subsystems teaches readers
    // to skip its notices. Absent means nothing renders.
    expect(exportHtml(book)).not.toMatch(/insights block/i);
    expect(exportHtml(book)).not.toMatch(/insight detectors/i);
    // …and no dead contents entry pointing at a section that is not there.
    expect(doc.querySelectorAll('a[href="#insights"]').length).toBe(0);
    // The words a synthesised empty block would produce.
    expect(exportHtml(book)).not.toMatch(/no findings/i);
  });
});

// ── G-R8 — A NULL MEASURE IS "not reported", NEVER A NUMBER ───────────

describe("G-R8 · ABSENT is not ZERO inside a finding", () => {
  it("a measure the engine could not compute prints as a stated gap", () => {
    // Real engine output, one field emptied — the shape a detector emits
    // when its input was not on the envelope.
    const fx = insightsFixture("agras");
    const holed = JSON.parse(JSON.stringify(fx)) as typeof fx;
    const first = holed.insights[0] as unknown as {
      id: string;
      measures: Array<{ key: string; label: string; value: number | null; unit: string }>;
    };
    const target = first.measures[1];
    const label = target.label;
    target.value = null;

    const doc = exportDoc("agras", { ...statementsFor("agras"), insights: holed } as never);
    const row = Array.from(
      cardFor(doc, first.id).querySelectorAll("table.insight-measures tbody tr"),
    ).find((tr) => text(tr.querySelector("td")) === label);
    expect(row, `no measures row labelled ${JSON.stringify(label)}`).toBeTruthy();
    const printed = text(row!.querySelectorAll("td")[1]);
    expect(printed).toBe("not reported");
    expect(printed).not.toMatch(/\d/);
    expect(printed).toBe(formatMeasure({ value: null, unit: "money" }, "RON"));
  });
});

// ── G-R9 — "CHECKED AND CLEAR" IS PRINTED ─────────────────────────────

describe("G-R9 · a detector that ran and did not fire is still news", () => {
  it("retail's not_fired entry is printed with its stated reason", () => {
    const fx = insightsFixture("retail");
    expect(fx.not_fired.length, "the retail fixture no longer carries a not_fired entry")
      .toBeGreaterThan(0);
    const doc = exportDoc("retail", withInsights("retail"));
    const list = doc.querySelector(".insight-not-fired");
    expect(list, "retail prints no 'checked and clear' list").toBeTruthy();
    for (const n of fx.not_fired) {
      const li = list!.querySelector(`li[data-insight-id="${String(n.id)}"]`);
      expect(li, `not_fired ${String(n.id)} was dropped from the printed document`).toBeTruthy();
      expect(text(li)).toContain(String(n.reason));
    }
  });

  it("a book with nothing to report prints no empty 'checked and clear' list", () => {
    expect(insightsFixture("agras").not_fired.length).toBe(0);
    const doc = exportDoc("agras", withInsights("agras"));
    expect(doc.querySelector(".insight-not-fired")).toBeNull();
  });
});

// ── G-R10 — THE COMPARATIVES DEGRADE TO A SENTENCE ────────────────────

describe("G-R10 · no prior period is a sentence, never a dash or a zero", () => {
  it.each(BOOKS)("%s says so plainly, on the note and on every line", (book) => {
    const doc = exportDoc(book, withInsights(book));
    const note = text(doc.querySelector("#sec-exec .comparatives-note"));
    expect(note).toContain("position report, not performance report");
    expect(note).toContain("no prior period was supplied with this book");

    const table = doc.querySelector("#sec-exec table.comparatives");
    expect(table, `${book}: no headline-figures table on page one`).toBeTruthy();
    const cells = Array.from(table!.querySelectorAll("tbody tr td.nocmp"));
    expect(cells.length, `${book}: comparison cells`).toBeGreaterThan(0);
    for (const td of cells) {
      expect(text(td)).toBe("no prior period");
      // The two spellings that read as "no change" and are therefore lies.
      expect(text(td)).not.toBe("—");
      expect(text(td)).not.toMatch(/^[+−-]?0(\.0+)?%?$/);
      // …and the reason travels with the cell rather than being lost.
      expect(td.getAttribute("title") ?? "").not.toBe("");
    }
  });
});

// ── G-R11 — WHAT WOULD CHANGE THE VERDICT ─────────────────────────────

describe("G-R11 · the rungs this book is nearest to crossing", () => {
  it.each(BOOKS)("%s prints the distances, and its own ordering rule", (book) => {
    const doc = exportDoc(book, withInsights(book));
    const table = doc.querySelector("#sec-exec table.would-change");
    expect(table, `${book}: no 'what would change the verdict' table`).toBeTruthy();
    const rows = Array.from(table!.querySelectorAll("tbody tr"));
    expect(rows.length, `${book}: threshold rows`).toBeGreaterThan(0);
    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll("td"));
      const now = parsePrinted(text(tds[1]));
      const rung = parsePrinted(text(tds[2]));
      const distance = parsePrinted(text(tds[3]));
      expect(now).not.toBeNull();
      expect(rung).not.toBeNull();
      expect(distance).not.toBeNull();
      // THE ROW MUST FOOT. A distance that is not |now − rung| is a
      // number a reader cannot check against the two beside it.
      expect(Math.abs(Math.abs(now! - rung!) - distance!)).toBeLessThan(
        Math.max(Math.abs(distance!) * 0.02, 1e-6),
      );
      expect(tr.getAttribute("data-to-verdict")).toBeTruthy();
    }
    // The ordering key, printed, so the ranking is checkable (TC-10).
    expect(text(doc.querySelector("#sec-exec table.would-change")?.previousElementSibling ?? null))
      .toContain("nearest first");
  });
});

// ── G-R12 — WHY THIS VERDICT ──────────────────────────────────────────

describe("G-R12 · the grade travels with the facts that produced it", () => {
  it.each(BOOKS)("%s prints the graded facts, worst first", (book) => {
    const doc = exportDoc(book, withInsights(book));
    const block = doc.querySelector("#sec-exec .verdict-facts");
    expect(block, `${book}: page one states a verdict with no evidence beside it`).toBeTruthy();
    const rows = Array.from(block!.querySelectorAll("tr[data-verdict-fact]"));
    expect(rows.length).toBeGreaterThan(0);
    const RANK: Record<string, number> = { Critical: 0, Watch: 1, Healthy: 2, Strong: 3 };
    const verdicts = rows.map((tr) => text(tr.querySelectorAll("td")[2]));
    for (let n = 1; n < verdicts.length; n += 1) {
      expect(
        RANK[verdicts[n]] >= RANK[verdicts[n - 1]],
        `${book}: verdict facts are not worst-first (${verdicts.join(" → ")})`,
      ).toBe(true);
    }
    // Every fact names its band, so the word is checkable (TC-10).
    for (const tr of rows) {
      expect(text(tr.querySelectorAll("td")[3]).length).toBeGreaterThan(0);
    }
  });
});

// ── G-R13 — ONE CONCEPT, ONE VALUE, ACROSS THE STRIP AND THE CARDS ────

describe("G-R13 · R1 — the KPI strip quotes the document's own figures", () => {
  const CARD_TO_TILE: Array<[string, string]> = [
    ["Net Income (account 121, as filed)", "net_income"],
    ["Operating revenue", "revenue"],
  ];

  it.each(BOOKS)("%s: the strip and the cards print one value per concept", (book) => {
    const doc = exportDoc(book, withInsights(book));
    for (const [cardLabel, tileKey] of CARD_TO_TILE) {
      const card = Array.from(doc.querySelectorAll("#sec-exec .ratio-card")).find(
        (c) => text(c.querySelector(".label")) === cardLabel,
      );
      if (!card) continue;
      const row = doc.querySelector(`#sec-exec tr[data-tile="${tileKey}"]`);
      expect(row, `${book}: no headline row for ${tileKey}`).toBeTruthy();
      const fromCard = parsePrinted(text(card.querySelector(".value")));
      const fromStrip = parsePrinted(text(row!.querySelectorAll("td")[1]));
      expect(
        fromStrip,
        `${book}: the KPI strip prints ${fromStrip} for ${tileKey} while the card two inches ` +
          `above prints ${fromCard} — one concept, two values, one page`,
      ).toBe(fromCard);
    }
  });

  // ── G-R14 — the collision the section made possible ─────────────────
  //
  // Until the findings section existed, the ratio table and the
  // detectors never met in one file. They do now, and on three of the
  // four books they disagree about days payables outstanding — the ratio
  // card divides by TOTAL operating cost, `trade_float` by cost of goods
  // sold. The renderer cannot reconcile two arithmetics and must not
  // pretend to; what it must not do is let the contradiction be silent.
  //
  // This gate reads PRINTED STRINGS only, so it cannot inherit the
  // renderer's own matching rule: it compares every measure row against
  // every ratio card of the same name, and demands a stated note exactly
  // where the two figures differ — and no note where they agree, so the
  // notice can never become decoration.
  /** Half a display step of a printed figure. `halfStep` from the
   *  harness reads the last separator group, so a thousands separator
   *  makes "RON 18,420,491" look like three decimals; money figures are
   *  the whole point of this comparison, so the step is read off the
   *  decimal point alone. A compacted figure ("RON 7.53M") carries no
   *  usable precision at all and is skipped rather than guessed at. */
  const printedHalfStep = (printed: string): number => {
    const t = printed.replace(/[\u00a0\u202f ]/g, "");
    if (/\d[KMB](?![A-Za-z])/.test(t)) return Number.POSITIVE_INFINITY;
    const m = t.match(/\.(\d+)/);
    return 0.5 / Math.pow(10, m ? m[1].length : 0);
  };

  const cardKey = (label: string): string =>
    label
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  it.each(BOOKS)("%s: a same-named figure that differs says so, and one that agrees is quiet", (book) => {
    const doc = exportDoc(book, withInsights(book));
    const cards = new Map(
      Array.from(doc.querySelectorAll(".ratio-card")).map((c) => [
        cardKey(text(c.querySelector(".label"))),
        text(c.querySelector(".value")),
      ]),
    );
    let compared = 0;
    for (const card of doc.querySelectorAll("section#insights .insight-card")) {
      for (const tr of card.querySelectorAll("table.insight-measures tbody tr")) {
        if (tr.classList.contains("measure-clash")) continue;
        const tds = Array.from(tr.querySelectorAll("td"));
        const key = cardKey(text(tds[0]));
        const onCard = cards.get(key);
        if (onCard === undefined) continue;
        const mine = parsePrinted(text(tds[1]));
        const theirs = parsePrinted(onCard);
        if (mine === null || theirs === null) continue;
        compared += 1;
        // TWO DISPLAY PRECISIONS ARE NOT TWO VALUES. The ratio card
        // prints days at whole numbers and `formatMeasure` at one
        // decimal, so 26.2056 reaches the page as "26.2 days" and
        // "26 days"; money rounds to the unit on a card and to the cent
        // inside a finding. Both are roundings, not disagreements. The
        // comparison is widened by the half-step of BOTH printed forms,
        // and what survives it is a difference in the arithmetic.
        const slack = printedHalfStep(text(tds[1])) + printedHalfStep(onCard);
        const differs = Math.abs(mine - theirs) > slack;
        const note = tr.nextElementSibling;
        const noted = note !== null && note.classList.contains("measure-clash");
        if (differs) {
          expect(
            noted,
            `${book}: "${text(tds[0])}" reads ${text(tds[1])} inside a finding and ${onCard} on a ` +
              "ratio card in the same document, and nothing on the page says so",
          ).toBe(true);
          expect(text(note!)).toContain(onCard);
        } else {
          expect(
            noted,
            `${book}: "${text(tds[0])}" agrees with its ratio card and still carries a contradiction note`,
          ).toBe(false);
        }
      }
    }
    expect(compared, `${book}: no measure name matched any ratio card — the gate compared nothing`)
      .toBeGreaterThan(0);
  });

  it("agras: the DPO disagreement is stated, with both formulas", () => {
    const doc = exportDoc("agras", withInsights("agras"));
    const note = doc.querySelector(
      '.insight-card[data-insight-id="trade_float"] tr.measure-clash[data-clash="days payables outstanding"]',
    );
    expect(
      note,
      "agras prints DPO twice — 37.2 days inside trade_float, 27 days on a ratio card — with nothing between them",
    ).toBeTruthy();
    const said = text(note);
    expect(said).toContain("Days Payables Outstanding");
    expect(said).toContain("27 days");
    expect(said).toContain("TOTAL operating expense");
    expect(said).toContain("cost of goods sold");
  });

  it("agras: the strip prints the FILED close, not the reconstruction", () => {
    // The two readings on this book are 7,533,676.02 (account 121, what
    // the card prints) and 14,106,102.03 (the class-6/7 rebuild). A strip
    // built from `deriveTotals` alone prints the second one.
    const doc = exportDoc("agras", withInsights("agras"));
    const row = doc.querySelector('#sec-exec tr[data-tile="net_income"]')!;
    const printed = parsePrinted(text(row.querySelectorAll("td")[1]));
    expect(printed).toBeCloseTo(7_533_676, 0);
    expect(printed).not.toBeCloseTo(14_106_102, 0);
  });
});
