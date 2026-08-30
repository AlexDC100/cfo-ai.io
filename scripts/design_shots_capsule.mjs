#!/usr/bin/env node
/**
 * THE CAPSULE — answer-surface screenshot loop.
 *
 * `design_shots.mjs` captures ROUTES; the answer surface is not a route,
 * it is a state of an overlay. This driver reaches that state the way a
 * reader does — ⌘K, type, Enter on the Ask row — and captures each beat,
 * so the critique is written against what the surface actually paints
 * rather than against a mounted component in isolation.
 *
 * Beats captured, per viewport × theme:
 *   1  capsule-rest      the header pill at rest
 *   2  palette-search    ⌘K open, empty query
 *   3  palette-ask-row   a question typed — the Ask row and its placement
 *   4  answer-retrieval  Enter pressed; the retrieval trace + skeleton
 *   5  answer-done       the finished answer (or its calm degraded state)
 *   6  answer-evidence   "Show evidence" expanded
 *   7  answer-followup   a follow-up typed into the pinned input
 *
 * Usage (needs the test-mode stack: vite :5173 + engine :8000
 * PUBLIC_TEST_MODE=1, exactly like design_shots.mjs):
 *   node scripts/design_shots_capsule.mjs --label capsule-r1 --theme both
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
function arg(name, dflt) {
  const i = ARGS.indexOf("--" + name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
}

const LABEL = arg("label", "capsule-adhoc");
const BASE = arg("base", "http://localhost:5173");
const THEME = arg("theme", "both");
const ROUTE = arg("routes", "/dashboard");
const QUESTION = arg("q", "how did revenue change vs last month");
const FOLLOWUP = arg("q2", "and equity?");
const ANSWER_WAIT_MS = Number(arg("wait", "45000"));
// `--stub-tools 1` fulfils /api/capsule/tools/* from the fixture
// workspace instead of the live engine. The MODEL call stays real, so
// the guard, the placeholder resolution and the money renderer are all
// genuinely exercised — only the read layer is stood in for. Use it when
// the local engine predates the capsule router (it 404s), and SAY SO in
// the critique: the figures on those shots are fixture figures.
const STUB_TOOLS = arg("stub-tools", "0") === "1";

const FIXTURE_PERIODS = [
  { id: "p-2025-12", label: "Dec 2025", snapshot: "snap-a1b2c3d4" },
  { id: "p-2025-11", label: "Nov 2025", snapshot: "snap-b2c3d4e5" },
];
const SERIES = {
  revenue: [41372756000, 37880114500],
  net_result: [3678735300, 3402118844],
  total_assets: [29305008511, 28840112077],
  equity: [15015155111, 14438892027],
};

function stubMoney(fact, metric, minor, idx, scope) {
  const p = FIXTURE_PERIODS[idx] ?? FIXTURE_PERIODS[0];
  return {
    kind: "money", fact, metric, unit: "money",
    amount_minor: minor, value: minor / 100, currency: "RON",
    scope: scope ?? p.label, label_key: "",
    provenance: {
      period_id: p.id, period_label: p.label, entity_id: "org-fixture",
      source: "assembled_canonical_v1", tier: "served", snapshot_id: p.snapshot,
    },
  };
}

function stubPayload(tool, args) {
  const values = [];
  if (tool === "compare_periods") {
    for (const metric of args.metrics ?? ["revenue"]) {
      const series = SERIES[metric];
      if (!series) continue;
      values.push(stubMoney(`${metric}_a`, metric, series[1], 1));
      values.push(stubMoney(`${metric}_b`, metric, series[0], 0));
      values.push(stubMoney(`${metric}_delta`, metric, series[0] - series[1], 0,
        "Nov 2025 → Dec 2025"));
    }
  } else if (tool === "get_facts") {
    const series = SERIES[args.metric];
    if (series) values.push(stubMoney(args.metric, args.metric, series[0], 0));
  }
  const facts = {}, units = {};
  for (const v of values) { facts[v.fact] = v.value; units[v.fact] = "money"; }
  return {
    version: "ct1", tool, read_only: true, ok: values.length > 0,
    values, rows: [], gaps: [], limitations: [], notes: [],
    facts, fact_units: units, currency: values.length ? "RON" : null,
  };
}

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
];

const outDir = join("design_review", "capsule", LABEL);
mkdirSync(outDir, { recursive: true });

const themes = THEME === "both" ? ["light", "dark"] : [THEME];
const browser = await chromium.launch();

for (const theme of themes) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    const page = await ctx.newPage();
    if (STUB_TOOLS) {
      await page.route("**/api/capsule/tools/**", async (route) => {
        const tool = new URL(route.request().url()).pathname.split("/").pop();
        let args = {};
        try { args = JSON.parse(route.request().postData() || "{}").args ?? {}; } catch { /* empty */ }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(stubPayload(tool, args)),
        });
      });
    }
    const tag = `${vp.name}--${theme}`;
    const shot = async (beat) => {
      await page.waitForTimeout(250);
      const name = `${beat}--${tag}.png`;
      await page.screenshot({ path: join(outDir, name) });
      process.stdout.write(`shot ${name}\n`);
    };

    try {
      await page.goto(BASE + ROUTE, { waitUntil: "networkidle", timeout: 45000 });
    } catch {
      /* networkidle starves on polling pages — capture anyway */
    }
    await page.evaluate((t) => {
      try { localStorage.setItem("theme", t); } catch { /* private mode */ }
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(t);
      root.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(400);
    try {
      const d = page.getByTestId("test-mode-banner-dismiss");
      if (await d.isVisible({ timeout: 1200 })) await d.click();
    } catch { /* banner absent */ }
    await page.waitForTimeout(700);

    // 1 — the pill at rest.
    await shot("1-capsule-rest");

    // 2 — ⌘K.
    await page.keyboard.press("Meta+k");
    try {
      await page.getByTestId("command-palette").waitFor({ timeout: 5000 });
    } catch {
      process.stdout.write(`WARN palette did not open (${tag})\n`);
    }
    await shot("2-palette-search");

    // 3 — a question typed. The Ask row must be one keystroke away.
    await page.keyboard.type(QUESTION, { delay: 12 });
    await page.waitForTimeout(350);
    await shot("3-palette-ask-row");

    // 4 — Enter on the Ask row; the retrieval trace is what fills the
    //     gap before the first token.
    const askRow = page.locator('[data-ask="true"]');
    if (await askRow.count()) {
      await askRow.first().click();
    } else {
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(220);
    await shot("4-answer-retrieval");

    // 5 — the finished answer, however it finished.
    try {
      await page
        .locator('[data-testid="capsule-citation"], [data-testid="capsule-degraded"]')
        .first()
        .waitFor({ timeout: ANSWER_WAIT_MS });
    } catch {
      process.stdout.write(`WARN answer did not settle within ${ANSWER_WAIT_MS}ms (${tag})\n`);
    }
    await page.waitForTimeout(600);
    await shot("5-answer-done");

    // 6 — evidence expanded.
    try {
      const toggle = page.getByTestId("capsule-evidence-toggle");
      if (await toggle.isVisible({ timeout: 2000 })) await toggle.click();
    } catch { /* no answer to expand */ }
    await shot("6-answer-evidence");

    // 7 — the follow-up input, focused and carrying text.
    try {
      const input = page.getByTestId("capsule-followup");
      if (await input.isVisible({ timeout: 2000 })) {
        await input.click();
        await input.type(FOLLOWUP, { delay: 12 });
      }
    } catch { /* no thread */ }
    await shot("7-answer-followup");

    await ctx.close();
  }
}

await browser.close();
console.log(`\nDONE -> ${outDir}`);
