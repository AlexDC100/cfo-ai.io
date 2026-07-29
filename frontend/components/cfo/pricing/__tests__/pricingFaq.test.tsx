// PricingFaq — proves the 7 spec questions render and the answers stay
// honest about the intro plan being one-time + the chat being capped.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { PricingFaq } from "../PricingFaq";

describe("PricingFaq", () => {
  it("renders all 7 spec questions", () => {
    render(<PricingFaq />);
    const ids = [
      "faq-what-counts",
      "faq-quota-hit",
      "faq-intro-subscription",
      "faq-rollover",
      "faq-move-plans",
      "faq-chat-cap",
      "faq-billing-not-wired",
    ];
    for (const id of ids) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
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
  });

  it("never frames anything as recurring €0.99", () => {
    const { container } = render(<PricingFaq />);
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toMatch(/€0\.99\s*\/\s*month/);
    expect(text).not.toMatch(/0\.99\s*\/\s*month/);
    expect(text).not.toMatch(/\$0\.99\s*\/\s*month/);
  });
});
