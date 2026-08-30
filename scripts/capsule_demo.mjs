#!/usr/bin/env node
/**
 * THE CAPSULE — the grounded demo, measured on the SHIPPED SURFACE.
 *
 * ══ WHY THIS FILE EXISTS AND WHAT IT REFUSES TO DO ═══════════════════
 *
 * The previous wave published index-build and resolve times taken from
 * the RESOLVER, in jsdom, with hand-built fixtures, and published a
 * coverage percentage from the same place. Both measured a path that
 * the browser never runs. `design_shots_capsule.mjs` captured its
 * screenshots with `--stub-tools 1`, i.e. with the engine's tool layer
 * replaced by a literal in the driver.
 *
 * This driver stubs NOTHING that carries a number:
 *
 *   the numbers      a REAL Romanian trial balance
 *                    (`files/prod_scandia_frozen_31.12.2025.xlsx`,
 *                    byte-identical to `corpus/saga_10_col/input.xlsx`)
 *                    run through the REAL engine by
 *                    `design_review/capsule/tools/demo_engine.py`, which
 *                    mounts the REAL `pipeline.build_router` and
 *                    `_capsule_tools.build_router`.
 *   the surface      the real Vite app on :5173. No component is
 *                    mounted in isolation; every measurement is taken
 *                    from the DOM the reader sees.
 *   the spend count  every request the page makes is recorded, and the
 *                    two model seams are counted by URL — the same two
 *                    K10 names.
 *
 * What IS substituted, and only this:
 *   · Supabase auth  a session is seeded into localStorage so
 *                    `fetchPeriodFromApi` has a token to send. It gates
 *                    access, not arithmetic.
 *   · the API host   requests to the app's configured API origin are
 *                    re-pointed at the sidecar. Same routers, same code,
 *                    different port.
 *
 * ══ THE CANARIES ═════════════════════════════════════════════════════
 *
 * A driver that works by discovery must name what it MUST find. Every
 * mode here fails loudly rather than reporting a clean census:
 *
 *   C-LOAD      the period must load and paint a figure whose digits
 *               appear in the fixture. A surface that renders nothing
 *               would otherwise "pass" every later assertion.
 *   C-SPEND     the coverage run must observe at least one question that
 *               DOES reach a model seam. If nothing ever spends, the
 *               seam counter is not wired, and "0 spend" means nothing.
 *   C-GUARD     the ask guard's burst limit (6/60s) must never be the
 *               reason a question spent nothing. One page load per
 *               question; any refusal is reported as UNMEASURED, never
 *               as coverage.
 *   C-PHASE     a latency phase with no sample is printed as UNMEASURED
 *               with its reason. It is never filled from a budget.
 *
 * Usage:
 *   node scripts/capsule_demo.mjs probe
 *   node scripts/capsule_demo.mjs demo      --label grounded-r1
 *   node scripts/capsule_demo.mjs latency   --runs 5
 *   node scripts/capsule_demo.mjs coverage
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const MODE = ARGS[0] && !ARGS[0].startsWith("--") ? ARGS[0] : "probe";
function arg(name, dflt) {
  const i = ARGS.indexOf("--" + name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
}
function flag(name) {
  return ARGS.includes("--" + name);
}

const BASE = arg("base", "http://localhost:5173");
const SIDECAR = arg("engine", "http://127.0.0.1:8010");
const APP_API = arg("app-api", "http://127.0.0.1:8000");
const SUPABASE_REF = arg("supabase-ref", "cjclenykwlngqvapmisb");
const LABEL = arg("label", "grounded");
const OUT_ROOT = join("design_review", "capsule");

// The two seams K10 names. Counted by URL; everything else the page
// fetches (fonts, auth, the period read) is recorded but is NOT spend.
const MODEL_SEAMS = [
  { label: "engine tool endpoint", match: /\/api\/capsule\/tools\// },
  { label: "chat-llm Edge Function", match: /functions\/v1\/chat-llm/ },
];
const isSpend = (u) => MODEL_SEAMS.some((s) => s.match.test(u));

// ── the seeded session ────────────────────────────────────────────────
// A structurally valid, unsigned JWT with a far-future expiry.
// supabase-js reads `exp` out of the payload to decide whether the
// stored session is live; it does not verify the signature client-side.
// The sidecar accepts any bearer token (it is bound to loopback and
// holds one period built from a repo file).
function seedSession(ref) {
  const b64 = (o) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
  const uid = "00000000-0000-4000-8000-000000000001";
  const token = [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ sub: uid, role: "authenticated", aud: "authenticated", exp,
          email: "test@cfo-ai.io" }),
    "capsule-demo-not-a-signature",
  ].join(".");
  return {
    key: `sb-${ref}-auth-token`,
    value: JSON.stringify({
      access_token: token,
      refresh_token: "capsule-demo-refresh",
      token_type: "bearer",
      expires_in: 86400,
      expires_at: exp,
      user: {
        id: uid, aud: "authenticated", role: "authenticated",
        email: "test@cfo-ai.io", app_metadata: {}, user_metadata: {},
        created_at: new Date(0).toISOString(),
      },
    }),
  };
}

async function periodId() {
  const res = await fetch(`${SIDECAR}/__demo/period-id`);
  if (!res.ok) throw new Error(`sidecar not up at ${SIDECAR} (${res.status})`);
  return (await res.json()).period_id;
}

/** One browser context wired to the sidecar, with a request ledger. */
async function makeContext(browser, { theme = "light", viewport } = {}) {
  const ctx = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  const sess = seedSession(SUPABASE_REF);
  await ctx.addInitScript(
    ([k, v, t]) => {
      try {
        localStorage.setItem(k, v);
        localStorage.setItem("theme", t);
      } catch { /* private mode */ }
    },
    [sess.key, sess.value, theme],
  );

  const ledger = { all: [], spend: [], failed: [] };
  const page = await ctx.newPage();

  // Re-point the app's configured API origin at the sidecar. Same
  // routers, same handler code — a different port.
  await page.route(`${APP_API}/**`, async (route) => {
    const url = route.request().url().replace(APP_API, SIDECAR);
    await route.continue({ url });
  });
  page.on("request", (r) => {
    const u = r.url();
    ledger.all.push(u);
    if (isSpend(u)) ledger.spend.push(u);
  });
  page.on("requestfailed", (r) => ledger.failed.push(r.url()));
  return { ctx, page, ledger };
}

