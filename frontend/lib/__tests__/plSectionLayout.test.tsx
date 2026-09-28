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
// THE ONE EBITDA (owner ruling 2026-09-26) rewrote the order this file
// holds: net turnover (cifra de afaceri netă — no 722, no 767) → other
// operating income → own work capitalised (72x) → operating expenses → the
// stock variation (711, "Variația stocurilor de produse") beside them →
// EBITDA → D&A to EBIT → financial items → profit before tax → the net
// result, ending on account 121. The closing line is account 121 as filed
// (`pl.net_income`), no longer the operational build-up excluding 722; the
// "clean EBITDA" footnote this file used to hold to the operating-expenses
// section is RETIRED (it stated EBITDA without 72x as the operating truth).
//
// WHAT THESE RED ON, with the view correct (TC-11):
//   · profit before tax, income tax or the net result missing from a P&L
//     that carries a 758 section, or their compare cells missing;
//   · any section, the stock-variation row or the EBITDA box out of the
//     reference order above;
//   · the retired footnote rendering again.
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
  "NET TURNOVER",
  "Total net turnover",
  "OTHER OPERATING INCOME",
  "Total other operating income",
  "OPERATING EXPENSES",
  "Total operating expenses",
  "Variația stocurilor de produse",
  "EBITDA",
  "EBIT",
  "FINANCIAL ITEMS",
  "Net financial result",
  "Profit before tax",
  "Rezultatul net din contul 121",
];
/** The line-item book below: no 711 postings, no account 121 served — the
 *  closing line is "Net profit". */
const LEAF_ORDER = ORDER.filter((l) => l !== "Variația stocurilor de produse").map((l) =>
  l === "Rezultatul net din contul 121" ? "Net profit" : l,
);

function renderPl(statement: PLStatement, doc?: ComparativesResponse) {
  const view = <PLStatementView statement={statement} hideGuide />;
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

  it("profit before tax, income tax and the net result carry their compare cells", () => {
    const { current_body, comparatives: doc } = load();
    const statement = pickPLBuilder({ lineItems: [] }, current_body.statements);
    const { container } = renderPl(statement, doc);
    for (const key of ["pl.pretax", "pl.tax", "pl.net_income"]) {
      const cells = container.querySelector(`[data-cmp-key="${key}"]`);
      expect(cells, key).not.toBeNull();
      expect(cells!.getAttribute("data-cmp"), key).toBe("compared");
    }
  });

  it("without a 758 section the order is unchanged", () => {
    const { current_body } = load();
    // The served line the builder reads first, and the mirror behind it.
    current_body.statements.incomeStatement.otherIncome = 0;
    (current_body.statements.assembled_pl as Record<string, number>).other_operating_income = 0;
    const statement = pickPLBuilder({ lineItems: [] }, current_body.statements);
    expect(statement.sections.map((s) => s.header)).not.toContain("OTHER OPERATING INCOME");
    const { container } = renderPl(statement);
    expectReferenceOrder(container, ORDER.filter((l) => !/other operating income/i.test(l)));
  });

  it("without a stock variation the order is unchanged", () => {
    const { current_body } = load();
    const apl = current_body.statements.assembled_pl as unknown as Record<string, Record<string, unknown>>;
    apl.inventory_variation = { ...apl.inventory_variation, value: 0, provenance: "no_711_activity" };
    const statement = pickPLBuilder({ lineItems: [] }, current_body.statements);
    expect(statement.sections.map((s) => s.role)).not.toContain("stockVariation");
    const { container } = renderPl(statement);
    expectReferenceOrder(container, ORDER.filter((l) => l !== "Variația stocurilor de produse"));
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
    expectReferenceOrder(container, LEAF_ORDER);
  });
});

// ── The retired footnote ─────────────────────────────────────────────
describe("the 'clean EBITDA' footnote is retired", () => {
  it("a book carrying own work capitalised renders no footnote and no 'clean' EBITDA", () => {
    // The book the footnote used to fire on: 72x of 200,000. Under the
    // ruling 72x is INSIDE EBITDA — there is no "clean" EBITDA beside it.
    const statements = {
      companyName: "Synthetic SRL", currency: "RON", periodLabel: "2025-12-31",
      balanceSheet: {}, supplementary: {},
      incomeStatement: {
        revenue: 3_000_000.0, costOfGoodsSold: 700_000.0, operatingExpenses: 900_000.0,
        depreciationAmortization: 50_000.0, interestExpense: 0, otherIncome: 123_456.78,
        financialIncome: 0, financialExpense: 0, taxExpense: 0, capitalizedOwnWork: 200_000.0,
      },
    } as unknown as Statements;
    const statement = pickPLBuilder({ lineItems: [] }, statements);
    expect(statement.sections.map((s) => s.role)).toContain("capitalizedOwnWork");
    const { container } = renderPl(statement);
    expect(container.querySelector('[data-testid="pl-footnote"]')).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/clean EBITDA|opex drops to/i);
  });
});
