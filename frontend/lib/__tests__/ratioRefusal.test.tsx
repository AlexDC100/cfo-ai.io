// GATE F2-RATIO-REFUSAL — a ratio computed from an input the source never
// carried must REFUSE, and must never wear a provenance card.
//
// ── what was live ─────────────────────────────────────────────────────
//
// `publicCompanyAdapters.ts` wrote `?? 0` at 84 sites and
// `financialReport.ts` divided by the results through
//
//     const safeDiv = (a, b) => (b === 0 ? 0 : a / b);
//
// On the repo's OWN real AAPL envelope the adapted inputs were
// `cogs: 0, opex: 0, interestExpense: 0, accountsPayable: 0,
// longTermDebt: 0` — every one an ABSENT leaf, none of them a filed zero
// — and the page rendered, through the real `<Amount>`:
//
//     interest_coverage        0.00x  CRITICAL   ← EBIT in the same file
//     dscr_with_lt_principal   0.00x  CRITICAL      is 123,216,000,000
//     dpo                      0 d    CRITICAL
//     dio                      232 d  CRITICAL
//     current_ratio            0.23x  CRITICAL
//
// each carrying
//     data-provenance="true" … "method":"derived · computeRatios ·
//     interest_coverage","pack":"nasdaq_v1.0.0"
//
// Less visibly and worse: `deriveTotals` rebuilt EBITDA as
// `revenue − 0 − 0`, so EBITDA read 391.0 B where the same envelope
// reports 134.7 B, and every margin, leverage and distress figure was
// computed against revenue.
//
// ── TC-1 ──────────────────────────────────────────────────────────────
//
// Both fixtures are real. `aapl_envelope.json` is the repo's own captured
// `/api/public/companies/AAPL` payload; `period_carniprod_fy2025.json` is
// captured `/api/period` output for a real Romanian trial balance. Every
// expected figure below is recomputed from the fixture's own numbers
// rather than typed in, so a fixture change moves the assertion with it.
//
// ── TC-9 ──────────────────────────────────────────────────────────────
//
// A gate that only asserts refusals passes on a page that refuses
// everything. Each refusal law here is paired with the ratios that STILL
// compute on the same fixture, and with the private fixture where 19 of
// 23 compute — so "clean" is distinguishable from "empty".

import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "@/test/renderWithProviders";
import { buildPublicStatements } from "@/lib/publicCompanyAdapters";
import {
  altmanRatio,
  computeRatios,
  deriveTotals,
  type Ratio,
  type Statements,
} from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import { factsFrom } from "@/lib/servedFacts";
import { Amount } from "@/components/instrument/Amount";
import { derivedRatioOrigin } from "@/pages/cfo/publicCompanyOrigins";
import type { PublicCompanyEnvelope } from "@/lib/publicCompanyApi";

import aaplJson from "./fixtures/publicCompany/aapl_envelope.json";
import carniprodJson from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";

const aapl = aaplJson as unknown as PublicCompanyEnvelope;
const carniprod = carniprodJson as unknown as Statements;

/** EVERY ROW THE RATIOS TAB RENDERS — which is no longer one object.
 *
 *  `altman_z` used to be `RatioBundle.bankruptcy`, computed by a Z″
 *  formula written inline in `computeRatios`. That was the THIRD
 *  arithmetic in the codebase claiming the name "Altman Z″ (1995 EM)",
 *  and it is deleted; the row is now `altmanRatio(credit)` — a projection
 *  of the ONE credit reader, which the tab, the workbook and the printed
 *  report all render. The SET this gate measures is unchanged (the floors
 *  below are untouched), only where one member is assembled. */
function rowsOf(statements: Statements): Ratio[] {
  return [
    ...Object.values(computeRatios(statements)).flat(),
    altmanRatio(computeCreditScore(statements)),
  ];
}

function publicRatios(): { statements: Statements; all: Ratio[] } {
  const built = buildPublicStatements(aapl);
  if (!built) throw new Error("the AAPL fixture no longer yields statements");
  return { statements: built.statements, all: rowsOf(built.statements) };
}

const byKey = (rows: Ratio[], key: string): Ratio => {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`no ratio \`${key}\` — the bundle changed shape`);
  return r;
};

/** The 15 ratios whose unit routes them through `<Amount>`, which is the
 *  renderer that carries the provenance affordance. Percent ratios go
 *  through `PercentLevel`, which has no provenance prop. */
const CARD_BEARING_UNITS = ["x", "days", "ratio"];

// ── TC-3: is the fixture the subject this gate is about? ───────────────

