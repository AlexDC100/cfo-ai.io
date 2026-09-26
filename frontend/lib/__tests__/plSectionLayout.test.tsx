// THE P&L LAYOUT PLACES EACH SECTION BY ITS ROLE, NEVER BY ITS INDEX.
//
// THE DEFECT. PLStatementView read the statement's sections POSITIONALLY —
// `[revenue, opex, d&a, financial, closing] = sections` — while both RO
// builders insert an OTHER OPERATING INCOME section (account 758) right
// after operating revenue whenever the book carries one. On such a book,
// which is most books, every index after it shifted by one: the 758
// section rendered in the operating-expenses slot, the EBITDA box landed
// between it and the operating expenses, and the sixth section — profit
// before tax, income tax, net profit — was never rendered at all, its
// compare cells with it. The footnote read `sections[1]` as the operating
// expenses and so printed the 758 subtotal's arithmetic as "opex".
//
// WHAT THESE RED ON, with the view correct (TC-11):
//   · profit before tax, income tax or net profit missing from a P&L that
//     carries a 758 section, or their compare cells missing;
//   · any section, or the EBITDA box, out of the reference order —
//     revenue, other operating income, operating expenses, EBITDA, D&A to
//     EBIT, financial items, profit before tax to net profit;
//   · the footnote's "clean" operating expenses computed off any section
//     but the operating expenses.
//
// THE FIXTURES: the committed comparatives pair (see ratioTableByteMatch
// .test.tsx) and synthetic books. No client figure, name or code enters
// this file.
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";
import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { pickPLBuilder } from "@/lib/buildPlStatement";
import type { ComparativesResponse } from "@/lib/comparatives";
import type { ApiLineItem, PLStatement } from "@/lib/plStructure";
import type { Statements } from "@/lib/financialReport";

import pairJson from "./fixtures/comparatives/pair_served.json";

interface Pair {
  current_body: { statements: Statements };
  comparatives: ComparativesResponse;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The reference order, as the label each landmark row starts with. */
const ORDER = [
  "OPERATING REVENUE",
  "Total operating revenue",
  "OTHER OPERATING INCOME",
  "Total other operating income",
  "OPERATING EXPENSES",
  "Total operating expenses (cash)",
  "EBITDA",
  "EBIT",
  "FINANCIAL ITEMS",
  "Net financial result",
  "Profit before tax",
  "Net profit — operational (excl. 722)",
];

function renderPl(statement: PLStatement, doc?: ComparativesResponse, showFootnote = false) {
  const view = <PLStatementView statement={statement} hideGuide showFootnote={showFootnote} />;
  return renderWithProviders(
    doc
      ? <ComparativeProvider doc={doc} columns={{ prior: true, delta: true, deltaPct: true, share: true }} statement="PL" currency="RON">{view}</ComparativeProvider>
      : view,
  );
}

/** Every section header and row label, in document order. */
function landmarks(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".pl-section-header, .pl-row .pl-label"))
    .map((el) => (el.textContent ?? "").trim());
}

/** The landmark's position: an exact label first ("EBIT" must not match
 *  "EBITDA"), else the one label it starts (headers and labels carry a
 *  suffix: "OPERATING EXPENSES (excl. D&A)"). */
function indexOfLandmark(marks: string[], label: string): number {
  const exact = marks.indexOf(label);
  if (exact >= 0) return exact;
  const prefixed = marks.flatMap((m, i) => (m.startsWith(label) ? [i] : []));
  expect(prefixed, `"${label}" is rendered exactly once`).toHaveLength(1);
  return prefixed[0];
}

function expectReferenceOrder(container: HTMLElement, expected: string[]) {
  const marks = landmarks(container);
  const positions = expected.map((label) => indexOfLandmark(marks, label));
  const increasing = positions.every((p, i) => i === 0 || p > positions[i - 1]);
  expect(increasing, `rendered order: ${marks.join(" | ")}`).toBe(true);
}

beforeEach(() => {
  localStorage.setItem("cfo-view-mode-v1", "pro");
});

