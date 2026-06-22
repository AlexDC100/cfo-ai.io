// AccountMenu — proves the redesign contract:
//   · Renders header (name + email), plan status, usage preview, sections
//   · Sign-out appears EXACTLY once (testid `account-menu-sign-out`) —
//     the single source of truth per spec §10
//   · Theme toggle label flips with the current theme
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
import { render, screen, fireEvent } from "@testing-library/react";

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
    isDark: true,
    onNavigateSettings: vi.fn(),
    onNavigateBilling: vi.fn(),
    onToggleTheme: vi.fn(),
    onSignOut: vi.fn(),
  };
  return render(<AccountMenuContent {...defaults} {...overrides} />);
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

  it("renders the usage preview with docs_used / included_docs", () => {
    renderContent();
    expect(screen.getByTestId("account-menu-usage-count").textContent).toBe(
      "4 / 15",
    );
  });

  it("contains EXACTLY ONE sign-out element (single source of truth)", () => {
    renderContent();
    expect(screen.queryAllByTestId("account-menu-sign-out")).toHaveLength(1);
  });

  it("renders Billing, Settings, Theme rows", () => {
    renderContent();
    expect(screen.getByTestId("account-menu-billing")).toBeTruthy();
    expect(screen.getByTestId("account-menu-settings")).toBeTruthy();
  });

  it("does NOT render the Privacy or Add workspace rows (operator directive)", () => {
    renderContent();
    expect(screen.queryByTestId("account-menu-privacy")).toBeNull();
    expect(screen.queryByTestId("account-menu-add-workspace")).toBeNull();
  });

  it("theme toggle label flips between dark and light", () => {
    const { rerender } = renderContent({ isDark: true });
    expect(screen.getByTestId("account-menu-theme").textContent).toContain(
      "Switch to light",
    );
    rerender(
      <AccountMenuContent
        name="x"
        email="y@z"
        plan={PLAN}
        isDark={false}
        onNavigateSettings={() => {}}
        onNavigateBilling={() => {}}
        onToggleTheme={() => {}}
        onSignOut={() => {}}
      />,
    );
    expect(screen.getByTestId("account-menu-theme").textContent).toContain(
      "Switch to dark",
    );
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