describe("the AAPL fixture is the right subject", () => {
  it("reports EBIT and EBITDA on the headline, and carries only three leaves", () => {
    const h = aapl.periods[0].headline as Record<string, number>;
    expect(h.ebit).toBeGreaterThan(100_000_000_000);
    expect(h.ebitda).toBeGreaterThan(h.ebit);
    // The absence is the point: a fixture with a full leaf set could not
    // show that an absent leaf is refused.
    const leaves = Object.keys(aapl.periods[0].leaves ?? {});
    expect(leaves).not.toContain("interest_expense_bank");
    expect(leaves).not.toContain("cogs_materials");
    expect(leaves).not.toContain("bank_loans_lt");
  });

  it("the adapter declares those absences instead of writing zeroes", () => {
    const { statements } = publicRatios();
    const absent = new Set(statements.absentInputs ?? []);
    for (const name of [
      "interestExpense",
      "costOfGoodsSold",
      "operatingExpenses",
      "accountsPayable",
      "longTermDebt",
      "shortTermDebt",
      "retainedEarnings",
    ]) {
      expect(
        absent.has(name as never),
        `\`${name}\` is not declared absent, so any ratio using it will be ` +
          "computed from a placeholder zero.",
      ).toBe(true);
    }
  });
});

// ── the refusals ───────────────────────────────────────────────────────

describe("F2 — a ratio over an absent input has no value and no verdict", () => {
  /** The exact five the critic rendered, plus the rest of that family. */
  const MUST_REFUSE = [
    "current_ratio",
    "quick_ratio",
    "cash_ratio",
    "gross_margin",
    "interest_coverage",
    "dscr",
    "adjusted_dscr",
    "dscr_with_lt_principal",
    "dio",
    "dpo",
    "ccc",
    "altman_z",
  ];

  it("each of them returns null, verdict `unknown`, and never `critical`", () => {
    const { all } = publicRatios();
    for (const key of MUST_REFUSE) {
      const r = byKey(all, key);
      expect(r.value, `\`${key}\` still produced a value from an absent input`).toBeNull();
      expect(
        r.verdict,
        `\`${key}\` was GRADED. A ratio nobody could compute has no verdict; ` +
          "grading the substituted 0 is what produced `0.00x critical`.",
      ).toBe("unknown");
    }
  });

  it("interest coverage names the interest expense, beside an EBIT of 123.2 B", () => {
    const { all } = publicRatios();
    const r = byKey(all, "interest_coverage");
    // The numerator is present and large; the refusal is about the
    // denominator, and the reader is told which.
    const ebit = (aapl.periods[0].headline as Record<string, number>).ebit;
    expect(ebit).toBeGreaterThan(123_000_000_000);
    expect(r.commentary).toContain("interest expense");
    expect(r.commentary).toMatch(/^Not reported/);
    expect(r.unavailable).toEqual({ kind: "missing", inputs: ["interestExpense"] });
  });

  it("every refusal states what is missing, in words a reader can check", () => {
    const { all } = publicRatios();
    const refused = all.filter((r) => r.value === null);
    expect(refused.length, "nothing refused — this gate has no subject").toBeGreaterThan(5);
    for (const r of refused) {
      expect(r.commentary.length, `\`${r.key}\` refuses with an empty reason`).toBeGreaterThan(20);
      // Never a bare dash or a blank: a reader takes those for zero.
      expect(r.commentary).not.toBe("—");
      // Field names never reach the reader.
      expect(r.commentary, `\`${r.key}\` leaks a code identifier`).not.toMatch(
        /[a-z][A-Z]|_[a-z]/,
      );
    }
  });
});

// ── TC-9: what still computes, and is now RIGHT ────────────────────────

describe("F2 — the ratios that survive are the ones the feed supports", () => {
  it("eleven compute, and the totals come from the served headline", () => {
    const { all } = publicRatios();
    const computed = all.filter((r) => r.value !== null);
    expect(
      computed.length,
      "nothing computes, so the refusal laws above pass on an empty bundle",
    ).toBeGreaterThan(8);
  });

  it("EBITDA margin is EBITDA over revenue — not revenue over revenue", () => {
    const { all } = publicRatios();
    const h = aapl.periods[0].headline as Record<string, number>;
    const r = byKey(all, "ebitda_margin");
    expect(r.value).toBeCloseTo((h.ebitda / h.revenue) * 100, 6);
    // The reconstruction it replaced: `revenue − cogs(0) − opex(0)`.
    expect(r.value).not.toBeCloseTo(100, 3);
  });

  it("ROE is net income over equity — both served", () => {
    const { all } = publicRatios();
    const h = aapl.periods[0].headline as Record<string, number>;
    const r = byKey(all, "roe");
    expect(r.value).toBeCloseTo((h.net_income / h.total_equity) * 100, 6);
  });

  it("Debt / EBITDA divides the served debt by the served EBITDA", () => {
    const { all } = publicRatios();
    const h = aapl.periods[0].headline as Record<string, number>;
    const r = byKey(all, "debt_to_ebitda");
    expect(r.value).toBeCloseTo(h.total_debt / h.ebitda, 9);
  });
});

