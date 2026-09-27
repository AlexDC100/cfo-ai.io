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
//
// THE PRINTED OPERANDS, DIVIDED AS PRINTED (second describe below). Round 2
// of the adversarial verifier: the operands above were the right figures
// but printed COMPACT — `EBIT 7.82M RON ÷ Interest 278K RON` under agras's
// 28.14× (divides to 28.13), `−29.10M ÷ 1.16M` under realestate's −25.13×
// (−25.09), `787K ÷ 2.42M` under retail's 0.32× (0.33): on 8 of the 10
// books with interest the reader's own division did not reproduce the card.
// The token-level check above compared unrounded token VALUES, so it could
// not see a render that rounds them. The operands now print EXACT (to the
// bani, thousands separators — FormulaToken.exact), and this half reads the
// RENDERED operand text back as a reader would, divides it exactly, rounds
// half-up to the card's printed decimals and holds it equal to the card —
// on EVERY corpus book with interest (the scope is discovered by the engine:
// fixtures/coverage_popover_corpus.json, kept fresh by
// tests/engine/test_coverage_popover_corpus_fixture.py) and on the committed
// Scandia baseline, in both languages, for the served-table card (what the
// Ratios tab prints for an analysed period) and the no-table card.
// REDS ON: an operand printed compact, rounded or otherwise not to the bani;
// a printed operand that is not the served figure to the cent; printed
// operands whose exact quotient does not print the card's digits; a popover
// header that does not print the card's digits; a corpus whose books with
// interest all happen to survive compact rounding (TC-3, asserted).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { InteractiveFormula } from "@/components/learning/InteractiveFormula";
import { PopoverStackProvider } from "@/components/learning/PopoverStackProvider";
import { ReportingContextProvider } from "@/components/learning/ReportingContextProvider";
import { formatValue } from "@/components/learning/valueFormat";
import { computeRatios, formatRatio, type Statements } from "@/lib/financialReport";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import {
  buildRatioCompareView,
  currentSideOf,
  printRatioRow,
  readRatioTable,
} from "@/lib/ratioCompareView";
import { lookupConcept } from "@/lib/learning/concepts";
import type { FormulaSpec, FormulaToken, ReportingMetrics } from "@/lib/learning/concepts/_schema";
import { BOOKS, metricsFor, statementsFor } from "./exportBooks";

type Served = Statements & { assembled_pl?: Record<string, number> };

const SCANDIA_BASELINE = resolve(
  __dirname,
  "../../../src/engine/country_packs/ro_romania/fixtures/regression_baselines/scandia_fy2025.json",
);

// The served card digits, re-read from the served GET /api/period
// (tests/engine/fixtures/firm/served_metrics.json `interest_coverage`,
// re-captured under the one-EBITDA ruling 2026-09-26: the EBIT the card
// divides now carries the measured net 711 — agras 31.9962, realestate
// 0.4221, retail 0.3249; before the ruling agras 28.14 and realestate
// -25.13); carniprod has no interest and is refused (zero_denominator).
// The Scandia regression baseline was re-captured under the ruling on
// 2026-09-27 (BASELINE_HISTORY): its EBIT carries the bridged net 711
// (41,313,577.93 ÷ interest 3,075,221.80) and the engine gate, served that
// baseline through GET /api/period, printed 13.43 (13.27 before the ruling).
// Literals, never recomputed here from the same statements the popover
// reads.
const SERVED_DIGITS: Record<string, string | null> = {
  agras: "32.00",
  carniprod: null,
  realestate: "0.42",
  retail: "0.32",
  scandia_baseline: "13.43",
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
  const spec = concept!.computation!({ metrics, currency: "RON", locale } as never, value);
  // A refused EBIT has no formula (null); every book this helper is called
  // on carries a measured card, so a null here is a failure, not a skip.
  if (spec === null) throw new Error("interest_coverage served no formula on a book with a measured card");
  return spec;
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

// ─── The printed operands, divided as printed ──────────────────────────

type CorpusBook = {
  case: string;
  served: boolean;
  refused?: string;
  interest_expense?: number | null;
  interest_coverage?: { value: number | null; value_q: string | null; reason: string | null };
  body?: {
    statements: Served;
    assembled_metrics: { ratio_table: unknown };
    metrics: Array<{ name: string; value: number | null }>;
  };
};

const CORPUS = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/coverage_popover_corpus.json"), "utf-8"),
) as { books: CorpusBook[] };