/** Tailwind runs `darkMode: ["class"]`, so the theme is a class on
 *  <html> that the app owns and re-resolves on every hydration. Forcing
 *  it once after the FIRST load is not enough: any later `page.goto`
 *  reloads the document and the class reverts.
 *
 *  That is not hypothetical — the first run of this driver produced
 *  `6-amount--light.png` and `6-amount--dark.png` with the SAME sha256,
 *  because frame 5b navigates. Two identical files under two theme names
 *  is exactly the kind of evidence that looks like coverage and is not,
 *  so the theme is now re-asserted immediately before every capture. */
async function applyTheme(page, theme) {
  await page.evaluate((t) => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(t);
    root.style.colorScheme = t;
  }, theme ?? "light");
}

async function openDashboard(page, pid, theme) {
  try {
    await page.goto(`${BASE}/dashboard?period=${pid}`, {
      waitUntil: "domcontentloaded", timeout: 45000,
    });
  } catch { /* polling pages never reach networkidle */ }
  await applyTheme(page, theme);
  // The banner overlays the header pill in a screenshot.
  try {
    const d = page.getByTestId("test-mode-banner-dismiss");
    if (await d.isVisible({ timeout: 2500 })) await d.click();
  } catch { /* absent */ }
}

/** Wait until the period payload has actually landed in the app — the
 *  company name is the cheapest DOM proof that `useActivePeriod`
 *  resolved through the network path and not the demo sample. */
async function waitForPeriod(page, company, timeout = 45000) {
  await page.waitForFunction(
    (name) => document.body.innerText.includes(name),
    company,
    { timeout },
  );
}

// ══════════════════════════════════════════════════════════════════════
// probe
// ══════════════════════════════════════════════════════════════════════

async function probe() {
  const pid = await periodId();
  const browser = await chromium.launch();
  const { ctx, page, ledger } = await makeContext(browser);
  await openDashboard(page, pid, "light");
  await page.waitForTimeout(6000);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log("URL      ", page.url());
  console.log("period   ", pid);
  console.log("--- body ---\n" + text);
  console.log("--- api requests ---");
  for (const u of [...new Set(ledger.all)].filter((u) => u.includes("/api/")))
    console.log("  " + u);
  console.log("--- failed ---");
  for (const u of [...new Set(ledger.failed)].slice(0, 20)) console.log("  " + u);
  await ctx.close();
  await browser.close();
}

// ══════════════════════════════════════════════════════════════════════
// explore — an interactive scratch pass, not a deliverable
// ══════════════════════════════════════════════════════════════════════

async function explore() {
  const pid = await periodId();
  const Q = arg("q", "what are our total assets");
  const browser = await chromium.launch();
  const { ctx, page, ledger } = await makeContext(browser);
  await openDashboard(page, pid, "light");
  await waitForPeriod(page, "Scandia Food SRL");
  await page.waitForTimeout(1500);

  await page.keyboard.press("Meta+k");
  await page.getByTestId("command-palette").waitFor({ timeout: 8000 });
  await page.keyboard.type(Q, { delay: 8 });
  await page.waitForTimeout(700);
  // The PREVIEW ELEMENT, with the surface's own refused/resolved verdict.
  // Dumping the page tail here instead was how a refusal ("…on file for
  // Dec 2025, but the split behind it is not…") got mistaken for a
  // resolution once already.
  console.log("--- while typing (Tier-0 preview) ---");
  console.log(JSON.stringify(await page.evaluate(() => {
    const el = document.querySelector('[data-testid="capsule-tier0"]');
    if (!el) return { state: "absent" };
    return {
      state: el.getAttribute("data-refused") === "true" ? "refused" : "resolved",
      kind: el.getAttribute("data-kind"),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140),
    };
  }), null, 1));

  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  console.log("\n--- after Enter ---");
  console.log((await page.evaluate(() => document.body.innerText)).slice(-1800));

  const marks = await page.evaluate(() => {
    const q = (s) => Array.from(document.querySelectorAll(s)).length;
    return {
      factCard: q('[data-testid="capsule-fact-card"]'),
      dots: q('[data-testid="capsule-provenance-dot"]'),
      citation: q('[data-testid="capsule-citation"]'),
      degraded: q('[data-testid="capsule-degraded"]'),
      amounts: q("[data-provenance]"),
      dotAttrs: Array.from(
        document.querySelectorAll('[data-testid="capsule-provenance-dot"]'),
      ).map((e) => e.getAttribute("data-traceable-source-statement") + "/" +
                   e.getAttribute("data-traceable-source-bucket")),
    };
  });
  console.log("\nMARKS", JSON.stringify(marks, null, 1));
  console.log("SPEND", ledger.spend.length, ledger.spend.slice(0, 6));
  console.log("API CALLS", [...new Set(ledger.all.filter((u) => u.includes("/api/") || u.includes("functions/v1")))]);
  await ctx.close();
  await browser.close();
}


// ══════════════════════════════════════════════════════════════════════
// demo — the grounded numeric demo, as a numbered frame sequence
// ══════════════════════════════════════════════════════════════════════
//
// Frames, per theme:
//   1  pill        the header capsule at rest, period loaded
//   2  typed       the question typed; the Tier-0 preview already resolved
//   3  answered    Enter; the figure, the dot, the citation footer
//   4  dot-hover   the pointer on the provenance dot, its label showing
//   5  landed      the jump's destination: the Balance Sheet row, pulsed
//   6  amount      an <Amount>-rendered figure with its provenance tooltip
//
// Frames 3 and 5 are the two ends of the provenance jump. They are
// captured in one run, from one click, so the pair cannot drift.

