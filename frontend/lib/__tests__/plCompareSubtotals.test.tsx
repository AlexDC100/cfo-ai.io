// THE P&L ROWS THAT PRINTED "—" BESIDE A FIGURE THE ENGINE SERVES.
//
// THE INCIDENT (2026-09-26). "Compare with Dec 2025" on a Dec 2024 book: the
// prior, Δ, Δ % and share cells were filled on the net-turnover line, on
// EBITDA, cost of goods sold and operating expenses — and blank on "Total
// operating revenue", "Other operating income (758)" and "Total other
// operating income". The engine serves `pl.revenue` and
// `pl.other_operating_income` for both periods; the rows simply carried no
// key the comparatives map knew (the 758 line no `bucket`, its section no
// `subtotalBucket`, and "revenue" unmapped).
//
// THE PARITY GUARD STAYS. A row carries the engine's cells only when the
// number it shows IS the engine's current figure — and, for "Total operating
// revenue", only while its DEFINITION is the engine line's: that total is
// net turnover PLUS capitalized own work (722) — and, on the line-item
// path, discounts received (767) — so it may carry the net-turnover cells
// only while NEITHER period carries any. Never the prior's net turnover
// under a total that includes 722.
//
// WHAT THESE RED ON, with the module correct (TC-11):
//   · "Total operating revenue", the 758 line or its subtotal carrying no
//     engine key again (the blank cells of the incident);
//   · the total carrying the net-turnover cells while either period carries
//     722 — in the row, in the current period's served memo only, or in
//     the prior's served memo only — or while a refused (null) prior memo
//     stands in for a zero;
//   · a 758 row whose figure is not the engine's 758 line painted with the
//     engine's prior (the committed pair's row carries 781 reversals);
//   · a prior cell printing anything but the engine column's `prior`;
//   · the line-item builder dropping the keys of its 758, 628, 766, 666,
//     net-financial, pre-tax and tax rows, or its total folding in a 767 a
//     period carries without the cells saying the definition differs.
//
// THE FIXTURES are the committed comparatives pair (a real GET /api/period
// body and its comparatives document, rebuilt from the committed corpus —
// see ratioTableByteMatch.test.tsx) and synthetic books. Every figure is
// read off the fixture or invented here; no client figure, name or code
// enters this file.
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";
import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { pickPLBuilder } from "@/lib/buildPlStatement";
import {
  PARITY_FLOOR,
  cellForRow,
  indexCells,
  type ComparativeColumnDto,
  type ComparativesResponse,
} from "@/lib/comparatives";
import type { ApiLineItem, PLStatement } from "@/lib/plStructure";
import type { Statements } from "@/lib/financialReport";

import pairJson from "./fixtures/comparatives/pair_served.json";
import priorBlocksJson from "./fixtures/comparatives/pair_prior_blocks.json";

interface Pair {
  current_body: { statements: Statements };
  comparatives: ComparativesResponse;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The two committed documents. The prior-blocks document carries no
 *  `current_body` — its `_current_body` records that it is the served
 *  pair's, asserted identical — and no `prior_statements` (`_trimmed`):
 *  the prior's 722 memo is ABSENT there, which the served contract reads
 *  as zero. */
const FIXTURES: Record<string, () => Pair> = {
  "the served pair": () => clone(pairJson) as unknown as Pair,
  "the prior-blocks pair (prior statements trimmed)": () => ({
    current_body: clone((pairJson as unknown as Pair).current_body),
    comparatives: clone((priorBlocksJson as { comparatives: unknown }).comparatives) as ComparativesResponse,
  }),
};

const COLUMNS = { prior: true, delta: true, deltaPct: true, share: true };

function renderPl(statements: Statements, doc: ComparativesResponse, lineItems: ApiLineItem[] = []) {
  const statement = pickPLBuilder(
    { lineItems, entity: "Entity", period: "Period", currency: "RON" },
    statements,
  );
  const view = renderWithProviders(
    <ComparativeProvider doc={doc} columns={COLUMNS} statement="PL" currency="RON">
      <PLStatementView statement={statement} hideGuide showFootnote={false} />
    </ComparativeProvider>,
  );
  return { statement, ...view };
}

/** Every rendered P&L row whose label starts with `label` (the account
 *  chip renders inside the label, after the text). */
function rowsByLabel(container: HTMLElement, label: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".pl-row")).filter((row) =>
    (row.querySelector(".pl-label")?.textContent ?? "").trim().startsWith(label),
  );
}

function cellsOf(container: HTMLElement, label: string): HTMLElement {
  const rows = rowsByLabel(container, label);
  expect(rows, `exactly one row labelled "${label}"`).toHaveLength(1);
  const cells = rows[0].querySelector<HTMLElement>(".cmp-cells");
  expect(cells, `the "${label}" row renders its comparative cells`).not.toBeNull();
  return cells!;
}

