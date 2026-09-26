/**
 * workspace_v2 — the browser gates (G7 end to end, with G1, G3, G5 and G6
 * watched on the way), against the REAL production bundle and a hermetic
 * backend double (e2e/workspace-v2.double.ts). Nothing leaves the machine.
 *
 *   1. Scandia's company page is open (the header names Scandia).
 *   2. The anonymized real Agras FY2025 balance is DROPPED on the page.
 *   3. The confirmation card names Agras, its CUI, 31.12.2025 and where
 *      each came from — G1: Scandia on screen, Agras's file, Agras's card.
 *   4. ONE tap, "Analizează" / "Analyse": the commit carries Agras and
 *      2025-12-31; the screen and the header follow the file to Agras; the
 *      card shows the five live steps naming Agras.
 *   5. The analysis finishes: toast + bell, and the analysed dashboard of
 *      Agras opens, printing the revenue the engine served for that book.
 *   6. G3: the same file again → "Already uploaded — open it", nothing
 *      committed.
 *
 * On every DOM mutation, the header must name the company the page is about
 * (G6, `installHeaderWatch`). On each of the three screens every file input
 * belongs to the one upload component (G5 at runtime), and no screen says
 * "source" / "attachment" (plain language).
 *
 * The screenshot loop (WS_SHOTS_DIR set) captures the three screens, the
 * confirmation card and the progress at 1440 and 390, dark and Paper, EN and
 * RO — captures only.
 *
 * Run against a hermetic build (no .env, two unresolvable hosts):
 *   VITE_OUT_DIR=/tmp/ws-dist VITE_SUPABASE_URL=http://harness.invalid \
 *     VITE_SUPABASE_ANON_KEY=harness-anon VITE_API_URL=http://engine.invalid \
 *     npx vite build --outDir /tmp/ws-dist
 *   npx vite preview --outDir /tmp/ws-dist --port 4417 --strictPort &
 *   E2E_BASE_URL=http://127.0.0.1:4417 npx playwright test e2e/workspace-v2.spec.ts --project=chromium
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  AGRAS,
  ORG_AGRAS,
  ORG_SCANDIA,
  SCANDIA,
  USER_ID,
  WorkspaceDouble,
  agrasBalanceBytes,
  dropFile,
  installHeaderWatch,
} from "./workspace-v2.double";

test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "the hermetic double needs a local build of the bundle (see the header)",
);

const NAMES = { [ORG_SCANDIA]: "Scandia Food SRL", [ORG_AGRAS]: "Agras SRL" };
const AGRAS_PERIOD = AGRAS.period.period.id as string;
const AGRAS_REVENUE = AGRAS.years[0].revenue as number;
const SCANDIA_PERIOD = SCANDIA.period.period.id as string;
const SCANDIA_REVENUE = SCANDIA.years[0].revenue as number;
/** Which company each analysed period belongs to — the G6 watch's authority
 *  for a dashboard that carries `?period=` alone. */
const OWNERS = { [SCANDIA_PERIOD]: ORG_SCANDIA, [AGRAS_PERIOD]: ORG_AGRAS };
const FORBIDDEN_WORDS = /\b(source|attachment|sursă|sursa|atașament|atasament)\b/i;

/** Every file input on the screen belongs to the one upload component. */
async function expectOneUploadComponent(page: Page, expected: number): Promise<void> {
  const inputs = page.locator('input[type="file"]');
  await expect(inputs).toHaveCount(expected);
  for (let i = 0; i < expected; i++) {
    await expect(inputs.nth(i)).toHaveAttribute("data-upload-component", /^(zone|tile)$/);
  }
}

async function expectPlainLanguage(page: Page): Promise<void> {
  const text = await page.locator("main").innerText().catch(() => "");
  const card = await page.locator('[data-testid="upload-card"]').innerText().catch(() => "");
  expect(`${text}\n${card}`).not.toMatch(FORBIDDEN_WORDS);
}

function millions(n: number, lang: "en" | "ro"): RegExp {
  // "118.6 M" / "118,6 mil." — the page's own Money formatting; only the
  // digits are pinned (to one decimal), both separators accepted.
  const [int, dec] = (n / 1e6).toFixed(1).split(".");
  void lang;
  return new RegExp(`${int}[.,]${dec}`);
}

