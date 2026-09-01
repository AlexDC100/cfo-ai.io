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
 *   /benchmark                46     46     46     46     46     30  (was 15)
 *   /settings                415    415    415    415    415    160
 *   /workspace                80     80     80     80     80     30
 *   /                        165    165    165    165    165     60
 *
 * ══ A FOURTH SIGNAL: THE FLOOR PASSED ON A CRASHED ROUTE ══════════════
 *
 * MEASURED 2026-09-01 on the live test-mode stack. Everything above
 * asks "did enough render?". Nothing asked "is what rendered the PAGE,
 * or the ERROR CARD?" — and the two are not distinguishable by count,
 * because `RouteErrorBoundary` (App.tsx:447, keyed by pathname, mounted
 * INSIDE `<main>`) paints a real, substantial card.
 *
 * Forced by blocking each route's lazy chunk, then measured exactly
 * what this helper measures:
 *
 *   route (crashed)   main   axe nodes   shell canary   recorded floors
 *   /benchmark          21        343       present      15 / 130  PASSED
 *   /workspace          21        343       present      30 / 220  (main red)
 *   /chat               21        342       present      45 / 190  (main red)
 *
 * So `/benchmark` — floor 15, the lowest in the table, because the route
 * is genuinely thin — reported **"axe clean"** with its entire content
 * replaced by "This page needs a refresh". The shell canary lives in the
 * shell and survives; the node floor of 130 is cleared 2.6x over by the
 * shell alone; and 21 > 15. Three signals, all green, on a broken page.
 * Note the crash also carried ONE serious violation today (the shell's
 * own contrast), so the spec still went red — for the WRONG REASON. When
 * that contrast debt is paid, the crash reports clean.
 *
 * The error card's size, both branches, measured rather than reasoned:
 *
 *   ChunkLoadError branch (no dev <pre>)          main = 21
 *   render-throw branch   (dev <pre> stack)       main = 22
 *
 * TWO fixes, because either alone is the failure this file exists to
 * document:
 *
 *   1. AN EXACT DISCRIMINATOR, not arithmetic. `ERROR_CARD` names the
 *      one element the boundary always paints. A count-based check can
 *      only ever be lucky about this; a named element cannot. It also
 *      catches the crash on routes whose floors happen to sit above 22
 *      today, and on every route added later.
 *   2. NO FLOOR MAY SIT BELOW THE ERROR CARD. `/benchmark` goes 15 -> 30
 *      (above the measured 22 by 8, and 65% of its healthy 46 — tighter
 *      slack than the 40% convention, which is the price of a route this
 *      thin), and the rule is enforced MECHANICALLY per route below, so
 *      the next surface cannot join the table under 22 and read as
 *      covered.
 *
 * A named anchor in product code is itself a stale-anchor hazard — the
 * exact disease `scripts/check_stale_gates.mjs` hunts — so the anchor is
 * PROVEN AGAINST ITS SOURCE on every call: if the testid is renamed or
 * the component moves, this throws instead of quietly discriminating
 * nothing.
 */
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
  // 15 -> 30. At 15 this route reported "axe clean" with its content
  // region replaced by the RouteErrorBoundary card (measured: 21
  // elements). 30 clears the card's measured maximum of 22 by 8.
  ["/benchmark", 30],
  ["/settings", 160],
  ["/workspace", 30],
  ["/", 60],
]);

// ══════════════════════════════════════════════════════════════════════
// THE CRASHED-ROUTE DISCRIMINATOR
// ══════════════════════════════════════════════════════════════════════

/** The one element `RouteErrorBoundary` always paints in its error
 *  branch — both the ChunkLoadError and the render-throw variants. */
export const ERROR_CARD = '[data-testid="route-error-clear-restart"]';

/** The component that renders it. Named so the anchor can be proven
 *  against its source rather than trusted. */
export const ERROR_CARD_SOURCE = "frontend/components/cfo/RouteErrorBoundary.tsx";

/** Elements the error card puts inside `<main>`. MEASURED 2026-09-01:
 *  21 on the ChunkLoadError branch, 22 on the render-throw branch (the
 *  dev-only `<pre>` stack). The maximum is what a floor has to beat. */
