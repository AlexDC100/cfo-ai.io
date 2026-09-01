#!/usr/bin/env node
/**
 * THE `period` FAMILY — the census G4 never took.
 *
 * G4 pinned `period` at exactly zero and justified the pin with
 * "`usePeriodStepper().periods` is empty on the test-mode stack, so the
 * palette's period loop iterates nothing." That is FALSE, and this file
 * is the measurement that replaces it.
 *
 * ── WHAT THE SWEEP WAS ACTUALLY MEASURING ────────────────────────────
 *
 * `boot()` navigates ONCE and reads the palette on a COLD MOUNT. On the
 * first page load of a fresh browser context the app resolves NO ACTIVE
 * WORKSPACE, so `usePeriodStepper`'s direct feed is `enabled: !!org?.id`
 * = false and the merged list is empty. Measured, in this order:
 *
 *   ·  +173ms  GET /api/test-mode/session          (the session arrives)
 *   ·  +479ms  "[org] auto-created default workspace: Test workspace"
 *              — `fetchOrgsForUser()` had already run and returned
 *              `{orgs: [], error: false}` because `auth.getSession()`
 *              had no user yet, so ensure-default fired on a FALSE zero
 *   ·  +721ms  POST rpc/list_workspaces -> 1000 rows
 *   · +1313ms  GET financial_periods -> 4 rows
 *
 * The DATA is therefore present and cached well inside `boot()`'s 8s
 * settle — dumped from `cfoai-query-cache-v1` at t=8s on the cold mount:
 *
 *   ["org-periods","00000000-0000-4000-8000-000000000002"] status=success n=4
 *
 * and the palette STILL paints zero period rows. So this was never "the
 * data has not arrived yet", and no amount of waiting fixes it: read out
 * of the React fiber with the palette open at t=8.6s on the cold mount,
 * `AppShell`'s `useActiveOrg()` holds NO org list at all, while on the
 * second navigation the same fiber holds `ORGS[1000]` and a
 * `PAYLOAD{periods:4}`. `lib/org.ts` memoises the list in the
 * MODULE-GLOBAL `cachedOrgListPromise` and `load()`'s deps are
 * `[status, userId]`, both stable — so the empty resolution is permanent
 * for the page load. A 20s extra wait on the same mount changes nothing
 * (measured); a reload fixes it, because the Supabase session is in
 * localStorage by then and `list_workspaces` succeeds on the first call.
 *
 * ── WHAT THIS TOOL DOES ──────────────────────────────────────────────
 *
 * Boots with the corrected protocol (`bootPopulated`), then censuses
 * every candidate query by row FAMILY at both viewports in both themes,
 * so the `period` expectation G4 records is a measurement and not a
 * story. It also re-measures the COLD mount in the same run, so the
 * before/after is one artifact rather than two.
 *
 * Usage:
 *   node design_review/capsule-craft/period-census.mjs --label period-r0
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const arg = (n, d) => {
  const i = ARGS.indexOf("--" + n);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const LABEL = arg("label", "period-r0");
const BASE = arg("base", "http://localhost:5173");
const OUT = join("design_review", "capsule-craft", LABEL);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const THEMES = ["dark", "light"];

/** Every query worth asking of the period family, plus the sweep's own
 *  so the census is comparable with G4's. */
const QUERIES = [
  "", // rest
  "202", "aug", "dec", "sep", "jul",
  "dash", "sce", "work", "bench", "prod", "sett", "cash", "bal",
  "a", "range", "core", "trans", "glossary", "zzqqxx",
];

const LEARNING = { mode: "subtle", coachDismissed: true, tutorialsSeen: {} };
const OVERLAY = '[data-testid="command-palette"]';
const COMPOSER =
  `${OVERLAY} textarea, ${OVERLAY} input[type="text"], ${OVERLAY} [contenteditable="true"]`;