for (const lang of ["ro", "en"] as const) {
  test.describe(`G7 — drop → Analyse → analysed dashboard (${lang})`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test.setTimeout(120_000);

    test("an Agras file dropped on Scandia's page lands in Agras, one tap, five steps, the dashboard", async ({ page }) => {
      const double = new WorkspaceDouble({ theme: "light", language: lang });
      await double.install(page);
      const watch = await installHeaderWatch(page, NAMES, OWNERS);

      // ── Scandia's company page ─────────────────────────────────────
      await page.goto(`/workspace/${ORG_SCANDIA}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("company-title")).toHaveText("Scandia Food SRL", { timeout: 20_000 });
      await expect(page.getByTestId("header-command-bar")).toContainText("Scandia Food SRL");
      await expect(page.getByTestId("company-year-2025")).toBeVisible();
      await expectOneUploadComponent(page, 1);
      await expectPlainLanguage(page);

      // ── Drop the Agras balance anywhere on the page ───────────────
      await dropFile(page, "balanta_2017.xlsx", agrasBalanceBytes(), '[data-testid="company-title"]');
      const card = page.getByTestId("upload-card");
      await expect(card).toHaveAttribute("data-phase", "confirm", { timeout: 15_000 });
      expect(double.identifies.at(-1)?.orgHeader).toBe(ORG_SCANDIA);
      // G1 on the card: Agras, its CUI, the DOCUMENT's period.
      await expect(page.getByTestId("upload-card-company-value")).toContainText("Agras SRL");
      await expect(page.getByTestId("upload-card-cui-value")).toContainText("46355095");
      await expect(page.getByTestId("upload-card-period-value")).toContainText(/2025/);
      await expect(page.getByTestId("upload-card-period-value")).not.toContainText(/2017/);
      await expect(page.getByTestId("upload-card-cui-from")).not.toHaveText("");
      await expect(page.getByTestId("upload-card-period-from")).not.toHaveText("");
      await expectPlainLanguage(page);
      // One primary action on the card.
      await expect(page.getByTestId("upload-card-analyse")).toHaveText(lang === "ro" ? /Analizează/ : /Analy[sz]e/);

      // ── One tap ────────────────────────────────────────────────────
      await page.getByTestId("upload-card-analyse").click();
      // G1 at the wire: the ONE commit names Agras and the document's period.
      await expect.poll(() => double.commits.length, { timeout: 15_000 }).toBe(1);
      expect(double.commits[0].target_org_id).toBe(ORG_AGRAS);
      expect(double.commits[0].period_end).toBe("2025-12-31");
      expect(double.commits[0].create_company).toBeUndefined();
      await expect(card).toHaveAttribute("data-phase", "progress", { timeout: 15_000 });
      // The screen and the header follow the file to Agras.
      await expect(page).toHaveURL(new RegExp(`/workspace/${ORG_AGRAS}`));
      await expect(page.getByTestId("header-command-bar")).toContainText("Agras SRL");
      await expect(card).toContainText("Agras SRL");
      await expect(page.locator('[data-testid^="upload-progress-step-"]')).toHaveCount(5);

      // ── Done → the analysed company's dashboard ────────────────────
      await expect(page).toHaveURL(new RegExp(`/dashboard\\?period=${AGRAS_PERIOD}&org=${ORG_AGRAS}`), {
        timeout: 60_000,
      });
      await expect(page.getByTestId("header-command-bar")).toContainText("Agras SRL", { timeout: 20_000 });
      await expect(page.locator("body")).toContainText(millions(AGRAS_REVENUE, lang), { timeout: 30_000 });
      await expectOneUploadComponent(page, 0);
      // Toast + bell entry.
      await expect(page.locator("[data-sonner-toast]").first()).toContainText("Agras SRL");
      await expect(page.getByTestId("notifications-badge")).toBeVisible();
      await page.getByTestId("notifications-button").click();
      await expect(page.getByTestId("notifications-analysis").first()).toContainText("Agras SRL");
      await page.keyboard.press("Escape");

      // ── The company page now has the year ─────────────────────────
      await page.goto(`/workspace/${ORG_AGRAS}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("company-title")).toHaveText("Agras SRL", { timeout: 20_000 });
      await expect(page.getByTestId("company-year-2025-revenue")).toContainText(millions(AGRAS_REVENUE, lang));

      // ── G3: the same file again ────────────────────────────────────
      await dropFile(page, "balanta_2017.xlsx", agrasBalanceBytes(), '[data-testid="company-title"]');
      await expect(card).toHaveAttribute("data-phase", "duplicate", { timeout: 15_000 });
      await expect(card).toContainText(lang === "ro" ? "Deja încărcat" : "Already uploaded");
      await expect(page.getByTestId("upload-card-duplicate-open")).toBeVisible();
      expect(double.commits).toHaveLength(1);

      // ── G6 held on every mutation of the run ──────────────────────
      expect(watch.violations).toEqual([]);
      // Distinct (page, header) states checked — at least the four the run
      // walks: Scandia's page, Agras's page, Agras's dashboard, Agras again.
      expect(watch.checks).toBeGreaterThanOrEqual(4);
      expect(double.unhandled.filter((u) => u.startsWith("THREW"))).toEqual([]);
      console.log(`[workspace-v2] G6 header checks (${lang}): ${watch.checks}, violations: ${watch.violations.length}`);
      console.log(`[workspace-v2] unmodelled requests (${lang}):`, JSON.stringify([...new Set(double.unhandled)]));
    });

    // G6, the redesign's own paths (2026-09-26). Owner-reported: with Agras
    // open — its company page, no analysed year — the sidebar's Dashboard
    // landed on /dashboard?period=<one of Scandia's> under a header reading
    // "Agras SRL · dec. 2025". Rule: a dashboard link from a company page
    // opens THAT company's latest analysed period, or, with none, the company
    // page itself with its one-line state; a period of another company
    // switches the active company first; the header describes the screen.
    test("G6 — Dashboard from a company page is THAT company's, and a stale period link switches the company first", async ({ page }) => {
      const double = new WorkspaceDouble({ theme: "light", language: lang });
      await double.install(page);
      const watch = await installHeaderWatch(page, NAMES, OWNERS);
      const noAnalysis = lang === "ro" ? "Nicio analiză încă" : "No analysis yet";
      const dashboardRow = page.locator('aside [data-testid="sidebar-dashboard"]').first();

      // ── Agras: no analysed year. The row leads to the page's own state. ──
      await page.goto(`/workspace/${ORG_AGRAS}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("company-title")).toHaveText("Agras SRL", { timeout: 20_000 });
      await expect(page.getByTestId("company-no-years")).toContainText(noAnalysis);
      await expect(dashboardRow).toHaveAttribute("href", `/workspace/${ORG_AGRAS}`);
      await dashboardRow.click();
      await page.waitForTimeout(1500);
      await expect(page).toHaveURL(new RegExp(`/workspace/${ORG_AGRAS}$`));
      expect(page.url()).not.toContain(SCANDIA_PERIOD);
      await expect(page.getByTestId("company-no-years")).toContainText(noAnalysis);
      await expect(page.getByTestId("header-command-bar")).toContainText("Agras SRL");

      // ── Scandia: its latest analysed year, the company pinned. ──────
      await page.goto(`/workspace/${ORG_SCANDIA}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("company-title")).toHaveText("Scandia Food SRL", { timeout: 20_000 });
      await expect(dashboardRow).toHaveAttribute("href", `/dashboard?period=${SCANDIA_PERIOD}&org=${ORG_SCANDIA}`);
      await dashboardRow.click();
      await expect(page).toHaveURL(new RegExp(`/dashboard\\?period=${SCANDIA_PERIOD}&org=${ORG_SCANDIA}`));
      await expect(page.getByTestId("header-command-bar")).toContainText("Scandia Food SRL", { timeout: 20_000 });
      await expect(page.locator("body")).toContainText(millions(SCANDIA_REVENUE, lang), { timeout: 30_000 });

      // ── A stale link: Scandia's period while Agras is active. ───────
      await page.goto(`/workspace/${ORG_AGRAS}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("company-title")).toHaveText("Agras SRL", { timeout: 20_000 });
      await expect(page.getByTestId("header-command-bar")).toContainText("Agras SRL");
      await page.goto(`/dashboard?period=${SCANDIA_PERIOD}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("header-command-bar")).toContainText("Scandia Food SRL", { timeout: 20_000 });
      await expect(page.locator("body")).toContainText(millions(SCANDIA_REVENUE, lang), { timeout: 30_000 });

      expect(watch.violations).toEqual([]);
      expect(watch.checks).toBeGreaterThanOrEqual(3);
      expect(double.unhandled.filter((u) => u.startsWith("THREW"))).toEqual([]);
      console.log(`[workspace-v2] G6 company-page→Dashboard checks (${lang}): ${watch.checks}, violations: ${watch.violations.length}`);
    });

    // G6, the comparison (live walkthrough, 2026-09-26). Scandia Food's
    // dashboard, then another company's analysed period: the Overview
    // printed "No comparison: period '<Scandia's id>' is not in this
    // workspace". The "compare with" choice was ONE browser-wide value (and
    // Scandia's company preference), so the dashboard asked the engine to
    // compare the next company's period with Scandia's, and printed the
    // engine's refusal line, raw id and all. Rule: after a company switch no
    // request names a period of the company left behind; the prior is only
    // ever one of the current company's own periods; a company with one
    // period shows no comparison and no error; no raw id reaches the screen.
    test("G6 — a company switch carries no period of the company left behind into any request, and no raw id to the screen", async ({ page }) => {
      const COLUMNS = { prior: true, delta: true, deltaPct: true, share: true };
      const double = new WorkspaceDouble({ theme: "light", language: lang });
      // Agras has its analysed year from the start; Scandia's reader had
      // chosen a comparison, synced to Scandia's company preferences.
      double.periods[ORG_AGRAS].push(AGRAS);
      double.orgPrefs[ORG_SCANDIA].comparatives_view = { priorPeriodId: SCANDIA_PERIOD, columns: COLUMNS };
      // …and under the per-company key every choice is stored under now.
      double.orgPrefs[ORG_SCANDIA].comparatives_view_v2 = { priorPeriodId: SCANDIA_PERIOD, columns: COLUMNS };
      await double.install(page);
      // What every browser that used the dashboard before this fix holds:
      // ONE "compare with" choice, under a key naming no company.
      await page.addInitScript(
        ({ value }) => {
          try {
            localStorage.setItem("cfo:comparatives-view:v1", value);
          } catch {
            /* ignore */
          }
        },
        { value: JSON.stringify({ priorPeriodId: SCANDIA_PERIOD, columns: COLUMNS }) },
      );
      const watch = await installHeaderWatch(page, NAMES, OWNERS);
      const header = page.getByTestId("header-command-bar");
      const dashboardRow = page.locator('aside [data-testid="sidebar-dashboard"]').first();

      // ── Scandia's dashboard, the way the owner opened it ───────────
      await page.goto(`/workspace/${ORG_SCANDIA}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("company-title")).toHaveText("Scandia Food SRL", { timeout: 20_000 });
      await dashboardRow.click();
      await expect(page).toHaveURL(new RegExp(`/dashboard\\?period=${SCANDIA_PERIOD}&org=${ORG_SCANDIA}`));
      await expect(header).toContainText("Scandia Food SRL", { timeout: 20_000 });
      await expect(page.locator("body")).toContainText(millions(SCANDIA_REVENUE, lang), { timeout: 30_000 });

      // ── The switch: Agras's company page, then its Dashboard ───────
      // From the switch on, nothing asked of Agras names a Scandia period;
      // once Agras's page is up, nothing at all does (a request Scandia's
      // page sent for its own period as it was left is Scandia's, under
      // Scandia's X-Org-Id — not a leak).
      const switchedAt = double.requests.length;
      await page.goto(`/workspace/${ORG_AGRAS}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("company-title")).toHaveText("Agras SRL", { timeout: 20_000 });
      const mark = double.requests.length;
      await expect(dashboardRow).toHaveAttribute("href", `/dashboard?period=${AGRAS_PERIOD}&org=${ORG_AGRAS}`);
      await dashboardRow.click();
      await expect(page).toHaveURL(new RegExp(`/dashboard\\?period=${AGRAS_PERIOD}&org=${ORG_AGRAS}`));
      await expect(header).toContainText("Agras SRL", { timeout: 20_000 });
      await expect(page.locator("body")).toContainText(millions(AGRAS_REVENUE, lang), { timeout: 30_000 });
      // Every request the page makes on arrival has had its chance to fire.
      await page.waitForTimeout(2_500);

      const namesScandia = (r: { path: string; search: string }) => `${r.path}${r.search}`.includes(SCANDIA_PERIOD);
      const askedOfAgras = double.requests.slice(switchedAt).filter((r) => r.org === ORG_AGRAS && namesScandia(r));
      expect(askedOfAgras, "a request asked of Agras named a period of Scandia's").toEqual([]);
      const after = double.requests.slice(mark);
      const foreign = after.filter(namesScandia);
      expect(foreign, "a request after the switch named a period of Scandia's").toEqual([]);
      expect(
        double.comparisons.filter((c) => c.org === ORG_AGRAS),
        "Agras has one analysed year: there is nothing to compare it with",
      ).toEqual([]);
      const text = await page.locator("body").innerText();
      expect(text).not.toContain(SCANDIA_PERIOD);
      expect(text).not.toMatch(/not in this workspace|nu este în acest spațiu/i);
      const states = await page
        .locator("[data-prior-state]")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-prior-state")));
      expect(states.filter((st) => st === "refused" || st === "failed")).toEqual([]);

      expect(watch.violations).toEqual([]);
      expect(double.unhandled.filter((u) => u.startsWith("THREW"))).toEqual([]);
      console.log(
        `[workspace-v2] G6 company switch (${lang}): ${after.length} requests after the switch, ` +
          `${foreign.length} naming Scandia's period, comparisons asked of Agras: ` +
          `${double.comparisons.filter((c) => c.org === ORG_AGRAS).length}`,
      );
    });
  });
}

