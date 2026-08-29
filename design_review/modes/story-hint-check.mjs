// THE DIAL — trust-hint interaction check (story lane). Verifies against
// the live test-mode stack: the hint renders once in Simple, tapping it
// opens the accuracy receipt, and the guard key keeps it dismissed on
// reload. Run: node design_review/modes/story-hint-check.mjs
import { chromium } from "@playwright/test";

const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("cfo-view-mode-v1", "simple");
  } catch {}
});
const page = await ctx.newPage();
await page.goto(BASE + "/dashboard", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(800);

const hint = page.getByTestId("trust-hint");
console.log("hint visible:", await hint.isVisible());

await page.getByTestId("trust-hint-see-how").click();
await page.waitForTimeout(300);
console.log("receipt open after tap:", await page.getByTestId("accuracy-receipt").isVisible());
console.log("hint gone after tap:", !(await hint.isVisible().catch(() => false)));

await page.reload({ waitUntil: "networkidle" }).catch(() => {});
await page.waitForTimeout(800);
console.log(
  "hint stays dismissed on reload:",
  !(await page.getByTestId("trust-hint").isVisible().catch(() => false)),
);
await page.screenshot({ path: "design_review/modes/story-r1/trust-hint-receipt.png" });
await browser.close();
