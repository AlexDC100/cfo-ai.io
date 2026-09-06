// LR-LIVE — READ-ONLY, UNAUTHENTICATED probe of the PUBLIC surfaces on the
// deployed site. Run with `--project=prod`.
//
// RULES THIS SPEC OBEYS, AND WHY
// ==============================
// Everything here is a GET and a read. It never signs up, never signs in,
// never types a credential, never submits a form, never enters card data.
// Production billing is on a LIVE Stripe key, so a stray submit is real
// money; and the one prior incident in this repo's history that cost real
// cleanup (8,498 junk organizations) came from pointing a writing client
// at production. So: navigation and assertions only.
//
// The authenticated journeys are NOT probed here. They are evidenced
// hermetically against local dev servers; the live matrix cells for them
// read BLOCKED until a QA account exists.
//
// WHAT EACH TEST REDS ON (Engine Book TC-11) is stated on the test.

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

/** Console errors + uncaught page errors, collected for the whole page life. */
function collectConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/**
 * Console noise that is NOT the app's own defect. Kept deliberately short
 * and specific: a broad filter here would let a real error through, which
 * is the whole failure mode this gate exists to catch.
 */
const IGNORABLE = [
  // Third-party network blocked by an ad-blocker / privacy extension in the
  // runner's profile — not a page defect.
  /net::ERR_BLOCKED_BY_CLIENT/,
  // Favicon 404s are cosmetic and never break a surface.
  /favicon\.ico/,
];

function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !IGNORABLE.some((re) => re.test(e)));
}

for (const vp of VIEWPORTS) {
  test.describe(`live public surfaces @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    // Reds on: any public marketing/auth page that fails to load, renders a
    // title-less document, or logs a console error on first paint.
    for (const path of ["/", "/pricing", "/login", "/signup", "/contact-sales"]) {
      test(`${path} loads clean`, async ({ page }, testInfo) => {
        const errors = collectConsole(page);
        const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
        expect(resp?.status(), `${path} HTTP status`).toBeLessThan(400);

        // The SPA needs a beat to mount before "is anything on screen" holds.
        await page.waitForLoadState("networkidle").catch(() => {});
        const title = await page.title();
        expect(title.trim().length, `${path} has a <title>`).toBeGreaterThan(0);

        const bodyText = (await page.locator("body").innerText()).trim();
        expect(bodyText.length, `${path} rendered something`).toBeGreaterThan(40);

        await page.screenshot({
          path: testInfo.outputPath(`live${path.replace(/\//g, "_")}-${vp.name}.png`),
          fullPage: false,
        });

        expect(realErrors(errors), `${path} console errors`).toEqual([]);
      });
    }
  });
}

// Reds on: a missing or empty og:title / og:description / og:image on the
// home page — the three tags every social and chat preview reads. A share
// with no card is a launch-visible defect, not a nicety.
test("home page carries the OG tags a share preview needs", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  for (const prop of ["og:title", "og:description", "og:image"]) {
    const content = await page
      .locator(`meta[property="${prop}"]`)
      .first()
      .getAttribute("content");
    expect(content?.trim() ?? "", `meta ${prop}`).not.toBe("");
  }
});

// Reds on: any in-app link on the home page whose href resolves to a 4xx/5xx.
// Crawls only same-origin links; external links are somebody else's uptime.
test("every same-origin link on the home page resolves", async ({ page, request }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const hrefs = await page.$$eval("a[href]", (as) =>
    as.map((a) => (a as HTMLAnchorElement).href),
  );
  const origin = new URL(page.url()).origin;
  const sameOrigin = [...new Set(hrefs)]
    .filter((h) => h.startsWith(origin))
    // Hash-only links are in-page anchors, not navigations.
    .filter((h) => new URL(h).pathname !== "/" || !h.includes("#"));

  const broken: string[] = [];
  for (const href of sameOrigin) {
    const r = await request.get(href, { maxRedirects: 5 });
    if (r.status() >= 400) broken.push(`${href} → ${r.status()}`);
  }
  expect(broken, "broken same-origin links on /").toEqual([]);
});

// Reds on: a legal document that does not resolve at its own URL.
//
// THIS TEST IS EXPECTED TO FAIL ON THE CURRENT DEPLOY, and that failure IS
// the finding: before the LegalPage routes shipped, the three documents
// existed only as sections of the marketing page reached by a client-side
// hash (`/#/legal`), so `/privacy` fell through the SPA to the catch-all.
// After deploy it should pass. Do not weaken it to make the current deploy
// green — that would pin the defect as the law.
test("each legal document resolves at its own URL", async ({ page }) => {
  for (const path of ["/privacy", "/terms", "/cookies"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const legal = page.locator('[data-testid="legal-page"]');
    await expect(legal, `${path} renders the legal page`).toHaveCount(1);
  }
});

// Reds on: an in-app surface outside the launch scope being reachable and
// rendering its real screen to an anonymous visitor. /public-companies is
// the one such route that is auth-optional, so it is the one an anonymous
// probe can check. PendingState (or a redirect to sign-in) is the pass.
test("public-companies is not a working screen for an anonymous visitor", async ({ page }) => {
  await page.goto("/public-companies", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const pending = await page.locator('[data-testid="pending-state"]').count();
  const onLogin = /\/login|\/signup/.test(new URL(page.url()).pathname);
  expect(
    pending > 0 || onLogin,
    "expected PendingState or a bounce to sign-in; got the live market surface",
  ).toBeTruthy();
});
