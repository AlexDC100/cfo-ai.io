// THE HEADLINE FIGURES NAME THEIR ORIGIN — measured on REAL engine output.
//
// TC-1: the balance-sheet half of the fixture is
// `corpus/saga_10_col_carniprod/expected/served_envelope.json`, a real
// SAGA export served by the engine with codes and numerics preserved to
// the cent. The cash claim below is only ever made when the envelope's
// own cash rows SUM to the figure on screen, so the assertion is about
// arithmetic the reader can repeat, not about what this module believes
// a cash row is.
//
// TC-2 was run on this file: with the cent check in `matchingCashRows`
// loosened to `true`, "a cash figure that is NOT the served rows renders
// plain" went red with the account codes in the card — the exact
// fabrication the check exists to refuse.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildHeadlineProvenance,
  plBuiltFromLineItems,
  type HeadlineProvenanceInput,
} from "@/lib/headlineProvenance";
import { buildPLStatement, pickPLBuilder } from "@/lib/buildPlStatement";
import type { CanonicalBs, Statements } from "@/lib/financialReport";
import type { PeriodLineItem } from "@/lib/activePeriod";

const repoRoot = resolve(__dirname, "../../..");
const envelope = JSON.parse(
  readFileSync(
    resolve(repoRoot, "corpus/saga_10_col_carniprod/expected/served_envelope.json"),
    "utf-8",
  ),
) as CanonicalBs;

/** The envelope's cash rows, summed the way the module sums them. */
const CASH_ROWS = envelope.rows.filter((r) => r.id.startsWith("cash"));
const CASH = CASH_ROWS.reduce((a, r) => a + r.amount, 0);
const CASH_CODES = [...new Set(CASH_ROWS.flatMap((r) => r.account_codes))];

function statementsWith(cash: number): Statements {
  return {
    companyName: "Carniprod",
    currency: "RON",
    periodLabel: "FY 2025",
    balanceSheet: { cash, shortTermDebt: 1_000, longTermDebt: 2_000 } as Statements["balanceSheet"],
    incomeStatement: { revenue: 90_000_000.5 } as Statements["incomeStatement"],
    supplementary: {} as Statements["supplementary"],
    // The served block names the one EBITDA `ebitda` (the legacy alias rides beside it).
    assembled_pl: { ebitda: 12_345_678.9, ebitda_statutory: 12_345_678.9 },
    canonical_bs: envelope,
  };
}

function baseInput(over: Partial<HeadlineProvenanceInput> = {}): HeadlineProvenanceInput {
  return {
    statements: statementsWith(CASH),
    pl: null,
    fromLineItems: false,
    metrics: [{ name: "net_income_statutory", value: 1_435_533.59, unit: "RON", direction: null }],
    sourceDocumentFilename: "carniprod_balanta_2025.xlsx",
    periodLabel: "FY 2025",
    values: {
      revenue: 90_000_000.5,
      ebitda: 12_345_678.9,
      profit: 1_435_533.59,
      cash: CASH,
      totalDebt: 3_000,
      netDebt: 3_000 - CASH,
    },
    ...over,
  };
}

describe("the fixture actually carries what the module would claim", () => {
  it("has cash rows with account codes, a sheet, a method and a pack", () => {
    expect(CASH_ROWS.length).toBeGreaterThan(0);
    expect(CASH_CODES.length).toBeGreaterThan(0);
    expect(envelope.extraction?.sheet).toBeTruthy();
    expect(envelope.extraction?.method).toBeTruthy();
    expect(envelope.mapping_version).toBeTruthy();
  });

  it("anchors its closing result on named codes with cents", () => {
    const anchor = (envelope as unknown as {
      source_anchor: { closing_result: { codes: string[]; p121_cents: number } };
    }).source_anchor.closing_result;
    expect(anchor.codes).toEqual(["121"]);
    expect(anchor.p121_cents).toBe(143553359);
  });
});

