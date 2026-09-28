/**
 * THE COMMAND BAR (⌘K) — the live half (design C2/C3/C5), against the REAL
 * production bundle and the hermetic backend double
 * (e2e/workspace-v2.double.ts). Nothing leaves the machine; the engine's
 * answers are captures ("Ce contează acum" and the sector documents as
 * the ENGINE composed them over the same two bodies —
 * frontend/lib/__tests__/fixtures/attention/, drift-held by
 * tests/engine/test_cmdbar_fixtures.py).
 *
 *   G0  every anchor this file depends on resolves live (closed, open,
 *       typed) — a renamed element fails HERE, not as a quiet green below.
 *   G1  the header line names the company and the period being searched,
 *       and the empty state is THAT company's (swap test, live).
 *   G2  typing: groups in order, answer first, "Întreabă CFO AI" last,
 *       Tab jumps to it; every row family paints (FAMILY_EXPECT floors).
 *   G3  a keystroke fetches NOTHING (the double counts every request) —
 *       counted only after the network has stayed quiet for the whole
 *       DEBOUNCE_HORIZON_MS, so a request a keystroke DEFERS (a debounce,
 *       any timer) is counted too (G6 and G7 count the same way).
 *   G4  no horizontal overflow at 390; the panel fits the viewport — at rest
 *       and for every typed query of the screenshot loop.
 *   G5  an item opens its evidence: a ratio answer → the ratios tab with
 *       its drawer; a Cont row → the account view on that leaf,
 *       highlighted; a "Ce contează acum" item naming a line → that line.
 *   G6  SERVED EQUALITY, live (stage CB-G): every Răspuns and Cont figure
 *       the real bundle paints — each statement answer, each ratio_table
 *       row, EVERY leaf account of both books — character-equals the value
 *       in the body the double served, printed by the app's own printers
 *       (e2e/cmdbar.printers.entry.ts, bundled from the same source and run
 *       in the same browser), in RO and EN — each printed in the BAR'S
 *       language, stated to the printer, and every painted figure (and every
 *       resting one) free of the other language's number format
 *       (frontend/test/numberLanguage.ts; owner ticket 2026-09-28: the
 *       English bar painted "413,7 mil. RON"); and nothing is fetched
 *       meanwhile.
 *   G7  LATENCY, live: every keystroke of the typed queries re-renders the
 *       groups in < 100 ms, measured in the page from the input event to the
 *       list naming the query, with ZERO requests; the keyboard flow
 *       (↓ stops on "Întreabă CFO AI", ↑ back to the answer, Enter opens the
 *       answer's evidence, Esc closes) on the real bundle.
 *   G9  LEGIBLE, live: every figure, change, position and basis a row
 *       carries lies inside its row and the list's width, never cut by an
 *       ellipsis — at rest and typed, 1440 and 390, both companies, RO/EN.
 *   G8  IN VIEW, live: every row ↓ selects is the row the reader sees —
 *       never parked under the sticky "Întreabă CFO AI" — at 1440 and 390,
 *       both companies; and a new query selects its own first row whatever
 *       the previous walk left (both defects found by this stage's probe).
 *   G10 A SWITCH, live (review of stage CB-H): Scandia → Agras with the bar
 *       open (at rest, typed) and closed, and Scandia Dec 2025 → Dec 2024,
 *       each through an in-app navigation (no reload — the query cache and
 *       its keepPreviousData live on). Every frame the bar paints (a
 *       MutationObserver in the page) carries only figures the header's own
 *       company and month paint when opened alone; no request asks one
 *       company about another's period; after the switch settles nothing
 *       names a period of the company left behind. From the switch on the
 *       double answers every engine document SWITCH_DELAY_MS late, so the
 *       window a kept (placeholder) payload is shown in is always open.
 *   G11 THE BAR'S OWN SWITCH, live (review round 2 of stage CB-I): from
 *       Scandia's dashboard (EN and RO), its company page, /benchmark, a
 *       bare /dashboard and /settings, the reader picks "Switch to Agras
 *       SRL". The header names Agras within SWITCH_WITHIN_MS and still names
 *       it past the hold's ask window (HOLD_ASK_WINDOW_MS, read from
 *       lib/companyOnScreen.ts); the page is never held blank under it; the
 *       URL it ends on is Agras's own screen; the G6 header watch sees no
 *       header over another company's page; no request pairs a company with
 *       another's period, and once the header names Agras nothing names
 *       Scandia's; the bar opened again searches Agras with Agras's own
 *       items. G10 moves the URL itself — this one presses the bar's row.
 *
 * Screenshots (CMDBAR_SHOTS_DIR set): Scandia and Agras × empty and typed
 * ("profit", "4111", "clienti", "stoc", "raport") × 1440 and 390 × Terminal
 * (dark) and Paper (light) × RO and EN — 96 captures.
 *
 * HERMETIC ONLY. The double answers two unresolvable hosts; against a dev
 * server built from .env nothing would be intercepted. Run (VITE_OUT_DIR
 * must name the same directory as --outDir: the legal-page prerender reads
 * it, and fails on the default dist/ when --outDir points elsewhere):
 *   VITE_OUT_DIR=/tmp/cmdbar-dist VITE_SUPABASE_URL=http://harness.invalid \
 *     VITE_SUPABASE_ANON_KEY=harness-anon VITE_API_URL=http://engine.invalid \
 *     npx vite build --outDir /tmp/cmdbar-dist
 *   npx vite preview --outDir /tmp/cmdbar-dist --port 4417 --strictPort &
 *   E2E_HERMETIC=1 E2E_BASE_URL=http://127.0.0.1:4417 \
 *     npx playwright test e2e/design/cmdbar.spec.ts --project=chromium
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGRAS,
  ATTENTION,
  ORG_AGRAS,
  ORG_SCANDIA,
  SCANDIA,
  SECTOR_BENCHMARK,
  WorkspaceDouble,
  installHeaderWatch,
} from "../workspace-v2.double";
import { foreignNumber } from "../../frontend/test/numberLanguage";

test.skip(
  () => process.env.E2E_HERMETIC !== "1",
  "the command bar's live gates run only against the hermetic build (see the header)",
);

// ── G0 — the anchors, declared once ─────────────────────────────────────
const ANCHORS_CLOSED = ['[data-testid="header-command-bar"]'];
const ANCHORS_OPEN = [
  '[data-testid="command-palette"]',
  '[data-testid="cmdbar"]',
  '[data-testid="cmdbar-scope"]',
  '[data-testid="cmdbar-rows"]',
  '[data-testid="capsule-composer"]',
  '[data-testid="cmdbar-row-now"]',
  '[data-testid="cmdbar-row-now-action"]',
  '[data-testid="cmdbar-caveat"]',
];
const ANCHORS_TYPED = [
  '[data-testid="cmdbar-heading-answer"]',
  '[data-testid="cmdbar-row-answer"]',
  '[data-testid="cmdbar-row-ask"]',
];
const ANCHORS = [...ANCHORS_CLOSED, ...ANCHORS_OPEN, ...ANCHORS_TYPED];

// ── the row families (scripts/check_capsule_craft.mjs F2b holds this table
//    to cmdbar/cmdbarRows.ts CMDBAR_ROW_KINDS) ─────────────────────────────
const FAMILY_EXPECT = {
  now: { query: "", floor: 2 },
  "now-action": { query: "", floor: 1 },
  answer: { query: "profit", floor: 1 },
  account: { query: "4111", floor: 1 },
  // Both books hold more 4111 leaves than the Cont group shows (Scandia 6,
  // Agras 4): the rest are counted and opened by this row, never hidden.
  "account-more": { query: "4111", floor: 1 },
  page: { query: "bilant", floor: 1 },
  action: { query: "exporta", floor: 1 },
  ask: { query: "profit", floor: 1 },
};
const FAMILY_UNVERIFIED = {
  recent: "painted only after a pick on this device; held by commandBar.test.tsx (recent searches)",
};

const SCANDIA_PERIOD = SCANDIA.period.period.id as string;
const AGRAS_PERIOD = AGRAS.period.period.id as string;
const COMPANIES = [
  { key: "scandia", org: ORG_SCANDIA, period: SCANDIA_PERIOD, name: "Scandia Food SRL" },
  { key: "agras", org: ORG_AGRAS, period: AGRAS_PERIOD, name: "Agras SRL" },
] as const;

const SHOTS = process.env.CMDBAR_SHOTS_DIR ? resolve(process.env.CMDBAR_SHOTS_DIR) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function openDashboard(page: Page, double: WorkspaceDouble, c: (typeof COMPANIES)[number]) {
  double.periods[ORG_AGRAS] = [AGRAS]; // Agras analysed: both companies hold FY2025
  await double.install(page);
  await page.goto(`/dashboard?period=${c.period}&org=${c.org}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("header-command-bar")).toContainText(c.name, { timeout: 25_000 });
}

async function openBar(page: Page) {
  await page.getByTestId("header-command-bar").click();
  await expect(page.getByTestId("command-palette")).toBeVisible();
  // The empty state has painted the engine's items (the prefetch landed).
  await expect(page.getByTestId("cmdbar-row-now").first()).toBeVisible({ timeout: 15_000 });
}

/** Wait until the page behind the bar has stopped talking to the double
 *  (no new request for `quietMs`), so what is counted next is the bar's. */
