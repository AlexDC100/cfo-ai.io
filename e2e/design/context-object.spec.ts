/**
 * THE INSTRUMENT — gate D11: the context object.
 *
 * Every authenticated screen must anchor the user in workspace · period.
 * The design brief gives the shell lane a single switcher for that job;
 * this gate coordinates on data-testid="context-object".
 *
 * The shell lane was NOT explicitly told to add that testid, so this
 * spec probes for it: when present, it must be visible on every authed
 * route; when absent, we assert the unambiguous half of D11 instead —
 * NO visible UUID anywhere in the page text (raw ids are the failure
 * mode the context object exists to replace). The testid gap is
 * reported via a test annotation either way so the wave coordinator
 * can close the loop with the shell lane.
 *
 * Run: npx playwright test e2e/design/context-object.spec.ts
 */
import { test, expect } from "@playwright/test";
import { dismissPublicTestBanner } from "../_helpers";

// Authed routes only — "/" is marketing and carries no workspace context.
const AUTHED_ROUTES = [
  "/dashboard",
  "/chat",
  "/products",
  "/public-companies",
  "/dashboard/scenarios",
  "/dashboard/variance",
  "/benchmark",
  "/settings",
  "/workspace",
];

// The probe from the brief: any visible UUID fragment is a failure.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}/i;

const SETTLE_MS = 8000;

// NOT serial: every route must report even when one fails.
test.describe("D11 context object — workspace·period anchor, no raw ids", () => {
  test.setTimeout(60_000);

  for (const route of AUTHED_ROUTES) {
    test(`context anchored: ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(SETTLE_MS);
      await dismissPublicTestBanner(page);

      const contextObject = page.getByTestId("context-object");
      const hasContextObject = (await contextObject.count()) > 0;

      if (hasContextObject) {
        await expect(contextObject.first()).toBeVisible();
      } else {
        test.info().annotations.push({
          type: "d11-testid-gap",
          description:
            `${route}: data-testid="context-object" not in DOM — shell lane has not shipped the switcher testid; falling back to the no-visible-UUID assertion`,
        });
      }

      // The unambiguous half of D11 holds regardless: no visible UUID.
      // innerText excludes display:none content, so hidden state stores
      // and script tags don't false-positive.
      const visibleText = await page.evaluate(() => document.body.innerText);
      const match = visibleText.match(UUID_RE);
      expect(
        match,
        `visible UUID fragment "${match?.[0]}" on ${route} — raw ids must never render`,
      ).toBeNull();
    });
  }
});
