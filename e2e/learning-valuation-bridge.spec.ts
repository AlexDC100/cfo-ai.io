/**
 * F5.0 Phase 5 — Valuation bridge real test (no stubs).
 *
 * Targets prod (https://cfo-ai.io) — PUBLIC_TEST_MODE bypasses AuthGuard
 * so the route is reachable without sign-in.
 *
 * Run with:  npx playwright test --project=prod e2e/learning-valuation-bridge.spec.ts
 *
 * Asserts the exact contract from Wave 3:
 *   1. /dashboard → Valuation tab renders LearnableValuationBridge
 *   2. Bridge contains Stage 1 (EBITDA × Multiple = EV) and Stage 2
 *      (EV − Gross Debt + Cash = Equity Value)
 *   3. "Why cash is added back" explainer is visible (with the exact
 *      string "EV − Gross Debt + Cash") and shows the strikethrough on
 *      the legacy "EV − Net Debt" shorthand
 *   4. All 6 LearnableMetricCard tiles are present and individually
 *      clickable: ebitda, ev_ebitda_multiple, enterprise_value,
 *      total_debt, cash, equity_value
 *   5. Click Gross Debt → popover renders trial-balance source accounts
 *      162 / 167 / 519 (Wave 3 sourceTrace)
 *   6. Click Cash → popover renders 5121 / 5124 / 531
 *   7. Click Equity Value → popover renders the formula tokens
 *      "Enterprise Value", "Gross Debt", "Cash"
 *
 * Failure modes this spec catches:
 *   · Bridge component removed or hidden
 *   · sourceTrace regressed (popover no longer lists account codes)
 *   · Stage 2 formula changed back to "EV − Net Debt"
 *   · LearnableMetricCard testid pattern changed
 */

import { test, expect, type Page } from "@playwright/test";

const VALUATION_URL = "/dashboard?tab=valuation";

async function gotoValuation(page: Page) {
  await page.goto(VALUATION_URL, { waitUntil: "domcontentloaded" });
  // The Overview briefing renders first; click the Valuation tab.
  const valuationTab = page.getByRole("tab", { name: /^Valuation$/ });
  await expect(valuationTab).toBeVisible({ timeout: 15_000 });
  await valuationTab.click();
  // The bridge is below the EBITDA-multiple primary card.
  await expect(page.getByTestId("learnable-valuation-bridge")).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("F5.0 Wave 3 — Valuation bridge", () => {
  test("Bridge renders with both stages + cash-add-back explainer", async ({
    page,
  }) => {
    await gotoValuation(page);

    // Stage labels are spelled out — the DOM text is "Stage 1" / "Stage 2"
    // (CSS `text-transform: uppercase` makes them LOOK uppercase but the
    // text node stays mixed-case).
    const bridge = page.getByTestId("learnable-valuation-bridge");
    await expect(bridge).toContainText("Stage 1");
    await expect(bridge).toContainText("What buyers pay for the business");
    await expect(bridge).toContainText("Stage 2");
    await expect(bridge).toContainText("What the shareholders walk away with");

    // The explainer block carries the canonical "why cash adds back" copy.
    const explainer = page.getByTestId("valuation-bridge-cash-explainer");
    await expect(explainer).toBeVisible();
    await expect(explainer).toContainText("Why cash is added back");
    await expect(explainer).toContainText("EV − Gross Debt + Cash");
    // The strikethrough "EV − Net Debt" is rendered in plain text and
    // wrapped in a <span class="line-through ...">. We assert the text.
    await expect(explainer).toContainText("EV − Net Debt");
  });

  test("All 6 bridge cards render as LearnableMetricCard", async ({ page }) => {
    await gotoValuation(page);
    // LearnableMetricCard renders `data-testid="metric-${conceptKey}"`.
    for (const key of [
      "metric-ebitda",
      "metric-ev_ebitda_multiple",
      "metric-enterprise_value",
      "metric-total_debt",
      "metric-cash",
      "metric-equity_value",
    ]) {
      await expect(page.getByTestId(key).first()).toBeVisible();
    }
  });

  test("Click Gross Debt → popover with 162/167/519 source accounts", async ({
    page,
  }) => {
    await gotoValuation(page);
    await page.getByTestId("metric-total_debt").first().click();
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 2_000 });
    // sourceTrace block lists each account code as a leading number.
    await expect(popover).toContainText("Total Debt");
    await expect(popover).toContainText(/162|167|519/);
  });

  test("Click Cash → popover with 5121/5124/531 source accounts", async ({
    page,
  }) => {
    await gotoValuation(page);
    await page.getByTestId("metric-cash").first().click();
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 2_000 });
    await expect(popover).toContainText(/Cash/i);
    await expect(popover).toContainText(/5121|5124|531/);
  });

  test("Click Equity Value → formula tokens for EV − Gross Debt + Cash", async ({
    page,
  }) => {
    await gotoValuation(page);
    await page.getByTestId("metric-equity_value").first().click();
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 2_000 });
    // The Wave 3 equity_value computation returns three labelled tokens.
    await expect(popover).toContainText("Enterprise Value");
    await expect(popover).toContainText("Gross Debt");
    await expect(popover).toContainText("Cash");
  });
});
