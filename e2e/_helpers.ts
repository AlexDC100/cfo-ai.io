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
import type { Page, Route } from "@playwright/test";

// ══════════════════════════════════════════════════════════════════════
// THE SHARED PREFERENCE BAG — why seeding localStorage is not enough
// ══════════════════════════════════════════════════════════════════════
//
// MEASURED 2026-08-31. Every browser context in this suite authenticates
// as the SAME PUBLIC_TEST_MODE identity — user
// `00000000-0000-4000-8000-000000000001`, org `…-000000000002`
// (src/engine/api/_test_mode.py: "The fixed test user"). That identity
// owns ONE `user_prefs.prefs` row, and the app treats it as a
// cross-device preference bag: `frontend/lib/prefs.ts::usePrefSync`
// hydrates it a few hundred ms after first paint and ADOPTS any value
// that differs from what is on screen.
//
// So a spec that seeds only localStorage has pinned HALF the state, and
// the other half — shared by all 35 spec files and by every previous run
// of this suite — silently overrides it. Traced on the live stack:
//
//     seed cfo-view-mode-v1=pro
//       0ms   class="light"  viewMode=pro
//       500ms class="light"  viewMode=simple      ← adopted from the bag
//
// The bag at the time of writing held
// `{theme:"light", view_mode:"simple", learning_mode:{mode:"guided",…}}`.
// `modes.spec.ts`'s Pro test seeds `pro`, is reverted to `simple` at
// ~500 ms, and then asserts the Pro surface on a Simple page.
//
// WHAT THIS COST, in measured runs of ten:
//
//   modes.spec  M5 "Pro dashboard keeps the classic overview"
//                        10/10 FAIL  →  0/10 FAIL
//   learning-mode-toggle "default mode is guided"
//                         7/10 FAIL  →  0/10 FAIL
//
// Note the shapes. view_mode never had a defence: `seedMode` wrote
// localStorage directly, so `setPref` was never called and no pending
// write ever shadowed the bag — adoption won every time, and the test
// was 10-for-10 red in isolation while passing in the full suite, which
// is the worst possible signal to hand a reader. learning_mode had a
// PARTIAL defence and so was genuinely intermittent: the store's mount
// run deliberately skips the write-back (`firstPersistRef`), leaving the
// local value unshadowed until the user changes it, and the outcome then
// turned on whether a hydration happened to land first.
//
// THEME IS THE EXCEPTION, AND THE REASON IS AN ACCIDENT. A control was
// run before believing the obvious story: a bag serving the OPPOSITE of
// the seed, forced deterministically rather than raced. view_mode and
// learning_mode both flipped. Theme did NOT — and that refuted the first
// version of this comment, which had blamed theme for the four axe
// movers.
//
// Why theme survives: `ThemePrefSync` calls `setPref("user","theme",…)`
// on mount, which parks the value in `prefs.ts`'s `pendingWrites` map,
// and `getRemotePref` returns a pending write in preference to the
// server's value. The entry is cleared only when `set_user_pref`
// CONFIRMS — and in PUBLIC_TEST_MODE that RPC never fires at all
// (`setPref` returns early on `auth.getSession()`; no `rpc/set_user_pref`
// request appears on the wire in a 12 s trace). So the pending entry is
// never cleared and adoption is suppressed forever.
//
// That is protection by accident, not by design: it lasts exactly as
// long as the write path stays broken in test mode. `seedTheme` pins the
// theme anyway so the a11y gates do not depend on that accident — but it
// is PROPHYLACTIC. It is not the fix for anything measured today, and it
// should not be credited with one.
//
// The fix is NOT a longer wait: waiting longer makes adoption MORE
// likely, not less. It is to pin the OTHER half of the state, so the
// value the spec seeds and the value the app hydrates cannot disagree.
// `pinUserPrefs` rewrites the bag ON THE WIRE for the pinned keys only —
// every other key (org decision rules, currency, scenario levers) passes
// through untouched, so nothing else about the session changes.

/** The PERSONAL bag read. Deliberately NOT the `select=active_org_id`
 *  read on the same table: workspace resolution must keep working. */
const USER_PREFS_BAG_RE = /\/rest\/v1\/user_prefs\?.*\bselect=prefs\b/;
/** The COMPANY bag read — display currency, decision rules, levers. */
const ORG_PREFS_BAG_RE = /\/rest\/v1\/org_prefs\?.*\bselect=prefs\b/;

/** Pins installed per page and scope, so repeated calls merge instead of
 *  racing, and one route per scope stays installed. */
const pinnedPrefs = new WeakMap<Page, Partial<Record<PrefScope, Record<string, unknown>>>>();

type PrefScope = "user" | "org";

