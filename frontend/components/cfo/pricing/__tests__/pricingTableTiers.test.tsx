// PricingTableV2 — 2026-08 three-tier restructure render contract.
//
//   · Renders the three paid tiers from the server config (RO Solo 4.99 /
//     Pro 9.99 / Multi-Country 16.99), price-ascending.
//   · Pro is the visual hero (data-highlight="true"); the others are not.
//   · Retired `starter` NEVER renders a card, even when the backend still
//     returns it (purchasable: false) for legacy holders.
//   · The Multi card surfaces the non-RO inclusion.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { PricingTableV2 } from "../../PricingTableV2";
import {
  __clearPricingConfigForTest,
  __setPricingConfigForTest,
  type PlanConfig,
  type PricingPublicConfig,
} from "@/lib/pricingConfig";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ status: "signed_out", displayName: null, user: null }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function plan(p: Partial<PlanConfig> & { key: PlanConfig["key"] }): PlanConfig {
  return {
    display_name: p.key,
    blurb: "",
    price_eur: 0,
    recurring: false,
    requires_card: false,
    included_docs: 1,
    extra_doc_eur: null,
    chat_daily_cap: null,
    chat_monthly_cap: null,
    window_days: null,
    ...p,
  } as PlanConfig;
}

const CONFIG: PricingPublicConfig = {
  plans: [
    plan({ key: "trial" }),
    plan({ key: "intro", price_eur: 0.99, window_days: 7 }),
    plan({
      key: "solo",
      display_name: "RO Solo",
      price_eur: 4.99,
      recurring: true,
      purchasable: true,
      included_docs: 3,
      extra_doc_eur: 1.49,
      chat_daily_cap: 10,
      chat_monthly_cap: 50,
      max_workspaces: 1,
      allows_non_ro: false,
    }),
    plan({
      key: "pro",
      display_name: "Pro",
      price_eur: 9.99,
      recurring: true,
      purchasable: true,
      included_docs: 15,
      extra_doc_eur: 0.99,
      chat_daily_cap: 25,
      chat_monthly_cap: 150,
      max_workspaces: 5,
      allows_non_ro: false,
    }),
    plan({
      key: "multi",
      display_name: "Multi-Country",
      price_eur: 16.99,
      recurring: true,
      purchasable: true,
      included_docs: 15,
      extra_doc_eur: 0.99,
      chat_daily_cap: 40,
      chat_monthly_cap: 200,
      max_workspaces: 5,
      allows_non_ro: true,
      included_nonro_docs: 8,
      extra_nonro_doc_eur: 1.49,
    }),
    plan({ key: "starter", display_name: "Starter", price_eur: 14.99, recurring: true, purchasable: false }),
  ],
};

beforeEach(() => {
  cleanup();
  __setPricingConfigForTest(CONFIG);
});

afterEach(() => {
  cleanup();
  __clearPricingConfigForTest();
});

function renderTable() {
  return render(
    <MemoryRouter>
      <PricingTableV2 />
    </MemoryRouter>,
  );
}

describe("PricingTableV2 — three paid tiers", () => {
  it("renders solo, pro and multi cards; never starter", () => {
    renderTable();
    expect(screen.getByTestId("pricing-plan-solo")).toBeTruthy();
    expect(screen.getByTestId("pricing-plan-pro")).toBeTruthy();
    expect(screen.getByTestId("pricing-plan-multi")).toBeTruthy();
    expect(screen.queryByTestId("pricing-plan-starter")).toBeNull();
  });

  it("shows the spec prices from the config", () => {
    renderTable();
    expect(screen.getByTestId("pricing-plan-solo-price").textContent).toContain("4.99");
    expect(screen.getByTestId("pricing-plan-pro-price").textContent).toContain("9.99");
    expect(screen.getByTestId("pricing-plan-multi-price").textContent).toContain("16.99");
  });

  it("marks Pro as the hero tier and the others as not", () => {
    renderTable();
    expect(screen.getByTestId("pricing-plan-pro").getAttribute("data-highlight")).toBe("true");
    expect(screen.getByTestId("pricing-plan-solo").getAttribute("data-highlight")).toBe("false");
    expect(screen.getByTestId("pricing-plan-multi").getAttribute("data-highlight")).toBe("false");
  });

  it("second paid tier is named exactly 'Pro' (user directive)", () => {
    renderTable();
    const card = screen.getByTestId("pricing-plan-pro");
    const heading = card.querySelector("h3");
    expect(heading?.textContent).toBe("Pro");
  });

  // 2026-10-01 — this case used to assert that the Multi card "surfaces the
  // non-RO inclusion". No file from another country is analysed correctly
  // today (frontend/data/coverage.json, row other_countries), so the plan is
  // COMING SOON: shown, marked, and with no way to start a checkout.
  it("shows Multi-Country as coming soon: marked, not on sale, no checkout", () => {
    renderTable();
    const multi = screen.getByTestId("pricing-plan-multi");
    expect(multi.getAttribute("data-plan-state")).toBe("coming-soon");
    expect(screen.getByTestId("pricing-plan-multi-badge").textContent).toContain("Coming soon");
    expect(screen.getByTestId("pricing-plan-multi-blurb").textContent).toContain(
      "international coverage is not available yet",
    );
    // the backend's own blurb for the plan is not rendered
    expect(multi.textContent).not.toContain("non-Romanian");
    expect(multi.textContent?.toLowerCase()).not.toContain("non-ro");
    expect(multi.textContent).toContain("Not on sale yet");
    // no checkout CTA — a disabled label instead
    expect(screen.queryByTestId("pricing-plan-multi-cta")).toBeNull();
    const cta = screen.getByTestId("pricing-plan-multi-coming-soon") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    // the plans that ARE on sale keep their CTA
    expect(screen.getByTestId("pricing-plan-solo-cta")).toBeTruthy();
    expect(screen.getByTestId("pricing-plan-pro-cta")).toBeTruthy();
    expect(screen.getByTestId("pricing-plan-solo").getAttribute("data-plan-state")).toBe("on-sale");
  });

  it("an existing Multi-Country subscriber still sees it as their current plan", () => {
    render(
      <MemoryRouter>
        <PricingTableV2 currentPlanKey="multi" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("pricing-plan-multi-current")).toBeTruthy();
    expect(screen.queryByTestId("pricing-plan-multi-coming-soon")).toBeNull();
  });
});
