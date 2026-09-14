// THE SERVED TWO-PERIOD RATIO BLOCK, for the export gates.
//
// `tests/engine/fixtures/firm/served_ratio_pair.json` is the `ratios` block
// `GET /api/period/{id}/comparatives` serves, captured from the real
// composer (`capture_served_ratio_pair.py`, freshness held by
// `tests/engine/test_served_ratio_pair_fixture.py`) over two committed
// corpus books read back through the real router: agras as the current
// period ("Dec 2025"), carniprod as the prior ("Dec 2024").
//
// `pairStatements()` composes what an exporter receives when the caller
// attaches the served comparatives document: the agras statements exactly
// as every other export gate renders them (`statementsFor`), the prior
// period's two statements, and `comparatives.ratios`. Nothing here builds a
// ratio row by hand — a gate that planted a row writes its plant on a deep
// copy of the served one and says so.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CreditEnvelopes } from "@/lib/financialExports";
import type { Statements } from "@/lib/financialReport";
import type { CreditEnvelope, PiotroskiEnvelope } from "@/lib/financialValuation";
import type { RatioComparisonV1 } from "@/lib/ratioTable";

import { metricsFor, statementsFor, type Book, type BookStatements } from "./exportBooks";

const repoRoot = resolve(__dirname, "../../..");

export interface ServedRatioPairFixture {
  current_book: "agras";
  prior_book: "carniprod";
  current_label: string;
  prior_label: string;
  current_credit_envelope: CreditEnvelope | null;
  current_piotroski_envelope: PiotroskiEnvelope | null;
  ratios: RatioComparisonV1;
}

export function servedRatioPair(): ServedRatioPairFixture {
  return JSON.parse(
    readFileSync(resolve(repoRoot, "tests/engine/fixtures/firm/served_ratio_pair.json"), "utf-8"),
  ) as ServedRatioPairFixture;
}

/** The statements an exporter receives for the pair. `ratios` defaults to
 *  the served block; pass a planted copy, or `null` for a comparison that
 *  reached the export without its table. */
export function pairStatements(ratios?: RatioComparisonV1 | null): BookStatements & Statements {
  const fx = servedRatioPair();
  const prior = statementsFor(fx.prior_book);
  const current = statementsFor(fx.current_book);
  return {
    ...current,
    periodLabel: fx.current_label,
    prior: {
      periodLabel: fx.prior_label,
      balanceSheet: prior.balanceSheet,
      incomeStatement: prior.incomeStatement,
    },
    comparatives: { ratios: ratios === undefined ? fx.ratios : ratios },
  };
}

/** The envelopes the caller hands the exporters for the current period:
 *  the served metric rows and the served credit and Piotroski envelopes. */
export function pairEnvelopes(): CreditEnvelopes {
  const fx = servedRatioPair();
  return {
    metricsByName: metricsFor(fx.current_book),
    credit: fx.current_credit_envelope ?? undefined,
    piotroski: fx.current_piotroski_envelope ?? undefined,
  };
}

/** A deep copy of the served block, for a plant. */
export function servedRatiosCopy(): RatioComparisonV1 {
  return JSON.parse(JSON.stringify(servedRatioPair().ratios)) as RatioComparisonV1;
}

// ── EVERY ORDERED CORPUS PAIR ──────────────────────────────────────────
//
// `tests/engine/fixtures/firm/served_ratio_pairs.json` is the same block
// for all twelve ordered pairs of the four committed books, captured by the
// same script from the same composer (freshness:
// `test_the_committed_corpus_pairs_are_todays_composer_output`). A reader
// gate that holds on one pair can still be wrong on the pair where two
// ladders disagree; the book-agnostic gates walk all twelve.

export interface ServedCorpusPairs {
  current_label: string;
  prior_label: string;
  books: Record<Book, { credit_envelope: CreditEnvelope | null; piotroski_envelope: PiotroskiEnvelope | null }>;
  pairs: Record<string, RatioComparisonV1>;
}

let corpusCache: ServedCorpusPairs | null = null;

export function servedCorpusPairs(): ServedCorpusPairs {
  if (corpusCache === null) {
    corpusCache = JSON.parse(
      readFileSync(resolve(repoRoot, "tests/engine/fixtures/firm/served_ratio_pairs.json"), "utf-8"),
    ) as ServedCorpusPairs;
  }
  return JSON.parse(JSON.stringify(corpusCache)) as ServedCorpusPairs;
}

/** Every ordered pair, as `[current, prior]`. */
export function corpusPairKeys(): Array<[Book, Book]> {
  return Object.keys(servedCorpusPairs().pairs).map((k) => k.split("|") as [Book, Book]);
}

/** What an exporter receives for one corpus pair. `ratios` defaults to the
 *  served block for the pair. */
export function corpusPairStatements(
  current: Book,
  prior: Book,
  ratios?: RatioComparisonV1 | null,
): BookStatements & Statements {
  const fx = servedCorpusPairs();
  const cur = statementsFor(current);
  const pri = statementsFor(prior);
  return {
    ...cur,
    periodLabel: fx.current_label,
    prior: { periodLabel: fx.prior_label, balanceSheet: pri.balanceSheet, incomeStatement: pri.incomeStatement },
    comparatives: { ratios: ratios === undefined ? fx.pairs[`${current}|${prior}`] : ratios },
  };
}

export function corpusPairEnvelopes(current: Book): CreditEnvelopes {
  const fx = servedCorpusPairs();
  return {
    metricsByName: metricsFor(current),
    credit: fx.books[current].credit_envelope ?? undefined,
    piotroski: fx.books[current].piotroski_envelope ?? undefined,
  };
}

/** THE PRODUCTION PRE-B6 SHAPE: the caller attached `prior` and no
 *  comparatives document at all (FinancialStatements.tsx statementsForExport
 *  before B6's wiring lands). */
export function pairStatementsWithoutComparatives(): BookStatements & Statements {
  const s = pairStatements();
  delete (s as { comparatives?: unknown }).comparatives;
  return s;
}
