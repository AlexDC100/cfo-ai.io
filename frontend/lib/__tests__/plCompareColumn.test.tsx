// THE P&L COMPARE COLUMN PRINTS THE PRIOR'S SERVED FIGURE — on a condensed
// four-digit book beside a full-ledger six-digit one.
//
// THE INCIDENT (2026-09-23). "Compare with Dec 2025" on a Dec 2024 book
// printed operating revenue 2,727,103.68 under the label "Operating revenue
// (706/704/707 combined)" with a "706" chip, beside a current column of
// 426.7M. The figure was the engine's — the prior period slot held another
// company's book that day — but the row's label and chip were a hard-coded
// fiction: three families named on a row that was 99% account 701, and a
// chip the footnote read as "this company is a landlord".
//
// WHAT THESE RED ON, with the module correct (TC-11):
//   · the compare cell on a headline row printing anything but the engine
//     column's `prior` — a FE-built prior, a re-summed subset, a zero;
//   · the parity guard letting the prior render when the row's amount is
//     not the engine's current figure;
//   · an absent prior painted as a number instead of the word;
//   · the aggregates row's chip listing families the book does not hold,
//     or missing one it does, or the label calling a subset "combined";
//   · the column header losing the source-document title the engine serves.
//
// The book here is SYNTHETIC — four-digit codes shaped like a condensed
// external balanță — and every figure is invented. No client figure, name
// or code enters this file.
import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/renderWithProviders";
import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { pickPLBuilder, revenueFamiliesChip } from "@/lib/buildPlStatement";
import { PL_ROW_TO_KEY, type ComparativesResponse } from "@/lib/comparatives";
import type { ApiLineItem } from "@/lib/plStructure";
import type { Statements } from "@/lib/financialReport";
import en from "@/i18n/locales/en.json";

// ── A condensed four-digit book (synthetic) ───────────────────────────

const REVENUE = 987_654_321.09;
const COGS = 456_000_000.0;
const OPEX = 300_000_000.0;
const DNA = 20_000_000.0;
// Aggregates-path EBITDA: revenue − (cogs + opex) + other income (0 here).
const EBITDA = REVENUE - (COGS + OPEX);

const PRIOR_REVENUE = 876_543_210.98;
const PRIOR_EBITDA = 200_000_000.0;

const pl = (code: string, bucket: string, amount: number): ApiLineItem => ({
  statement: "PL", bucket, ro_account_code: code, amount, is_derived: false,
});

/** Four-digit codes only — a condensed external balanță. The revenue
 *  bucket spans five families (701 sales, 704 services, 706 rent, 707
 *  goods, 709 reductions); the opex codes are ones the line-item view's
 *  exact-match table does not name, so the book routes to the aggregates
 *  builder exactly as the real condensed book did. */
const LINE_ITEMS: ApiLineItem[] = [
  pl("7011", "revenue", 900_000_000.0),
  pl("7040", "revenue", 50_000_000.0),
  pl("7060", "revenue", 1_000_000.0),
  pl("7071", "revenue", 60_000_000.0),
  pl("7091", "revenue", -23_345_678.91),
  pl("6011", "cogs", COGS),
  pl("6411", "operatingExpenses", OPEX),
  pl("6811", "depreciation", DNA),
];

const STATEMENTS = {
  companyName: "Synthetic SRL",
  currency: "RON",
  periodLabel: "2024-12-31",
  balanceSheet: {},
  supplementary: {},
  incomeStatement: {
    revenue: REVENUE, costOfGoodsSold: COGS, operatingExpenses: OPEX,
    depreciationAmortization: DNA, interestExpense: 0, otherIncome: 0,
    financialIncome: 0, financialExpense: 0, taxExpense: 0,
  },
  assembled_pl: {
    revenue: REVENUE, cogs: COGS, opex_total: OPEX, depreciation: DNA,
    ebitda: EBITDA, total_operating_expense: COGS + OPEX + DNA,
  },
} as unknown as Statements;