async function settle(page: Page, double: WorkspaceDouble, quietMs = 1200) {
  let last = -1;
  let stableSince = Date.now();
  for (let i = 0; i < 100; i++) {
    const n = double.requests.length;
    if (n !== last) { last = n; stableSince = Date.now(); }
    if (Date.now() - stableSince >= quietMs) return;
    await page.waitForTimeout(150);
  }
}

/** THE DEBOUNCE HORIZON (review of stage CB-H). A request a keystroke
 *  DEFERS — a debounce, a throttle, any timer — is issued after its window;
 *  a count taken a fixed 300 ms after typing could not see a 400 ms one.
 *  Every zero-request law counts only once the network has been quiet for
 *  this long after the last keystroke (`settle`). */
const DEBOUNCE_HORIZON_MS = 1500;

/** The requests a count holds against the bar: every request to either
 *  doubled host EXCEPT the header's engine-status dot, which polls
 *  `GET /health` on its own 20 s clock (lib/useBackendStatus.ts, CLAUDE.md
 *  §17) — a wait past the debounce horizon can meet it, and it is no
 *  keystroke's. Nothing else is excused. */
function heldAgainstTheBar(reqs: { method: string; path: string }[]): string[] {
  return reqs.filter((r) => !(r.method === "GET" && r.path === "/health")).map((r) => `${r.method} ${r.path}`);
}

async function typeQuery(page: Page, q: string) {
  const input = page.getByTestId("capsule-composer");
  await input.fill(q);
}

test.describe("G0 — every anchor this file depends on resolves live", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("closed, open and typed anchors all match a real element (ANCHORS_CLOSED / ANCHORS_OPEN)", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "dark", language: "en" });
    await openDashboard(page, double, COMPANIES[0]);
    for (const a of ANCHORS_CLOSED) await expect(page.locator(a).first(), a).toBeVisible();
    await openBar(page);
    for (const a of ANCHORS_OPEN) await expect(page.locator(a).first(), a).toBeAttached();
    await typeQuery(page, "profit");
    for (const a of ANCHORS_TYPED) await expect(page.locator(a).first(), a).toBeVisible();
    const FLOOR = ANCHORS.length;
    expect(FLOOR, "VACUITY: no anchors declared").toBeGreaterThanOrEqual(10);
  });
});

test.describe("G1/G2/G3 — the bar on each company", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(90_000);

  test("header, swap test, groups, families, zero fetch per keystroke", async ({ browser }) => {
    const restTexts: string[] = [];
    for (const c of COMPANIES) {
      const double = new WorkspaceDouble({ theme: "dark", language: "ro" });
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const pageFor = await ctx.newPage();
      await openDashboard(pageFor, double, c);
      await openBar(pageFor);

      // G1 — the header names this company and its period.
      await expect(pageFor.getByTestId("cmdbar-scope")).toHaveText(new RegExp(`^Caut în ${c.name} · `));
      // The rows ARE the engine's items, in the engine's rank.
      const served = (ATTENTION[c.period].items as { key: string }[]).map((i) => `now:${i.key}`);
      const ids = await pageFor.getByTestId("cmdbar-row-now").evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-row-id")));
      expect(ids).toEqual(served);
      restTexts.push((await pageFor.getByTestId("cmdbar-rows").innerText()).replace(/[0-9][0-9.,\s]*/g, "#"));
      // The caveat is printed once for the panel.
      await expect(pageFor.getByTestId("cmdbar-caveat")).toHaveCount(1);

      // G2 — every family paints where its query says it does.
      let families = 0;
      for (const [family, want] of Object.entries(FAMILY_EXPECT)) {
        await typeQuery(pageFor, want.query);
        const n = await pageFor.locator(`[data-testid="cmdbar-row-${family}"]`).count();
        expect(n, `${c.key}: family ${family} for "${want.query}"`).toBeGreaterThanOrEqual(want.floor);
        families++;
      }
      expect(families, "VACUITY: families checked").toBe(Object.keys(FAMILY_EXPECT).length);
      void FAMILY_UNVERIFIED;

      // Groups in order; Întreabă CFO AI last; Tab jumps to it.
      await typeQuery(pageFor, "clienti");
      const headings = await pageFor.locator('[data-testid^="cmdbar-heading-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-testid")));
      expect(headings[0]).toBe("cmdbar-heading-answer");
      expect(headings.at(-1)).toBe("cmdbar-heading-ask");
      await pageFor.getByTestId("capsule-composer").press("Tab");
      await expect(pageFor.locator('[role="option"][aria-selected="true"]')).toHaveAttribute("data-row-kind", "ask");

      // G3 — a keystroke fetches nothing: every document came from cache.
      // The dashboard behind the bar may still be settling (its briefing
      // re-narration, its own reads) — wait for it, then count.
      await settle(pageFor, double);
      const before = double.requests.length;
      for (const q of ["p", "pr", "pro", "prof", "profi", "profit", "4", "41", "411", "4111", "bilnat", "stocuri"]) {
        await typeQuery(pageFor, q);
      }
      // Past any debounce: quiet for the whole horizon, then count.
      await settle(pageFor, double, DEBOUNCE_HORIZON_MS);
      const during = heldAgainstTheBar(double.requests.slice(before));
      expect(during, `${c.key}: requests while typing`).toEqual([]);
      expect(double.unhandled.filter((u) => u.startsWith("THREW"))).toEqual([]);
      console.log(`[cmdbar] ${c.key} unmodelled requests:`, JSON.stringify([...new Set(double.unhandled)]));
      await ctx.close();
    }
    // SWAP (S2, live): with every numeral masked, the two empty states differ.
    expect(restTexts[0]).not.toBe(restTexts[1]);
  });
});

