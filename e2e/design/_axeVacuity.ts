/**
 * ANTI-VACUITY for the axe gates (D1 in axe.spec.ts / axe-dark.spec.ts,
 * M6 in modes.spec.ts).
 *
 * THE HOLE, MEASURED 2026-08-31
 * -----------------------------
 * Every axe test in this suite had the same shape:
 *
 *     goto(route); wait 8s; analyze(); expect(serious/critical).toEqual([])
 *
 * and nothing anywhere asserted that the route had actually RENDERED.
 * axe on a page that painted nothing reports nothing, so the assertion
 * passes. Proven rather than reasoned: with the app's JS aborted,
 * `/dashboard` rendered **2 elements** with empty body text, axe
 * inspected **9 nodes**, found **0** serious/critical violations, and
 * axe.spec.ts's exact assertion PASSED.
 *
 * That is the `tsc --noEmit` disease in a11y clothing — a gate that
 * discovers its own inputs, loses them, and still prints green
 * (design_review/FALSE_GREEN_FINDINGS.md). It is not hypothetical here:
 * it produced a WRONG CLOSURE. Across three full gate runs on one commit
 * with no edits, `axe clean: /chat|/dashboard|/products` and
 * `axe clean (dark): /chat` FAILED in runs 1 and 3 and PASSED in run 2 —
 * and in that same run 2, four capsule/anchor tests failed with
 * "selector does not match a real element", the signature of a surface
 * that never came up. Measured alone against the same commit, all four
 * of those axe checks are **10/10 FAIL**. So the run-2 "healed" reading
 * was a vacuous pass, and a previous lane, reading exactly such a run,
 * concluded the baseline entries were stale and the tests fixed. They
 * are not fixed; the sidebar's `⌘J` kbd is 3.2:1 on brand green.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS SHAPED THIS WAY
 * ------------------------------------------------
 * Two independent signals, both recorded PER ROUTE, both asserted AFTER
 * `analyze()` — never inside the discovery that produced the number:
 *
 *   1. A CANARY THAT NAMES AN ELEMENT. `sidebar-chat` is the app-shell
 *      row that only exists once the authed shell has mounted. Measured
 *      present exactly once on all ten routes. It is deliberately the
 *      element that CARRIES one of the live violations, so a page that
 *      can satisfy this canary is a page on which "clean" means
 *      something.
 *   2. A FLOOR THAT NAMES A NUMBER — how many nodes axe actually
 *      inspected (passes + violations + incomplete). A canary alone can
 *      survive a half-rendered shell with an empty main; a floor alone
 *      can be cleared by chrome with no page under it. Neither is
 *      sufficient, which is why both are here.
 *
 *   3. A FLOOR THAT NAMES THE CONTENT REGION — how many elements the
 *      route's `<main>` holds. Signals 1 and 2 are BOTH satisfiable by
 *      the APP SHELL alone, and that is measured, not feared. With
 *      `<main>` emptied on the live stack (2026-09-01, dark), four
 *      routes were probed directly and all four still cleared both
 *      checks above, i.e. the gate reported "axe clean" with the entire
 *      content region deleted:
 *
 *        route        shell-only nodes   page floor   verdict then
 *        /dashboard         289             280       PASSED
 *        /benchmark         289             130       PASSED
 *        /chat              294             190       PASSED (guard)
 *        /workspace         295             220       PASSED
 *
 *      The canary LIVES in that shell, so it cannot see this either. A
 *      floor on the page total is a floor on a SUM, and the shell is an
 *      addend big enough to carry it. Holding that measured ~290 against
 *      the other six recorded floors: / (280) and /dashboard/scenarios
 *      (260) would also have passed — inferred, not probed — while
 *      /products (320), /dashboard/variance (320), /settings (450) and
 *      /public-companies (1000) would have been caught by the page
 *      floor. Six of ten blind, four of those six measured directly.
 *      That is TC-6 exactly: a floor on a sum cannot see one addend
 *      collapse. So the content region gets its own recorded
 *      expectation, and it is plant-proven per route.
 *
 * A route with NO recorded floor — in EITHER table — THROWS rather than
 * checking nothing. An unrecorded route is exactly how the next surface
 * joins the gate un-floored and goes dark for free, and a route added to
 * one table but not the other is half-floored, which reads as covered.
 *
 * THE NUMBERS ARE MEASURED, NOT GUESSED
 * -------------------------------------
 * Inspected-node counts on the live test-mode stack, 2026-08-31, in all
 * four states the three specs cover (Pro/light, Pro/dark, Simple/light,
 * Simple/dark). The floor is ~40% of the LOWEST of the four, rounded
 * down to a round number:
 *
 *   route                  pro/lt pro/dk sim/lt sim/dk  min   floor
 *   /dashboard               701    709    732    740    701    280
 *   /chat                    482    490    513    521    482    190
 *   /products                799    807    830    838    799    320
 *   /public-companies       2716   2932   2955   2963   2716   1000
 *   /dashboard/scenarios     670    678    701    709    670    260
 *   /dashboard/variance      823    831    854    862    823    320
 *   /benchmark               344    352    375    383    344    130
 *   /settings               1132   1140   1163   1171   1132    450
 *   /workspace               565    573    596    604    565    220
 *   /                        701    709    732    740    701    280
 *
 * The margin is wide on purpose. This is a COLLAPSE detector, not a
 * ratchet on page weight: content changes must never turn it red, or
 * the next reader learns to ignore it. Every floor is still at least
 * 14x the 9 nodes the proven-vacuous run examined, so the gap it has to
 * discriminate is two orders of magnitude, not a few percent.
 *
 * CONTENT-REGION counts, same stack, same four states, 2026-09-01 —
 * `document.querySelector("main").querySelectorAll("*").length`. The
 * unit deliberately differs from the page floor above: this one asks
 * whether the ROUTE'S OWN CONTENT exists, and a DOM count answers that
 * without a second axe pass and without depending on which rules axe
 * happens to cover. The spread across the four states is ZERO on nine
 * of ten routes (only /public-companies moves, 1343 -> 1346), so the
 * 40% floor here is even more slack than it looks:
 *
 *   route                  pro/lt pro/dk sim/lt sim/dk  min   floor
 *   /dashboard               165    165    165    165    165     60
 *   /chat                    123    123    123    123    123     45
 *   /products                310    310    310    310    310    120
 *   /public-companies       1343   1343   1346   1346   1343    500
 *   /dashboard/scenarios     216    216    216    216    216     80
 *   /dashboard/variance      396    396    396    396    396    150
 *   /benchmark                46     46     46     46     46     15
 *   /settings                415    415    415    415    415    160
 *   /workspace                80     80     80     80     80     30
 *   /                        165    165    165    165    165     60
 */
