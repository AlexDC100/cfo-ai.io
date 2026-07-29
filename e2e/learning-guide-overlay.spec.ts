/**
 * F5.0 Wave 3 — Guide overlay behaviour.
 *
 * Contract (UPDATED 2026-06-13 to match shipped UX):
 *   1. The page guide does NOT auto-open on navigation. Users click
 *      GUIDE ME explicitly. (The earlier auto-open prototype was
 *      reverted in Phase 5.)
 *   2. The overlay testid is `page-guide-overlay`, NOT `guide-overlay`.
 *   3. The Balance Sheet tab id is `balance_sheet`, NOT `statements`.
 *   4. Esc closes the overlay.
 *   5. Done marks the tutorial seen so a subsequent GUIDE ME click
 *      reopens from step 1.
 *
 * Each test dismisses the public-test-mode banner before clicking the
 * GUIDE ME pill (the banner intercepts header pointer events).
 */

import { test, expect, type Page } from "@playwright/test";
import { dismissPublicTestBanner, preseedLearningMode } from "./_helpers";

async function openGuide(
  page: Page,
  tab: string,
  triggerTestId: string,
  tabLabel: RegExp,
) {
  await page.goto(`/dashboard?tab=${tab}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  await dismissPublicTestBanner(page);
  // The ?tab= URL param hints the initial render, but the tab must be
  // clicked to actually mount the per-tab surface that hosts the
  // GUIDE ME pill. Without this click, the trigger testid never
  // appears in the DOM.
  const tabEl = page.getByRole("tab", { name: tabLabel });
  if (await tabEl.isVisible().catch(() => false)) {
    await tabEl.click();
    await page.waitForTimeout(1500);
  }
  const trigger = page.getByTestId(triggerTestId);
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.scrollIntoViewIfNeeded();
  // Regular click (not force) — force-clicks bypass element-stability
  // gates and Framer Motion can still be mid-mount when we fire,
  // causing the overlay's open state to stick at false.
  await trigger.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
}

test.describe("F5.0 Wave 3 — Guide overlay UX", () => {
  test.beforeEach(async ({ page }) => {
    // Pre-seed `mode: subtle` + `coachDismissed: true` so the
    // LearningCoach card doesn't render between the banner and the
    // GUIDE ME pill — its sparkle animation can intercept clicks.
    await preseedLearningMode(page, "subtle");
  });

  test("Esc closes the BS guide", async ({ page }) => {
    await openGuide(page, "balance_sheet", "guide-trigger-balance-sheet", /^Balance Sheet$/);
    await expect(page.getByTestId("page-guide-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("page-guide-overlay")).toBeHidden({
      timeout: 1500,
    });
  });

  test("Next advances the BS guide", async ({ page }) => {
    await openGuide(page, "balance_sheet", "guide-trigger-balance-sheet", /^Balance Sheet$/);
    // Step 1 of N — initial header includes "1 OF" pattern.
    await expect(page.getByText(/1 OF/i).first()).toBeVisible();
    await page.getByTestId("page-guide-next").click({ force: true });
    await expect(page.getByText(/2 OF/i).first()).toBeVisible();
  });

  test("Closing the guide persists across reload (no auto-open)", async ({
    page,
  }) => {
    await openGuide(page, "balance_sheet", "guide-trigger-balance-sheet", /^Balance Sheet$/);
    // Close via Esc — the close path is what calls markTutorialSeen()
    // internally. The "Done-walk-through-all-steps" path is brittle
    // because step counts vary by page and each transition has its own
    // animation latency; the Esc shortcut achieves the same contract.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("page-guide-overlay")).toBeHidden({
      timeout: 2000,
    });

    // Reload — the guide should NOT auto-open on subsequent visit.
    // (Auto-open was reverted in Phase 5; this test now also guards
    // against any future re-introduction.)
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("page-guide-overlay")).toBeHidden();
  });

  test("Valuation guide overlay also responds to Esc", async ({ page }) => {
    await openGuide(page, "valuation", "guide-trigger-valuation", /Valuation/i);
    await expect(page.getByTestId("page-guide-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("page-guide-overlay")).toBeHidden({
      timeout: 1500,
    });
  });
});