test.describe("G5 — an item opens its evidence", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(60_000);
  // The benchmark page's `?row=` receiver: /benchmark ALSO reads the legacy
  // report (/api/benchmarks/report/{period}), which the double holds no
  // capture for. The test below answers that ONE route with the engine's own
  // refusal shapes (src/engine/api/_benchmarks.py — caen_not_set is its
  // answer for a period with no per-period CAEN assignment, which is every
  // workspace upload); the sector document is the engine's composition.
  // Held in jsdom too, with an HTTP error and an unreachable API
  // (frontend/pages/cfo/__tests__/benchmarkRowReceiver.test.tsx).
  const LEGACY_REPORT: Record<string, Record<string, unknown>> = {
    caen_not_set: {
      error: "caen_not_set",
      message: "Industry is not set for this period. Open the industry picker to choose one.",
      period_id: AGRAS_PERIOD, org_id: ORG_AGRAS, refusal: null,
    },
    benchmarks_not_available: { error: "benchmarks_not_available", message: "No benchmark data for this CAEN yet." },
  };
  for (const legacy of Object.keys(LEGACY_REPORT)) {
    test(`a 'worst vs sector' item opens its highlighted /benchmark row — the legacy report says ${legacy}`, async ({ page }) => {
      const double = new WorkspaceDouble({ theme: "dark", language: "en" });
      await openDashboard(page, double, COMPANIES[1]);
      // Registered AFTER the double: Playwright matches the last route first.
      await page.route(
        (url) => url.hostname === "engine.invalid" && url.pathname.startsWith("/api/benchmarks/report/"),
        (route) => route.fulfill({ status: 200, json: LEGACY_REPORT[legacy] }),
      );
      await openBar(page);
      const item = (ATTENTION[AGRAS_PERIOD].items as { key: string; evidence: { kind: string; row?: string } }[])
        .find((i) => i.evidence.kind === "benchmark_row")!;
      await page.locator(`[data-row-id="now:${item.key}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/benchmark\\?.*row=${item.evidence.row}`));
      const row = page.locator(`[data-sector-row="${item.evidence.row}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toHaveAttribute("data-highlighted", "true");
      // Nothing modal over the row the reader came to see.
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/agras_benchmark_row_${legacy}_1440_terminal_en.png` });
    });
  }

  test("a ratio answer opens the ratios tab with its drawer", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "light", language: "en" });
    await openDashboard(page, double, COMPANIES[0]);
    await openBar(page);
    await typeQuery(page, "current ratio");
    await page.locator('[data-row-id="ratio:current_ratio"]').click();
    await expect(page).toHaveURL(/tab=ratios.*ratio=current_ratio|ratio=current_ratio.*tab=ratios/);
    await expect(page.getByTestId("ratio-detail-drawer")).toBeVisible({ timeout: 20_000 });
  });

  // The account view (design C4, stage CB-F2) — mounted by the REAL
  // dashboard, not only in jsdom (evidenceLanding.test.tsx, cmdbar-evidence).
  test("a Cont row opens the account view on that leaf, highlighted", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "light", language: "en" });
    await openDashboard(page, double, COMPANIES[0]);
    await openBar(page);
    await typeQuery(page, "411101");
    const row = page.getByTestId("cmdbar-row-account").first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(/account=411101/);
    const view = page.getByTestId("evidence-drawer");
    await expect(view).toBeVisible({ timeout: 20_000 });
    await expect(view.locator('[data-evidence-target="leaf:411101"][data-highlighted="true"]')).toBeVisible();
    if (SHOTS) {
      await page.waitForTimeout(700); // the sheet's slide-in
      await page.screenshot({ path: `${SHOTS}/scandia_account_411101_1440_paper_en.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/scandia_account_411101_390_paper_en.png` });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.keyboard.press("Escape");
    await expect(view).toBeHidden();
    await expect(page).not.toHaveURL(/account=/);
  });

  test("a finding opens under ITS own number — Scandia's earnings_quality, 758 + 781, not the 758 line", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "light", language: "ro" });
    await openDashboard(page, double, COMPANIES[0]);
    await openBar(page);
    const item = page.locator('[data-row-id="now:earnings_quality"]');
    const printed = (await item.locator('[data-figure="now"]').textContent()) ?? "";
    expect(printed).not.toBe("");
    await item.click();
    await expect(page).toHaveURL(/finding=earnings_quality/);
    const view = page.getByTestId("evidence-drawer");
    await expect(view).toBeVisible({ timeout: 20_000 });
    await expect(view.getByTestId("evidence-finding-value")).toHaveText(printed);
    await expect(view.getByTestId("evidence-line-value")).toHaveCount(0);
    await expect(view.locator('[data-evidence-target^="account:"][data-highlighted="true"]').first()).toBeVisible();
    if (SHOTS) {
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${SHOTS}/scandia_finding_earnings_quality_1440_paper_ro.png` });
    }
  });

  test("a 'Ce contează acum' item that names a line opens that line's evidence", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "dark", language: "ro" });
    await openDashboard(page, double, COMPANIES[0]);
    await openBar(page);
    await page.locator('[data-row-id="now:financial_position"]').click();
    await expect(page).toHaveURL(/line=pl\.net_financial_result/);
    const view = page.getByTestId("evidence-drawer");
    await expect(view).toBeVisible({ timeout: 20_000 });
    await expect(view.locator('[data-evidence-target="line:pl.net_financial_result"][data-highlighted="true"]')).toBeVisible();
    await expect(view.locator('[data-evidence-target^="account:"][data-highlighted="true"]').first()).toBeVisible();
    if (SHOTS) {
      await page.waitForTimeout(700); // the sheet's slide-in
      await page.screenshot({ path: `${SHOTS}/scandia_line_net_financial_result_1440_terminal_ro.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/scandia_line_net_financial_result_390_terminal_ro.png` });
    }
  });
});

// ── G6 / G7 — served equality, latency and the keyboard, on the real bundle ─

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/** The app's own printers, bundled once from the same source the production
 *  bundle compiles (e2e/cmdbar.printers.entry.ts). */
let printersCode: Promise<string> | null = null;
function printersBundle(): Promise<string> {
  printersCode ??= esbuild.build({
    entryPoints: [resolve(REPO, "e2e/cmdbar.printers.entry.ts")],
    absWorkingDir: REPO,
    bundle: true,
    format: "iife",
    write: false,
    platform: "browser",
    target: "es2020",
    tsconfig: resolve(REPO, "tsconfig.e2e.json"),
    define: {
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": '"production"',
      "import.meta.env": "{}",
    },
    logLevel: "silent",
  }).then((r) => r.outputFiles[0].text);
  return printersCode;
}

type PrintJob =
  | { kind: "money"; value: number; lang: "en" | "ro" }
  | { kind: "ratio"; row: Record<string, unknown>; lang: "en" | "ro" };

/** Print every job with the app's printers, in a blank page of the SAME
 *  browser (same Intl / ICU as the bar), isolated from the app under test. */
async function printServed(browser: Browser, jobs: PrintJob[]): Promise<string[]> {
  const ctx = await browser.newContext();
  const pp = await ctx.newPage();
  await pp.setContent("<!doctype html><html><head></head><body></body></html>");
  await pp.addScriptTag({ content: await printersBundle() });
  const out = await pp.evaluate((js: PrintJob[]) => {
    const P = (globalThis as unknown as { __cmdbarPrinters: Record<string, (...a: unknown[]) => string> }).__cmdbarPrinters;
    // The bar's money printer: the SERVED currency with its code, compact,
    // never converted by the display toggle (lib/money formatMoneyFrom,
    // source = display = the period's currency, RON here), in the BAR'S
    // language — its locale stated through the one mapping, never the blank
    // page's default (owner ticket 2026-09-28: "413,7 mil. RON" in English).
    return js.map((j) => j.kind === "money"
      ? P.formatMoneyFrom(j.value, "RON", "RON", { RON: 1, EUR: 1, USD: 1 }, { compact: true, locale: P.moneyLocaleFor(j.lang) })
      : P.formatRatioSide(j.row, j.row.display_unit, j.lang));
  }, jobs);
  await ctx.close();
  return out;
}

interface Painted {
  kind: string | null;
  id: string | null;
  figure: string | null;
  absent: string | null;
  text: string;
}

/** Type a query the way a keystroke does (native setter + input event) and
 *  wait, in the page, until the list names THIS query. Returns the wall time
 *  from the event to that paint and the rows painted. */
async function typeInPage(page: Page, q: string): Promise<{ ms: number; rows: Painted[] }> {
  return page.evaluate(async (query) => {
    const el = document.querySelector('[data-testid="capsule-composer"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const t0 = performance.now();
    setter.call(el, query);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const reflects = () => {
      const bar = document.querySelector('[data-testid="cmdbar"]');
      if (!bar) return false;
      if (query.trim() === "") return bar.getAttribute("data-mode") === "rest";
      const ask = bar.querySelector('[data-row-kind="ask"]');
      return bar.getAttribute("data-mode") === "typing" && !!ask && (ask.textContent ?? "").includes(query.trim());
    };
    let ms = Number.NaN;
    for (let i = 0; i < 2000; i++) {
      if (reflects()) { ms = performance.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 0));
    }
    const rows = Array.from(document.querySelectorAll('[data-testid="cmdbar-rows"] [role="option"]')).map((r) => ({
      kind: r.getAttribute("data-row-kind"),
      id: r.getAttribute("data-row-id"),
      figure: r.querySelector("[data-figure]")?.textContent ?? null,
      absent: r.querySelector("[data-absent]")?.textContent ?? null,
      text: r.textContent ?? "",
    }));
    return { ms, rows };
  }, q);
}

/** Each statement answer's served figure, read INDEPENDENTLY of the bar's
 *  term table: the path the engine serves it at (the jsdom twin:
 *  commandBar.test.tsx `servedPath`). */
const STATEMENT_QUERIES: Record<string, string> = {
  turnover: "cifra de afaceri", ebitda: "ebitda", operating_result: "rezultat din exploatare",
  net_result: "profit net", cash: "numerar", debt: "datorie totala", inventory: "stocuri",
  receivables: "creante", payables: "furnizori", equity: "capitaluri proprii", total_assets: "total active",
};
function servedStatement(body: Record<string, any>, id: string): number {
  const pl = body.statements.assembled_pl;
  const bs = body.statements.assembled_bs;
  return ({
    turnover: pl.revenue, ebitda: pl.ebitda, operating_result: pl.ebit, net_result: pl.net_income_statutory,
    cash: bs.cash, debt: bs.total_debt, inventory: bs.inventory, receivables: bs.ar_net,
    payables: bs.ap, equity: bs.total_equity, total_assets: bs.total_assets,
  } as Record<string, number>)[id];
}

const BODIES: Record<string, Record<string, any>> = { scandia: SCANDIA.period, agras: AGRAS.period };

test.describe("G6 — every Răspuns and Cont figure the real bundle paints IS the served figure", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(300_000);

  for (const c of COMPANIES) {
    for (const lang of ["ro", "en"] as const) {
      test(`${c.key} (${lang}): statement answers, every ratio_table row, every leaf account`, async ({ browser }) => {
        const body = BODIES[c.key];
        const double = new WorkspaceDouble({ theme: "dark", language: lang });
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        await openDashboard(page, double, c);
        await openBar(page);
        await settle(page, double);
        const before = double.requests.length;

        // THE READER'S LANGUAGE (owner ticket 2026-09-28: the English bar
        // painted "413,7 mil. RON"). Independent of the printers — a defect
        // the bar and the expected string shared would agree below — no
        // figure at rest (the engine's items, their chips) is a number in
        // the other language's format.
        const resting = await page
          .locator('[data-testid="cmdbar"] [data-figure], [data-testid="cmdbar"] [data-chip-state]')
          .allTextContents();
        expect(resting.filter((f) => /\d/.test(f)).length, `${c.key}/${lang}: VACUITY — resting figures`).toBeGreaterThanOrEqual(2);
        expect(resting.filter((f) => foreignNumber(f, lang) !== null), `${c.key}/${lang}: resting figures in the other language's format`).toEqual([]);

        type Check = { what: string; painted: string | null; job: PrintJob };
        const checks: Check[] = [];

        // Răspuns — statement answers.
        for (const [id, q] of Object.entries(STATEMENT_QUERIES)) {
          const { rows } = await typeInPage(page, q);
          const row = rows.find((r) => r.id === `answer:${id}`);
          expect(row, `${c.key}/${lang}: "${q}" answers ${id}`).toBeTruthy();
          checks.push({ what: `answer:${id}`, painted: row!.figure, job: { kind: "money", value: servedStatement(body, id), lang } });
        }
        // Răspuns — every ratio_table row (inventory days ride the statement
        // answer through their one adapter; held in jsdom).
        let ratios = 0;
        for (const r of body.assembled_metrics.ratio_table.rows as Record<string, any>[]) {
          if (r.key === "dio") continue;
          const { rows } = await typeInPage(page, String(r.key).replace(/_/g, " "));
          const row = rows.find((x) => x.id === `ratio:${r.key}`);
          // EVERY served row, found by its own name — never skipped.
          expect(row, `${c.key}/${lang}: "${String(r.key).replace(/_/g, " ")}" answers ratio:${r.key}`).toBeTruthy();
          checks.push({ what: `ratio:${r.key}`, painted: row!.figure ?? row!.absent, job: { kind: "ratio", row: r, lang } });
          ratios++;
        }
        // Cont — EVERY leaf, found by its own code.
        const leaves = (body.line_items as Record<string, any>[]).filter(
          (li) => typeof li.ro_account_code === "string" && li.statement !== "IGNORED");
        let accounts = 0;
        for (const li of leaves) {
          const { rows } = await typeInPage(page, li.ro_account_code);
          const row = rows.find((x) => x.id === `account:${li.ro_account_code}:${li.bucket}`);
          expect(row, `${c.key}/${lang}: "${li.ro_account_code}" finds its own leaf`).toBeTruthy();
          checks.push({ what: `account:${li.ro_account_code}`, painted: row!.figure, job: { kind: "money", value: li.amount, lang } });
          accounts++;
        }

        const expected = await printServed(browser, checks.map((k) => k.job));
        const mismatches = checks
          .map((k, i) => ({ what: k.what, painted: k.painted, served: expected[i] }))
          .filter((m) => m.painted !== m.served);
        expect(mismatches, `${c.key}/${lang}: painted ≠ served`).toEqual([]);
        const foreign = checks.filter((k) => foreignNumber(k.painted ?? "", lang) !== null).map((k) => `${k.what}: ${k.painted}`);
        expect(foreign, `${c.key}/${lang}: painted figures in the other language's format`).toEqual([]);

        await settle(page, double, DEBOUNCE_HORIZON_MS);
        const during = heldAgainstTheBar(double.requests.slice(before));
        expect(during, `${c.key}/${lang}: requests while searching`).toEqual([]);
        console.log(`GATE-WORK cmdbar-live-figures ${c.key}/${lang} answers=${Object.keys(STATEMENT_QUERIES).length} ratios=${ratios} accounts=${accounts} total=${checks.length}`);
        expect(ratios, "every ratio_table row but dio").toBe(
          (body.assembled_metrics.ratio_table.rows as Record<string, any>[]).filter((r) => r.key !== "dio").length);
        expect(ratios, "VACUITY: ratio answers").toBeGreaterThanOrEqual(20);
        expect(accounts, "VACUITY: every leaf").toBe(leaves.length);
        expect(accounts).toBeGreaterThanOrEqual(280);
        await ctx.close();
      });
    }
  }
});