export const ERROR_CARD_MAIN_ELEMENTS = 22;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let anchorProven = false;

/**
 * Prove the discriminator still names something real.
 *
 * A guard keyed to a `data-testid` in product code is a stale anchor
 * waiting to happen: rename the attribute and this file goes on
 * asserting `count === 0` forever, which is trivially true and reads
 * green. Cheap to prevent — read the component and look for the
 * literal. Once per process; the file does not change mid-run.
 */
export function assertErrorCardAnchorIsReal(): void {
  if (anchorProven) return;
  const file = path.join(REPO_ROOT, ERROR_CARD_SOURCE);
  let src = "";
  try {
    src = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `[axe vacuity] cannot read ${ERROR_CARD_SOURCE}. The crashed-route `
      + 'discriminator is anchored to that component; if it moved, this guard '
      + 'is asserting the absence of an element nothing can render — a stale '
      + 'anchor, which passes for free. Point ERROR_CARD_SOURCE at the '
      + "boundary's new home in e2e/design/_axeVacuity.ts.",
    );
  }
  // The FULL attribute literal, closing quote included. A bare substring
  // check is not enough and that is measured, not feared: planting
  // `data-testid="route-error-clear-restart-RENAMED"` left
  // `includes("route-error-clear-restart")` TRUE, so the first draft of
  // this guard passed while `ERROR_CARD` matched nothing — a stale
  // anchor certified by its own anti-stale-anchor check.
  if (!src.includes('data-testid="route-error-clear-restart"')) {
    throw new Error(
      `[axe vacuity] ${ERROR_CARD_SOURCE} no longer contains the testid `
      + `"route-error-clear-restart" that ${ERROR_CARD} matches. The guard `
      + 'that tells a crashed route from a rendered one is now anchored to '
      + 'nothing and would pass on every page, broken or not. Re-anchor it on '
      + "whatever the error branch renders now — do not delete the check.",
    );
  }
  anchorProven = true;
}

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

  // THE FLOOR MUST BEAT THE ERROR CARD, mechanically, per route.
  // `/benchmark` sat at 15 and reported "axe clean" on a crashed route
  // for exactly this reason. Enforcing it here rather than in a comment
  // is what stops the next thin route from joining the table under the
  // card's size and reading as covered.
  if (mainFloor <= ERROR_CARD_MAIN_ELEMENTS) {
    throw new Error(
      `[axe vacuity] ${label} ${route}: its content-region floor is ${mainFloor}, `
      + `at or below the ${ERROR_CARD_MAIN_ELEMENTS} elements RouteErrorBoundary `
      + 'paints inside <main> (measured: 21 on the ChunkLoadError branch, 22 on '
      + 'the render-throw branch). A floor that low cannot tell this route from '
      + 'a crashed one — which is not hypothetical: /benchmark at 15 PASSED with '
      + 'its whole content region replaced by "This page needs a refresh". Raise '
      + 'the floor above ' + `${ERROR_CARD_MAIN_ELEMENTS}` + ' in AXE_MAIN_FLOORS, '
      + 'or if this route\'s real content is genuinely smaller than the error '
      + 'card, say so here explicitly — do not lower the constant.',
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

  // IS WHAT RENDERED THE PAGE, OR THE ERROR CARD? Asked BEFORE the
  // content floor so a crash is diagnosed as a crash rather than as a
  // thin page — and asked at all because no count can answer it.
  assertErrorCardAnchorIsReal();
  const errorCards = await page
    .locator(`${MAIN_REGION} ${ERROR_CARD}`)
    .count();
  expect(
    errorCards,
    `[axe vacuity] ${label} ${route}: the content region <${MAIN_REGION}> holds `
    + `the RouteErrorBoundary card (${ERROR_CARD}), so this route THREW and what `
    + 'axe examined is an error card, not the surface under test. Measured '
    + '2026-09-01: a crashed route still carries the shell canary, still '
    + 'examines ~343 axe nodes, and still paints 21-22 elements in <main> — '
    + 'enough to clear /benchmark\'s old floor of 15 and report "axe clean" on '
    + 'a broken page.',
  ).toBe(0);

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