async function fulfilPinned(
  route: Route,
  pins: Record<string, unknown>,
): Promise<void> {
  let response;
  try {
    response = await route.fetch();
  } catch {
    // The real read failed (offline, aborted). Let the app see that
    // rather than inventing a bag it never received.
    await route.continue().catch(() => {});
    return;
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const wasArray = Array.isArray(payload);
  const row = (wasArray ? (payload as unknown[])[0] : payload) as
    | Record<string, unknown>
    | null
    | undefined;
  const prefs: Record<string, unknown> = {
    ...(((row?.prefs as Record<string, unknown>) ?? {}) as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(pins)) {
    // `null` means "this key is ABSENT for this test" — the app then uses
    // its own default instead of adopting anything.
    if (value === null) delete prefs[key];
    else prefs[key] = value;
  }
  const merged = { ...(row ?? {}), prefs };
  await route.fulfill({ response, json: wasArray ? [merged] : merged });
}

/**
 * Pin keys inside the shared `user_prefs.prefs` bag for this page only.
 *
 * Pass a value to force it; pass `null` to make the key ABSENT so the app
 * falls back to its own default and adopts nothing. Safe to call more
 * than once per page — the pins merge and one route stays installed.
 *
 * Must be called BEFORE the navigation whose hydration it governs.
 */
export async function pinUserPrefs(
  page: Page,
  pins: Record<string, unknown>,
): Promise<void> {
  await pinPrefs(page, "user", pins);
}

/**
 * The same thing for the COMPANY bag, `org_prefs.prefs` — display
 * currency, decision rules, scenario levers, dashboard view.
 *
 * The single shared test org makes this exactly as leaky as the personal
 * one, and the shapes match: header.spec's "currency persists across
 * reload" clicks EUR, the click writes localStorage and calls
 * `setPref("org", …)` whose RPC never confirms in test mode, and after
 * the reload — which discards the page-scoped `pendingWrites` that had
 * been shadowing the server value — the bag's older currency is adopted
 * back over the localStorage the test is asserting on. Measured on the
 * unmodified tree: 5 failures in 6.
 */
export async function pinOrgPrefs(
  page: Page,
  pins: Record<string, unknown>,
): Promise<void> {
  await pinPrefs(page, "org", pins);
}

async function pinPrefs(
  page: Page,
  scope: PrefScope,
  pins: Record<string, unknown>,
): Promise<void> {
  const byScope = pinnedPrefs.get(page) ?? {};
  pinnedPrefs.set(page, byScope);
  const existing = byScope[scope];
  if (existing) {
    Object.assign(existing, pins);
    return;
  }
  const bag: Record<string, unknown> = { ...pins };
  byScope[scope] = bag;
  const re = scope === "user" ? USER_PREFS_BAG_RE : ORG_PREFS_BAG_RE;
  await page.route(
    (url) => re.test(url.toString()),
    (route) => fulfilPinned(route, bag),
  );
}

/**
 * Seed the theme the way the app itself stores it (next-themes'
 * `cfoai_theme`) AND pin the server half, so the adoption race cannot
 * repaint the page mid-test.
 *
 * `null` seeds nothing and pins the key absent — "boot in the app's own
 * default theme", which is what the light-theme gates actually mean.
 */
export async function seedTheme(
  page: Page,
  theme: "light" | "dark" | null,
): Promise<void> {
  if (theme) {
    await page.addInitScript((t) => {
      window.localStorage.setItem("cfoai_theme", t);
    }, theme);
  }
  await pinUserPrefs(page, { theme });
}

/**
 * Seed the view mode (`lib/viewMode.ts`'s `cfo-view-mode-v1`) AND pin the
 * server half. Without the pin the bag reverts the seed ~500 ms in.
 *
 * `null` pins the key absent, so `defaultMode()` decides — the right
 * posture for a test about what a fresh visitor sees.
 */
export async function seedViewMode(
  page: Page,
  mode: "simple" | "pro" | null,
): Promise<void> {
  if (mode) {
    await page.addInitScript((m) => {
      window.localStorage.setItem("cfo-view-mode-v1", m);
    }, mode);
  }
  await pinUserPrefs(page, { view_mode: mode });
}

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
  const state = { mode, coachDismissed: true, tutorialsSeen: {} };
  await page.addInitScript((s) => {
    window.localStorage.setItem("cfo:learning-mode:v1", JSON.stringify(s));
  }, state);
  // The other half. `learning_mode` is a PERSONAL pref on the shared test
  // identity, so without this the bag's copy is adopted a few hundred ms
  // in and the coach this seed exists to suppress comes back.
  await pinUserPrefs(page, { learning_mode: state });
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