describe("cash — the served rows, only when they sum to the figure", () => {
  it("names the rows' account codes, the sheet, the method and the pack", () => {
    const p = buildHeadlineProvenance(baseInput()).cash;
    expect(p).not.toBeNull();
    expect(p?.accounts).toBe(CASH_CODES.join(", "));
    expect(p?.source).toContain(envelope.extraction?.sheet);
    expect(p?.source).toContain("carniprod_balanta_2025.xlsx");
    expect(p?.method).toBe(envelope.extraction?.method);
    expect(p?.pack).toBe(envelope.mapping_version);
    expect(p?.period).toBe("FY 2025");
  });

  it("a cash figure that is NOT the served rows renders plain (no codes borrowed)", () => {
    const off = CASH + 1;
    const p = buildHeadlineProvenance(
      baseInput({ statements: statementsWith(off), values: { ...baseInput().values, cash: off } }),
    ).cash;
    // The legacy field is the figure, so that field path is named — but
    // never the rows, never their codes, never the sheet.
    expect(p?.accounts).toBeUndefined();
    expect(p?.pack).toBeUndefined();
    expect(p?.source).toContain("statements.balanceSheet.cash");
  });
});

describe("net profit — account 121 only from the envelope's own anchor", () => {
  it("claims 121 when the anchor's cents equal the figure", () => {
    const p = buildHeadlineProvenance(baseInput()).profit;
    expect(p?.accounts).toBe("121");
    expect(p?.source).toContain("calculated_metrics.net_income_statutory");
  });

  it("drops the account when the figure is not the anchored cents", () => {
    const input = baseInput();
    input.metrics = [{ name: "net_income_statutory", value: 999, unit: "RON", direction: null }];
    input.values = { ...input.values, profit: 999 };
    const p = buildHeadlineProvenance(input).profit;
    expect(p?.source).toContain("calculated_metrics.net_income_statutory");
    expect(p?.accounts).toBeUndefined();
  });
});

describe("EBITDA — the served field, else the builder", () => {
  // The one EBITDA by its own served name (one-EBITDA ruling): the legacy
  // `ebitda_statutory` is an alias of it and is no longer named.
  it("names assembled_pl.ebitda when that is the figure", () => {
    const p = buildHeadlineProvenance(baseInput()).ebitda;
    expect(p?.source).toBe("carniprod_balanta_2025.xlsx · assembled_pl.ebitda");
  });

  it("names nothing when neither the field nor a builder produced the figure", () => {
    const input = baseInput();
    input.values = { ...input.values, ebitda: 1 };
    expect(buildHeadlineProvenance(input).ebitda).toBeNull();
  });
});

describe("the derived pair name their derivation and NO source", () => {
  it("total debt and net debt", () => {
    const out = buildHeadlineProvenance(baseInput());
    expect(out.totalDebt?.method).toContain("derived");
    expect(out.totalDebt?.source).toBeUndefined();
    expect(out.netDebt?.method).toContain("total debt − cash");
    expect(out.netDebt?.source).toBeUndefined();
  });

  it("refuse when the arithmetic does not hold", () => {
    const input = baseInput();
    input.values = { ...input.values, netDebt: 12 };
    expect(buildHeadlineProvenance(input).netDebt).toBeNull();
  });
});

// ── revenue, through the REAL P&L builder ──────────────────────────────

const PL_ITEMS: PeriodLineItem[] = [
  { statement: "PL", bucket: "revenue", ro_account_code: "706", amount: 500 },
  { statement: "PL", bucket: "revenue", ro_account_code: "708", amount: 25.5 },
  { statement: "PL", bucket: "opex", ro_account_code: "628", amount: 100 },
];

function plFor(items: PeriodLineItem[], s: Statements) {
  return pickPLBuilder({ lineItems: items, entity: "x", period: "FY 2025", currency: "RON" }, s);
}

