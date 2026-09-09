// A P&L view may not silently omit accounts it does not recognise.
//
// THE DEFECT (P0, live on Dec 2024, 2026-09-09). The router in
// buildPlStatement guessed the book's shape from the LENGTH of its account
// codes: if most were longer than 4 characters it used the engine's
// aggregates, otherwise it built the statement from line items with
// `sumByExact` against a fixed table (OPEX_CODES).
//
// A CONDENSED EXTERNAL balanță — 4-digit synthetic codes, an entirely
// normal Romanian disclosure level — took the line-item branch. Of its 70
// class-6 accounts, exactly THREE are in that table: 6024, 6051, 6458. The
// served statement showed:
//
//     Spare parts (6024)              55.31
//     Energy (6051)            4,833,129.56
//     Other social contrib (6458) 870,424.00
//     Total operating expenses  5,703,608.87
//
// against a book carrying 409,697,663.25, with revenue rendering as
// nothing. The engine had stored all 220 line items correctly. An
// exact-match table has no way to say "I did not recognise this account",
// so 67 of them vanished without a word.
//
// THE FIX is to route on COVERAGE: build the line-item view only if it
// reaches OPEX_COVERAGE_FLOOR of the operating expense the engine
// assembled. Anything less falls back to the aggregates, which are the
// engine's own totals.
//
// WHAT THIS REDS ON, with the router correct (TC-11):
//   · a condensed (4-digit synthetic) book routing to the line-item view
//   · the coverage floor being lowered enough to admit a partial view
//   · OPEX_CODES shrinking so an analytic book stops being covered
import { describe, expect, it } from "vitest";

import {
  OPEX_CODES,
  OPEX_COVERAGE_FLOOR,
  pickPLBuilder,
} from "@/lib/buildPlStatement";
import type { ApiLineItem } from "@/lib/plStructure";

/** The real class-6 codes the condensed Scandia FY2024 book carries.
 *  Four-digit synthetics — only 6024/6051/6458 are in OPEX_CODES. */
const CONDENSED_CODES = [
  "6011", "6012", "6014", "6015", "6019",
  "6021", "6022", "6023", "6024",
  "6051", "6052",
  "6111", "6121", "6131",
  "6411", "6451", "6458",
];

/** The analytic FY2025 shape: 6-digit codes under the same synthetics. */
const ANALYTIC_CODES = [
  "601101", "601201", "601401", "602101", "602401",
  "605101", "611101", "641101", "645101", "645801",
];

function items(codes: string[], each: number): ApiLineItem[] {
  return codes.map((code, i) => ({
    id: `li-${i}`,
    statement: "PL",
    ro_account_code: code,
    ro_account_name: `Account ${code}`,
    amount: each,
    bucket: "opex",
  })) as unknown as ApiLineItem[];
}

/** An engine envelope whose assembled totals are the truth. Carries BOTH
 *  shapes: `assembled_pl` (what the router measures coverage against) and
 *  `incomeStatement` (what the aggregates builder renders from). */
function statements(totalOpex: number, revenue: number) {
  return {
    assembled_pl: {
      revenue,
      total_operating_expense: totalOpex,
      ebitda: revenue - totalOpex,
      cogs: 0,
      opex_excluding_cogs_and_da: totalOpex,
      other_income_758: 0,
      net_income_statutory: revenue - totalOpex,
    },
    incomeStatement: {
      revenue,
      costOfGoodsSold: 0,
      operatingExpenses: totalOpex,
      depreciationAmortization: 0,
      capitalizedOwnWork: 0,
      otherIncome: 0,
      financialIncome: 0,
      financialExpense: 0,
      interestExpense: 0,
      taxExpense: 0,
    },
    assembled_bs: {},
  } as unknown as Parameters<typeof pickPLBuilder>[1];
}

function totalOpexOf(stmt: ReturnType<typeof pickPLBuilder>): number {
  for (const section of stmt.sections ?? []) {
    if (/operating expense|opex/i.test(section.header ?? "")) {
      return Math.abs(Number(section.subtotalAmount ?? 0));
    }
  }
  return 0;
}

describe("P&L routing — coverage, not code shape", () => {
  it("the condensed book really does defeat the exact-code table", () => {
    // TC-3 non-vacuity: if OPEX_CODES ever covered these, the test below
    // would pass without exercising anything.
    const matched = CONDENSED_CODES.filter((c) => (OPEX_CODES as readonly string[]).includes(c));
    expect(matched.sort()).toEqual(["6024", "6051", "6458"]);
    expect(matched.length / CONDENSED_CODES.length).toBeLessThan(0.2);
  });

  it("a condensed 4-digit book serves the engine's total, not three lines", () => {
    // 17 accounts of 1,000,000 each; the engine assembled 17,000,000.
    const ASSEMBLED = 17_000_000;
    const stmt = pickPLBuilder(
      { lineItems: items(CONDENSED_CODES, 1_000_000), entity: "E", period: "FY2024" },
      statements(ASSEMBLED, 40_000_000),
    );
    const served = totalOpexOf(stmt);
    // The defect served 3/17 of the book. The fix serves all of it.
    expect(
      served,
      `served operating expenses ${served.toLocaleString()} against an assembled ` +
        `${ASSEMBLED.toLocaleString()} — the line-item table dropped the accounts it does not name`,
    ).toBeCloseTo(ASSEMBLED, 2);
  });

  it("an analytic 6-digit book still routes to the aggregates", () => {
    const ASSEMBLED = 10_000_000;
    const stmt = pickPLBuilder(
      { lineItems: items(ANALYTIC_CODES, 1_000_000), entity: "E", period: "FY2025" },
      statements(ASSEMBLED, 30_000_000),
    );
    expect(totalOpexOf(stmt)).toBeCloseTo(ASSEMBLED, 2);
  });

  it("a book the table DOES cover keeps its per-account detail", () => {
    // POSITIVE CONTROL. Without it, "always use aggregates" would pass
    // every test above — and that would throw away the line-item view
    // entirely, which is a different regression.
    const covered = ["6024", "6051", "6458", "641", "645", "628", "635"];
    const ASSEMBLED = covered.length * 1_000_000;
    const stmt = pickPLBuilder(
      { lineItems: items(covered, 1_000_000), entity: "E", period: "FY2025" },
      statements(ASSEMBLED, 30_000_000),
    );
    const opexSection = (stmt.sections ?? []).find((s) =>
      /operating expense/i.test(s.header ?? ""),
    );
    expect(
      (opexSection?.lines ?? []).length,
      "a fully covered book lost its per-account lines — the fallback is now unconditional",
    ).toBeGreaterThan(1);
  });

  it("the coverage floor is high enough to be meaningful", () => {
    // A floor low enough to admit the defect is not a floor. The condensed
    // book scored 0.014 in production.
    expect(OPEX_COVERAGE_FLOOR).toBeGreaterThan(0.9);
    expect(OPEX_COVERAGE_FLOOR).toBeLessThanOrEqual(1);
  });
});