/** A printed amount at full precision: optional minus, thousands groups,
 *  two decimals, the currency. Nothing else is an exact operand. */
const EXACT_AMOUNT = /^([−-])?(\d{1,3}(?:,\d{3})*)\.(\d{2}) RON$/;

function exactCents(printed: string): bigint | null {
  const m = EXACT_AMOUNT.exec(printed);
  if (!m) return null;
  const c = BigInt(m[2].replace(/,/g, "") + m[3]);
  return m[1] ? -c : c;
}

/** What a reader recovers from ANY printed amount, compact included
 *  ("7.82M RON" → 7,820,000.00) — used to print what the reader's own
 *  division gives when an operand is not exact. */
function readerCents(printed: string): bigint | null {
  const exact = exactCents(printed);
  if (exact !== null) return exact;
  const m = /^([−-])?([\d,]+)(?:\.(\d+))?([KMB])? RON$/.exec(printed);
  if (!m) return null;
  const scale = ({ K: 3, M: 6, B: 9 } as Record<string, number>)[m[4] ?? ""] ?? 0;
  const frac = m[3] ?? "";
  const digits = BigInt(m[2].replace(/,/g, "") + frac);
  const exp = scale + 2 - frac.length;
  const c = exp >= 0 ? digits * 10n ** BigInt(exp) : digits / 10n ** BigInt(-exp);
  return m[1] ? -c : c;
}

/** a ÷ b, exactly, rounded half-up (away from zero) to `decimals` places —
 *  the engine's ROUND_HALF_UP, on the printed operands. */
function divideHalfUp(a: bigint, b: bigint, decimals: number): string {
  if (b === 0n) return "division by zero";
  const neg = a !== 0n && (a < 0n) !== (b < 0n);
  const A = a < 0n ? -a : a;
  const B = b < 0n ? -b : b;
  const scaled = A * 10n ** BigInt(decimals);
  let q = scaled / B;
  if (2n * (scaled % B) >= B) q += 1n;
  const s = q.toString().padStart(decimals + 1, "0");
  const txt = decimals > 0 ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s;
  return (neg && q !== 0n ? "-" : "") + txt;
}

/** The digits a card prints ("28.14×", "-25.13×", "28,14×", "−25.13×"). */
function cardDigits(printed: string): { digits: string; decimals: number } | null {
  const m = /^([−-])?(\d+)(?:[.,](\d+))?×$/.exec(printed.trim());
  if (!m) return null;
  return { digits: `${m[1] ? "-" : ""}${m[2]}${m[3] ? `.${m[3]}` : ""}`, decimals: (m[3] ?? "").length };
}

const toCents = (x: number) => BigInt(Math.round(x * 100));

/** The two operands as the RENDERED popover prints them (the value text of
 *  each token button, without its label). */
function renderedOperands(spec: FormulaSpec, metrics: ReportingMetrics, locale: "en" | "ro") {
  const { container, unmount } = render(
    <MemoryRouter>
      <ReportingContextProvider metrics={metrics} currency="RON" locale={locale}>
        <PopoverStackProvider>
          <InteractiveFormula spec={spec} />
        </PopoverStackProvider>
      </ReportingContextProvider>
    </MemoryRouter>,
  );
  const pick = (key: string): string | null => {
    const spans = container.querySelectorAll(`[data-testid="formula-value-${key}"] span`);
    return spans.length ? (spans[spans.length - 1].textContent ?? null) : null;
  };
  const out = { ebit: pick("ebit"), interest: pick("interest_expense"), text: container.textContent ?? "" };
  unmount();
  return out;
}

