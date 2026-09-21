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
      const watch = await installHeaderWatch(page, NAMES);

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
      // Toast + bell.
      await expect(page.locator("[data-sonner-toast]").first()).toContainText("Agras SRL");

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
  });
}

test.describe("G5 at runtime — the home screen", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("one drop zone, one file input, a card per company", async ({ page }) => {
    const double = new WorkspaceDouble({ theme: "dark", language: "ro" });
    await double.install(page);
    await page.goto("/workspace", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`company-card-${ORG_SCANDIA}`)).toContainText("16070576");
    await expect(page.getByTestId(`company-card-${ORG_AGRAS}`)).toContainText("46355095");
    await expect(page.getByTestId("upload-drop-zone")).toHaveCount(1);
    await expectOneUploadComponent(page, 1);
    await expectPlainLanguage(page);
  });
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
          const watch = await installHeaderWatch(page, NAMES);

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
