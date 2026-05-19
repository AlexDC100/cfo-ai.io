// MonthlyBillEstimator — proves the slider math:
//
//   · Default state: docs=7 (over Starter's 5) → Starter shows 2 extras
//     × €3.00 = €6.00 on top of €14.99 = €20.99
//   · Pro shows base €39.99 with 0 extras at 7 docs (15 included)
//   · Sliding docs → 25 makes Pro show 10 extras × €2.50 = €25 on
//     top of €39.99 = €64.99
//
// All numbers come from the test PricingPublicConfig fixture; the
// component never hardcodes a price.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { MonthlyBillEstimator } from "../MonthlyBillEstimator";
import type { PlanConfig, PricingPublicConfig } from "@/lib/pricingConfig";

function makeConfig(): PricingPublicConfig {
  const starter: PlanConfig = {
    key: "starter",
    display_name: "Starter",
    blurb: "",
    price_eur: 14.99,
    recurring: true,
    requires_card: true,
    included_docs: 5,
    extra_doc_eur: 3.0,
    chat_daily_cap: 10,
    chat_monthly_cap: 50,
    window_days: null,
  };
  const pro: PlanConfig = {
    key: "pro",
    display_name: "Pro",
    blurb: "",
    price_eur: 39.99,
    recurring: true,
    requires_card: true,
    included_docs: 15,
    extra_doc_eur: 2.5,
    chat_daily_cap: 40,
    chat_monthly_cap: 200,
    window_days: null,
  };
  const trial: PlanConfig = {
    key: "trial",
    display_name: "Free trial",
    blurb: "",
    price_eur: 0,
    recurring: false,
    requires_card: false,
    included_docs: 1,
    extra_doc_eur: null,
    chat_daily_cap: 3,
    chat_monthly_cap: 5,
    window_days: 7,
  };
  return { plans: [trial, starter, pro] };
}

describe("MonthlyBillEstimator", () => {
  it("shows only recurring plans (no trial, no intro)", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    expect(screen.getByTestId("estimator-plan-starter")).toBeTruthy();
    expect(screen.getByTestId("estimator-plan-pro")).toBeTruthy();
    expect(screen.queryByTestId("estimator-plan-trial")).toBeNull();
  });

  it("computes Starter total at docs=7 → 2 extras × €3 + €14.99 = €20.99", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    const total = screen.getByTestId("estimator-starter-total").textContent ?? "";
    expect(total).toContain("20.99");
  });

  it("computes Pro total at docs=7 → 0 extras → €39.99", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    const total = screen.getByTestId("estimator-pro-total").textContent ?? "";
    expect(total).toContain("39.99");
  });

  it("recomputes when the docs slider moves to 25 → Pro 10 extras × €2.50 + €39.99 = €64.99", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    const slider = screen.getByTestId("estimator-docs-slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "25" } });
    const total = screen.getByTestId("estimator-pro-total").textContent ?? "";
    expect(total).toContain("64.99");
  });

  it("flags chat-over-cap when the chat slider exceeds monthly cap", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    const chat = screen.getByTestId("estimator-chat-slider") as HTMLInputElement;
    fireEvent.change(chat, { target: { value: "75" } });
    // Starter monthly cap = 50; 75 > 50 → flagged
    const starterVerdict = screen.getByTestId("estimator-starter-chat-verdict");
    expect(starterVerdict.textContent?.toLowerCase()).toContain("over cap");
    // Pro monthly cap = 200; 75 < 200 → fits
    const proVerdict = screen.getByTestId("estimator-pro-chat-verdict");
    expect(proVerdict.textContent?.toLowerCase()).toContain("fits cap");
  });
});
