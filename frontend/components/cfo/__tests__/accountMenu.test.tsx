// AccountMenu — proves the redesign contract:
//   · Renders header (name + email), plan status, usage preview, sections
//   · Sign-out appears EXACTLY once (testid `account-menu-sign-out`) —
//     the single source of truth per spec §10
//   · The theme row is GONE (dark-only app, 2026-07-25) — asserted below
//   · The "Coming soon" rows (Add workspace, Privacy) were dropped from
//     the menu per the operator directive — tests assert they are NOT
//     rendered, so re-adding them by accident fails CI.
//
// Tests render `AccountMenuContent` directly (the pure props component)
// to avoid depending on Radix DropdownMenu portal mounting under jsdom.
// The wiring (`AccountMenu` → `AccountMenuContent`) is checked by tsc
// and by the running app at integration time; this unit test owns the
// rendering contract.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

// Mounted through the shared helper, not a bare `render`. AccountMenuContent
// renders <CurrencyToggle />, which calls useCurrency() — and that hook throws
// on purpose when no <CurrencyProvider> is above it, to stop the app ever
// falling back to a silently-wrong currency. The helper supplies the same
// provider stack App.tsx does, so this file tests the component as it is
// actually mounted rather than in a context the app never creates.
import { renderWithProviders } from "@/test/renderWithProviders";

import { AccountMenuContent } from "../AccountMenu";
import type { PlanState } from "@/lib/planState";

const PLAN: PlanState = {
  plan_key: "pro",
  plan_display_name: "Pro",
  plan_price_eur: 39.99,
  plan_recurring: true,
  included_docs: 15,
  extra_doc_eur: 2.5,
  docs_used: 4,
  extra_docs_billed_this_period: 0,
  extra_docs_pending_this_period: 0,
  chat_used_today: 7,
  chat_daily_cap: 40,
  chat_used_this_period: 23,
  chat_monthly_cap: 200,
  window_expires_at: null,
  today: "2026-05-18",
  period_month: "2026-05",
};

function renderContent(overrides: Partial<React.ComponentProps<typeof AccountMenuContent>> = {}) {
  const defaults: React.ComponentProps<typeof AccountMenuContent> = {
    name: "Dumitru Alexandru",
    email: "alex@example.com",
    plan: PLAN,
    onNavigateSettings: vi.fn(),
    onNavigateBilling: vi.fn(),
    onSignOut: vi.fn(),
  };
  return renderWithProviders(<AccountMenuContent {...defaults} {...overrides} />);
}

describe("AccountMenu — single source of truth for sign-out", () => {
  it("renders the name + email header", () => {
    renderContent();
    expect(screen.getByTestId("account-menu-name").textContent).toContain(
      "Dumitru Alexandru",
    );
    expect(screen.getByTestId("account-menu-email").textContent).toContain(
      "alex@example.com",
    );
  });

  it("renders plan status with name + price + 'per month' cadence", () => {
    renderContent();
    expect(screen.getByTestId("account-menu-plan-name").textContent).toBe("Pro");
    const price = screen.getByTestId("account-menu-plan-price").textContent ?? "";
    expect(price).toContain("39.99");
    expect(price).toContain("/ mo");
  });

  it("renders 'one-time' cadence for non-recurring plans, never '/mo'", () => {
    renderContent({
      plan: {
        ...PLAN,
        plan_key: "intro",
        plan_display_name: "Intro unlock",
        plan_price_eur: 0.99,
        plan_recurring: false,
      },
    });
    const price = screen.getByTestId("account-menu-plan-price").textContent ?? "";
    expect(price).toContain("0.99");
    expect(price).toContain("one-time");
    expect(price).not.toContain("/ mo");
    expect(price.toLowerCase()).not.toContain("monthly");
  });

  it("renders the usage preview as token spend / allowance", () => {
    // The 2026-07-24 token-budget redesign shows tokens (via lib/tokenUsage),
    // not raw docs_used / included_docs. PLAN above derives to 123K / 575K.
    renderContent();
    expect(screen.getByTestId("account-menu-usage-count").textContent).toBe(
      "123K / 575K",
    );
  });

  it("contains EXACTLY ONE sign-out element (single source of truth)", () => {
    renderContent();
    expect(screen.queryAllByTestId("account-menu-sign-out")).toHaveLength(1);
  });

  it("renders Billing and Settings rows", () => {
    renderContent();
    expect(screen.getByTestId("account-menu-billing")).toBeTruthy();
    expect(screen.getByTestId("account-menu-settings")).toBeTruthy();
  });

  it("does NOT render the Privacy or Add workspace rows (operator directive)", () => {
    renderContent();
    expect(screen.queryByTestId("account-menu-privacy")).toBeNull();
    expect(screen.queryByTestId("account-menu-add-workspace")).toBeNull();
  });

  it("does NOT render the theme row (dark-only app)", () => {
    renderContent();
    expect(screen.queryByTestId("account-menu-theme")).toBeNull();
  });

  it("clicking sign-out fires the onSignOut handler", () => {
    const onSignOut = vi.fn();
    renderContent({ onSignOut });
    fireEvent.click(screen.getByTestId("account-menu-sign-out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("clicking Billing fires onNavigateBilling (which routes to /pricing in the wrapper)", () => {
    const onNavigateBilling = vi.fn();
    renderContent({ onNavigateBilling });
    fireEvent.click(screen.getByTestId("account-menu-billing"));
    expect(onNavigateBilling).toHaveBeenCalledTimes(1);
  });

});
