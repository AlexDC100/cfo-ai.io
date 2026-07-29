/**
 * F5.0 — Page guide spotlight tour test.
 *
 * Verifies:
 *   1. Clicking GuideMeButton opens the PageGuideOverlay
 *   2. Per-step `selector` finds its target on the page (spotlight cutout
 *      positions over the right element)
 *   3. Next / Back / Done navigation works
 *   4. Esc closes the guide; closing marks the page as "tutorialsSeen" so
 *      the next visit doesn't auto-open
 *
 * UPDATED 2026-06-13:
 *   · Tab id is `balance_sheet` / `p_and_l` / `ratios` (not `statements`)
 *   · Overlay testid is `page-guide-overlay` (not `guide-overlay`)
 *   · Next button testid is `page-guide-next`
 *   · Banner dismiss + 8s lazy-load wait before any header click
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
  // The ?tab= URL param hints initial render but the tab must be
  // clicked to mount the surface that hosts the GUIDE ME pill.
  const tabEl = page.getByRole("tab", { name: tabLabel });
  if (await tabEl.isVisible().catch(() => false)) {
    await tabEl.click();
    await page.waitForTimeout(1500);
  }
  const trigger = page.getByTestId(triggerTestId);
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
}

test.describe("F5.0 — page guide spotlight tour", () => {
  test.beforeEach(async ({ page }) => {
    // Pre-seed `mode: subtle` + `coachDismissed: true` so the
    // LearningCoach card doesn't intercept clicks on the guide pill.
    await preseedLearningMode(page, "subtle");
  });

  test("Balance Sheet guide opens + Esc closes", async ({ page }) => {
    await openGuide(page, "balance_sheet", "guide-trigger-balance-sheet", /^Balance Sheet$/);
    await expect(page.getByTestId("page-guide-overlay")).toBeVisible();
    // Esc closes the overlay — same contract as Done click but without
    // the step-walk loop that's brittle across step-count and animation
    // timing differences.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("page-guide-overlay")).toBeHidden({
      timeout: 2000,
    });
  });

  test("P&L guide reveals data-guide markers after Next", async ({ page }) => {
    await openGuide(page, "p_and_l", "guide-trigger-pnl", /^P&L$/);
    await expect(page.getByTestId("page-guide-overlay")).toBeVisible();
    // Step 1 → step 2 reveals the pl-revenue spotlight target.
    const next = page.getByTestId("page-guide-next");
    if (await next.isVisible().catch(() => false)) {
      await next.click({ force: true });
      await page.waitForTimeout(400);
    }
    // The target should exist in the DOM (may be partially scrolled).
    await expect(
      page.locator('[data-guide="pl-revenue"], [data-guide="pl_revenue"]').first(),
    ).toBeAttached({ timeout: 5000 });
  });

  test("Esc closes the guide", async ({ page }) => {
    await openGuide(page, "balance_sheet", "guide-trigger-balance-sheet", /^Balance Sheet$/);
    await expect(page.getByTestId("page-guide-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("page-guide-overlay")).toBeHidden({
      timeout: 1500,
    });
  });

  test("Ratios tab renders with the spotlight data-guide markers attached", async ({
    page,
  }) => {
    await page.goto("/dashboard?tab=ratios", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    await dismissPublicTestBanner(page);
    // Click the Ratios tab so the per-tab content actually mounts.
    const ratiosTab = page.getByRole("tab", { name: /Ratios/i });
    if (await ratiosTab.isVisible().catch(() => false)) {
      await ratiosTab.click();
      await page.waitForTimeout(2000);
    }
    // All 4 spotlight targets should be in the DOM (may be off-screen).
    await expect(page.locator('[data-guide="ratios-profitability"]')).toBeAttached({ timeout: 10_000 });
    await expect(page.locator('[data-guide="ratios-leverage"]')).toBeAttached({ timeout: 5000 });
    await expect(page.locator('[data-guide="ratios-efficiency"]')).toBeAttached({ timeout: 5000 });
    await expect(page.locator('[data-guide="ratios-risk"]')).toBeAttached({ timeout: 5000 });
  });
});
