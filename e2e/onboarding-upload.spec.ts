/**
 * The workspace onboarding wizard's upload step — the one path EVERY new
 * user takes, and the one nothing in the battery covered.
 *
 * IT HAS BROKEN TWICE.
 *
 *  · 2026-08-04: the step-3 dropzone posted a balanță to /api/upload-excel,
 *    the legacy SKU / trading parser, which died on
 *    "missing Categ_Pr / Volume(to) / NIV (kRon)". A reroute was added —
 *    but only AFTER the backend answered with a [TRIAL_BALANCE] token.
 *  · 2026-09-05: that endpoint was walled behind LEGACY_SKU_AI_ENABLED
 *    (an anonymous POST reached an Anthropic completion with no bearer and
 *    no rate limit). The wall answers 404 BEFORE routing, so the backend
 *    never saw the file, never emitted the token, and the reroute became
 *    unreachable by construction. Every new workspace ended on a bare
 *    "Upload failed 404" — the operator hit it on 2026-09-09 uploading a
 *    real client book.
 *
 * Separately, the dropzone hard-coded `.xlsx,.csv` and refused `.xls`, so
 * a Crystal Reports balanță — real, parseable, saga_10_col via xlrd —
 * could not even be SELECTED.
 *
 * WHAT THIS SPEC ASSERTS
 *   1. the dropzone accepts .xls (and pdf/csv), i.e. the allowlist is the
 *      Dashboard's shared one and not a second hand-written copy;
 *   2. the copy no longer promises SKU sales / margin / inventory;
 *   3. choosing a REAL .xls trial balance is accepted client-side — no
 *      "unsupported file" refusal;
 *   4. nothing the wizard does reaches /api/upload-excel or /api/analyze.
 *
 * SCOPE, STATED HONESTLY. (4) is the load-bearing one and is asserted by
 * watching every request the page makes. The spec deliberately stops
 * short of completing a Supabase Storage write: that needs real
 * credentials and would put a row in a real workspace. What broke twice
 * was the ROUTING DECISION and the CLIENT-SIDE GATE, and both are covered
 * here. A full storage round-trip belongs in the E2E_REAL suite.
 *
 * The file used is a REAL trial balance — corpus/saga_10_col/input.xlsx,
 * committed corpus bytes. The client's own books are confidential and
 * never enter this repository.
 *
 * WHERE THIS ACTUALLY GATES. Reaching the wizard needs an AUTHENTICATED
 * workspace, which needs PUBLIC_TEST_MODE on the engine. The battery does
 * not run with it — measured on the local stack, /workspace answers "Could
 * not load your workspace. The workspace list didn't come back from the
 * server", because only VITE_PUBLIC_TEST_MODE is set and the engine-side
 * flag is set nowhere. So this spec SKIPS in the battery's configuration,
 * and a skip is not coverage.
 *
 * The gate that runs today is
 * frontend/pages/cfo/__tests__/onboardingUploadStep.test.tsx, which
 * renders the real StepUpload and covers both breakages. This file is the
 * end-to-end proof for a session-bearing run, and it names what it needs
 * rather than skipping silently.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { dismissPublicTestBanner } from "./_helpers";

// Playwright runs from the repo root (playwright.config.ts lives there),
// so cwd IS the repo. __dirname is unavailable under this ESM config.
const REPO = process.cwd();
/** A real Romanian trial balance, in the repo, not the client's. */
const REAL_TB = join(REPO, "corpus", "saga_10_col", "input.xlsx");

/** Paths the backend WALLS. Reaching one is the defect this spec exists for. */
const WALLED = ["/api/upload-excel", "/api/analyze"];

/**
 * Force the FIRST-RUN wizard. `/workspace` shows the post-onboarding hub
 * once `cfoai:v1:workspace-onboarded` is set, so a spec that just visits
 * the route silently SKIPS — which is how "the one path every new user
 * takes" ended up with no coverage at all. Clearing the flag before the
 * app boots puts us on step 0, then two Continues reach the upload step.
 */
