#!/usr/bin/env node
/**
 * THE CAPSULE — THE BRIEF LANE'S HARNESS.
 *
 * The mission this serves is about CONTENT, not geometry, so this probe
 * counts what the surface SAYS. It is a fork of `capsule-craft/craft.mjs`
 * (the geometry block is kept verbatim so a regression there is still
 * visible) with a census bolted on for the three things the brief adds:
 *
 *   restZones        which of the three resting zones actually painted —
 *                    pulse / fact tiles / question chips. TC-6: ONE
 *                    NUMBER PER ZONE, never a sum. A floor on "resting
 *                    nodes" cannot see the fact tiles collapse to zero
 *                    while the chips grow by three.
 *   duplication      how many resting rows name a destination that is
 *                    ALSO permanently in the sidebar rail. This is the
 *                    owner's complaint stated as an integer, and it is
 *                    the number Part A has to drive to 0.
 *   visibleRows      rows painted in the typing state. Part C caps it
 *                    at 8, and a cap nobody counts is a comment.
 *
 * Every count is BY SOURCE (`data-row-source`, `data-testid`) rather
 * than by geometry, because the defect that keeps recurring in this file
 * is a fix landing on a component that renders nothing in the state
 * under test.
 *
 * Usage: node design_review/capsule-brief/brief.mjs --label r0
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const arg = (n, d) => { const i = ARGS.indexOf("--" + n); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
const LABEL = arg("label", "r0");
const BASE = arg("base", "http://localhost:5173");
const SHOTS = !ARGS.includes("--no-shots");
const OUT = join("design_review", "capsule-brief", LABEL);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const THEMES = ["dark", "light"];

// The four states the brief names.
const Q_TYPING = "cash";        // resolves Tier 0 AND matches navigation
const Q_ACCOUNT = "461";        // the account-lookup capability
const Q_EMPTY = "zzqqxx";       // matches nothing — the honest empty

/** Destinations the sidebar rail carries permanently. A resting row
 *  naming one of these is the duplication the owner reported. Folded
 *  the same way the router folds a query. */
const RAIL_DESTINATIONS = [
  "dashboard", "scenarios", "workspaces", "workspace", "benchmark",
  "benchmarks", "products", "chat", "settings", "public companies",
  "markets", "findings", "documents",
];

const PROBE = (railDestinations) => {
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

  // ── ink runs, measured with a Range (glyph extents, not element boxes)
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

  // ── row census BY SOURCE ────────────────────────────────────────────
  const ROWS = '[data-row-source], [role="option"], [data-testid="capsule-jump-row"], ' +
    '[data-testid="capsule-ask-fallback"]';
  const rowEls = [...root.querySelectorAll(ROWS)].filter(painted);
  const rowsBySource = {};
  for (const row of rowEls) {
    const src = row.getAttribute("data-row-source") || "UNSTAMPED";
    rowsBySource[src] = (rowsBySource[src] || 0) + 1;
  }

  // ── the three resting zones, counted SEPARATELY (TC-6) ──────────────
  const count = (sel) => [...root.querySelectorAll(sel)].filter(painted).length;
  const restZones = {
    pulse: count('[data-testid="capsule-context-strip"]'),
    pulseOpen: count('[data-testid="capsule-open-thing"]'),
    tiles: count('[data-testid="capsule-fact-tile"]'),
    tileDots: count('[data-testid="capsule-fact-tile"] [data-testid="capsule-provenance-dot"]'),
    chips: count('[data-testid="capsule-suggestion"]'),
    honest: count('[data-testid="capsule-suggestions-empty"]'),
    jumpRows: count('[data-testid="capsule-jump-row"]'),
    sectionLabels: count('[data-testid="capsule-section-label"]'),
    tier0: count('[data-testid="capsule-tier0"]'),
    separators: count('[data-testid="capsule-zone-rule"]'),
  };

  // ── DUPLICATION: resting rows that name a rail destination ──────────
  const fold = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const duplicated = [];
  const restRows = [...root.querySelectorAll(
    '[data-testid="capsule-jump-row"], [data-testid="capsule-suggestion"], ' +
    '[data-testid="capsule-fact-tile"]')].filter(painted);
  for (const row of restRows) {
    const text = fold(row.textContent || "");
    if (!text) continue;
    if (railDestinations.some((d) => text === d)) {
      duplicated.push(text.slice(0, 32));
    }
  }

  // What each tile actually says, so a "clean" reading is distinguishable
  // from "no subject" (TC-9).
  const tiles = [...root.querySelectorAll('[data-testid="capsule-fact-tile"]')]
    .filter(painted)
    .map((el) => ({
      fact: el.getAttribute("data-fact") || null,
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
    }));
  const chips = [...root.querySelectorAll('[data-testid="capsule-suggestion"]')]
    .filter(painted)
    .map((el) => ({
      kind: el.getAttribute("data-kind") || null,
      text: (el.textContent || "").trim().slice(0, 60),
    }));

  return {
    present: true,
    card: { x: Math.round(rr.x), top: Math.round(rr.top), w: Math.round(rr.width),
            h: Math.round(rr.height), bottom: Math.round(rr.bottom) },
    vhFraction: Math.round((rr.height / window.innerHeight) * 1000) / 10,
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
    visibleRows: rowEls.length,
    rowsBySource,
    restZones,
    duplicated,
    tiles,
    chips,
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
    // NO MODEL SPEND. Both seams are dead-ended: any request that escapes
    // is a failure of the surface, not something this harness pays for.
    await page.route("**/functions/v1/chat-llm", (r) =>
      r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await page.route("**/api/capsule/tools/**", (r) =>
      r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));

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
      const m = await page.evaluate(PROBE, RAIL_DESTINATIONS);
      out.push({ state, viewport: vp.name, theme, ...m });
      const z = m.present ? m.restZones : {};
      process.stdout.write(
        `  ${state.padEnd(9)} ${vp.name.padEnd(5)} ${theme.padEnd(5)} ` +
        (m.present
          ? `card ${m.card.h}px lead=${m.leadGap} tail=${m.tailGap} maxGap=${m.maxGap} ` +
            `ink=${m.inkDensity}% comp=${m.composerBottom} rows=${m.visibleRows} ` +
            `| pulse=${z.pulse} tiles=${z.tiles} chips=${z.chips} jump=${z.jumpRows} ` +
            `labels=${z.sectionLabels} dup=${m.duplicated.length}`
          : "NO OVERLAY") + "\n");
    };

    await open();
    await shot("rest");

    const input = page.locator('[data-testid="command-palette"] textarea').first();
    await input.click().catch(() => {});
    await input.fill(Q_TYPING).catch(() => {});
    await page.waitForTimeout(650);
    await shot("typing");

    await input.fill(Q_ACCOUNT).catch(() => {});
    await page.waitForTimeout(650);
    await shot("account");

    await input.fill(Q_EMPTY).catch(() => {});
    await page.waitForTimeout(650);
    await shot("empty");

    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(OUT, "BRIEF.json"), JSON.stringify(out, null, 2));
process.stdout.write(`\nwrote ${join(OUT, "BRIEF.json")}\n`);
