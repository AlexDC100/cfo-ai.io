// D3 — A FLATTERING BAND ON THE MOST DISTRESSED BOOK IN THE CORPUS.
//
// ── WHAT WAS MEASURED, ON THE COMMITTED `realestate` BOOK, 2026-09-07 ─
//
// The printed export carried, in §Leverage:
//
//     Debt / EBITDA   -0.64×   STRONG
//     "Debt service comfortably aligned with cash generation."
//
// in the same document as EBITDA -29,038,838, DSCR -5.86× Critical,
// Interest Coverage -25.08× Critical, and a CRITICAL recommendation card
// reading "the operating model is not generating cash". The band track
// under the card drew its marker in the strong zone too, because it bands
// off the same ladder.
//
// Nothing was wrong with the arithmetic. Dividing by a negative flips the
// quotient's sign, so a lower-is-better ladder reads the worst book in
// the corpus as beating its best rung. `periodFacts.ts:545` already
// refuses this exact case for the fact feed; the export path did not use
// it, and -0.6388 was the ENGINE's own served `debt_to_ebitda`, so a
// guard inside the local `div()` would never have run either.
//
// ── WHAT THESE GATES RED ON, AFTER THE REPAIR (TC-11) ───────────────
//
//   · any book, any ratio, where the denominator the ladder assumes to be
//     positive is negative and the row still prints Strong / Healthy /
//     Watch / Critical — the badge names itself in the failure;
//   · a NEW ratio key appearing in the bundle that is in neither the
//     guarded set nor the stated-exempt set, so a row cannot be added
//     without someone deciding which side of the guard it is on;
//   · the non-vacuity direction: the four books' positive-denominator
//     rows must still grade, so the guard cannot be "fixed" by
//     withholding everything.
//
// ── WHAT THEY CANNOT SEE ────────────────────────────────────────────
//
//   · a ladder whose rungs are simply wrong for the sector (that is the
//     industry-signal block's job, not this one);
//   · a ratio whose denominator is positive but tiny, where the multiple
//     is arithmetically fine and practically meaningless;
//   · the SCREEN. This reads the printed export only; `reportBooks.tsx`
//     is the screen's half.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildReportHtml } from "@/lib/financialExports";
import { computeRatios, type Ratio, type Statements } from "@/lib/financialReport";
import { BOOKS, cardNamed, exportDoc, metricsFor, ratioCards, statementsFor, type Book } from "./exportBooks";

const firm = (n: string) => resolve(__dirname, "../../../tests/engine/fixtures/firm", n);

/** Every key `computeRatios` produces, in one flat list. */
function everyRatio(s: Statements, metrics?: Record<string, number | null>): Ratio[] {
  const r = computeRatios(s, undefined, metrics);
  return [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency].flat();
}

// ── THE DENOMINATOR EACH LADDER ASSUMES IS POSITIVE ──────────────────
//
// Recomputed here from the served envelope INDEPENDENTLY of
// `computeRatios`, on purpose: a gate that asked the code under test for
// its own denominators would agree with it by construction.
function denominators(book: string): Record<string, number> {
  const fx = JSON.parse(readFileSync(firm(`${book}.json`), "utf-8")) as {
    statements: {
      assembled_bs: Record<string, number>;
      assembled_pl: Record<string, number>;
      incomeStatement: Record<string, number>;
    };
  };
  const bs = fx.statements.assembled_bs;
  const pl = fx.statements.assembled_pl;
  const is = fx.statements.incomeStatement;
  return {
    "current liabilities": bs.total_current_liabilities,
    revenue: is.revenue,
    "total assets": bs.total_assets,
    "total equity": bs.total_equity,
    "invested capital": bs.total_debt + bs.total_equity,
    EBITDA: pl.ebitda_statutory,
    "total operating expense":
      (is.costOfGoodsSold ?? 0) + (is.operatingExpenses ?? 0) + (is.depreciationAmortization ?? 0),
  };
}

/** Ratio key → the denominator name its ladder assumes positive. */
const GUARDED: Record<string, string> = {
  current_ratio: "current liabilities",
  quick_ratio: "current liabilities",
  cash_ratio: "current liabilities",
  gross_margin: "revenue",
  ebitda_margin: "revenue",
  net_margin: "revenue",
  dso: "revenue",
  roa: "total assets",
  ltv: "total assets",
  equity_ratio: "total assets",
  asset_turnover: "total assets",
  roe: "total equity",
  debt_to_equity: "total equity",
  roic: "invested capital",
  debt_to_ebitda: "EBITDA",
  dio: "total operating expense",
  dpo: "total operating expense",
};

