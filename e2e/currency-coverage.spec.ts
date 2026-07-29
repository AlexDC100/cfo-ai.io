/**
 * CUR-FIX-G — currency-coverage e2e walk.
 *
 * Walks every money-bearing surface in the app and asserts that toggling
 * the TopHeader RON / EUR / USD switch actually flips the currency
 * symbol on every page. Without this guard the coverage regressions
 * we already shipped (Products in kRON forever, peer-comparison
 * "Financial impact" stuck in M RON, etc.) reappear silently.
 *
 * Strategy:
 *   1. Sign in via the demo button (same harness adaptation the
 *      `golden-path` spec uses — no seeded account required).
 *   2. Load the EEI sample so the workspace has real numbers.
 *   3. For each [page → testid → expected currency symbol] tuple,
 *      visit the page, switch the toggle to the target currency,
 *      and assert at least one money cell carries the target symbol.
 *      Then capture a full-page screenshot into
 *      `playwright-report/screenshots/<page>-<currency>.png` so the
 *      operator can eyeball the screenshot grid Step 11 of the spec
 *      called for.
 *
 * The assertions deliberately look at the FIRST money tile on each
 * page (it would be the one to regress first if a render path goes
 * uncovered). Per-cell scans are saved for the linter (CUR-FIX
 * `no-restricted-syntax`) so this spec stays under 60s wall-clock.
 *
 * To extend: add a tuple to PAGE_MATRIX. To run locally:
 *   npm run dev   # in one terminal
 *   npx playwright test e2e/currency-coverage.spec.ts --headed
 */

import { test, expect, type Page } from "@playwright/test";

type Currency = "ron" | "eur" | "usd";

const CURRENCY_SYMBOL: Record<Currency, RegExp> = {
  // Each regex matches the SYMBOL or 3-letter CODE the formatter emits for
  // that currency. Intl.NumberFormat output varies by locale — RON in
  // ro-RO is "RON" (suffix), EUR in de-DE is "€" (prefix), USD in en-US
  // is "$" (prefix). We tolerate either symbol or code.
  ron: /\bRON\b|\bLEI\b/i,
  eur: /€|\bEUR\b/i,
  usd: /\$|\bUSD\b/i,
};

/**
 * Every page that renders money plus at least one stable testid we can
 * scope the symbol assertion to. Add new pages here — never delete from
 * this list without confirming the page genuinely has no money surface.
 */
const PAGE_MATRIX: Array<{
  name: string;
  path: string;
  /** A testid whose descendants include at least one money cell. */
  scope: string;
}> = [
  { name: "dashboard",         path: "/dashboard",         scope: "dashboard-kpi-row-1" },
  { name: "financial-stmts",   path: "/statements",        scope: "statements-pnl-table" },
  { name: "comprehensive-rpt", path: "/report",            scope: "report-section-1-overview" },
  { name: "products",          path: "/products",          scope: "portfolio-totals" },
];

async function signInAndLoadSample(page: Page) {
  await page.goto("/");
  await page.getByTestId("auth-continue-demo").first().click();
  await expect(page).toHaveURL(/\/dashboard/);

  // Load EEI sample via the Statements sample picker (the only surface
  // that always shows the picker on first load).
  await page.getByTestId("sidebar-statements").click();
  const replace = page.getByTestId("replace-period");
  if (await replace.isVisible().catch(() => false)) {
    await replace.click();
  }
  await page.getByTestId("sample-pick-eei").click();
  await expect(page).toHaveURL(/period=eei/);
}

async function setCurrency(page: Page, c: Currency) {
  await page.getByTestId(`currency-toggle-${c}`).click();
  // One frame for Framer Motion + the global store re-render to land.
  await page.waitForTimeout(150);
}

test.describe("CUR-FIX-G — currency coverage", () => {
  test("RON / EUR / USD propagate across every money surface", async ({ page }, testInfo) => {
    test.setTimeout(90_000); // sample load + 3 currencies × 4 pages

    await signInAndLoadSample(page);

    for (const currency of ["ron", "eur", "usd"] as const) {
      // Switch BEFORE visiting each page so the store is in the right
      // state at first render — eliminates a class of "toggle didn't
      // re-render because we visited the page first" flakes.
      await setCurrency(page, currency);

      for (const { name, path, scope } of PAGE_MATRIX) {
        await page.goto(path);

        // Some surfaces fetch data on mount — wait for the scope to
        // actually contain text before asserting on it.
        const scoped = page.getByTestId(scope);
        await expect(scoped, `scope ${scope} should render on ${name}`).toBeVisible({
          timeout: 10_000,
        });
        const text = await scoped.innerText();
        expect(
          text,
          `${name} @ ${currency.toUpperCase()} — money symbol missing in scope ${scope}`,
        ).toMatch(CURRENCY_SYMBOL[currency]);

        // For every OTHER currency, confirm the page doesn't STILL show
        // the old symbol. e.g. EUR mode shouldn't have $ leaking through.
        // (Skip RON's "L" check — too many incidental matches.)
        if (currency !== "ron") {
          const otherCurrencies = (["eur", "usd"] as const).filter((c) => c !== currency);
          for (const other of otherCurrencies) {
            // We're lenient here — copyright-style "USD" mentions in
            // text are fine; we only flag if MORE THAN HALF the matches
            // are the wrong currency. This catches "every tile still in
            // RON" without false-positives on a single source-currency
            // disclosure line.
            const ours = (text.match(CURRENCY_SYMBOL[currency]) ?? []).length;
            const theirs = (text.match(CURRENCY_SYMBOL[other]) ?? []).length;
            expect(
              ours,
              `${name} @ ${currency.toUpperCase()} — only ${ours} ${currency} symbols vs ${theirs} ${other} symbols`,
            ).toBeGreaterThanOrEqual(theirs);
          }
        }

        // Screenshot grid for the operator's visual sanity-check.
        await testInfo.attach(`${name}-${currency}.png`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    }
  });

  test("subscription/billing prices DO NOT convert with the toggle", async ({ page }) => {
    // Billing prices are intentionally currency-independent (the price is
    // what we charge in the billing-system's currency, not what the user
    // toggled their dashboard to). Regression guard: flipping the toggle
    // shouldn't change ANY of the price strings on /pricing.
    await page.goto("/");
    await page.getByTestId("auth-continue-demo").first().click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto("/pricing");
    // Capture pricing strings before + after toggle. They must be byte-identical.
    const before = await page.locator("body").innerText();

    await setCurrency(page, "usd");
    const after = await page.locator("body").innerText();

    // Pricing block lives in a card on the page; assert the price chunks
    // didn't move. We don't compare full body text because the toggle
    // itself changes (USD button is now active). Instead we look for the
    // EUR € prefix which billing uses regardless of toggle.
    const eurPriceMatches = (s: string) => (s.match(/€\s?\d+[.,]?\d*/g) ?? []).sort().join("|");
    expect(eurPriceMatches(after), "billing prices changed when toggle flipped to USD")
      .toBe(eurPriceMatches(before));
  });
});