test.describe("G5 at runtime — the home screen", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("one drop zone, one file input, a card per company", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "dark", language: "ro" });
    await double.install(page);
    await page.goto("/workspace", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 20_000 });
    // The header describes the screen: Home is "Companiile tale", not the
    // company last opened (the double boots with Scandia active).
    await expect(page.getByTestId("header-command-bar")).toContainText("Companiile tale");
    await expect(page.getByTestId("header-command-bar")).not.toContainText("Scandia");
    await expect(page.getByTestId(`company-card-${ORG_SCANDIA}`)).toContainText("16070576");
    await expect(page.getByTestId(`company-card-${ORG_AGRAS}`)).toContainText("46355095");
    await expect(page.getByTestId("upload-drop-zone")).toHaveCount(1);
    await expectOneUploadComponent(page, 1);
    await expectPlainLanguage(page);
  });
});

// ── THE AUTH-LOCK FLOOD (P0, measured on production 2026-09-26) ────────
//
// A company page queued supabase-js auth-lock requests without end (1,080
// pending `lock:sb-<ref>-auth-token` after 8 s, 35,066 a few minutes later);
// that Web Lock is shared by every tab of the origin, so every other tab hung
// on "Signing you in…". Two authorities over "the company on screen" fought
// forever — two TABS through the one browser-wide header name, or, in one
// tab, the company page and the shell's dashboard hold over a foreign
// `?period=` / `?org=` — and every flip remounted a page that re-read the
// session and the preferences. The real bundle's supabase-js takes the real
// Web Lock here, so the lock queue is measured, not modelled.
//
// Fails on: more than 20 requests to the double in 10 s once the page has
// settled, or a queue of auth-lock requests, on Agras's page — its only
// document a FAILED upload, as production's is — alone, beside a second tab
// on Scandia, and under a foreign `?period=` / `?org=`.