// ── the card ───────────────────────────────────────────────────────────

describe("F2 — a refused ratio wears no provenance card", () => {
  it("the derivation origin exists, and is exactly what must NOT be attached", () => {
    // TC-3 for this law: `derivedRatioOrigin` is what put the card on. If
    // it ever stops producing a payload, the assertion below would pass
    // for the wrong reason.
    const p = derivedRatioOrigin(aapl.periods[0], "interest_coverage");
    expect(p).toBeTruthy();
    expect(p!.method).toContain("computeRatios");
  });

  it("`<Amount>` given a refused ratio's value renders no affordance", () => {
    const { all } = publicRatios();
    const r = byKey(all, "interest_coverage");
    expect(CARD_BEARING_UNITS).toContain(r.unit);
    const { container } = renderWithProviders(
      <Amount
        kind="multiple"
        value={r.value}
        cap={99}
        provenance={derivedRatioOrigin(aapl.periods[0], r.key)}
      />,
    );
    expect(
      container.querySelectorAll('[data-provenance="true"]').length,
      "a provenance card opened over a ratio that has no value — the exact " +
        "receipt the critic read off the live DOM.",
    ).toBe(0);
  });

  it("…while a ratio that DID compute still carries one", async () => {
    const { all } = publicRatios();
    const r = byKey(all, "debt_to_ebitda");
    expect(r.value).not.toBeNull();
    const { container } = renderWithProviders(
      <Amount
        kind="multiple"
        value={r.value}
        cap={99}
        provenance={derivedRatioOrigin(aapl.periods[0], r.key)}
      />,
    );
    const card = container.querySelector<HTMLElement>('[data-provenance="true"]');
    expect(
      card,
      "no card on a computed ratio either — the refusal law above would " +
        "then be passing because nothing renders a card at all (TC-9)",
    ).toBeTruthy();
    fireEvent.focus(card!);
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"))
          .map((n) => n.textContent ?? "")
          .join(" "),
      ).toContain("debt_to_ebitda"),
    );
  });
});

// ── the private path ───────────────────────────────────────────────────

describe("F2 — a trial balance is complete, so its zeroes stay measured", () => {
  it("carniprod computes almost everything, and declares no absences", () => {
    expect(carniprod.absentInputs).toBeUndefined();
    expect(carniprod.reportedTotals).toBeUndefined();
    const all = rowsOf(carniprod);
    const computed = all.filter((r) => r.value !== null);
    expect(
      computed.length,
      "the private path lost ratios it used to compute — the absence " +
        "machinery is leaking into a source that declares none.",
    ).toBeGreaterThanOrEqual(19);
  });

  it("a MEASURED zero denominator is undefined, not `0.00x critical`", () => {
    // Carniprod is debt-free: `interestExpense` and `shortTermDebt` are
    // both a real, reported 0. `safeDiv` returned 0 and the page graded
    // it CRITICAL — the worst possible verdict for the strongest possible
    // coverage position.
    expect(carniprod.incomeStatement.interestExpense).toBe(0);
    expect(carniprod.balanceSheet.shortTermDebt).toBe(0);
    const all = rowsOf(carniprod);
    const r = byKey(all, "interest_coverage");
    expect(r.value).toBeNull();
    expect(r.verdict).toBe("unknown");
    expect(r.unavailable).toEqual({
      kind: "undefined_ratio",
      denominator: "interest expense",
    });
    // The reason is the RIGHT one: nothing is missing from this filing.
    expect(r.commentary).toMatch(/^Undefined/);
    expect(r.commentary).not.toMatch(/does not carry/);
  });
});

// ── the private path, NUMERICALLY ──────────────────────────────────────

