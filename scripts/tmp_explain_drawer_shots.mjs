// EXPLAIN ANYTHING — drawer-open capture (Prompt 12, Part D shots).
// Drives /dashboard/scenarios: activates a scenario template so the
// results column (and the Simple-mode Explain button) appears, opens the
// drawer, and captures both themes at 1440. Output lands next to the
// route shots in design_review/explain-r1/.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:5173";
const OUT = "design_review/explain-r1";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  const page = await ctx.newPage();
  // Simple mode explicitly — the Explain affordance is Simple-only.
  await page.addInitScript(() => {
    try { localStorage.setItem("cfo-view-mode-v1", "simple"); } catch {}
  });
  try {
    await page.goto(BASE + "/dashboard/scenarios", { waitUntil: "networkidle", timeout: 45000 });
  } catch {}
  await page.evaluate((t) => {
    try { localStorage.setItem("theme", t); } catch {}
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(t);
    root.style.colorScheme = t;
  }, theme);
  try {
    const d = page.getByTestId("test-mode-banner-dismiss");
    if (await d.isVisible({ timeout: 800 })) await d.click();
  } catch {}
  await page.waitForTimeout(400);

  // Activate a scenario -> results become "active" -> Explain appears.
  await page.getByTestId("scenario-template-sales_drop_20").click().catch(async () => {
    // template key unknown — click the first template card.
    await page.locator('[data-testid^="scenario-template-"]').first().click();
  });
  await page.waitForTimeout(400);
  const btn = page.getByTestId("explain-button-scenario-impact");
  await btn.waitFor({ state: "visible", timeout: 5000 });
  await page.screenshot({ path: join(OUT, `scenarios-explain-button--${theme}.png`) });
  await btn.click();
  await page.getByTestId("explain-drawer").waitFor({ state: "visible", timeout: 5000 });
  // Let the AI upgrade resolve or collapse to the template (either state
  // is a designed state; both must look calm).
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, `scenarios-explain-drawer--${theme}.png`) });
  const src = await page.getByTestId("explain-source").textContent().catch(() => "?");
  const deg = await page.getByTestId("explain-degraded").isVisible().catch(() => false);
  const txt = await page.getByTestId("explain-text").textContent().catch(() => "");
  console.log(`[${theme}] source="${src}" degraded=${deg}`);
  console.log(`[${theme}] text=${(txt ?? "").slice(0, 220)}`);
  await ctx.close();
}
await browser.close();
console.log("DONE");
