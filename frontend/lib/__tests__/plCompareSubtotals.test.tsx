// THE P&L ROWS THAT PRINTED "—" BESIDE A FIGURE THE ENGINE SERVES.
//
// THE INCIDENT (2026-09-26). "Compare with Dec 2025" on a Dec 2024 book: the
// prior, Δ, Δ % and share cells were filled on the net-turnover line, on
// EBITDA, cost of goods sold and operating expenses — and blank on the
// operating-revenue total, "Other operating income (758)" and "Total other
// operating income". The engine serves `pl.revenue` and
// `pl.other_operating_income` for both periods; the rows simply carried no
// key the comparatives map knew.
//
// THE ONE EBITDA (owner ruling 2026-09-26) REWROTE THIS FILE'S SECOND LAW.
// It used to hold "Total operating revenue" to net turnover PLUS own work
// capitalised (722) — and, on the line-item path, discounts received (767) —
// so the total could carry the net-turnover cells only while neither period
// carried either. Under the ruling the first subtotal IS net turnover
// (cifra de afaceri netă): 72x is an operating line of its own, outside
// turnover, and 767 is financial. So the total now carries `pl.revenue` on
// its own figure whatever either period holds of 72x or 767, the 72x row
// carries `pl.capitalized_own_work`, and the stock variation (711) row
// `pl.inventory_variation` — the prior side of each the PRIOR period's own
// measured figure. The new guard in their place: a row on the one EBITDA
// carries the engine's cells only while the prior's served block
// (`prior_statements.assembled_pl.ebitda_definition`) names the definition
// the current period is served on.
//
// THE PARITY GUARD STAYS. A row carries the engine's cells only when the
// number it shows IS the engine's current figure.
//
// WHAT THESE RED ON, with the module correct (TC-11):
//   · "Total net turnover", the 758 line or its subtotal carrying no engine
//     key again (the blank cells of the incident);
//   · 72x or 767 in either period refusing — or changing — the net-turnover
//     total's cells (the old fold law);
//   · the 72x or the 711 row carrying no engine cells, or a prior other than
//     the engine column's;
//   · a prior served under another EBITDA definition painted beside the
//     current EBITDA, EBIT or profit before tax;
//   · a prior the engine REFUSED printed as a number or a bare dash instead
//     of the word with the prior's own reason;
//   · a 758 row whose figure is not the engine's 758 line painted with the
//     engine's prior (the committed pair's row carries 781 reversals);
//   · the line-item builder dropping the keys of its 758, 628, 766, 666,
//     net-financial, pre-tax and tax rows.
//
// THE FIXTURES are the committed comparatives pair (a real GET /api/period
// body and its comparatives document, rebuilt from the committed corpus —
// see ratioTableByteMatch.test.tsx) and synthetic books. Every figure is
// read off the fixture or invented here; no client figure, name or code
// enters this file.
import { beforeEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";

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
      <PLStatementView statement={statement} hideGuide />
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

const TOTAL_REVENUE = "Total net turnover";
const NET_TURNOVER = "Net turnover";
const LINE_758 = "Other operating income";
const TOTAL_758 = "Total other operating income";

beforeEach(async () => {
  // Pro mode: Simple opens totals-first and hides every `item` row (the 758
  // line among them) behind "Show all lines".
  localStorage.setItem("cfo-view-mode-v1", "pro");
  await i18n.changeLanguage("en");
});

describe.each(Object.keys(FIXTURES))("the committed comparatives pair — %s", (name) => {
  const load = FIXTURES[name];

  it("'Total net turnover' carries the prior's served net turnover", () => {
    const { current_body, comparatives: doc } = load();
    const st = current_body.statements;
    const revenue = column(doc, "pl.revenue");
    const { container } = renderPl(st, doc);
    expectPriorCell(cellsOf(container, TOTAL_REVENUE), revenue);
    // The net-turnover line beside it carries the very same cells.
    expectPriorCell(cellsOf(container, NET_TURNOVER), revenue);
  });

  it("the 758 line and its subtotal are keyed to the engine's 758 line — carried where the row IS 758, refused where it holds a 781 reversal", () => {
    const { current_body, comparatives: doc } = load();
    const st = current_body.statements;
    const line758 = column(doc, "pl.other_operating_income");
    // Owner ruling R2 (2026-09-28): the 7812 / 7814 reversals left other
    // operating income for their own net-provisions line, so on this book
    // (whose only reversals were 7814) the served row IS the 758 leaves —
    // the engine's 758 line — and carries its cells.
    const pl = st.assembled_pl as Record<string, number>;
    expect(Math.abs(pl.other_operating_income - (line758.current as number))).toBeLessThan(PARITY_FLOOR);
    expect(pl.other_income_781_reversals).toBe(0);
    const served = renderPl(st, doc);
    expectPriorCell(cellsOf(served.container, LINE_758), line758);
    expectPriorCell(cellsOf(served.container, TOTAL_758), line758);
    served.unmount();
    // A reversal still inside EBITDA (an unruled 7813, say) makes the row
    // wider than the engine's 758 line: refused, never painted wrong.
    pl.other_operating_income = (line758.current as number) + 1_234.56;
    pl.other_income_781_reversals = 1_234.56;
    st.incomeStatement.otherIncome = pl.other_operating_income;
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
    // (The builder prints the SERVED other-operating-income line, and the
    // bucket mirror behind it: both are set.)
    st.incomeStatement.otherIncome = line758.current as number;
    (st.assembled_pl as Record<string, number>).other_operating_income = line758.current as number;
    const { container } = renderPl(st, doc);
    expectPriorCell(cellsOf(container, LINE_758), line758);
    expectPriorCell(cellsOf(container, TOTAL_758), line758);
  });
});

// ── 72x and 767: outside net turnover in both periods ────────────────
describe("'Total net turnover' beside a period that carries own work capitalised (72x)", () => {
  const load = FIXTURES["the served pair"];
  const apl = (st: unknown) => (st as { assembled_pl: Record<string, unknown> }).assembled_pl;
  const setServedCapitalized = (st: unknown, value: number) => {
    const block = apl(st);
    block.capitalized_own_work = {
      ...(block.capitalized_own_work as Record<string, unknown>),
      value,
      provenance: "72x_credit_turnover_closed_book",
    };
    block.capitalized_own_work_memo = value;
  };

  it("72x in the current period: the total keeps the net-turnover cells, the 72x row carries its own", () => {
    const { current_body, comparatives: doc } = load();
    const st = current_body.statements;
    setServedCapitalized(st, 1_234_567.89);
    const cap = doc.columns.find((c) => c.key === "pl.capitalized_own_work")!;
    Object.assign(cap, { current: 1_234_567.89, prior: 98_765.43, delta: 1_135_802.46, status: "compared" });
    const { container } = renderPl(st, doc);
    expectPriorCell(cellsOf(container, TOTAL_REVENUE), column(doc, "pl.revenue"));
    expectPriorCell(cellsOf(container, NET_TURNOVER), column(doc, "pl.revenue"));
    expectPriorCell(cellsOf(container, "Producția realizată pentru scopuri proprii"), column(doc, "pl.capitalized_own_work"));
  });

  it("72x only in the prior period: the net-turnover total is still net turnover on both sides", () => {
    const { current_body, comparatives: doc } = load();
    setServedCapitalized(doc.prior_statements, 98_765.43);
    const { container } = renderPl(current_body.statements, doc);
    expectPriorCell(cellsOf(container, TOTAL_REVENUE), column(doc, "pl.revenue"));
  });
});

// ── The stock variation (711) row and the one-EBITDA definition guard ──
describe("the stock variation and the rows on the one EBITDA", () => {
  const load = FIXTURES["the served pair"];
  const apl = (st: unknown) => (st as { assembled_pl: Record<string, unknown> }).assembled_pl;

  it("the 711 row carries the engine's pl.inventory_variation — the prior's own measured variation", () => {
    const { current_body, comparatives: doc } = load();
    const iv = column(doc, "pl.inventory_variation");
    // The precondition, read off the fixture: both periods are bridge books.
    expect(iv.status).toBe("compared");
    expect(typeof iv.prior).toBe("number");
    const { container } = renderPl(current_body.statements, doc);
    expectPriorCell(cellsOf(container, "Variația stocurilor de produse"), iv);
  });

  it("EBITDA, EBIT and profit before tax carry the engine's cells when both periods are on one definition", () => {
    const { current_body, comparatives: doc } = load();
    expect(apl(doc.prior_statements).ebitda_definition).toBe(apl(current_body.statements).ebitda_definition);
    const { container } = renderPl(current_body.statements, doc);
    for (const key of ["pl.ebitda", "pl.ebit", "pl.pretax"]) {
      const cells = container.querySelector(`[data-cmp-key="${key}"]`);
      expect(cells?.getAttribute("data-cmp"), key).toBe("compared");
    }
  });

  it("a prior served under another EBITDA definition is refused on every one-EBITDA row — and only there", () => {
    const { current_body, comparatives: doc } = load();
    apl(doc.prior_statements).ebitda_definition = "ebitda/2025:711-outside";
    const { container } = renderPl(current_body.statements, doc);
    for (const key of ["pl.ebitda", "pl.ebit", "pl.pretax", "pl.inventory_variation"]) {
      const cells = container.querySelector(`[data-cmp-key="${key}"]`);
      expect(cells?.getAttribute("data-cmp"), key).toBe("definition-differs");
      expect(digits(cells?.textContent), key).toBe("");
    }
    // Net turnover is the same line under either definition.
    expectPriorCell(cellsOf(container, TOTAL_REVENUE), column(doc, "pl.revenue"));
  });

  it("a prior with no definition stamp at all is refused the same way", () => {
    const { current_body, comparatives: doc } = load();
    delete apl(doc.prior_statements).ebitda_definition;
    const { container } = renderPl(current_body.statements, doc);
    expect(container.querySelector('[data-cmp-key="pl.ebitda"]')?.getAttribute("data-cmp")).toBe("definition-differs");
  });

  it("a prior the engine REFUSED is the word, titled with the prior's own reason in the reader's language", async () => {
    const { current_body, comparatives: doc } = load();
    const prior = apl(doc.prior_statements);
    const refusal = {
      code: "account_121_anchor_absent",
      text_ro: "balanța este închisă, iar contul 121 lipsește",
      text_en: "the trial balance is closed and account 121 is absent",
    };
    prior.ebitda_refusal = { ...refusal, source: "inventory_variation" };
    prior.inventory_variation = { ...(prior.inventory_variation as object), value: null, refusal };
    for (const key of ["pl.ebitda", "pl.inventory_variation"]) {
      Object.assign(doc.columns.find((c) => c.key === key)!, {
        prior: null, delta: null, delta_pct: null, status: "refused",
        note: "Dec 2024: " + refusal.text_en,
      });
    }
    for (const lang of ["en", "ro"] as const) {
      await i18n.changeLanguage(lang);
      const { container, unmount } = renderPl(current_body.statements, doc);
      for (const key of ["pl.ebitda", "pl.inventory_variation"]) {
        const cells = container.querySelector(`[data-cmp-key="${key}"]`)!;
        expect(cells.getAttribute("data-cmp"), key).toBe("refused");
        const word = cells.querySelector(".cmp-cell--word")!;
        expect(word.textContent, key).toBe(lang === "ro" ? "refuzat" : "refused");
        expect(word.getAttribute("title"), key).toBe(lang === "ro" ? refusal.text_ro : refusal.text_en);
        expect(cells.querySelector(".cmp-cell--prior"), key).toBeNull();
      }
      unmount();
    }
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
    // The served one-EBITDA block for the leaf book: net turnover 5,000,000
    // + other operating income 50,000 − costs 1,700,000 = EBITDA 3,350,000;
    // − D&A 20,000 = EBIT 3,330,000; − net financial 10,000 = PBT 3,320,000.
    assembled_pl: {
      revenue: 5_000_000.0, turnover: 5_000_000.0, other_operating_income: 50_000.0,
      cogs: 0, opex_total: 1_700_000.0, depreciation: 20_000.0,
      ebitda: 3_350_000.0, ebit: 3_330_000.0, net_financial_result: -10_000.0,
      interest_expense: 20_000.0, pretax: 3_320_000.0, tax: 100_000.0,
      ebitda_definition: DEFINITION,
      total_operating_expense: 1_720_000.0,
      capitalized_own_work_memo: 0, discounts_received: 0,
      ...servedPl,
    },
  } as unknown as Statements;
}

const DEFINITION = "ebitda/2026-09-26:711-72x-inside,767-financial";

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
      assembled_pl: {
        capitalized_own_work_memo: 0, discounts_received: 0, ebitda_definition: DEFINITION,
        ...priorServedPl,
      },
    },
  } as unknown as ComparativesResponse;
}

