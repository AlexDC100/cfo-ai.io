#!/usr/bin/env node
/**
 * The public sample's REPORT — the product's own export of the fictional
 * book, as HTML and as PDF.
 *
 * Second half of `scripts/build_public_sample.py` (which runs it). The
 * first half carries the fictional trial balances through the real engine
 * and writes the three served documents under public/sample/; this half
 * hands them to the product's own report builder and renderer:
 *
 *   served documents  ->  frontend/lib/publicSampleReport.ts
 *                         (`ratioSurfacesOf` + `buildReportHtml`, the Export
 *                         tab's own call, loaded through Vite SSR)
 *                     ->  public/sample/sample_report_fy2025.html
 *                     ->  services/pdf/render.mjs on headless Chromium
 *                     ->  public/sample/sample_report_fy2025.pdf
 *
 * NO CLOCK. The report prints "Report generated: <date>"; the date is the
 * sample's `as_of` (scripts/public_sample_config.json), not today's, so a
 * rebuild on another day produces the same bytes.
 *
 *   node scripts/build_public_sample_report.mjs                write both
 *   node scripts/build_public_sample_report.mjs --check        compare, write nothing
 *   node scripts/build_public_sample_report.mjs --no-pdf       HTML only
 *   node scripts/build_public_sample_report.mjs --dir <path>   another directory
 *
 * `--check` holds the HTML to the committed bytes. The PDF is held to its
 * page count and its TEXT LAYER (read back out of the bytes): a PDF's
 * bytes depend on the Chromium that printed it, its text does not.
 *
 * Requires a Chromium for the PDF: `npx playwright install chromium-headless-shell`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

// fileURLToPath, not URL.pathname — the repo path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const REPORT_HTML = "sample_report_fy2025.html";
export const REPORT_PDF = "sample_report_fy2025.pdf";
const SERVED_CURRENT = "served_period_fy2025.json";
const SERVED_PRIOR = "served_period_fy2024.json";
const SERVED_COMPARATIVES = "served_comparatives_fy2025_vs_fy2024.json";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const CHECK = process.argv.includes("--check");
const NO_PDF = process.argv.includes("--no-pdf");
const DIR = argValue("--dir") ?? join(ROOT, "public/sample");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const CONFIG = readJson(join(ROOT, "scripts/public_sample_config.json"));

/** Run `fn` with `new Date()` / `Date.now()` pinned to the sample's as-of
 *  day (noon UTC, so every timezone prints the same calendar date). */
function withFixedClock(asOf, fn) {
  const RealDate = Date;
  const fixed = RealDate.parse(`${asOf}T12:00:00Z`);
  if (!Number.isFinite(fixed)) throw new Error(`as_of is not a date: ${JSON.stringify(asOf)}`);
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

async function loadFromRepo() {
  const server = await createServer({
    configFile: join(ROOT, "vitest.config.ts"),
    root: ROOT,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
  });
  try {
    globalThis.__dirname = join(ROOT, "frontend/lib/__tests__");
    const builder = await server.ssrLoadModule("/frontend/lib/publicSampleReport.ts");
    const reader = await server.ssrLoadModule("/frontend/lib/__tests__/pdfText.ts");
    const current = readJson(join(DIR, SERVED_CURRENT));
    const prior = readJson(join(DIR, SERVED_PRIOR));
    const comparatives = readJson(join(DIR, SERVED_COMPARATIVES));
    const html = withFixedClock(CONFIG.as_of, () =>
      builder.sampleReportHtml(current, prior, comparatives),
    );
    return {
      html,
      company: current.statements.companyName,
      period: current.statements.periodLabel,
      pageTexts: reader.pageTexts,
    };
  } finally {
    delete globalThis.__dirname;
    await server.close();
  }
}

/** The PDF's text, page by page, with runs of whitespace folded — what a
 *  reader's viewer shows, independent of the Chromium that printed it. */
function textLayer(pageTexts, bytes) {
  return pageTexts(bytes).map((t) => t.replace(/\s+/g, " ").trim());
}

const failures = [];
const { html, company, period, pageTexts } = await loadFromRepo();
const htmlPath = join(DIR, REPORT_HTML);
const pdfPath = join(DIR, REPORT_PDF);

if (CHECK) {
  const committed = existsSync(htmlPath) ? readFileSync(htmlPath, "utf-8") : null;
  if (committed === null) failures.push(`${REPORT_HTML} is missing from ${DIR}`);
  else if (committed !== html) {
    let at = 0;
    while (at < committed.length && committed[at] === html[at]) at += 1;
    failures.push(
      `${REPORT_HTML} is not what the report builder produces from the served documents ` +
        `(first difference at byte ${at}: committed ${JSON.stringify(committed.slice(at, at + 60))} ` +
        `vs rebuilt ${JSON.stringify(html.slice(at, at + 60))})`,
    );
  } else console.log(`  ok   ${REPORT_HTML} — byte-identical rebuild (${html.length} chars)`);
} else {
  writeFileSync(htmlPath, html, "utf-8");
  console.log(`wrote ${htmlPath} (${html.length} chars)`);
}

if (!NO_PDF) {
  const { renderReport, closeBrowser } = await import(join(ROOT, "services/pdf/render.mjs"));
  try {
    const rendered = await renderReport(html, { company, period });
    if (CHECK) {
      if (!existsSync(pdfPath)) failures.push(`${REPORT_PDF} is missing from ${DIR}`);
      else {
        const committed = new Uint8Array(readFileSync(pdfPath));
        const was = textLayer(pageTexts, committed);
        const now = textLayer(pageTexts, rendered.bytes);
        if (was.length !== now.length) {
          failures.push(`${REPORT_PDF}: committed ${was.length} pages, rebuilt ${now.length}`);
        } else {
          const page = was.findIndex((t, i) => t !== now[i]);
          if (page >= 0) failures.push(`${REPORT_PDF}: the text of page ${page + 1} differs from a rebuild`);
          else console.log(`  ok   ${REPORT_PDF} — ${now.length} pages, text layer identical to a rebuild`);
        }
      }
    } else {
      writeFileSync(pdfPath, rendered.bytes);
      console.log(`wrote ${pdfPath} (${rendered.bytes.length} bytes, ${rendered.pages} pages)`);
    }
  } finally {
    await closeBrowser();
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  console.error("public sample report: STALE — run scripts/build_public_sample.py");
  process.exit(1);
}
if (CHECK) console.log("public sample report: PASS");
