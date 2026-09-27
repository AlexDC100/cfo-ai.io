// THE DASHBOARD NET PROFIT IS THE ACCOUNT-121 ANCHOR, ON THE SAME
// ENVELOPE EVERY OTHER SURFACE READS.
//
// Conduct, not source text: every figure below is read out of the REAL
// served books (`tests/engine/fixtures/firm/saga_10_col_*.json`, the
// captured `GET /api/period` statements) and the P&L is built by the
// REAL builder (`pickPLBuilder`) from those books' own line items.
// Nothing is hand-typed except the assertions.
//
// WHAT WENT WRONG. The tile resolved
//   calculated_metrics.net_income_statutory → pl.netProfitStatutory → pl.netProfit
// and never consulted `statements.assembled_pl.net_income_statutory` —
// the anchor the engine re-resolves on EVERY request, and the figure the
// Ratios tab, the CFO report and the Benchmark headline all print. The
// second rung is a class-6/7 reconstruction carrying the word
// "statutory"; on agras it is 14,106,102.03 against an account 121 of
// 7,533,676.02, so the card overstated the bottom line by 87.2 % while
// the sentence under it said "…net profit as filed" over the anchor.
//
// RED EXCERPT, this file against d2d7267 (the seam commit, which carried
// the page's chain verbatim):
//
//   FAIL  the served envelope's anchor is what the card prints > agras
//   AssertionError: expected 14106102.03 to be 7533676.02
//     - Expected   7533676.02
//     + Received  14106102.03
//
//   FAIL  a stale persisted metric never outranks the envelope > agras
//   AssertionError: expected 999999.99 to be 7533676.02
//
// AFTER THE REPAIR it reds on: the resolver preferring anything over a
// finite `assembled_pl.net_income_statutory`; a book whose served
// envelope stops carrying that field silently; and any book whose served
// anchor drifts from its `gateway_facts.net_result_cents`.
//
// THE ONE EBITDA (owner ruling 2026-09-26) MOVED THE WITNESS. The P&L
// builder no longer reproduces the class-6/7 reconstruction: it states the
// SERVED net result, ending on account 121 — so on the three bridge books
// its figure IS the anchor, and "the builder disagrees with the anchor" has
// no witness left there. The disagreement now lives where it is real: the
// ENVELOPE's own `net_income_reconstructed` (the build-up before the stock
// variation) still differs from account 121 on those books, and the builder
// must print the anchor, never that reconstruction. The resolver's
// precedence gets a CONSTRUCTED witness (design A8): a builder statement
// built from an envelope that serves no anchor refuses its net result, and
// the resolver answers "absent" — never zero, never the other envelope's
// anchor.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { pickPLBuilder } from "@/lib/buildPlStatement";
import { resolveHeadlineNetProfit } from "@/lib/headlineFigures";
import { buildHeadlineProvenance, plBuiltFromLineItems } from "@/lib/headlineProvenance";
import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";
import type { Statements } from "@/lib/financialReport";

import { BOOKS, statementsFor, type Book } from "./exportBooks";

const repoRoot = resolve(__dirname, "../../..");

interface FirmFixture {
  line_items: PeriodLineItem[];
}

function lineItemsFor(book: Book): PeriodLineItem[] {
  const fx = JSON.parse(
    readFileSync(resolve(repoRoot, `tests/engine/fixtures/firm/saga_10_col_${book}.json`), "utf-8"),
  ) as FirmFixture;
  return fx.line_items;
}

interface Served {
  statements: Statements & { assembled_pl?: Record<string, number> };
  pl: ReturnType<typeof pickPLBuilder>;
  anchor: number;
  reconstruction: number;
}

function servedBook(book: Book): Served {
  const statements = statementsFor(book);
  // The SAME call shape the dashboard makes — `pickPLBuilder` takes an
  // options object, and handing it a bare array silently routes to the
  // aggregates branch instead of the line-item one.
  const pl = pickPLBuilder(
    { lineItems: lineItemsFor(book), currency: statements.currency },
    statements,
  );
  const apl = statements.assembled_pl ?? {};
  return {
    statements,
    pl,
    anchor: apl.net_income_statutory as number,
    reconstruction: apl.net_income_reconstructed as number,
  };
}

const NONE: readonly PeriodMetric[] = [];

// Under tb_parser_v6 (the 609/709 contra-convention repair, plan/2 B4)
// retail's class-6/7 reconstruction closes to its account 121 to the cent,
// so retail no longer carries the disagreement this gate is about; the
// other three books still do, and retail is pinned to its closure below so
// it rejoins this list the moment its reconstruction drifts again.
const DISAGREEING: readonly Book[] = BOOKS.filter((b) => b !== "retail");