async function dismissBanner(page) {
  const b = page.getByTestId("test-mode-banner-dismiss");
  if (await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function open(page) {
  await dismissBanner(page);
  const t = page.locator('[data-testid="header-command-bar"]').first();
  await t.waitFor({ state: "visible", timeout: 20000 });
  await t.click({ timeout: 20000 });
  await page.locator(OVERLAY).waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(600);
}

async function close(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

/** Census one state by family, and report each period row's trailing
 *  glyph geometry so the ban is measured here too, not only in G4. */
async function census(page, q) {
  const input = page.locator(COMPOSER).locator("visible=true").first();
  await input.click();
  await input.fill("");
  if (q) await input.fill(q);
  await page.waitForTimeout(400);
  return page.locator(OVERLAY).evaluate((root) => {
    const painted = (el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const rows = [...root.querySelectorAll("[data-row-source]")].filter(painted);
    const byFamily = {};
    const periodRows = [];
    for (const row of rows) {
      const src = row.getAttribute("data-row-source");
      const fam = row.getAttribute("data-row-family") ?? src;
      byFamily[fam] = (byFamily[fam] ?? 0) + 1;
      if (fam !== "period") continue;
      const leaves = [];
      const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const txt = (n.textContent ?? "").trim();
        if (!txt || !n.parentElement || !painted(n.parentElement)) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        const box = r.getBoundingClientRect();
        if (box.width < 1) continue;
        leaves.push({ text: txt, left: box.left, right: box.right });
      }
      leaves.sort((a, b) => a.left - b.left);
      const rb = row.getBoundingClientRect();
      periodRows.push({
        text: leaves.map((l) => l.text).join(" ⟨/⟩ "),
        runs: leaves.length,
        glyphGutter:
          leaves.length >= 2
            ? Math.round(leaves[leaves.length - 1].left - leaves[0].right)
            : null,
        rightSlack:
          leaves.length >= 1 ? Math.round(rb.right - leaves[leaves.length - 1].right) : null,
      });
    }
    return { rows: rows.length, byFamily, periodRows };
  });
}

/**
 * THE CORRECTED BOOT. See the header: the first page load of a fresh
 * context resolves no workspace and never recovers, so the populated
 * state needs a RELOAD — and then it is AWAITED, not slept on.
 *
 * What is awaited: `[data-row-family="period"]` painting for a query
 * measured to summon it. `usePeriodStepper` has exactly ONE live
 * consumer in this app (`CommandPalette`) — `PeriodBreadcrumb`, the
 * other surface that reads it, is imported by nothing — so there is no
 * upstream DOM proxy for that hook. The wait is bounded and does not
 * throw: whether it succeeded is REPORTED, so a failure is a
 * measurement rather than a harness error.
 */
async function bootPopulated(page, opts = { reload: true }) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  await dismissBanner(page);
  if (!opts.reload) return { populated: null, waitedMs: 0 };

  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await dismissBanner(page);
  await open(page);
  const t0 = Date.now();
  const input = page.locator(COMPOSER).locator("visible=true").first();
  await input.click();
  await input.fill("202");
  const populated = await page
    .locator(`${OVERLAY} [data-row-family="period"]`)
    .first()
    .waitFor({ state: "visible", timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  return { populated, waitedMs: Date.now() - t0 };
}

const results = { label: LABEL, at: new Date().toISOString(), cold: {}, populated: {} };
const browser = await chromium.launch();

// ── 1. THE COLD MOUNT, for the record ────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript((s) => {
    window.localStorage.setItem("cfo:learning-mode:v1", JSON.stringify(s));
  }, LEARNING);
  await page.addInitScript((t) => {
    window.localStorage.setItem("cfoai_theme", t);
  }, "dark");
  await bootPopulated(page, { reload: false });
  await open(page);
  for (const q of ["", "202", "aug", "a"]) results.cold[q || "(rest)"] = await census(page, q);
  await ctx.close();
  console.log("COLD MOUNT (one navigation + 8s settle — today's boot()):");
  for (const [q, r] of Object.entries(results.cold))
    console.log(`  q=${JSON.stringify(q)}  rows=${r.rows}  fam=${JSON.stringify(r.byFamily)}`);
}

// ── 2. THE POPULATED STATE, every viewport × theme ───────────────────
for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    const key = `${vp.name}/${theme}`;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await page.addInitScript((s) => {
      window.localStorage.setItem("cfo:learning-mode:v1", JSON.stringify(s));
    }, LEARNING);
    await page.addInitScript((t) => {
      window.localStorage.setItem("cfoai_theme", t);
    }, theme);

    const boot = await bootPopulated(page);
    const states = {};
    for (const q of QUERIES) states[q || "(rest)"] = await census(page, q);
    results.populated[key] = { boot, states };

    console.log(`\n${key}  populated=${boot.populated} awaited=${boot.waitedMs}ms`);
    for (const [q, r] of Object.entries(states)) {
      const p = r.byFamily.period ?? 0;
      console.log(
        `  q=${String(JSON.stringify(q)).padEnd(11)} rows=${String(r.rows).padStart(2)} ` +
          `period=${p}  fam=${JSON.stringify(r.byFamily)}`,
      );
      for (const pr of r.periodRows)
        console.log(
          `        · "${pr.text}" runs=${pr.runs} glyphGutter=${pr.glyphGutter} rightSlack=${pr.rightSlack}`,
        );
    }
    await ctx.close();
  }
}

writeFileSync(join(OUT, "census.json"), JSON.stringify(results, null, 2));
console.log(`\nwrote ${join(OUT, "census.json")}`);
await browser.close();
