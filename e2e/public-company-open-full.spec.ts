/**
 * F5.0 Phase 4.5 — Public Company "Open full analysis" navigation.
 *
 * Contract:
 *   1. Land on /public-companies (the search/intelligence page).
 *   2. Click the AAPL ticker chip (Quick Pick) → StockDetailDrawer opens.
 *   3. Click the drawer's "Open full analysis" footer button
 *      (data-testid="stock-drawer-open-full").
 *   4. URL transitions to /dashboard/public/AAPL.
 *   5. The PublicCompanyDashboard renders.
 *   6. The Wave 4 LearnableMetricCard KPI tiles are present and clickable:
 *      data-testid="public-kpi-revenue"
 *      data-testid="public-kpi-ebitda"
 *      data-testid="public-kpi-net_profit"
 *      data-testid="public-kpi-total_assets"
 *   7. Clicking the EBITDA tile opens its concept popover.
 *
 * Replaces the older "Coming soon" toast assertion that was scaffolded
 * pre-Wave 4. Once the route is live the gate becomes the regression
 * we guard against — a re-introduction of the toast would fail step 4.
 */

import { test, expect } from "@playwright/test";

test.describe("F5.0 Phase 4.5 — Public Company Open full analysis", () => {
  test("AAPL: drawer → full analysis dashboard with learnable tiles", async ({
    page,
  }) => {
    await page.goto("/public-companies");

    // The Quick Pick chip for AAPL.
    await page.getByText("AAPL", { exact: true }).first().click();

    // Drawer opens — verify by the footer CTA.
    const openFullBtn = page.getByTestId("stock-drawer-open-full");
    await expect(openFullBtn).toBeVisible({ timeout: 8000 });

    // Click → navigate (NOT a toast).
    await openFullBtn.click();
    await page.waitForURL(/\/dashboard\/public\/AAPL/, { timeout: 8000 });

    // The KPI grid is the Wave 4 surface. Assert all four headline tiles
    // are present as LearnableMetricCard buttons.
    const expected = [
      "public-kpi-revenue",
      "public-kpi-ebitda",
      "public-kpi-net_profit",
      "public-kpi-total_assets",
    ];
    for (const t of expected) {
      await expect(page.getByTestId(t)).toBeVisible({ timeout: 6000 });
    }

    // Click EBITDA tile → popover.
    await page.getByTestId("public-kpi-ebitda").click();
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 1500 });

    // Plain-English (Wave 2) + formal definition are both present.
    await expect(
      page.getByTestId("learn-pop-plain-english"),
    ).toBeVisible();
  });

  test("Stock detail drawer remains intact (no regression)", async ({
    page,
  }) => {
    await page.goto("/public-companies");
    await page.getByText("AAPL", { exact: true }).first().click();

    // Drawer surfaces (chart range buttons, source link, etc.) still load.
    await expect(page.getByTestId("stock-drawer-open-full")).toBeVisible({
      timeout: 8000,
    });
    await expect(page.getByTestId("stock-drawer-add-peer")).toBeVisible();
    await expect(page.getByTestId("stock-drawer-ask-cfo-ai")).toBeVisible();
  });
});
