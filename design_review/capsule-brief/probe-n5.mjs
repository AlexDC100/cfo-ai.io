#!/usr/bin/env node
/**
 * N5 PROBE — the account-code path, measured honestly.
 *
 * The first probe measured its own sleep (it typed with a delay, then
 * waited a fixed 220 ms, then called the elapsed time "latency"). That
 * number is discarded. This one starts a MutationObserver BEFORE the
 * final keystroke and reports the time to the first paint that follows
 * it, so the measurement is the surface's, not the probe's.
 *
 * It also asks the question the first probe did not: does ENTER resolve
 * an account code from the local fact index, and can the surface tell a
 * REAL account from a fabricated one?
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const SPEND_RE = /\/api\/capsule\/tools\/get_facts|functions\/v1\/chat-llm|\/api\/cfo\/chat\/llm|api\.anthropic\.com/;
const argv = process.argv.slice(2);
const OUT = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const spend = [];
  page.on("request", (r) => { if (SPEND_RE.test(r.url())) spend.push(r.url()); });

  const dismiss = async () => {
    const b = page.getByTestId("test-mode-banner-dismiss");
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  };
  await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000); await dismiss();
  await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="header-command-bar"]', { timeout: 20000 });
  await dismiss(); await page.waitForTimeout(2500);

  const report = { typing: [], enter: [], factIndex: null };

  // ── is there a fact index at all on this workspace? ────────────────
  // Measured through the surface, not by importing the module: what the
  // gate cares about is what the READER can reach.
  await page.locator('[data-testid="header-command-bar"]').first().click();
  await page.waitForSelector('[data-testid="command-palette"]');
  await page.waitForTimeout(1200);

  const codes = ["5121", "411", "401", "121", "9999", "8888"];

  for (const code of codes) {
    await page.locator('[data-testid="capsule-composer"]').fill("");
    await page.waitForTimeout(200);
    // everything but the last character, so the observer is armed on a
    // settled surface and only the FINAL keystroke is being timed
    const head = code.slice(0, -1), tail = code.slice(-1);
    await page.locator('[data-testid="capsule-composer"]').fill(head);
    await page.waitForTimeout(350);

    await page.evaluate(() => {
      const root = document.querySelector('[data-testid="command-palette"]');
      window.__t0 = null; window.__paint = null;
      window.__obs?.disconnect();
      window.__obs = new MutationObserver(() => {
        if (window.__t0 != null && window.__paint == null) window.__paint = performance.now();
      });
      window.__obs.observe(root, { childList: true, subtree: true, characterData: true });
    });
    await page.evaluate(() => { window.__t0 = performance.now(); });
    await page.keyboard.type(tail);
    await page.waitForTimeout(500);
    const ms = await page.evaluate(() => (window.__paint == null ? null : window.__paint - window.__t0));

    const shape = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="command-palette"]');
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return {
        askFallback: !!root.querySelector('[data-testid="capsule-ask-fallback"]'),
        rows: Array.from(root.querySelectorAll('button,[role="option"]')).filter(vis)
          .map((e) => ({ t: e.getAttribute("data-testid"), s: e.getAttribute("data-row-source"),
                         text: (e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 70) })),
        provenance: root.querySelectorAll("[data-provenance]").length,
        factNodes: root.querySelectorAll("[data-fact]").length,
      };
    });
    report.typing.push({ code, paintMs: ms, ...shape });
  }

  // ── ENTER, on a real code and a fabricated one ─────────────────────
  for (const code of ["5121", "9999"]) {
    await page.locator('[data-testid="capsule-composer"]').fill("");
    await page.waitForTimeout(200);
    await page.locator('[data-testid="capsule-composer"]').fill(code);
    await page.waitForTimeout(400);
    const before = spend.length;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3500);
    const shape = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="command-palette"]');
      if (!root) return { gone: true };
      return {
        answer: !!root.querySelector('[data-testid="capsule-answer"]'),
        turn: root.querySelectorAll('[data-testid="capsule-turn"]').length,
        factCard: !!root.querySelector('[data-testid="capsule-fact-card"]'),
        provenance: root.querySelectorAll("[data-provenance]").length,
        text: (root.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 320),
      };
    });
    report.enter.push({ code, spend: spend.length - before, ...shape });
    // back to a clean surface
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    if (!(await page.locator('[data-testid="command-palette"]').count())) {
      await page.locator('[data-testid="header-command-bar"]').first().click();
      await page.waitForSelector('[data-testid="command-palette"]');
      await page.waitForTimeout(800);
    }
  }

  console.log("══ N5 · TYPING (paint latency after the FINAL keystroke) ══");
  for (const t of report.typing)
    console.log(`   ${t.code.padEnd(6)} paint=${t.paintMs == null ? "NO-PAINT" : t.paintMs.toFixed(1) + "ms"}  askFallback=${t.askFallback}  rows=${t.rows.length}  prov=${t.provenance}  fact=${t.factNodes}  [${t.rows.map((r) => r.text).join(" | ").slice(0, 90)}]`);
  console.log("\n══ N5 · ENTER ══");
  for (const e of report.enter)
    console.log(`   ${e.code.padEnd(6)} spend=${e.spend} answer=${e.answer} turns=${e.turn} factCard=${e.factCard} prov=${e.provenance}\n          "${(e.text ?? "").slice(0, 220)}"`);
  console.log("\n   spend-seam hits total: " + spend.length);

  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  await browser.close();
};
main().catch((e) => { console.error(e); process.exit(2); });