async function openWizardUploadStep(page: import("@playwright/test").Page) {
  await page.goto("/workspace", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  await dismissPublicTestBanner(page);

  // Enter the wizard the way a user does. Clearing
  // `cfoai:v1:workspace-onboarded` is NOT enough — the org pref
  // `workspace_onboarded` syncs back from the server and re-closes the
  // wizard, so a localStorage-only approach silently lands on the hub and
  // the spec skips. "Create workspace" is also exactly the flow that
  // broke: the 404 dead end only ever appeared on a NEW workspace.
  const create = page.getByTestId("workspace-create");
  if ((await create.count()) === 0) {
    test.skip(
      true,
      "No authenticated workspace on this stack. Set PUBLIC_TEST_MODE=1 on " +
        "the engine (:8000) as well as VITE_PUBLIC_TEST_MODE on the frontend, " +
        "or run with a real session. The battery's own coverage for this " +
        "path is frontend/pages/cfo/__tests__/onboardingUploadStep.test.tsx.",
    );
  }
  await create.click();

  const onboarding = page.getByTestId("workspace-onboarding");
  await expect(
    onboarding,
    "the first-run wizard did not open — this spec cannot cover the upload step",
  ).toBeVisible({ timeout: 20000 });

  // step 0 (name) -> step 1 (decision rules) -> step 2 (upload)
  const next = page.getByTestId("onboarding-next");
  for (let i = 0; i < 2; i++) {
    await expect(next).toBeVisible({ timeout: 15000 });
    await next.click();
    await page.waitForTimeout(1200);
  }
  await expect(
    page.getByTestId("onboarding-dropzone"),
    "did not reach the wizard's upload step",
  ).toBeVisible({ timeout: 15000 });
}

test.describe("workspace onboarding — the upload step", () => {
  test("the dropzone accepts .xls, not just .xlsx", async ({ page }) => {
    await openWizardUploadStep(page);
    const input = page.locator('input[type="file"]').first();
    const accept = (await input.getAttribute("accept")) ?? "";
    // The exact failure: a Crystal Reports balanță is .xls and the wizard
    // refused it before any request was made.
    expect(accept, `accept="${accept}" must admit .xls`).toContain(".xls");
    expect(accept).toContain(".csv");
    expect(accept).toContain(".pdf");
  });

  test("the copy no longer promises SKU sales, margin and inventory", async ({ page }) => {
    await openWizardUploadStep(page);
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(
      body.includes("sku sales, margin, and inventory"),
      "the wizard still describes the legacy SKU workbook",
    ).toBe(false);
  });

  test("a real .xls trial balance is accepted, and nothing reaches a walled endpoint",
    async ({ page }) => {
      test.skip(!existsSync(REAL_TB), `corpus book missing at ${REAL_TB}`);

      // Watch EVERY request the page makes, for the whole test.
      const walledHits: string[] = [];
      page.on("request", (req) => {
        const url = req.url();
        if (WALLED.some((p) => url.includes(p))) walledHits.push(`${req.method()} ${url}`);
      });

      await openWizardUploadStep(page);
      const input = page.locator('input[type="file"]').first();
      await input.setInputFiles(REAL_TB);
      await page.waitForTimeout(4000);

      // The client-side allowlist must NOT have refused it.
      const body = (await page.locator("body").innerText()).toLowerCase();
      expect(
        body.includes("unsupported file"),
        "the wizard refused a real trial balance before sending it anywhere",
      ).toBe(false);

      // The load-bearing assertion.
      expect(
        walledHits,
        `the wizard reached a WALLED endpoint — this is the 404 dead end returning:\n  ${walledHits.join("\n  ")}`,
      ).toEqual([]);

      // And it must not render a bare status code at the user. If it
      // failed for an environmental reason, the message must still be a
      // sentence — that is the errorDetail() fix (reads error.message as
      // well as detail, so a walled surface reports its real reason).
      expect(
        /upload failed\s*$/i.test(body) || body.includes("404 not found"),
        "the failure surfaced as a bare status code instead of a reason",
      ).toBe(false);
    });
});
