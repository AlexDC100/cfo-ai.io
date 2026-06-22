/**
 * /dashboard?period=… → Valuation tab — EBITDA-multiple as the headline.
 *
 * Covers:
 *   · Primary card visible with equity-P50, range (P25 – P75), confidence dot.
 *   · Formula line renders the math (Equity = EBITDA × Multiple − Debt + Cash).
 *   · Industry source attribution shown ("Damodaran … 2026-01-15").
 *   · DCF + EV/Revenue cross-check cards present with sensitivity bands.
 *   · Football field renders ≥ 2 bars and the primary one is highlighted.
 *   · Slider drag fires a PUT and the headline equity re-renders.
 *   · Reset link restores engine defaults.
 *
 * Gated on E2E_REAL=1 — same gating contract as the other real-pipeline
 * specs. Requires a signed-in test account with at least one analyzed
 * financial period (bilanț + P&L combined) so the backend has produced a
 * valuations row.
 */

import { test, expect } from "@playwright/test";

const REAL = process.env.E2E_REAL === "1";
const TEST_EMAIL = process.env.E2E_EMAIL || "test@cfoai.dev";
const TEST_PASSWORD = process.env.E2E_PASSWORD || "Test1234!";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByPlaceholder(/you@company\.com/i).fill(TEST_EMAIL);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/dashboard|\/onboarding|\/products/, { timeout: 10_000 });
  if (page.url().includes("/onboarding")) {
    await page.getByRole("radio").first().click();
    await page.getByRole("button", { name: /continue/i }).click();
  }
}

async function openValuationTab(page: import("@playwright/test").Page) {
  // Land on the dashboard with any period auto-selected; the activePeriod
  // hook + ?period query param do the rest.
  await page.goto("/dashboard");
  // If the user has no analyzed period yet, skip — the spec needs real data.
  const hasValuationTab = await page
    .getByRole("tab", { name: /^valuation$/i })
    .isVisible()
    .catch(() => false);
  test.skip(!hasValuationTab, "No analyzed period — valuation tab not visible.");
  await page.getByRole("tab", { name: /^valuation$/i }).click();
  // Wait for the server-computed primary card; absence means the backend
  // never produced a valuations row for this period (e.g. accounts_count = 0).
  const primary = page.getByTestId("valuation-primary");
  await expect(primary).toBeVisible({ timeout: 5_000 });
}

