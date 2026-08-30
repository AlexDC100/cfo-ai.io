#!/usr/bin/env node
/**
 * THE CAPSULE — craft screenshot loop.
 *
 * `scripts/design_shots.mjs` captures ROUTES. This surface is an
 * OVERLAY, and an overlay is invisible to a route capture: every craft
 * complaint in the brief (700px of air, the form-field input, the flat
 * rows, the detached coach mark) lives in a state that only exists
 * after a click and a keystroke. So this harness drives the surface
 * into each state and shoots it.
 *
 * FOUR STATES, 2 viewports, 2 themes = 16 frames per round:
 *   rest      overlay open, nothing typed
 *   typing    a partial question in the composer
 *   answer    a Tier-0 question answered (no model spend — the
 *             generation seam is stubbed, and Tier 0 does not reach it
 *             anyway)
 *   empty     the honest no-suggestions line
 *
 * It also writes MEASURE.json — the numbers the critique is written
 * against, so a round's claims can be checked instead of believed.
 *
 * Usage: node design_review/capsule-craft/shoot.mjs --label craft-r0
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const arg = (n, d) => {
  const i = ARGS.indexOf("--" + n);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const LABEL = arg("label", "craft-r0");
const BASE = arg("base", "http://localhost:5173");
const OUT = join("design_review", "capsule-craft", LABEL);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const THEMES = ["dark", "light"]; // dark == Terminal, light == Paper

const TOOL_PAYLOAD = {
  version: "ct1", tool: "get_facts", read_only: true, ok: true,
  values: [{
    kind: "money", fact: "total_assets", metric: "total_assets", unit: "money",
    amount_minor: 39000000, value: 390000, currency: "RON",
    scope: "December 2024", label_key: "capsule.metric.total_assets",
    provenance: {
      period_id: "p-dec", period_label: "December 2024", entity_id: "org-1",
      source: "assembled_canonical_v1", tier: "canonical_bs",
      snapshot_id: "sha256-p-dec",
    },
  }],
  rows: [], gaps: [], limitations: [], notes: [],
};

const measurements = [];

const browser = await chromium.launch();

for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: theme,
    });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("cfo:learning-mode:v1",
          JSON.stringify({ mode: "subtle", coachDismissed: true }));
        localStorage.setItem("cfo-view-mode-v1", "pro");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.route("**/functions/v1/chat-llm", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ answer: "Total assets stand at {{money:total_assets}} for December 2024." }) }));
    await page.route("**/api/capsule/tools/**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TOOL_PAYLOAD) }));

    await page.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    await page.evaluate((t) => {
      try { localStorage.setItem("theme", t); } catch {}
      const r = document.documentElement;
      r.classList.remove("light", "dark"); r.classList.add(t); r.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(400);
    const dis = page.getByTestId("test-mode-banner-dismiss");
    if (await dis.isVisible().catch(() => false)) { await dis.click().catch(() => {}); await page.waitForTimeout(300); }

    const shot = async (state) => {
      await page.waitForTimeout(500);
      const name = `${state}--${vp.name}--${theme}.png`;
      await page.screenshot({ path: join(OUT, name) });
      const box = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="command-palette"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        // deepest-content height: the union of children boxes
        const kids = Array.from(el.children).map((c) => c.getBoundingClientRect());
        const contentH = kids.length
          ? Math.max(...kids.map((k) => k.bottom)) - Math.min(...kids.map((k) => k.top))
          : 0;
        return {
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          contentH: Math.round(contentH),
        };
      });
      measurements.push({ state, viewport: vp.name, theme, box });
      process.stdout.write(`shot ${name}  ${box ? `${box.w}x${box.h}` : "NO OVERLAY"}\n`);
    };

    // ── REST ──
    const trigger = page.locator('[data-testid="header-command-bar"]');
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
    } else {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    }
    await page.waitForTimeout(700);
    await shot("rest");

    // ── TYPING ──
    const input = page.locator('[data-testid="command-palette"] textarea').first();
    await input.click().catch(() => {});
    await input.fill("cash").catch(() => {});
    await page.waitForTimeout(600);
    await shot("typing");

    // ── ANSWER ──
    await input.fill("what are total assets").catch(() => {});
    await page.waitForTimeout(400);
    await input.press("Enter").catch(() => {});
    await page.waitForTimeout(3500);
    await shot("answer");

    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(OUT, "MEASURE.json"), JSON.stringify(measurements, null, 2));
process.stdout.write(`\nwrote ${join(OUT, "MEASURE.json")}\n`);
