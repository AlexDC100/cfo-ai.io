/**
 * Shared Playwright helpers. Imported by every e2e spec that interacts
 * with prod (the `--project=prod` posture).
 *
 * Why this exists:
 *   PUBLIC_TEST_MODE renders a sticky amber banner across the top of
 *   every page (`test-mode-banner`). Production users never see it,
 *   but Playwright tests do — and the banner sits above every clickable
 *   surface in the top-right corner (glossary trigger, account menu,
 *   sidebar buttons). When a test calls `.click()` on one of those
 *   elements, the banner intercepts the pointer event and the click
 *   silently fails with the "subtree intercepts pointer events" message.
 *
 *   The fix is to dismiss the banner once per page navigation, before
 *   any test-specific interaction. That's `dismissPublicTestBanner()`.
 *
 *   TEST-DEBT (2026-06-13) — this helper was extracted after 16
 *   auxiliary F5.0 specs failed at the suite level because each spec
 *   had to re-discover the banner-intercept pattern. Centralising
 *   keeps the contract uniform.
 */
import type { Page } from "@playwright/test";

/**
 * Click the dismiss "×" on the public-test-mode banner if it is
 * visible. No-op when the banner isn't there (test mode disabled,
 * already dismissed in a prior step). Idempotent.
 *
 * After dismissing, also presses Escape so any auto-opened page-guide
 * overlay clears — the GUIDE ME flow in some specs uses the same
 * keystroke and we don't want stray Escapes interfering mid-test.
 */
export async function dismissPublicTestBanner(page: Page): Promise<void> {
  const dismiss = page.getByTestId("test-mode-banner-dismiss");
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click().catch(() => {});
    // Allow the slide-out animation + state commit before downstream
    // interactions reach for the now-revealed surface beneath.
    await page.waitForTimeout(300);
  }
  // NB: we deliberately do NOT press Escape here. An earlier version
  // did, but Escape closes the PageGuideOverlay on open and breaks
  // guide-trigger specs. Tests that need the LearningCoach gone
  // should pre-seed `cfo:learning-mode:v1` with
  // `{ mode: "subtle", coachDismissed: true }` (see preseedLearningMode).
}

/**
 * Pre-seed the learning-mode persistence so the LearningCoach card
 * doesn't render. Required for any spec that interacts with the top-
 * row dashboard surfaces — the coach is mounted right where guide
 * triggers and KPI tiles live, and its sparkle animation can intercept
 * clicks.
 */
export async function preseedLearningMode(
  page: Page,
  mode: "guided" | "subtle" | "off" = "subtle",
): Promise<void> {
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

/**
 * Open the dashboard in a banner-dismissed, hydrated state. Common
 * preamble for any spec that needs to interact with a tab or KPI tile.
 * Waits the standard 8 s lazy-bundle load before returning so the
 * caller can reach for testids immediately.
 */
export async function bootDashboard(
  page: Page,
  searchParams: string = "",
): Promise<void> {
  await page.goto(`/dashboard${searchParams}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  await dismissPublicTestBanner(page);
}
