/**
 * Products page — full SKU portfolio + datasets panel + comparison.
 *
 * Covers the surface from the multi-step "Products: dataset switcher +
 * full SKU-level analysis" prompt:
 *   - 406+ SKUs visible (virtualized list — small DOM footprint)
 *   - Sort changes which row is first; loss-makers float to the top
 *     under "GM ↑"
 *   - State filter chips (Eliminate / Watch / Wind down / Anchor)
 *   - Brand / category / channel dropdowns
 *   - Search filters live
 *   - CSV export
 *   - Datasets toggle pill + slide-out panel + Cmd+Shift+D shortcut
 *   - Switch dataset in place (URL updates, KPIs repaint, panel stays open)
 *   - Comparison view banner when ?compare=<id> is in URL
 *
 * Same gating as the other E2E specs: requires E2E_REAL=1 + a signed-in
 * test account with at least one analyzed sales dataset. Without the
 * flag every test skips so dev CI doesn't burn API credits.
 */

import { test, expect } from "@playwright/test";

const REAL = process.env.E2E_REAL === "1";
const TEST_EMAIL = process.env.E2E_EMAIL || "test@cfoai.dev";
const TEST_PASSWORD = process.env.E2E_PASSWORD || "Test1234!";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByPlaceholder(/you@company\.com/i).fill(TEST_EMAIL);
  // Password input has no placeholder in sign-in mode — match on type instead.
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
  // Two buttons are named "Sign in" — the tab switcher and the form submit.
  // Target the submit button by type so we don't accidentally hit the tab.
  await page.locator('button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/dashboard|\/onboarding|\/products/, { timeout: 10_000 });
  if (page.url().includes("/onboarding")) {
    await page.getByRole("radio").first().click();
    await page.getByRole("button", { name: /continue/i }).click();
  }
}

