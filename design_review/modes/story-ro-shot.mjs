// THE DIAL — story lane RO-language capture (register check).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("design_review/modes/story-r1", { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("cfo-view-mode-v1", "simple");
    localStorage.setItem("cfo.userLanguage", "ro");
  } catch {}
});
const page = await ctx.newPage();
await page.goto("http://localhost:5173/dashboard", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
try {
  const d = page.getByTestId("test-mode-banner-dismiss");
  if (await d.isVisible({ timeout: 800 })) await d.click();
} catch {}
await page.waitForTimeout(900);
await page.screenshot({ path: "design_review/modes/story-r1/dashboard--ro--simple.png", fullPage: true });
console.log("shot dashboard--ro--simple.png");
await browser.close();