describe("revenue — the builder's own account codes, on the line-item path only", () => {
  it("lists the codes the builder summed when the subtotal is the figure", () => {
    const s = statementsWith(CASH);
    const pl = plFor(PL_ITEMS, s);
    const revenue = pl.sections[0].subtotalAmount ?? NaN;
    expect(revenue).toBe(525.5);
    const p = buildHeadlineProvenance(
      baseInput({ pl, fromLineItems: true, values: { ...baseInput().values, revenue } }),
    ).revenue;
    expect(p?.accounts).toBe("706, 708");
    expect(p?.source).toBe("carniprod_balanta_2025.xlsx");
    expect(p?.method).toContain("Total net turnover");
  });

  it("names NO accounts on the aggregates path — those codes are labels", () => {
    const s = statementsWith(CASH);
    const pl = plFor(PL_ITEMS, s);
    const revenue = pl.sections[0].subtotalAmount ?? NaN;
    const p = buildHeadlineProvenance(
      baseInput({ pl, fromLineItems: false, values: { ...baseInput().values, revenue } }),
    ).revenue;
    expect(p?.accounts).toBeUndefined();
    expect(p?.method).toContain("P&L builder subtotal");
  });
});

describe("plBuiltFromLineItems ASKS pickPLBuilder's rule — it no longer mirrors it", () => {
  // This block used to assert that two SEPARATE copies of the routing rule
  // agreed. They stopped agreeing on 2026-09-09, when the rule became a
  // COVERAGE test — and the block did its job by going red. The fix was not
  // to re-sync the copies but to delete one: `plBuiltFromLineItems` now
  // delegates to `plUsesLineItems`, the single authority in
  // buildPlStatement.ts. What is left to assert is that the delegation is
  // real and that the predicate still describes what the picker did.

  it("says TRUE exactly when the picker used the line-item builder", () => {
    const s = statementsWith(CASH);
    expect(plBuiltFromLineItems(PL_ITEMS, s)).toBe(true);
    const picked = plFor(PL_ITEMS, s);
    // The picker hands the line-item builder the period's served block —
    // the same call, made directly, builds the same statement.
    const direct = buildPLStatement({
      lineItems: PL_ITEMS, entity: "x", period: "FY 2025", currency: "RON",
      servedPl: s.assembled_pl,
    });
    expect(picked.sections.map((x) => x.subtotalAmount)).toEqual(
      direct.sections.map((x) => x.subtotalAmount),
    );
  });

  it("says FALSE for a book the code table cannot cover, and the picker agrees", () => {
    // A CONDENSED 4-digit book: the exact-code table names almost none of
    // it, so coverage collapses and the aggregates must serve. This is the
    // production shape that served three expense lines out of seventy.
    const condensed: PeriodLineItem[] = [
      "6011", "6012", "6021", "6022", "6111", "6411", "6451",
    ].map((code, i) => ({
      ...PL_ITEMS[0], id: `c-${i}`, ro_account_code: code, amount: 1_000_000,
    })) as PeriodLineItem[];
    // The envelope must state an operating-expense total, or there is
    // nothing to measure coverage AGAINST and the predicate cannot judge.
    const base = statementsWith(CASH);
    const s = {
      ...base,
      assembled_pl: { ...(base as { assembled_pl?: object }).assembled_pl,
                      total_operating_expense: 7_000_000 },
    } as typeof base;
    expect(
      plBuiltFromLineItems(condensed, s),
      "a book the table cannot cover must not be reported as read from line items",
    ).toBe(false);
    const picked = plFor(condensed, s);
    const direct = buildPLStatement({
      lineItems: condensed, entity: "x", period: "FY 2025", currency: "RON",
    });
    // The picker fell back to the aggregates, so its subtotals are the
    // envelope's, not the line items'.
    expect(picked.sections[0].subtotalAmount).not.toBe(direct.sections[0].subtotalAmount);
  });

  it("says FALSE when there are no P&L items at all", () => {
    expect(plBuiltFromLineItems([], statementsWith(CASH))).toBe(false);
  });

  it("there is only ONE copy of the rule left", () => {
    // The structural half. A second implementation is the defect this
    // block was originally written to detect.
    const src = readFileSync(
      join(process.cwd(), "frontend", "lib", "headlineProvenance.ts"), "utf-8",
    );
    expect(src).toContain("plUsesLineItems");
    expect(
      src.includes("length > 4"),
      "headlineProvenance has re-implemented the routing rule instead of asking for it",
    ).toBe(false);
  });
});
