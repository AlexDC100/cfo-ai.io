// THE /report PAGE PRINTS THE ONE INVENTORY-DAYS SPLIT (owner spec
// 2026-09-26, inventory days; design B4). Section 5's DIO row carries the
// one name; under the ratio tables the served block's split — every leg with
// its accounts and days, alte stocuri, the basis — exactly as
// `printInventoryDays` prints it. No block, no panel. Mounted over the
// committed carniprod corpus fixture (the served shape), fetch stubbed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
import { printInventoryDays, readInventoryDaysSplit } from "@/lib/inventoryDays";

type Json = Record<string, unknown>;
const repoRoot = resolve(__dirname, "../../../..");
const FIXTURE = JSON.parse(
  readFileSync(resolve(repoRoot, "tests/engine/fixtures/firm/saga_10_col_carniprod.json"), "utf-8"),
) as { currency: string; period_end: string; statements: Json };

async function mount(statements: Json, metrics: Array<{ name: string; value: number | null }> = []) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      period: { id: "p-carniprod", period_end: FIXTURE.period_end, currency: FIXTURE.currency, source_document: null },
      statements: { companyName: "Carniprod", ...statements },
      metrics, alerts: [], recommendations: [],
    }),
  })));
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/report?period=p-carniprod"]}>
        <ComprehensiveReport />
      </MemoryRouter>
    </TooltipProvider>,
  );
  await screen.findByTestId("comprehensive-report");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/report — section 5 prints the served inventory-days split", () => {
  it("the panel carries every leg, alte stocuri and the basis, as printInventoryDays prints them", async () => {
    const statements = JSON.parse(JSON.stringify(FIXTURE.statements)) as Json;
    await mount(statements);
    const section = screen.getByTestId("report-section-5-ratios");
    expect(within(section).getByText("Inventory days (DIO)")).toBeTruthy();
    const panel = within(section).getByTestId("report-inventory-days");
    const printed = printInventoryDays(readInventoryDaysSplit(statements)!, "en");
    for (const r of [...printed.legs, ...(printed.other ? [printed.other] : []), printed.total]) {
      const row = panel.querySelector<HTMLElement>(`[data-inventory-leg="${r.key}"]`)!;
      expect(row, r.key).not.toBeNull();
      expect(row.querySelector('[data-col="days"]')!.textContent).toBe(r.days);
    }
    expect(within(panel).getByTestId("inventory-days-basis").textContent).toBe(printed.basis);
  });

  it("ONE quantization: the DIO row and the split's total print the same digits — the block's value_q", async () => {
    // The Ratios tile printed "30" while the split under it, the command
    // bar and the bank export printed "30,2": two strings for one figure.
    // The block now quantizes at the ratio table's days rule, and the
    // report's DIO row (the served metric = the block's total) prints the
    // same digits as the split's total row.
    const statements = JSON.parse(JSON.stringify(FIXTURE.statements)) as Json;
    const total = (statements.inventory_days as Json).total as Json;
    const q = total.value_q as string;
    expect(q).toMatch(/^\d+$/);
    await mount(statements, [{ name: "dio", value: total.value as number }]);
    const section = screen.getByTestId("report-section-5-ratios");
    const label = within(section).getByText("Inventory days (DIO)");
    const row = (label.closest("tr") ?? label.parentElement!) as HTMLElement;
    expect(row.textContent).toContain(`${q} d`);
    const printed = printInventoryDays(readInventoryDaysSplit(statements)!, "en");
    expect(printed.total.days).toBe(`${q} days`);
    const panelTotal = within(section).getByTestId("report-inventory-days")
      .querySelector<HTMLElement>('[data-inventory-leg="total"] [data-col="days"]')!;
    expect(panelTotal.textContent).toBe(`${q} days`);
  });

  it("no block, no panel", async () => {
    const statements = JSON.parse(JSON.stringify(FIXTURE.statements)) as Json;
    delete statements.inventory_days;
    await mount(statements);
    expect(screen.queryByTestId("report-inventory-days")).toBeNull();
  });
});
