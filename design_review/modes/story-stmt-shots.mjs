// THE DIAL — story lane statement-disclosure capture. The plain shot
// harness can't reach the statement tabs (?tab= is dropped during the
// test-mode boot), so this script clicks the tabs like a user and
// captures Simple collapsed -> expanded, plus Pro for the untouched
// baseline. Run from repo root:
//   node design_review/modes/story-stmt-shots.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:5173";
const OUT = join("design_review", "modes", process.argv[2] ?? "story-stmts-r2");
mkdirSync(OUT, { recursive: true });

const TABS = [
  { label: "P&L", slug: "pl" },
  { label: "Balance Sheet", slug: "bs" },
  { label: "Cash Flow", slug: "cf" },
];

const browser = await chromium.launch();
for (const mode of ["simple", "pro"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((m) => {
    try {
      localStorage.setItem("cfo-view-mode-v1", m);
    } catch {}
  }, mode);
  const page = await ctx.newPage();
  await page.goto(BASE + "/dashboard", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  try {
    const d = page.getByTestId("test-mode-banner-dismiss");
    if (await d.isVisible({ timeout: 800 })) await d.click();
  } catch {}
  await page.waitForTimeout(800);
  for (const tab of TABS) {
    await page.getByRole("tab", { name: tab.label }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `${tab.slug}--${mode}.png`), fullPage: true });
    process.stdout.write(`shot ${tab.slug}--${mode}.png\n`);
    if (mode === "simple") {
      // Expand "Show all lines" and capture the full table too.
      const toggle = page.getByTestId(`${tab.slug === "bs" ? "bs" : tab.slug === "cf" ? "cf" : "pl"}-show-all`);
      if (await toggle.isVisible({ timeout: 1500 }).catch(() => false)) {
        await toggle.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(OUT, `${tab.slug}--${mode}-expanded.png`), fullPage: true });
        process.stdout.write(`shot ${tab.slug}--${mode}-expanded.png\n`);
        await toggle.click(); // restore collapsed for the next tab
      } else {
        process.stdout.write(`WARN no show-all toggle on ${tab.slug}\n`);
      }
    }
  }
  await ctx.close();
}
await browser.close();
console.log(`DONE -> ${OUT}`);