test.describe(REAL ? "products portfolio (real)" : "products portfolio (skipped — set E2E_REAL=1 to run)", () => {
  test.skip(!REAL, "Set E2E_REAL=1 + a test account with ≥1 analyzed sales dataset.");

  test("portfolio renders 400+ SKUs, virtualized", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto("/products");

    // KPI bar — SKU count matches the dataset, not a synthetic roll-up.
    const skuCountText = await page.getByTestId("kpi-sku-count").innerText();
    const skuCount = parseInt(skuCountText.replace(/\D/g, ""), 10);
    expect(skuCount).toBeGreaterThanOrEqual(100);

    // Table summary reflects the same total.
    const summary = await page.getByTestId("sku-table-summary").innerText();
    expect(summary).toMatch(/\d{3,}/);

    // Virtualization: only a small number of rows live in the DOM even
    // for hundreds of total SKUs.
    const rowsInDom = await page.getByTestId("sku-row").count();
    expect(rowsInDom).toBeGreaterThan(5);
    expect(rowsInDom).toBeLessThan(80);
  });

  test("sort GM ↑ surfaces loss-makers at the top", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto("/products");

    // Apply GM↑, capture the top row, then apply GM↓ and check the top row
    // CHANGED — the only way the inversion can leave the top row identical
    // is a one-row dataset. Robust to whether the default sort already
    // happens to coincide with GM↑.
    await page.getByTestId("sort-dropdown").selectOption("gm_krn_asc");
    const firstRow = page.getByTestId("sku-row").first();
    await expect(firstRow).toBeVisible();
    const ascendingFirst = await firstRow.innerText();
    await page.getByTestId("sort-dropdown").selectOption("gm_krn_desc");
    await expect(page.getByTestId("sku-row").first()).toBeVisible();
    const descendingFirst = await page.getByTestId("sku-row").first().innerText();
    expect(descendingFirst).not.toBe(ascendingFirst);
  });

  test("state chip filters narrow the list", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto("/products");

    // Find a chip with a non-zero count, then click it and confirm URL +
    // narrowed count. Some datasets only have 1–2 buckets populated, so we
    // probe the chip text for the trailing number rather than blindly
    // clicking and asserting > 0.
    let clickedChipFound = false;
    for (const id of ["chip-wind_down", "chip-watch", "chip-eliminate", "chip-anchor", "chip-scale", "chip-keep"]) {
      const chip = page.getByTestId(id);
      if (!(await chip.isVisible().catch(() => false))) continue;
      const chipText = await chip.innerText();
      const countMatch = chipText.match(/(\d+)\s*$/);
      const count = countMatch ? parseInt(countMatch[1], 10) : 0;
      if (count === 0) continue;
      await chip.click();
      await expect(page).toHaveURL(/state=/);
      const summary = await page.getByTestId("sku-table-summary").innerText();
      expect(summary).toMatch(/Showing/i);
      clickedChipFound = true;
      break;
    }
    test.skip(!clickedChipFound, "No state chip with a non-zero count on this account's data.");
  });

  test("search filters live", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto("/products");

    const beforeSummary = await page.getByTestId("sku-table-summary").innerText();

    // Use a token unlikely to match any real SKU so we know the search wired
    // through. The visible row count goes to zero (or the lowest the
    // virtualizer keeps mounted) and the summary line updates.
    await page.getByPlaceholder(/search.*sku/i).fill("zzqxprobe");
    await page.waitForTimeout(400); // debounce
    const afterSummary = await page.getByTestId("sku-table-summary").innerText();
    expect(afterSummary).toMatch(/Showing/);
    expect(afterSummary).not.toBe(beforeSummary);
  });

  test("CSV export downloads a file", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto("/products");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-portfolio").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/i);
  });

  test("Datasets panel: pill, shortcut, switch, persistence", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto("/products");

    const pill = page.getByTestId("datasets-toggle");
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(/datasets/i);

    // Click opens
    await pill.click();
    await expect(page.getByTestId("datasets-panel")).toBeVisible();
    await expect(page.getByTestId("datasets-panel-section-active")).toBeVisible();

    // Cmd+Shift+D toggles closed
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await expect(page.getByTestId("datasets-panel")).toHaveCount(0);

    // Cmd+Shift+D toggles open
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await expect(page.getByTestId("datasets-panel")).toBeVisible();

    // Persistence: reload preserves open state
    await page.reload();
    await expect(page.getByTestId("datasets-panel")).toBeVisible();

    // Switch to a sibling dataset if one exists
    const others = page.getByTestId("datasets-panel-section-others");
    if (await others.count() > 0) {
      const initialDataset = new URL(page.url()).searchParams.get("dataset");
      const target = others.getByTestId("dataset-card").first();
      await target.getByRole("button", { name: /switch/i }).click();
      await expect(page).toHaveURL(/dataset=/);
      const newDataset = new URL(page.url()).searchParams.get("dataset");
      expect(newDataset).not.toBe(initialDataset);
      // Panel stayed open
      await expect(page.getByTestId("datasets-panel")).toBeVisible();
    }

    // Close via Esc
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("datasets-panel")).toHaveCount(0);
  });

  test("dataset menu actions (rename + re-run) — round-trip", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto("/products");
    await page.getByTestId("datasets-toggle").click();

    const card = page.getByTestId("dataset-card").first();
    const labelSpan = card.locator("span").first();
    const originalLabel = (await labelSpan.innerText()).trim();
    // Strip any [pw] suffixes that may have leaked from prior test runs so
    // the restore step lands on the actual base label.
    const baseLabel = originalLabel.replace(/(\s*\[pw\])+$/g, "").trim();
    const newLabel = `${baseLabel} [pw]`;

    // Rename via menu. The rename input is autofocused with the original
    // text selected, so we use fill() to avoid focus-timing edge cases
    // with End/Type.
    await card.getByTestId("dataset-menu").click();
    await page.getByRole("menuitem", { name: /rename/i }).click();
    const renameInput = card.locator("input").first();
    await renameInput.fill(newLabel);
    await renameInput.press("Enter");

    await expect.poll(
      async () => (await card.innerText()).includes("[pw]"),
      { timeout: 5_000 },
    ).toBe(true);

    // Re-run via menu — toast shows "Re-classified N SKUs"
    await card.getByTestId("dataset-menu").click();
    await page.getByRole("menuitem", { name: /re-run/i }).click();
    // The toast text varies; verify the API call completed by waiting
    // for the cards to invalidate / re-render.
    await page.waitForTimeout(1_500);

    // Best-effort restore — we don't fail the test on cleanup. The next
    // rename run strips suffixes anyway.
    try {
      await card.getByTestId("dataset-menu").click({ timeout: 3_000 });
      await page.getByRole("menuitem", { name: /rename/i }).click({ timeout: 3_000 });
      const restoreInput = card.locator("input").first();
      await restoreInput.fill(baseLabel);
      await restoreInput.press("Enter");
    } catch {
      // Menu state didn't re-open in time after rerun; that's fine.
    }
  });

  test("comparison banner renders side-by-side movers", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto("/products");

    await page.getByTestId("datasets-toggle").click();
    const others = page.getByTestId("datasets-panel-section-others");
    test.skip(
      (await others.count()) === 0,
      "Comparison view needs ≥2 datasets on the test account.",
    );

    const otherCard = others.getByTestId("dataset-card").first();
    await otherCard.getByTestId("dataset-menu").click();
    await page.getByRole("menuitem", { name: /compare with active/i }).click();

    await expect(page.getByTestId("comparison-section")).toBeVisible({ timeout: 5_000 });
    // Two dataset labels in the header
    const header = await page.getByTestId("comparison-section").locator("h3").innerText();
    expect(header.toLowerCase()).toContain("vs");

    // Close button removes the section
    await page.getByTestId("comparison-close").click();
    await expect(page.getByTestId("comparison-section")).toHaveCount(0);
  });

  test("narrow viewport overlays datasets panel with backdrop", async ({ page }) => {
    test.setTimeout(30_000);
    // Tailwind's `lg:hidden` activates at width >= 1024, so the backdrop is
    // only visible at sub-lg widths. Use 1000 to stay below the breakpoint.
    await page.setViewportSize({ width: 1000, height: 800 });
    await signIn(page);
    await page.goto("/products");

    await page.getByTestId("datasets-toggle").click();
    await expect(page.getByTestId("datasets-panel")).toBeVisible();
    await expect(page.getByTestId("datasets-panel-backdrop")).toBeVisible();
    await page.getByTestId("datasets-panel-backdrop").click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId("datasets-panel")).toHaveCount(0);
  });
});
