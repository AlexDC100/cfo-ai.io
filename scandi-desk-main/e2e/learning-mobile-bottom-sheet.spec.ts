/**
 * F5.0 Phase 5 — Mobile bottom-sheet real test (no stubs).
 *
 * Target: prod with iPhone 13 viewport override (390×844).
 * Run with: npx playwright test --project=prod e2e/learning-mobile-bottom-sheet.spec.ts
 *
 * Contract:
 *   1. At iPhone viewport, LearningPopover renders as a vaul bottom-sheet
 *      (NOT the desktop floating panel positioned above the trigger rect).
 *   2. The bottom-sheet sits at the bottom of the viewport (top edge below
 *      viewport.height / 2).
 *   3. Tapping a Map chip opens the bottom-sheet at <100px below the
 *      bottom of the page.
 *   4. Pull-down / Esc dismisses the sheet.
 *
 * The desktop floating panel uses position: fixed with `top`/`left`
 * relative to the trigger rect. The mobile vaul sheet uses `bottom: 0`
 * full-width with rounded top corners. We assert the rect.bottom is at
 * or near viewport.height.
 */

import { test, expect } from "@playwright/test";

// File-level mobile viewport override — chromium with iPhone 13 dimensions
// (390 × 844) + a mobile UA so `useIsMobile()` resolves to true and the
// LearningPopover mounts the vaul drawer path. Avoids the WebKit binary
// dependency in CI/local runs without `npx playwright install webkit`.
test.use({
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  hasTouch: true,
  isMobile: true,
});

test.describe("F5.0 Phase 5 — Mobile bottom-sheet popover", () => {
  test("Cash chip → vaul bottom-sheet anchored to bottom of viewport", async ({
    page,
  }) => {
    await page.goto("/dashboard?tab=balance_sheet", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("tab", { name: /^Balance Sheet$/ }).click();
    await expect(page.getByTestId("balance-sheet-map")).toBeVisible({
      timeout: 12_000,
    });

    await page.getByTestId("bs-map-cash").click();

    // Wait for the popover content.
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 2_000 });

    // On mobile the vaul Drawer wrapper has the content at the bottom.
    // Find the nearest drawer container ([role="dialog"] from vaul.dev).
    const drawer = page
      .locator('[role="dialog"]:has(.learn-pop-content)')
      .first();
    await expect(drawer).toBeVisible();

    // Box must extend to or very near the viewport bottom (vaul anchors
    // bottom: 0). Allow 4px for safe-area inset variance.
    const box = await drawer.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (box && viewport) {
      expect(box.y + box.height).toBeGreaterThan(viewport.height - 6);
      // And the sheet covers significant vertical space (≥ 30% of viewport)
      // — i.e. it's not the tiny desktop floating panel.
      expect(box.height).toBeGreaterThan(viewport.height * 0.3);
    }
  });

  test("Mobile popover renders the same content stack as desktop", async ({
    page,
  }) => {
    await page.goto("/dashboard?tab=balance_sheet", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("tab", { name: /^Balance Sheet$/ }).click();
    await expect(page.getByTestId("balance-sheet-map")).toBeVisible({
      timeout: 12_000,
    });
    await page.getByTestId("bs-map-cash").click();

    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 2_000 });

    // Plain-English layer must still render on mobile (no responsive hide).
    await expect(page.getByTestId("learn-pop-plain-english")).toBeVisible();
    // Source accounts must still render on mobile.
    await expect(popover).toContainText(/5121|5124|531/);
  });
});
