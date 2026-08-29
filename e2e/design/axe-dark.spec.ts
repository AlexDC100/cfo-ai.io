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

const SETTLE_MS = 8000;

test.describe("D1 axe (Terminal theme) — serious/critical a11y violations", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("cfoai_theme", "dark");
    });
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