describe("F2 — the private path's numbers did not move", () => {
  // The whole ratio layer was rewritten onto absence-aware arithmetic.
  // "the tests still pass" is not evidence that a Romanian trial balance
  // still reports the same figures, because most ratios have no assertion
  // pinning their VALUE. So this recomputes each one the way the file did
  // BEFORE — `deriveTotals` + the servedFacts gateway + `safeDiv` — and
  // requires equality, with exactly one sanctioned exception: a division
  // whose denominator is a measured zero, which used to return 0 and now
  // refuses.
  const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b);
  const pct = (a: number, b: number): number => safeDiv(a, b) * 100;

  for (const [name, fixture] of [["carniprod", carniprod]] as const) {
    it(`${name}: every ratio equals its pre-rewrite value, or refuses a zero denominator`, () => {
      const t = deriveTotals(fixture);
      const sf = factsFrom(fixture);
      const bs = fixture.balanceSheet;
      const is = fixture.incomeStatement;
      const days = fixture.supplementary.periodDays ?? 365;
      const totalOpEx =
        is.costOfGoodsSold + is.operatingExpenses + is.depreciationAmortization;

      // The gateway accessors are ABSENT-CAPABLE now. This fixture is a
      // COMPLETE served envelope, so every one of them must be present —
      // `req` says that at the read instead of letting a `null` slide
      // into `safeDiv` (where it would be Infinity, not a refusal).
      const req = (v: number | null, what: string): number => {
        expect(v, `${what} absent on a complete fixture`).not.toBeNull();
        return v as number;
      };
      const CA = req(sf.currentAssets(), "currentAssets");
      const CL = req(sf.currentLiabilities(), "currentLiabilities");
      const TA = req(sf.totalAssets(), "totalAssets");
      const TE = req(sf.totalEquity(), "totalEquity");

      // key → [old value, the denominator that decides whether the old
      // value was a real number or `safeDiv`'s zero]
      const before: Record<string, [number, number]> = {
        current_ratio: [safeDiv(CA, CL), CL],
        quick_ratio: [safeDiv(bs.cash + bs.accountsReceivable, CL), CL],
        cash_ratio: [safeDiv(bs.cash, CL), CL],
        gross_margin: [pct(t.grossProfit, is.revenue), is.revenue],
        ebitda_margin: [pct(t.ebitda, is.revenue), is.revenue],
        net_margin: [pct(t.netIncome, is.revenue), is.revenue],
        roa: [pct(t.netIncome, TA), TA],
        roe: [pct(t.netIncome, TE), TE],
        roic: [
          pct(t.ebit * (1 - 0.16), Math.max(t.totalDebt + TE, 1)),
          Math.max(t.totalDebt + TE, 1),
        ],
        debt_to_ebitda: [safeDiv(t.totalDebt, t.ebitda), t.ebitda],
        debt_to_equity: [safeDiv(t.totalDebt, TE), TE],
        equity_ratio: [pct(TE, TA), TA],
        ltv: [pct(t.totalDebt, TA), TA],
        interest_coverage: [safeDiv(t.ebit, is.interestExpense), is.interestExpense],
        dscr: [safeDiv(t.ebitda, is.interestExpense + bs.shortTermDebt), is.interestExpense + bs.shortTermDebt],
        dscr_with_lt_principal: [
          safeDiv(t.ebitda, is.interestExpense + bs.longTermDebt / 8),
          is.interestExpense + bs.longTermDebt / 8,
        ],
        dso: [safeDiv(bs.accountsReceivable, is.revenue) * days, is.revenue],
        dio: [safeDiv(bs.inventory, totalOpEx) * days, totalOpEx],
        dpo: [safeDiv(bs.accountsPayable, totalOpEx) * days, totalOpEx],
        asset_turnover: [safeDiv(is.revenue, TA), TA],
      };

      const all = Object.values(computeRatios(fixture)).flat();
      let compared = 0;
      let refusedZero = 0;
      for (const [key, [oldValue, denominator]] of Object.entries(before)) {
        const now = byKey(all, key);
        if (denominator === 0) {
          expect(
            now.value,
            `\`${key}\` divided by a MEASURED zero. The old code answered ` +
              `${oldValue} and graded it; the only correct answer is a refusal.`,
          ).toBeNull();
          expect(now.unavailable?.kind).toBe("undefined_ratio");
          refusedZero++;
          continue;
        }
        expect(
          now.value,
          `\`${key}\` MOVED: was ${oldValue}, now ${now.value}. The rewrite was ` +
            "supposed to change which ratios refuse, never what the ones that " +
            "compute report.",
        ).toBeCloseTo(oldValue, 9);
        compared++;
      }
      // TC-3 floors, after the loop.
      expect(compared, "nothing was compared").toBeGreaterThanOrEqual(15);
      expect(
        refusedZero,
        "this fixture has no zero denominator, so the exception arm above is " +
          "untested here — point it at one that has.",
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

// ── the units that never carried a card ────────────────────────────────

describe("the card-bearing set is what this gate thinks it is", () => {
  it("fifteen ratios route through the renderer that carries provenance", () => {
    const { all } = publicRatios();
    const carded = all.filter((r) => CARD_BEARING_UNITS.indexOf(r.unit) >= 0);
    expect(carded.length).toBe(15);
  });
});