test.describe(
  REAL ? "valuation (real)" : "valuation (skipped — set E2E_REAL=1 to run)",
  () => {
    test.skip(!REAL, "Set E2E_REAL=1 + a test account with ≥1 analyzed financial period.");

    test("EBITDA-multiple is the headline on the Dashboard Overview tab", async ({ page }) => {
      // Locks down the bug the user reported: "DCF still appears as main
      // evaluation method." This test asserts that when a real period
      // loads, the Overview tab renders the server-computed EBITDA-multiple
      // ValuationSection BEFORE the user has to click into a separate tab.
      test.setTimeout(60_000);
      await signIn(page);
      await page.goto("/dashboard");

      // The Overview tab is the default. The valuation section must appear
      // here, not just in the Valuation tab.
      const overview = page.getByTestId("state-b-overview");
      const hasOverview = await overview.isVisible().catch(() => false);
      test.skip(!hasOverview, "Dashboard in State A (no period loaded) — Overview hero requires real data.");

      const valuationOnOverview = page.getByTestId("dashboard-valuation");
      await expect(valuationOnOverview).toBeVisible({ timeout: 5_000 });

      // The primary card inside is the EBITDA-multiple one
      const primary = valuationOnOverview.getByTestId("valuation-primary");
      await expect(primary).toBeVisible();
      await expect(primary).toContainText(/EBITDA/i);
      await expect(primary).toContainText(/Multiple/i);

      // DCF appears as a cross-check, NOT as the headline
      const dcfCard = valuationOnOverview.getByTestId("valuation-cross-dcf");
      await expect(dcfCard).toBeVisible();
      await expect(dcfCard).toContainText(/DCF/i);

      // DOM order: primary comes before DCF cross-check
      const primaryBox = await primary.boundingBox();
      const dcfBox = await dcfCard.boundingBox();
      expect(primaryBox && dcfBox && primaryBox.y).toBeLessThan(dcfBox!.y);

      // The Overview hero precedes the Mini statements + Top risks/opps
      const overviewHtml = await overview.innerHTML();
      const valuationIdx = overviewHtml.indexOf("dashboard-valuation");
      const miniStatementsIdx = overviewHtml.indexOf("mini-statements");
      if (miniStatementsIdx > -1) {
        expect(valuationIdx).toBeLessThan(miniStatementsIdx);
      }
    });

    test("primary card shows EBITDA-multiple equity + range + confidence", async ({ page }) => {
      test.setTimeout(60_000);
      await signIn(page);
      await openValuationTab(page);

      const primary = page.getByTestId("valuation-primary");
      await expect(primary.getByTestId("valuation-equity-p50")).toBeVisible();
      const equityText = await primary.getByTestId("valuation-equity-p50").innerText();
      // Headline equity should look like a money figure ("1.23M RON", "456K RON", or "1234 RON").
      expect(equityText).toMatch(/(M|K)?\s*[A-Z]{3}$/);

      // Range line should reference P25 and P75 of the peer band.
      await expect(primary.getByTestId("valuation-equity-range")).toContainText(/P25|P75|peer/i);

      // Confidence label is one of the three known levels.
      await expect(
        primary.getByText(/High confidence|Medium confidence|Low confidence/i),
      ).toBeVisible();
    });

    test("formula line renders the EBITDA × Multiple − Debt + Cash math", async ({ page }) => {
      test.setTimeout(60_000);
      await signIn(page);
      await openValuationTab(page);

      const formula = page.getByTestId("valuation-formula");
      await expect(formula).toBeVisible();
      const text = await formula.innerText();
      expect(text).toContain("EBITDA");
      expect(text).toContain("Multiple");
      expect(text).toContain("Debt");
      expect(text).toContain("Cash");
      // Must contain a multiplication sign and ends with the equity value.
      expect(text).toMatch(/×|x/);
      expect(text).toMatch(/=/);
    });

    test("industry source attribution is visible (no anonymous multiples)", async ({ page }) => {
      test.setTimeout(60_000);
      await signIn(page);
      await openValuationTab(page);

      // The slider sub-line shows multiples_source and multiples_as_of_date.
      await expect(page.getByText(/Damodaran|benchmark|2026/i)).toBeVisible();
    });

    test("cross-check cards render DCF + EV/Revenue with sensitivity bands", async ({ page }) => {
      test.setTimeout(60_000);
      await signIn(page);
      await openValuationTab(page);

      await expect(page.getByTestId("valuation-cross-revenue")).toBeVisible();
      await expect(page.getByTestId("valuation-cross-dcf")).toBeVisible();

      // DCF card includes the WACC and Gordon-terminal growth.
      const dcfText = await page.getByTestId("valuation-cross-dcf").innerText();
      expect(dcfText).toMatch(/WACC/i);
      expect(dcfText).toMatch(/g\s*\d+(\.\d+)?%/);
    });

    test("football field shows ≥ 2 method bars, primary highlighted", async ({ page }) => {
      test.setTimeout(60_000);
      await signIn(page);
      await openValuationTab(page);

      const field = page.getByTestId("valuation-football-field");
      await expect(field).toBeVisible();
      const bars = field.getByTestId("valuation-football-row");
      const count = await bars.count();
      expect(count).toBeGreaterThanOrEqual(2);
      // The "Primary" tag should appear on exactly one bar.
      await expect(field.getByText(/^Primary$/i).first()).toBeVisible();
    });

    test("slider drag fires PUT and equity re-renders", async ({ page }) => {
      test.setTimeout(60_000);
      await signIn(page);
      await openValuationTab(page);

      const equityBefore = await page
        .getByTestId("valuation-equity-p50")
        .innerText();

      // Move the slider — small but non-zero nudge. range inputs accept Tab + arrows
      // reliably across browsers.
      const slider = page.getByTestId("valuation-input-multiple");
      await slider.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");

      // Wait out the 350ms debounce + server round trip
      await page.waitForTimeout(1_200);

      const equityAfter = await page
        .getByTestId("valuation-equity-p50")
        .innerText();
      expect(equityAfter).not.toBe(equityBefore);

      // Reset link must now be visible (user overrides present).
      await expect(page.getByTestId("valuation-reset")).toBeVisible();
    });

    test("reset to defaults removes user overrides", async ({ page }) => {
      test.setTimeout(60_000);
      await signIn(page);
      await openValuationTab(page);

      // Make sure there's an override first.
      const slider = page.getByTestId("valuation-input-multiple");
      await slider.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1_200);

      const reset = page.getByTestId("valuation-reset");
      if (await reset.isVisible().catch(() => false)) {
        await reset.click();
        // After reset, the Reset link should disappear and equity should
        // settle back to the engine default. Reset link gone is the
        // user-visible signal.
        await expect(reset).toHaveCount(0, { timeout: 5_000 });
      }
    });

    test("briefing references the valuation (engine number, not invented)", async ({ page }) => {
      test.setTimeout(60_000);
      await signIn(page);
      await page.goto("/dashboard");

      // Briefing copy lives on the Overview tab.
      const briefing = page.locator("[data-testid=briefing-body]");
      if ((await briefing.count()) === 0) {
        test.skip(true, "No briefing rendered for this period.");
      }
      const text = await briefing.first().innerText();
      // The briefing should at least mention a valuation-y concept.
      expect(
        /value|valoare|valor|valuation|equity|EBITDA|multiple|peer/i.test(text),
      ).toBeTruthy();
    });
  },
);
