#!/usr/bin/env node
/**
 * THE INSTRUMENT — screenshot loop harness.
 *
 * Captures every app route at the brief's three viewports (1440 / 1280 /
 * 390) in one or both themes, into design_review/<label>/. The design
 * mandate makes this loop non-negotiable: a migration part is DONE only
 * when its screenshots pass written self-critique, and every round is
 * archived so the critique trail survives.
 *
 * Usage:
 *   node scripts/design_shots.mjs --label baseline
 *   node scripts/design_shots.mjs --label part-a --theme both
 *   node scripts/design_shots.mjs --label dash-r2 --routes /dashboard --theme both
 *
 * Assumes the test-mode stack is up (engine :8000 PUBLIC_TEST_MODE=1,
 * vite :5173). Test mode boots a session on first visit — no login.
 * The test-mode banner is dismissed before capture so it never occludes
 * the header in review shots.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
function arg(name, dflt) {
  const i = ARGS.indexOf("--" + name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
}

const LABEL = arg("label", "adhoc");
const BASE = arg("base", "http://localhost:5173");
const THEME = arg("theme", "current"); // current | light | dark | both
const ONLY = arg("routes", null);

const ROUTES = ONLY
  ? ONLY.split(",")
  : [
      "/dashboard",
      "/workspace",
      "/chat",
      "/public-companies",
      "/dashboard/scenarios",
      "/dashboard/variance",
      "/benchmark",
      "/products",
      "/settings",
      "/",
    ];

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "mobile-390", width: 390, height: 844 },
];

const outDir = join("design_review", LABEL);
mkdirSync(outDir, { recursive: true });

function slug(route) {
  return route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "-");
}

const themes = THEME === "both" ? ["light", "dark"] : [THEME];

const browser = await chromium.launch();
for (const theme of themes) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    const page = await ctx.newPage();
    for (const route of ROUTES) {
      try {
        await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 45000 });
      } catch {
        // networkidle can starve on pages with polling; capture anyway.
      }
      if (theme !== "current") {
        // next-themes class strategy: force deterministically per shot.
        await page.evaluate((t) => {
          try {
            localStorage.setItem("theme", t);
          } catch {}
          const root = document.documentElement;
          root.classList.remove("light", "dark");
          root.classList.add(t);
          root.style.colorScheme = t;
        }, theme);
        await page.waitForTimeout(350);
      }
      // The sticky test-mode banner occludes the header — dismiss it.
      try {
        const d = page.getByTestId("test-mode-banner-dismiss");
        if (await d.isVisible({ timeout: 800 })) await d.click();
      } catch {}
      await page.waitForTimeout(600);
      const name = `${slug(route)}--${vp.name}${THEME === "both" ? "--" + theme : ""}.png`;
      await page.screenshot({ path: join(outDir, name), fullPage: vp.name !== "mobile-390" });
      process.stdout.write(`shot ${name}\n`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`\nDONE -> ${outDir}`);
