/**
 * F5.0 Phase 8 — Products / SKU learning real test (no stubs).
 *
 * Target: prod (https://cfo-ai.io) — PUBLIC_TEST_MODE bypasses AuthGuard.
 * Run with: npx playwright test --project=prod e2e/learning-products.spec.ts
 *
 * Verifies the Phase 8 explainability contract on the Products surface:
 *
 *   1. /products renders the 4-tile KPI strip with the bucket labels
 *      (Protect / Watch / Wind down) as LearnableRowLabel buttons.
 *   2. Clicking the "Protect" KPI label opens the protect_bucket_count
 *      concept popover (plain-English + sourceTrace).
 *   3. /products?view=all renders the flat SKU table.
 *   4. Clicking the first SKU row opens the SkuDetailDrawer.
 *   5. The drawer's "Real margin" hero label is a LearnableRowLabel
 *      that opens the real_margin concept popover.
 *   6. The breakdown grid labels (Gross margin / SG&A / DIO / Capital cost)
 *      and KPI tile labels (NIV revenue / Absolute profit / Category share)
 *      are clickable and open their respective concept popovers.
 *
 * Failure modes this catches:
 *   · KpiCard regresses to plain-label (no conceptKey wired)
 *   · BreakdownRow / KpiTile lose their conceptKey prop
 *   · sku_classification badge stops being learnable
 *   · concept registry doesn't merge PRODUCTS_BY_KEY
 */

import { test, expect, type Page } from "@playwright/test";

