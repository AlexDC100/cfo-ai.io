#!/usr/bin/env node
/**
 * THE RESTING CENSUS — what the capsule actually says at rest, and what
 * the sidebar already said two inches to the left.
 *
 * This is the MEASUREMENT that precedes the gates. It is not a gate: it
 * exits 0 whatever it finds, prints a JSON blob, and the numbers in it
 * become the recorded per-component expectations in GATES.md.
 *
 * Run (needs vite :5173 + engine :8000 PUBLIC_TEST_MODE):
 *   node design_review/capsule-brief/census.mjs [--route /chat] [--out FILE]
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const ROUTE = arg("--route", "/chat");
const OUT = arg("--out", null);
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";

async function dismissBanner(page) {
  const b = page.locator('[data-testid="test-mode-banner"] button, [data-testid="test-mode-banner-dismiss"]');
  if (await b.count()) {
    try { await b.first().click({ timeout: 1500 }); } catch { /* already gone */ }
  }
}

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.addInitScript(() => {
    try {
      localStorage.setItem("cfo-learning-mode-v1", JSON.stringify({ mode: "guided" }));
    } catch { /* private mode */ }
  });

  await page.goto(BASE + ROUTE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  await dismissBanner(page);
  await page.goto(BASE + ROUTE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="header-command-bar"]', { timeout: 20000 });
  await dismissBanner(page);
  await page.waitForTimeout(2500);

  // ── the SIDEBAR, before the capsule is opened ──────────────────────
  const sidebar = await page.evaluate(() => {
    const seen = [];
    for (const a of Array.from(document.querySelectorAll("a[href], button"))) {
      const r = a.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const st = getComputedStyle(a);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) < 0.05) continue;
      // The left rail: anything whose painted box sits in the left 300px.
      if (r.right > 300 || r.left < -10) continue;
      const href = a.getAttribute("href");
      const label = (a.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!label && !href) continue;
      seen.push({ label, href, x: Math.round(r.x), y: Math.round(r.y) });
    }
    return seen;
  });

  // ── open the capsule ────────────────────────────────────────────────
  await page.locator('[data-testid="header-command-bar"]').first().click();
  await page.waitForSelector('[data-testid="command-palette"]', { timeout: 10000 });
  await page.waitForTimeout(1200);

  const rest = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="command-palette"]');
    if (!root) return null;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
    };
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    // every element carrying a data-testid, so the census names components
    const testids = [];
    for (const el of Array.from(root.querySelectorAll("[data-testid]"))) {
      if (!visible(el)) continue;
      testids.push({
        testid: el.getAttribute("data-testid"),
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        ...box(el),
      });
    }
    // every activatable thing at rest
    const rows = [];
    for (const el of Array.from(root.querySelectorAll('button, a[href], [role="option"], [role="button"]'))) {
      if (!visible(el)) continue;
      rows.push({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute("data-testid"),
        rowSource: el.getAttribute("data-row-source"),
        rowFamily: el.getAttribute("data-row-family"),
        href: el.getAttribute("href"),
        aria: el.getAttribute("aria-label"),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        ...box(el),
      });
    }
    // every text node, so the census can say what the surface SAYS
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    let n;
    while ((n = walker.nextNode())) {
      const s = (n.nodeValue ?? "").replace(/\s+/g, " ").trim();
      if (!s) continue;
      const p = n.parentElement;
      if (!p || !visible(p)) continue;
      texts.push({ text: s.slice(0, 160), tag: p.tagName.toLowerCase(), testid: p.closest("[data-testid]")?.getAttribute("data-testid") ?? null, ...box(p) });
    }
    return { overlay: box(root), testids, rows, texts };
  });

  const out = { base: BASE, route: ROUTE, at: "measured", sidebar, rest };
  const json = JSON.stringify(out, null, 2);
  if (OUT) writeFileSync(OUT, json);

  console.log("═══ SIDEBAR (visible, left rail) ═══", sidebar.length, "items");
  for (const s of sidebar) console.log(`   ${String(s.href ?? "—").padEnd(28)} ${s.label.slice(0, 44)}`);
  console.log("\n═══ CAPSULE AT REST ═══");
  console.log("overlay", JSON.stringify(rest?.overlay));
  console.log("\n-- testids --");
  for (const t of rest?.testids ?? []) console.log(`   ${t.testid.padEnd(34)} ${t.tag.padEnd(8)} h=${String(t.h).padStart(3)} ${t.text.slice(0, 60)}`);
  console.log("\n-- activatable rows --");
  for (const r of rest?.rows ?? []) console.log(`   ${String(r.testid ?? r.rowSource ?? r.tag).padEnd(28)} href=${String(r.href ?? "—").padEnd(20)} ${r.text.slice(0, 56)}`);
  console.log("\n-- text nodes --");
  for (const t of rest?.texts ?? []) console.log(`   [${String(t.testid ?? "-").padEnd(30)}] ${t.text}`);
  if (OUT) console.log(`\nwrote ${OUT}`);

  await browser.close();
};

main().catch((e) => { console.error(e); process.exit(2); });
