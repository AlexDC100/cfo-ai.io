#!/usr/bin/env node
/**
 * THE DIAL — mode-aware screenshot loop for the entry-points lane.
 *
 * Same harness as scripts/design_shots.mjs, plus a VIEW-MODE dimension:
 * cfo-view-mode-v1 is stamped via addInitScript so React reads the mode
 * on first paint (stamping after load would only apply on re-render).
 *
 * Usage:
 *   node design_review/modes/entry-shots.mjs --label entry-r1 \
 *     --routes /chat,/dashboard/scenarios --theme both --mode both
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
function arg(name, dflt) {
  const i = ARGS.indexOf("--" + name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
}

const LABEL = arg("label", "entry-adhoc");
const BASE = arg("base", "http://localhost:5173");
const THEME = arg("theme", "both");
const MODE = arg("mode", "both"); // simple | pro | both
const ONLY = arg("routes", "/chat,/dashboard/scenarios");

const ROUTES = ONLY.split(",");
const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
];

const outDir = join("design_review", "modes", LABEL);
mkdirSync(outDir, { recursive: true });

const slug = (r) => (r === "/" ? "home" : r.replace(/^\//, "").replace(/\//g, "-"));
const themes = THEME === "both" ? ["light", "dark"] : [THEME];
const modes = MODE === "both" ? ["simple", "pro"] : [MODE];

const browser = await chromium.launch();
for (const mode of modes) {
  for (const theme of themes) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        colorScheme: theme === "dark" ? "dark" : "light",
      });
      // Mode + theme BEFORE first paint on every document in this context.
      await ctx.addInitScript(
        ([m, t]) => {
          try {
            localStorage.setItem("cfo-view-mode-v1", m);
            localStorage.setItem("theme", t);
          } catch {}
        },
        [mode, theme],
      );
      const page = await ctx.newPage();
      for (const route of ROUTES) {
        try {
          await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 45000 });
        } catch {}
        await page.evaluate((t) => {
          const root = document.documentElement;
          root.classList.remove("light", "dark");
          root.classList.add(t);
          root.style.colorScheme = t;
        }, theme);
        try {
          const d = page.getByTestId("test-mode-banner-dismiss");
          if (await d.isVisible({ timeout: 800 })) await d.click();
        } catch {}
        await page.waitForTimeout(700);
        const name = `${slug(route)}--${vp.name}--${theme}--${mode}.png`;
        await page.screenshot({ path: join(outDir, name), fullPage: vp.name !== "mobile-390" });
        process.stdout.write(`shot ${name}\n`);
        // Simple-mode scenarios: also capture the "Show all" expanded state.
        if (mode === "simple") {
          try {
            const toggle = page.getByTestId("scenario-rows-toggle");
            if (await toggle.isVisible({ timeout: 800 })) {
              await toggle.click();
              await page.waitForTimeout(300);
              const xname = `${slug(route)}--${vp.name}--${theme}--${mode}-expanded.png`;
              await page.screenshot({ path: join(outDir, xname), fullPage: vp.name !== "mobile-390" });
              process.stdout.write(`shot ${xname}\n`);
            }
          } catch {}
        }
      }
      await ctx.close();
    }
  }
}
await browser.close();
console.log(`\nDONE -> ${outDir}`);
