/**
 * THE INSTRUMENT — gate D1: automated a11y (axe-core).
 *
 * Runs @axe-core/playwright against every app route on the live
 * test-mode stack (vite :5173 + engine :8000, PUBLIC_TEST_MODE) and
 * fails on violations with impact serious or critical. Moderate/minor
 * findings are printed as telemetry but do not fail — the gate exists
 * to stop regressions people cannot use, not to boil the ocean.
 *
 * Run: npx playwright test e2e/design/axe.spec.ts
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { dismissPublicTestBanner } from "../_helpers";

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

  for (const route of ROUTES) {
    test(`axe clean: ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(SETTLE_MS);
      await dismissPublicTestBanner(page);

      const results = await new AxeBuilder({ page })
        // The test-mode banner is not a product surface; if a remnant
        // survives dismissal it must not pollute the gate.
        .exclude('[data-testid="test-mode-banner"]')
        .analyze();

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
