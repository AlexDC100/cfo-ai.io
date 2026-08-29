// TrustChip — the never-fake-trust gate for the header verdict chip.
//
// The chip may render ONLY when the active period carries a served
// canonical envelope; legacy/public-summary lanes and empty periods get
// nothing. Wording follows the served presenter (engine authority).

import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Statements } from "@/lib/financialReport";

// TrustChip reads the active period through this hook only — the mock is
// the period switchboard for every case below.
const mockPeriod = vi.hoisted(() => ({ current: { statements: null as unknown } }));
vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => mockPeriod.current,
}));

import { TrustChip } from "../TrustChip";

function canonicalStatements(overrides: Record<string, unknown> = {}): Statements {
  return {
    currency: "RON",
    canonical_bs: {
      schema: "bs_v2",
      mapping_version: "ro-coa-1",
      rows: [],
      sections: [],
      totals: {
        assets: 100,
        equity: 60,
        liabilities: 40,
        equity_plus_liabilities: 100,
        current_assets: 50,
        current_liabilities: 20,
      },
      difference: 0,
      status: "BALANCED",
      ...overrides,
    },
  } as unknown as Statements;
}

afterEach(() => {
  cleanup();
  mockPeriod.current = { statements: null };
});

describe("<TrustChip> — render-nothing rule", () => {
  it("renders nothing with no statements at all", () => {
    mockPeriod.current = { statements: null };
    render(<TrustChip />);
    expect(screen.queryByTestId("trust-chip")).toBeNull();
  });

  it("renders nothing on a legacy (no canonical envelope) period", () => {
    // Minimal legacy shape — factsFrom's legacy branch always calls
    // deriveTotals, which reads these bucket fields.
    const zeroBs = {
      cash: 0, accountsReceivable: 0, inventory: 0, otherCurrentAssets: 0,
      propertyPlantEquipment: 0, intangibles: 0, otherNonCurrentAssets: 0,
      accountsPayable: 0, shortTermDebt: 0, otherCurrentLiabilities: 0,
      longTermDebt: 0, otherNonCurrentLiabilities: 0,
      shareCapital: 0, retainedEarnings: 0, otherEquity: 0,
    };
    const zeroIs = {
      revenue: 0, costOfGoodsSold: 0, otherIncome: 0, operatingExpenses: 0,
      depreciationAmortization: 0, interestExpense: 0, interestIncome: 0,
      otherFinancialResult: 0, taxExpense: 0,
    };
    mockPeriod.current = {
      statements: {
        currency: "RON",
        balanceSheet: zeroBs,
        incomeStatement: zeroIs,
        assembled_bs: { total_assets: 100, total_equity: 60, total_liabilities: 40 },
      } as unknown as Statements,
    };
    render(<TrustChip />);
    expect(screen.queryByTestId("trust-chip")).toBeNull();
  });
});

describe("<TrustChip> — served verdict wording", () => {
  it("BALANCED → success 'Balanced · machine-computed'", () => {
    mockPeriod.current = { statements: canonicalStatements() };
    render(<TrustChip />);
    expect(screen.getByTestId("trust-chip").textContent).toMatch(/machine-computed/);
    expect(screen.getByTestId("trust-chip").textContent).toMatch(/Balanced/);
  });

  it("BALANCED + AI-read extraction → accent 'AI-read · verified'", () => {
    mockPeriod.current = {
      statements: canonicalStatements({
        extraction: {
          method: "llm",
          parser_version: "p1",
          source_format: "xlsx",
          number_locale: "ro",
        },
      }),
    };
    render(<TrustChip />);
    expect(screen.getByTestId("trust-chip").textContent).toMatch(/AI-read/);
    expect(screen.getByTestId("trust-chip").textContent).toMatch(/verified/);
  });

  it("mechanical_mapped extraction must NOT wear the AI-read badge", () => {
    mockPeriod.current = {
      statements: canonicalStatements({
        extraction: {
          method: "mechanical_mapped",
          parser_version: "p1",
          source_format: "xlsx",
          number_locale: "ro",
        },
      }),
    };
    render(<TrustChip />);
    expect(screen.getByTestId("trust-chip").textContent).not.toMatch(/AI-read/);
    expect(screen.getByTestId("trust-chip").textContent).toMatch(/machine-computed/);
  });

  it("RECONCILED → caution 'Reconciled · auto-adjusted' (never 'Balanced')", () => {
    mockPeriod.current = {
      statements: canonicalStatements({
        status: "RECONCILED",
        reconciliation: {
          original_difference: 5,
          applied_delta: 5,
          placement: "balance_sheet",
          origin: "deterministic",
        },
      }),
    };
    render(<TrustChip />);
    const text = screen.getByTestId("trust-chip").textContent ?? "";
    expect(text).toMatch(/auto-adjusted/);
    expect(text).not.toMatch(/Balanced/);
  });

  it("MATERIAL_IMBALANCE → alert with the presenter's wording", () => {
    mockPeriod.current = {
      statements: canonicalStatements({ status: "MATERIAL_IMBALANCE", difference: 12 }),
    };
    render(<TrustChip />);
    expect(screen.getByTestId("trust-chip").textContent).toMatch(/imbalance/i);
  });
});
