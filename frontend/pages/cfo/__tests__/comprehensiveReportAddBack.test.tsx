// GATE one-ebitda (owner ruling R2, 2026-09-28) — /report's cash-flow
// add-back row is named for what it sums.
//
// The report's §4 prints `assembled_cf.depreciation` — the cash-flow walk's
// non-cash add-back, all of 68x. Since R2 the P&L's `depreciation` leaves out
// the 6812 / 6814 provision charges (their net is its own P&L line), so on a
// book that posts them the row holding all of 68x is not "Depreciation &
// amortization" (deploy-readiness review of feat/rulings-2, 2026-09-29).
//
// LAW, on two firm books (real engine output): carniprod posts 6812 / 6814
// charges — the row reads "+ Depreciation, amortisation and provision charges
// (68x)" and its printed figure is the served add-back
// `assembled_cf.depreciation` (not the narrowed P&L D&A); realestate posts
// none — the row reads "+ Depreciation & amortization" and prints its one
// figure. The tab and the workbook are held by provisionsAddBack.test.tsx.
// REDS ON: the row named D&A over the figure holding the charges, or named
// for them on a book posting none; the row printing another figure than the
// served add-back (review 2026-10-01: the law checked the label only).
// CANNOT SEE: whether the served figures are right (provisions-symmetric);
// pixels.
import { afterEach, describe, expect, it, vi } from "vitest";
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
  useActivePeriodFallback: () => ({ periodId: "p-book", status: "resolved" }),
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

type Json = Record<string, unknown>;
const repoRoot = resolve(__dirname, "../../../..");
const book = (name: string) =>
  JSON.parse(
    readFileSync(resolve(repoRoot, `tests/engine/fixtures/firm/saga_10_col_${name}.json`), "utf-8"),
  ) as { currency: string; period_end: string; statements: Json };

async function mount(fx: ReturnType<typeof book>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      period: { id: "p-book", period_end: fx.period_end, currency: fx.currency, source_document: null },
      statements: { companyName: "Book", ...fx.statements },
      metrics: [], alerts: [], recommendations: [],
    }),
  })));
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/report?period=p-book"]}>
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

/** The first-cell labels of §4's rows, without the "~ " an approximated
 *  statement prefixes to each (both books are single-period captures). */
function cfLabels(): string[] {
  const section = screen.getByTestId("report-section-4-cf");
  return Array.from(section.querySelectorAll("tr"))
    .map((tr) => (tr.querySelector("td")?.textContent?.trim() ?? "").replace(/^~ /, ""))
    .filter(Boolean);
}

/** The printed figure of the §4 row whose first cell is `label`, as digits
 *  (the printer's separators and decimals dropped). */
function cfRowDigits(label: string): string {
  const section = screen.getByTestId("report-section-4-cf");
  const tr = Array.from(section.querySelectorAll("tr")).find(
    (r) => (r.querySelector("td")?.textContent?.trim() ?? "").replace(/^~ /, "") === label,
  );
  expect(tr, `the §4 row "${label}"`).toBeDefined();
  return (tr!.querySelectorAll("td")[1]?.textContent ?? "").replace(/\D/g, "");
}
/** The digits a served figure prints with, at the printer's precision. */
const printedDigits = (v: number, printed: string) =>
  (printed.length === Math.round(Math.abs(v)).toString().length
    ? Math.round(Math.abs(v)).toString()
    : Math.abs(v).toFixed(2).replace(/\D/g, ""));

const WITH = "+ Depreciation, amortisation and provision charges (68x)";
const PLAIN = "+ Depreciation & amortization";

describe("/report §4 — the add-back row is named for what it sums (R2)", () => {
  it("carniprod posts 6812 / 6814 charges: the row holding all of 68x names them", async () => {
    const fx = book("carniprod");
    const apl = fx.statements.assembled_pl as Json;
    const acf = fx.statements.assembled_cf as Json;
    // Non-vacuity: the two served figures differ by the served charges.
    const charges = ((apl.net_provisions as Json).charges as Json).value as number;
    expect(charges).toBeGreaterThan(1);
    expect(Math.abs((acf.depreciation as number) - (apl.depreciation as number) - charges)).toBeLessThan(0.005);
    await mount(fx);
    const labels = cfLabels();
    expect(labels).toContain(WITH);
    expect(labels).not.toContain(PLAIN);
    // The figure under the name: the served add-back, not the P&L's D&A.
    const printed = cfRowDigits(WITH);
    expect(printed, "the row prints assembled_cf.depreciation").toBe(printedDigits(acf.depreciation as number, printed));
    expect(printed, "and not the narrowed P&L D&A").not.toBe(printedDigits(apl.depreciation as number, printed));
  });

  it("realestate posts none: the row is plain D&A", async () => {
    const fx = book("realestate");
    const apl = fx.statements.assembled_pl as Json;
    const acf = fx.statements.assembled_cf as Json;
    expect(acf.depreciation).toBe(apl.depreciation);
    await mount(fx);
    const labels = cfLabels();
    expect(labels).toContain(PLAIN);
    expect(labels).not.toContain(WITH);
    const printed = cfRowDigits(PLAIN);
    expect(printed, "the row prints the one served figure").toBe(printedDigits(apl.depreciation as number, printed));
  });
});
