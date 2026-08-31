#!/usr/bin/env node
/**
 * THE CAPSULE — the CLOSE lane's probe.
 *
 * Written because the SURFACE lane's own harness could not see three of
 * the defects the owner reported. It measures what the READER sees, not
 * what the element boxes say:
 *
 *   inkDensity     Σ(area of every TEXT RUN's client rects, measured with
 *                  a Range over the text node) ÷ card area. A card that
 *                  grows without gaining words scores lower. Invariant to
 *                  whether the box hugs its last child, which is exactly
 *                  what the old "dead space" metric was not.
 *   maxGap         the tallest horizontal band inside the card that no
 *                  painted ink crosses. Air BETWEEN children counts; the
 *                  old metric only ever saw air AFTER the last one.
 *   glyphGutter    for a row: (left edge of the trailing text's glyphs)
 *                  − (right edge of the label's glyphs). The element-box
 *                  gutter is pinned at `gap-3` = 12px by `flex-1` no
 *                  matter how short the label is; the reader sees the
 *                  glyph gutter, which on a short label is 200px+.
 *   rowsBySource   every row node, grouped by the `data-row-source` its
 *                  renderer stamps. A fix applied to a component that
 *                  renders nothing in this state shows up as a 0.
 *   titles         `[title]` census over the WHOLE document, not the
 *                  overlay — the trigger pill and the header trust dot
 *                  are part of this surface and live outside the portal.
 *
 * Usage: node design_review/capsule-craft/probe.mjs --label close-r0
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const arg = (n, d) => { const i = ARGS.indexOf("--" + n); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
const LABEL = arg("label", "close-r0");
const BASE = arg("base", "http://localhost:5173");
const SHOTS = !ARGS.includes("--no-shots");
const OUT = join("design_review", "capsule-craft", LABEL);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const THEMES = ["dark", "light"];

/** The typing query the critic used — it is the one that summons concept
 *  rows, which is where the category column lives. */
const TYPING_QUERY = "cash";
const ASK_QUESTION = "what are total assets";
const FOLLOW_UP = "and current ratio";

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

