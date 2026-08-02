// Workspace-flow acceptance (2026-08-02) — the spec §14 E2E flow.
//
// Runs against PROD (--project=prod) with a REAL account, supplied via env:
//   E2E_EMAIL / E2E_PASSWORD   — credentials of a test account
// The whole suite SKIPS when they're absent, so CI without secrets stays
// green. Signup-with-email-confirmation can't run headlessly against prod
// (the confirmation link lands in a mailbox), so this exercises the
// login → workspace → dashboard → data-pages → chat chain; the signup
// trigger + ensure-default are locked by unit tests instead.
//
// Optional: E2E_UPLOAD_FIXTURE=<path to a small trial-balance .xlsx> adds the
// live upload → scan → populated-dashboard leg (slow: a real pipeline run).

import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const FIXTURE = process.env.E2E_UPLOAD_FIXTURE;

test.describe("authenticated upload → dashboard flow", () => {
  test.skip(!EMAIL || !PASSWORD, "E2E_EMAIL / E2E_PASSWORD not set");
  test.use({ viewport: { width: 1366, height: 900 } });

  test("landing → login → workspace exists → dashboard + data pages + chat", async ({ page }) => {
    test.setTimeout(180_000);

    // 1-2. Landing renders publicly.
    await page.goto("/");
    await expect(page).toHaveTitle(/CFO AI/i);

    // 3. Login.
    await page.goto("/login");
    await page.getByLabel(/email/i).or(page.locator('input[type="email"]')).first().fill(EMAIL!);
    await page.locator('input[type="password"]').first().fill(PASSWORD!);
    await page.locator('button[type="submit"]').first().click();

    // 4-5. Workspace exists automatically → dashboard loads. No workspace
    // error, no login bounce-back.
    await page.waitForURL(/\/(dashboard|workspace)/, { timeout: 30_000 });
    await page.goto("/dashboard");
    await expect(page.getByTestId("sidebar-dashboard")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/no organization found/i)).toHaveCount(0);
    await expect(page.getByText(/workspace missing/i)).toHaveCount(0);

    // 6-8 (optional). Live upload leg.
    if (FIXTURE) {
      const input = page.locator('input[type="file"]').first();
      await input.setInputFiles(FIXTURE);
      // Scan runs (pipeline strip), completes, and results open — either via
      // the auto-open or the View-results card.
      await expect(page.getByTestId("upload-scanning-fullscreen")).toBeVisible({ timeout: 20_000 });
      const view = page.getByTestId("scan-view-results");
      await view.waitFor({ state: "visible", timeout: 150_000 }).catch(() => null);
      if (await view.isVisible().catch(() => false)) await view.click();
      await expect(page).toHaveURL(/period=/, { timeout: 30_000 });
    }

    // 9. Dashboard shows an analysis when one exists (URL carries ?period=
    // once the workspace has data; a fresh empty workspace legitimately
    // shows the upload hero instead — both are non-error states).
    const hasPeriod = /period=/.test(page.url());

    if (hasPeriod) {
      // 10-13. Data pages open from the same active analysis.
      for (const tab of ["P&L", "Balance Sheet", "Ratios", "Valuation"]) {
        const trigger = page.getByRole("tab", { name: new RegExp(tab, "i") }).first();
        if (await trigger.isVisible().catch(() => false)) {
          await trigger.click();
          await expect(page.getByText(/error|failed to load/i)).toHaveCount(0);
        }
      }
    }

    // 14. CFO AI Chat opens carrying the same context (no workspace error).
    await page.getByTestId("sidebar-chat").click();
    await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 });
    await expect(page.getByText(/no organization found/i)).toHaveCount(0);
  });
});
