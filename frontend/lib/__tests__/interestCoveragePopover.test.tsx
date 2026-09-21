// interest-coverage-one-operand, THE LEARNING-POPOVER HALF.
//
// The Ratios tab wraps every measured interest-coverage card in
// `<LearnableNumber conceptKey="interest_coverage">`, and its "How it's
// computed" popover prints the formula's operands under the figure:
// `EBIT <x> ÷ Interest <y>`. `buildReportingMetricsSnapshot` never set
// `interestExpense`, and the concept read `m.interestExpense ?? 0` — so on
// EVERY book with interest the popover printed `Interest 0 RON` beneath the
// served coverage (retail 0.32x, agras 28.14x, realestate -25.13x, the
// Scandia baseline 13.27x): printed operands that do not recompute the
// figure beside them, found by an adversarial verifier on all 10 served
// books with interest. The engine gate (tests/engine/
// test_interest_coverage_one_operand.py) could not see it — it reads the
// served row, not this surface — and neither could the two other vitest
// halves (interestCoverageBasis, exportRatioFormulas G4).
//
// WHAT THIS CHECKS, on the four firm corpus books (the served shape,
// `statementsFor` + the served metric map) and the Scandia regression
// baseline — the same five books as the engine gate:
//   1. the card the Ratios tab prints (`computeRatios` + `formatRatio`)
//      prints the served digits (literals re-read from the served GET
//      /api/period, which the engine gate prints);
//   2. the popover's two value tokens are EBIT and Interest, EBIT is the
//      P&L's `assembled_pl.ebit` and Interest its `interest_expense`, to
//      the cent — the operands the engine row divides;
//   3. token EBIT ÷ token Interest, quantized as the card is, prints the
//      card's digits;
//   4. the RENDERED formula (InteractiveFormula inside the providers the
//      page mounts) prints the interest figure and never `Interest 0 RON`.
// And ABSENT stays absent: with `interestExpense` taken out of the
// snapshot, or declared absent by the source, the popover prints
// "Interest not reported" / "Interest neraportat" as text and no value
// token at all — never a 0.
//
// REDS ON (TC-11, after the repair): the snapshot dropping or zeroing
// `interestExpense`; the concept printing a `?? 0` operand; an operand
// read from a different EBIT or interest authority than the engine row's
// (so the tokens no longer recompute the card); an absent operand printed
// as a number.
// CANNOT SEE: the engine row itself (the engine gate); the export and the
// no-envelope credit model (the other two vitest halves); carniprod, whose
// interest is a reported 0.00 — its card is refused, so the page renders
// no LearnableNumber and no popover (printed as out of scope).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { InteractiveFormula } from "@/components/learning/InteractiveFormula";
import { PopoverStackProvider } from "@/components/learning/PopoverStackProvider";
import { ReportingContextProvider } from "@/components/learning/ReportingContextProvider";
import { computeRatios, formatRatio, type Statements } from "@/lib/financialReport";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { lookupConcept } from "@/lib/learning/concepts";
import type { FormulaSpec, FormulaToken, ReportingMetrics } from "@/lib/learning/concepts/_schema";
import { BOOKS, metricsFor, statementsFor } from "./exportBooks";

type Served = Statements & { assembled_pl?: Record<string, number> };

const SCANDIA_BASELINE = resolve(
  __dirname,
  "../../../src/engine/country_packs/ro_romania/fixtures/regression_baselines/scandia_fy2025.json",
);

// The served card digits, re-read from the served GET /api/period
// (test_interest_coverage_one_operand prints them: "agras 28.14,
// realestate -25.13, retail 0.32, Scandia 13.27"); carniprod has no
// interest and is refused (zero_denominator). Literals, never recomputed
// here from the same statements the popover reads.
const SERVED_DIGITS: Record<string, string | null> = {
  agras: "28.14",
  carniprod: null,
  realestate: "-25.13",
  retail: "0.32",
  scandia_baseline: "13.27",
};

function cases(): Array<{ name: string; s: Served; metrics?: Record<string, number | null> }> {
  const out: Array<{ name: string; s: Served; metrics?: Record<string, number | null> }> = BOOKS.map(
    (book) => ({ name: book, s: statementsFor(book) as Served, metrics: metricsFor(book) }),
  );
  const scandia = JSON.parse(readFileSync(SCANDIA_BASELINE, "utf-8")) as {
    assembled: { statements: Served };
  };
  out.push({ name: "scandia_baseline", s: scandia.assembled.statements });
  return out;
}

function specFor(metrics: ReportingMetrics, value: number, locale: "en" | "ro" = "en"): FormulaSpec {
  const concept = lookupConcept("interest_coverage");
  expect(concept?.computation, "interest_coverage has no computation").toBeTruthy();
  return concept!.computation!({ metrics, currency: "RON", locale } as never, value);
}