/** Agras's only document: the failed upload the migration moved into it. */
function withFailedAgrasUpload(double: WorkspaceDouble): void {
  double.keptDocuments.push({
    id: "c1368347-0000-4000-8000-000000000001", org_id: ORG_AGRAS, uploaded_by: USER_ID, status: "failed",
    original_filename: "balanta.pdf", display_name: "balanta.pdf", storage_path: `${ORG_AGRAS}/uploads/balanta.pdf`,
    period_id: null, error: "The document could not be read.", scope: "financial", detected_type: null,
    detected_language: null, is_active: true, size_bytes: 1, created_at: "2026-09-20T10:00:00Z", deleted_at: null,
  });
}

/** supabase-js auth-lock requests waiting on `page`'s origin. */
async function pendingAuthLocks(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const q = await navigator.locks.query();
    return (q.pending ?? []).filter((l) => (l.name ?? "").startsWith("lock:sb-")).length;
  });
}

/** Requests to the double during `ms` of quiet on an already-settled screen. */
async function quietWindow(double: WorkspaceDouble, page: Page, ms = 10_000) {
  const mark = double.requests.length;
  await page.waitForTimeout(ms);
  const after = double.requests.slice(mark);
  const byPath: Record<string, number> = {};
  for (const r of after) byPath[`${r.method} ${r.path}`] = (byPath[`${r.method} ${r.path}`] ?? 0) + 1;
  return { count: after.length, byPath: JSON.stringify(byPath) };
}

