#!/usr/bin/env node
/**
 * The social-share image (public/og/homepage.png), built from the landing's
 * own hero copy.
 *
 * WHY THIS EXISTS
 *   The image every link preview shows was a hand-taken screenshot of an
 *   older hero. It read "100+ ratios" while the page said 22, and it sold
 *   "public companies your size". Its alt text described a tagline the
 *   picture did not contain. A screenshot cannot be gated: the text is
 *   pixels.
 *
 *   So the image now has a generator, and the generator reads the SAME
 *   strings the page renders (landingStrings[en].hero, tokens filled).
 *   Beside the PNG it writes public/og/homepage.json — the exact text
 *   drawn — and the gate `public-claims` compares that record with the
 *   current landing strings, so the picture cannot say something the
 *   page stopped saying.
 *
 * Run:   node scripts/build_og_image.mjs
 * Needs: a Chromium for Playwright (`npx playwright install chromium`).
 *
 * The PNG is NOT byte-reproducible across machines (font rasterisation);
 * the JSON record is, and it is the part under test.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

// fileURLToPath, not URL.pathname — the repo path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_PNG = join(ROOT, "public/og/homepage.png");
const OUT_JSON = join(ROOT, "public/og/homepage.json");

const font = (rel) => pathToFileURL(join(ROOT, "node_modules", rel)).href;

async function heroStrings() {
  const server = await createServer({
    configFile: join(ROOT, "vitest.config.ts"),
    root: ROOT,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const mod = await server.ssrLoadModule("/frontend/pages/cfo/landingStrings.ts");
    const L = mod.landingStringsFor("en");
    return {
      eyebrow: L.hero.eyebrow,
      headline: [L.hero.t1, L.hero.thl, L.hero.t2],
      body: L.hero.body,
    };
  } finally {
    await server.close();
  }
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cardHtml(h) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  @font-face { font-family: "Instrument Serif"; font-weight: 400;
    src: url("${font("@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2")}") format("woff2"); }
  @font-face { font-family: "Inter"; font-weight: 100 900;
    src: url("${font("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")}") format("woff2"); }
  @font-face { font-family: "JetBrains Mono"; font-weight: 500;
    src: url("${font("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2")}") format("woff2"); }
  html, body { margin: 0; width: 1200px; height: 630px; }
  body { background: #070C0A; color: #F5F5F5; font-family: "Inter", sans-serif;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 56px 72px; box-sizing: border-box;
    background-image: radial-gradient(ellipse at 85% 0%, rgba(75,191,168,.18), transparent 55%); }
  .top { display: flex; align-items: center; gap: 14px; font-size: 22px; font-weight: 600; }
  .top b { color: #4BBFA8; font-weight: 600; }
  .eyebrow { font-family: "JetBrains Mono", monospace; font-size: 15px; letter-spacing: .18em;
    text-transform: uppercase; color: #ABABAB; display: flex; align-items: center; gap: 12px; }
  .eyebrow i { width: 8px; height: 8px; background: #4BBFA8; display: inline-block; }
  h1 { margin: 20px 0 0; font-family: "Instrument Serif", serif; font-weight: 400;
    font-size: 70px; line-height: 1.04; letter-spacing: -.02em; max-width: 1000px; }
  h1 span { color: #4BBFA8; }
  p { margin: 24px 0 0; font-size: 21px; line-height: 1.5; color: #ABABAB; max-width: 980px; }
  .foot { font-family: "JetBrains Mono", monospace; font-size: 15px; letter-spacing: .08em; color: #8C8C8C; }
</style></head>
<body>
  <div class="top">
    <svg width="34" height="34" viewBox="0 0 64 64" aria-hidden="true"><path d="M 30 4 L 4 20 L 4 44 L 30 60 L 30 50 L 14 41 L 14 23 L 30 14 Z" fill="#4BBFA8"></path><path d="M 38 14 L 60 60 L 48 60 L 38 38 Z" fill="#F4F6F8"></path><rect x="34" y="34" width="14" height="3" fill="#F4F6F8"></rect></svg>
    <span>CFO <b>AI</b></span>
  </div>
  <div>
    <div class="eyebrow"><i></i>${esc(h.eyebrow)}</div>
    <h1>${esc(h.headline[0])}<span>${esc(h.headline[1])}</span>${esc(h.headline[2])}</h1>
    <p>${esc(h.body)}</p>
  </div>
  <div class="foot">cfo-ai.io</div>
</body></html>`;
}

const hero = await heroStrings();
const dir = mkdtempSync(join(tmpdir(), "og-"));
const htmlPath = join(dir, "card.html");
writeFileSync(htmlPath, cardHtml(hero), "utf8");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: OUT_PNG, type: "png" });
} finally {
  await browser.close();
}

const record = {
  about: "The exact text drawn on public/og/homepage.png. Written by scripts/build_og_image.mjs from landingStrings[en].hero; gate public-claims compares it with the current landing strings.",
  generated_by: "scripts/build_og_image.mjs",
  source: "frontend/pages/cfo/landingStrings.ts → landingStringsFor('en').hero",
  size: { width: 1200, height: 630 },
  text: {
    wordmark: "CFO AI",
    eyebrow: hero.eyebrow,
    headline: hero.headline.join(""),
    body: hero.body,
    footer: "cfo-ai.io",
  },
};
writeFileSync(OUT_JSON, JSON.stringify(record, null, 2) + "\n", "utf8");
console.log(`OG IMAGE: written ${OUT_PNG}`);
console.log(`OG IMAGE: text record ${OUT_JSON}`);
console.log(`  headline: ${record.text.headline}`);