function column(doc: ComparativesResponse, key: string): ComparativeColumnDto {
  const c = doc.columns.find((x) => x.key === key);
  expect(c, `the engine serves ${key}`).toBeDefined();
  return c!;
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const digitsOf = (n: number) => Math.abs(n).toFixed(2).replace(/\D/g, "");

/** The prior cell prints the engine column's prior — and nothing else. */
function expectPriorCell(cells: HTMLElement, col: ComparativeColumnDto) {
  expect(cells.getAttribute("data-cmp")).toBe(col.status);
  expect(cells.getAttribute("data-cmp-key")).toBe(col.key);
  expect(typeof col.prior).toBe("number");
  expect(digits(cells.querySelector(".cmp-cell--prior")?.textContent)).toBe(digitsOf(col.prior as number));
}

function expectDefinitionDiffers(cells: HTMLElement, key: string) {
  expect(cells.getAttribute("data-cmp")).toBe("definition-differs");
  expect(cells.getAttribute("data-cmp-key")).toBe(key);
  expect(cells.querySelector(".cmp-cell--prior")).toBeNull();
  expect(digits(cells.textContent)).toBe("");
}

const TOTAL_REVENUE = "Total operating revenue";
const NET_TURNOVER = "Operating revenue (net turnover)";
const LINE_758 = "Other operating income (758)";
const TOTAL_758 = "Total other operating income";

beforeEach(() => {
  // Pro mode: Simple opens totals-first and hides every `item` row (the 758
  // line among them) behind "Show all lines".
  localStorage.setItem("cfo-view-mode-v1", "pro");
});

describe.each(Object.keys(FIXTURES))("the committed comparatives pair — %s", (name) => {
  const load = FIXTURES[name];

  it("'Total operating revenue' carries the prior's served net turnover: neither period carries 722", () => {
    const { current_body, comparatives: doc } = load();
    const st = current_body.statements;
    const revenue = column(doc, "pl.revenue");
    // The precondition, read off the fixture: the current total IS net
    // turnover (no 722 in the row, none in the served memo).
    expect(Math.abs((st.assembled_pl as Record<string, number>).capitalized_own_work_memo)).toBeLessThan(PARITY_FLOOR);
    const { container } = renderPl(st, doc);
    expectPriorCell(cellsOf(container, TOTAL_REVENUE), revenue);
    // The net-turnover line beside it carries the very same cells.
    expectPriorCell(cellsOf(container, NET_TURNOVER), revenue);
  });

  it("the 758 line and its subtotal are keyed to the engine's 758 line — and refused, because this row carries 781 reversals", () => {
    const { current_body, comparatives: doc } = load();
    const st = current_body.statements;
    const line758 = column(doc, "pl.other_operating_income");
    // The row shows the served other-operating-income bucket; on this book
    // it holds provision reversals (781) the engine's 758 line excludes.
    const rowAmount = st.incomeStatement.otherIncome as number;
    expect(Math.abs(rowAmount - (line758.current as number))).toBeGreaterThanOrEqual(PARITY_FLOOR);
    expect((st.assembled_pl as Record<string, number>).other_income_781_reversals).toBeGreaterThan(0);
    const { container } = renderPl(st, doc);
    expectDefinitionDiffers(cellsOf(container, LINE_758), "pl.other_operating_income");
    expectDefinitionDiffers(cellsOf(container, TOTAL_758), "pl.other_operating_income");
  });

  it("the 758 line and its subtotal carry the prior's served 758 figure when the row IS the engine's 758 line", () => {
    const { current_body, comparatives: doc } = load();
    const st = current_body.statements;
    const line758 = column(doc, "pl.other_operating_income");
    // The same pair, the current book's other operating income being all
    // account 758: the row's figure is then the engine's current figure.
    st.incomeStatement.otherIncome = line758.current as number;
    const { container } = renderPl(st, doc);
    expectPriorCell(cellsOf(container, LINE_758), line758);
    expectPriorCell(cellsOf(container, TOTAL_758), line758);
  });
});

// ── 722 on one side: the total's definition differs ──────────────────
describe("'Total operating revenue' beside a period that carries capitalized own work (722)", () => {
  const load = FIXTURES["the served pair"];
  const memo = (st: unknown) => (st as { assembled_pl: Record<string, unknown> }).assembled_pl;

  it("722 in the current row: definition differs, and the net-turnover line keeps its cells", () => {
    const { current_body, comparatives: doc } = load();
    const st = current_body.statements;
    (st.incomeStatement as { capitalizedOwnWork?: number }).capitalizedOwnWork = 1_234_567.89;
    memo(st).capitalized_own_work_memo = 1_234_567.89;
    const { container } = renderPl(st, doc);
    expectDefinitionDiffers(cellsOf(container, TOTAL_REVENUE), "pl.revenue");
    expectPriorCell(cellsOf(container, NET_TURNOVER), column(doc, "pl.revenue"));
  });

  it("722 only in the current period's served memo (no 722 line): definition differs although the total equals net turnover", () => {
    const { current_body, comparatives: doc } = load();
    const st = current_body.statements;
    memo(st).capitalized_own_work_memo = 250_000.5;
    const { container, statement } = renderPl(st, doc);
    // The row itself IS net turnover — only the definition guard can refuse it.
    expect(statement.sections[0].subtotalAmount).toBe(column(doc, "pl.revenue").current);
    expectDefinitionDiffers(cellsOf(container, TOTAL_REVENUE), "pl.revenue");
  });

  it("722 only in the prior period: definition differs — never the prior's net turnover under a total that includes 722", () => {
    const { current_body, comparatives: doc } = load();
    memo(doc.prior_statements).capitalized_own_work_memo = 98_765.43;
    const { container } = renderPl(current_body.statements, doc);
    expectDefinitionDiffers(cellsOf(container, TOTAL_REVENUE), "pl.revenue");
    expectPriorCell(cellsOf(container, NET_TURNOVER), column(doc, "pl.revenue"));
  });

  it("a prior memo the engine refused (null) is not a zero: definition differs", () => {
    const { current_body, comparatives: doc } = load();
    memo(doc.prior_statements).capitalized_own_work_memo = null;
    const { container } = renderPl(current_body.statements, doc);
    expectDefinitionDiffers(cellsOf(container, TOTAL_REVENUE), "pl.revenue");
  });

  it("a prior memo the document does not serve reads as zero, per the served contract", () => {
    const { current_body, comparatives: doc } = load();
    delete memo(doc.prior_statements).capitalized_own_work_memo;
    const { container } = renderPl(current_body.statements, doc);
    expectPriorCell(cellsOf(container, TOTAL_REVENUE), column(doc, "pl.revenue"));
  });
});

// ── The line-item builder: the same rows, keyed the same way ─────────
//
// A synthetic three/four-digit book whose operating costs sit on codes the
// line-item view names, so `pickPLBuilder` routes it to `buildPLStatement`.

const li = (code: string, bucket: string, amount: number): ApiLineItem => ({
  statement: "PL", bucket, ro_account_code: code, amount, is_derived: false,
});

const LEAF_BOOK: ApiLineItem[] = [
  li("706", "revenue", 5_000_000.0),
  li("611", "operatingExpenses", 400_000.0),
  li("628", "operatingExpenses", 300_000.0),
  li("641", "operatingExpenses", 1_000_000.0),
  li("6811", "depreciation", 20_000.0),
  li("758", "otherIncome", 50_000.0),
  li("766", "financialIncome", 10_000.0),
  li("666", "interestExpense", 20_000.0),
  li("691", "taxExpense", 100_000.0),
];

function leafStatements(servedPl: Record<string, unknown> = {}): Statements {
  return {
    companyName: "Synthetic SRL", currency: "RON", periodLabel: "2025-12-31",
    balanceSheet: {}, supplementary: {},
    incomeStatement: {
      revenue: 5_000_000.0, costOfGoodsSold: 0, operatingExpenses: 1_700_000.0,
      depreciationAmortization: 20_000.0, interestExpense: 20_000.0, otherIncome: 50_000.0,
      financialIncome: 10_000.0, financialExpense: 0, taxExpense: 100_000.0,
    },
    assembled_pl: {
      total_operating_expense: 1_720_000.0,
      capitalized_own_work_memo: 0, discounts_received: 0,
      ...servedPl,
    },
  } as unknown as Statements;
}

function leafColumn(key: string, current: number, prior: number) {
  return {
    key, statement: "PL" as const, label: key, unit: "money", requires: "synthetic",
    current, prior, delta: Math.round((current - prior) * 100) / 100,
    delta_pct: (current - prior) / Math.abs(prior),
    current_disclosure: "reported", prior_disclosure: "reported",
    status: "compared" as const, note: "",
  };
}

/** The engine's document for the leaf book: every current side IS the
 *  engine figure the matching row shows; the priors are invented. */
function leafDoc(priorServedPl: Record<string, unknown> = {}): ComparativesResponse {
  return {
    columns: [
      leafColumn("pl.revenue", 5_000_000.0, 4_000_000.0),
      leafColumn("pl.other_operating_income", 50_000.0, 40_000.0),
      leafColumn("pl.opex_third_party", 300_000.0, 250_000.0),
      leafColumn("pl.interest_income", 10_000.0, 8_000.0),
      leafColumn("pl.interest_expense", 20_000.0, 15_000.0),
      leafColumn("pl.net_financial_result", -10_000.0, -7_000.0),
      leafColumn("pl.pretax", 3_320_000.0, 2_000_000.0),
      leafColumn("pl.tax", 100_000.0, 90_000.0),
    ],
    common_size: [],
    prior_statements: {
      assembled_pl: { capitalized_own_work_memo: 0, discounts_received: 0, ...priorServedPl },
    },
  } as unknown as ComparativesResponse;
}

interface KeyedRow { key: string; amount: number | undefined; folds?: Readonly<Record<string, number | null>> }

/** Every keyed row of a built statement, as the view hands them to the guard. */
function keyedRows(statement: PLStatement): KeyedRow[] {
  const out: KeyedRow[] = [];
  for (const s of statement.sections) {
    for (const l of s.lines) if (l.bucket) out.push({ key: l.bucket, amount: l.amount });
    if (s.subtotalBucket) out.push({ key: s.subtotalBucket, amount: s.subtotalAmount, folds: s.subtotalFolds });
  }
  return out;
}

function outcomeOf(statement: PLStatement, doc: ComparativesResponse, key: string) {
  const rows = keyedRows(statement).filter((r) => r.key === key);
  expect(rows, `the line-item statement carries exactly one "${key}" row`).toHaveLength(1);
  const [row] = rows;
  return cellForRow(indexCells(doc), row.key, row.amount, {
    folds: row.folds,
    priorStatements: doc.prior_statements,
  });
}

describe("the line-item builder keys the same rows", () => {
  it("routes the synthetic book to the line-item builder", () => {
    const statement = pickPLBuilder({ lineItems: LEAF_BOOK }, leafStatements());
    // The aggregates builder's revenue row would be the net-turnover line.
    expect(statement.sections[0].lines.map((l) => l.accountCode)).toEqual(["706"]);
  });

  it.each([
    ["revenue", "pl.revenue"],
    ["otherOperatingIncome", "pl.other_operating_income"],
    ["otherOperatingIncomeTotal", "pl.other_operating_income"],
    ["opexThirdParty", "pl.opex_third_party"],
    ["interestIncome", "pl.interest_income"],
    ["interestExpense", "pl.interest_expense"],
    ["netFinancialResult", "pl.net_financial_result"],
    ["pretax", "pl.pretax"],
    ["taxExpense", "pl.tax"],
  ])("the %s row carries the engine's %s cells", (key, engineKey) => {
    const statement = pickPLBuilder({ lineItems: LEAF_BOOK }, leafStatements());
    const out = outcomeOf(statement, leafDoc(), key);
    expect(out.kind).toBe("cell");
    if (out.kind === "cell") expect(out.cell.key).toBe(engineKey);
  });

  it("a prior that carries discounts received (767) — folded into this builder's total — refuses the total", () => {
    const statement = pickPLBuilder({ lineItems: LEAF_BOOK }, leafStatements());
    const out = outcomeOf(statement, leafDoc({ discounts_received: 12_345.67 }), "revenue");
    expect(out.kind).toBe("definition_differs");
  });

  it("a 767 the current period's served block carries but no exact-767 leaf shows refuses the total", () => {
    // A 7671 sub-account: the builder's exact-code table does not read it,
    // the engine does. The row still equals net turnover.
    const book = [...LEAF_BOOK, li("7671", "financialIncome", 5_000.0)];
    const statement = pickPLBuilder({ lineItems: book }, leafStatements({ discounts_received: 5_000.0 }));
    expect(statement.sections[0].subtotalAmount).toBe(5_000_000.0);
    expect(outcomeOf(statement, leafDoc(), "revenue").kind).toBe("definition_differs");
  });

  it("722 in the current leaves refuses the total", () => {
    const book = [...LEAF_BOOK, li("722", "capitalizedOwnWork", 80_000.0)];
    const statement = pickPLBuilder({ lineItems: book }, leafStatements({ capitalized_own_work_memo: 80_000.0 }));
    expect(outcomeOf(statement, leafDoc(), "revenue").kind).toBe("definition_differs");
  });

  it("the parity guard still refuses a keyed row whose figure is not the engine's", () => {
    const doc = leafDoc();
    doc.columns[1] = leafColumn("pl.other_operating_income", 50_000.01, 40_000.0);
    const statement = pickPLBuilder({ lineItems: LEAF_BOOK }, leafStatements());
    expect(outcomeOf(statement, doc, "otherOperatingIncome").kind).toBe("definition_differs");
    expect(outcomeOf(statement, doc, "otherOperatingIncomeTotal").kind).toBe("definition_differs");
  });
});
