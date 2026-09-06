// AN ABSENT FIELD IS A GAP, NOT A ZERO WEARING A SOURCE — the report.
//
// TC-1: the envelope is `tests/engine/fixtures/firm/saga_10_col_carniprod
// .json` — a real SAGA export run through the engine, `statements`
// verbatim. The positive control renders it whole and counts the
// affordances in the three statement sections. The plant then removes
// four `assembled_pl` fields, one `assembled_bs` field, and replaces
// `assembled_cf` with `{}` — the shape the HU pack really serves
// (`src/engine/country_packs/hu_hungary/chart_of_accounts.py`) — and
// expects every affected row to paint "—" with NO affordance, and each
// section to lose EXACTLY the affordances of the rows removed — a
// per-component delta (TC-6), measured against the whole envelope in
// the same test, so a refusal-of-everything and a fabrication are both
// distinguishable from the fix. (A SERVED zero is a figure and keeps
// its card — the fixture carries real zeros; only a fallback zero is the
// defect.)
//
// Until 2026-09-04 twenty-three sites read `pl.cogs ?? 0` and handed the
// zero to a row whose origin named `assembled_pl.cogs`: 27 of 51
// affordances opened a Source over a zero the source did not contain
// (critic finding #1, ea6df1f).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
const stableToast = { toast: () => undefined };
vi.mock("@/hooks/use-toast", () => ({ useToast: () => stableToast }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: "p-carniprod", status: "resolved" }),
}));
vi.mock("@/components/learning/GuideMeButton", () => ({ GuideMeButton: () => null }));
vi.mock("@/components/learning/LearnableNumber", () => ({
  LearnableNumber: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/cfo/CreditScoreCard", () => ({
  CreditScoreCard: () => null,
  readCreditFromMetrics: () => null,
}));
vi.mock("@/components/cfo/RiskInventory", () => ({ RiskInventory: () => null }));
vi.mock("@/components/cfo/EbitdaReconciliationPanel", () => ({
  EbitdaReconciliationPanel: () => null,
}));

import ComprehensiveReport from "@/pages/cfo/ComprehensiveReport";

const repoRoot = resolve(__dirname, "../../../..");
const FIXTURE = JSON.parse(
  readFileSync(resolve(repoRoot, "tests/engine/fixtures/firm/saga_10_col_carniprod.json"), "utf-8"),
) as {
  currency: string;
  period_end: string;
  statements: {
    assembled_pl: Record<string, number>;
    assembled_bs: Record<string, number>;
    assembled_cf: Record<string, unknown>;
  };
};

type Statements = {
  assembled_pl: Record<string, number>;
  assembled_bs: Record<string, number>;
  assembled_cf: Record<string, unknown>;
};

function periodResponse(statements: Statements) {
  return {
    period: {
      id: "p-carniprod",
      period_end: FIXTURE.period_end,
      currency: FIXTURE.currency,
      source_document: { filename: "input.xlsx", id: "d1" },
    },
    statements: { companyName: "Carniprod", ...statements },
    metrics: [],
    alerts: [],
    recommendations: [],
  };
}

async function mount(statements: Statements) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => periodResponse(statements) })));
  const { container } = render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/report?period=p-carniprod"]}>
        <ComprehensiveReport />
      </MemoryRouter>
    </TooltipProvider>,
  );
  await screen.findByTestId("comprehensive-report");
  return container;
}

const affordances = (root: Element) =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-provenance="true"]'));

/** The amount cell of the table row whose first cell reads `label`. */
function amountCell(section: Element, label: string): HTMLTableCellElement {
  const row = Array.from(section.querySelectorAll("tr")).find(
    (tr) => tr.querySelector("td")?.textContent?.trim() === label,
  );
  if (!row) throw new Error(`no row labelled ${JSON.stringify(label)}`);
  const cells = row.querySelectorAll("td");
  return cells[1] as HTMLTableCellElement;
}

const DROPPED_PL = ["cogs", "opex_total", "depreciation", "tax"] as const;
const PL_ROWS: Record<(typeof DROPPED_PL)[number], string> = {
  cogs: "Cost of goods sold",
  opex_total: "Operating expenses",
  depreciation: "Depreciation & amortization",
  tax: "Income tax",
};

describe("ComprehensiveReport — the fixture", () => {
  it("carries the fields the plant removes, so the plant is not vacuous", () => {
    for (const k of DROPPED_PL) expect(typeof FIXTURE.statements.assembled_pl[k]).toBe("number");
    expect(typeof FIXTURE.statements.assembled_bs.inventory).toBe("number");
    expect(Object.keys(FIXTURE.statements.assembled_cf).length).toBeGreaterThan(10);
  });
});

