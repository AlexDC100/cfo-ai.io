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
 * A route with NO recorded floor THROWS rather than checking nothing —
 * an unrecorded route is exactly how the next surface joins the gate
 * un-floored and goes dark for free.
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
}
