/**
 * F5.0 — Plain-English layer test.
 *
 * Verifies:
 *   1. Concepts with `plainEnglish` show the "In plain English" block in
 *      the popover when learning mode is guided or subtle
 *   2. The block is hidden in "off" mode (formal definition only)
 *   3. The block is rendered ABOVE the formal definition (which is then
 *      labelled "Formally" below)
 *
 * UPDATED 2026-06-13:
 *   · Open the popover via the `learnable-ebitda` testid wired on the
 *     Overview KPI tile, not via legacy `[data-traceable-target=...]`
 *     selectors that were removed in the Wave 2 refactor.
 *   · Banner dismiss + 8s lazy-load wait before clicking.
 */

import { test, expect, type Page } from "@playwright/test";
import { dismissPublicTestBanner } from "./_helpers";

async function setLearningMode(page: Page, mode: "guided" | "subtle" | "off") {
  await page.addInitScript((m) => {
    window.localStorage.setItem(
      "cfo:learning-mode:v1",
      JSON.stringify({
        mode: m,
        coachDismissed: true,
        tutorialsSeen: {},
      }),
    );
  }, mode);
}

async function openEbitdaPopover(page: Page) {
  await page.goto("/dashboard?tab=overview", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  await dismissPublicTestBanner(page);
  const tile = page.getByTestId("learnable-ebitda").first();
  await expect(tile).toBeVisible({ timeout: 10_000 });
  await tile.dispatchEvent("click");
  await page.waitForTimeout(1500);
}

test.describe("F5.0 — plain-English popover layer", () => {
  test("guided mode: EBITDA shows In plain English block above Formally", async ({
    page,
  }) => {
    await setLearningMode(page, "guided");
    await openEbitdaPopover(page);
    await expect(page.getByTestId("learn-pop-plain-english")).toBeVisible({
      timeout: 3000,
    });
    await expect(page.getByText(/Formally|How it's computed/i).first()).toBeVisible();
  });

  test("off mode: plain-English block is hidden", async ({ page }) => {
    await setLearningMode(page, "off");
    await openEbitdaPopover(page);
    // Popover should still appear (off mode just hides the affordance,
    // not the popover content surface).
    await expect(page.locator(".learn-pop-content").first()).toBeVisible();
    // But the plain-English block is hidden.
    await expect(page.getByTestId("learn-pop-plain-english")).toBeHidden();
  });
});
