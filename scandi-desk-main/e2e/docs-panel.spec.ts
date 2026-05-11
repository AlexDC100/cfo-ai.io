/**
 * Documents panel — Playwright spec.
 *
 * Covers the full slide-out flow:
 *   - Pill in dashboard header
 *   - Open via click, close via Cmd+D, persistence across reload
 *   - Switch periods (URL updates, KPI repaints, panel stays open)
 *   - Per-document menu (Rename / Download / Re-run / Mark inactive / Delete)
 *   - Soft delete + Restore from Recently deleted
 *   - Narrow viewport backdrop close
 *
 * Same gating as real-e2e.spec.ts: requires a live Supabase project, a
 * working FastAPI backend, ≥2 analyzed periods on the test account, and
 * a sign-in path. Skipped unless E2E_REAL=1 is set so the dev CI doesn't
 * burn API credits accidentally.
 */

import { test, expect } from "@playwright/test";

const REAL = process.env.E2E_REAL === "1";
const TEST_EMAIL = process.env.E2E_EMAIL || "test@cfoai.dev";
const TEST_PASSWORD = process.env.E2E_PASSWORD || "Test1234!";

test.describe(REAL ? "docs panel (real)" : "docs panel (skipped — set E2E_REAL=1 to run)", () => {
  test.skip(!REAL, "Set E2E_REAL=1 + a test account with ≥2 periods uploaded.");

  test("open / close / shortcut / persistence", async ({ page }) => {
    test.setTimeout(60_000);

    // Sign in
    await page.goto("/login");
    await page.getByPlaceholder(/you@company\.com/i).fill(TEST_EMAIL);
    await page.getByPlaceholder(/at least 6 characters|password/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).first().click();
    await expect(page).toHaveURL(/\/dashboard|\/onboarding/, { timeout: 10_000 });

    // If onboarding intercepts, finish it once so subsequent runs go
    // straight to /dashboard.
    if (page.url().includes("/onboarding")) {
      await page.getByRole("radio").first().click();
      await page.getByRole("button", { name: /continue/i }).click();
    }
    await expect(page).toHaveURL(/\/dashboard/);

    // Pill is in the header with a count
    const pill = page.getByTestId("docs-toggle");
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(/docs/i);

    // Open via click
    await pill.click();
    await expect(page.getByTestId("docs-panel")).toBeVisible();
    await expect(page.getByTestId("docs-panel-section-active")).toBeVisible();

    // Close via Cmd+D (or Ctrl+D on Linux/Win — page.keyboard handles both via Meta+D)
    await page.keyboard.press("ControlOrMeta+D");
    await expect(page.getByTestId("docs-panel")).toHaveCount(0);

    // Open via Cmd+D again
    await page.keyboard.press("ControlOrMeta+D");
    await expect(page.getByTestId("docs-panel")).toBeVisible();

    // Persistence: reload page, panel stays open
    await page.reload();
    await expect(page.getByTestId("docs-panel")).toBeVisible();

    // Esc closes
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("docs-panel")).toHaveCount(0);
  });

  test("switch periods updates URL + KPIs in place", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    await page.getByTestId("docs-toggle").click();

    const others = page.getByTestId("docs-panel-section-others");
    test.skip(
      (await others.count()) === 0,
      "Test account needs ≥2 analyzed periods for this test.",
    );

    const initialUrl = page.url();
    const initialRevenue = (await page.getByTestId("kpi-revenue").innerText()).trim();

    // Click the Switch button on the first non-active period
    const targetCard = others.getByTestId("period-card").first();
    await targetCard.getByRole("button", { name: /switch/i }).click();

    // URL changed (period= param swapped) but stayed on /dashboard
    await expect(page).toHaveURL(/\/dashboard\?period=/);
    expect(page.url()).not.toBe(initialUrl);

    // Panel stayed open
    await expect(page.getByTestId("docs-panel")).toBeVisible();

    // KPI revenue updated (or at least re-rendered)
    await expect.poll(
      async () => (await page.getByTestId("kpi-revenue").innerText()).trim(),
      { timeout: 5_000 },
    ).not.toBe(initialRevenue);
  });

  test("per-document menu has all 5 actions + delete moves to recently deleted", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    await page.getByTestId("docs-toggle").click();

    const firstDoc = page.getByTestId("doc-row").first();
    await firstDoc.hover();
    await firstDoc.getByTestId("doc-menu").click();

    for (const item of [/rename/i, /download/i, /re-run/i, /mark.*active|mark.*inactive/i, /delete/i]) {
      await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    }

    // Cancel out so we don't actually delete the prod fixture
    await page.keyboard.press("Escape");

    // To exercise soft-delete + restore safely, this test requires a
    // disposable document — guard with an env flag. If the env says
    // there's a test doc id we can nuke, do the full round-trip.
    const disposableId = process.env.E2E_DISPOSABLE_DOC_ID;
    test.skip(
      !disposableId,
      "Set E2E_DISPOSABLE_DOC_ID to a real document id you don't mind soft-deleting.",
    );

    const target = page.getByTestId("doc-row").filter({ has: page.locator(`text=${disposableId!.slice(0, 8)}`) }).first();
    await target.hover();
    await target.getByTestId("doc-menu").click();
    await page.getByRole("menuitem", { name: /delete/i }).click();
    await page.getByTestId("confirm-delete-doc").click();

    // Appears in Recently deleted
    const deletedSection = page.getByTestId("docs-panel-section-deleted");
    await expect(deletedSection).toBeVisible({ timeout: 5_000 });

    // Restore round-trip
    await deletedSection.getByRole("button", { name: /restore/i }).first().click();
    await expect(deletedSection).toHaveCount(0, { timeout: 5_000 });
  });

  test("inline rename persists across reload", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    await page.getByTestId("docs-toggle").click();

    const firstDoc = page.getByTestId("doc-row").first();
    const originalName = await firstDoc.innerText();
    const newSuffix = ` [renamed-${Date.now() % 1_000_000}]`;

    await firstDoc.hover();
    await firstDoc.getByTestId("doc-menu").click();
    await page.getByRole("menuitem", { name: /rename/i }).click();

    // Type a suffix to the existing name and press Enter
    await page.keyboard.press("End");
    await page.keyboard.type(newSuffix);
    await page.keyboard.press("Enter");

    // Wait for the rename to land
    await expect.poll(
      async () => (await page.getByTestId("doc-row").first().innerText()).includes(newSuffix.trim()),
      { timeout: 5_000 },
    ).toBe(true);

    // Reload — the rename persists
    await page.reload();
    await page.getByTestId("docs-toggle").click(); // panel may need re-open
    await expect.poll(
      async () => (await page.getByTestId("doc-row").first().innerText()),
      { timeout: 5_000 },
    ).toContain(newSuffix.trim());

    // Rename back so subsequent runs see the original
    const renamedRow = page.getByTestId("doc-row").first();
    await renamedRow.hover();
    await renamedRow.getByTestId("doc-menu").click();
    await page.getByRole("menuitem", { name: /rename/i }).click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(originalName.trim());
    await page.keyboard.press("Enter");
  });

  test("narrow viewport overlays with backdrop", async ({ page }) => {
    test.setTimeout(30_000);
    // <1280px → backdrop overlay; clicking backdrop closes
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto("/dashboard");

    await page.getByTestId("docs-toggle").click();
    await expect(page.getByTestId("docs-panel")).toBeVisible();
    await expect(page.getByTestId("docs-panel-backdrop")).toBeVisible();

    // Backdrop click closes
    await page.getByTestId("docs-panel-backdrop").click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId("docs-panel")).toHaveCount(0);
  });

  test("active period card is sticky", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto("/dashboard");
    await page.getByTestId("docs-toggle").click();
    const activeCard = page.getByTestId("docs-panel-section-active");
    await expect(activeCard).toBeVisible();

    // Scroll the panel's scroll container down a lot; the active card
    // should remain in viewport (sticky top-0).
    const panel = page.getByTestId("docs-panel");
    await panel.evaluate((el) => {
      const scroller = el.querySelector(".overflow-y-auto");
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await expect(activeCard).toBeInViewport();
  });
});
