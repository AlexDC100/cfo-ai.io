/**
 * Public-companies grid + stock drawer walk.
 *
 * RETARGETED 2026-08-30 (Lane B, the dark-suite pass). This file was
 * written for "PUB-200" — a 200-row `public-companies-universe` TABLE
 * with `universe-row-<TICKER>` rows, a `universe-search-input`, and
 * `sector-chip-*` filters. Every one of those elements is gone: §18 of
 * CLAUDE.md rebuilt the surface as `MarketsOverview` — a paginated
 * 24-tile `markets-company-grid` of `company-grid-tile-<TICKER>` cards,
 * an `Explore` pill grid whose sector pills are `sector-tile-<slug>`,
 * and `CompanySearchPanel`'s `public-companies-search-input`.
 * `RomanianListedCard` (the row list) was deleted outright.
 *
 * The spec had been asserting against that removed table since. It never
 * failed, because nothing ran it — `scripts/run_battery.py` did not run
 * Playwright at all. Six of the 33 stale assertions
 * `scripts/check_stale_gates.mjs` counted were in this one file.
 *
 * Two changes beyond the renames, both forced by measurement rather than
 * taste:
 *
 *   · AAPL → TLV. The universe is no longer a static 200-row bundle; it
 *     is served per market from the market registry. On a local stack
 *     the US market holds "1 company cached" and `?ticker=AAPL` opens
 *     NOTHING (measured: drawer count 0), while `?ticker=TLV` opens the
 *     full drawer with 8 range buttons. Keeping AAPL would make this
 *     spec a prod-only test wearing local clothes.
 *   · The "Add as peer button is wired" test is DELETED, not retargeted.
 *     `stock-drawer-add-peer` does not exist because the button does not
 *     exist: StockDetailDrawer's footer holds Ask CFO AI alone, and the
 *     peer flow is behind a "Coming soon" toast
 *     (StockDetailDrawer.tsx — the 2026-05-25 temporary gate). Adding a
 *     testid to the app to satisfy a gate would be inventing the feature
 *     the gate claims to check.
 *
 * Run: node scripts/run_playwright_gate.mjs      (or)
 *      npx playwright test e2e/public-companies-drawer.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";

const TILE = '[data-testid^="company-grid-tile-"]';
/** A ticker the local market store actually holds. */
const TICKER = "TLV";

async function openMarkets(page: Page) {
  await page.goto("/public-companies", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("public-company-intelligence"))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("markets-company-grid"))
    .toBeVisible({ timeout: 15_000 });
}

test.describe("public companies — grid + drawer", () => {
  test("/public-companies — the company grid hydrates a full page of tiles", async ({ page }) => {
    await openMarkets(page);

    const tiles = page.locator(TILE);
    await expect(tiles.first()).toBeVisible();
    const count = await tiles.count();
    // 24 per page (4 rows at lg:grid-cols-6). Asserting "a full page"
    // rather than a universe total, because the total now depends on
    // which markets the registry has cached — a number this spec has no
    // business pinning.
    expect(count, `expected a full 24-tile page, got ${count}`).toBe(24);

    // Paginated, not truncated: the next-page control must exist.
    await expect(page.getByTestId("company-grid-next")).toBeVisible();
  });

  test("/public-companies — a sector pill narrows the grid, and un-narrows", async ({ page }) => {
    await openMarkets(page);
    const tiles = page.locator(TILE);
    const before = await tiles.count();

    const financials = page.getByTestId("sector-tile-financials");
    await expect(financials).toBeVisible();
    await financials.click();
    await page.waitForTimeout(400);
    const filtered = await tiles.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered, "the Financials pill must narrow the grid").toBeLessThan(before);

    // The pills toggle; there is no "All" chip any more (the previous
    // `sector-chip-all` was part of the deleted table's filter bar).
    await financials.click();
    await page.waitForTimeout(400);
    expect(await tiles.count(), "clicking the pill again restores the page").toBe(before);
  });

  test("/public-companies — search narrows the grid", async ({ page }) => {
    await openMarkets(page);
    const tiles = page.locator(TILE);
    const before = await tiles.count();

    await page.getByTestId("public-companies-search-input").fill(TICKER);
    await page.waitForTimeout(600);

    await expect(page.getByTestId(`company-grid-tile-${TICKER}`)).toBeVisible();
    const after = await tiles.count();
    expect(after).toBeGreaterThan(0);
    expect(after, "search must narrow the grid").toBeLessThan(before);
  });

  test(`click ${TICKER} tile → drawer opens with chart and deep-links the URL`, async ({ page }) => {
    await openMarkets(page);
    await page.getByTestId("public-companies-search-input").fill(TICKER);
    await page.waitForTimeout(600);
    await page.getByTestId(`company-grid-tile-${TICKER}`).click();

    const drawer = page.getByTestId("stock-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // The URL carries the selection, so the drawer is shareable.
    await expect(page).toHaveURL(new RegExp(`ticker=${TICKER}`));

    // Chart appears OR a clear loading/empty state — never blank.
    await expect(drawer.locator('[data-testid^="stock-price-chart"]').first())
      .toBeVisible({ timeout: 15_000 });

    // Range selector renders its full set.
    expect(await drawer.locator('[data-testid^="range-"]').count()).toBe(8);
  });

  test("change range → chart re-renders", async ({ page }) => {
    await page.goto(`/public-companies?ticker=${TICKER}`, { waitUntil: "domcontentloaded" });
    const drawer = page.getByTestId("stock-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await expect(drawer.locator('[data-testid^="stock-price-chart"]').first())
      .toBeVisible({ timeout: 15_000 });

    await page.getByTestId("range-1m").click();
    await page.waitForTimeout(800);
    await expect(drawer.locator('[data-testid^="stock-price-chart"]').first()).toBeVisible();
  });

  test("the drawer footer offers Ask CFO AI", async ({ page }) => {
    await page.goto(`/public-companies?ticker=${TICKER}`, { waitUntil: "domcontentloaded" });
    const drawer = page.getByTestId("stock-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15_000 });

    const ask = page.getByTestId("stock-drawer-ask-cfo-ai");
    await expect(ask).toBeVisible();
    expect(await ask.evaluate((el) => el.tagName)).toBe("BUTTON");
  });

  test("ESC closes the drawer and clears the URL", async ({ page }) => {
    await page.goto(`/public-companies?ticker=${TICKER}`, { waitUntil: "domcontentloaded" });
    const drawer = page.getByTestId("stock-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0, { timeout: 5_000 });
    expect(page.url()).not.toContain(`ticker=${TICKER}`);
  });
});
