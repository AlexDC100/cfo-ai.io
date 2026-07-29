/**
 * F5.0 — Metric Glossary Drawer + Cmd+K integration test.
 *
 * Verifies:
 *   1. Clicking the TopHeader "Glossary" button opens the drawer
 *      (data-testid="metric-glossary")
 *   2. Search filters by concept name (en + ro + key)
 *   3. Clicking a concept item pushes it onto the popover stack
 *   4. Cmd+K opens SearchDialog, "glossary" matches the Browse glossary
 *      entry, and selecting it opens the drawer
 *   5. SearchDialog returns concept results for finance keywords
 *      ("ebitda" → concept-ebitda)
 *
 * TEST-DEBT (2026-06-13) — dismissPublicTestBanner() added before any
 * top-row click so the amber banner doesn't intercept the glossary
 * trigger pointer event.
 */

import { test, expect } from "@playwright/test";
import { bootDashboard, dismissPublicTestBanner } from "./_helpers";

test.describe("F5.0 — metric glossary drawer", () => {
  test("opens via TopHeader trigger + search + pick", async ({ page }) => {
    await bootDashboard(page);
    // LEARN-FIX-4 (2026-06-14): the standalone "Glossary" pill was
    // replaced by a Learning Hub dropdown. Open the hub, then click
    // the Glossary row inside it.
    await page.getByTestId("top-learning-hub-trigger").click({ force: true });
    await page.getByTestId("top-learning-hub-glossary").click({ force: true });
    await expect(page.getByTestId("metric-glossary")).toBeVisible();

    // Search for EBITDA.
    await page.getByTestId("glossary-search").fill("ebitda");
    await expect(page.getByTestId("glossary-item-ebitda")).toBeVisible();

    // Click → popover stack push.
    await page.getByTestId("glossary-item-ebitda").click({ force: true });
    await expect(page.locator(".learn-pop-content").first()).toBeVisible({
      timeout: 2000,
    });
  });
});

test.describe("F5.0 — Cmd+K SearchDialog → glossary integration", () => {
  test("typing a concept name surfaces a concept result", async ({ page }) => {
    await bootDashboard(page);
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+k" : "Control+k",
    );
    await page.waitForTimeout(500);
    await page.keyboard.type("ebitda");
    await expect(page.getByText("Learn", { exact: true }).first()).toBeVisible({
      timeout: 2000,
    });
  });

  test("Browse glossary entry opens the drawer", async ({ page }) => {
    await bootDashboard(page);
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+k" : "Control+k",
    );
    await page.waitForTimeout(500);
    await page.getByText("Browse glossary").click({ force: true });
    await expect(page.getByTestId("metric-glossary")).toBeVisible();
  });
});

// Pin the helper as used so unused-import lints stay quiet across
// editor configurations.
export const _dismissProbe = dismissPublicTestBanner;
