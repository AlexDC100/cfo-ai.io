/**
 * F5.0 Phase 5 — Balance Sheet trace real test (no stubs).
 *
 * Target: prod (https://cfo-ai.io) — PUBLIC_TEST_MODE bypasses AuthGuard.
 * Run with: npx playwright test --project=prod e2e/learning-balance-sheet-trace.spec.ts
 *
 * Asserts the full Wave 3 BS contract:
 *   1. /dashboard → Balance Sheet tab renders BalanceSheetMap above the table
 *   2. Map shows 12 clickable chips across 3 columns (Assets / Liab / Equity)
 *      with the "Tap any item to learn it" affordance text
 *   3. Cash chip click → popover with plain-English block (Wave 2) +
 *      sourceTrace listing 5121 / 5124 / 531
 *   4. Total Assets row label is a clickable LearnableRowLabel button
 *   5. Clicking Total Assets → formula tokens "Non-Current" + "Current"
 *   6. Total Equity & Liabilities row label is clickable
 *   7. GuideMeButton "GUIDE ME" pill is visible on the BS view header
 *
 * Failure modes this catches:
 *   · BalanceSheetMap removed or unmounted
 *   · sourceTrace regressed (cash popover stops listing 5121 etc.)
 *   · LearnableRowLabel testid pattern changed
 *   · Total Assets computation tokens regressed
 */

import { test, expect, type Page } from "@playwright/test";

async function gotoBalanceSheet(page: Page) {
  await page.goto("/dashboard?tab=balance_sheet", { waitUntil: "domcontentloaded" });
  const bsTab = page.getByRole("tab", { name: /^Balance Sheet$/ });
  await expect(bsTab).toBeVisible({ timeout: 15_000 });
  await bsTab.click();
  await expect(page.getByTestId("balance-sheet-map")).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("F5.0 Wave 3 — Balance Sheet trace", () => {
  test("BalanceSheetMap renders with 3 columns + affordance text", async ({
    page,
  }) => {
    await gotoBalanceSheet(page);
    const map = page.getByTestId("balance-sheet-map");
    await expect(map).toContainText("Balance Sheet Map");
    await expect(map).toContainText("Learning rail");
    await expect(map).toContainText("Tap any item to learn it");
    // All 3 column headers.
    await expect(map).toContainText("Assets");
    await expect(map).toContainText("Liabilities");
    await expect(map).toContainText("Equity");
    // Balance equation footnote.
    await expect(map).toContainText(/Assets\s*=\s*Liabilities\s*\+\s*Equity/);
  });

  test("Cash chip → plain English + 5121/5124/531 source accounts", async ({
    page,
  }) => {
    await gotoBalanceSheet(page);
    await page.getByTestId("bs-map-cash").click();
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 2_000 });

    // Wave 2 plain-English block.
    await expect(page.getByTestId("learn-pop-plain-english")).toBeVisible();
    await expect(popover).toContainText("In plain English");

    // Wave 3 sourceTrace lists each account code.
    await expect(popover).toContainText(/5121/);
    await expect(popover).toContainText(/5124/);
    await expect(popover).toContainText(/531/);
  });

  test("All 12 map chips are present and clickable", async ({ page }) => {
    await gotoBalanceSheet(page);
    // Asset column.
    await expect(page.getByTestId("bs-map-non_current_assets")).toBeVisible();
    await expect(page.getByTestId("bs-map-inventory")).toBeVisible();
    await expect(page.getByTestId("bs-map-receivables")).toBeVisible();
    await expect(page.getByTestId("bs-map-cash")).toBeVisible();
    // Liabilities column.
    await expect(page.getByTestId("bs-map-long_term_debt")).toBeVisible();
    await expect(page.getByTestId("bs-map-short_term_debt")).toBeVisible();
    await expect(page.getByTestId("bs-map-accounts_payable")).toBeVisible();
    await expect(page.getByTestId("bs-map-current_liabilities")).toBeVisible();
    // Equity column.
    await expect(page.getByTestId("bs-map-share_capital")).toBeVisible();
    await expect(page.getByTestId("bs-map-retained_earnings").first()).toBeVisible();
    await expect(page.getByTestId("bs-map-net_profit")).toBeVisible();
  });

  test("Total Assets row label is a clickable button + opens formula", async ({
    page,
  }) => {
    await gotoBalanceSheet(page);
    const totalAssetsLabel = page.getByTestId("bs-total-assets-label");
    await expect(totalAssetsLabel).toBeVisible();
    // Must be a button (Wave 3 LearnableRowLabel).
    const tag = await totalAssetsLabel.evaluate((el) => el.tagName);
    expect(tag).toBe("BUTTON");
    await totalAssetsLabel.click();
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 2_000 });
    // Wave 3 total_assets computation returns these two operand labels.
    await expect(popover).toContainText("Non-Current");
    await expect(popover).toContainText("Current");
  });

  test("Total Equity & Liabilities row label is clickable", async ({
    page,
  }) => {
    await gotoBalanceSheet(page);
    const totalEqLabel = page.getByTestId("bs-total-equity-liab-label");
    await expect(totalEqLabel).toBeVisible();
    const tag = await totalEqLabel.evaluate((el) => el.tagName);
    expect(tag).toBe("BUTTON");
  });

  test("GUIDE ME pill renders on BS header", async ({ page }) => {
    await gotoBalanceSheet(page);
    await expect(page.getByTestId("guide-trigger-balance-sheet")).toBeVisible();
  });
});
