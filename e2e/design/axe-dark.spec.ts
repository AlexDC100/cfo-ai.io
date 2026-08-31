/**
 * THE INSTRUMENT — gate D1, Terminal (dark) variant.
 *
 * axe.spec.ts runs the app in whatever theme the session boots with (Paper).
 * This spec forces the Terminal theme through next-themes' storage key
 * (`cfoai_theme`, see frontend/theme/ThemeProvider.tsx) BEFORE first paint,
 * then applies the identical serious/critical gate. Added by the AXE lane
 * (2026-08-29) because the base spec had no theme mechanism and several
 * violations (alert-delta opacity, eyebrow-on-wash) only reproduced in dark.
 *
 * Run: npx playwright test e2e/design/axe-dark.spec.ts --project=chromium
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { dismissPublicTestBanner, seedTheme } from "../_helpers";
import { assertAxeExaminedTheSurface } from "./_axeVacuity";

const ROUTES = [
  "/dashboard",
  "/chat",
  "/products",
  "/public-companies",
  "/dashboard/scenarios",
  "/dashboard/variance",
  "/benchmark",
  "/settings",
  "/workspace",
  "/",
];

const SETTLE_MS = 8000;

test.describe("D1 axe (Terminal theme) — serious/critical a11y violations", () => {
  test.setTimeout(60_000);

  // seedTheme pins BOTH halves of the theme — localStorage and the
  // shared identity's `user_prefs.prefs.theme`, which `usePrefSync`
  // would otherwise be free to adopt over the seed.
  //
  // HONEST SCOPE: a hostile-bag control showed theme does NOT currently
  // flip, because an unconfirmed `pendingWrites` entry shadows the
  // server value for the whole session (e2e/_helpers.ts explains why,
  // and why that is an accident of test mode rather than a guarantee).
  // So this pin did not fix the movement seen in these checks — it
  // removes a dependence on that accident.
  //
  // THE PARAGRAPH THAT USED TO BE HERE WAS WRONG, AND IT IS WORTH
  // KEEPING THE CORRECTION. It read: "AND THE MOVEMENT WAS NOT FLAKE.
  // Run ten times against one commit, these ten routes were 10/10
  // STABLE — every one of them, in both directions. The two that the
  // gate reported as 'healed' (/settings, /dashboard/scenarios) had
  // been genuinely FIXED by other lanes since the baseline was
  // recorded; they were stale entries, not a coin flip."
  //
  // RE-MEASURED 2026-08-31, three full gate runs on one commit with no
  // edits between them, plus ten isolated runs per test:
  //
  //     axe clean (dark): /chat      run1 FAIL  run2 PASS  run3 FAIL
  //                                  isolated: 10/10 FAIL
  //
  // So it does move, and it is not a stale entry: alone against this
  // commit it fails every single time. The `⌘J` kbd in the sidebar's
  // Ask-CFO-AI row is 3.2:1 (#b2d4cc on #0e7c6b) and has not been
  // fixed by anybody.
  //
  // The PASS is the anomaly, not the FAIL — and the mechanism is now
  // proven rather than argued: this assertion passes on a page that
  // never rendered. With the app's JS blocked, /dashboard painted 2
  // elements, axe inspected 9 nodes, found 0 violations, and this exact
  // expectation went green. In run 2 four capsule/anchor tests failed
  // in the same run with "selector does not match a real element" — a
  // surface that did not come up. `assertAxeExaminedTheSurface` below
  // is the antibody; see e2e/design/_axeVacuity.ts.
  //
  // "NEW and HEALED in one run" was read here as proof of a moving
  // tree. It can also be a vacuous pass, and telling those apart needs
  // a floor, not an argument.
  test.beforeEach(async ({ page }) => {
    await seedTheme(page, "dark");
  });

  for (const route of ROUTES) {
    test(`axe clean (dark): ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(SETTLE_MS);
      await dismissPublicTestBanner(page);

      const results = await new AxeBuilder({ page })
        .exclude('[data-testid="test-mode-banner"]')
        .analyze();

      // See the note in axe.spec.ts: a surface that never rendered
      // reports zero violations and reads as clean.
      await assertAxeExaminedTheSurface(page, route, results, "dark");

      const gating = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      const advisory = results.violations.filter(
        (v) => v.impact !== "serious" && v.impact !== "critical",
      );

      if (advisory.length) {
        console.log(
          `[axe advisory dark] ${route}: ${advisory
            .map((v) => `${v.id}(${v.impact ?? "?"})x${v.nodes.length}`)
            .join(", ")}`,
        );
      }

      const detail = gating
        .map(
          (v) =>
            `${v.id} [${v.impact}] — ${v.help}\n` +
            v.nodes
              .slice(0, 5)
              .map((n) => `    ${n.target.join(" ")}`)
              .join("\n"),
        )
        .join("\n");
      expect(
        gating,
        `serious/critical axe violations (dark) on ${route}:\n${detail}`,
      ).toEqual([]);
    });
  }
});