interface KeyedRow { key: string; amount: number | undefined }

/** Every keyed row of a built statement, as the view hands them to the guard. */
function keyedRows(statement: PLStatement): KeyedRow[] {
  const out: KeyedRow[] = [];
  for (const s of statement.sections) {
    for (const l of s.lines) if (l.bucket) out.push({ key: l.bucket, amount: l.amount });
    if (s.subtotalBucket) out.push({ key: s.subtotalBucket, amount: s.subtotalAmount });
  }
  return out;
}

function outcomeOf(statement: PLStatement, doc: ComparativesResponse, key: string) {
  const rows = keyedRows(statement).filter((r) => r.key === key);
  expect(rows, `the line-item statement carries exactly one "${key}" row`).toHaveLength(1);
  const [row] = rows;
  return cellForRow(indexCells(doc), row.key, row.amount, {
    currentDefinition: statement.served?.definition ?? null,
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

  it("767 is financial: a prior carrying discounts received leaves the net-turnover total on pl.revenue", () => {
    const statement = pickPLBuilder({ lineItems: LEAF_BOOK }, leafStatements());
    const out = outcomeOf(statement, leafDoc({ discounts_received: 12_345.67 }), "revenue");
    expect(out.kind).toBe("cell");
  });

  it("a 767 sub-account in the current leaves is a financial row, and the total stays net turnover", () => {
    const book = [...LEAF_BOOK, li("7671", "financialIncome", 5_000.0)];
    const statement = pickPLBuilder({ lineItems: book }, leafStatements({ discounts_received: 5_000.0 }));
    expect(statement.sections[0].subtotalAmount).toBe(5_000_000.0);
    expect(outcomeOf(statement, leafDoc(), "revenue").kind).toBe("cell");
    const financial = statement.sections.find((s) => s.role === "financialItems")!;
    expect(financial.lines.map((l) => l.accountCode)).toContain("767");
    expect(statement.sections[0].lines.map((l) => l.accountCode)).not.toContain("767");
  });

  it("72x in the current leaves is its own operating row, and the total stays net turnover", () => {
    const book = [...LEAF_BOOK, li("722", "capitalizedOwnWork", 80_000.0)];
    const statement = pickPLBuilder(
      { lineItems: book },
      leafStatements({ capitalized_own_work_memo: 80_000.0, ebitda: 3_430_000.0 }),
    );
    expect(outcomeOf(statement, leafDoc(), "revenue").kind).toBe("cell");
    const cap = statement.sections.find((s) => s.role === "capitalizedOwnWork")!;
    expect(cap.lines.map((l) => l.amount)).toEqual([80_000.0]);
    expect(statement.sections[0].lines.map((l) => l.accountCode)).toEqual(["706"]);
  });

  it("the parity guard still refuses a keyed row whose figure is not the engine's", () => {
    const doc = leafDoc();
    doc.columns[1] = leafColumn("pl.other_operating_income", 50_000.01, 40_000.0);
    const statement = pickPLBuilder({ lineItems: LEAF_BOOK }, leafStatements());
    expect(outcomeOf(statement, doc, "otherOperatingIncome").kind).toBe("definition_differs");
    expect(outcomeOf(statement, doc, "otherOperatingIncomeTotal").kind).toBe("definition_differs");
  });
});
