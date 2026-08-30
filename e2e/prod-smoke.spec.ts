/**
 * Smoke walk of the public surfaces — origin-agnostic.
 *
 * RETARGETED 2026-08-30 (Lane B). Written against the deleted
 * `public-companies-universe` table (`universe-row-*`, `sector-chip-*`);
 * §18 of CLAUDE.md replaced that surface with `MarketsOverview`'s
 * paginated `markets-company-grid`. Three of the 33 stale assertions
 * lived here.
 *
 * Deliberately NARROWER than e2e/public-companies-drawer.spec.ts. This
 * file is the "is the deploy alive" walk and must hold on any origin, so
 * it asserts only what is true of every one of them: the page mounts,
 * the grid hydrates, a sector pill filters, and the drawer opens for
 * whichever ticker the grid's own first tile names. It never names a
 * ticker, because which companies a given origin has cached is exactly
 * the thing that differs between prod and a local stack — the old
 * hard-coded AAPL is why this spec could only ever have been a prod
 * spec.
 *
 * Local:  node scripts/run_playwright_gate.mjs
 * Prod:   npx playwright test --project=prod e2e/prod-smoke.spec.ts
 */

import { test, expect } from "@playwright/test";

const TILE = '[data-testid^="company-grid-tile-"]';

test.describe("public surface smoke", () => {
  test("landing renders", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/CFO AI/i);
    await expect(page.locator("body")).toBeVisible();
  });

  test("/public-companies — the market grid hydrates", async ({ page }) => {
    await page.goto("/public-companies", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("public-company-intelligence"))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("markets-company-grid"))
      .toBeVisible({ timeout: 15_000 });

    const tiles = page.locator(TILE);
    await expect(tiles.first()).toBeVisible({ timeout: 15_000 });
    expect(await tiles.count(), "the grid must hydrate at least one page")
      .toBeGreaterThan(0);
  });

  test("/public-companies — a sector pill narrows the grid", async ({ page }) => {
    await page.goto("/public-companies", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("markets-company-grid"))
      .toBeVisible({ timeout: 15_000 });

    const tiles = page.locator(TILE);
    await expect(tiles.first()).toBeVisible({ timeout: 15_000 });
    const before = await tiles.count();

    // Take whichever sector pill the origin actually rendered rather than
    // naming one — the sector mix follows the cached universe.
    const pill = page.locator('[data-testid^="sector-tile-"]').first();
    await expect(pill).toBeVisible();
    await pill.click();
    await page.waitForTimeout(500);

    const after = await tiles.count();
    expect(after).toBeGreaterThan(0);
    expect(after, "a sector pill must narrow the grid").toBeLessThanOrEqual(before);
  });

  test("first grid tile opens the stock drawer with Ask CFO AI", async ({ page }) => {
    await page.goto("/public-companies", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("markets-company-grid"))
      .toBeVisible({ timeout: 15_000 });

    const first = page.locator(TILE).first();
    await expect(first).toBeVisible({ timeout: 15_000 });
    await first.click();

    const drawer = page.getByTestId("stock-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15_000 });

    const ask = page.getByTestId("stock-drawer-ask-cfo-ai");
    await expect(ask, "Ask CFO AI must render in the drawer footer")
      .toBeVisible({ timeout: 5_000 });
    expect(await ask.evaluate((el) => el.tagName)).toBe("BUTTON");
  });
});
