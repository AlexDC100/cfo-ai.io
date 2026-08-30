// Reproducible capture for the peer-add lane (DOD2 second half + DOD5).
//
// Drives the REAL local stack (vite :5173 + engine :8000) through the
// exact flow a user takes: US tab -> resolve AAPL -> Add as peer ->
// See it in Benchmark. Nothing is stubbed; the AAPL figures on screen
// come from the engine's spine store, which read them out of SEC bytes.
//
//   node design_review/markets/peer-add-r1/capture.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const shot = (page, name) => page.screenshot({ path: join(OUT, name), fullPage: false });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

// 1 — the US tab, before anything is added.
await page.goto(`${BASE}/public-companies?market=us`, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.removeItem("cfo:benchmark-peers:v1"));
await page.reload({ waitUntil: "networkidle" });
await shot(page, "01-us-tab.png");

// 2 — resolve AAPL; the card renders with the peer control.
await page.getByTestId("market-ticker-input-us").fill("AAPL");
await page.getByTestId("market-ticker-submit-us").click();
await page.getByTestId("market-peer-add-button-AAPL").waitFor();
await page.getByTestId("market-peer-add-us-AAPL").scrollIntoViewIfNeeded();
await shot(page, "02-aapl-card-add-as-peer.png");

// 3 — added: check chip + the cohort law stated where the action happened.
await page.getByTestId("market-peer-add-button-AAPL").click();
await page.getByTestId("market-peer-added-AAPL").waitFor();
await page.getByTestId("market-peer-add-us-AAPL").scrollIntoViewIfNeeded();
await shot(page, "03-added-check-chip.png");

// 4 — DOD5, the honest minimum: one foreign peer, its OWN population.
await page.getByTestId("market-peer-open-benchmark-AAPL").click();
await page.getByTestId("public-companies-benchmark-panel").waitFor();
await page.getByTestId("public-companies-benchmark-panel").scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await shot(page, "04-benchmark-us-cohort-n1.png");

// 5 — the same law with a Romanian peer set beside it, so the SPLIT is
//     visible rather than implied. Seeded through the store's own shape
//     because this environment's Romanian peer-add paths need either a
//     loaded workspace period (PeerSuggestRail) or a Nasdaq key
//     (/dashboard/public/:ticker) — see the critique.
await page.evaluate(() => {
  const key = "cfo:benchmark-peers:v1";
  const cur = JSON.parse(localStorage.getItem(key) || "[]");
  for (const [ticker, name, sector] of [
    ["TLV", "Banca Transilvania S.A.", "Financials"],
    ["SNP", "OMV Petrom S.A.", "Energy"],
  ]) {
    cur.push({ ticker, name, sector, exchange: "BVB", currency: "RON",
      marketId: "ro", source: "public", addedAt: new Date().toISOString() });
  }
  localStorage.setItem(key, JSON.stringify(cur));
});
await page.goto(`${BASE}/public-companies?tab=overview`, { waitUntil: "networkidle" });
await page.getByTestId("public-companies-benchmark-panel").scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await shot(page, "05-two-cohorts-ro-and-us.png");

// 6 — the US cohort selected inside that same group.
await page.getByTestId("benchmark-cohort-us|USD|US_GAAP").click();
await page.waitForTimeout(400);
await page.getByTestId("public-companies-benchmark-panel").scrollIntoViewIfNeeded();
await shot(page, "06-us-cohort-selected.png");

// 7 — the peer tray labels a foreign peer with its market.
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
await shot(page, "07-peer-tray-market-chip.png");

await browser.close();
console.log("captured ->", OUT);
