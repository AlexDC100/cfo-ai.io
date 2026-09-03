/**
 * PROVENANCE — THE SCREENSHOT LOOP (captures only, no gate).
 *
 * Four surfaces × two viewports × two themes × two states, written to
 * `design_review/provenance/r1/` for the honest critique beside them.
 * This file asserts almost nothing on purpose: `provenance.spec.ts`
 * (another lane's) carries the live gates; this one exists so a human —
 * or the critique — can LOOK at the affordance resting, hovered and
 * focused, on a phone and on a desk, in both themes.
 *
 * The period is the same real-engine fixture that spec serves from the
 * browser (`e2e/fixtures/provenance/carniprod_period.json`), read here
 * as data. Nothing is written to any engine or Supabase host: every
 * route this file answers is read-only, and the recover-stuck watchdog
 * is stubbed.
 *
 *   npx playwright test e2e/design/provenance-screens.spec.ts --project=chromium
 */
import { test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dismissPublicTestBanner,
  preseedLearningMode,
  seedTheme,
  seedViewMode,
} from "../_helpers";

test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "captures need the test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIX_DIR = resolve(HERE, "../fixtures/provenance");
const OUT_DIR = resolve(HERE, "../../design_review/provenance/r1");
const PERIOD_RAW = readFileSync(resolve(FIX_DIR, "carniprod_period.json"), "utf-8");
const PERIODS_RAW = readFileSync(resolve(FIX_DIR, "carniprod_periods.json"), "utf-8");
const PERIOD_ID = (JSON.parse(PERIOD_RAW) as { period: { id: string } }).period.id;
const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

const AFF = '[data-provenance="true"]';
const SETTLE_MS = 8_000;

const VIEWPORTS = {
  desk: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;
const THEMES = ["light", "dark"] as const;

async function boot(page: Page, theme: "light" | "dark"): Promise<void> {
  await preseedLearningMode(page, "subtle");
  await seedViewMode(page, "pro");
  await seedTheme(page, theme);
  await page.route(/\/auth\/v1\/user(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: TEST_USER_ID,
        aud: "authenticated",
        role: "authenticated",
        email: "test@cfo-ai.io",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      }),
    }),
  );
  await page.route(new RegExp(`/api/period/${PERIOD_ID}(\\?|$)`), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: PERIOD_RAW }),
  );
  await page.route(/\/api\/org\/periods-with-documents/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: PERIODS_RAW }),
  );
  await page.route(/\/api\/pipeline\/recover-stuck/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6_000);
}

async function openPeriod(page: Page, tab?: string): Promise<void> {
  const q = tab ? `&tab=${tab}` : "";
  await page.goto(`/dashboard?period=${PERIOD_ID}${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
}

/** Rest → hover → focus, three captures of one figure. The card opens on
 *  hover for a pointer and on focus for a keyboard; both are shot so the
 *  critique can see whether the two states actually match. */
async function shootStates(
  page: Page,
  figure: Locator,
  name: string,
): Promise<{ rest: boolean; hover: boolean; focus: boolean }> {
  const out = { rest: false, hover: false, focus: false };
  if ((await figure.count()) === 0) return out;
  await figure.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-rest.png`) });
  out.rest = true;

  await figure.hover();
  await page.waitForTimeout(600);
  out.hover = (await page.locator('[role="tooltip"]').count()) > 0;
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-hover.png`) });

  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await figure.focus();
  await page.waitForTimeout(400);
  out.focus = (await page.locator('[role="tooltip"]').count()) > 0;
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-focus.png`) });
  await page.keyboard.press("Escape");
  return out;
}

for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  for (const theme of THEMES) {
    test.describe(`${vpName} · ${theme}`, () => {
      test.use({ viewport });
      test.setTimeout(180_000);

      test("dashboard · statements · findings · public companies", async ({ page }) => {
        mkdirSync(OUT_DIR, { recursive: true });
        await boot(page, theme);
        const tag = `${vpName}-${theme}`;
        const log: Record<string, unknown> = {};

        // DASHBOARD — the Pro key-metric row, revenue tile.
        await openPeriod(page);
        log.dashboard = await shootStates(
          page,
          page.locator(`[data-testid="key-metric-revenue-amount"] ${AFF}`).first(),
          `dashboard-${tag}`,
        );
        log.dashboardAffordances = await page.locator(`[data-testid="key-metrics"] ${AFF}`).count();

        // STATEMENTS — the balance sheet, first account-coded row.
        await openPeriod(page, "balance_sheet");
        log.statements = await shootStates(
          page,
          page.locator(`.bs-statement .bs-row ${AFF}`).first(),
          `statements-${tag}`,
        );
        log.statementAffordances = await page.locator(`.bs-statement ${AFF}`).count();

        // FINDINGS — the first finding card's threshold figures. Findings
        // render inside the statement tabs' "Notes & recommendations"
        // sections (the recommendations tab chip is gone since 2026-07-25),
        // so look on the balance sheet first, then P&L, then the overview.
        let card = page.locator('[data-testid^="fnd-card-"]').first();
        for (const tab of ["pl", undefined] as const) {
          if ((await card.count()) > 0) break;
          await openPeriod(page, tab);
          card = page.locator('[data-testid^="fnd-card-"]').first();
        }
        log.findings = await shootStates(
          page,
          card.locator(`[data-testid="fnd-threshold"] ${AFF}`).first(),
          `findings-${tag}`,
        );
        log.findingAffordances = await page.locator(`[data-testid^="fnd-card-"] ${AFF}`).count();

        // PUBLIC COMPANIES — the markets overview, first company card footer.
        await page.goto("/public-companies", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(SETTLE_MS);
        await dismissPublicTestBanner(page);
        log.publicCompanies = await shootStates(
          page,
          page.locator(`[data-testid^="company-card-"] ${AFF}, .group ${AFF}`).first(),
          `public-companies-${tag}`,
        );
        log.publicAffordances = await page.locator(AFF).count();

        // The counts are printed, not asserted — the gates live in
        // provenance.spec.ts; this file's output is the pictures.
        console.log(`PROVENANCE-SCREENS ${tag} ${JSON.stringify(log)}`);
      });
    });
  }
}