test.describe("G7 — < 100 ms per keystroke, zero requests, and the keyboard, on the real bundle", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(120_000);

  for (const c of COMPANIES) {
    test(`${c.key}: every keystroke of the typed queries re-renders in < 100 ms with no request`, async ({ browser }) => {
      const double = new WorkspaceDouble({ theme: "light", language: "ro" });
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await openDashboard(page, double, c);
      await openBar(page);
      await settle(page, double);
      const before = double.requests.length;
      const walls: number[] = [];
      let horizons = 0;
      for (const q of ["profit", "4111", "clienti", "stoc", "raport", "cifra de afaceri", "furnizrii", "marja neta", "bilant", "exporta"]) {
        for (let i = 1; i <= q.length; i++) {
          const { ms } = await typeInPage(page, q.slice(0, i));
          walls.push(ms);
        }
        // The reader stops typing: a request the query DEFERS (a debounce)
        // is issued now — wait it out before the next keystroke clears it
        // (ending on the empty query hid a debounced fetch: the plant log).
        await settle(page, double, DEBOUNCE_HORIZON_MS);
        horizons++;
        walls.push((await typeInPage(page, "")).ms);
      }
      expect(horizons, "VACUITY: every query waited out the debounce horizon").toBe(10);
      const sorted = [...walls].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)];
      const max = sorted[sorted.length - 1];
      console.log(`GATE-WORK cmdbar-live-latency ${c.key} keystrokes=${walls.length} p50_ms=${p50.toFixed(1)} max_ms=${max.toFixed(1)}`);
      expect(walls.every((w) => Number.isFinite(w)), "every keystroke painted its query").toBe(true);
      expect(walls.length).toBeGreaterThanOrEqual(60);
      expect(max, `${c.key}: slowest keystroke`).toBeLessThan(100);
      await settle(page, double, DEBOUNCE_HORIZON_MS);
      const during = heldAgainstTheBar(double.requests.slice(before));
      expect(during, `${c.key}: requests while typing`).toEqual([]);
      await ctx.close();
    });
  }

  test("the keyboard: ↓ stops on 'Întreabă CFO AI', ↑ back to the answer, Enter opens the answer's evidence, Esc closes", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "dark", language: "ro" });
    await openDashboard(page, double, COMPANIES[0]);
    await openBar(page);
    const composer = page.getByTestId("capsule-composer");
    await typeQuery(page, "clienti");
    const selected = page.locator('[role="option"][aria-selected="true"]');
    await expect(selected).toHaveAttribute("data-row-kind", "answer");
    const n = await page.locator('[data-testid="cmdbar-rows"] [role="option"]').count();
    for (let i = 0; i < n + 2; i++) await composer.press("ArrowDown");
    await expect(selected).toHaveAttribute("data-row-kind", "ask");
    await expect(composer).toHaveAttribute("aria-activedescendant", (await selected.getAttribute("id")) ?? "");
    for (let i = 0; i < n + 2; i++) await composer.press("ArrowUp");
    await expect(selected).toHaveAttribute("data-row-id", "answer:receivables");
    await composer.press("Enter");
    await expect(page).toHaveURL(/line=bs\.trade_receivables_net/);
    await expect(page.getByTestId("command-palette")).toBeHidden();
    // The answer's evidence is the account view for its line (a modal
    // sheet); Esc closes it and drops the parameter.
    const view = page.getByTestId("evidence-drawer");
    await expect(view).toBeVisible({ timeout: 20_000 });
    await expect(view.locator('[data-evidence-target="line:bs.trade_receivables_net"][data-highlighted="true"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(view).toBeHidden();
    await page.getByTestId("header-command-bar").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();
  });
});

