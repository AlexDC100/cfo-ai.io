#!/usr/bin/env node
/**
 * Market-tab shot probe — supplements scripts/design_shots.mjs for THIS
 * surface, which has a state per market tab that the route-level harness
 * cannot reach (it captures one URL per route).
 *
 * Two registry states are captured, because both are real:
 *
 *   --registry bundled   the engine does not answer /api/public/markets
 *                        (the local :8000 process predates the spine
 *                        lane). The page falls back to the bundled
 *                        registry mirror: full tab strip, holdings
 *                        unknown. This is DOD3's state.
 *   --registry live      the route's REAL body, captured in-process from
 *                        engine.public_market.router and replayed via
 *                        page.route(). Not a hand-written mock: the same
 *                        bytes the deployed API returns, with the real
 *                        entities_held counts.
 *
 * Usage:
 *   node design_review/markets/ui-shots.mjs --label markets-r2 \
 *        --registry live --registry-body /path/registry_live.json
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const arg = (n, d) => {
  const i = ARGS.indexOf("--" + n);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

const LABEL = arg("label", "markets-adhoc");
const BASE = arg("base", "http://localhost:5173");
const REGISTRY = arg("registry", "bundled");
const BODY_PATH = arg("registry-body", null);
// Optional: a real company document body, replayed so the document view
// can be reviewed even when the spine store is empty on this machine.
const COMPANY_BODY_PATH = arg("company-body", null);
const COMPANY_TICKER = arg("company-ticker", "AAPL");
const TABS = arg("tabs", "ro,us,europe,cn,ae,all").split(",");
const THEMES = (arg("theme", "dark") === "both" ? ["light", "dark"] : [arg("theme", "dark")]);

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
];

const outDir = join("design_review", LABEL);
mkdirSync(outDir, { recursive: true });

const registryBody =
  REGISTRY === "live" && BODY_PATH ? readFileSync(BODY_PATH, "utf-8") : null;
const companyBody = COMPANY_BODY_PATH
  ? readFileSync(COMPANY_BODY_PATH, "utf-8")
  : null;
if (REGISTRY === "live" && !registryBody) {
  console.error("--registry live needs --registry-body <file.json>");
  process.exit(1);
}

const browser = await chromium.launch();
for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    // Pin the theme BEFORE first paint: setting it after load lets the
    // theme provider re-hydrate from storage and win the race, which is
    // how an r2 run captured light shots under `--theme dark`.
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem("theme", t);
      } catch {}
    }, theme);
    const page = await ctx.newPage();
    if (registryBody) {
      await page.route("**/api/public/markets", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: registryBody,
        }),
      );
    }
    for (const tab of TABS) {
      const url = `${BASE}/public-companies${tab === "ro" ? "" : `?market=${tab}`}`;
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      } catch {
        /* polling pages can starve networkidle; capture anyway */
      }
      await page.evaluate((t) => {
        try {
          localStorage.setItem("theme", t);
        } catch {}
        const root = document.documentElement;
        root.classList.remove("light", "dark");
        root.classList.add(t);
        root.style.colorScheme = t;
      }, theme);
      await page.waitForTimeout(300);
      try {
        const d = page.getByTestId("test-mode-banner-dismiss");
        if (await d.isVisible({ timeout: 600 })) await d.click();
      } catch {}
      await page.waitForTimeout(500);
      const name = `tab-${tab}--${vp.name}--${theme}--${REGISTRY}.png`;
      await page.screenshot({
        path: join(outDir, name),
        fullPage: vp.name !== "mobile-390",
      });
      process.stdout.write(`shot ${name}\n`);

      // Document view: replay a real company body and drive the lookup.
      if (companyBody && tab === "us") {
        await page.route("**/api/public/markets/company/**", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: companyBody,
          }),
        );
        try {
          await page.getByTestId("market-ticker-input-us").fill(COMPANY_TICKER);
          await page.getByTestId("market-ticker-submit-us").click();
          await page.waitForSelector('[data-testid^="market-document-"]', {
            timeout: 8000,
          });
          await page.waitForTimeout(300);
          const docName = `tab-us-document--${vp.name}--${theme}--${REGISTRY}.png`;
          await page.screenshot({
            path: join(outDir, docName),
            fullPage: vp.name !== "mobile-390",
          });
          process.stdout.write(`shot ${docName}\n`);
        } catch (e) {
          process.stdout.write(`document shot failed: ${e.message}\n`);
        }
        await page.unroute("**/api/public/markets/company/**");
      }
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`\nDONE -> ${outDir}`);
