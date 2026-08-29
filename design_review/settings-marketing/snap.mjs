// One-off region snapper for the settings+marketing lane review loop.
// Usage: node design_review/settings-marketing/snap.mjs <url> <out.png> [selector] [--dark]
import { chromium } from "@playwright/test";

const [url, out, selector, flag] = process.argv.slice(2);
const dark = flag === "--dark" || selector === "--dark";
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: dark ? "dark" : "light",
  reducedMotion: "no-preference",
});
const page = await ctx.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem(
      "cfoai_consent",
      JSON.stringify({ analytics: false, marketing: false, ts: Date.now() }),
    );
  } catch {}
});
try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
} catch {}
await page.waitForTimeout(800);
if (selector && selector !== "--dark") {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await el.screenshot({ path: out });
} else {
  await page.screenshot({ path: out });
}
await browser.close();
console.log("snapped", out);
