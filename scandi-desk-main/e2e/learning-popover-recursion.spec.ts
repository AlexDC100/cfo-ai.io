/**
 * F5.0 Phase 5 — Popover recursion real test (no stubs).
 *
 * Target: prod (https://cfo-ai.io) — PUBLIC_TEST_MODE bypass.
 * Run with: npx playwright test --project=prod e2e/learning-popover-recursion.spec.ts
 *
 * Verifies the critical Wave 1 fix: depth>0 popovers render formula
 * tokens. Pre-fix, the closure capture race left `stage` stuck at 0 on
 * nested popovers, hiding the formula and Ask CFO AI footer. This test
 * is the regression gate.
 *
 * Chain walked (BS surface, no auth needed thanks to PUBLIC_TEST_MODE):
 *   Total Assets (depth 0)
 *     → Non-Current Assets formula token (depth 1)
 *       → ... must still render formula or sourceTrace at depth 1+
 *   Back button pops one level
 *   Esc pops one level (not the whole stack)
 *
 * Also verified at depth 0:
 *   · plain-English block present
 *   · "Ask CFO AI about this" footer present
 *   · Close button (×) clears the stack
 */

import { test, expect, type Page } from "@playwright/test";

async function gotoBalanceSheet(page: Page) {
  await page.goto("/dashboard?tab=balance_sheet", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: /^Balance Sheet$/ }).click();
  await expect(page.getByTestId("balance-sheet-map")).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("F5.0 Wave 1 — Popover recursion regression gate", () => {
  test("depth-0 popover has formula + plain-English + Ask CFO AI footer", async ({
    page,
  }) => {
    await gotoBalanceSheet(page);
    await page.getByTestId("bs-total-assets-label").click();
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 2_000 });

    // Plain-English (Wave 2 layer).
    await expect(popover).toContainText("In plain English");
    // Formula block label.
    await expect(popover).toContainText(/How it's computed|Formula/i);
    // Ask CFO AI footer.
    await expect(popover).toContainText(/Ask CFO AI/);
  });

  test("depth-1 popover (drill from formula) still renders formula or source", async ({
    page,
  }) => {
    await gotoBalanceSheet(page);
    // Open Total Assets (depth 0).
    await page.getByTestId("bs-total-assets-label").click();
    await expect(page.locator(".learn-pop-content").first()).toBeVisible();

    // Drill into "Non-Current" formula token (depth 1).
    // InteractiveFormula tokens are clickable buttons inside the popover.
    const popover0 = page.locator(".learn-pop-content").first();
    const nonCurrentToken = popover0
      .locator('button:has-text("Non-Current")')
      .first();
    await expect(nonCurrentToken).toBeVisible({ timeout: 1_500 });
    await nonCurrentToken.click();

    // Depth 1 popover stacks — there should now be at least 2 popovers.
    await expect(page.locator(".learn-pop-content")).toHaveCount(2, {
      timeout: 2_000,
    });

    // The depth-1 popover must still contain a substantive content block
    // beyond just the header — either "How it's computed", "Source",
    // or "In plain English". This is the Wave 1 stage-fix gate.
    const popover1 = page.locator(".learn-pop-content").nth(1);
    await expect(popover1).toBeVisible();
    const text = await popover1.innerText();
    // LEARN-FIX-1 (2026-06-13) — "Source in trial balance" was renamed
    // to "Composition" when the flat source-account list was replaced
    // by the proportional-bar view. Both labels accepted so the gate
    // stays semantic.
    expect(
      /How it's computed|In plain English|Source in trial balance|Composition|Tap any number/i.test(
        text,
      ),
    ).toBe(true);
  });

  test("Esc on top of stack pops one level (not all)", async ({ page }) => {
    await gotoBalanceSheet(page);
    await page.getByTestId("bs-total-assets-label").click();
    await expect(page.locator(".learn-pop-content").first()).toBeVisible();

    // Drill to depth 1.
    await page
      .locator(".learn-pop-content")
      .first()
      .locator('button:has-text("Non-Current")')
      .first()
      .click();
    await expect(page.locator(".learn-pop-content")).toHaveCount(2, {
      timeout: 2_000,
    });

    // Esc once → depth 1 closes, depth 0 stays.
    await page.keyboard.press("Escape");
    await expect(page.locator(".learn-pop-content")).toHaveCount(1, {
      timeout: 1_500,
    });

    // Esc again → depth 0 closes.
    await page.keyboard.press("Escape");
    await expect(page.locator(".learn-pop-content")).toHaveCount(0, {
      timeout: 1_500,
    });
  });

  test("Back button on depth 1 pops to depth 0", async ({ page }) => {
    await gotoBalanceSheet(page);
    await page.getByTestId("bs-total-assets-label").click();
    await page
      .locator(".learn-pop-content")
      .first()
      .locator('button:has-text("Non-Current")')
      .first()
      .click();
    await expect(page.locator(".learn-pop-content")).toHaveCount(2);

    // The depth-1 popover has a "Back" button (data-testid="learn-pop-back").
    // Use force:true — framer-motion's entry animation keeps the button
    // "moving" for a few hundred ms, and Playwright's stability check
    // times out. force:true clicks at the resolved center regardless.
    await page.getByTestId("learn-pop-back").click({ force: true });
    await expect(page.locator(".learn-pop-content")).toHaveCount(1, {
      timeout: 1_500,
    });
  });
});
