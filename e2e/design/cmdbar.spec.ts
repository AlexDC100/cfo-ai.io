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
 *   G3  a keystroke fetches NOTHING (the double counts every request).
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
 *       in the same browser), in RO and EN; and nothing is fetched meanwhile.
 *   G7  LATENCY, live: every keystroke of the typed queries re-renders the
 *       groups in < 100 ms, measured in the page from the input event to the
 *       list naming the query, with ZERO requests; the keyboard flow
 *       (↓ stops on "Întreabă CFO AI", ↑ back to the answer, Enter opens the
 *       answer's evidence, Esc closes) on the real bundle.
 *   G8  IN VIEW, live: every row ↓ selects is the row the reader sees —
 *       never parked under the sticky "Întreabă CFO AI" — at 1440 and 390,
 *       both companies; and a new query selects its own first row whatever
 *       the previous walk left (both defects found by this stage's probe).
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
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGRAS,
  ATTENTION,
  ORG_AGRAS,
  ORG_SCANDIA,
  SCANDIA,
  WorkspaceDouble,
} from "../workspace-v2.double";

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
      await pageFor.waitForTimeout(300);
      const during = double.requests.slice(before).map((r) => `${r.method} ${r.path}`);
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
  // The benchmark page's `?row=` receiver is held in jsdom
  // (evidenceReceivers.test.tsx): /benchmark reads
  // /api/benchmarks/report/{period}, which the double holds no capture for,
  // and the double invents no engine answer.
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
  | { kind: "money"; value: number }
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
    // The bar's money printer: the dashboard's amount formatter, compact,
    // from the period's currency into the header's (RON → RON here).
    return js.map((j) => j.kind === "money"
      ? P.formatAmountFrom(j.value, "RON", "RON", { RON: 1, EUR: 1, USD: 1 }, { compact: true })
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

        type Check = { what: string; painted: string | null; job: PrintJob };
        const checks: Check[] = [];

        // Răspuns — statement answers.
        for (const [id, q] of Object.entries(STATEMENT_QUERIES)) {
          const { rows } = await typeInPage(page, q);
          const row = rows.find((r) => r.id === `answer:${id}`);
          expect(row, `${c.key}/${lang}: "${q}" answers ${id}`).toBeTruthy();
          checks.push({ what: `answer:${id}`, painted: row!.figure, job: { kind: "money", value: servedStatement(body, id) } });
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
          checks.push({ what: `account:${li.ro_account_code}`, painted: row!.figure, job: { kind: "money", value: li.amount } });
          accounts++;
        }

        const expected = await printServed(browser, checks.map((k) => k.job));
        const mismatches = checks
          .map((k, i) => ({ what: k.what, painted: k.painted, served: expected[i] }))
          .filter((m) => m.painted !== m.served);
        expect(mismatches, `${c.key}/${lang}: painted ≠ served`).toEqual([]);

        const during = double.requests.slice(before).map((r) => `${r.method} ${r.path}`);
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
      for (const q of ["profit", "4111", "clienti", "stoc", "raport", "cifra de afaceri", "furnizrii", "marja neta", "bilant", "exporta"]) {
        for (let i = 1; i <= q.length; i++) {
          const { ms } = await typeInPage(page, q.slice(0, i));
          walls.push(ms);
        }
        walls.push((await typeInPage(page, "")).ms);
      }
      const sorted = [...walls].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)];
      const max = sorted[sorted.length - 1];
      console.log(`GATE-WORK cmdbar-live-latency ${c.key} keystrokes=${walls.length} p50_ms=${p50.toFixed(1)} max_ms=${max.toFixed(1)}`);
      expect(walls.every((w) => Number.isFinite(w)), "every keystroke painted its query").toBe(true);
      expect(walls.length).toBeGreaterThanOrEqual(60);
      expect(max, `${c.key}: slowest keystroke`).toBeLessThan(100);
      const during = double.requests.slice(before).map((r) => `${r.method} ${r.path}`);
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