function renderedText(spec: FormulaSpec, metrics: ReportingMetrics, locale: "en" | "ro" = "en"): string {
  const { container, unmount } = render(
    <MemoryRouter>
      <ReportingContextProvider metrics={metrics} currency="RON" locale={locale}>
        <PopoverStackProvider>
          <InteractiveFormula spec={spec} />
        </PopoverStackProvider>
      </ReportingContextProvider>
    </MemoryRouter>,
  );
  const text = container.textContent ?? "";
  unmount();
  return text;
}

const valueTokens = (spec: FormulaSpec) =>
  spec.tokens.filter((t): t is Extract<FormulaToken, { type: "value" }> => t.type === "value");
const cents = (x: number) => Math.round(x * 100);
const q2 = (x: number) => x.toFixed(2);

describe("the interest-coverage popover prints operands that recompute its card", () => {
  it("on the four firm books and the Scandia baseline", () => {
    const lines: string[] = [];
    const failures: string[] = [];
    let measured = 0;
    for (const { name, s, metrics } of cases()) {
      const pl = s.assembled_pl ?? {};
      const card = computeRatios(s, undefined, metrics).coverage.find((r) => r.key === "interest_coverage");
      if (!card) {
        failures.push(`${name}: the Ratios bundle carries no interest_coverage card`);
        continue;
      }
      const printed = formatRatio(card);
      const want = SERVED_DIGITS[name];
      if (want === null) {
        lines.push(`  ${name.padEnd(17)} interest ${pl.interest_expense}: card refused (${printed}); no popover renders`);
        if (card.value !== null) failures.push(`${name}: a zero-interest book printed a coverage ${printed}`);
        continue;
      }
      measured += 1;
      if (printed !== `${want}×`) failures.push(`${name}: the card prints ${printed}, the served row ${want}×`);

      const snap = buildReportingMetricsSnapshot(s);
      const spec = specFor(snap, card.value as number);
      const [ebitTok, intTok] = valueTokens(spec);
      if (!ebitTok || !intTok || ebitTok.conceptKey !== "ebit" || intTok.conceptKey !== "interest_expense") {
        failures.push(`${name}: the popover's value tokens are ${JSON.stringify(valueTokens(spec))}`);
        continue;
      }
      if (cents(ebitTok.value) !== cents(pl.ebit)) {
        failures.push(`${name}: popover EBIT ${ebitTok.value} is not the P&L's EBIT ${pl.ebit}`);
      }
      if (cents(intTok.value) !== cents(pl.interest_expense)) {
        failures.push(`${name}: popover Interest ${intTok.value} is not the P&L's interest expense ${pl.interest_expense}`);
      }
      const recomputed = intTok.value !== 0 ? q2(ebitTok.value / intTok.value) : "division by zero";
      if (`${recomputed}×` !== printed) {
        failures.push(`${name}: popover EBIT ${ebitTok.value} ÷ Interest ${intTok.value} = ${recomputed}, the card prints ${printed}`);
      }
      const text = renderedText(spec, snap);
      if (/Interest\s*0 RON/.test(text) || !/Interest/.test(text)) {
        failures.push(`${name}: the rendered popover reads ${JSON.stringify(text)}`);
      }
      lines.push(`  ${name.padEnd(17)} card ${printed}; popover EBIT ${ebitTok.value} ÷ Interest ${intTok.value} = ${recomputed}; rendered ${JSON.stringify(text)}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `SCOPE interest-coverage-one-operand (popover half): books ${cases().length} ` +
        `(${cases().map((c) => c.name).join(", ")}); popover operands recomputed on ${measured}\n` +
        lines.join("\n"),
    );
    expect(failures).toEqual([]);
    // TC-3: the scope must hold books with interest, or this is vacuous.
    expect(measured).toBeGreaterThanOrEqual(4);
  });

  it("an interest figure the snapshot does not carry prints 'not reported', never 0", () => {
    const s = statementsFor("retail") as Served;
    const snap = buildReportingMetricsSnapshot(s);
    expect(snap.interestExpense).toBe(s.assembled_pl?.interest_expense);
    const { interestExpense: _dropped, ...withoutInterest } = snap;
    for (const [locale, word] of [["en", "Interest not reported"], ["ro", "Interest neraportat"]] as const) {
      const spec = specFor(withoutInterest, 0.3249, locale);
      const values = valueTokens(spec);
      expect(values.map((t) => t.conceptKey)).toEqual(["ebit"]);
      expect(spec.tokens).toContainEqual({ type: "literal", text: word });
      const text = renderedText(spec, withoutInterest, locale);
      expect(text).toContain(word);
      expect(text).not.toMatch(/Interest\s*0 RON/);
    }
  });

  it("a source that declares interest absent carries no interest figure into the snapshot", () => {
    const s = { ...(statementsFor("retail") as Served), absentInputs: ["interestExpense"] } as Served;
    expect(buildReportingMetricsSnapshot(s).interestExpense).toBeUndefined();
    const bare = { ...(statementsFor("retail") as Served) };
    delete (bare as { assembled_pl?: unknown }).assembled_pl;
    // No assembled P&L: the income statement's own line is the authority.
    expect(buildReportingMetricsSnapshot(bare).interestExpense).toBe(bare.incomeStatement.interestExpense);
  });
});
