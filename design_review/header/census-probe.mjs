// Standalone live-DOM header census probe (no test runner).
import { chromium } from "@playwright/test";

const SEL = [
  "button", "a[href]", "input", "select", "textarea",
  '[role="button"]', '[role="radiogroup"]', '[role="combobox"]',
].join(", ");

const routes = process.argv[2] ? [process.argv[2]] : ["/dashboard", "/chat"];
const widths = [1440, 1024, 900];

const browser = await chromium.launch();
for (const w of widths) {
  for (const route of routes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    await ctx.addInitScript(() => {
      window.localStorage.setItem("cfo:learning-mode:v1", JSON.stringify({ mode: "subtle", coachDismissed: true, tutorialsSeen: {} }));
    });
    const page = await ctx.newPage();
    await page.goto("http://localhost:5173" + route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    const dismiss = page.getByTestId("test-mode-banner-dismiss");
    if (await dismiss.isVisible().catch(() => false)) { await dismiss.click().catch(() => {}); await page.waitForTimeout(300); }
    const out = await page.evaluate((sel) => {
      const headerEl = [...document.querySelectorAll("header")].find((h) => h.querySelector('[data-testid="account-menu-trigger"]'));
      if (!headerEl) return { error: "no app header" };
      const inOverlay = (el) => !!el.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
      const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"; };
      const all = [...headerEl.querySelectorAll(sel)].filter((el) => visible(el) && !inOverlay(el));
      const topLevel = all.filter((el) => { let p = el.parentElement; while (p && p !== headerEl) { if (p.matches(sel)) return false; p = p.parentElement; } return true; });
      return {
        allCount: all.length,
        count: topLevel.length,
        items: topLevel.map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), testid: el.getAttribute("data-testid"), aria: el.getAttribute("aria-label"), text: (el.textContent ?? "").trim().slice(0, 40) })),
      };
    }, SEL);
    console.log(`\n=== ${w}px  ${route} ===`);
    if (out.error) { console.log("  " + out.error); }
    else {
      console.log(`  count=${out.count}  (raw matches before top-level filter: ${out.allCount})`);
      out.items.forEach((i, n) => console.log(`  ${n + 1}. <${i.tag}> testid=${i.testid} role=${i.role} aria="${i.aria}" text="${i.text}"`));
    }
    await ctx.close();
  }
}
await browser.close();