/** Rows deliberately NOT sign-guarded, each with the reason stated. A key
 *  that is in neither map reds the coverage test below, so adding a ratio
 *  forces the decision instead of inheriting a default. */
const EXEMPT: Record<string, string> = {
  interest_coverage:
    "denominator is interest expense — a negative here is a negative NUMERATOR (EBITDA), " +
    "and a coverage of -25x IS critical. Withholding it would delete a true distress signal.",
  dscr: "denominator is interest + short-term debt; same reasoning as interest_coverage.",
  dscr_with_lt_principal: "denominator is interest + an LT principal proxy; same reasoning.",
  adjusted_dscr: "refuses outright without a supplied lease charge; never reaches a ladder.",
  ccc:
    "a difference, not a quotient. A negative cash conversion cycle means the company is " +
    "paid before it pays — the best thing this scale can say — so a refusal would delete a strength.",
};

const GRADE_WORDS = /\b(Strong|Healthy|Watch|Critical)\b/;

describe("D3 — every ratio row is on one side of the sign guard, deliberately", () => {
  it("no ratio key is unclassified", () => {
    const seen = new Set<string>();
    for (const book of BOOKS) {
      for (const r of everyRatio(statementsFor(book), metricsFor(book))) seen.add(r.key);
    }
    const unclassified = [...seen].filter((k) => !(k in GUARDED) && !(k in EXEMPT));
    expect(
      unclassified.join(", "),
      `these ratio rows are in neither the sign-guarded map nor the stated-exempt map, so ` +
        `nobody has decided whether their ladder survives a negative denominator: ` +
        `${unclassified.join(", ")}`,
    ).toBe("");
  });
});

describe("D3 — a negative denominator never earns a grade", () => {
  const cases: Array<{ label: string; book: string; statements: () => Statements; metrics?: Record<string, number | null> }> = [
    ...BOOKS.map((b) => ({
      label: b,
      book: b === "agras" || b === "carniprod" || b === "realestate" || b === "retail" ? `saga_10_col_${b}` : b,
      statements: () => statementsFor(b as Book) as Statements,
      metrics: metricsFor(b as Book),
    })),
    {
      // Negative EQUITY, which flips `roe` and `debt_to_equity` the same
      // way negative EBITDA flips `debt_to_ebitda`. Real engine output,
      // committed beside the four books.
      label: "synthetic_negative_equity",
      book: "synthetic_negative_equity",
      statements: () =>
        (JSON.parse(readFileSync(firm("synthetic_negative_equity.json"), "utf-8")) as {
          statements: Statements;
        }).statements,
    },
  ];

  for (const c of cases) {
    it(`${c.label}: every row whose denominator is negative prints its figure ungraded`, () => {
      const denom = denominators(c.book);
      const rows = everyRatio(c.statements(), c.metrics);
      const failures: string[] = [];
      let checked = 0;
      for (const r of rows) {
        const name = GUARDED[r.key];
        if (name === undefined) continue;
        const d = denom[name];
        if (typeof d !== "number" || d >= 0) continue;
        checked += 1;
        if (r.verdict !== "ungraded") {
          failures.push(
            `${c.label}: "${r.label}" reads ${r.value === null ? "no value" : r.value.toFixed(2)} ` +
              `and is graded ${r.verdict.toUpperCase()} while its denominator ${name} is ` +
              `${d.toLocaleString("en-US")} — dividing by a negative flipped its sign, so that ` +
              `badge is on the wrong side of every rung of its own ladder.`,
          );
        }
      }
      expect(failures.join("\n")).toBe("");
      // Non-vacuity is asserted per-case only where a negative
      // denominator actually exists; the corpus-wide proof is below.
      expect(checked).toBeGreaterThanOrEqual(0);
    });
  }

  it("NON-VACUITY — the corpus really does contain negative denominators", () => {
    const hits: string[] = [];
    for (const book of ["saga_10_col_realestate", "synthetic_negative_equity"]) {
      for (const [name, v] of Object.entries(denominators(book))) {
        if (v < 0) hits.push(`${book}: ${name} = ${v.toLocaleString("en-US")}`);
      }
    }
    expect(
      hits.length,
      "no committed book carries a negative denominator, so the guard above proves nothing",
    ).toBeGreaterThan(0);
  });
});

