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
// radius) — literals, NOT recomputed here from the statements. Re-read from
// the tb_parser_v6 capture (tests/engine/fixtures/firm/served_metrics.json,
// `interest_coverage` / `ebitda_to_interest`) after the 609/709
// contra-convention repair moved agras and retail; before it they were
// agras 55.64 / 66.28 and retail -0.52 / 0.09.
const EBIT_BASIS: Array<[Book, number, number]> = [
  // book, EBIT / interest, EBITDA / interest (what the row must NOT be)
  ["agras", 28.14, 38.77],
  ["realestate", -25.13, -25.08],
  ["retail", 0.32, 0.93],
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

// ── THE NO-ENVELOPE MODEL DOES NOT FLOOR A ZERO-INTEREST BOOK (owner floors
// ruling, 2026-09-18; surfaces re-verify, low) ─────────────────────────────
// `safeDiv(ebit, 0) = 0` read "Below covenant", sub-score 15. Carniprod has
// no debt, no interest and a positive EBIT: it scored 67.8 BB+ here against
// the engine's labelled rung and 79.3 A. The model now does what the engine
// does (R-D1): the top rung, LABELLED as declared, only when debt == 0,
// interest == 0 and EBIT > 0 are all reported; otherwise the component
// refuses, and the completeness law mints no composite and no letter.
// REDS ON, after the repair: a coverage or DSCR sub-score of 15 (or any
// measured-looking value) on a book whose interest expense is zero or
// declared absent; a declared rung on a book with debt, a non-positive EBIT
// or an unreported operand; a composite or letter beside a refused term.
// CANNOT SEE: the engine path (creditRefusedSubscores.test.tsx), and
// whether the feed should have carried the line (publicCompanyAdapters).
describe("the no-envelope model refuses or declares the rung on a zero interest expense", () => {
  const rows = (s: ReturnType<typeof statementsFor>) => {
    const credit = computeCreditScore(s);
    return {
      credit,
      cov: credit.components.find((c) => c.label.startsWith("Interest coverage"))!,
      dscr: credit.components.find((c) => c.label.startsWith("~DSCR"))!,
    };
  };

  it("carniprod (no debt, no interest, EBIT > 0): the declared top rung, labelled, and a composite", () => {
    const s = statementsFor("carniprod");
    expect(s.incomeStatement.interestExpense).toBe(0);
    expect(s.balanceSheet.shortTermDebt + s.balanceSheet.longTermDebt).toBe(0);
    const { credit, cov, dscr } = rows(s);
    expect(cov.value).toBeNull();
    expect(cov.subscore).toBe(95);
    expect(dscr.subscore).toBe(90);
    for (const r of [cov, dscr]) {
      expect(r.refusal ?? null).toBeNull();
      expect(r.declaredRung?.label).toContain("by declared rule, not measured");
      expect(r.read).toContain("not measured");
      expect(r.read).not.toContain("Below");
    }
    expect(credit.score).not.toBeNull();
    expect(credit.rating).not.toBeNull();
  });

  it("the same book WITH debt declares nothing: both terms refuse, no composite, no letter", () => {
    const s = statementsFor("carniprod");
    s.balanceSheet = { ...s.balanceSheet, longTermDebt: 1000 };
    // the reader takes debt from the served totals when they are present
    if (s.assembled_bs) s.assembled_bs = { ...s.assembled_bs, total_debt: 1000, long_term_debt: 1000 };
    const { credit, cov, dscr } = rows(s);
    expect(cov.subscore).toBeNull();
    expect(cov.value).toBeNull();
    expect(cov.refusal?.code).toBe("interest_expense_not_positive");
    expect(cov.declaredRung ?? null).toBeNull();
    // 1,000 of debt gives a principal estimate, so DSCR is measured
    expect(dscr.subscore).not.toBeNull();
    expect(credit.score).toBeNull();
    expect(credit.rating).toBeNull();
    expect(credit.grade).toBeNull();
  });

  it.each([["interestExpense"], ["longTermDebt"], ["shortTermDebt"]])(
    "an operand the source declares absent (%s) declares nothing either",
    (absent) => {
      const s = statementsFor("carniprod");
      s.absentInputs = [...(s.absentInputs ?? []), absent as never];
      const { credit, cov, dscr } = rows(s);
      expect(cov.declaredRung ?? null).toBeNull();
      expect(dscr.declaredRung ?? null).toBeNull();
      expect(cov.subscore).toBeNull();
      expect(dscr.subscore).toBeNull();
      expect(cov.refusal?.code).toBe(absent === "interestExpense" ? "credit_inputs_absent" : "interest_expense_not_positive");
      expect(credit.score).toBeNull();
      expect(credit.rating).toBeNull();
    },
  );

  // realestate, not retail: under tb_parser_v6 retail's EBIT is positive,
  // so it no longer carries the non-positive-EBIT case this test is about.
  it("a non-positive EBIT declares nothing (realestate: EBIT < 0, with its interest zeroed and its debt removed)", () => {
    const s = statementsFor("realestate");
    expect(s.assembled_pl?.ebit ?? Number.NaN).toBeLessThan(0);
    s.incomeStatement = { ...s.incomeStatement, interestExpense: 0 };
    s.balanceSheet = { ...s.balanceSheet, shortTermDebt: 0, longTermDebt: 0 };
    if (s.assembled_pl) s.assembled_pl = { ...s.assembled_pl, interest_expense: 0 };
    if (s.assembled_bs) s.assembled_bs = { ...s.assembled_bs, total_debt: 0, long_term_debt: 0, short_term_debt: 0 };
    const { credit, cov } = rows(s);
    expect(cov.subscore).toBeNull();
    expect(cov.declaredRung ?? null).toBeNull();
    expect(cov.refusal?.code).toBe("interest_expense_not_positive");
    expect(credit.rating).toBeNull();
  });

  it("a measured book is banded exactly as before", () => {
    const { cov, credit } = rows(statementsFor("agras"));
    expect(cov.subscore).toBe(95);
    expect(cov.refusal ?? null).toBeNull();
    expect(cov.declaredRung ?? null).toBeNull();
    expect(credit.score).not.toBeNull();
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