describe("the books actually carry the disagreement this gate is about", () => {
  it("retail: the v6 reconstruction IS account 121, and the builder states it", () => {
    const s = servedBook("retail");
    expect(Number.isFinite(s.anchor)).toBe(true);
    expect(s.reconstruction).toBe(s.anchor);
    expect(s.pl.netProfitStatutory).toBe(s.anchor);
    expect(s.pl.netProfit).toBe(s.anchor);
  });

  it.each(DISAGREEING)("%s: the envelope's reconstruction is not the anchor, and the builder prints the anchor", (book) => {
    const s = servedBook(book);
    expect(Number.isFinite(s.anchor)).toBe(true);
    // The envelope says the build-up before the stock variation differs…
    expect(s.reconstruction).not.toBe(s.anchor);
    // …and the P&L states account 121 — never that reconstruction.
    expect(s.pl.netProfitStatutory).toBe(s.anchor);
    expect(s.pl.netProfit).toBe(s.anchor);
    expect(s.pl.netProfit).not.toBe(s.reconstruction);
  });

  it("the served anchor is the gateway's own net result, to the cent", () => {
    for (const book of BOOKS) {
      const facts = JSON.parse(
        readFileSync(
          resolve(repoRoot, `corpus/saga_10_col_${book}/expected/gateway_facts.json`),
          "utf-8",
        ),
      ) as { net_result_cents: number };
      expect(Math.round(servedBook(book).anchor * 100)).toBe(facts.net_result_cents);
    }
  });
});

describe("the served envelope's anchor is what the card prints", () => {
  it.each(BOOKS)("%s", (book) => {
    const s = servedBook(book);
    expect(resolveHeadlineNetProfit(s.statements, NONE, s.pl)).toBe(s.anchor);
  });
});

describe("a stale persisted metric never outranks the envelope", () => {
  // `calculated_metrics` is a snapshot written once by `stage_compute`;
  // `assembled_pl` is re-assembled on every request. When they disagree
  // the envelope is the newer statement of the same concept.
  it.each(BOOKS)("%s", (book) => {
    const s = servedBook(book);
    const stale: PeriodMetric[] = [
      { name: "net_income_statutory", value: 999_999.99, unit: "RON", direction: null },
    ];
    expect(resolveHeadlineNetProfit(s.statements, stale, s.pl)).toBe(s.anchor);
  });
});

describe("absent is not zero, and absent is not the anchor either", () => {
  it("an envelope that serves no anchor: the builder refuses its net result and the resolver says absent", () => {
    // CONSTRUCTED witness (design A8): the agras envelope with its served
    // net-income fields removed — no anchor, no reconciliation, no result.
    const s = servedBook("agras");
    const apl = { ...(s.statements.assembled_pl as Record<string, unknown>) };
    delete apl.net_income_statutory;
    delete apl.ebitda_reconciliation;
    const noAnchor = { ...s.statements, assembled_pl: apl as Record<string, number> };
    const pl = pickPLBuilder({ lineItems: lineItemsFor("agras"), currency: noAnchor.currency }, noAnchor);
    expect(pl.netProfit).toBeNull();
    expect(pl.netProfitStatutory).toBeNull();
    const got = resolveHeadlineNetProfit(noAnchor, NONE, pl);
    expect(Number.isNaN(got), `absent — got ${got}`).toBe(true);
    expect(got).not.toBe(0);
    expect(got).not.toBe(s.anchor);
  });

  it("no envelope and no metrics at all still resolves to the builder", () => {
    const s = servedBook("agras");
    expect(resolveHeadlineNetProfit(null, null, s.pl)).toBe(s.pl.netProfitStatutory);
  });
});

describe("the card can still name where the printed figure came from", () => {
  // A figure whose origin the provenance module cannot verify renders
  // plain — so moving the tile onto the envelope must move the
  // provenance with it, or the repair trades a wrong number for a
  // number with no source.
  it.each(BOOKS)("%s names assembled_pl.net_income_statutory", (book) => {
    const s = servedBook(book);
    const profit = resolveHeadlineNetProfit(s.statements, NONE, s.pl);
    const p = buildHeadlineProvenance({
      statements: s.statements,
      pl: s.pl,
      fromLineItems: plBuiltFromLineItems(lineItemsFor(book), s.statements),
      metrics: NONE,
      sourceDocumentFilename: `${book}_balanta.xlsx`,
      periodLabel: "FY 2025",
      values: {
        revenue: s.statements.incomeStatement.revenue,
        ebitda: 0,
        profit,
        cash: s.statements.balanceSheet.cash,
        totalDebt: 0,
        netDebt: 0,
      },
    }).profit;
    expect(p).not.toBeNull();
    expect(p?.source).toContain("assembled_pl.net_income_statutory");
  });
});
