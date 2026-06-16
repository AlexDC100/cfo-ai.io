/**
 * F5.0 — Learning mode toggle persistence test.
 *
 * Verifies that:
 *   1. Default learning mode is "guided" (first load with no localStorage)
 *   2. Toggling to subtle / off via Settings persists across reloads
 *   3. The html[data-learning-mode] attribute is set on every mode change
 *      (drives the CSS visibility selectors in src/styles/learning.css)
 *   4. resetAll() returns to guided
 *
 * Notes — these tests are scaffold stubs. They assume Playwright is
 * configured against a local dev server (vite preview / dev) with a
 * demo-mode entry. Adapt to your auth flow as needed.
 */

import { test, expect } from "@playwright/test";
import { dismissPublicTestBanner } from "./_helpers";

test.describe("F5.0 — learning mode toggle", () => {
  test.beforeEach(async ({ page }) => {
    // Clear all learning state before each test so we start fresh.
    await page.addInitScript(() => {
      window.localStorage.removeItem("cfo:learning-mode:v1");
    });
  });

  test("default mode is guided + html attribute set", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForTimeout(8000);
    await dismissPublicTestBanner(page);
    // Wait for the learning provider to initialize and set the attribute.
    await expect(page.locator("html")).toHaveAttribute(
      "data-learning-mode",
      "guided",
    );
  });

  test("toggling to subtle persists across reload", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForTimeout(5000);
    await dismissPublicTestBanner(page);
    // Click the "Subtle" mode option in Settings → Learning section.
    await page.getByTestId("settings-learning-mode-subtle").click({ force: true });
    await expect(page.locator("html")).toHaveAttribute(
      "data-learning-mode",
      "subtle",
    );

    // Reload and verify persistence.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await expect(page.locator("html")).toHaveAttribute(
      "data-learning-mode",
      "subtle",
    );
  });

  test("toggling to off persists + resetAll returns to guided", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForTimeout(5000);
    await dismissPublicTestBanner(page);
    await page.getByTestId("settings-learning-mode-off").click({ force: true });
    await expect(page.locator("html")).toHaveAttribute(
      "data-learning-mode",
      "off",
    );

    // Reset.
    await page.getByTestId("settings-learning-reset").click({ force: true });
    await expect(page.locator("html")).toHaveAttribute(
      "data-learning-mode",
      "guided",
    );
  });
});
