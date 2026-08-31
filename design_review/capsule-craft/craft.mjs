#!/usr/bin/env node
/**
 * THE CAPSULE — the CLOSE lane's final harness.
 *
 * FOUR states × TWO viewports × TWO themes = 16 frames, plus the numbers
 * the critique has to be written against. It measures what the READER
 * sees rather than what the layout engine reports:
 *
 *   leadGap     card.top → the top of the FIRST ink inside it. This is
 *               defect 2 stated as one number: 113px on a 298px card at
 *               1440 is 37.9% of the card blank before anything is said.
 *               `deadSpace` (the old metric) measured the OTHER end and
 *               read 0px on that same card, because the content is
 *               bottom-aligned — the air was all above it.
 *   tailGap     the same at the bottom, kept so the pair is on the record
 *               and a "fix" that just flips which end holds the hole is
 *               visible as a swap rather than as a win.
 *   maxGap      the tallest horizontal band inside the card that no ink
 *               crosses, wherever it sits.
 *   inkDensity  Σ(area of every text run, measured with a Range) ÷ card
 *               area. A card that grows without gaining words scores
 *               lower.
 *   composer    top/bottom in viewport coordinates, per state — G2's
 *               subject, so a claim that it does not move is a delta.
 *   rowsBySource / rowsByFamily / trailingOffenders — defect 1's subject.
 *
 * Usage: node design_review/capsule-craft/craft.mjs --label critique-r0
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const arg = (n, d) => { const i = ARGS.indexOf("--" + n); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
const LABEL = arg("label", "critique-r0");
const BASE = arg("base", "http://localhost:5173");
const SHOTS = !ARGS.includes("--no-shots");
const OUT = join("design_review", "capsule-craft", LABEL);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const THEMES = ["dark", "light"];

const TYPING_QUERY = "range";       // the query that summons the PRODUCT rows
const ASK_QUESTION = "what are total assets";
const EMPTY_QUERY = "zzqqxx";       // matches nothing — the reachable empty

const TOOL_PAYLOAD = {
  version: "ct1", tool: "get_facts", read_only: true, ok: true,
  values: [
    { kind: "money", fact: "total_assets", metric: "total_assets", unit: "money",
      amount_minor: 39000000, value: 390000, currency: "RON", scope: "December 2024",
      label_key: "capsule.metric.total_assets",
      provenance: { period_id: "p-dec", period_label: "December 2024", entity_id: "org-1",
        source: "assembled_canonical_v1", tier: "canonical_bs", snapshot_id: "sha256-p-dec" } },
    { kind: "ratio", fact: "current_ratio", metric: "current_ratio", unit: "ratio",
      value: 2.8, numerator_minor: 140000, denominator_minor: 50000,
      operand_currency: "RON", scope: "December 2024",
      label_key: "capsule.metric.current_ratio",
      provenance: { period_id: "p-dec", period_label: "December 2024", entity_id: "org-1",
        source: "assembled_canonical_v1", tier: "canonical_bs", snapshot_id: "sha256-p-dec" } },
  ],
  rows: [], gaps: [], limitations: [], notes: [],
};

const PROBE = () => {
  const root = document.querySelector('[data-testid="command-palette"]');
  if (!root) return { present: false };
  const painted = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const rr = root.getBoundingClientRect();
  const area = Math.max(1, rr.width * rr.height);

  const runs = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    if (!n.textContent || !n.textContent.trim()) continue;
    const parent = n.parentElement;
    if (!parent || !painted(parent)) continue;
    const pr = parent.getBoundingClientRect();
    if (pr.width < 2 || pr.height < 2) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      runs.push({ top: rect.top, bottom: rect.bottom, a: rect.width * rect.height,
                  text: (n.textContent || "").trim().slice(0, 28) });
    }
  }
  const glyphless = [];
  root.querySelectorAll('svg, img, input, textarea, [data-testid="capsule-row-rule"]').forEach((el) => {
    if (!painted(el)) return;
    const r = el.getBoundingClientRect();
    glyphless.push({ top: r.top, bottom: r.bottom, a: r.width * r.height, text: "«" + el.tagName + "»" });
  });

  const all = [...runs, ...glyphless]
    .map((r) => ({ top: Math.max(rr.top, r.top), bottom: Math.min(rr.bottom, r.bottom), text: r.text }))
    .filter((r) => r.bottom > r.top)
    .sort((a, b) => a.top - b.top);

  const firstInk = all.length ? all[0] : null;
  const lastInkBottom = all.length ? Math.max(...all.map((r) => r.bottom)) : rr.top;
  const leadGap = firstInk ? Math.round(firstInk.top - rr.top) : Math.round(rr.height);
  const tailGap = Math.round(rr.bottom - lastInkBottom);

  const merged = [];
  for (const b of all) {
    const last = merged[merged.length - 1];
    if (last && b.top <= last[1] + 0.5) last[1] = Math.max(last[1], b.bottom);
    else merged.push([b.top, b.bottom]);
  }
  let maxGap = 0, gapAt = null, cursor = rr.top;
  for (const [a, b] of merged) {
    const g = a - cursor;
    if (g > maxGap) { maxGap = g; gapAt = Math.round(cursor); }
    cursor = Math.max(cursor, b);
  }
  if (rr.bottom - cursor > maxGap) { maxGap = rr.bottom - cursor; gapAt = Math.round(cursor); }

  const inkArea = runs.reduce((s, r) => s + r.a, 0);

  const comps = [...root.querySelectorAll("textarea, input[type=text]")].filter(painted);
  const comp = comps[comps.length - 1] ?? null;
  const cb = comp ? comp.getBoundingClientRect() : null;

  const pill = document.querySelector('[data-testid="header-command-bar"]');
  const pb = pill ? pill.getBoundingClientRect() : null;

  const ROWS = '[data-row-source], [role="option"], [data-testid="capsule-jump-row"], ' +
    '[data-testid="capsule-ask-fallback"]';
  const rowEls = [...root.querySelectorAll(ROWS)].filter(painted);
  const rowsBySource = {}, rowsByFamily = {};
  const trailingOffenders = [];
  for (const row of rowEls) {
    const src = row.getAttribute("data-row-source") || "UNSTAMPED";
    const fam = row.getAttribute("data-row-family") || "(none)";
    rowsBySource[src] = (rowsBySource[src] || 0) + 1;
    rowsByFamily[fam] = (rowsByFamily[fam] || 0) + 1;
    const leaves = [];
    const w2 = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w2.nextNode())) {
      const txt = (t.textContent || "").trim();
      if (!txt) continue;
      const p = t.parentElement;
      if (!p || !painted(p)) continue;
      const rg = document.createRange();
      rg.selectNodeContents(t);
      const b = rg.getBoundingClientRect();
      if (b.width < 1) continue;
      leaves.push({ text: txt, left: b.left, right: b.right, el: p });
    }
    if (leaves.length < 2) continue;
    leaves.sort((a, b) => a.left - b.left);
    const first = leaves[0], last = leaves[leaves.length - 1];
    if (last === first) continue;
    if (last.el.tagName === "KBD" || last.el.closest("kbd")) continue;
    if (!/[A-Za-zĂÂÎȘȚăâîșț]{3,}/.test(last.text)) continue;
    const rb = row.getBoundingClientRect();
    const glyphGutter = Math.round(last.left - first.right);
    if (rb.right - last.right < 40 && glyphGutter > 24) {
      trailingOffenders.push({ source: src, family: fam,
        label: first.text.slice(0, 28), trail: last.text.slice(0, 28), glyphGutter });
    }
  }

  return {
    present: true,
    card: { x: Math.round(rr.x), top: Math.round(rr.top), w: Math.round(rr.width),
            h: Math.round(rr.height), bottom: Math.round(rr.bottom) },
    vhFraction: Math.round((rr.height / window.innerHeight) * 1000) / 10,
    pillBottom: pb ? Math.round(pb.bottom) : null,
    pillGap: pb ? Math.round(rr.top - pb.bottom) : null,
    leadGap,
    leadGapPct: Math.round((leadGap / Math.max(1, rr.height)) * 1000) / 10,
    firstInk: firstInk ? firstInk.text : null,
    tailGap,
    maxGap: Math.round(maxGap),
    gapAt,
    inkDensity: Math.round((inkArea / area) * 10000) / 100,
    composerTop: cb ? Math.round(cb.top) : null,
    composerBottom: cb ? Math.round(cb.bottom) : null,
    rows: rowEls.length, rowsBySource, rowsByFamily,
    trailingOffenders,
  };
};

const out = [];
const browser = await chromium.launch();

for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1, colorScheme: theme,
    });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("cfo:learning-mode:v1", JSON.stringify({ mode: "subtle", coachDismissed: true }));
        localStorage.setItem("cfo-view-mode-v1", "pro");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.route("**/functions/v1/chat-llm", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ answer: "Total assets stand at {{money:total_assets}} for December 2024, with a current ratio of {{fact:current_ratio|d2}}." }) }));
    await page.route("**/api/capsule/tools/**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TOOL_PAYLOAD) }));

    const open = async () => {
      const dis = page.getByTestId("test-mode-banner-dismiss");
      if (await dis.isVisible().catch(() => false)) { await dis.click().catch(() => {}); await page.waitForTimeout(300); }
      const trigger = page.locator('[data-testid="header-command-bar"]');
      if (await trigger.isVisible().catch(() => false)) await trigger.click();
      else await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      await page.waitForTimeout(800);
    };

    await page.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    await page.evaluate((t) => {
      try { localStorage.setItem("theme", t); } catch {}
      const r = document.documentElement;
      r.classList.remove("light", "dark"); r.classList.add(t); r.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(400);

    const shot = async (state) => {
      await page.waitForTimeout(450);
      if (SHOTS) await page.screenshot({ path: join(OUT, `${state}--${vp.name}--${theme}.png`) });
      const m = await page.evaluate(PROBE);
      out.push({ state, viewport: vp.name, theme, ...m });
      process.stdout.write(
        `  ${state.padEnd(9)} ${vp.name.padEnd(5)} ${theme.padEnd(5)} ` +
        (m.present
          ? `card ${m.card.h}px (${m.vhFraction}vh) top=${m.card.top} bot=${m.card.bottom} ` +
            `lead=${m.leadGap}px (${m.leadGapPct}%) tail=${m.tailGap} maxGap=${m.maxGap} ` +
            `ink=${m.inkDensity}% comp=${m.composerBottom} rows=${m.rows} off=${m.trailingOffenders.length}`
          : "NO OVERLAY") + "\n");
    };

    await open();
    await shot("rest");

    const input = page.locator('[data-testid="command-palette"] textarea').first();
    await input.click().catch(() => {});
    await input.fill(TYPING_QUERY).catch(() => {});
    await page.waitForTimeout(650);
    await shot("typing");

    await input.fill(EMPTY_QUERY).catch(() => {});
    await page.waitForTimeout(650);
    await shot("empty");

    await input.fill(ASK_QUESTION).catch(() => {});
    await page.waitForTimeout(350);
    await input.press("Enter").catch(() => {});
    await page.waitForTimeout(3200);
    await shot("answering");

    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(OUT, "CRAFT.json"), JSON.stringify(out, null, 2));
process.stdout.write(`\nwrote ${join(OUT, "CRAFT.json")}\n`);
