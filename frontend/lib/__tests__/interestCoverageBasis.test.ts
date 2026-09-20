// Interest coverage is EBIT / interest; EBITDA / interest is the separate
// `ebitda_to_interest` row (CLAUDE.md Appendix A, section 5; decisions D14).
// Two hunks of that move had no gate (B8 repair-round verifier, TC-2):
//
//  (b) the NO-ENVELOPE credit model's coverage term (financialValuation.ts
//      `computeCreditScore`): reverted to statutory EBITDA, all of vitest
//      stayed green — the four books' sub-scores do not move, only the
//      printed row value does (agras 55.64 -> 66.28, retail -0.52 -> +0.09).
//  (c) the ROMANIAN half of the one label authority: '(EBITDA / dobânzi)'
//      planted on the interest_coverage label, all of vitest green.
//
// REDS ON, AFTER THE REPAIR (TC-11): the no-envelope coverage row's value
// leaving the pinned EBIT figure on a book with interest; either coverage
// key's label, in either language, missing its own basis token or carrying
// the other's.
// CANNOT SEE: the engine's row (test_credit_model_pure.py) or the served
// reader's row (ratioTableByteMatch).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeCreditScore } from "@/lib/financialValuation";
import { statementsFor, type Book } from "./exportBooks";

// EBIT / interest as served by the engine for the same books (D14 blast
// radius) — literals, NOT recomputed here from the statements.
const EBIT_BASIS: Array<[Book, number, number]> = [
  // book, EBIT / interest, EBITDA / interest (what the row must NOT be)
  ["agras", 55.64, 66.28],
  ["realestate", -25.13, -25.08],
  ["retail", -0.52, 0.09],
];

describe("the no-envelope credit model's coverage row divides EBIT", () => {
  it.each(EBIT_BASIS)("%s: %d, never the EBITDA figure %d", (book, ebitBasis, ebitdaBasis) => {
    const credit = computeCreditScore(statementsFor(book));
    const row = credit.components.find((c) => c.label.startsWith("Interest coverage"));
    expect(row, "no coverage component").toBeTruthy();
    expect(row!.label).toBe("Interest coverage (EBIT / interest)");
    expect(Number(row!.value).toFixed(2)).toBe(ebitBasis.toFixed(2));
    expect(Number(row!.value).toFixed(2)).not.toBe(ebitdaBasis.toFixed(2));
  });
});

describe("each coverage key's label states its own basis, in both languages", () => {
  const load = (lang: string) =>
    JSON.parse(readFileSync(resolve(__dirname, `../../i18n/locales/${lang}.json`), "utf-8"))
      .statements.ratioCmp.label as Record<string, string>;

  it.each(["en", "ro"])("%s", (lang) => {
    const label = load(lang);
    // EBIT but not EBITDA: the token followed by a non-letter.
    expect(label.interest_coverage).toMatch(/\(EBIT \/ /);
    expect(label.interest_coverage).not.toMatch(/EBITDA/);
    expect(label.ebitda_to_interest).toMatch(/\(EBITDA \/ /);
    expect(label.ebitda_to_interest).not.toMatch(/\(EBIT \/ /);
  });
});