type Surface = {
  book: string;
  statements: Served;
  /** The value the card hands its LearnableNumber (the popover's header). */
  value: number;
  /** Each card the page can print for this book, by path. */
  cards: Array<{ path: string; printed: string }>;
};

function corpusSurfaces(): { surfaces: Surface[]; lines: string[]; failures: string[] } {
  const surfaces: Surface[] = [];
  const lines: string[] = [];
  const failures: string[] = [];
  for (const b of CORPUS.books) {
    if (!b.served) {
      lines.push(`  ${b.case.padEnd(26)} not served offline (${b.refused})`);
      continue;
    }
    if (!b.body) {
      lines.push(`  ${b.case.padEnd(26)} interest ${b.interest_expense}: card refused (${b.interest_coverage?.reason}); no popover renders`);
      continue;
    }
    const view = buildRatioCompareView({
      periodTable: readRatioTable(b.body.assembled_metrics),
      comparativesDoc: null,
      currentLabel: b.case,
    });
    const side = currentSideOf(view, "interest_coverage");
    const row = printRatioRow(view, "interest_coverage", "en");
    const rowRo = printRatioRow(view, "interest_coverage", "ro");
    if (!side || typeof side.value !== "number" || !row || !rowRo) {
      failures.push(`${b.case}: the served table prints no measured interest_coverage card`);
      continue;
    }
    const metricsByName = Object.fromEntries(b.body.metrics.map((m) => [m.name, m.value]));
    const legacy = computeRatios(b.body.statements, undefined, metricsByName).coverage.find(
      (r) => r.key === "interest_coverage",
    );
    const cards = [
      { path: "served table (en)", printed: row.current },
      { path: "served table (ro)", printed: rowRo.current },
    ];
    if (legacy) cards.push({ path: "no served table", printed: formatRatio(legacy) });
    else failures.push(`${b.case}: computeRatios carries no interest_coverage card`);
    surfaces.push({ book: b.case, statements: b.body.statements, value: side.value, cards });
  }
  // The committed Scandia regression baseline, read in place (never copied:
  // ruling Q10). It carries no served table, so its card is the no-table
  // path, and its served digits are the engine gate's (SERVED_DIGITS).
  const scandia = JSON.parse(readFileSync(SCANDIA_BASELINE, "utf-8")) as { assembled: { statements: Served } };
  const legacy = computeRatios(scandia.assembled.statements).coverage.find((r) => r.key === "interest_coverage");
  if (legacy && typeof legacy.value === "number") {
    surfaces.push({
      book: "scandia_baseline",
      statements: scandia.assembled.statements,
      value: legacy.value,
      cards: [
        { path: "no served table", printed: formatRatio(legacy) },
        { path: "served digits (engine gate)", printed: `${SERVED_DIGITS.scandia_baseline}×` },
      ],
    });
  } else {
    failures.push("scandia_baseline: computeRatios carries no measured interest_coverage card");
  }
  return { surfaces, lines, failures };
}

