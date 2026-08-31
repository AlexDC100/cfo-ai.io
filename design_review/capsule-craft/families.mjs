#!/usr/bin/env node
/**
 * THE CAPSULE — WHICH QUERY SUMMONS WHICH ROW FAMILY.
 *
 * Defect 1's gate half. G4 reported ZERO offenders on a build where 57
 * rows carried a trailing right-aligned word, because its nine-query
 * sweep never typed a query that summons the PRODUCT rows — the only
 * family that still had a trailing node. Its predicate was correct and
 * its sample was blind.
 *
 * This harness is the measurement that has to come BEFORE the widened
 * gate: for a candidate query, what families does the palette actually
 * paint, how many rows each, and how many carry a right-aligned trailing
 * glyph run. The numbers it prints are what the per-family expectations
 * in the spec are set from — recorded, not guessed.
 *
 * Usage: node design_review/capsule-craft/families.mjs --label famcensus-r0
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const arg = (n, d) => { const i = ARGS.indexOf("--" + n); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
const LABEL = arg("label", "famcensus-r0");
const BASE = arg("base", "http://localhost:5173");
const OUT = join("design_review", "capsule-craft", LABEL);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];

/** Candidates, chosen to reach every family in `items` (CommandPalette):
 *  pages, actions, glossary, periods, categories, SKUs, concepts,
 *  companies, and the no-match fallback. */
const QUERIES = [
  "", "dash", "sce", "work", "bench", "prod", "sett", "cash", "bal",
  "range", "core", "tinned", "juice", "sku", "dec", "202", "aug", "a",
  "banca", "tlv", "trans", "digi", "upload", "export", "theme", "rail",
  "glossary", "ebitda", "ratio", "margin", "zzqqxx",
];

const ROW_PROBE = () => {
  const root = document.querySelector('[data-testid="command-palette"]');
  if (!root) return { present: false, rows: [] };
  const painted = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const ROWS =
    '[data-row-source], [role="option"], [data-testid="capsule-jump-row"], ' +
    '[data-testid="capsule-ask-fallback"]';
  const rows = [...root.querySelectorAll(ROWS)].filter(painted);

  // The section label a row sits under: nearest preceding
  // `capsule-section-label` in document order.
  const labels = [...root.querySelectorAll('[data-testid="capsule-section-label"]')];
  const sectionOf = (row) => {
    let best = null;
    for (const l of labels) {
      if (l.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) best = l;
    }
    return best ? (best.textContent || "").trim() : "";
  };

  const out = [];
  for (const row of rows) {
    const leaves = [];
    const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const txt = (n.textContent || "").trim();
      if (!txt) continue;
      const p = n.parentElement;
      if (!p || !painted(p)) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      const b = rg.getBoundingClientRect();
      if (b.width < 1) continue;
      leaves.push({ text: txt, left: b.left, right: b.right, el: p });
    }
    leaves.sort((a, b) => a.left - b.left);
    const rb = row.getBoundingClientRect();
    let offender = null;
    if (leaves.length >= 2) {
      const first = leaves[0], last = leaves[leaves.length - 1];
      const isKbd = last.el.tagName === "KBD" || !!last.el.closest("kbd");
      const isWord = /[A-Za-zĂÂÎȘȚăâîșț]{3,}/.test(last.text);
      const glyphGutter = Math.round(last.left - first.right);
      const fb = first.el.getBoundingClientRect(), lb = last.el.getBoundingClientRect();
      const elementGutter = Math.round(lb.left - fb.right);
      const rightAligned = rb.right - last.right < 40;
      if (!isKbd && isWord && rightAligned && glyphGutter > 24) {
        offender = { label: first.text.slice(0, 32), trail: last.text.slice(0, 32),
                     glyphGutter, elementGutter };
      }
    }
    out.push({
      source: row.getAttribute("data-row-source") || "UNSTAMPED",
      family: row.getAttribute("data-row-family") || "(unstamped)",
      section: sectionOf(row),
      text: (row.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
      offender,
    });
  }
  return { present: true, rows: out };
};

const results = [];
const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1, colorScheme: "dark",
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("cfo:learning-mode:v1", JSON.stringify({ mode: "subtle", coachDismissed: true }));
      localStorage.setItem("cfo-view-mode-v1", "pro");
    } catch {}
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  const dis = page.getByTestId("test-mode-banner-dismiss");
  if (await dis.isVisible().catch(() => false)) { await dis.click().catch(() => {}); await page.waitForTimeout(300); }

  const trigger = page.locator('[data-testid="header-command-bar"]');
  if (await trigger.isVisible().catch(() => false)) await trigger.click();
  else await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.waitForTimeout(800);

  const input = page.locator('[data-testid="command-palette"] textarea').first();
  await input.click().catch(() => {});

  for (const q of QUERIES) {
    await input.fill("").catch(() => {});
    await page.waitForTimeout(120);
    if (q) await input.fill(q).catch(() => {});
    await page.waitForTimeout(420);
    const r = await page.evaluate(ROW_PROBE);
    const bySection = {};
    const byFamily = {};
    for (const row of r.rows) {
      bySection[row.section || "(none)"] = (bySection[row.section || "(none)"] || 0) + 1;
      byFamily[row.family] = (byFamily[row.family] || 0) + 1;
    }
    const offenders = r.rows.filter((x) => x.offender);
    results.push({ viewport: vp.name, query: q || "(rest)", rows: r.rows.length,
                   bySection, byFamily, offenders: offenders.length, detail: r.rows });
    process.stdout.write(
      `${vp.name.padEnd(5)} ${(q || "(rest)").padEnd(10)} rows=${String(r.rows.length).padStart(3)} ` +
      `off=${String(offenders.length).padStart(3)}  ${JSON.stringify(bySection)}\n`);
    for (const o of offenders.slice(0, 4)) {
      process.stdout.write(`        · "${o.offender.label}" → "${o.offender.trail}" glyph ${o.offender.glyphGutter}px (element ${o.offender.elementGutter}px)\n`);
    }
  }
  await ctx.close();
}
await browser.close();
writeFileSync(join(OUT, "FAMILIES.json"), JSON.stringify(results, null, 2));
process.stdout.write(`\nwrote ${join(OUT, "FAMILIES.json")}\n`);
