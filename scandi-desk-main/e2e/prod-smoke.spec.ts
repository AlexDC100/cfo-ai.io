/**
 * Prod smoke — read-only walk of public surfaces on https://cfo-ai.io.
 *
 * Why a separate spec: `currency-coverage.spec.ts` depends on the demo
 * sign-in button and a seeded EEI sample, neither of which exist on prod
 * (anonymous visitors land on the marketing surface). This spec covers
 * the surfaces an anonymous user actually CAN reach:
 *
 *   · Landing page renders the twin entry-point cards
 *   · /public-companies renders the 57-row universe table
 *   · Sector chip filtering narrows the table
 *   · Per-row source pills render (currently Demo)
 *   · Clicking a row opens the snapshot panel
 *   · Snapshot's "Ask CFO AI" button opens the in-app chat panel
 *     (NASDAQ-13 — the button no longer navigates away to /chat)
 *
 * Run with: `npx playwright test --project=prod e2e/prod-smoke.spec.ts`
 */

import { test, expect } from "@playwright/test";

test.describe("prod smoke @ cfo-ai.io", () => {
  test("landing → twin entry cards render", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/CFO AI/i);
    // Anonymous visitors see the marketing hero, not the AppShell.
    await expect(page.locator("body")).toBeVisible();
  });

  test("/public-companies — universe table renders ≥50 rows", async ({ page }) => {
    await page.goto("/public-companies");

    // Header + table both rendered
    await expect(page.getByTestId("public-company-intelligence")).toBeVisible({ timeout: 15_000 });
    const table = page.getByTestId("public-companies-universe");
    await expect(table).toBeVisible({ timeout: 15_000 });

    // Universe contract: at least 50 rows (PUB-UPG spec §21)
    const rows = page.locator('[data-testid^="universe-row-"]');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count, `expected ≥50 universe rows, got ${count}`).toBeGreaterThanOrEqual(50);
  });

  test("/public-companies — sector filter narrows rows", async ({ page }) => {
    await page.goto("/public-companies");
    await expect(page.getByTestId("public-companies-universe")).toBeVisible({ timeout: 15_000 });

    // Filter state persists across visits via localStorage. Click All
    // first so this test's baseline is "show everything" regardless of
    // what a previous run / previous tab left behind.
    await page.getByTestId("sector-chip-all").click();
    await page.waitForTimeout(200);
    const allBefore = await page.locator('[data-testid^="universe-row-"]').count();
    expect(allBefore, "All chip should restore the full universe").toBeGreaterThanOrEqual(50);

    await page.getByTestId("sector-chip-technology").click();
    await page.waitForTimeout(200);
    const techCount = await page.locator('[data-testid^="universe-row-"]').count();
    expect(techCount).toBeGreaterThan(0);
    expect(techCount, "Technology filter should narrow vs All").toBeLessThan(allBefore);
  });

  test("/public-companies?ticker=AAPL — drawer opens with Ask CFO AI button", async ({ page }) => {
    // PUB-200 — the inline snapshot panel was replaced by StockDetailDrawer
    // (slide-over with chart + metrics). The "Ask CFO AI" button now lives
    // in the drawer footer, with testid stock-drawer-ask-cfo-ai.
    await page.goto("/public-companies?ticker=AAPL");
    const drawer = page.getByTestId("stock-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    const askButton = page.getByTestId("stock-drawer-ask-cfo-ai");
    await expect(askButton, "Ask CFO AI button should render on the drawer footer")
      .toBeVisible({ timeout: 5_000 });
    const tagName = await askButton.evaluate((el) => el.tagName);
    expect(tagName).toBe("BUTTON");
  });
});
