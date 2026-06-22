/**
 * Golden-path spec — Step 5 of the FIX-NOW prompt.
 *
 * Adaptation note: the spec as written assumed a seeded `demo@cfoai.dev` /
 * `Test1234!` Supabase account for sign-in. This build doesn't have that
 * seed yet (real Supabase auth, no fixture). We use the equivalent
 * AuthCard "Continue with demo data" button which authenticates instantly
 * via the same `useAuth().enterDemo()` call the rest of the demo-mode
 * flow uses — same observable post-auth state (lands on /dashboard with
 * demo workspace active). When the seeded account lands (Phase G), swap
 * the four lines marked "AUTH-DEMO ADAPTATION" for the email/password
 * fill described in the original spec.
 */

import { test, expect, type Page } from "@playwright/test";

/**
 * Pick a sample regardless of State A vs State B. State A shows the picker
 * directly in the right-rail panel; State B exposes the same options behind
 * the [Replace ▾] dropdown trigger. Both surfaces use the same
 * `sample-pick-<id>` testid so the selector below is single-shape.
 */
async function pickSample(page: Page, id: string) {
  // If we're on State B, the picker is hidden inside Replace ▾ — open it.
  const replaceBtn = page.getByTestId("replace-period");
  if (await replaceBtn.isVisible().catch(() => false)) {
    await replaceBtn.click();
  }
  await page.getByTestId(`sample-pick-${id}`).click();
  await expect(page).toHaveURL(new RegExp(`period=${id}`));
}

test("Dashboard is financial-first, not inventory-first", async ({ page }) => {
  await page.goto("/");

  // ── AUTH-DEMO ADAPTATION ─────────────────────────────────────────────
  // Original: click Sign-in link, fill email + password, submit.
  // Adapted:  click the "Continue with demo data" button on AuthCard.
  await page.getByTestId("auth-continue-demo").first().click();

  // GATE 1: lands on /dashboard
  await expect(page).toHaveURL(/\/dashboard/);

  // GATE 1: sidebar order (locked per latest fix prompt)
  const items = await page.locator('[data-testid^="sidebar-"]').allInnerTexts();
  expect(items.slice(0, 8).map((s) => s.trim())).toEqual([
    "Dashboard",
    "Financial Statements",
    "Cash",
    "Profit",
    "Products",
    "Decisions",
    "Alerts",
    "Settings",
  ]);
  expect(items).not.toContain("Reports");
  expect(items).not.toContain("Today");

  // ── Load (redacted sample 1) via the Statements sample picker ─────────────
  await page.getByTestId("sidebar-statements").click();
  await pickSample(page, "eei");

  // ── GATE 2: Dashboard hero is financial, not inventory ───────────────
  await page.getByTestId("sidebar-dashboard").click();
  await expect(page).toHaveURL(/\/dashboard/);

  const heroText = await page.getByTestId("dashboard-hero").innerText();
  // Must NOT contain inventory language
  expect(heroText).not.toMatch(/inventory|tying up|trapped/i);
  // Must contain financial language
  expect(heroText).toMatch(/revenue|EBITDA|margin|leverage|cash/i);

  // GATE 2: KPI Row 1 labels — exact order
  const row1Labels = await page
    .locator('[data-testid="dashboard-kpi-row-1"] [data-testid="kpi-label"]')
    .allInnerTexts();
  expect(row1Labels.map((s) => s.trim().toLowerCase())).toEqual([
    "revenue",
    "ebitda",
    "net income",
    "total debt",
  ]);

  // GATE 2: KPI Row 2 labels — must include ROIC, Free Cash Flow, Cash
  const row2Labels = await page
    .locator('[data-testid="dashboard-kpi-row-2"] [data-testid="kpi-label"]')
    .allInnerTexts();
  const row2 = row2Labels.map((s) => s.trim().toLowerCase());
  expect(row2).toContain("roic");
  expect(row2).toContain("free cash flow");
  expect(row2).toContain("cash");

  // GATE 2: NO SKU names on Dashboard for (sample 1)
  const dashboardBody = await page.getByTestId("dashboard-body").innerText();
  for (const sku of ["SOMON", "MACROU", "OTET", "PET FOOD", "PROD-A100", "PROD-B300"]) {
    expect(dashboardBody).not.toContain(sku);
  }

  // GATE 2: NO decision-bucket grid on Dashboard
  await expect(page.getByTestId("decision-bucket-liquidate")).toHaveCount(0);
  await expect(page.getByTestId("decision-bucket-watch")).toHaveCount(0);

  // ── GATE 3: SKU/decision content on Products page ((sample 2)) ──────────
  await page.getByTestId("sidebar-statements").click();
  await pickSample(page, "fmcg");
  await page.getByTestId("sidebar-products").click();
  // All six bucket cards present
  for (const b of ["liquidate", "fix", "reduce", "watch", "scale", "protect"] as const) {
    await expect(page.getByTestId(`decision-bucket-${b}`)).toBeVisible();
  }

  // ── GATE 4: Data flows downward — same revenue across pages ──────────
  await page.getByTestId("sidebar-dashboard").click();
  const dashRev = await page.getByTestId("kpi-revenue").innerText();
  expect(dashRev).not.toMatch(/^(—|RON 0|EUR 0|0)$/);

  // Same revenue on Profit
  await page.getByTestId("sidebar-profit").click();
  const profitRev = await page.getByTestId("kpi-revenue").innerText();
  // Profit shows just the number; Dashboard adds " ↑ X% YoY" — compare prefix.
  const dashHeadline = dashRev.split("\n").slice(0, 2).join(" ").trim();
  const profitHeadline = profitRev.split("\n").slice(0, 2).join(" ").trim();
  expect(profitHeadline).toBe(dashHeadline);

  // Cash has data
  await page.getByTestId("sidebar-cash").click();
  const cashTrapped = await page.getByTestId("kpi-cash-trapped").innerText();
  expect(cashTrapped).not.toMatch(/^(—|RON 0|EUR 0|0)$/);

  // Decisions has at least one recommendation
  await page.getByTestId("sidebar-decisions").click();
  await expect(page.getByTestId("recommendation-card").first()).toBeVisible();

  // Alerts has at least one alert
  await page.getByTestId("sidebar-alerts").click();
  await expect(page.getByTestId("alert-card").first()).toBeVisible();

  // Same revenue back on Statements
  await page.getByTestId("sidebar-statements").click();
  const stmtRev = await page.getByTestId("kpi-revenue").innerText();
  const stmtHeadline = stmtRev.split("\n").slice(0, 2).join(" ").trim();
  expect(stmtHeadline).toBe(dashHeadline);

  // ── GATE 4: industry-aware briefings differ across companies ─────────
  await page.getByTestId("sidebar-statements").click();
  await pickSample(page, "eei");
  await page.getByTestId("sidebar-dashboard").click();
  const eeiBriefing = await page.getByTestId("cfo-briefing").innerText();
  expect(eeiBriefing.toLowerCase()).toMatch(/real estate|imobiliar|commercial property/);

  await page.getByTestId("sidebar-statements").click();
  await pickSample(page, "fmcg");
  await page.getByTestId("sidebar-dashboard").click();
  const scandiaBriefing = await page.getByTestId("cfo-briefing").innerText();
  expect(scandiaBriefing.toLowerCase()).toMatch(/fmcg|distribut|consumer goods|food|inventory/);

  expect(eeiBriefing).not.toBe(scandiaBriefing);
});