import { expect, type Page } from "@playwright/test";

/** Structural shape of `new AxeBuilder(...).analyze()`'s result. Typed
 *  here rather than imported so this file adds no new dependency. */
type AxeRuleResultLike = { nodes: unknown[] };
export type AxeResultsLike = {
  passes: AxeRuleResultLike[];
  violations: AxeRuleResultLike[];
  incomplete: AxeRuleResultLike[];
};

/** The app-shell row. Measured present exactly once on all ten routes,
 *  in every one of the four states, 2026-08-31. */
export const SHELL_CANARY = '[data-testid="sidebar-chat"]';

/** Per-route floor on nodes axe actually inspected. See the table above
 *  for the measurements these are derived from. */
export const AXE_NODE_FLOORS = new Map<string, number>([
  ["/dashboard", 280],
  ["/chat", 190],
  ["/products", 320],
  ["/public-companies", 1000],
  ["/dashboard/scenarios", 260],
  ["/dashboard/variance", 320],
  ["/benchmark", 130],
  ["/settings", 450],
  ["/workspace", 220],
  ["/", 280],
]);

/** The route's content region. The canary above lives in the SHELL, and
 *  so does most of the node count, so neither can speak for this. */
export const MAIN_REGION = "main";

/** Per-route floor on elements inside `<main>`. See the second table
 *  above for the measurements these are derived from. */