const DEMO_QUESTION = "what are our total assets";
const DEMO_AMOUNT_QUESTION = "what is the equity ratio";
const DEMO_COMPANY = "Scandia Food SRL";

// `--period demo-meridian` captures the SAME six frames against the
// fictional demo sample the previous wave's evidence was taken on. It is
// the honest "before" for this pack: same driver, same frames, same two
// themes — the only thing that changes is whether the numbers came from
// a real trial balance run through the engine.
async function demo() {
  const pid = arg("period", null) ?? (await periodId());
  const company = arg("company", null) ??
    (pid === "demo-meridian" ? "Meridian Industries SRL" : DEMO_COMPANY);
  const outDir = join(OUT_ROOT, LABEL);
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const report = { question: DEMO_QUESTION, periodId: pid, company, themes: {} };
  // The fictional sample resolves through `SAMPLE_DATASETS`, not through
  // the network path, so the jump/spend assertions below are about a
  // DIFFERENT code path and must not be reported as if they were the
  // real one. Captured for the side-by-side; not asserted.
  const isSample = !/^[0-9a-f-]{36}$/i.test(pid);

  for (const theme of ["light", "dark"]) {
    const { ctx, page, ledger } = await makeContext(browser, { theme });
    const tag = `--1440--${theme}`;
    const shot = async (name) => {
      await applyTheme(page, theme);
      await page.waitForTimeout(220);
      await page.screenshot({ path: join(outDir, `${name}${tag}.png`) });
      process.stdout.write(`  shot ${name}${tag}.png\n`);
    };
    const t = {};

    await openDashboard(page, pid, theme);
    await waitForPeriod(page, company);
    await page.waitForTimeout(1200);
    await shot("1-pill");

    await page.keyboard.press("Meta+k");
    await page.getByTestId("command-palette").waitFor({ timeout: 10000 });
    await page.keyboard.type(DEMO_QUESTION, { delay: 8 });
    // THE PREVIEW IS THE PRECONDITION, NOT A TIMER. Enter is only
    // meaningful once the fact index has resolved the question; pressing
    // it earlier is a race, and a race that fails in one theme and not
    // the other is a flaky capture, not a finding.
    await page.getByTestId("capsule-tier0").waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    await shot("2-typed");

    await page.keyboard.press("Enter");
    await page.getByTestId("capsule-fact-card").waitFor({ timeout: 20000 });
    await page.getByTestId("capsule-citation").waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);

    // THE CLAIM, READ OFF THE DOM. Not typed into this file.
    t.answer = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="capsule-fact-card"]');
      const money = card?.querySelector("[data-narrative-money]");
      const dot = card?.querySelector('[data-testid="capsule-provenance-dot"]');
      const cite = document.querySelector('[data-testid="capsule-citation"]');
      return {
        label: card?.querySelector("span")?.textContent?.trim() ?? null,
        figure: (money?.textContent ?? card?.querySelector("[data-fact]")?.textContent ?? "")
          .trim(),
        factKey: card?.querySelector("[data-fact]")?.getAttribute("data-fact") ?? null,
        moneyAttr: money?.getAttribute("data-narrative-money") ?? null,
        dotTarget: dot
          ? `${dot.getAttribute("data-traceable-source-statement")}/${dot.getAttribute("data-traceable-source-bucket")}`
          : null,
        citation: cite?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      };
    });
    await shot("3-answered");

    // 4 — the dot, hovered, so the affordance is visible in the capture.
    const dot = page.getByTestId("capsule-provenance-dot").first();
    await dot.scrollIntoViewIfNeeded();
    await dot.hover();
    await page.waitForTimeout(400);
    await shot("4-dot-hover");

    // 5 — THE JUMP, BOTH ENDS, AS SHIPPED AND AS INTENDED.
    //
    // 5a is what the button does today. 5b is the same trace with the
    // ONE parameter value corrected, and it exists because "show both
    // ends" is impossible otherwise: the shipped click never reaches the
    // row. Frame 5b is NOT a capture of shipped behaviour and is named
    // so nobody can mistake it for one.
    await dot.click();
    await page.waitForTimeout(3500);
    t.landedShipped = await page.evaluate(() => {
      const row = document.querySelector('[data-traceable-target="totalAssets"]');
      const head = document.querySelector("h2,h3");
      return {
        url: location.pathname + location.search,
        tabParam: new URLSearchParams(location.search).get("tab"),
        rowFound: !!row,
        rowText: row?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        pulsed: !!row?.classList.contains("traceable-pulse"),
        heading: head?.textContent?.trim() ?? null,
        // The hook strips ?highlight once it lands. Still present means
        // it never found the row and gave up silently.
        highlightStillInUrl: new URLSearchParams(location.search).has("highlight"),
      };
    });
    await shot("5a-landed-SHIPPED");

    const corrected = `${BASE}/dashboard?period=${pid}&tab=balance_sheet&highlight=totalAssets`;
    await page.goto(corrected, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await waitForPeriod(page, company);
    await page.waitForTimeout(2500);
    t.landedCorrected = await page.evaluate(() => {
      const row = document.querySelector('[data-traceable-target="totalAssets"]');
      const head = document.querySelector("h2,h3");
      return {
        url: location.pathname + location.search,
        rowFound: !!row,
        rowText: row?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        heading: head?.textContent?.trim() ?? null,
        inViewport: (() => {
          if (!row) return false;
          const r = row.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        })(),
      };
    });
    await shot("5b-landed-CORRECTED-URL");

    // 6 — an <Amount>-rendered figure. Money deliberately does NOT go
    //     through <Amount> (CapsuleFigures.tsx explains why); a
    //     dimensionless metric does, and carries `data-provenance`.
    await page.keyboard.press("Meta+k");
    await page.getByTestId("command-palette").waitFor({ timeout: 10000 });
    await page.keyboard.type(DEMO_AMOUNT_QUESTION, { delay: 8 });
    await page.getByTestId("capsule-tier0").waitFor({ timeout: 15000 });
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.getByTestId("capsule-fact-card").waitFor({ timeout: 20000 });
    await page.waitForTimeout(600);
    const amountEl = page.locator('[data-testid="capsule-fact-card"] [data-provenance="true"]').first();
    t.amount = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="capsule-fact-card"] [data-provenance="true"]');
      return el
        ? { text: el.textContent?.trim() ?? null, renderer: "Amount", hasProvenance: true }
        : null;
    });
    if (t.amount) {
      await amountEl.hover();
      await page.waitForTimeout(500);
    }
    await shot("6-amount");

    t.spendRequests = ledger.spend.length;
    t.spendUrls = [...new Set(ledger.spend)].slice(0, 5);
    report.themes[theme] = t;
    await ctx.close();
  }
  await browser.close();

  // ── THE CANARIES ────────────────────────────────────────────────────
  // A demo that captured six screenshots of an empty surface would
  // otherwise print "done" and be filed as evidence.
  const problems = [];   // the capture is not evidence
  const defects = [];    // the capture IS evidence — of a broken surface
  if (isSample) {
    writeFileSync(join(outDir, "demo-report.json"),
      JSON.stringify(report, null, 2) + "\n");
    console.log("\n" + JSON.stringify(report, null, 2));
    console.log(
      `\nCAPTURED AGAINST THE FICTIONAL SAMPLE (${pid}). No canary is asserted:\n` +
      "  this period resolves through SAMPLE_DATASETS, not through\n" +
      "  fetchPeriodFromApi, so it exercises a different path. These frames\n" +
      "  exist for the side-by-side only.");
    console.log(`-> ${outDir}`);
    return;
  }
  for (const [theme, t] of Object.entries(report.themes)) {
    const digits = (t.answer.figure || "").replace(/\D/g, "");
    if (!digits.includes("5276471779"))
      problems.push(`C-LOAD ${theme}: the figure on screen (${t.answer.figure || "<empty>"}) does not carry the fixture's total-assets digits`);
    if (t.answer.dotTarget !== "bs/totalAssets")
      problems.push(`C-LOAD ${theme}: provenance dot target was ${t.answer.dotTarget}`);
    if (!t.amount)
      problems.push(`C-LOAD ${theme}: no <Amount>-rendered figure with provenance`);
    if (t.spendRequests !== 0)
      problems.push(`C-SPEND ${theme}: ${t.spendRequests} model-seam request(s) on a Tier-0 answer`);
    if (!t.landedCorrected.rowFound)
      problems.push(`C-LOAD ${theme}: even ?tab=balance_sheet found no totalAssets row — the target itself is gone`);

    // C-JUMP. This is the surface's defect, not the driver's.
    if (!t.landedShipped.rowFound)
      defects.push(
        `C-JUMP ${theme}: the dot emitted ?tab=${t.landedShipped.tabParam} and landed on ` +
        `"${t.landedShipped.heading}". No totalAssets row on the page; ` +
        `?highlight still in the URL = ${t.landedShipped.highlightStillInUrl} ` +
        `(the hook gave up silently). The same trace with ?tab=balance_sheet ` +
        `finds "${(t.landedCorrected.rowText || "").slice(0, 46)}".`,
      );
  }

  writeFileSync(join(outDir, "demo-report.json"),
    JSON.stringify(report, null, 2) + "\n");
  console.log("\n" + JSON.stringify(report, null, 2));

  if (problems.length) {
    console.error("\nCAPTURE BROKEN — this run is not evidence of anything:");
    for (const p of problems) console.error("  · " + p);
    process.exit(2);
  }
  if (defects.length) {
    console.error("\nSURFACE DEFECT — the capture is good; the surface is not:");
    for (const d of defects) console.error("  · " + d);
    console.error(
      "\n  ROOT CAUSE  CommandPalette.jumpToSource writes ?tab=bs | pnl | cf.\n" +
      "              The dashboard's tab ids are pl | balance_sheet | cash_flow\n" +
      "              (frontend/lib/financialStatementTabs.ts TAB_SPECS).\n" +
      "              resolveActiveTab() coerces all three unknown values to \"pl\",\n" +
      "              so EVERY provenance jump lands on the P&L tab. A P&L source\n" +
      "              is right by accident; a BS or CF source is silently wrong.\n" +
      "  This gate stays RED until the mapping is fixed. It is not the driver.",
    );
    process.exit(1);
  }
  console.log(`\nALL CANARIES GREEN — figure, dot, jump, <Amount> and zero spend confirmed in both themes.`);
  console.log(`-> ${outDir}`);
}


