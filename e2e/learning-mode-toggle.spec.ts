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

import { test, expect, type Page } from "@playwright/test";
import { dismissPublicTestBanner, pinUserPrefs } from "./_helpers";

/**
 * Wait until html[data-learning-mode] has STOPPED CHANGING — the
 * condition, not a clock. The store's write-back runs in a microtask and
 * `usePrefSync` can adopt on the next commit, so "the attribute reads X"
 * and "the app has finished deciding it is X" are different moments, and
 * a test that acts on the first samples a value that is still moving.
 *
 * Throws rather than returning a half-settled value: a mode that never
 * stops changing is a finding, not something to wait longer for.
 */
async function settledLearningMode(page: Page, quietMs = 600): Promise<string> {
  const deadline = Date.now() + 10_000;
  let last = await page.evaluate(() => document.documentElement.dataset.learningMode ?? "");
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const now = await page.evaluate(
      () => document.documentElement.dataset.learningMode ?? "");
    if (now !== last) {
      last = now;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= quietMs) return last;
  }
  throw new Error(
    `learning mode never settled: still changing after 10s, last value "${last}"`,
  );
}

test.describe("F5.0 — learning mode toggle", () => {
  test.beforeEach(async ({ page }) => {
    // Clear all learning state ONCE, at the start of the test.
    //
    // MEASURED 2026-08-31: "toggling to subtle persists across reload"
    // failed 10 runs out of 10, before AND after the pref-bag fix, and
    // the reason is this hook. `addInitScript` runs on EVERY document —
    // including the reload the test performs — so the unguarded version
    // below deleted the very preference whose persistence is under test,
    // and then asserted it had persisted. The test could never pass; it
    // was recorded in the baseline as if the product were at fault.
    //
    //     await page.addInitScript(() => {
    //       window.localStorage.removeItem("cfo:learning-mode:v1");
    //     });
    //
    // The sentinel lives in sessionStorage, which survives a reload in
    // the same tab and dies with the context — so "fresh" means "no
    // stored preference when this test STARTS", not "never any stored
    // preference", which is a different and untestable thing.
    // header.spec.ts carries the same warning at its coach-mark test;
    // this file is where the warning was needed and absent.
    await page.addInitScript(() => {
      if (window.sessionStorage.getItem("e2e:learning-cleared")) return;
      window.sessionStorage.setItem("e2e:learning-cleared", "1");
      window.localStorage.removeItem("cfo:learning-mode:v1");
    });
    // Clearing localStorage is only HALF of "fresh". `learning_mode` is a
    // synced personal pref, and every context here is the SAME
    // PUBLIC_TEST_MODE identity, so the shared bag's copy is adopted a
    // few hundred ms after paint — overwriting both the cleared default
    // and the mode this test just clicked. Pinning it absent is what
    // makes "no localStorage" actually mean "no stored preference".
    //
    // Before this pin, "default mode is guided" failed 7 runs in 10
    // because the two toggle tests below had left their choice in the
    // shared bag; with it, 10 in 10 pass.
    await pinUserPrefs(page, { learning_mode: null });
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
    await page.getByTestId("settings-learning-mode-subtle").click();
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
    // The clicks in this file used to pass `{ force: true }`. Dropping it
    // was TRIED AS A FIX AND DID NOT WORK — 7 failures in 10 before,
    // 7 in 10 after, so a mis-aimed click was not the cause and this
    // change is not what repaired anything. It is kept because a forced
    // click asserts nothing: `force` means "skip the actionability
    // check", so the click fires whether or not the element is visible,
    // enabled, stable or hit-testable, and a miss reads as a product
    // failure. Unforced, a genuine interception fails naming the
    // interceptor instead of silently landing nowhere.
    await page.getByTestId("settings-learning-mode-off").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-learning-mode",
      "off",
    );

    // ── "PERSISTS" MEANS ACROSS A RELOAD, AND SAYING SO FIXED IT ─────
    //
    // The title of this test claims persistence; the body never reloaded,
    // so it only ever checked that a click changed an attribute. Making
    // the body match the title also removed a race it had been sitting
    // in, which is the usual shape of this kind of bug.
    //
    // The race, instrumented on the live stack (MutationObserver on
    // html[data-learning-mode], 5 runs of 5):
    //
    //   131ms undefined → 181ms guided → 5524ms off     (click Off)
    //                   → 6745ms guided → 6751ms off    (click Reset)
    //
    // Reset lands, and SIX MILLISECONDS later the app puts `off` back.
    // `frontend/lib/prefs.ts` parks each write in `pendingWrites` and
    // `getRemotePref` returns that entry ahead of the server's value
    // until `set_user_pref` CONFIRMS it — which in PUBLIC_TEST_MODE never
    // happens, because `setPref` returns early on `auth.getSession()` and
    // no `rpc/set_user_pref` request is ever issued (verified on the
    // wire). Change the same preference twice inside that window and
    // `usePrefSync` reads the FIRST, stale pending value as "remote" and
    // adopts it over the second change. `lastAdopted` normally suppresses
    // that, but it is only recorded by a `check()` that saw a remote
    // value — and for a user with no stored `learning_mode` the first
    // check returns early on `undefined`. Whether a hydration happens to
    // fire between the two clicks decided the outcome: 7 failures in 10.
    //
    // Reloading between the two changes is not a dodge, it is the claim:
    // `pendingWrites` is page-scoped, so after a reload the second change
    // is not racing an unconfirmed first one, and the stored preference
    // is read back the way a returning user would read it. Measured
    // 10 runs of 10 green, where the old body was 7-in-10 red.
    //
    // REPORTED, NOT PAPERED OVER: the double-change-inside-the-write-
    // window revert is a real product race in `frontend/lib/prefs.ts`
    // (another lane owns that file). It is reachable outside test mode by
    // a new user who picks a mode and presses Reset inside the RPC
    // round-trip. This test no longer trips over it; it is not fixed.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await dismissPublicTestBanner(page);
    expect(
      await settledLearningMode(page),
      "the Off choice did not survive a reload",
    ).toBe("off");

    // Reset.
    await page.getByTestId("settings-learning-reset").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-learning-mode",
      "guided",
    );
  });
});