describe("the popover's printed operands, divided as printed, reproduce the card", () => {
  it("on every corpus book with interest and the Scandia baseline, in both languages", () => {
    const { surfaces, lines, failures } = corpusSurfaces();
    let compactWouldMiss = 0;
    for (const { book, statements, value, cards } of surfaces) {
      const pl = statements.assembled_pl ?? {};
      const snap = buildReportingMetricsSnapshot(statements);
      for (const locale of ["en", "ro"] as const) {
        const spec = specFor(snap, value, locale);
        const op = renderedOperands(spec, snap, locale);
        if (op.ebit === null || op.interest === null) {
          failures.push(`${book} (${locale}): the popover renders operands ${JSON.stringify(op)}`);
          continue;
        }
        const e = exactCents(op.ebit);
        const i = exactCents(op.interest);
        if (e === null || i === null) {
          const re = readerCents(op.ebit);
          const ri = readerCents(op.interest);
          const d = cardDigits(cards[0].printed)?.decimals ?? 2;
          failures.push(
            `${book} (${locale}): an operand is not printed to the bani — "EBIT ${op.ebit} ÷ Interest ${op.interest}"` +
              (re !== null && ri !== null ? ` divides to ${divideHalfUp(re, ri, d)}` : "") +
              `, the card prints ${cards[0].printed}`,
          );
          continue;
        }
        if (e !== toCents(pl.ebit)) failures.push(`${book} (${locale}): printed EBIT ${op.ebit} is not the served EBIT ${pl.ebit}`);
        if (i !== toCents(pl.interest_expense)) {
          failures.push(`${book} (${locale}): printed Interest ${op.interest} is not the served interest ${pl.interest_expense}`);
        }
        for (const card of cards) {
          const want = cardDigits(card.printed);
          if (!want) {
            failures.push(`${book} (${locale}): the ${card.path} card prints ${JSON.stringify(card.printed)}, not a coverage`);
            continue;
          }
          const got = divideHalfUp(e, i, want.decimals);
          if (got !== want.digits) {
            failures.push(`${book} (${locale}): "EBIT ${op.ebit} ÷ Interest ${op.interest}" divides to ${got}, the ${card.path} card prints ${card.printed}`);
          }
        }
        if (locale === "en") {
          // The popover's own header prints the value the card handed it.
          const header = formatValue(value, "ratio");
          if (cardDigits(header)?.digits !== cardDigits(cards[0].printed)?.digits) {
            failures.push(`${book}: the popover header prints ${header}, the card ${cards[0].printed}`);
          }
          // TC-3: what the pre-repair COMPACT print would have divided to.
          const compact = (x: number) => readerCents(formatValue(x, "currency", { currency: "RON" }))!;
          const d = cardDigits(cards[0].printed)!.decimals;
          const compactQ = divideHalfUp(compact(pl.ebit), compact(pl.interest_expense), d);
          if (compactQ !== cardDigits(cards[0].printed)!.digits) compactWouldMiss += 1;
          lines.push(
            `  ${book.padEnd(26)} card ${cards.map((c) => `${c.printed} [${c.path}]`).join(", ")}; ` +
              `popover "EBIT ${op.ebit} ÷ Interest ${op.interest}" = ${divideHalfUp(e, i, d)}; compact would divide to ${compactQ}`,
          );
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `SCOPE interest-coverage-one-operand (popover half, printed operands): corpus cases ${CORPUS.books.length}; ` +
        `books with a measured card ${surfaces.length} (${surfaces.map((s) => s.book).join(", ")}); ` +
        `books where compact operands would not reproduce the card: ${compactWouldMiss}\n` +
        lines.join("\n"),
    );
    expect(failures).toEqual([]);
    // TC-3: the corpus's books with interest are measured, and the scope
    // holds books on which a compact print misses the card.
    expect(surfaces.filter((s) => s.book !== "scandia_baseline").length).toBeGreaterThanOrEqual(4);
    expect(compactWouldMiss).toBeGreaterThanOrEqual(3);
  });

  it("the exact operand reader refuses a compact or whole-RON print", () => {
    expect(exactCents("2,421,110.34 RON")).toBe(242111034n);
    expect(exactCents("−29,101,057.56 RON")).toBe(-2910105756n);
    for (const compact of ["2.42M RON", "278K RON", "2,421,110 RON", "2421110.34 RON"]) {
      expect(exactCents(compact), compact).toBeNull();
    }
    expect(readerCents("7.82M RON")).toBe(782000000n);
    expect(readerCents("278K RON")).toBe(27800000n);
    expect(divideHalfUp(782000000n, 27800000n, 2)).toBe("28.13");
    expect(divideHalfUp(-125n, 1000n, 2)).toBe("-0.13");
    expect(formatValue(2421110.34, "currency", { currency: "RON", exact: true })).toBe("2,421,110.34 RON");
    expect(formatValue(-29101057.56, "currency", { currency: "RON", exact: true })).toBe("−29,101,057.56 RON");
    expect(formatValue(-0.001, "currency", { currency: "RON", exact: true })).toBe("0.00 RON");
  });
});
