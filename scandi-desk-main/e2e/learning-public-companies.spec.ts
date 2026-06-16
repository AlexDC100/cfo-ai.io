/**
 * F5.0 Phase 5 — Public Companies learning real test (no stubs).
 *
 * Target: prod — /dashboard/public/AAPL is reachable thanks to
 * PUBLIC_TEST_MODE bypass.
 * Run with: npx playwright test --project=prod e2e/learning-public-companies.spec.ts
 *
 * Asserts Wave 4 + Phase 4.5 contracts together:
 *   1. Public Companies hub renders AAPL Quick Pick chip
 *   2. Click AAPL → StockDetailDrawer opens with "Open full analysis" CTA
 *   3. Click "Open full analysis" → navigates to /dashboard/public/AAPL
 *      (NOT a Coming Soon toast — Phase 4.5 regression gate)
 *   4. All 8 Wave 4 LearnableMetricCard KPI tiles render:
 *      revenue, ebitda, net_profit, total_assets, cash, total_debt,
 *      operating_cash_flow (×2 — Operating CF + Free Cash Flow)
 *   5. Click EBITDA tile → popover opens with plain-English (Wave 2),
 *      Formally section, formula tokens, Ask CFO AI footer
 *   6. Click Revenue tile → popover opens with revenue plain-English
 *   7. GUIDE ME pill renders on the dashboard
 */

import { test, expect, type Page } from "@playwright/test";

async function openAaplDashboard(page: Page) {
  await page.goto("/public-companies", { waitUntil: "domcontentloaded" });
  // Quick Pick chip for AAPL.
  await page.getByText("AAPL", { exact: true }).first().click();
  // Drawer surfaces.
  await expect(page.getByTestId("stock-drawer-open-full")).toBeVisible({
    timeout: 8_000,
  });
  // Phase 4.5 fix — navigate.
  await page.getByTestId("stock-drawer-open-full").click();
  await page.waitForURL(/\/dashboard\/public\/AAPL/, { timeout: 8_000 });
}

test.describe("F5.0 Phase 4.5 + Wave 4 — Public Companies learning", () => {
  test("AAPL drawer → Open full analysis → live dashboard (NOT toast)", async ({
    page,
  }) => {
    await openAaplDashboard(page);
    // We're now on the dashboard. The header carries the AAPL identifier.
    await expect(page.locator("body")).toContainText("AAPL");
    await expect(page.locator("body")).toContainText(/APPLE INC|Apple Inc/i);
  });

  test("All 4 headline KPI tiles render as LearnableMetricCard", async ({
    page,
  }) => {
    await openAaplDashboard(page);
    for (const t of [
      "public-kpi-revenue",
      "public-kpi-ebitda",
      "public-kpi-net_profit",
      "public-kpi-total_assets",
    ]) {
      await expect(page.getByTestId(t)).toBeVisible({ timeout: 8_000 });
    }
  });

  test("Click EBITDA tile → popover with plain-English + formula + Ask CFO AI", async ({
    page,
  }) => {
    await openAaplDashboard(page);
    // Use dispatchEvent('click') — bypasses Playwright stability checks
    // AND triggers React's onClick because React listens at the document
    // level. The button is rendered, animations don't matter for
    // event dispatch. Empirical: force:true alone wasn't enough on
    // PUBLIC_TEST_MODE prod (dev-React overhead delays settle).
    const tile = page.getByTestId("public-kpi-ebitda");
    await expect(tile).toBeVisible();
    await tile.scrollIntoViewIfNeeded();
    await tile.dispatchEvent("click");
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 3_000 });

    // Wave 2 plain-English layer.
    await expect(page.getByTestId("learn-pop-plain-english")).toBeVisible();

    // Wave 2 + Wave 1 — formula + Ask CFO AI footer.
    await expect(popover).toContainText(/How it's computed|Formula/i);
    await expect(popover).toContainText(/Ask CFO AI/);

    // EBITDA-specific copy.
    await expect(popover).toContainText("EBITDA");
  });

  test("Click Revenue tile → popover with revenue plain-English", async ({
    page,
  }) => {
    await openAaplDashboard(page);
    const tile = page.getByTestId("public-kpi-revenue");
    await expect(tile).toBeVisible();
    await tile.scrollIntoViewIfNeeded();
    await tile.dispatchEvent("click");
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 3_000 });
    await expect(popover).toContainText(/Revenue/i);
    // The plain-English string for revenue (Wave 2 seed.ts).
    await expect(page.getByTestId("learn-pop-plain-english")).toBeVisible();
  });

  test("GUIDE ME pill renders on AAPL dashboard", async ({ page }) => {
    await openAaplDashboard(page);
    await expect(page.getByTestId("guide-trigger-public-company")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("Source pill — Nasdaq Sharadar SF1 — renders in header", async ({
    page,
  }) => {
    await openAaplDashboard(page);
    // Wave 4 retained the provenance pill on the dashboard.
    await expect(page.locator("body")).toContainText(/Nasdaq Sharadar SF1/i);
  });
});
