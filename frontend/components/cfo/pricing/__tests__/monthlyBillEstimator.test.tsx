// MonthlyBillEstimator — proves the slider math under the 2026-08 tier
// restructure (RO Solo / Pro / Multi-Country; starter retired):
//
//   · Only PURCHASABLE recurring plans render — trial/intro never, and
//     retired starter never, even when the config still lists it.
//   · Default state: docs=7 (over Solo's 3) → Solo shows 4 extras
//     × €1.49 = €5.96 on top of €4.99 = €10.95
//   · Pro shows base €9.99 with 0 extras at 7 docs (15 included)
//   · Sliding docs → 25 makes Pro show 10 extras × €0.99 = €9.90 on
//     top of €9.99 = €19.89
//
// All numbers come from the test PricingPublicConfig fixture; the
// component never hardcodes a price.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { MonthlyBillEstimator } from "../MonthlyBillEstimator";
import type { PlanConfig, PricingPublicConfig } from "@/lib/pricingConfig";

function makeConfig(): PricingPublicConfig {
  const solo: PlanConfig = {
    key: "solo",
    display_name: "RO Solo",
    blurb: "",
    price_eur: 4.99,
    recurring: true,
    requires_card: true,
    included_docs: 3,
    extra_doc_eur: 1.49,
    chat_daily_cap: 10,
    chat_monthly_cap: 50,
    window_days: null,
    purchasable: true,
    max_workspaces: 1,
  };
  const pro: PlanConfig = {
    key: "pro",
    display_name: "Pro",
    blurb: "",
    price_eur: 9.99,
    recurring: true,
    requires_card: true,
    included_docs: 15,
    extra_doc_eur: 0.99,
    chat_daily_cap: 25,
    chat_monthly_cap: 150,
    window_days: null,
    purchasable: true,
    max_workspaces: 5,
  };
  const starterRetired: PlanConfig = {
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
    purchasable: false,
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
  return { plans: [trial, starterRetired, solo, pro] };
}

describe("MonthlyBillEstimator", () => {
  it("shows only purchasable recurring plans (no trial/intro, no retired starter)", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    expect(screen.getByTestId("estimator-plan-solo")).toBeTruthy();
    expect(screen.getByTestId("estimator-plan-pro")).toBeTruthy();
    expect(screen.queryByTestId("estimator-plan-trial")).toBeNull();
    expect(screen.queryByTestId("estimator-plan-starter")).toBeNull();
  });

  it("computes Solo total at docs=7 → 4 extras × €1.49 + €4.99 = €10.95", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    const total = screen.getByTestId("estimator-solo-total").textContent ?? "";
    expect(total).toContain("10.95");
  });

  it("computes Pro total at docs=7 → 0 extras → €9.99", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    const total = screen.getByTestId("estimator-pro-total").textContent ?? "";
    expect(total).toContain("9.99");
  });

  it("recomputes when the docs slider moves to 25 → Pro 10 extras × €0.99 + €9.99 = €19.89", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    const slider = screen.getByTestId("estimator-docs-slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "25" } });
    const total = screen.getByTestId("estimator-pro-total").textContent ?? "";
    expect(total).toContain("19.89");
  });

  // 2026-09-06 — replaces "flags chat-over-cap when the chat slider exceeds
  // monthly cap". The chat dimension was removed: it never affected the
  // bill (chat is capped, not metered) and it invited a visitor to size a
  // plan around /chat, which the registry hides for this release. Reds if
  // a chat slider or a per-plan chat verdict comes back to the estimator.
  it("does not offer a chat dimension — no slider, no per-plan chat verdict", () => {
    render(<MonthlyBillEstimator config={makeConfig()} />);
    expect(screen.queryByTestId("estimator-chat-slider")).toBeNull();
    expect(screen.queryByTestId("estimator-solo-chat-verdict")).toBeNull();
    expect(screen.queryByTestId("estimator-pro-chat-verdict")).toBeNull();
    const card = screen.getByTestId("monthly-bill-estimator");
    expect(card.textContent?.toLowerCase()).not.toContain("ask cfo ai");
    expect(card.textContent?.toLowerCase()).not.toContain("fits cap");
  });
});
