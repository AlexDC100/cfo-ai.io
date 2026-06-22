/**
 * F5.0 Phase 9 — Landing / first-run packaging real test (no stubs).
 *
 * Target: prod (https://cfo-ai.io) — PUBLIC_TEST_MODE is on, which means
 * `/` redirects to `/dashboard`. We can't render Landing in the browser
 * on prod via this test mode, so the Landing contract is checked via
 * the prod bundle (asserts the LearningLayerSection strings shipped).
 * The first-run onboarding contract — LearningCoach lighting up for new
 * users — IS visible on /dashboard once we clear the persisted state.
 *
 * Run with: npx playwright test --project=prod e2e/learning-landing-onboarding.spec.ts
 *
 * Contracts verified:
 *   1. The prod /dashboard route bundles the LearningLayerSection
 *      (headline strings present in the same chunk as Landing).
 *   2. With localStorage cleared, the LearningCoach renders on
 *      first /dashboard load with the canonical headline + "Show me"
 *      and "Maybe later" buttons.
 *   3. Clicking "Maybe later" dismisses the coach and it stays dismissed
 *      across reload (persisted via localStorage).
 *   4. The coach does NOT re-appear on the second visit after dismissal.
 *
 * Failure modes this catches:
 *   · Landing import lost the LearningLayerSection
 *   · LearningCoach mount regressed off the FinancialStatements shell
 *   · Coach dismiss flag is volatile (not persisted)
 *   · Headlines / CTAs renamed without updating the contract
 */

import { test, expect, type Page } from "@playwright/test";

async function clearLearningModeState(page: Page) {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try {
      localStorage.removeItem("cfo:learning-mode:v1");
    } catch {
      /* private mode — silently ignore */
    }
  });
}

test.describe("F5.0 Phase 9 — Landing + first-run packaging", () => {
  test("Landing bundle ships LearningLayerSection strings", async ({
    request,
  }) => {
    // Read the prod index.html → extract the main bundle path → fetch the
    // bundle → assert the section's headline strings shipped. The
    // section's hash changes every build, so we resolve through the
    // already-deployed index.html.
    const indexHtml = await request.get("https://cfo-ai.io/").then((r) => r.text());
    const match = indexHtml.match(/index-[A-Za-z0-9_-]+\.js/);
    expect(match, "index bundle reference must be present on /").not.toBeNull();
    const indexBundlePath = match![0];

    const bundle = await request
      .get(`https://cfo-ai.io/assets/${indexBundlePath}`)
      .then((r) => r.text());

    // The canonical Phase 9 strings. If any of these vanish from the
    // bundle, the LearningLayerSection didn't ship in this deploy.
    const expectedStrings = [
      "Every number, traceable",
      "CFO AI Learn",
      "landing-learn-section",
      "landing-learn-layer-",
      // Romanian RAS-account labels rendered in the SourceIllustration
      // SVG. Their presence is the strongest evidence the section is
      // bundled (not just a translation key in a manifest).
      "Vânzare produse finite",
    ];
    for (const s of expectedStrings) {
      expect(bundle, `expected string "${s}" missing from prod bundle`).toContain(s);
    }
  });

  test("LearningCoach lights up on first-time dashboard load", async ({
    page,
  }) => {
    await clearLearningModeState(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    // FinancialStatements is lazy-loaded — give the bundle parse time.
    await page.waitForTimeout(8_000);

    const coach = page.getByTestId("learning-coach");
    await expect(coach).toBeVisible({ timeout: 5_000 });
    await expect(coach).toContainText(/Learn how CFO AI reads your numbers/i);
    await expect(coach).toContainText(/source accounts in your trial balance/i);

    // CTAs.
    await expect(page.getByTestId("learning-coach-show")).toBeVisible();
    await expect(page.getByTestId("learning-coach-dismiss")).toBeVisible();
  });

  test("Maybe-later dismisses the coach + sticks across reload", async ({
    page,
  }) => {
    await clearLearningModeState(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8_000);

    const coach = page.getByTestId("learning-coach");
    await expect(coach).toBeVisible({ timeout: 5_000 });

    await page.getByTestId("learning-coach-dismiss").click({ force: true });
    // Allow framer-motion exit + persist microtask.
    await page.waitForTimeout(600);
    await expect(coach).not.toBeVisible();

    // Reload — coach must stay dismissed.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5_000);
    await expect(page.getByTestId("learning-coach")).not.toBeVisible();

    // The store flag should be persisted as coachDismissed: true.
    const persisted = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("cfo:learning-mode:v1");
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    });
    expect(persisted).not.toBeNull();
    expect(persisted.coachDismissed).toBe(true);
    // First-time flow also flips guided → subtle so subsequent navigation
    // shows the affordances without intrusive tours.
    expect(persisted.mode).toBe("subtle");
  });
});
