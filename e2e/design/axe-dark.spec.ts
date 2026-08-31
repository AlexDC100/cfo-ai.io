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
  // AND THE MOVEMENT WAS NOT FLAKE. Run ten times against one commit,
  // these ten routes were 10/10 STABLE — every one of them, in both
  // directions. The two that the gate reported as "healed" (/settings,
  // /dashboard/scenarios) had been genuinely FIXED by other lanes since
  // the baseline was recorded; they were stale entries, not a coin
  // flip. "NEW and HEALED in one run" is the flake signature only when
  // one tree is standing still, and this one is not.
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
