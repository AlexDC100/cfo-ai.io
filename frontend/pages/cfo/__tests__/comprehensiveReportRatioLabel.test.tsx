// The /report ratios table prints the interest-coverage row under the ONE
// label authority (ratioTable.ts `ratioLabelForKey`), so the basis — EBIT /
// interest — is stated beside the figure, as it is on the Ratios tab, the
// exports and the workbook (B8 repair round, medium: the row read a bare
// "Interest coverage" over a figure whose definition had been revised).
//
// REDS ON, AFTER THE REPAIR (TC-11): the row's name differing from the
// label authority's string; a row named without a basis; the row printing
// a figure other than the served `metrics[]` row.
// CANNOT SEE: whether the served row IS the EBIT figure — the engine's
// real-route gate (tests/engine/test_period_route_revised_rows.py) owns that.
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

import { ratioLabelForKey } from "@/lib/ratioTable";

async function mount(metrics: Array<{ name: string; value: number; unit: string }>) {
  const body = {
    period: { id: "p-carniprod", period_end: FIXTURE.period_end, currency: FIXTURE.currency,
      source_document: { filename: "input.xlsx", id: "d1" } },
    statements: { companyName: "Carniprod", ...FIXTURE.statements },
    metrics, alerts: [], recommendations: [],
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
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

describe("ComprehensiveReport — the interest-coverage row states its basis", () => {
  beforeEach(() => cleanup());
  afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

  it("is named by the label authority and prints the served row", async () => {
    const container = await mount([
      { name: "interest_coverage", value: 55.64, unit: "ratio" },
      { name: "ebitda_to_interest", value: 66.28, unit: "ratio" },
    ]);
    const want = ratioLabelForKey("interest_coverage");
    expect(want).toContain("EBIT / interest");
    const firstCells = Array.from(container.querySelectorAll("tr"))
      .map((tr) => [tr, tr.querySelector("td")?.textContent?.trim() ?? ""] as const);
    const named = firstCells.filter(([, txt]) => /interest coverage/i.test(txt));
    expect(named.map(([, txt]) => txt)).toEqual([want]);
    const row = named[0][0];
    expect(row.textContent).toContain("55.64");
    expect(row.textContent).not.toContain("66.28");
  });
});
