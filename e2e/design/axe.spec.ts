/**
 * THE INSTRUMENT — gate D1: automated a11y (axe-core).
 *
 * Runs @axe-core/playwright against every app route on the live
 * test-mode stack (vite :5173 + engine :8000, PUBLIC_TEST_MODE) and
 * fails on violations with impact serious or critical. Moderate/minor
 * findings are printed as telemetry but do not fail — the gate exists
 * to stop regressions people cannot use, not to boil the ocean.
 *
 * THE THEME IS NOW NAMED. This spec used to run "in whatever theme the
 * session boots with", and a gate whose subject is decided by ambient
 * state cannot say what it measured: theme is a cross-device preference
 * on the ONE shared PUBLIC_TEST_MODE identity, so "whatever it boots
 * with" is, in principle, whatever anything else left in the shared bag.
 * `seedTheme(page, "light")` pins the localStorage half AND the server
 * half, so this file's name and its subject agree.
 *
 * Measured, so the claim stays the right size: theme was NOT observed to
 * flip today — a `pendingWrites` shadow suppresses adoption for the whole
 * session (see e2e/_helpers.ts). This change buys a stated subject, not a
 * repaired flake.
 *
 * Run: npx playwright test e2e/design/axe.spec.ts
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

// Lazy route bundles + test-mode session boot need a beat before the
// surface is real; mirrors bootDashboard()'s settle in e2e/_helpers.ts.
const SETTLE_MS = 8000;

// NOT serial: a failing route must not stop the report for the rest —
// the config's workers:1 already keeps runs sequential.
test.describe("D1 axe — serious/critical a11y violations", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await seedTheme(page, "light");
  });

  for (const route of ROUTES) {
    test(`axe clean: ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(SETTLE_MS);
      await dismissPublicTestBanner(page);

      const results = await new AxeBuilder({ page })
        // The test-mode banner is not a product surface; if a remnant
        // survives dismissal it must not pollute the gate.
        .exclude('[data-testid="public-test-mode-banner"]')
        .analyze();

      // BEFORE reading the verdict, establish that there was a surface
      // to read it from. axe on a page that painted nothing reports
      // nothing, and this assertion would pass — proven, not assumed
      // (e2e/design/_axeVacuity.ts).
      await assertAxeExaminedTheSurface(page, route, results, "light");

      const gating = results.violations.filter((v) =>
        v.impact === "serious" || v.impact === "critical",
      );
      const advisory = results.violations.filter(
        (v) => v.impact !== "serious" && v.impact !== "critical",
      );

      if (advisory.length) {
        console.log(
          `[axe advisory] ${route}: ${advisory
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
      expect(gating, `serious/critical axe violations on ${route}:\n${detail}`).toEqual([]);
    });
  }
});