// ══════════════════════════════════════════════════════════════════════
// latency — measured on the SHIPPED SURFACE, in the page, per frame
// ══════════════════════════════════════════════════════════════════════
//
// Every number below is the interval between an INPUT EVENT the reader
// caused and the FRAME on which the thing they were waiting for was
// painted. Not a resolver call. Not a React commit. A `MutationObserver`
// fires, one `requestAnimationFrame` passes, and the clock stops — which
// is the closest a page can get to "the reader can now see it".
//
// The instrument lives in the page (`addInitScript`) because polling
// from Node has 10–50 ms granularity, and the fastest phase here is a
// single-digit number of milliseconds. Measuring a 16 ms event with a
// 30 ms ruler is how a fast path gets published as a slow one.
//
// EACH SAMPLE GETS A FRESH PAGE. The ask guard (`capsuleAskGuard.ts`) is
// module state: 1.5 s minimum gap, 6 per rolling minute. Reusing a page
// would let the 7th sample be REFUSED and record as "instant", which is
// a measurement artifact dressed as a result.

// THE INSTRUMENT WRITES TO `window.__lat`; NODE POLLS THAT OBJECT.
//
// The first revision returned a long-lived Promise from `page.evaluate`
// and awaited it in Node. That died with "Execution context was
// destroyed" the moment anything navigated, and — worse — an in-flight
// await is silently lost rather than reported as a missing sample.
// Storing the reading in the page and polling for it decouples the two:
// the TIMESTAMPS are still taken in-page at rAF resolution, so Node's
// polling granularity cannot affect a single measured number; it only
// affects how soon Node notices.
const LAT_INSTRUMENT = () => {
  const w = window;
  w.__lat = {};
  // THE RESOURCE BUFFER OVERFLOWS, SO DO NOT READ IT LATE.
  //
  // `performance.getEntriesByType("resource")` returned ZERO tool entries
  // when queried after a turn settled — not because the request never
  // happened, but because this page issues ~575 resources and the default
  // buffer holds 250. The tool call had been evicted. Reading the buffer
  // at the end silently reported "no tool call was planned", which is a
  // different and wrong story.
  //
  // A PerformanceObserver records every entry as it lands, so eviction
  // cannot hide one.
  w.__res = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        w.__res.push({ name: e.name, responseEnd: e.responseEnd });
    }).observe({ type: "resource", buffered: true });
  } catch { /* no PerformanceObserver: the phase reports UNMEASURED */ }
  w.__latStart = (k, selector, pattern) => {
    // THE BASELINE IS THE POINT.
    //
    // The first revision stopped the clock as soon as an element
    // MATCHING the pattern existed. Typing "what are our total assets"
    // one character short leaves "…total asset", which ALREADY resolves
    // Tier 0 — so the preview was already on screen with a digit in it,
    // `hit()` returned true on its very first call, and three runs
    // reported 0.5 ms, 0.5 ms, 0.5 ms. That is the rAF cost of observing
    // an unchanged DOM, published as a product latency.
    //
    // So a sample now requires a CHANGE from the text that was on screen
    // when the clock started, and a start whose baseline ALREADY matched
    // is recorded as `baselineMatched` and thrown away by the caller
    // rather than counted.
    const re = pattern ? new RegExp(pattern) : null;
    let baseline = null;
    let baselineMatched = false;
    for (const el of document.querySelectorAll(selector)) {
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      baseline = txt;
      if (!re || re.test(txt)) baselineMatched = true;
      break;
    }
    w.__lat[k] = { t0: performance.now(), baseline, baselineMatched };
  };
  w.__latPaint = (k, selector, pattern) => {
    const re = pattern ? new RegExp(pattern) : null;
    const baseline = w.__lat[k]?.baseline ?? null;
    const hit = () => {
      for (const el of document.querySelectorAll(selector)) {
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        if ((!re || re.test(txt)) && txt !== baseline) return el;
      }
      return null;
    };
    let done = false;
    const stop = (el) => {
      if (done) return true;
      done = true;
      requestAnimationFrame(() => {
        const rec = w.__lat[k] || { t0: performance.now() };
        rec.t1 = performance.now();
        rec.ms = rec.t1 - rec.t0;
        rec.text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
        w.__lat[k] = rec;
      });
      return true;
    };
    const first = hit();
    if (first) { stop(first); return; }
    const mo = new MutationObserver(() => {
      const el = hit();
      if (el && stop(el)) mo.disconnect();
    });
    mo.observe(document.documentElement,
      { subtree: true, childList: true, characterData: true });
  };
};

