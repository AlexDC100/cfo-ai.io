#!/usr/bin/env node
/**
 * THE N-GATE PROBE — one live measurement pass over every subject
 * gates N1–N8 will assert on. Exits 0 whatever it finds; the numbers it
 * prints become the RECORDED per-component expectations in GATES.md.
 *
 * It is deliberately NOT a gate. A gate that also invents its own
 * expectations is a gate grading its own homework.
 *
 * Run (needs vite :5173 + engine :8000 PUBLIC_TEST_MODE):
 *   node design_review/capsule-brief/probe.mjs --out design_review/capsule-brief/probe.json
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = arg("--out", null);
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const ROUTE = arg("--route", "/chat");

/** The two paid seams. Anything hitting these is model spend. */
const SPEND_RE = /\/api\/capsule\/tools\/get_facts|functions\/v1\/chat-llm|\/api\/cfo\/chat\/llm|api\.anthropic\.com/;

const report = {};

async function dismissBanner(page) {
  const b = page.getByTestId("test-mode-banner-dismiss");
  if (await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function boot(page, route) {
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  await dismissBanner(page);
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="header-command-bar"]', { timeout: 20000 });
  await dismissBanner(page);
  await page.waitForTimeout(2500);
}

const openCapsule = async (page) => {
  await page.locator('[data-testid="header-command-bar"]').first().click();
  await page.waitForSelector('[data-testid="command-palette"]', { timeout: 10000 });
  await page.waitForTimeout(900);
};

/** Every painted, activatable row inside the overlay + what it points at. */
const readRows = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-testid="command-palette"]');
    if (!root) return [];
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
    };
    return Array.from(root.querySelectorAll('button, a[href], [role="option"]'))
      .filter(vis)
      .map((el) => ({
        testid: el.getAttribute("data-testid"),
        rowSource: el.getAttribute("data-row-source"),
        rowFamily: el.getAttribute("data-row-family"),
        navTo: el.getAttribute("data-nav-to") ?? el.getAttribute("href"),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 110),
      }));
  });

