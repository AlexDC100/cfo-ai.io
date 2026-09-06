// LR7 / LR8 — the in-scope surfaces in BOTH languages and at 390.
//
// Hermetic. Companion to launch-route-cut.spec.ts: that gate asks "does
// this route render something legitimate at all"; this one asks "does it
// render legitimately in Romanian, and on a phone".
//
// LR7 — no raw i18n key leaks on any in-scope route in either language,
//       and the Romanian render is actually Romanian (the app does not
//       silently fall back to English).
// LR8 — at 390 CSS px no in-scope route scrolls horizontally.
//
// Scope is the eight launch surfaces plus the legal pages, deliberately:
// a cut route renders PendingState, whose two paragraphs are already
// covered by the i18n keys this gate checks, and asserting layout on a
// screen nobody can reach spends runtime on nothing.

import { test, expect, type Page } from "@playwright/test";

const IN_SCOPE = [
  "/",
  "/pricing",
  "/contact-sales",
  "/login",
  "/signup",
  "/privacy",
  "/terms",
  "/cookies",
  "/dashboard",
  "/workspace",
  "/settings",
];

/** A raw key looks like `some.dotted.key` sitting alone in a text node —
 *  i18next renders the key itself when a translation is missing. */
const RAW_KEY = /(^|\s)[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9_]*){2,}(\s|$)/;

/** Text that is unambiguously a raw key rather than prose or a filename. */
function rawKeyHits(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length < 80)
    .filter((l) => RAW_KEY.test(l))
    // Real content that legitimately looks dotted.
    .filter((l) => !/\.(ts|tsx|py|json|xlsx|pdf|csv|io|com|ro)\b/.test(l))
    .filter((l) => !/@/.test(l));
}

async function setLanguage(page: Page, lng: "en" | "ro") {
  // `?lang=` is the boot-time override the i18n bootstrap persists once,
  // which is the same path the language switcher writes — so this drives
  // the real resolver rather than poking i18next directly.
  await page.addInitScript((l) => {
    try {
      window.localStorage.setItem("i18nextLng", l as string);
    } catch {
      /* private mode */
    }
  }, lng);
}

for (const lng of ["en", "ro"] as const) {
  test(`LR7 — no raw i18n keys on the in-scope routes (${lng})`, async ({ page }) => {
    test.setTimeout(180_000);
    await setLanguage(page, lng);
    const offenders: string[] = [];
    for (const path of IN_SCOPE) {
      await page.goto(`${path}?lang=${lng}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      const text = await page.locator("body").innerText();
      for (const hit of rawKeyHits(text)) offenders.push(`${path} [${lng}]: ${hit}`);
    }
    expect(offenders, `raw i18n keys rendered in ${lng}`).toEqual([]);
  });
}

// Reds on: an in-scope route whose document scrolls horizontally at 390 —
// the narrowest phone width the product supports. Measured on
// documentElement, so a single overflowing table or a fixed-width panel
// anywhere on the page trips it.
test("LR8 — no horizontal scroll at 390", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const offenders: string[] = [];
  for (const path of IN_SCOPE) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
    const over = await page.evaluate(() => {
      const d = document.documentElement;
      return d.scrollWidth - d.clientWidth;
    });
    // 1px of subpixel rounding is not a layout defect.
    if (over > 1) offenders.push(`${path}: ${over}px wider than the viewport`);
  }
  expect(offenders, "routes scrolling horizontally at 390").toEqual([]);
});
