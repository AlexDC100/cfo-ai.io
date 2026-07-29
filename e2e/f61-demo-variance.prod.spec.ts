/**
 * Prod verification @ cfo-ai.io for:
 *   · F6.1 — Meridian demo company + Snapshot/Trend toggle on the dashboard
 *   · Budget-vs-Actual removed from the sidebar; /dashboard/variance still works
 *
 * Run: npx playwright test --project=prod e2e/f61-demo-variance.prod.spec.ts
 */
import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 1366, height: 900 } }); // lg+ so the sidebar shows

test.describe("F6.1 demo + variance-nav removal @ cfo-ai.io", () => {
  test("dashboard greets with the Meridian demo + Snapshot/Trend toggle", async ({ page }) => {
    await page.goto("/dashboard");
    // Public surface defaults a bare URL to the demo period.
    await expect(page).toHaveURL(/period=demo-meridian/, { timeout: 20_000 });

    // Configurable dashboard renders.
    await expect(page.getByTestId("configurable-dashboard")).toBeVisible({ timeout: 20_000 });

    // Demo banner present (only shows for the demo period).
    await expect(page.getByTestId("demo-banner")).toBeVisible();

    // Snapshot/Trend toggle present and Trend ENABLED (demo has 5 years).
    const trendBtn = page.getByTestId("dashboard-view-trend");
    await expect(trendBtn).toBeVisible();
    await expect(trendBtn).toBeEnabled();

    // Switch to Trend → at least one sparkline trend block appears.
    await trendBtn.click();
    await expect(page.locator('[data-testid^="metric-trend-"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test("sidebar no longer has Budget vs Actual, but keeps Scenarios/Benchmark", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("sidebar-dashboard")).toBeVisible({ timeout: 20_000 });

    // The removed item.
    await expect(page.getByTestId("sidebar-variance")).toHaveCount(0);
    await expect(page.getByText("Budget vs Actual", { exact: true })).toHaveCount(0);

    // The Analysis group still has its siblings.
    await expect(page.getByTestId("sidebar-scenarios")).toBeVisible();
    await expect(page.getByTestId("sidebar-benchmark")).toBeVisible();
    await expect(page.getByTestId("sidebar-products")).toBeVisible();
  });

  test("/dashboard/variance route is NOT orphaned — still loads", async ({ page }) => {
    await page.goto("/dashboard/variance");
    // On the public surface the route auto-resolves to the demo period, so the
    // report page renders (H1 + budget-upload card) rather than the no-period
    // empty state. Either way the route is reachable — proving not orphaned.
    await expect(
      page.getByRole("heading", { name: "Budget vs Actual vs Last year" }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