const main = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const spend = [];
  const allReq = [];
  page.on("request", (r) => {
    allReq.push(r.url());
    if (SPEND_RE.test(r.url())) spend.push({ url: r.url(), method: r.method() });
  });

  await boot(page, ROUTE);

  // ══ N1 — the sidebar's VISIBLE destinations ═══════════════════════
  const sidebar = await page.evaluate(() => {
    const out = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const r = a.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right > 300) continue;
      const s = getComputedStyle(a);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05) continue;
      out.push({
        href: a.getAttribute("href"),
        path: (a.getAttribute("href") ?? "").split("?")[0],
        label: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
      });
    }
    return out;
  });
  report.sidebar = sidebar;

  // ══ N3 — spend during OPEN + REST ═════════════════════════════════
  const spendBefore = spend.length;
  await openCapsule(page);
  await page.waitForTimeout(2500);          // sit at rest, read the tiles
  const restSpend = spend.slice(spendBefore);

  // ══ N1 / N4 / N7 — the resting surface ════════════════════════════
  const restRows = await readRows(page);
  const rest = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="command-palette"]');
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
    };
    const grab = (sel) => Array.from(root.querySelectorAll(sel)).filter(vis).map((el) => ({
      testid: el.getAttribute("data-testid"),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
      provenance: el.getAttribute("data-provenance"),
      fact: el.getAttribute("data-fact"),
      gap: el.getAttribute("data-gap"),
    }));
    return {
      overlayH: Math.round(root.getBoundingClientRect().height),
      tiles: grab('[data-testid^="capsule-tile"], [data-testid="capsule-fact-tile"]'),
      chips: grab('[data-testid="capsule-suggestion"]'),
      strip: grab('[data-testid="capsule-context-strip"]'),
      jumps: grab('[data-testid="capsule-jump"], [data-testid^="capsule-jump"]'),
      provenanceNodes: grab("[data-provenance]"),
      factNodes: grab("[data-fact]"),
      // every numeral the resting surface paints, with its owner
      numerals: (() => {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const out = [];
        let n;
        while ((n = w.nextNode())) {
          const s = (n.nodeValue ?? "").trim();
          if (!/\d/.test(s)) continue;
          const p = n.parentElement;
          if (!p || !vis(p)) continue;
          out.push({
            text: s.slice(0, 90),
            owner: p.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
            provenance: p.closest("[data-provenance]") ? true : false,
          });
        }
        return out;
      })(),
    };
  });
  report.rest = { ...rest, rows: restRows, spendDuringOpenAndRest: restSpend };

  // ══ N5 — account-code lookup latency ══════════════════════════════
  const codes = ["5121", "411", "121", "401", "9999"];
  const lookups = [];
  for (const code of codes) {
    const spendMark = spend.length;
    await page.locator('[data-testid="capsule-composer"]').fill("");
    await page.waitForTimeout(180);
    const t0 = Date.now();
    await page.locator('[data-testid="capsule-composer"]').type(code, { delay: 12 });
    // wait for the surface to settle on SOMETHING (rows, or the fallback)
    await page.waitForTimeout(220);
    const t1 = Date.now();
    const rows = await readRows(page);
    const shape = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="command-palette"]');
      const q = (s) => !!root.querySelector(s);
      return {
        askFallback: q('[data-testid="capsule-ask-fallback"]'),
        sectionLabels: Array.from(root.querySelectorAll('[data-testid="capsule-section-label"]'))
          .map((e) => e.textContent.trim()),
        text: (root.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 220),
      };
    });
    lookups.push({ code, ms: t1 - t0, rows: rows.length, spend: spend.length - spendMark, ...shape,
      rowTexts: rows.map((r) => r.text).slice(0, 8) });
  }
  report.accountLookup = lookups;

  // ══ N7 — row budget across typing states ══════════════════════════
  const typingQueries = ["a", "cash", "dash", "period", "5121", "bal"];
  const budget = [];
  for (const q of typingQueries) {
    await page.locator('[data-testid="capsule-composer"]').fill("");
    await page.waitForTimeout(150);
    await page.locator('[data-testid="capsule-composer"]').fill(q);
    await page.waitForTimeout(400);
    const rows = await readRows(page);
    budget.push({ q, visibleRows: rows.length });
  }
  report.rowBudget = budget;

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ══ N6 — the handoff, on /chat ════════════════════════════════════
  const threadKeys = async () =>
    page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith("cfo-ai-chat-history")) continue;
        try {
          const v = JSON.parse(localStorage.getItem(k) ?? "[]");
          out[k] = Array.isArray(v) ? v.length : (v?.conversations?.length ?? -1);
        } catch { out[k] = -2; }
      }
      return out;
    });

  const beforeThreads = await threadKeys();
  const composerBefore = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName?.toLowerCase() ?? null, testid: el?.getAttribute?.("data-testid") ?? null };
  });

  await openCapsule(page);
  await page.locator('[data-testid="capsule-composer"]').fill("what moved gross margin");
  await page.waitForTimeout(300);
  await page.keyboard.press("Meta+Enter");            // the documented handoff
  await page.waitForTimeout(2500);

  const afterThreads = await threadKeys();
  const afterFocus = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      testid: el?.getAttribute?.("data-testid") ?? null,
      placeholder: el?.getAttribute?.("placeholder") ?? null,
      value: el?.value?.slice?.(0, 60) ?? null,
      inCapsule: !!el?.closest?.('[data-testid="command-palette"]'),
    };
  });
  const chatComposers = await page.evaluate(() =>
    Array.from(document.querySelectorAll("textarea"))
      .filter((t) => t.getBoundingClientRect().height > 0)
      .map((t) => ({
        testid: t.getAttribute("data-testid"),
        placeholder: t.getAttribute("placeholder"),
        value: t.value.slice(0, 60),
        inCapsule: !!t.closest('[data-testid="command-palette"]'),
      })),
  );
  report.handoff = {
    url: page.url(),
    beforeThreads, afterThreads, composerBefore, afterFocus, chatComposers,
    capsuleStillOpen: await page.locator('[data-testid="command-palette"]').count(),
  };

  report.spendTotal = spend;
  report.requestCount = allReq.length;

  const json = JSON.stringify(report, null, 2);
  if (OUT) writeFileSync(OUT, json);

  // ── printout ─────────────────────────────────────────────────────
  const L = (s) => console.log(s);
  L("\n══ N1 · SIDEBAR VISIBLE DESTINATIONS ══ " + sidebar.length);
  for (const s of sidebar) L(`   ${s.path.padEnd(24)} ${s.label}`);
  L("\n══ N1/N7 · CAPSULE AT REST ══ overlay h=" + rest.overlayH);
  L(`   tiles=${rest.tiles.length}  chips=${rest.chips.length}  jumps=${rest.jumps.length}  activatable rows=${restRows.length}`);
  for (const r of restRows) L(`     row: ${String(r.testid ?? r.rowSource).padEnd(26)} navTo=${r.navTo ?? "—"}  ${r.text.slice(0, 60)}`);
  L(`   provenance nodes=${rest.provenanceNodes.length}  data-fact nodes=${rest.factNodes.length}`);
  L("   numerals painted at rest:");
  for (const n of rest.numerals) L(`     "${n.text}"  owner=${n.owner}  provenance=${n.provenance}`);
  L("\n══ N3 · SPEND WHILE OPENING + SITTING AT REST ══ " + restSpend.length);
  for (const s of restSpend) L("   " + s.method + " " + s.url);
  L("\n══ N5 · ACCOUNT-CODE LOOKUP ══");
  for (const l of report.accountLookup)
    L(`   ${l.code.padEnd(6)} ${String(l.ms).padStart(4)}ms  rows=${String(l.rows).padStart(2)}  spend=${l.spend}  askFallback=${l.askFallback}  labels=[${l.sectionLabels.join("|")}]`);
  for (const l of report.accountLookup) L(`   ${l.code}: ${l.rowTexts.join(" ; ").slice(0, 150)}`);
  L("\n══ N7 · ROW BUDGET BY TYPING STATE ══");
  for (const b of report.rowBudget) L(`   ${b.q.padEnd(8)} ${b.visibleRows} visible rows`);
  L("\n══ N6 · HANDOFF ON /chat ══");
  L("   url after: " + report.handoff.url);
  L("   threads before: " + JSON.stringify(beforeThreads));
  L("   threads after : " + JSON.stringify(afterThreads));
  L("   focus after   : " + JSON.stringify(afterFocus));
  L("   visible textareas: " + JSON.stringify(chatComposers));
  L("   capsule still mounted: " + report.handoff.capsuleStillOpen);
  L("\n══ TOTALS ══ requests=" + allReq.length + "  spend-seam hits=" + spend.length);
  if (OUT) L("\nwrote " + OUT);

  await browser.close();
};

main().catch((e) => { console.error(e); process.exit(2); });