test.describe("the auth-lock flood — a company page settles", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(90_000);

  test("Agras's page (its only document failed) settles: bounded requests, no auth-lock queue", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "light", language: "en" });
    withFailedAgrasUpload(double);
    await double.install(page);
    await page.goto(`/workspace/${ORG_AGRAS}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("company-title")).toHaveText("Agras SRL", { timeout: 20_000 });
    await expect(page.getByTestId("company-no-years")).toBeVisible();
    await page.waitForTimeout(3_000);
    const w = await quietWindow(double, page);
    expect(w.count, `requests in 10 s: ${w.byPath}`).toBeLessThanOrEqual(20);
    expect(await pendingAuthLocks(page)).toBeLessThanOrEqual(3);
    console.log(`[workspace-v2] flood — Agras alone: ${w.count} requests in 10 s ${w.byPath}`);
  });

  test("two tabs on two companies do not fight over the header", async ({ context }) => {
    const double = new WorkspaceDouble({ theme: "light", language: "en" });
    withFailedAgrasUpload(double);
    const agras = await context.newPage();
    const scandia = await context.newPage();
    await double.install(agras);
    await double.install(scandia);
    await agras.goto(`/workspace/${ORG_AGRAS}`, { waitUntil: "domcontentloaded" });
    await expect(agras.getByTestId("company-title")).toHaveText("Agras SRL", { timeout: 20_000 });
    await scandia.goto(`/dashboard?period=${SCANDIA_PERIOD}&org=${ORG_SCANDIA}`, { waitUntil: "domcontentloaded" });
    await expect(scandia.getByTestId("header-command-bar")).toContainText("Scandia Food SRL", { timeout: 20_000 });
    await scandia.waitForTimeout(3_000);
    const w = await quietWindow(double, scandia);
    expect(w.count, `requests in 10 s, both tabs: ${w.byPath}`).toBeLessThanOrEqual(20);
    expect(await pendingAuthLocks(scandia)).toBeLessThanOrEqual(3);
    // Each tab still names its own company.
    await expect(agras.getByTestId("header-command-bar")).toContainText("Agras SRL");
    await expect(agras.getByTestId("company-title")).toHaveText("Agras SRL");
    await expect(scandia.getByTestId("header-command-bar")).toContainText("Scandia Food SRL");
    console.log(`[workspace-v2] flood — two tabs: ${w.count} requests in 10 s ${w.byPath}`);
  });

  for (const [what, search] of [
    ["?period= of Scandia's", `?period=${SCANDIA_PERIOD}`],
    ["?org= of Scandia", `?org=${ORG_SCANDIA}`],
  ] as const) {
    test(`a ${what} on Agras's page: the page's company wins, once`, async ({ page }) => {
      const double = new WorkspaceDouble({ theme: "light", language: "en" });
      withFailedAgrasUpload(double);
      await double.install(page);
      await page.goto(`/workspace/${ORG_AGRAS}${search}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("company-title")).toHaveText("Agras SRL", { timeout: 20_000 });
      await expect(page.getByTestId("header-command-bar")).toContainText("Agras SRL");
      await page.waitForTimeout(3_000);
      const w = await quietWindow(double, page);
      expect(w.count, `requests in 10 s: ${w.byPath}`).toBeLessThanOrEqual(20);
      expect(await pendingAuthLocks(page)).toBeLessThanOrEqual(3);
      await expect(page.getByTestId("company-title")).toHaveText("Agras SRL");
      // The foreign parameter is dropped: the page is about its path's company.
      expect(page.url()).not.toContain(SCANDIA_PERIOD);
      expect(page.url()).not.toContain(`org=${ORG_SCANDIA}`);
      console.log(`[workspace-v2] flood — ${what}: ${w.count} requests in 10 s ${w.byPath}`);
    });
  }
});

