// THE P&L FOOTNOTE'S RENTAL-DOMINANCE TEST READS THE 706 FAMILY OFF THE
// BOOK'S OWN REVENUE FAMILIES — never off a line whose account code
// happens to equal "706".
//
// The footnote frames the 722/628 wash as a landlord's when rental income
// (706, plus 767) is at least 60% of revenue ex own-work. It used to find
// that rent as `lines.find((l) => l.accountCode === "706")`. On the
// aggregates path the revenue row's `accountCode` is the CHIP — the
// families the book holds ("701/704/706/707/709" on a goods seller,
// "704/706" on a landlord with a little service income) — so the test read
// a landlord with any second family as no landlord at all, and a chip
// reading exactly "706" as the whole turnover; on a sub-account ledger
// (7061, 7062, …) `=== "706"` matched nothing (verifier P2, 2026-09-26).
// The 706 family is now `revenueFamilyAmounts` — the same reading of the
// leaves the chip is built from, carried on the statement.
//
// WHAT THESE RED ON, with the module correct (TC-11):
//   · a landlord whose revenue leaves are 706 sub-accounts beside a small
//     704 family read as not rental-dominated (the pre-repair chip test);
//   · a goods seller with a token 706 leaf read as rental-dominated;
//   · `revenueFamilyAmounts` folding "706.01" / "7061" / "706" into more
//     than one family, or counting a balance-sheet row or another bucket;
//   · the statement not carrying the families the chip was read from.
//
// Every book here is SYNTHETIC (four-digit codes, invented figures). No
// client figure, name or code enters this file.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/renderWithProviders";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { pickPLBuilder, revenueFamiliesChip, revenueFamilyAmounts } from "@/lib/buildPlStatement";
import type { ApiLineItem } from "@/lib/plStructure";
import type { Statements } from "@/lib/financialReport";

const pl = (code: string, bucket: string, amount: number): ApiLineItem => ({
  statement: "PL", bucket, ro_account_code: code, amount, is_derived: false,
});

const OWN_WORK = 1_000.0;
const COGS = 100_000.0;
const OPEX = 50_000.0;
const DNA = 10_000.0;

/** Opex codes the line-item view's exact-match table does not name, so
 *  every book here routes to the aggregates builder — the path on which
 *  the revenue row's code is the chip. */
const COSTS: ApiLineItem[] = [
  pl("6011", "cogs", COGS),
  pl("6411", "operatingExpenses", OPEX),
  pl("6811", "depreciation", DNA),
];

/** A landlord keeping its rent in 706 sub-accounts, with a little service
 *  income: the chip reads "704/706", the rent is 95% of turnover. */
const LANDLORD_SUBACCOUNTS: ApiLineItem[] = [
  pl("7061", "revenue", 8_000_000.0),
  pl("7062", "revenue", 1_500_000.0),
  pl("7041", "revenue", 500_000.0),
];

/** A landlord on three-digit codes: the chip reads exactly "706". */
const LANDLORD_EXACT: ApiLineItem[] = [pl("706", "revenue", 5_000_000.0)];

/** A goods seller with a token rent leaf: the chip reads five families. */
const GOODS_SELLER: ApiLineItem[] = [
  pl("7011", "revenue", 900_000_000.0),
  pl("7040", "revenue", 50_000_000.0),
  pl("7060", "revenue", 1_000_000.0),
  pl("7071", "revenue", 60_000_000.0),
  pl("7091", "revenue", -23_345_678.91),
];

const sum = (leaves: ApiLineItem[]) => leaves.reduce((a, li) => a + li.amount, 0);

