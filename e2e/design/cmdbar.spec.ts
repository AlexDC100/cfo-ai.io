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
 *   G4  no horizontal overflow at 390; the panel fits the viewport.
 *
 * Screenshots (CMDBAR_SHOTS_DIR set): Scandia and Agras × empty and typed ×
 * 1440 and 390 × Terminal (dark) and Paper (light) × RO and EN.
 *
 * HERMETIC ONLY. The double answers two unresolvable hosts; against a dev
 * server built from .env nothing would be intercepted. Run:
 *   VITE_SUPABASE_URL=http://harness.invalid VITE_SUPABASE_ANON_KEY=harness-anon \
 *     VITE_API_URL=http://engine.invalid npx vite build --outDir /tmp/cmdbar-dist
 *   npx vite preview --outDir /tmp/cmdbar-dist --port 4417 --strictPort &
 *   E2E_HERMETIC=1 E2E_BASE_URL=http://127.0.0.1:4417 \
 *     npx playwright test e2e/design/cmdbar.spec.ts --project=chromium
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

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

// ── G4 + the screenshot loop ────────────────────────────────────────────
for (const vp of [{ label: "1440", width: 1440, height: 900 }, { label: "390", width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"] as const) {
    for (const lang of ["ro", "en"] as const) {
      test.describe(`G4 @${vp.label} ${theme} ${lang}`, () => {
        test.use({ viewport: { width: vp.width, height: vp.height } });
        test.setTimeout(90_000);
        test("empty and typed, both companies: fits the viewport, no horizontal scroll", async ({ browser }) => {
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
            if (SHOTS) await p.screenshot({ path: `${SHOTS}/${c.key}_empty_${vp.label}_${theme === "dark" ? "terminal" : "paper"}_${lang}.png` });
            await typeQuery(p, "profit");
            await expect(p.getByTestId("cmdbar-row-answer").first()).toBeVisible();
            await p.waitForTimeout(200);
            expect(await fits()).toEqual({ overflowX: false, inside: true });
            if (SHOTS) await p.screenshot({ path: `${SHOTS}/${c.key}_typed-profit_${vp.label}_${theme === "dark" ? "terminal" : "paper"}_${lang}.png` });
            await ctx.close();
          }
        });
      });
    }
  }
}
