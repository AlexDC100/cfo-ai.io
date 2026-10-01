// PricingFaq — proves the questions render and the answers stay honest
// about the intro plan being one-time + the chat being capped. The seventh
// question ("What happens if billing is not wired yet?") was developer copy
// on a public page and was removed on 2026-10-02; what the answers may claim
// about coverage is the gate `public-claims` (the FAQ is a harvested surface).

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import "@/i18n";
import { PricingFaq } from "../PricingFaq";

describe("PricingFaq", () => {
  it("renders the six questions, and not the retired developer one", () => {
    render(<PricingFaq />);
    const ids = [
      "faq-what-counts",
      "faq-quota-hit",
      "faq-intro-subscription",
      "faq-rollover",
      "faq-move-plans",
      "faq-chat-cap",
    ];
    for (const id of ids) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.queryByTestId("faq-billing-not-wired")).toBeNull();
    // the answers are words, not raw dictionary keys
    expect(screen.getByTestId("pricing-faq").textContent).not.toMatch(/pricingFaq\./);
  });

  it("the intro-subscription answer says NO and frames it as one-time + 7-day", () => {
    // Spec §9 verbatim: "Is the €0.99 Intro Unlock a subscription? Answer:
    // No. It is a one-time 7-day unlock for one extra document." So we
    // assert: the answer opens with "No", uses "one-time", uses "7-day",
    // and never accidentally says "monthly" / "/month".
    render(<PricingFaq />);
    const item = screen.getByTestId("faq-intro-subscription");
    const text = item.textContent?.toLowerCase() ?? "";
    expect(text).toContain("no.");
    expect(text).toContain("one-time");
    expect(text).toContain("7-day");
    expect(text).not.toContain("monthly");
    expect(text).not.toMatch(/\/month/);
  });

  it("the chat-cap answer confirms caps exist", () => {
    render(<PricingFaq />);
    const item = screen.getByTestId("faq-chat-cap");
    expect(item.textContent?.toLowerCase()).toContain("capped");
    expect(item.textContent?.toLowerCase()).not.toContain("after launch");
  });

  it("the what-counts answer names trial balances and sends the rest to the AI reader", () => {
    render(<PricingFaq />);
    const text = screen.getByTestId("faq-what-counts").textContent ?? "";
    expect(text).toMatch(/Romanian trial balances/);
    expect(text).toMatch(/needs the AI reader, which is currently unavailable|needs the AI reader, which is available/);
    expect(text).not.toContain("{{");
  });

  it("never frames anything as recurring €0.99", () => {
    const { container } = render(<PricingFaq />);
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toMatch(/€0\.99\s*\/\s*month/);
    expect(text).not.toMatch(/0\.99\s*\/\s*month/);
    expect(text).not.toMatch(/\$0\.99\s*\/\s*month/);
  });
});