/** Poll the page for a reading the instrument stored. Returns null when
 *  the phase never painted inside `timeout` — which is a RESULT, printed
 *  as UNMEASURED, not an error to be swallowed. */
async function readPaint(page, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await page
      .evaluate((k) => {
        const r = window.__lat?.[k];
        return r ? { ms: r.ms ?? null, baselineMatched: !!r.baselineMatched } : null;
      }, key)
      .catch(() => null);
    if (rec && typeof rec.ms === "number") return rec;
    await page.waitForTimeout(60);
  }
  const rec = await page
    .evaluate((k) => {
      const r = window.__lat?.[k];
      return r ? { ms: null, baselineMatched: !!r.baselineMatched } : null;
    }, key)
    .catch(() => null);
  return rec ?? { ms: null, baselineMatched: false };
}

const P = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1));
  return Math.round(s[i] * 10) / 10;
};

const TIER0_Q = "what are our total assets";
// One period is loaded, so a comparison honestly refuses at Tier 0 and
// falls through to the model — which is what makes this the right probe
// for the paid path.
const TIER1_Q = "what if revenue drops 10 percent for us";

async function latency() {
  const pid = await periodId();
  const runs = Number(arg("runs", "7"));
  const modelRuns = Number(arg("model-runs", "5"));
  const browser = await chromium.launch();
  const rec = { tier0: [], tier1Card: [], modelText: [], factsArrived: [],
                notes: [], spend: [] };

  const sidecarMode = await (await fetch(`${SIDECAR}/__demo/period-id`)).json();

  // ── phase 1: Tier-0 first paint ─────────────────────────────────────
  for (let i = 0; i < runs; i++) {
    const { ctx, page, ledger } = await makeContext(browser);
    await page.addInitScript(LAT_INSTRUMENT);
    await openDashboard(page, pid, "light");
    await waitForPeriod(page, DEMO_COMPANY);
    await page.waitForTimeout(900);
    await page.keyboard.press("Meta+k");
    await page.getByTestId("command-palette").waitFor({ timeout: 10000 });

    // Type the question MINUS its final word, let the surface settle,
    // then type that word and measure the transition. Minus one
    // CHARACTER is not enough: "…total asset" already resolves.
    const cut = TIER0_Q.lastIndexOf(" ") + 1;
    await page.keyboard.type(TIER0_Q.slice(0, cut), { delay: 6 });
    await page.waitForTimeout(700);
    await page.evaluate(
      ([sel, pat]) => {
        window.__latStart("tier0", sel, pat);
        window.__latPaint("tier0", sel, pat);
      },
      ['[data-testid="capsule-tier0"]', "\\d"],
    );
    await page.keyboard.type(TIER0_Q.slice(cut), { delay: 0 });
    const r0 = await readPaint(page, "tier0", 20000);
    if (r0.baselineMatched) {
      rec.notes.push(
        `tier0 run ${i + 1}: REJECTED — the preview already showed a figure ` +
        `before the measured keystroke, so the sample would time an unchanged DOM`);
    } else if (r0.ms == null) {
      rec.notes.push(`tier0 run ${i + 1}: never painted`);
    } else {
      rec.tier0.push(r0.ms);
    }
    if (ledger.spend.length) rec.spend.push(...ledger.spend);
    await ctx.close();
  }

  // ── phase 2: Tier-1 fact-card paint ─────────────────────────────────
  // Runs against whichever sidecar this invocation was pointed at, and
  // the report says which. As shipped, the tool layer 422s and the card
  // never paints — so this phase reports UNMEASURED with the reason,
  // and is NOT filled from a budget.
  for (let i = 0; i < modelRuns; i++) {
    const { ctx, page, ledger } = await makeContext(browser);
    await page.addInitScript(LAT_INSTRUMENT);
    await openDashboard(page, pid, "light");
    await waitForPeriod(page, DEMO_COMPANY);
    await page.waitForTimeout(900);
    await page.keyboard.press("Meta+k");
    await page.getByTestId("command-palette").waitFor({ timeout: 10000 });
    await page.keyboard.type(TIER1_Q, { delay: 6 });
    await page.waitForTimeout(400);

    await page.evaluate(
      ([cardSel, proseSel]) => {
        window.__latStart("card", cardSel, null);
        window.__latPaint("card", cardSel, null);
        window.__latStart("prose", proseSel, "\\S");
        window.__latPaint("prose", proseSel, "\\S");
      },
      ['[data-testid="capsule-fact-card"]', '[data-testid="capsule-answer-body"]'],
    );
    await page.keyboard.press("Enter");
    // One wait covers both readings; whichever never paints comes back
    // null and is reported as UNMEASURED with its reason.
    const proseR = await readPaint(page, "prose", 60000);
    const cardR = await readPaint(page, "card", 2000);
    const cardMs = cardR.ms, proseMs = proseR.ms;

    // WHEN DID THE FACTS ACTUALLY ARRIVE?
    //
    // Resource Timing and `window.__lat.card.t0` share the page's
    // `performance.now()` origin, so subtracting gives ms-from-Enter for
    // the tool response — the moment the client HAD the number — which
    // can then be compared against the frame the fact card painted on.
    const arrival = await page
      .evaluate(() => {
        const t0 = window.__lat?.card?.t0;
        if (t0 == null) return null;
        return (window.__res || [])
          .filter((e) => /\/api\/capsule\/tools\//.test(e.name))
          .map((e) => Math.round((e.responseEnd - t0) * 10) / 10)
          .filter((ms) => ms > 0);
      })
      .catch(() => null);
    if (arrival && arrival.length) {
      rec.factsArrived.push(Math.max(...arrival));
    }
    if (cardMs != null) rec.tier1Card.push(cardMs);
    if (proseMs != null) rec.modelText.push(proseMs);
    const spent = ledger.spend.filter((u) => /functions\/v1\/chat-llm/.test(u)).length;
    if (proseMs != null && spent === 0)
      rec.notes.push(`model run ${i + 1}: prose painted with NO chat-llm request — not a model sample`);
    rec.spend.push(...ledger.spend);
    await ctx.close();
  }
  await browser.close();

  const out = {
    measuredOn: {
      surface: `${BASE} (vite dev)`,
      apiOrigin: `${APP_API} rewritten to ${SIDECAR}`,
      toolBodyBinding: sidecarMode.tool_body_binding,
      periodId: pid,
      date: new Date().toISOString().slice(0, 10),
    },
    phases: {},
    notes: rec.notes,
    modelSeamRequests: rec.spend.length,
  };
  const phase = (name, xs, n, why) => {
    out.phases[name] = xs.length
      ? { samples: xs.length, p50: P(xs, 50), p95: P(xs, 95),
          min: P(xs, 0), max: P(xs, 100),
          raw: xs.map((v) => Math.round(v * 10) / 10) }
      : { samples: 0, p50: null, p95: null, state: "UNMEASURED", why };
  };
  phase("tier0_first_paint", rec.tier0, runs,
    "the Tier-0 preview never painted a digit");
  phase("tier1_fact_card_paint", rec.tier1Card, modelRuns,
    sidecarMode.tool_body_binding === "repaired"
      ? "the fact card never painted even with the tool body binding repaired"
      : "AS SHIPPED, POST /api/capsule/tools/* returns 422 (see the C-JUMP/422 finding), " +
        "so no facts reach the turn and the fact card is never rendered. " +
        "Re-run against a sidecar started with --repair-tool-body for the number " +
        "this phase would carry once the defect is closed.");
  phase("first_model_text_painted", rec.modelText, modelRuns,
    "no model prose ever painted");
  phase("facts_arrived_at_the_client", rec.factsArrived, modelRuns,
    "no /api/capsule/tools/ response completed — as shipped it 422s, and a "
    + "422 still has a responseEnd, so zero samples here means no tool call "
    + "was planned for this question at all");
  if (rec.factsArrived.length && rec.tier1Card.length) {
    const held = P(rec.tier1Card, 50) - P(rec.factsArrived, 50);
    out.phases.fact_card_held_behind_the_model = {
      p50_ms: Math.round(held * 10) / 10,
      what: "median gap between the tool response landing (the client HAS "
        + "the number) and the frame the fact card painted on.",
    };
  }

  out.phases.first_model_text_painted.note =
    "NOT a first-token time. `edgeGenerationTransport` awaits `cfoApi.chatLlm` " +
    "and yields the WHOLE answer in one chunk; `chat-llm/index.ts` contains no " +
    "streaming path. There is no first token on this surface to measure, so this " +
    "number is the complete model answer landing on screen.";

  const outFile = join(OUT_ROOT, `latency-${sidecarMode.tool_body_binding}.json`);
  writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  console.log(`\n-> ${outFile}`);
}


// ══════════════════════════════════════════════════════════════════════
// coverage — END TO END, on the shipped surface, over the ONE corpus
// ══════════════════════════════════════════════════════════════════════
//
// K3 measures `resolveTier0(q, index)` in jsdom and reports 51.4%
// (37/72). That is a true statement about a FUNCTION. This mode asks the
// question the product actually cares about: when a reader types each of
// those 72 questions into the real Capsule and presses Enter, how many
// of them reach a model seam?
//
// The corpus is loaded by TRANSPILING `frontend/lib/capsuleAskCorpus.ts`
// and importing it. Not re-typed here, not regex-scraped: a denominator
// that can drift from the file it claims to quote is the whole reason
// that file exists.
//
// ── THE THREE BUCKETS, AND WHY THE THIRD ONE MATTERS ─────────────────
//
//   answered_free   0 model-seam requests AND the surface actually
//                   produced a Tier-0 turn. This is coverage.
//   spent           ≥1 model-seam request. This is the paid path.
//   free_but_unanswered
//                   0 requests and NO answer — refused, unavailable,
//                   navigated away, or silently nothing. It costs
//                   nothing and it also answers nothing, so counting it
//                   as coverage would be the exact arithmetic that makes
//                   a gate lie. It is reported as its own line.
//
// ── WHY ONE PAGE LOAD PER QUESTION ───────────────────────────────────
//
// `capsuleAskGuard` is module state: a 1.5 s minimum gap and 6 asks per
// rolling minute. Driving 72 questions into one page would have the 7th
// onwards REFUSED — spending nothing, and scoring as coverage. That is
// canary C-GUARD, and the defence is structural rather than a sleep: a
// fresh context per question means every ask is the first ask.
//
// ── WHY THE MODEL SEAMS ARE ABORTED ──────────────────────────────────
//
// The measurement is whether the REQUEST WAS MADE. Letting 72 of them
// complete would spend real credits to learn nothing extra.

async function loadCorpus() {
  const { buildSync } = await import("esbuild");
  const built = buildSync({
    entryPoints: ["frontend/lib/capsuleAskCorpus.ts"],
    bundle: false, write: false, format: "esm", target: "es2020",
  });
  const b64 = Buffer.from(built.outputFiles[0].text).toString("base64");
  const mod = await import(`data:text/javascript;base64,${b64}`);
  return mod.CAPSULE_ASK_CORPUS;
}

async function coverage() {
  const pid = await periodId();
  const corpus = await loadCorpus();
  const limit = Number(arg("limit", String(corpus.length)));
  const rows = corpus.slice(0, limit);
  console.log(`corpus: ${corpus.length} questions (running ${rows.length})\n`);

  const browser = await chromium.launch();
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    const { ctx, page, ledger } = await makeContext(browser);
    // Record the seam, then abort it. The count is the measurement.
    for (const seam of [`${APP_API}/api/capsule/tools/**`,
                        "**/functions/v1/chat-llm**"]) {
      await page.route(seam, (route) => route.abort());
    }
    let r = {
      q: entry.query, source: entry.source, origin: entry.origin,
      spend: 0, seams: [], answered: false, tier0: false, navigated: false,
      error: null,
    };
    try {
      await openDashboard(page, pid, "light");
      await waitForPeriod(page, DEMO_COMPANY, 40000);
      await page.waitForTimeout(700);
      const urlBefore = page.url();
      await page.keyboard.press("Meta+k");
      await page.getByTestId("command-palette").waitFor({ timeout: 10000 });
      await page.keyboard.type(entry.query, { delay: 4 });
      await page.waitForTimeout(800);
      // THE RESOLVER'S OWN VERDICT, READ OFF THE REAL SURFACE.
      //
      // K3 runs `resolveTier0(q, index)` in jsdom against fixture data
      // and reports a percentage. The preview that paints while you type
      // IS that same call, running in the browser, against the index
      // built from this real period. Capturing it here gives both halves
      // of the comparison from ONE run over ONE dataset: what the
      // resolver says, and what pressing Enter then costs. A question
      // where those two disagree is the finding.
      //
      // THE PREDICATE IS THE COMPONENT'S OWN DECLARATION, not a text
      // heuristic. The first version asked "does the preview contain a
      // digit?" and counted `"The total is on file for Dec 2025, but the
      // split behind it is not — a trial balance carries the balance,
      // not the counterparty"` as a RESOLUTION, because a refusal names
      // the period it is refusing about and "2025" is a digit. Two
      // questions were reported as "resolved in the preview, then billed
      // on Enter" — a product defect that did not exist.
      //
      // `CapsuleTier0Preview` marks the refusal branch `data-refused
      // ="true"` and renders the resolved branch as a button. Reading
      // that attribute asks the surface what it decided instead of
      // guessing from its prose.
      r.previewState = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="capsule-tier0"]');
        if (!el) return "absent";
        return el.getAttribute("data-refused") === "true" ? "refused" : "resolved";
      });
      r.previewResolved = r.previewState === "resolved";
      await page.keyboard.press("Enter");
      // A TURN MUST APPEAR. If Enter raced the surface and no turn was
      // created, the row is an INSTRUMENT ERROR, not a product result —
      // the batch's first run reported "how much do we owe suppliers"
      // as free-but-unanswered on exactly this race, while the same
      // question answers free every time it is asked on its own. One
      // retry, then it is reported as an error and excluded from the
      // denominator rather than counted as a miss.
      let turnUp = await page
        .getByTestId("capsule-turn")
        .first()
        .waitFor({ timeout: 6000 })
        .then(() => true, () => false);
      if (!turnUp) {
        r.retried = true;
        await page.keyboard.press("Enter");
        turnUp = await page
          .getByTestId("capsule-turn")
          .first()
          .waitFor({ timeout: 6000 })
          .then(() => true, () => false);
      }
      // The seams are aborted, so nothing here waits on a model.
      await page.waitForTimeout(3500);
      r.turnCreated = turnUp;
      const dom = await page.evaluate(() => ({
        turn: !!document.querySelector('[data-testid="capsule-turn"]'),
        card: !!document.querySelector('[data-testid="capsule-fact-card"]'),
        tier0Note: !!document.querySelector('[data-testid="capsule-tier0-note"]'),
        cite: !!document.querySelector('[data-testid="capsule-citation"]'),
        degraded: !!document.querySelector('[data-testid="capsule-degraded"]'),
        body: (document.querySelector('[data-testid="capsule-answer-body"]')
          ?.textContent || "").trim().length,
      }));
      r.navigated = page.url() !== urlBefore;
      if (!turnUp && !r.navigated) {
        r.error = "no turn was created and the page did not navigate — "
          + "Enter did not reach the surface (instrument race, not a result)";
      }
      r.tier0 = dom.tier0Note;
      r.answered = dom.tier0Note || (dom.card && !dom.degraded);
      r.dom = dom;
      r.spend = ledger.spend.length;
      r.seams = [...new Set(ledger.spend.map((u) =>
        MODEL_SEAMS.find((s) => s.match.test(u))?.label))];
    } catch (e) {
      r.error = String(e).slice(0, 160);
    }
    results.push(r);
    const mark = r.spend > 0 ? "$" : r.answered ? "free" : "—";
    process.stdout.write(
      `  ${String(i + 1).padStart(2)}/${rows.length} [${mark.padEnd(4)}] ${entry.query.slice(0, 62)}\n`);
    await ctx.close();
  }
  await browser.close();

  // Preview resolved, but Enter still reached a seam. This is the exact
  // shape of "the percentage measured a path that never ran".
  const previewButPaid = results.filter((r) => r.previewResolved && r.spend > 0);
  const bySeam = {};
  for (const r of results)
    for (const label of r.seams) bySeam[label] = (bySeam[label] ?? 0) + 1;

  // K3 counts TWO deterministic ways to reach an answer with no model
  // call: Tier 0 resolves it, or the router sends it to a destination
  // whose row declares itself free. Both are kept separate here so the
  // end-to-end figure is comparable to K3's line by line rather than
  // only in aggregate.
  const answeredFree = results.filter((r) => r.spend === 0 && r.answered);
  const routedFree = results.filter((r) => r.spend === 0 && !r.answered && r.navigated);
  const spent = results.filter((r) => r.spend > 0);
  const freeUnanswered = results.filter(
    (r) => r.spend === 0 && !r.answered && !r.navigated);
  const errors = results.filter((r) => r.error);

  const out = {
    measuredOn: {
      surface: `${BASE} (vite dev)`,
      apiOrigin: `${APP_API} rewritten to ${SIDECAR}`,
      periodId: pid, date: new Date().toISOString().slice(0, 10),
      corpusFile: "frontend/lib/capsuleAskCorpus.ts",
      pageLoadsPerQuestion: 1,
    },
    total: results.length,
    answered_free: answeredFree.length,
    routed_free: routedFree.length,
    spent: spent.length,
    free_but_unanswered: freeUnanswered.length,
    errors: errors.length,
    zero_spend_coverage_pct:
      Math.round(((answeredFree.length + routedFree.length) / results.length) * 1000) / 10,
    answered_in_place_pct:
      Math.round((answeredFree.length / results.length) * 1000) / 10,
    questions_reaching_a_seam_pct:
      Math.round((spent.length / results.length) * 1000) / 10,
    tier0_preview_resolved: results.filter((r) => r.previewResolved).length,
    preview_resolved_but_still_paid: previewButPaid.map((r) => r.q),
    seam_breakdown: bySeam,
    rows: results,
  };
  writeFileSync(join(OUT_ROOT, "coverage-e2e.json"),
    JSON.stringify(out, null, 2) + "\n");

  console.log("\n──────────────────────────────────────────────");
  console.log(`  answered in place, free    ${out.answered_free}/${out.total}  (${out.answered_in_place_pct}%)`);
  console.log(`  routed to a free page      ${out.routed_free}/${out.total}`);
  console.log(`  ZERO-SPEND, either way     ${out.answered_free + out.routed_free}/${out.total}  (${out.zero_spend_coverage_pct}%)   <- comparable to K3's 37/72`);
  console.log(`  reached a model seam       ${out.spent}/${out.total}  (${out.questions_reaching_a_seam_pct}%)`);
  console.log(`  free but UNANSWERED        ${out.free_but_unanswered}/${out.total}`);
  console.log(`  driver errors              ${out.errors}`);
  console.log("──────────────────────────────────────────────");
  console.log(`  Tier-0 preview resolved    ${out.tier0_preview_resolved}/${out.total}   (the resolver's own verdict, on this data)`);
  console.log(`  …of which still PAID       ${previewButPaid.length}`);
  console.log(`  seam breakdown             ${JSON.stringify(bySeam)}`);
  if (previewButPaid.length) {
    console.log("\n  resolved in the preview, then billed on Enter:");
    for (const r of previewButPaid) console.log(`    · ${r.q.slice(0, 70)}`);
  }
  if (freeUnanswered.length) {
    console.log("\n  free but unanswered — NOT coverage:");
    for (const r of freeUnanswered)
      console.log(`    · ${r.q.slice(0, 70)}${r.navigated ? "  [navigated]" : ""}`);
  }

  // ── C-SPEND ─────────────────────────────────────────────────────────
  if (spent.length === 0) {
    console.error(
      "\nC-SPEND BROKEN: not one of the 72 questions reached a model seam.\n" +
      "  Either the seam matchers are wrong or the ask path never dispatched.\n" +
      "  A 100% zero-spend result from this run would be a broken counter,\n" +
      "  not a product achievement. Refusing to report it.",
    );
    process.exit(2);
  }
  if (errors.length) {
    console.error(`\n${errors.length} question(s) errored — the denominator is not clean:`);
    for (const r of errors) console.error(`  · ${r.q.slice(0, 60)} :: ${r.error}`);
    process.exit(1);
  }
  console.log(`\n-> ${join(OUT_ROOT, "coverage-e2e.json")}`);
}

const MODES = { probe, explore, demo, latency, coverage };

if (!MODES[MODE]) {
  console.error(`unknown mode ${MODE}; known: ${Object.keys(MODES).join(", ")}`);
  process.exit(2);
}
await MODES[MODE]();