describe("a P&L with an OTHER OPERATING INCOME section (the aggregates builder, the committed pair)", () => {
  const load = () => clone(pairJson) as unknown as Pair;

  it("renders every section, in the reference order", () => {
    const { current_body } = load();
    const statement = pickPLBuilder({ lineItems: [] }, current_body.statements);
    expect(statement.sections.map((s) => s.header)).toContain("OTHER OPERATING INCOME");
    const { container } = renderPl(statement);
    expectReferenceOrder(container, ORDER);
  });

  it("profit before tax, income tax and net profit carry their compare cells", () => {
    const { current_body, comparatives: doc } = load();
    const statement = pickPLBuilder({ lineItems: [] }, current_body.statements);
    const { container } = renderPl(statement, doc);
    for (const key of ["pl.pretax", "pl.tax", "pl.net_income_operational"]) {
      const cells = container.querySelector(`[data-cmp-key="${key}"]`);
      expect(cells, key).not.toBeNull();
      expect(cells!.getAttribute("data-cmp"), key).toBe("compared");
    }
  });

  it("without a 758 section the order is unchanged", () => {
    const { current_body } = load();
    current_body.statements.incomeStatement.otherIncome = 0;
    const statement = pickPLBuilder({ lineItems: [] }, current_body.statements);
    expect(statement.sections.map((s) => s.header)).not.toContain("OTHER OPERATING INCOME");
    const { container } = renderPl(statement);
    expectReferenceOrder(container, ORDER.filter((l) => !/other operating income/i.test(l)));
  });
});

// ── The line-item builder: the same layout ───────────────────────────
const li = (code: string, bucket: string, amount: number): ApiLineItem => ({
  statement: "PL", bucket, ro_account_code: code, amount, is_derived: false,
});

const LEAF_BOOK: ApiLineItem[] = [
  li("706", "revenue", 5_000_000.0),
  li("611", "operatingExpenses", 400_000.0),
  li("641", "operatingExpenses", 1_300_000.0),
  li("6811", "depreciation", 20_000.0),
  li("758", "otherIncome", 50_000.0),
  li("766", "financialIncome", 10_000.0),
  li("691", "taxExpense", 100_000.0),
];

const LEAF_STATEMENTS = {
  companyName: "Synthetic SRL", currency: "RON", periodLabel: "2025-12-31",
  balanceSheet: {}, supplementary: {}, incomeStatement: {},
  assembled_pl: { total_operating_expense: 1_720_000.0 },
} as unknown as Statements;

describe("a P&L with an OTHER OPERATING INCOME section (the line-item builder)", () => {
  it("renders every section, in the reference order", () => {
    const statement = pickPLBuilder({ lineItems: LEAF_BOOK }, LEAF_STATEMENTS);
    expect(statement.sections[0].lines.map((l) => l.accountCode)).toEqual(["706"]);
    const { container } = renderPl(statement);
    expectReferenceOrder(container, ORDER);
  });
});

// ── The footnote's operating expenses ────────────────────────────────
describe("the 722 footnote reads the operating-expenses section, not the section after revenue", () => {
  it("prints the clean operating expenses off the operating-expenses subtotal", () => {
    // Aggregates path: the footnote's 628 proxy is the whole operating-
    // expense bucket, so its "clean" opex is the cost of goods sold.
    const COGS = 700_000.0;
    const statements = {
      companyName: "Synthetic SRL", currency: "RON", periodLabel: "2025-12-31",
      balanceSheet: {}, supplementary: {},
      incomeStatement: {
        revenue: 3_000_000.0, costOfGoodsSold: COGS, operatingExpenses: 900_000.0,
        depreciationAmortization: 50_000.0, interestExpense: 0, otherIncome: 123_456.78,
        financialIncome: 0, financialExpense: 0, taxExpense: 0, capitalizedOwnWork: 200_000.0,
      },
      assembled_pl: { capitalized_own_work_memo: 200_000.0 },
    } as unknown as Statements;
    const statement = pickPLBuilder({ lineItems: [] }, statements);
    expect(statement.sections.map((s) => s.header)).toContain("OTHER OPERATING INCOME");
    const { container } = renderPl(statement, undefined, true);
    const footnote = container.querySelector('[data-testid="pl-footnote"]');
    expect(footnote).not.toBeNull();
    const text = footnote!.textContent ?? "";
    const opex = text.split("opex drops to ~")[1]?.split(", clean EBITDA")[0];
    expect(opex, text).toBeDefined();
    expect(opex!.replace(/\D/g, "")).toBe(COGS.toFixed(2).replace(/\D/g, ""));
  });
});
