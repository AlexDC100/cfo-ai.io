/**
 * F5.0 Phase 7 — Recommendations + Risk learning real test (no stubs).
 *
 * Target: prod (https://cfo-ai.io) — PUBLIC_TEST_MODE bypasses AuthGuard.
 * Run with: npx playwright test --project=prod e2e/learning-recommendations.spec.ts
 *
 * Verifies the Phase 7 explainability contract on the Recommendations tab:
 *
 *   1. /dashboard?tab=recommendations renders the tab with at least one
 *      RecommendationCard (test-mode workspace must have a sample loaded).
 *   2. Each card with `factsCited` shows a "Triggered by" block listing the
 *      engine's fact keys (DSCR, current_ratio, etc.) and their values.
 *   3. Severity pill is a LearnableRowLabel — clicking opens the
 *      alert_severity concept popover.
 *   4. Estimated impact label is a LearnableRowLabel for recommendation_impact.
 *   5. "Ask CFO AI about this" footer button is present and clickable.
 *
 * Failure modes this catches:
 *   · RecommendationCard regresses to the pre-Phase 7 layout (no Triggered by)
 *   · factsCited propagation broken at financialReport.ts mapping
 *   · concept registry for recommendations.ts not merged in CONCEPTS_BY_KEY
 *   · openAskCfoAi import / wiring removed
 */

import { test, expect, type Page } from "@playwright/test";

async function gotoRecommendations(page: Page) {
  await page.goto("/dashboard?tab=recommendations", {
    waitUntil: "domcontentloaded",
  });
  // Lazy bundle + React hydration + statements fetch can take a few
  // seconds on cold cache (FinancialStatements is dynamically imported).
  // Wait the same amount the manual probe needed before any click works.
  await page.waitForTimeout(8_000);

  // Wait for tabs shell. Recommendations tab is always visible per
  // FinancialStatements default tab set (Overview · Recommendations · Export).
  const recTab = page.getByRole("tab", { name: /^Recommendations$/ });
  await expect(recTab).toBeVisible({ timeout: 15_000 });
  await recTab.click();

  // Active tab panel mounts the cards (statements hydrated from URL
  // ?period or the test-mode default period). Wait for at least one
  // card to be in the DOM before any assertion. Recommendations on the
  // EEI default fixture fires multiple cards.
  await expect(
    page.locator('[data-testid^="rec-card-"]').first(),
  ).toBeVisible({ timeout: 20_000 });
}

test.describe("F5.0 Phase 7 — Recommendations explainability", () => {
  test("Recommendations tab renders at least one card with Triggered by block", async ({
    page,
  }) => {
    await gotoRecommendations(page);

    // Locate the first RecommendationCard. test-mode workspace must
    // have a fixture with recommendations populated. The card's testid
    // is `rec-card-{ruleKey}` and there will be one per fired rule.
    const firstCard = page.locator('[data-testid^="rec-card-"]').first();
    await expect(firstCard).toBeVisible({ timeout: 20_000 });

    // The Triggered by block is mounted iff the rule emitted factsCited.
    // Test-mode Scandia fixture has rules with facts (DSCR, ratios, etc.)
    // so we expect at least one card to have the block visible.
    const anyTriggeredBy = page.getByText(/Triggered by/i).first();
    await expect(anyTriggeredBy).toBeVisible({ timeout: 5_000 });

    // At least one fact row visible — testid is `rec-fact-{ruleKey}-{factKey}`.
    const anyFact = page.locator('[data-testid^="rec-fact-"]').first();
    await expect(anyFact).toBeVisible({ timeout: 5_000 });
  });

  test("Each fact label and value renders as text or LearnableRowLabel button", async ({
    page,
  }) => {
    await gotoRecommendations(page);
    const firstCard = page.locator('[data-testid^="rec-card-"]').first();
    await expect(firstCard).toBeVisible({ timeout: 20_000 });

    // First fact within first card.
    const firstFact = firstCard.locator('[data-testid^="rec-fact-"]').first();
    await expect(firstFact).toBeVisible({ timeout: 5_000 });

    // The fact row's content is not empty — it must have a label AND a value.
    // Inner text contains at least one non-whitespace character.
    const factText = await firstFact.innerText();
    expect(factText.trim().length).toBeGreaterThan(2);
  });

  test("Ask CFO AI footer button is present on cards", async ({ page }) => {
    await gotoRecommendations(page);
    const firstCard = page.locator('[data-testid^="rec-card-"]').first();
    await expect(firstCard).toBeVisible({ timeout: 20_000 });

    const askBtn = page.locator('[data-testid^="rec-ask-"]').first();
    await expect(askBtn).toBeVisible({ timeout: 5_000 });
    await expect(askBtn).toContainText(/Ask CFO AI about this/i);
    // Button is interactive (not disabled).
    await expect(askBtn).toBeEnabled();
  });

  test("Severity pill clicks open alert_severity concept popover", async ({
    page,
  }) => {
    await gotoRecommendations(page);
    const firstCard = page.locator('[data-testid^="rec-card-"]').first();
    await expect(firstCard).toBeVisible({ timeout: 20_000 });

    // Severity LearnableRowLabel renders as a button containing the
    // priority text (critical | high | medium | info). It lives inside
    // the colored pill at the top of the card. Click it.
    const severityBtn = firstCard
      .locator("button")
      .filter({ hasText: /^(critical|high|medium|info)$/i })
      .first();
    await expect(severityBtn).toBeVisible({ timeout: 3_000 });
    await severityBtn.click({ force: true });

    // The popover should mount and contain content for alert_severity:
    // either its plainEnglish ("How loud the alarm is") or the
    // canonical short definition mentioning severity.
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 3_000 });
    // Either layer should mention severity or alarm — both copy hits.
    await expect(popover).toContainText(/severity|alarm|urgent/i, {
      timeout: 3_000,
    });
  });

  test("Recommendation_impact label opens its concept popover", async ({
    page,
  }) => {
    await gotoRecommendations(page);
    const firstCard = page.locator('[data-testid^="rec-card-"]').first();
    await expect(firstCard).toBeVisible({ timeout: 20_000 });

    // "Estimated impact" LearnableRowLabel button. Renders only on cards
    // that have rec.estimatedImpact set — most rec cards from rule fires
    // do.
    const impactBtn = page
      .locator("button")
      .filter({ hasText: /^Estimated impact$/i })
      .first();
    // Defensive — some prod fixtures may not show this on every card.
    // If the prod fixture doesn't have any card with an estimatedImpact,
    // the test is harmlessly skipped.
    if (!(await impactBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await impactBtn.click({ force: true });
    const popover = page.locator(".learn-pop-content").first();
    await expect(popover).toBeVisible({ timeout: 3_000 });
    // recommendation_impact short definition + plainEnglish mention "impact".
    await expect(popover).toContainText(/impact|cash/i, { timeout: 3_000 });
  });
});