export const AXE_MAIN_FLOORS = new Map<string, number>([
  ["/dashboard", 60],
  ["/chat", 45],
  ["/products", 120],
  ["/public-companies", 500],
  ["/dashboard/scenarios", 80],
  ["/dashboard/variance", 150],
  ["/benchmark", 15],
  ["/settings", 160],
  ["/workspace", 30],
  ["/", 60],
]);

/** Nodes axe actually looked at, across every rule outcome. */
export function axeNodesExamined(results: AxeResultsLike): number {
  const bags = [results.passes, results.violations, results.incomplete];
  return bags.reduce(
    (total, bag) =>
      total + (bag ?? []).reduce((n, rule) => n + (rule.nodes?.length ?? 0), 0),
    0,
  );
}

/**
 * Assert that "no violations" would be a fact about the surface rather
 * than a fact about an empty page. Call AFTER `analyze()` and BEFORE the
 * violations assertion, so a collapsed surface fails as a collapse
 * instead of passing as a clean bill of health.
 *
 * `label` names the state under test (e.g. "dark", "simple/light") so
 * the failure says which of the four axe postures went hollow.
 */
export async function assertAxeExaminedTheSurface(
  page: Page,
  route: string,
  results: AxeResultsLike,
  label: string,
): Promise<void> {
  const floor = AXE_NODE_FLOORS.get(route);
  if (floor === undefined) {
    throw new Error(
      `[axe vacuity] ${label} ${route}: no recorded floor for this route. A `
      + 'route with no recorded expectation can collapse to a blank page and '
      + 'still report "axe clean". Measure it on the live stack and add it to '
      + 'AXE_NODE_FLOORS in e2e/design/_axeVacuity.ts — do not delete this '
      + 'check to get past it.',
    );
  }

  const mainFloor = AXE_MAIN_FLOORS.get(route);
  if (mainFloor === undefined) {
    throw new Error(
      `[axe vacuity] ${label} ${route}: no recorded CONTENT-REGION floor for this `
      + 'route. It has a page-total floor but none for its `<main>`, so it is '
      + 'half-floored: the app shell alone examines ~290 nodes and would carry '
      + 'the page floor with the content region deleted. Measure it on the live '
      + 'stack and add it to AXE_MAIN_FLOORS in e2e/design/_axeVacuity.ts.',
    );
  }

  const shell = await page.locator(SHELL_CANARY).count();
  expect(
    shell,
    `[axe vacuity] ${label} ${route}: the app-shell canary ${SHELL_CANARY} did `
    + 'not render, so "no serious/critical violations" would mean "nothing was '
    + 'examined", not "the surface is clean". Measured present exactly once on '
    + 'all ten routes — its absence means the page never came up.',
  ).toBeGreaterThan(0);

  const examined = axeNodesExamined(results);
  expect(
    examined,
    `[axe vacuity] ${label} ${route}: axe inspected ${examined} node(s), floor `
    + `${floor}. A proven-vacuous run of this exact assertion inspected 9 nodes `
    + 'on a /dashboard that painted nothing and PASSED. This surface did not '
    + 'render enough for a clean result to mean anything.',
  ).toBeGreaterThanOrEqual(floor);

  const mainCount = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.querySelectorAll("*").length : -1;
  }, MAIN_REGION);
  expect(
    mainCount,
    `[axe vacuity] ${label} ${route}: the content region <${MAIN_REGION}> holds `
    + `${mainCount < 0 ? "no element at all" : `${mainCount} element(s)`}, floor `
    + `${mainFloor}. The two checks above are BOTH satisfiable by the app shell `
    + 'alone — measured: with <main> emptied, four probed routes still examined '
    + '289-295 nodes and still carried the canary, which lives in that shell, and '
    + 'all four still reported "axe clean". So this '
    + "route's own content did not render, and a clean axe result here is a fact "
    + 'about the chrome, not about the surface under test.',
  ).toBeGreaterThanOrEqual(mainFloor);
}