// ── The screenshot loop ─────────────────────────────────────────────────
const SHOTS = process.env.WS_SHOTS_DIR;

const VIEWPORTS = { "1440": { width: 1440, height: 900 }, "390": { width: 390, height: 844 } } as const;

for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
  for (const theme of ["dark", "light"] as const) {
    for (const lang of ["ro", "en"] as const) {
      test.describe(`shots ${vp} · ${theme === "light" ? "paper" : "dark"} · ${lang}`, () => {
        test.skip(!SHOTS, "set WS_SHOTS_DIR to capture");
        test.use({ viewport });
        test.setTimeout(120_000);

        test("home · confirmation card · progress · company page · dashboard", async ({ page }) => {
          const dir = resolve(SHOTS as string);
          mkdirSync(dir, { recursive: true });
          const tag = `${vp}-${theme === "light" ? "paper" : "dark"}-${lang}`;
          const double = new WorkspaceDouble({ theme, language: lang, holdAt: "computing" });
          await double.install(page);
          const watch = await installHeaderWatch(page, NAMES, OWNERS);

          await page.goto("/workspace", { waitUntil: "domcontentloaded" });
          await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 20_000 });
          await expect(page.getByTestId(`company-card-${ORG_SCANDIA}`)).toBeVisible();
          await page.waitForTimeout(1200);
          await page.screenshot({ path: resolve(dir, `1-home-${tag}.png`), fullPage: true });

          await dropFile(page, "balanta_2017.xlsx", agrasBalanceBytes(), '[data-testid="workspace-home"]');
          await expect(page.getByTestId("upload-card")).toHaveAttribute("data-phase", "confirm", { timeout: 15_000 });
          await page.waitForTimeout(500);
          await page.screenshot({ path: resolve(dir, `2-card-${tag}.png`) });

          await page.getByTestId("upload-card-analyse").click();
          await expect(page.getByTestId("upload-card")).toHaveAttribute("data-phase", "progress", { timeout: 15_000 });
          // Held at "computing": steps 1-3 done/running, the rest waiting.
          await expect(page.getByTestId("upload-progress-step-3")).toBeVisible();
          await page.waitForTimeout(9_000);
          await page.screenshot({ path: resolve(dir, `3-progress-${tag}.png`) });

          double.release();
          await expect(page).toHaveURL(/\/dashboard\?period=/, { timeout: 60_000 });
          await page.waitForTimeout(4_000);
          await page.screenshot({ path: resolve(dir, `5-dashboard-${tag}.png`) });

          await page.goto(`/workspace/${ORG_AGRAS}`, { waitUntil: "domcontentloaded" });
          await expect(page.getByTestId("company-title")).toHaveText("Agras SRL", { timeout: 20_000 });
          await expect(page.getByTestId("company-year-2025")).toBeVisible();
          await page.waitForTimeout(1200);
          await page.screenshot({ path: resolve(dir, `4-company-${tag}.png`), fullPage: true });

          expect(watch.violations).toEqual([]);
          void SCANDIA;
        });
      });
    }
  }
}
