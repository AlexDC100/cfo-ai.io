#!/usr/bin/env node
/**
 * census-probe.mjs — read the LIVE header census at arbitrary widths,
 * without the test runner.
 *
 * The e2e gate prints the same inventory, but it takes ~4 minutes to run
 * the whole suite and only measures the two widths the law names. This
 * sweeps whatever you ask for in ~30 s, which is what you want while
 * moving a control around.
 *
 * It IMPORTS the census from scripts/check_header_law.mjs — it does not
 * restate it. A probe with its own copy of "what counts as a header
 * control" would be a second opinion, and two opinions are how a gate
 * ends up reporting a violation that does not exist.
 *
 * Needs the test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE).
 *
 *   node design_review/header/census-probe.mjs
 *   node design_review/header/census-probe.mjs /chat 1440,1023,375
 */
import { chromium } from "@playwright/test";
import {
  INTERACTIVE_SELECTORS,
  COMPOSITE_SELECTORS,
  headerCensus,
  formatCensus,
} from "../../scripts/check_header_law.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const routes = (process.argv[2] ?? "/dashboard,/chat").split(",");
const widths = (process.argv[3] ?? "1440,1023,900").split(",").map(Number);

const browser = await chromium.launch();
for (const width of widths) {
  for (const route of routes) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(() => {
      window.localStorage.setItem(
        "cfo:learning-mode:v1",
        JSON.stringify({ mode: "subtle", coachDismissed: true, tutorialsSeen: {} }),
      );
    });
    const page = await ctx.newPage();
    await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    const dismiss = page.getByTestId("test-mode-banner-dismiss");
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click().catch(() => {});
      await page.waitForTimeout(300);
    }
    const header = page
      .locator("header")
      .filter({ has: page.locator('[data-testid="account-menu-trigger"]') })
      .first();
    console.log(`\n=== ${width}px  ${route} ===`);
    if ((await header.count()) === 0) {
      console.log("  no app-shell header rendered (signed out?)");
    } else {
      const census = await header.evaluate(headerCensus, {
        selectors: INTERACTIVE_SELECTORS,
        composites: COMPOSITE_SELECTORS,
      });
      console.log(`  count=${census.count}`);
      console.log(formatCensus(census));
      for (const c of census.composites) {
        console.log(
          `  composite ${c.testid ?? c.role}: ${c.children.length} descendant(s) — ` +
            c.children.map((k) => k.testid ?? k.tag).join(", "),
        );
      }
    }
    await ctx.close();
  }
}
await browser.close();