describe("ComprehensiveReport — absent fields", () => {
  beforeEach(() => cleanup());
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  /** Affordance count per statement section. */
  function sectionCounts(): { pnl: number; bs: number; cf: number } {
    return {
      pnl: affordances(screen.getByTestId("report-section-2-pnl")).length,
      bs: affordances(screen.getByTestId("report-section-3-bs")).length,
      cf: affordances(screen.getByTestId("report-section-4-cf")).length,
    };
  }

  it("the whole envelope: every statement affordance wraps a figure (positive control)", async () => {
    const container = await mount(FIXTURE.statements);
    const pnl = screen.getByTestId("report-section-2-pnl");
    const counts = sectionCounts();
    // Floors per section (TC-6): a collapse in one cannot hide behind the sum.
    expect(counts.pnl, "P&L affordances").toBeGreaterThanOrEqual(10);
    expect(counts.bs, "BS affordances").toBeGreaterThanOrEqual(12);
    expect(counts.cf, "CF affordances").toBeGreaterThanOrEqual(15);
    for (const el of affordances(container)) {
      expect(el.textContent?.trim(), "an affordance wrapped the gap state").not.toBe("—");
    }
    // The dropped rows are present and figured, so the plant below has
    // something to remove.
    for (const k of DROPPED_PL) {
      const cell = amountCell(pnl, PL_ROWS[k]);
      expect(cell.textContent?.trim()).not.toBe("—");
      expect(affordances(cell).length).toBe(1);
    }
  });

  it("four P&L fields, one BS field and the whole cash flow absent: gap state, no card, exact delta", async () => {
    // The whole envelope first, in this test, so the delta is measured
    // rather than restated.
    await mount(FIXTURE.statements);
    const whole = sectionCounts();
    cleanup();
    vi.unstubAllGlobals();

    const pl = { ...FIXTURE.statements.assembled_pl };
    for (const k of DROPPED_PL) delete pl[k];
    const bs = { ...FIXTURE.statements.assembled_bs };
    delete bs.inventory;
    const container = await mount({ assembled_pl: pl, assembled_bs: bs, assembled_cf: {} });

    // EXACTLY the removed rows lost their cards, and nothing else did.
    const plant = sectionCounts();
    expect(plant.pnl, "P&L lost more or fewer cards than the four dropped rows").toBe(whole.pnl - DROPPED_PL.length);
    expect(plant.bs, "BS lost more or fewer cards than the one dropped row").toBe(whole.bs - 1);
    expect(plant.cf, "a cash-flow row wore a card over {}").toBe(0);

    // P&L: each dropped row paints the dash with no affordance.
    const pnl = screen.getByTestId("report-section-2-pnl");
    for (const k of DROPPED_PL) {
      const cell = amountCell(pnl, PL_ROWS[k]);
      expect(cell.textContent?.trim(), `${PL_ROWS[k]} should be the gap state`).toBe("—");
      expect(affordances(cell).length, `${PL_ROWS[k]} wore a card over a gap`).toBe(0);
    }
    // … while an untouched row still wears its card (the fix is not a
    // refusal of everything).
    const revenueCell = amountCell(pnl, "Net turnover");
    expect(revenueCell.textContent?.trim()).not.toBe("—");
    expect(affordances(revenueCell).length).toBe(1);

    // BS: the dropped field is a gap; its neighbours keep their cards.
    const bsSection = screen.getByTestId("report-section-3-bs");
    const inventory = amountCell(bsSection, "Inventory");
    expect(inventory.textContent?.trim()).toBe("—");
    expect(affordances(inventory).length).toBe(0);
    expect(affordances(amountCell(bsSection, "Cash")).length).toBe(1);

    // CF: `assembled_cf: {}` — the HU shape — every amount cell is the
    // gap state (the zero-affordance half is asserted above).
    const cf = screen.getByTestId("report-section-4-cf");
    const cfAmounts = Array.from(cf.querySelectorAll("tr")).map((tr) => tr.querySelectorAll("td")[1]);
    expect(cfAmounts.length).toBeGreaterThanOrEqual(20);
    for (const td of cfAmounts) expect(td?.textContent?.trim()).toBe("—");

    // And no affordance anywhere on the page wraps the gap state.
    for (const el of affordances(container)) {
      expect(el.textContent?.trim(), "an affordance wrapped the gap state").not.toBe("—");
    }
  });
});
