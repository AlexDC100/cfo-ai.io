// IntroUnlockCallout — proves the one-time framing is enforced:
//   · price renders
//   · "Not a subscription" copy present
//   · "One-time · 7-day window" cadence chip
//   · NEVER renders "/month", "monthly", "renews", or "subscription"
//   · refuses to render if a malformed plan with recurring=true is passed
// Spec §6 hard rule: no recurring €0.99 anywhere.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { IntroUnlockCallout } from "../IntroUnlockCallout";
import type { PlanConfig } from "@/lib/pricingConfig";

const INTRO: PlanConfig = {
  key: "intro",
  display_name: "Intro unlock",
  blurb: "",
  price_eur: 0.99,
  recurring: false,
  requires_card: true,
  included_docs: 1,
  extra_doc_eur: null,
  chat_daily_cap: 5,
  chat_monthly_cap: 10,
  window_days: 7,
};

describe("IntroUnlockCallout", () => {
  it("renders the price and the 'Not a subscription' chip", () => {
    render(<IntroUnlockCallout plan={INTRO} onUnlock={vi.fn()} />);
    expect(screen.getByTestId("intro-price").textContent).toContain("0.99");
    expect(screen.getByTestId("intro-not-a-subscription").textContent).toBe(
      "Not a subscription.",
    );
  });

  it("renders 'One-time · 7-day window' cadence and never 'monthly' or '/month'", () => {
    const { container } = render(
      <IntroUnlockCallout plan={INTRO} onUnlock={vi.fn()} />,
    );
    const cadence = screen.getByTestId("intro-cadence").textContent ?? "";
    expect(cadence).toContain("One-time");
    expect(cadence).toContain("7-day window");

    const text = container.textContent ?? "";
    expect(text.toLowerCase()).not.toMatch(/\/month/);
    expect(text.toLowerCase()).not.toMatch(/per month/);
    expect(text.toLowerCase()).not.toMatch(/monthly/);
    expect(text.toLowerCase()).not.toMatch(/renews/);
    expect(text.toLowerCase()).not.toMatch(/subscription[^.]/);
    // "Not a subscription." IS allowed (it explicitly negates the framing).
    // The regex above rejects "subscription" only when NOT followed by ".".
  });

  it("fires onUnlock on CTA click", () => {
    const onUnlock = vi.fn();
    render(<IntroUnlockCallout plan={INTRO} onUnlock={onUnlock} />);
    fireEvent.click(screen.getByTestId("intro-unlock-cta"));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it("refuses to render if plan is misconfigured as recurring", () => {
    const broken: PlanConfig = { ...INTRO, recurring: true };
    // Silence the defensive console.error from the component
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <IntroUnlockCallout plan={broken} onUnlock={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
