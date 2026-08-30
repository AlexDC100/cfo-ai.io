#!/usr/bin/env node
// Close-ups of the two things a full-page shot cannot settle: the
// composer's edge treatment, and whether the coach mark reads as
// attached to the avatar.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const LABEL = process.argv[process.argv.indexOf("--label") + 1] || "craft-r4";
const OUT = join("design_review", "capsule-craft", LABEL);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try {
    localStorage.setItem("cfo:learning-mode:v1", JSON.stringify({ mode: "subtle", coachDismissed: true }));
    localStorage.setItem("cfo-view-mode-v1", "pro");
  } catch {} });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  await page.evaluate((t) => { try { localStorage.setItem("theme", t); } catch {}
    const r = document.documentElement; r.classList.remove("light","dark"); r.classList.add(t); r.style.colorScheme = t; }, theme);
  await page.waitForTimeout(400);
  const d = page.getByTestId("test-mode-banner-dismiss");
  if (await d.isVisible().catch(() => false)) { await d.click().catch(()=>{}); await page.waitForTimeout(300); }
  await page.locator('[data-testid="header-command-bar"]').click();
  await page.waitForTimeout(800);
  const box = await page.locator('[data-testid="command-palette"]').boundingBox();
  await page.screenshot({ path: join(OUT, `composer-rest--${theme}.png`),
    clip: { x: box.x - 6, y: box.y + box.height - 92, width: box.width + 12, height: 98 } });
  // typing, with the send button armed
  const ta = page.locator('[data-testid="command-palette"] textarea').first();
  await ta.fill("what pushed revenue");
  await page.waitForTimeout(500);
  const box2 = await page.locator('[data-testid="command-palette"]').boundingBox();
  await page.screenshot({ path: join(OUT, `composer-typing--${theme}.png`),
    clip: { x: box2.x - 6, y: box2.y + box2.height - 92, width: box2.width + 12, height: 98 } });
  await page.screenshot({ path: join(OUT, `card-top--${theme}.png`),
    clip: { x: box2.x - 10, y: box2.y - 10, width: box2.width + 20, height: 80 } });
  await ctx.close();
}
// coach mark
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try {
    localStorage.setItem("cfo:learning-mode:v1", JSON.stringify({ mode: "subtle", coachDismissed: true }));
    localStorage.setItem("cfo-view-mode-v1", "pro");
    localStorage.removeItem("cfo:header-mode-coachmark-v1");
  } catch {} });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  await page.evaluate((t) => { try { localStorage.setItem("theme", t); } catch {}
    const r = document.documentElement; r.classList.remove("light","dark"); r.classList.add(t); r.style.colorScheme = t; }, theme);
  await page.waitForTimeout(500);
  const d = page.getByTestId("test-mode-banner-dismiss");
  if (await d.isVisible().catch(() => false)) { await d.click().catch(()=>{}); await page.waitForTimeout(300); }
  await page.screenshot({ path: join(OUT, `coach--${theme}.png`), clip: { x: 1440 - 470, y: 0, width: 470, height: 200 } });
  await ctx.close();
}
await browser.close();
console.log("zoom done ->", OUT);