test.describe("G8 — the row the keyboard selects is the row the reader SEES", () => {
  // Found by this stage's own probe: "Întreabă CFO AI" sticks to the bottom
  // of the list, and ↓ onto the row above it (Scandia, "profit", the P&L
  // page at 1440) scrolled that row UNDER the sticky row — selected,
  // announced, invisible. And a new, shorter query after ↓ to the end kept
  // the selection on "Întreabă CFO AI", so Enter asked the chat instead of
  // opening the answer just typed for.
  test.setTimeout(120_000);
  for (const vp of [{ label: "1440", width: 1440, height: 900 }, { label: "390", width: 390, height: 844 }]) {
    test(`@${vp.label}: every row ↓ selects is in view, never under the sticky 'Întreabă CFO AI'; a new query selects its answer`, async ({ browser }) => {
      let walked = 0;
      let overflowing = 0;
      const covered: string[] = [];
      const stale: string[] = [];
      for (const c of COMPANIES) {
        const double = new WorkspaceDouble({ theme: "dark", language: "ro" });
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        await openDashboard(page, double, c);
        await openBar(page);
        const composer = page.getByTestId("capsule-composer");
        for (const q of ["profit", "stoc", "raport", "clienti", "4111", "cifra de afaceri"]) {
          await typeQuery(page, q);
          await expect(page.locator('[data-testid="cmdbar"][data-mode="typing"]')).toBeVisible();
          await expect(page.getByTestId("cmdbar-row-ask")).toContainText(q);
          // A new query selects its first row — whatever the last walk left
          // (the previous query's walk ended on "Întreabă CFO AI").
          const first = await page.evaluate(() =>
            document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-row-id") ?? null);
          const top = await page.locator('[data-testid="cmdbar-rows"] [role="option"]').first().getAttribute("data-row-id");
          if (first !== top) stale.push(`${c.key} "${q}": selected ${first}, not ${top}`);
          const n = await page.locator('[data-testid="cmdbar-rows"] [role="option"]').count();
          if (await page.evaluate(() => {
            const l = document.getElementById("command-palette-list")!;
            return l.scrollHeight > l.clientHeight + 1;
          })) overflowing++;
          for (let i = 0; i < n; i++) {
            if (i > 0) await composer.press("ArrowDown");
            const seen = await page.evaluate((want) => {
              const el = document.querySelector('[role="option"][aria-selected="true"]') as HTMLElement | null;
              if (!el || el.getAttribute("data-idx") !== String(want)) return { id: el?.getAttribute("data-row-id") ?? null, ok: false, why: "not selected" };
              const b = el.getBoundingClientRect();
              const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              const askBlock = document.querySelector('[data-row-kind="ask"]')?.parentElement;
              const on = askBlock?.contains(hit) ? "the sticky 'Întreabă CFO AI'"
                : hit?.closest("[data-row-id]")?.getAttribute("data-row-id") ?? hit?.tagName ?? "nothing";
              return { id: el.getAttribute("data-row-id"), ok: el.contains(hit), why: `under ${on}` };
            }, i);
            if (!seen.ok) covered.push(`${c.key} "${q}" ${seen.id}: ${seen.why}`);
            walked++;
          }
        }
        await ctx.close();
      }
      console.log(`GATE-WORK cmdbar-live-in-view @${vp.label} rows_walked=${walked} overflowing_lists=${overflowing}`);
      expect({ covered, stale }, `@${vp.label}: rows selected out of sight / a stale selection after typing`)
        .toEqual({ covered: [], stale: [] });
      expect(walked, "VACUITY: rows walked").toBeGreaterThanOrEqual(40);
      // POSITIVE CONTROL: the walk only means something where the list
      // outgrows the card (the sticky row then overlays content).
      expect(overflowing, "an overflowing list was walked").toBeGreaterThanOrEqual(1);
    });
  }
});

test.describe("G9 — every figure, context and basis is ON SCREEN, inside its row", () => {
  // Found by review (2026-09-27): the context line was one truncating span —
  // at 1440 "stoc" painted "Durata de rotație a stocurilor 97 de zile"
  // without the sector value, its position, the "bază depusă" label or the
  // inventory basis the owner requires (the DOM held them, so every
  // textContent gate passed); at 390 "profit" cut "Marja operațională 6…"
  // mid-figure. Here every carrier's boxes (each line of a wrapped span)
  // lie inside its row and inside the list's width, and no box on the way
  // up to the row clips its text with an ellipsis.
  test.setTimeout(180_000);
  const CARRIERS = "[data-figure],[data-absent],[data-basis],[data-chip-state],[data-context],[data-chips],[data-key-metric],[data-more]";
  for (const vp of [{ label: "1440", width: 1440, height: 900 }, { label: "390", width: 390, height: 844 }]) {
    test(`@${vp.label}: at rest and for "stoc", "clienti", "profit", "cifra de afaceri", both companies, RO and EN`, async ({ browser }) => {
      let checked = 0;
      let bases = 0;
      const bad: string[] = [];
      for (const c of COMPANIES) {
        for (const lang of ["ro", "en"] as const) {
          const double = new WorkspaceDouble({ theme: "dark", language: lang });
          const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
          const page = await ctx.newPage();
          await openDashboard(page, double, c);
          await openBar(page);
          for (const q of ["", "stoc", "clienti", "profit", "cifra de afaceri"]) {
            if (q) {
              await typeQuery(page, q);
              await expect(page.getByTestId("cmdbar-row-ask")).toContainText(q);
            }
            await page.waitForTimeout(120);
            const res = await page.evaluate((sel) => {
              const out = { checked: 0, bases: 0, bad: [] as string[] };
              const list = document.getElementById("command-palette-list")!.getBoundingClientRect();
              for (const opt of Array.from(document.querySelectorAll('[data-testid="cmdbar-rows"] [role="option"]'))) {
                const row = opt.getBoundingClientRect();
                const id = opt.getAttribute("data-row-id");
                for (const el of Array.from(opt.querySelectorAll(sel))) {
                  out.checked++;
                  if (el.hasAttribute("data-basis")) out.bases++;
                  const what = `${id} ${(el.textContent ?? "").slice(0, 40)}`;
                  for (const r of Array.from(el.getClientRects())) {
                    if (r.width === 0 && r.height === 0) continue;
                    if (r.left < row.left - 1 || r.right > row.right + 1 || r.top < row.top - 1 || r.bottom > row.bottom + 1) {
                      out.bad.push(`${what}: outside its row`);
                    }
                    if (r.right > list.right + 1 || r.left < list.left - 1) out.bad.push(`${what}: past the list's edge`);
                  }
                  for (let n: Element | null = el; n && n !== opt; n = n.parentElement) {
                    const cs = getComputedStyle(n);
                    if (cs.textOverflow === "ellipsis" && (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1) {
                      out.bad.push(`${what}: cut by an ellipsis`);
                    }
                  }
                }
              }
              return out;
            }, CARRIERS);
            checked += res.checked;
            bases += res.bases;
            bad.push(...res.bad.map((b) => `${c.key}/${lang} "${q}": ${b}`));
          }
          await ctx.close();
        }
      }
      console.log(`GATE-WORK cmdbar-live-legible @${vp.label} carriers=${checked} bases=${bases}`);
      expect(bad, `@${vp.label}: figures, context or basis off their row or cut`).toEqual([]);
      expect(checked, "VACUITY: carriers checked").toBeGreaterThanOrEqual(100);
      // POSITIVE CONTROL: the owner's basis requirement was on screen to be
      // checked (the inventory basis, the filed-basis label).
      expect(bases, "basis labels checked").toBeGreaterThanOrEqual(4);
    });
  }
});

// ── G4 + the screenshot loop ────────────────────────────────────────────
/** The typed states of the screenshot loop (stage CB-G), besides "empty". */
const TYPED = ["profit", "4111", "clienti", "stoc", "raport"] as const;

for (const vp of [{ label: "1440", width: 1440, height: 900 }, { label: "390", width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"] as const) {
    for (const lang of ["ro", "en"] as const) {
      test.describe(`G4 @${vp.label} ${theme} ${lang}`, () => {
        test.use({ viewport: { width: vp.width, height: vp.height } });
        test.setTimeout(120_000);
        test("empty and every typed query, both companies: fits the viewport, no horizontal scroll", async ({ browser }) => {
          const skin = theme === "dark" ? "terminal" : "paper";
          let states = 0;
          for (const c of COMPANIES) {
            const double = new WorkspaceDouble({ theme, language: lang });
            const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
            const p = await ctx.newPage();
            await openDashboard(p, double, c);
            await openBar(p);
            await p.waitForTimeout(250);
            const fits = async () => p.evaluate(() => {
              const panel = document.querySelector('[data-testid="command-palette"]')!.getBoundingClientRect();
              return {
                overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
                inside: panel.left >= 0 && panel.right <= window.innerWidth + 1,
              };
            });
            expect(await fits()).toEqual({ overflowX: false, inside: true });
            if (SHOTS) await p.screenshot({ path: `${SHOTS}/${c.key}_empty_${vp.label}_${skin}_${lang}.png` });
            states++;
            for (const q of TYPED) {
              await typeQuery(p, q);
              await expect(p.locator('[data-testid="cmdbar"][data-mode="typing"]')).toBeVisible();
              await expect(p.getByTestId("cmdbar-row-ask")).toContainText(q);
              // Each typed state paints something besides "Întreabă CFO AI".
              const found = await p.locator('[data-testid="cmdbar-rows"] [role="option"]:not([data-row-kind="ask"])').count();
              expect(found, `${c.key}: "${q}" finds rows`).toBeGreaterThan(0);
              await p.waitForTimeout(150);
              expect(await fits(), `${c.key}: "${q}"`).toEqual({ overflowX: false, inside: true });
              if (SHOTS) await p.screenshot({ path: `${SHOTS}/${c.key}_typed-${q}_${vp.label}_${skin}_${lang}.png` });
              states++;
            }
            await ctx.close();
          }
          expect(states, "VACUITY: states checked").toBe(COMPANIES.length * (1 + TYPED.length));
        });
      });
    }
  }
}

// ── G10 — a company or period switch, live ──────────────────────────────
//
// Review of stage CB-H: the app's query client keeps the previous key's data
// on screen while a new key loads (keepPreviousData), and the bar read it —
// Scandia's "Ce contează acum" and sector positions under "Searching Agras
// SRL", and `/api/period/<Agras>/comparatives?prior=<Scandia>` asked under
// Scandia's X-Org-Id (workspace-v2 G6: 8 of 40 runs red on this branch, 20
// of 20 green on 69fb9621). The switch is made IN the app — history +
// popstate, the way a link or Back moves it — so the cache survives.

/** A second, earlier Scandia period: the Agras book re-homed under
 *  Scandia's name, its own id and year end — a different book, so its
 *  figures differ from Dec 2025's. Registered in the double for G10 only. */
const S24 = "5ea50000-0000-4000-8000-0000000051f4";
function withScandiaDec2024(d: WorkspaceDouble) {
  const body = {
    ...AGRAS.period,
    organization: { ...AGRAS.period.organization, id: ORG_SCANDIA, name: "Scandia Food SRL" },
    period: { ...AGRAS.period.period, id: S24, period_end: "2024-12-31" },
  };
  d.periods[ORG_SCANDIA] = [SCANDIA, {
    ...AGRAS, period: body,
    years: [{ ...AGRAS.years[0], period_id: S24, year: 2024, period_end: "2024-12-31" }],
  }];
  const att = ATTENTION[AGRAS_PERIOD] as Record<string, any>;
  ATTENTION[S24] = { ...att, period: { ...att.period, id: S24, org_id: ORG_SCANDIA, company_name: "Scandia Food SRL", period_end: "2024-12-31", label: "2024-12-31" } };
  const sec = SECTOR_BENCHMARK[AGRAS_PERIOD] as Record<string, any>;
  SECTOR_BENCHMARK[S24] = { ...sec, period: { ...sec.period, id: S24, period_end: "2024-12-31" } };
}
const OWNER: Record<string, string> = { [SCANDIA_PERIOD]: ORG_SCANDIA, [S24]: ORG_SCANDIA, [AGRAS_PERIOD]: ORG_AGRAS };

/** From the switch on, every engine document is answered SWITCH_DELAY_MS
 *  late (the double's `engineDelay`; the status dot and the feature flags
 *  at once). Review round 1 of stage CB-I: answered at once, the window in
 *  which the new key loads while the previous key's data is kept on screen
 *  was often shorter than one committed frame, and the paint check caught
 *  the pre-fix bundle only about half the time. Held open, it is caught on
 *  every run (the rates are in docs/engine_book/gates.md). */
const SWITCH_DELAY_MS = 900;
const slowDocuments = (pathAndSearch: string) =>
  pathAndSearch.startsWith("/health") || pathAndSearch.startsWith("/api/features/") ? 0 : SWITCH_DELAY_MS;

/** In the page: what the bar paints now — the header line, and every figure,
 *  served chip, key metric and context with its row; and a recorder that
 *  keeps every DIFFERENT frame, on every DOM mutation. */
const SNAP_JS = `
  window.__cmdbarSnap = () => {
    const scope = document.querySelector('[data-testid="cmdbar-scope"]');
    if (!scope) return null;
    const bar = document.querySelector('[data-testid="cmdbar"]');
    const kinds = ["data-figure", "data-chip-state", "data-key-metric", "data-context"];
    const carriers = Array.from(bar.querySelectorAll('[data-figure], [data-chip-state="ok"], [data-key-metric], [data-context]')).map((el) => {
      const row = (el.closest("[data-row-id]") || { getAttribute: () => "?" }).getAttribute("data-row-id");
      return row + " | " + kinds.find((a) => el.hasAttribute(a)) + " | " + (el.textContent || "");
    });
    const years = Array.from(bar.querySelectorAll('[data-row-id^="page:year:"]')).map((e) => e.getAttribute("data-row-id"));
    return { header: scope.textContent || "", carriers, years };
  };
  window.__cmdbarRecord = () => {
    window.__cmdbarFrames = [];
    let last = "";
    const rec = () => {
      const f = window.__cmdbarSnap();
      if (!f) return;
      const k = JSON.stringify(f);
      if (k === last) return;
      last = k;
      window.__cmdbarFrames.push(f);
    };
    new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    rec();
  };
`;
interface LiveFrame { header: string; carriers: string[]; years: string[] }
const snapNow = (page: Page) => page.evaluate(() => (window as unknown as { __cmdbarSnap: () => LiveFrame | null }).__cmdbarSnap());

/** In-app navigation: a link or Back moves the URL without a reload. */
async function moveTo(page: Page, url: string) {
  await page.evaluate((u) => {
    window.history.pushState({}, "", u);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, url);
}

/** What (company, period) paints when opened ALONE: its header line and
 *  every carrier at rest (and typed). */
async function steadyOf(browser: Browser, setup: (d: WorkspaceDouble) => void, org: string, period: string, name: string, query: string) {
  const double = new WorkspaceDouble({ theme: "dark", language: "en" });
  setup(double);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await double.install(page);
  await page.goto(`/dashboard?period=${period}&org=${org}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("header-command-bar")).toContainText(name, { timeout: 25_000 });
  await openBar(page);
  await settle(page, double);
  await page.evaluate(SNAP_JS);
  const rest = (await snapNow(page))!;
  const carriers = new Set(rest.carriers);
  if (query) {
    await typeQuery(page, query);
    await expect(page.getByTestId("cmdbar-row-ask")).toContainText(query);
    await settle(page, double);
    (await snapNow(page))!.carriers.forEach((c) => carriers.add(c));
  }
  await ctx.close();
  return { header: rest.header, carriers };
}

function paintViolations(frames: LiveFrame[], allowed: Map<string, Set<string>>): string[] {
  const out: string[] = [];
  for (const f of frames) {
    const ok = allowed.get(f.header);
    for (const c of f.carriers) if (!ok || !ok.has(c)) out.push(`"${f.header}" painted ${c}`);
    for (const id of f.years) {
      const [, , org, period] = id.split(":");
      if (OWNER[period] && OWNER[period] !== org) out.push(`"${f.header}" links ${org}'s year to ${period}`);
    }
  }
  return [...new Set(out)];
}

type Req = { method: string; path: string; search: string; org: string | null };
function requestViolations(reqs: Req[], mark: number, left: string | null): string[] {
  const out: string[] = [];
  reqs.forEach((r, i) => {
    const url = `${r.path}${r.search}`;
    const named = Object.keys(OWNER).filter((p) => url.includes(p));
    if (r.org && named.some((p) => OWNER[p] !== r.org)) out.push(`asked ${r.org} about another company's period: ${r.method} ${url}`);
    if (left && i >= mark && named.some((p) => OWNER[p] === left)) out.push(`after the switch, named the company left behind: ${r.method} ${url} (as ${r.org})`);
  });
  return out;
}

test.describe("G10 — a switch paints nothing of what was left behind and asks nothing across companies", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(120_000);
  const bothAnalysed = (d: WorkspaceDouble) => { d.periods[ORG_AGRAS] = [AGRAS]; };

  for (const v of [
    { name: "open, at rest", open: true, query: "" },
    { name: "open, typed 'clienti'", open: true, query: "clienti" },
    { name: "closed through the switch, opened after", open: false, query: "" },
  ]) {
    test(`Scandia → Agras, the bar ${v.name}`, async ({ browser }) => {
      const s = await steadyOf(browser, bothAnalysed, ORG_SCANDIA, SCANDIA_PERIOD, "Scandia Food SRL", v.query);
      const a = await steadyOf(browser, bothAnalysed, ORG_AGRAS, AGRAS_PERIOD, "Agras SRL", v.query);
      const allowed = new Map([[s.header, s.carriers], [a.header, a.carriers]]);
      const foreign = [...s.carriers].filter((c) => !a.carriers.has(c));
      expect(foreign.length, "POSITIVE CONTROL: Scandia paints ≥ 3 carriers Agras does not").toBeGreaterThanOrEqual(3);

      const double = new WorkspaceDouble({ theme: "dark", language: "en" });
      bothAnalysed(double);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await double.install(page);
      await page.goto(`/dashboard?period=${SCANDIA_PERIOD}&org=${ORG_SCANDIA}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("header-command-bar")).toContainText("Scandia Food SRL", { timeout: 25_000 });
      await page.evaluate(SNAP_JS);
      if (v.open) {
        await openBar(page);
        if (v.query) {
          await typeQuery(page, v.query);
          await expect(page.getByTestId("cmdbar-row-ask")).toContainText(v.query);
        }
      }
      await settle(page, double);
      await page.evaluate(() => (window as unknown as { __cmdbarRecord: () => void }).__cmdbarRecord());
      const switchedAt = double.requests.length;
      double.engineDelay = slowDocuments;

      await moveTo(page, `/dashboard?period=${AGRAS_PERIOD}&org=${ORG_AGRAS}`);
      await expect(page.getByTestId("header-command-bar")).toContainText("Agras SRL", { timeout: 25_000 });
      const mark = double.requests.length - switchedAt;
      if (!v.open) await openBar(page);
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await expect(page.getByTestId("cmdbar-scope")).toHaveText(a.header, { timeout: 20_000 });
      await settle(page, double, DEBOUNCE_HORIZON_MS);

      const frames = await page.evaluate(() => (window as unknown as { __cmdbarFrames: LiveFrame[] }).__cmdbarFrames);
      const paint = paintViolations(frames, allowed);
      const asks = requestViolations(double.requests.slice(switchedAt), mark, ORG_SCANDIA);
      expect({ paint, asks }, "a foreign figure under the header, or a request across companies").toEqual({ paint: [], asks: [] });
      // POSITIVE CONTROLS: the recorder saw the switch end on Agras's own paint.
      const last = frames.at(-1)!;
      expect(last.header).toBe(a.header);
      expect(last.carriers.length).toBeGreaterThanOrEqual(3);
      if (v.open) expect(frames.some((f) => f.header === s.header && f.carriers.length > 0), "Scandia was painted before").toBe(true);
      console.log(`GATE-WORK cmdbar-live-switch company "${v.name}" frames=${frames.length} foreign_carriers=${foreign.length} requests=${double.requests.length - switchedAt}`);
      await ctx.close();
    });
  }

  test("Scandia Dec 2025 → Dec 2024, the bar open", async ({ browser }) => {
    const setup = (d: WorkspaceDouble) => { bothAnalysed(d); withScandiaDec2024(d); };
    const d25 = await steadyOf(browser, setup, ORG_SCANDIA, SCANDIA_PERIOD, "Scandia Food SRL", "");
    const d24 = await steadyOf(browser, setup, ORG_SCANDIA, S24, "Scandia Food SRL", "");
    expect(d25.header).not.toBe(d24.header);
    const allowed = new Map([[d25.header, d25.carriers], [d24.header, d24.carriers]]);
    const foreign = [...d25.carriers].filter((c) => !d24.carriers.has(c));
    expect(foreign.length, "POSITIVE CONTROL: Dec 2025 paints ≥ 3 carriers Dec 2024 does not").toBeGreaterThanOrEqual(3);

    const double = new WorkspaceDouble({ theme: "dark", language: "en" });
    setup(double);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await double.install(page);
    await page.goto(`/dashboard?period=${SCANDIA_PERIOD}&org=${ORG_SCANDIA}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("header-command-bar")).toContainText("Scandia Food SRL", { timeout: 25_000 });
    await page.evaluate(SNAP_JS);
    await openBar(page);
    await settle(page, double);
    await page.evaluate(() => (window as unknown as { __cmdbarRecord: () => void }).__cmdbarRecord());
    const switchedAt = double.requests.length;
    double.engineDelay = slowDocuments;
    await moveTo(page, `/dashboard?period=${S24}&org=${ORG_SCANDIA}`);
    await expect(page.getByTestId("cmdbar-scope")).toHaveText(d24.header, { timeout: 20_000 });
    await expect(page.getByTestId("cmdbar-row-now").first()).toBeVisible({ timeout: 15_000 });
    await settle(page, double, DEBOUNCE_HORIZON_MS);

    const frames = await page.evaluate(() => (window as unknown as { __cmdbarFrames: LiveFrame[] }).__cmdbarFrames);
    const paint = paintViolations(frames, allowed);
    const asks = requestViolations(double.requests.slice(switchedAt), 0, null);
    expect({ paint, asks }, "a figure of another period under the header, or a request across companies").toEqual({ paint: [], asks: [] });
    const last = frames.at(-1)!;
    expect(last.header).toBe(d24.header);
    expect(last.carriers.length).toBeGreaterThanOrEqual(3);
    console.log(`GATE-WORK cmdbar-live-switch period frames=${frames.length} foreign_carriers=${foreign.length}`);
    await ctx.close();
  });
});

// ── G11 — the bar's own "Switch to <company>", live ─────────────────────
//
// Review round 2 of stage CB-I. The action switched IN PLACE, under the URL
// on display (CommandPalette `select()`), and a screen that pins a company
// holds for it (lib/companyOnScreen): on Scandia's dashboard (and a bare
// /dashboard) the header read "Agras SRL · Dec 2025" over a blank held page,
// on Scandia's company page it read Agras over Scandia's page, and when the
// hold's ask window ran out the screen went back to Scandia; /benchmark never
// switched. G10 moves the URL itself; this presses the bar's own row.

/** The hold's ask window, read from its source: the law samples past it. */
const HOLD_ASK_WINDOW_MS = (() => {
  const src = readFileSync(resolve(REPO, "frontend/lib/companyOnScreen.ts"), "utf-8");
  const m = /export const HOLD_ASK_WINDOW_MS = ([\d_]+);/.exec(src);
  if (!m) throw new Error("HOLD_ASK_WINDOW_MS is no longer declared in lib/companyOnScreen.ts — retarget G11");
  return Number(m[1].replace(/_/g, ""));
})();
/** How soon after the pick the header must name the new company. */
const SWITCH_WITHIN_MS = 5_000;
/** How long after the header names it the page may still be held (the
 *  hold lifts once the remote write re-resolves every reader). */
const HELD_GRACE_MS = 2_000;

/** The company a URL pins: `?org=`, its period's company, or the company
 *  page — none for /settings, a bare /dashboard, /benchmark with no period. */
function companyOfUrl(url: string): string | null {
  const u = new URL(url, "http://x.invalid");
  const org = u.searchParams.get("org");
  if (org) return org;
  const period = u.searchParams.get("period");
  if (period && OWNER[period]) return OWNER[period];
  const m = /^\/workspace\/([^/]+)$/.exec(u.pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

test.describe("G11 — the bar's own 'Switch to Agras SRL' switches, and stays switched", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(120_000);
  const NAMES = { [ORG_SCANDIA]: "Scandia Food SRL", [ORG_AGRAS]: "Agras SRL" };
  const STARTS = [
    { name: "Scandia's dashboard", url: `/dashboard?period=${SCANDIA_PERIOD}&org=${ORG_SCANDIA}`, language: "en" },
    { name: "Scandia's dashboard, in Romanian", url: `/dashboard?period=${SCANDIA_PERIOD}&org=${ORG_SCANDIA}`, language: "ro" },
    { name: "Scandia's company page", url: `/workspace/${ORG_SCANDIA}`, language: "en" },
    { name: "/benchmark of Scandia's period", url: `/benchmark?period=${SCANDIA_PERIOD}`, language: "en" },
    { name: "the bare dashboard", url: "/dashboard", language: "en" },
    { name: "/settings", url: "/settings", language: "en" },
  ] as const;

  for (const start of STARTS) {
    test(`from ${start.name}`, async ({ page }) => {
      const double = new WorkspaceDouble({ theme: "dark", language: start.language });
      double.periods[ORG_AGRAS] = [AGRAS];
      const watch = await installHeaderWatch(page, NAMES, OWNER);
      await double.install(page);
      await page.goto(start.url, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("header-command-bar")).toContainText("Scandia Food SRL", { timeout: 25_000 });
      await settle(page, double);

      await page.getByTestId("header-command-bar").click();
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await typeQuery(page, "agras");
      // Agras's own year has been read (the bar reads every company's years
      // while it is open), so the action opens its dashboard.
      await expect(page.locator(`[data-row-id="page:year:${ORG_AGRAS}:${AGRAS_PERIOD}"]`)).toBeVisible({ timeout: 10_000 });
      const row = page.locator(`[data-row-id="action:switch:${ORG_AGRAS}"]`);
      // POSITIVE CONTROL: the row pressed is the bar's own switch action.
      await expect(row).toContainText(start.language === "ro" ? "Treci la Agras SRL" : "Switch to Agras SRL");

      const pickedAt = double.requests.length;
      const watchedAt = watch.violations.length;
      const t0 = Date.now();
      await row.click();
      type Sample = { at: number; header: string; held: boolean; url: string; reqs: number };
      const samples: Sample[] = [];
      while (Date.now() - t0 < HOLD_ASK_WINDOW_MS + 2_500) {
        const s = await page.evaluate(() => ({
          header: document.querySelector('[data-testid="header-command-bar"]')?.textContent?.trim() ?? "",
          // The dashboard's hold (AppShell) or the company page's own.
          held: !!document.querySelector('[data-testid="org-param-hold"], [data-testid="company-page-hold"]'),
          url: location.pathname + location.search,
        }));
        samples.push({ ...s, at: Date.now() - t0, reqs: double.requests.length });
        await page.waitForTimeout(250);
      }

      const out: string[] = [];
      const named = samples.find((s) => s.header.startsWith("Agras SRL"));
      if (!named || named.at > SWITCH_WITHIN_MS) {
        out.push(`the header did not name Agras within ${SWITCH_WITHIN_MS} ms (first: ${named ? named.at + " ms" : "never"})`);
      }
      // Each kind of failure once, as the span of samples it covers.
      const span = (what: string, bad: (s: Sample) => boolean) => {
        const hit = samples.slice(named ? samples.indexOf(named) : samples.length).filter(bad);
        if (hit.length) {
          const a = hit[0], b = hit.at(-1)!;
          out.push(`${what} from ${a.at} to ${b.at} ms (${hit.length} samples): "${b.header}" at ${b.url}`);
        }
      };
      span("the header went back", (s) => !s.header.startsWith("Agras SRL"));
      span("the page is held blank under the new header", (s) => s.held && !!named && s.at > named.at + HELD_GRACE_MS);
      const last = samples.at(-1)!;
      if (last.at < HOLD_ASK_WINDOW_MS) out.push(`VACUITY: sampled only ${last.at} ms, not past the ask window`);
      if (companyOfUrl(last.url) !== ORG_AGRAS) out.push(`the screen it ends on (${last.url}) is not Agras's own`);
      const mark = (named?.reqs ?? double.requests.length) - pickedAt;
      out.push(...requestViolations(double.requests.slice(pickedAt), mark, ORG_SCANDIA));
      // From the pick on (the header watch runs from the page load).
      out.push(...watch.violations.slice(watchedAt).map((v) => `header watch: ${v}`));
      expect([...new Set(out)], "the bar's own switch").toEqual([]);

      // The bar opened again searches Agras, with Agras's own items.
      await page.getByTestId("header-command-bar").click();
      await expect(page.getByTestId("cmdbar-scope")).toHaveText(
        new RegExp(`^${start.language === "ro" ? "Caut în" : "Searching"} Agras SRL · `), { timeout: 15_000 });
      await expect(page.getByTestId("cmdbar-row-now").first()).toBeVisible({ timeout: 15_000 });
      const ids = await page.getByTestId("cmdbar-row-now").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-id")));
      expect(ids).toEqual((ATTENTION[AGRAS_PERIOD].items as { key: string }[]).map((i) => `now:${i.key}`));
      expect(watch.checks, "VACUITY: the header watch ran").toBeGreaterThan(0);
      console.log(`GATE-WORK cmdbar-live-switch-action from="${start.name}" named_at=${named?.at} samples=${samples.length} ends=${last.url.replace(/[0-9a-f-]{36}/g, (id) => (id === ORG_AGRAS ? "<Agras>" : id === AGRAS_PERIOD ? "<Agras FY2025>" : id))} requests=${double.requests.length - pickedAt}`);
    });
  }
});