function column(key: string, current: number | null, prior: number | null) {
  const compared = current !== null && prior !== null;
  return {
    key, statement: "PL" as const, label: key, unit: "money", requires: "synthetic",
    current, prior,
    delta: compared ? Math.round((current - prior) * 100) / 100 : null,
    delta_pct: compared && Math.abs(prior) >= 0.005 ? (current - prior) / Math.abs(prior) : null,
    current_disclosure: current === null ? "absent" : "reported",
    prior_disclosure: prior === null ? "absent" : "reported",
    status: compared ? ("compared" as const) : ("absent_prior" as const),
    note: "",
  };
}

/** The served document, as `compare_payloads` shapes it: the prior side
 *  of every column is the PRIOR PERIOD'S OWN assembled figure. */
function servedDoc(): ComparativesResponse {
  return {
    current: {
      period_id: "cur", period_end: "2024-12-31", period_start: "2024-01-01", currency: "RON",
      label: "Dec 2024", company_name: "Synthetic SRL",
      detail_level: { level: "synthetic", modal_depth: 4, reason: "", signals: {} },
      source_document: { id: "d1", filename: "balanta_2024_extern.xlsx", detected_type: "trial_balance" },
    },
    prior: {
      period_id: "pri", period_end: "2025-12-31", period_start: "2025-01-01", currency: "RON",
      label: "Dec 2025", company_name: "Synthetic SRL",
      detail_level: { level: "analytic", modal_depth: 6, reason: "", signals: {} },
      source_document: { id: "d2", filename: "balanta_2025_ledger.xls", detected_type: "trial_balance" },
    },
    comparability: {
      comparable: true, level: "synthetic", current_level: "synthetic", prior_level: "analytic",
      statement_lines: true, analytic_detail: false, reason: "",
    },
    coverage_source: { current: "line_items", prior: "line_items" },
    columns: [
      column("pl.revenue", REVENUE, PRIOR_REVENUE),
      column("pl.ebitda", EBITDA, PRIOR_EBITDA),
      // The prior book carries no cost-of-goods row: absent, not zero.
      column("pl.cogs", COGS, null),
    ],
    common_size: [],
    bridges: {} as ComparativesResponse["bridges"],
    movers: { materiality_floor: 0, bases: {}, top: [], improved: [], deteriorated: [], below_floor: 0 },
    prior_canonical_bs: null,
    prior_statements: {},
    prior_line_items: [],
    prior_metrics: [],
  };
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const digitsOf = (n: number) => n.toFixed(2).replace(/\D/g, "");

function renderPl(doc: ComparativesResponse) {
  const statement = pickPLBuilder(
    { lineItems: LINE_ITEMS, entity: "Synthetic SRL", period: "2024-12-31", currency: "RON" },
    STATEMENTS,
  );
  const view = renderWithProviders(
    <ComparativeProvider
      doc={doc}
      columns={{ prior: true, delta: true, deltaPct: true, share: true }}
      statement="PL"
      currency="RON"
    >
      <PLStatementView statement={statement} hideGuide />
    </ComparativeProvider>,
  );
  return { statement, ...view };
}

describe("P&L compare column — a four-digit book beside a six-digit one", () => {
  // Pro mode: Simple opens the statement totals-first and hides every
  // `item` row (the revenue line among them) behind "Show all lines".
  // The persisted key is written directly — the same contract
  // modeParityHarness uses — so no pref-sync side effect runs.
  beforeEach(() => {
    localStorage.setItem("cfo-view-mode-v1", "pro");
  });

  it("routes the condensed book to the aggregates builder and the revenue row to the engine's net-turnover line", () => {
    const { statement } = renderPl(servedDoc());
    const revenueRow = statement.sections[0].lines[0];
    expect(revenueRow.amount).toBe(REVENUE);
    expect(PL_ROW_TO_KEY[revenueRow.bucket as string]).toBe("pl.revenue");
  });

  it("prints the PRIOR'S served figure in the prior cell of the revenue and EBITDA rows", () => {
    const { container } = renderPl(servedDoc());
    const revenueCells = container.querySelector('[data-cmp-key="pl.revenue"]');
    expect(revenueCells).not.toBeNull();
    expect(revenueCells!.getAttribute("data-cmp")).toBe("compared");
    const priorCell = revenueCells!.querySelector(".cmp-cell--prior");
    expect(digits(priorCell?.textContent)).toBe(digitsOf(PRIOR_REVENUE));

    const ebitdaCells = container.querySelector('[data-cmp-key="pl.ebitda"]');
    expect(ebitdaCells).not.toBeNull();
    expect(digits(ebitdaCells!.querySelector(".cmp-cell--prior")?.textContent)).toBe(digitsOf(PRIOR_EBITDA));
  });

  it("the Δ is the engine's difference and the Δ % the engine's ratio, never a FE division", () => {
    const { container } = renderPl(servedDoc());
    const cells = container.querySelector('[data-cmp-key="pl.revenue"]')!;
    const spans = Array.from(cells.querySelectorAll(".cmp-cell"));
    expect(digits(spans[1].textContent)).toBe(digitsOf(REVENUE - PRIOR_REVENUE));
    const pct = ((REVENUE - PRIOR_REVENUE) / PRIOR_REVENUE) * 100;
    expect(spans[2].textContent).toBe(`+${pct.toFixed(1)}%`);
  });

  it("refuses the cell when the row's amount is not the engine's current figure", () => {
    const doc = servedDoc();
    // The engine's current side one cent away from the row the FE shows.
    doc.columns[0] = column("pl.revenue", REVENUE + 0.01, PRIOR_REVENUE);
    const { container } = renderPl(doc);
    const cells = container.querySelector('[data-cmp-key="pl.revenue"]');
    expect(cells?.getAttribute("data-cmp")).toBe("definition-differs");
    expect(cells?.querySelector(".cmp-cell--prior")).toBeNull();
    expect(digits(cells?.textContent)).toBe("");
  });

  it("an absent prior is the word, never a number", () => {
    const { container } = renderPl(servedDoc());
    const cogs = container.querySelector('[data-cmp-key="pl.cogs"]')!;
    expect(cogs.getAttribute("data-cmp")).toBe("absent_prior");
    expect(cogs.querySelector(".cmp-cell--prior")).toBeNull();
    expect(cogs.textContent).toContain(en.statements.cmp.new);
    expect(digits(cogs.textContent)).toBe("");
  });

  it("the revenue row's chip lists every family the book's revenue bucket holds and the label names no subset", () => {
    const { statement, container } = renderPl(servedDoc());
    const revenueRow = statement.sections[0].lines[0];
    expect(revenueRow.accountCode).toBe("701/704/706/707/709");
    expect(revenueRow.label.toLowerCase()).not.toContain("combined");
    expect(revenueRow.label).not.toMatch(/\d{3}\s*\/\s*\d{3}/);
    const row = container.querySelector(`[data-traceable-target="${revenueRow.bucket}"]`)!;
    expect(row.querySelector('[data-testid="account-chip"]')?.textContent).toBe("701/704/706/707/709");
    expect(row.textContent).not.toContain("combined");
  });

  it("the column headers carry the source document of each period as their title", () => {
    renderPl(servedDoc());
    expect(screen.getByTestId("cmp-col-current").getAttribute("title")).toBe("balanta_2024_extern.xlsx");
    expect(screen.getByTestId("cmp-col-prior").getAttribute("title")).toBe("balanta_2025_ledger.xls");
  });
});

describe("revenueFamiliesChip — read off the book, never hard-coded", () => {
  it("lists the three-digit families of the revenue bucket, sorted, separators stripped", () => {
    expect(revenueFamiliesChip(LINE_ITEMS)).toBe("701/704/706/707/709");
    expect(revenueFamiliesChip([pl("706.01", "revenue", 1), pl("706", "revenue", 2)])).toBe("706");
    expect(revenueFamiliesChip([pl("701101", "revenue", 1), pl("707103", "revenue", 2)])).toBe("701/707");
  });
  it("is the bucket itself when there are no leaves to read", () => {
    expect(revenueFamiliesChip([])).toBe("70x");
    expect(revenueFamiliesChip(undefined)).toBe("70x");
    expect(revenueFamiliesChip([pl("6011", "cogs", 1)])).toBe("70x");
  });
  it("ignores balance-sheet rows and rows outside the revenue bucket", () => {
    const bs = { ...pl("4111", "ar", 5), statement: "BS" as const };
    expect(revenueFamiliesChip([bs, pl("7581", "otherIncome", 3), pl("7011", "revenue", 1)])).toBe("701");
  });
});
