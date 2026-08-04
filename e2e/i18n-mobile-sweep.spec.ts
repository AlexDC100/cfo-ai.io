// i18n + mobile sweep (2026-08-04) — walks every page at 4 viewport widths
// in BOTH product languages and asserts, per page:
//   1. ZERO wrong-language words in the rendered DOM
//   2. ZERO horizontal overflow (no page-level horizontal scrollbar)
// Also captures a labeled screenshot of every combination into
// e2e/artifacts/sweep/ for the change report.
//
// Two run modes (the app's public/authed split):
//   SWEEP_MODE=public (default) — dev server with test mode OFF; walks
//     the logged-out pages: / , /pricing , /login , /signup , /404.
//   SWEEP_MODE=authed — dev server with VITE_PUBLIC_TEST_MODE=1 (and the
//     engine running with PUBLIC_TEST_MODE=1); walks the authed app.
//
// Wrong-language detection is wordlist-based, not diacritics-based: the
// EN copy legitimately contains Romanian document names ("bilanț,
// balanță") and the RO copy legitimately keeps brand/product terms
// ("CFO AI", "SAGA", "XLSX"). The lists below name words that only ever
// appear in UI chrome — if one shows up while the other language is
// active, a component skipped the translation system.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "fs";

const MODE = process.env.SWEEP_MODE === "authed" ? "authed" : "public";

const WIDTHS = [375, 390, 768, 1280] as const;
const LANGS = ["en", "ro"] as const;

const PUBLIC_PAGES: Record<string, string> = {
  landing: "/",
  pricing: "/pricing",
  login: "/login",
  signup: "/signup",
  notfound: "/definitely-not-a-page-404",
};

const AUTHED_PAGES: Record<string, string> = {
  dashboard: "/dashboard",
  products: "/products",
  settings: "/settings",
  benchmark: "/benchmark",
  scenarios: "/dashboard/scenarios",
  variance: "/dashboard/variance",
  workspace: "/workspace",
  chat: "/chat",
};

// Words that must NEVER appear when Romanian is active. Chrome-level
// English only — no brand names, no format names, no proper nouns.
const EN_FORBIDDEN = [
  "Source files",
  "Replace or add",
  "Drop your trial balance",
  "Download",
  "Loading",
  "Collapse sidebar",
  "Expand sidebar",
  "Sign out",
  "Sign in",
  "Settings",
  "Notifications",
  "Previous month",
  "Next month",
  "Current plan",
  "Most popular",
  "start a 7-day free trial",
  "Financial analysis",
  "Example trial balances",
  "Fictional data",
  "Start from the official template",
  "the full financial picture",
  "Every statement rebuilt",
  "No workspace loaded",
  "Learning mode",
  "Disclaimer",
  "Page not found",
];

// Words that must NEVER appear when English is active.
const RO_FORBIDDEN = [
  "Setări",
  "Deconectare",
  "Autentificare",
  "Încarcă",
  "Încărcați",
  "Tablou de bord",
  "Luna anterioară",
  "Luna următoare",
  "Spații de lucru",
  "Companii publice",
  "balanța de verificare aici",
  "Planul curent",
  "Cel mai popular",
  "Precizări legale",
  "Restrânge bara",
  "Fișiere sursă",
  "Date fictive",
  "imaginea financiară completă",
];

const SHOT_DIR = "e2e/artifacts/sweep";

async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - window.innerWidth);
  });
}

/** Elements wider than the viewport — named, for actionable failures. */
async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const bad: string[] = [];
    document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1) && r.width > 40) {
        const cls = (el.className || "").toString().slice(0, 60);
        bad.push(`${el.tagName.toLowerCase()}.${cls} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    });
    return bad.slice(0, 8);
  });
}

async function dismissChrome(page: Page) {
  // Cookie banner (landing) — reject optional, once per storage state.
  const reject = page.getByRole("button", { name: /Reject optional|Refuz/i });
  if (await reject.isVisible({ timeout: 500 }).catch(() => false)) {
    await reject.click();
  }
  // Test-mode banner — session-scoped dismissal so it doesn't cover the header.
  await page.evaluate(() => {
    try { sessionStorage.setItem("cfo:test-mode-banner-dismissed:v1", "1"); } catch { /* ok */ }
  });
}

test.describe(`sweep (${MODE})`, () => {
  test.setTimeout(300_000);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const pages = MODE === "authed" ? AUTHED_PAGES : PUBLIC_PAGES;

  for (const lang of LANGS) {
    for (const [name, path] of Object.entries(pages)) {
      test(`${name} · ${lang}`, async ({ page }) => {
        const failures: string[] = [];
        // ?lang= is the highest-priority language signal in useLanguage().
        const sep = path.includes("?") ? "&" : "?";
        await page.goto(`${path}${sep}lang=${lang}`, { waitUntil: "networkidle" });
        await dismissChrome(page);
        // Settle fonts/async content; then re-settle after banner dismissal.
        await page.waitForTimeout(800);

        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: width < 700 ? 812 : 900 });
          await page.waitForTimeout(350);

          // 1 — horizontal overflow
          const overflow = await horizontalOverflow(page);
          if (overflow > 1) {
            const els = await overflowingElements(page);
            failures.push(
              `[${width}px] horizontal overflow ${overflow}px — ${els.join(" | ") || "(no single element wider than viewport)"}`,
            );
          }

          // 2 — wrong-language words
          const text = await pageText(page);
          const forbidden = lang === "ro" ? EN_FORBIDDEN : RO_FORBIDDEN;
          for (const word of forbidden) {
            if (text.includes(word)) {
              failures.push(`[${width}px] wrong-language word visible: "${word}"`);
            }
          }

          // 3 — raw untranslated keys leaking into the DOM (a t() call
          // whose key is missing renders the key path itself).
          const rawKey = text.match(
            /\b(?:dash|files|tmpl|productsX|authX|pricingX|notFound|ws|chatX|panels|scan|tabs|topbar|account|sidebar)\.[a-zA-Z][a-zA-Z0-9_.]+/,
          );
          if (rawKey) {
            failures.push(`[${width}px] raw i18n key visible: "${rawKey[0]}"`);
          }

          // Screenshot the two key widths for the report.
          if (width === 390 || width === 1280) {
            await page.screenshot({
              path: `${SHOT_DIR}/${MODE}-${name}-${lang}-${width}.png`,
              fullPage: width === 1280,
            });
          }
        }

        expect(failures, failures.join("\n")).toEqual([]);
      });
    }
  }
});