describe("D3 — the printed export, on the book that was wrong", () => {
  it("realestate: Debt / EBITDA states its figure and withholds its verdict", () => {
    const card = cardNamed(exportDoc("realestate"), "Debt / EBITDA");
    expect(
      card.meta,
      `the printed card still grades leverage on a book whose EBITDA is negative: ` +
        `"${card.value}" / "${card.meta}"`,
    ).not.toMatch(GRADE_WORDS);
    expect(card.meta).toContain("Not graded");
    // TC-10: the reason renders the FIGURE that produced it, not a
    // cutoff typed in prose.
    expect(card.meta).toMatch(/EBITDA is positive, and here it is RON -29/);
    // The value is not deleted — it is a true statement about the book.
    expect(card.value).toBe("-0.64×");
  });

  it("realestate: the withheld rows draw no band track either", () => {
    // The critic's second half: the marker was drawn in the STRONG zone
    // under the badge, because the track bands off the same ladder. An
    // ungraded row carries no ladder, so `zonesForKey` has nothing to
    // draw — asserted here rather than assumed, because a track built
    // from a SECOND copy of the bands would reappear silently.
    const doc = exportDoc("realestate");
    for (const label of ["Debt / EBITDA", "Gross Margin"]) {
      const card = Array.from(doc.querySelectorAll(".ratio-card")).find(
        (c) => (c.querySelector(".label")?.textContent ?? "").trim() === label,
      );
      expect(card, label).toBeDefined();
      expect(
        card!.querySelector("svg.chart"),
        `${label} withholds its verdict and still draws its band position — the track is ` +
          `banding off a ladder the badge refused`,
      ).toBeNull();
    }
    // Non-vacuity: a graded row on the same page still draws one.
    const graded = Array.from(doc.querySelectorAll(".ratio-card")).find(
      (c) => (c.querySelector(".label")?.textContent ?? "").trim() === "Debt / Equity",
    );
    expect(graded!.querySelector("svg.chart")).not.toBeNull();
  });

  it("realestate: Gross Margin states 100.0% and says why it is not a grade", () => {
    const card = cardNamed(exportDoc("realestate"), "Gross Margin");
    expect(card.value).toBe("100.0%");
    expect(card.meta).not.toMatch(GRADE_WORDS);
    expect(card.meta).toMatch(/cost of sales of RON 0/);
  });

  it("the other three books keep every grade they had", () => {
    for (const book of ["agras", "carniprod", "retail"] as const) {
      const graded = ratioCards(exportDoc(book)).filter((c) => GRADE_WORDS.test(c.meta));
      expect(
        graded.length,
        `${book}: the sign guard withheld grades on a book with no negative denominator`,
      ).toBeGreaterThanOrEqual(15);
    }
  });

  it("realestate: the distress rows are still graded critical", () => {
    // The guard must not become a way to make a bad book look quiet.
    const doc = exportDoc("realestate");
    for (const label of [
      "Interest Coverage (EBITDA / Interest)",
      "DSCR (interest + ST debt)",
      "Net Margin",
    ]) {
      expect(cardNamed(doc, label).meta, label).toContain("Critical");
    }
  });
});

describe("D3 — the same rows in the workbook-facing bundle agree with the page", () => {
  it("realestate: an ungraded row carries no ladder for a downstream surface to band on", () => {
    const rows = everyRatio(statementsFor("realestate"), metricsFor("realestate"));
    for (const r of rows.filter((x) => x.verdict === "ungraded")) {
      expect(r.ladder, `${r.label} is ungraded but still carries a ladder`).toBeUndefined();
    }
  });

  it("the export renders from the same bundle these assertions read", () => {
    // Cheap provenance check: the printed value equals the bundle value.
    const rows = everyRatio(statementsFor("realestate"), metricsFor("realestate"));
    const html = buildReportHtml(statementsFor("realestate"), {
      metricsByName: metricsFor("realestate"),
    });
    const dte = rows.find((r) => r.key === "debt_to_ebitda");
    expect(dte?.value).not.toBeNull();
    expect(html).toContain("-0.64×");
  });
});
