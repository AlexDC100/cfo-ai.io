// PRODUCTS — THE SKU FIGURE IS NOT THE COMPANY'S INVENTORY DAYS (owner spec
// 2026-09-26 P1, design B4 "namespaced exemptions").
//
// The Products working-capital panel used to show "DIO companie" (Σ SKU
// inventory ÷ Σ SKU COGS × 365, from the sales file) and then ADD it to the
// trial balance's DSO and DPO as the company's cash-conversion cycle — a
// second formula under the names DIO and CCC. Laws:
//   1. the SKU figure is labelled "Zile de rotație SKU" / "SKU turnover
//      days", never DIO;
//   2. the CCC on the panel is the trial balance's (computeRatios → the ONE
//      inventory-days block on the period-end balance), NOT SKU days + DSO
//      − DPO — measured here on a planted SKU figure that would move it;
//   3. with no period loaded the CCC prints why, never a number.

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { computeRatios, type Statements } from "@/lib/financialReport";

import pairJson from "@/lib/__tests__/fixtures/comparatives/pair_served.json";

type Period = { id: string | null; label: string | null; statements: Statements | null; metrics: { name: string; value: number | null }[] };
const current: { period: Period } = { period: { id: null, label: null, statements: null, metrics: [] } };

vi.mock("@/lib/activePeriod", async (orig) => ({
  ...(await orig<typeof import("@/lib/activePeriod")>()),
  useActivePeriod: () => current.period,
}));

const { WorkingCapitalRollup } = await import("@/pages/cfo/Products");
type Sku = Parameters<typeof WorkingCapitalRollup>[0]["skus"][number];

const pair = pairJson as unknown as { current_body: { statements: Statements & { periodLabel: string }; metrics: { name: string; value: number | null }[] } };

const sku = (id: string, inv: number, cogs: number): Sku => ({
  id, product_name: id, brand: null, category: null, volume_tons: 1, niv_krn: 100, gm_krn: 10, gm_pct: 0.1,
  real_margin_krn: null, real_margin_pct: null,
  days_inventory_on_hand: (inv / cogs) * 365, inventory_value_krn: inv, cogs_krn: cogs,
  classification: "anchor" as Sku["classification"], classification_reason: null, channels_present: null,
  clients_present: null, line_row_count: null, user_override: null,
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("the Products working-capital panel", () => {
  it("labels the SKU figure as SKU turnover days and takes CCC from the trial balance", () => {
    const statements = pair.current_body.statements;
    current.period = { id: "p1", label: "FY2025", statements, metrics: pair.current_body.metrics };
    // 200 SKU days — far from the company's inventory days, so a hybrid
    // CCC (SKU days + DSO − DPO) could not coincide with the served one.
    const skus = [sku("a", 200, 365), sku("b", 200, 365)];
    renderWithProviders(<WorkingCapitalRollup skus={skus} />);
    const skuCard = screen.getByTestId("wc-dio");
    expect(skuCard.textContent).toContain("SKU turnover days");
    expect(skuCard.textContent).not.toMatch(/\bDIO\b/);
    expect(skuCard.textContent).toContain("200");

    const metrics: Record<string, number | null> = {};
    for (const m of pair.current_body.metrics) metrics[m.name] = m.value;
    const r = computeRatios(statements, undefined, metrics);
    const ccc = r.efficiency.find((x) => x.key === "ccc")!.value as number;
    const dso = r.efficiency.find((x) => x.key === "dso")!.value as number;
    const dpo = r.efficiency.find((x) => x.key === "dpo")!.value as number;
    const hybrid = Math.round(200 + dso - dpo);
    expect(Math.round(ccc)).not.toBe(hybrid);
    const cccCard = screen.getByTestId("wc-ccc");
    expect(cccCard.getAttribute("data-available")).toBe("true");
    expect(cccCard.textContent).toContain(String(Math.round(ccc)));
    expect(cccCard.textContent).not.toContain(String(hybrid));
    expect(cccCard.textContent).toContain("inventory days (split by stock type, period-end balance)");
  });

  it("in Romanian the SKU figure is 'Zile de rotație SKU'", async () => {
    await i18n.changeLanguage("ro");
    current.period = { id: "p1", label: "FY2025", statements: pair.current_body.statements, metrics: pair.current_body.metrics };
    renderWithProviders(<WorkingCapitalRollup skus={[sku("a", 50, 365)]} />);
    expect(within(screen.getByTestId("wc-dio")).getByText("Zile de rotație SKU")).toBeTruthy();
  });

  it("with no trial balance the CCC is not a number and says why", () => {
    current.period = { id: null, label: null, statements: null, metrics: [] };
    renderWithProviders(<WorkingCapitalRollup skus={[sku("a", 50, 365)]} />);
    const cccCard = screen.getByTestId("wc-ccc");
    expect(cccCard.getAttribute("data-available")).toBe("false");
    expect(cccCard.textContent).toContain("no trial balance in this session");
  });
});