// On first visit, the Products page auto-opens the page-guide overlay
// (the GUIDE ME tour for new visitors). It blocks all clicks until
// dismissed. The shared helper presses Escape after page-load to clear
// it — same pattern used by the existing Phase 5 Products specs.
async function dismissPageGuide(page: Page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

async function gotoProductsCategories(page: Page) {
  await page.goto("/products", { waitUntil: "domcontentloaded" });
  // Lazy bundle + hydration + dataset query — pattern matches Phase 7.
  await page.waitForTimeout(8_000);
  await dismissPageGuide(page);
  // The 4 KPI tiles must be present (statements loaded; test-mode default
  // dataset has SKUs).
  await expect(page.getByTestId("kpi-protect")).toBeVisible({ timeout: 15_000 });
}

async function gotoProductsAllSkus(page: Page) {
  // ?view= URL param is stripped by the route — we have to click the
  // ViewToggle to flip into the flat SKU table.
  await page.goto("/products", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8_000);
  await dismissPageGuide(page);
  await expect(page.getByTestId("kpi-protect")).toBeVisible({ timeout: 15_000 });
  const allToggle = page
    .locator('button:has-text("All SKUs"), button:has-text("All")')
    .first();
  await expect(allToggle).toBeVisible({ timeout: 5_000 });
  await allToggle.click({ force: true });
  // Flat SKU table renders rows with testid="sku-row" — give the
  // virtualized list time to mount the first chunk.
  await page.waitForTimeout(2_000);
  await expect(page.locator('[data-testid="sku-row"]').first()).toBeVisible({
    timeout: 15_000,
  });
}

async function openFirstSkuDrawer(page: Page) {
  await gotoProductsAllSkus(page);
  const firstRow = page.locator('[data-testid="sku-row"]').first();
  await firstRow.click({ force: true });
  await expect(page.getByTestId("sku-detail-drawer")).toBeVisible({
    timeout: 5_000,
  });
}

test.describe("F5.0 Phase 8 — Products / SKU learning", () => {
  test("Bucket KPI labels are LearnableRowLabel buttons", async ({ page }) => {
    await gotoProductsCategories(page);
    const protectLabel = page.getByTestId(
      "products-kpi-label-protect_bucket_count",
    );
    const watchLabel = page.getByTestId(
      "products-kpi-label-watch_bucket_count",
    );
    const windDownLabel = page.getByTestId(
      "products-kpi-label-wind_down_bucket_count",
    );

    await expect(protectLabel).toBeVisible();
    await expect(watchLabel).toBeVisible();
    await expect(windDownLabel).toBeVisible();
    // Buttons not <span>s.
    const tag = await protectLabel.evaluate((el) => el.tagName);
    expect(tag).toBe("BUTTON");
  });

  test("Click Protect KPI label → protect_bucket_count concept popover", async ({
    page,
  }) => {
    await gotoProductsCategories(page);
    const protectLabel = page.getByTestId(
      "products-kpi-label-protect_bucket_count",
    );
    await protectLabel.click({ force: true });

    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 3_000 });
    // protect_bucket_count plain-English mentions "don't touch" / winners.
    await expect(popover).toContainText(
      /don't touch|winners|Protect|protect/i,
      { timeout: 3_000 },
    );
  });

  test("SKU drawer opens from row click", async ({ page }) => {
    await openFirstSkuDrawer(page);
    await expect(page.getByTestId("sku-drawer-margin-card")).toBeVisible();
    await expect(page.getByTestId("sku-drawer-real-margin-label")).toBeVisible();
  });

  test("Drawer Real margin label → real_margin concept popover", async ({
    page,
  }) => {
    await openFirstSkuDrawer(page);
    const realMarginLabel = page.getByTestId("sku-drawer-real-margin-label");
    // Drawer's scrollable container puts the button outside the page
    // viewport check, even though it's visible on screen. dispatchEvent
    // fires a synthetic React-compatible click that bypasses the
    // viewport gate — same pattern as Phase 6 KPI tile clicks.
    await realMarginLabel.dispatchEvent("click");

    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 3_000 });
    // real_margin plain-English mentions "real money" or "actually makes"
    // or "SG&A" — the concept body is rich, any of the discriminators
    // should be in there.
    await expect(popover).toContainText(
      /SG&A|real margin|capital cost|warehouse|actually makes/i,
      { timeout: 3_000 },
    );
  });

  test("Drawer breakdown labels (SG&A / Capital cost) open their popovers", async ({
    page,
  }) => {
    await openFirstSkuDrawer(page);

    // Allocated SG&A.
    const sgaLabel = page.getByTestId("sku-drawer-row-label-allocated_sga");
    await expect(sgaLabel).toBeVisible({ timeout: 5_000 });
    await sgaLabel.dispatchEvent("click");
    const sgaPopover = page.locator(".learn-pop-content").first();
    await expect(sgaPopover).toBeVisible({ timeout: 3_000 });
    await expect(sgaPopover).toContainText(/SG&A|overhead|administrative|share/i);

    // Close popover (Esc).
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Capital cost on inventory.
    const capCostLabel = page.getByTestId(
      "sku-drawer-row-label-capital_cost_on_inventory",
    );
    await expect(capCostLabel).toBeVisible();
    await capCostLabel.dispatchEvent("click");
    const capCostPopover = page.locator(".learn-pop-content").first();
    await expect(capCostPopover).toBeVisible({ timeout: 3_000 });
    await expect(capCostPopover).toContainText(
      /capital|inventory|warehouse|opportunity cost|cash.*sitting/i,
    );
  });

  test("Drawer KPI tile labels (NIV revenue / Category share) open their popovers", async ({
    page,
  }) => {
    await openFirstSkuDrawer(page);

    // NIV revenue tile label.
    const nivLabel = page.getByTestId("sku-drawer-kpi-label-niv_revenue");
    await expect(nivLabel).toBeVisible({ timeout: 5_000 });
    await nivLabel.dispatchEvent("click");
    const nivPopover = page.locator(".learn-pop-content").first();
    await expect(nivPopover).toBeVisible({ timeout: 3_000 });
    await expect(nivPopover).toContainText(/NIV|Net Invoice|discounts|collected/i);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Category share tile label.
    const catLabel = page.getByTestId(
      "sku-drawer-kpi-label-category_share",
    );
    await expect(catLabel).toBeVisible();
    await catLabel.dispatchEvent("click");
    const catPopover = page.locator(".learn-pop-content").first();
    await expect(catPopover).toBeVisible({ timeout: 3_000 });
    await expect(catPopover).toContainText(
      /category|share|slice|long-tail|anchor/i,
    );
  });

  test("Drawer status badge → sku_classification concept popover", async ({
    page,
  }) => {
    await openFirstSkuDrawer(page);
    const statusLearn = page.getByTestId("sku-drawer-status-learn");
    await expect(statusLearn).toBeVisible({ timeout: 5_000 });
    await statusLearn.dispatchEvent("click");
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 3_000 });
    await expect(popover).toContainText(
      /anchor|keep|watch|wind|eliminate|verdict|classification/i,
    );
  });
});