// ── the one function that does every DOM read ─────────────────────────
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

  // ── ink: every text run, measured as glyphs ──
  const runs = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    if (!n.textContent || !n.textContent.trim()) continue;
    const parent = n.parentElement;
    if (!parent || !painted(parent)) continue;
    // sr-only text is not ink.
    const pr = parent.getBoundingClientRect();
    if (pr.width < 2 || pr.height < 2) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      runs.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
                  a: rect.width * rect.height });
    }
    range.detach?.();
  }
  // interactive things with no text still occupy the reader's eye
  const glyphless = [];
  root.querySelectorAll('svg, img, [data-testid="capsule-row-rule"]').forEach((el) => {
    if (!painted(el)) return;
    const r = el.getBoundingClientRect();
    glyphless.push({ top: r.top, bottom: r.bottom, a: r.width * r.height });
  });
  const inkArea = runs.reduce((s, r) => s + r.a, 0);
  const inkDensity = inkArea / area;

  // ── the tallest empty band inside the card ──
  const bands = [...runs, ...glyphless]
    .map((r) => [Math.max(rr.top, r.top), Math.min(rr.bottom, r.bottom)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1] + 0.5) last[1] = Math.max(last[1], b[1]);
    else merged.push([b[0], b[1]]);
  }
  let maxGap = 0, gapAt = null;
  let cursor = rr.top;
  const gaps = [];
  for (const [a, b] of merged) {
    const g = a - cursor;
    if (g > 0.5) gaps.push({ from: Math.round(cursor), to: Math.round(a), px: Math.round(g) });
    if (g > maxGap) { maxGap = g; gapAt = Math.round(cursor); }
    cursor = Math.max(cursor, b);
  }
  const tail = rr.bottom - cursor;
  if (tail > 0.5) gaps.push({ from: Math.round(cursor), to: Math.round(rr.bottom), px: Math.round(tail), tail: true });
  if (tail > maxGap) { maxGap = tail; gapAt = Math.round(cursor); }

  // ── the composer ──
  const comps = [...root.querySelectorAll("textarea, input[type=text]")].filter(painted);
  const comp = comps[comps.length - 1] ?? null;
  const cb = comp ? comp.getBoundingClientRect() : null;

  // ── rows, by the component that rendered them ──
  const ROWS = '[data-row-source], [role="option"], [data-testid="capsule-suggestion"], ' +
    '[data-testid="capsule-jump-row"], [data-testid="capsule-ask-fallback"]';
  const rowEls = [...root.querySelectorAll(ROWS)].filter(painted);
  const rowsBySource = {};
  const trailing = [];
  for (const row of rowEls) {
    const src = row.getAttribute("data-row-source") || row.getAttribute("data-testid") || "UNSTAMPED";
    rowsBySource[src] = (rowsBySource[src] || 0) + 1;
    // leaf text runs inside this row, in visual order
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
    // the OLD metric, kept side by side so the difference is on the record
    const fb = first.el.getBoundingClientRect(), lb = last.el.getBoundingClientRect();
    const elementGutter = Math.round(lb.left - fb.right);
    trailing.push({
      source: src, label: first.text.slice(0, 28), trail: last.text.slice(0, 28),
      glyphGutter, elementGutter,
      rightAligned: rb.right - last.right < 40,
    });
  }

  // ── native tooltips, whole document ──
  const titles = [...document.querySelectorAll("[title]")]
    .filter((el) => painted(el) || el.closest('[data-testid="command-palette"]'))
    .map((el) => ({
      testid: el.getAttribute("data-testid") ||
              el.closest("[data-testid]")?.getAttribute("data-testid") || el.tagName,
      title: (el.getAttribute("title") || "").slice(0, 60),
      inOverlay: !!el.closest('[data-testid="command-palette"]'),
    }));

  return {
    present: true,
    card: { x: Math.round(rr.x), y: Math.round(rr.top), w: Math.round(rr.width),
            h: Math.round(rr.height), bottom: Math.round(rr.bottom) },
    vhFraction: Math.round((rr.height / window.innerHeight) * 1000) / 10,
    composerBottom: cb ? Math.round(cb.bottom) : null,
    composerTop: cb ? Math.round(cb.top) : null,
    inkDensity: Math.round(inkDensity * 10000) / 100,
    inkArea: Math.round(inkArea),
    textRuns: runs.length,
    maxGap: Math.round(maxGap),
    gapAt,
    gaps: gaps.filter((g) => g.px >= 8),
    rows: rowEls.length,
    rowsBySource,
    trailing,
    trailingOffenders: trailing.filter((x) => x.rightAligned && x.glyphGutter > 24),
    titles,
    titleCount: titles.length,
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
      await page.waitForTimeout(450);
      if (SHOTS) await page.screenshot({ path: join(OUT, `${state}--${vp.name}--${theme}.png`) });
      const m = await page.evaluate(PROBE);
      out.push({ state, viewport: vp.name, theme, ...m });
      const b = m.present ? `${m.card.w}x${m.card.h} (${m.vhFraction}vh) ink=${m.inkDensity}% gap=${m.maxGap} rows=${m.rows} titles=${m.titleCount} trail=${m.trailingOffenders.length}` : "NO OVERLAY";
      process.stdout.write(`  ${state.padEnd(9)} ${vp.name.padEnd(5)} ${theme.padEnd(5)} ${b}\n`);
    };

    const trigger = page.locator('[data-testid="header-command-bar"]');
    if (await trigger.isVisible().catch(() => false)) await trigger.click();
    else await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    await page.waitForTimeout(800);
    await shot("rest");

    const input = page.locator('[data-testid="command-palette"] textarea').first();
    await input.click().catch(() => {});
    await input.fill(TYPING_QUERY).catch(() => {});
    await page.waitForTimeout(650);
    await shot("typing");

    await input.fill(ASK_QUESTION).catch(() => {});
    await page.waitForTimeout(350);
    await input.press("Enter").catch(() => {});
    await page.waitForTimeout(3200);
    await shot("answer");

    const follow = page.locator('[data-testid="command-palette"] textarea').first();
    await follow.click().catch(() => {});
    await follow.fill(FOLLOW_UP).catch(() => {});
    await page.waitForTimeout(250);
    await follow.press("Enter").catch(() => {});
    await page.waitForTimeout(3200);
    await shot("answer2");

    // ── EMPTY ──
    //
    // The brief asks for an "empty" frame. The literal one — a workspace
    // whose engine yields zero suggestions — cannot be reached on this
    // stack: every workspace here has at least one unattached period, so
    // `buildCapsuleSuggestions` always returns at least one chip, and
    // staging it would be photographing a state I forced into existence.
    //
    // The empty state the READER can actually reach is a query that
    // matches nothing: no rows, no Tier-0 figure, and the surface
    // offering the only thing it has — the reader's own words, back.
    // That is what this frame is, and it is labelled honestly.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    const d2 = page.getByTestId("test-mode-banner-dismiss");
    if (await d2.isVisible().catch(() => false)) { await d2.click().catch(() => {}); await page.waitForTimeout(300); }
    const trig2 = page.locator('[data-testid="header-command-bar"]');
    if (await trig2.isVisible().catch(() => false)) await trig2.click();
    await page.waitForTimeout(800);
    const in2 = page.locator('[data-testid="command-palette"] textarea').first();
    await in2.click().catch(() => {});
    await in2.fill("zzqqxx").catch(() => {});
    await page.waitForTimeout(650);
    await shot("empty");

    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(OUT, "PROBE.json"), JSON.stringify(out, null, 2));
process.stdout.write(`\nwrote ${join(OUT, "PROBE.json")}\n`);