function statementsFor(revenue: number): Statements {
  return {
    companyName: "Synthetic SRL",
    currency: "RON",
    periodLabel: "2024-12-31",
    balanceSheet: {},
    supplementary: {},
    incomeStatement: {
      revenue, costOfGoodsSold: COGS, operatingExpenses: OPEX,
      depreciationAmortization: DNA, interestExpense: 0, otherIncome: 0,
      financialIncome: 0, financialExpense: 0, taxExpense: 0,
      // Some capitalized own work, so the footnote renders at all.
      capitalizedOwnWork: OWN_WORK,
    },
    assembled_pl: {
      revenue, cogs: COGS, opex_total: OPEX, depreciation: DNA,
      ebitda: revenue - (COGS + OPEX), total_operating_expense: COGS + OPEX + DNA,
    },
  } as unknown as Statements;
}

function build(leaves: ApiLineItem[]) {
  return pickPLBuilder(
    { lineItems: [...leaves, ...COSTS], entity: "Synthetic SRL", period: "2024-12-31", currency: "RON" },
    statementsFor(sum(leaves)),
  );
}

/** The footnote's lead sentence for a book. */
function footnoteLead(leaves: ApiLineItem[]): string {
  renderWithProviders(<PLStatementView statement={build(leaves)} hideGuide showFootnote />);
  return screen.getByTestId("pl-footnote").querySelector("strong")?.textContent ?? "";
}

const RENTAL_LEAD = "Two things worth flagging";
const GENERIC_LEAD = "Worth flagging given the structure";

beforeEach(() => {
  localStorage.setItem("cfo-view-mode-v1", "pro");
});
afterEach(cleanup);

describe("revenueFamilyAmounts — one reading of the revenue leaves", () => {
  it("folds separators and sub-accounts into the three-digit family and sums the amounts", () => {
    const families = revenueFamilyAmounts([
      pl("706.01", "revenue", 1),
      pl("7061", "revenue", 2),
      pl("706", "revenue", 3),
      pl("7011", "revenue", 7),
    ]);
    expect(families).toEqual({ "706": 6, "701": 7 });
  });

  it("ignores balance-sheet rows and rows outside the revenue bucket, and names a family without an amount at zero", () => {
    const families = revenueFamilyAmounts([
      { statement: "BS", bucket: "revenue", ro_account_code: "7061", amount: 100 },
      pl("6011", "cogs", 9),
      { statement: "PL", bucket: "revenue", ro_account_code: "7041" },
      pl("7011", "revenue", 7),
    ]);
    expect(families).toEqual({ "704": 0, "701": 7 });
  });

  it("is the reading the chip is built from", () => {
    expect(revenueFamiliesChip(LANDLORD_SUBACCOUNTS)).toBe("704/706");
    expect(Object.keys(revenueFamilyAmounts(LANDLORD_SUBACCOUNTS)).sort()).toEqual(["704", "706"]);
    expect(revenueFamiliesChip([])).toBe("70x");
    expect(revenueFamilyAmounts([])).toEqual({});
  });
});

describe("the statement carries the families", () => {
  it("the aggregates path stamps them beside the chip", () => {
    const st = build(LANDLORD_SUBACCOUNTS);
    expect(st.sections[0]?.lines[0]?.accountCode).toBe("704/706");
    expect(st.revenueFamilyAmounts).toEqual({ "706": 9_500_000.0, "704": 500_000.0 });
  });

  it("a statement built without leaves carries none", () => {
    const st = pickPLBuilder({ lineItems: [], entity: "Synthetic SRL", period: "2024-12-31", currency: "RON" }, statementsFor(1));
    expect(st.revenueFamilyAmounts).toBeUndefined();
  });
});

describe("the footnote's rental-dominance test", () => {
  it("a landlord keeping rent in 706 sub-accounts beside a little service income IS a landlord", () => {
    // The pre-repair test read the chip "704/706" as no rent at all.
    expect(footnoteLead(LANDLORD_SUBACCOUNTS)).toContain(RENTAL_LEAD);
  });

  it("a goods seller with a token 706 leaf is NOT a landlord", () => {
    expect(footnoteLead(GOODS_SELLER)).toContain(GENERIC_LEAD);
  });

  it("a landlord on exact three-digit codes is still a landlord", () => {
    expect(footnoteLead(LANDLORD_EXACT)).toContain(RENTAL_LEAD);
  });
});
