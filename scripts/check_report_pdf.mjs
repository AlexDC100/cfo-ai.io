#!/usr/bin/env node
/**
 * G-P3 — THE PRODUCED PDF.
 *
 * `frontend/lib/__tests__/reportPrintCss.test.ts` asserts that the print
 * rules are WRITTEN. This gate asserts that they WORK: it builds the
 * real Agras export through `buildReportHtml`, renders it through the
 * shipped `services/pdf/render.mjs`, and reads the produced PDF back.
 *
 * CSS that parses is not CSS that paginates. Three of the defects this
 * lane repaired were invisible to any string assertion:
 *   · `section.rsec:first-of-type` matched NOTHING (the cover and the
 *     contents are `<section>` too), so the first section opened a page
 *     carrying 144 characters;
 *   · the KPI figures wrapped onto two lines at A4 width and the four
 *     headline numbers stopped sharing a baseline;
 *   · two adjacent `<th>` printed as the single word `THIS BOOKVERDICT`
 *     because the base cell padding is `6.5px 0`.
 * All three were found by rendering and looking.
 *
 * WHAT THIS GATE REDS ON, once the product is correct (TC-11):
 *   G1 the page stops being A4
 *   G2 a page loses the company or the period from its running head
 *   G3 a page number stops matching its own position, or the total
 *   G4 the cover gains a running head or a page number
 *   G5 a section stops opening its own page
 *   G6 the renderer stops being deterministic — same HTML, same bytes
 *   G7 the filename stops being `^[A-Za-z0-9_]+\.pdf$`
 *   G8 the chart palette's lightness ladder closes below 12 L*, which
 *      is the point at which a mono laser stops resolving two bars
 *   G9 a table that spans a page stops repeating its header row
 *   G10 the downloaded filename stops being read from the document, so
 *       a caller can name someone else's company on the file
 *   G11 the render sandbox opens — a script runs, a live listener the
 *       document names is reached, or a neighbouring file is read (each
 *       leg with a control that proves the guard, not the browser, is
 *       what refused)
 *   G12 a real company name — diacritics, quotes, a slash, stops —
 *       stops reaching the running head, or stops folding to the same
 *       safe filename
 *
 * WHAT IT CANNOT SEE:
 *   · whether the numbers are right — that is the 2,591 assertions in
 *     the export gates, over the same HTML this gate paginates;
 *   · the Romanian rendering, because the standalone report document is
 *     hard-coded `lang="en"` and carries no i18n. That is a real gap,
 *     it belongs to the document builder, and this gate does not pretend
 *     to cover it;
 *   · anything about a browser that is not the pinned Chromium — a
 *     different Chromium is a different paginator.
 *
 * Requires a Chromium: `npx playwright install chromium-headless-shell`.
 * Run: `node scripts/check_report_pdf.mjs`
 */

import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createServer } from "vite";

// fileURLToPath, not URL.pathname — the repo path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const failures = [];
const notes = [];
function check(id, ok, message) {
  if (ok) {
    notes.push(`  ok   ${id}  ${message}`);
  } else {
    failures.push(`  FAIL ${id}  ${message}`);
  }
}

// ── the real book ─────────────────────────────────────────────────────

function firm(name) {
  return join(ROOT, "tests/engine/fixtures/firm", name);
}

/**
 * Everything this gate needs out of the repo's own TypeScript, in ONE
 * Vite SSR session.
 *
 * ── THE DOCUMENT ──────────────────────────────────────────────────────
 *
 * Built through `exportBooks.ts::statementsFor`, NOT from
 * `saga_10_col_agras.json`'s `.statements` block directly. That block is
 * the WRITE path's half; `pipeline.py` adds `canonical_bs` on the SERVE
 * path afterwards, and a document rendered without it prints a balance
 * sheet whose two sides differ by the unclassified account-413 balance —
 * 46,613 RON on this very book, with no reconciling line. This gate read
 * `.statements` directly until 2026-09-08 and was therefore paginating a
 * document production does not produce. `statementsFor` performs the
 * join and THROWS if a book lacks its canonical half, so the failure
 * mode is a stopped gate rather than a quietly wrong one.
 *
 * ── THE READER ────────────────────────────────────────────────────────
 *
 * `pdfText.ts`, the same reader `threeWayParity.test.ts` runs its 2,591
 * assertions through. This gate used to carry a SECOND reader
 * (`scripts/_pdf_text.mjs`, now deleted): one renderer, two independent
 * PDF parsers, and no way to tell which of them was wrong on a document
 * they disagreed about. See that file's replacement note at the bottom
 * of `pdfText.ts`.
 *
 * ── THE `__dirname` SHIM ──────────────────────────────────────────────
 *
 * `exportBooks.ts` resolves the fixture directory from `__dirname`,
 * which vitest defines and a bare SSR module does not. It is defined
 * here rather than changed there: that file is loaded by ~30 test files
 * whose behaviour must not depend on how this one script loads it.
 */
/** The name G12 drives through the whole pipeline. Declared here because
 *  `loadFromRepo` builds the document with it and the assertion far
 *  below reads it back; one constant, two readers, no chance of the
 *  gate testing a name the document was not built with. */
const REAL_NAME = 'S.C. "AGRICOLĂ" ȘTEFĂNEŞTI-ARGEŞ / ŢARA S.R.L.';
const REAL_PERIOD = "FY 2025";

async function loadFromRepo() {
  const server = await createServer({
    configFile: join(ROOT, "vitest.config.ts"),
    root: ROOT,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
  });
  try {
    globalThis.__dirname = join(ROOT, "frontend/lib/__tests__");
    const books = await server.ssrLoadModule("/frontend/lib/__tests__/exportBooks.ts");
    const reader = await server.ssrLoadModule("/frontend/lib/__tests__/pdfText.ts");
    const statements = books.withInsights("agras", books.statementsFor("agras"));
    return {
      html: books.exportHtml("agras", statements),
      company: statements.companyName,
      period: statements.periodLabel,
      // THE SAME BOOK UNDER A REAL NAME — built by the same builder, from
      // the same statements, with only the two identity fields changed.
      // Rewriting the name into the produced markup instead would test a
      // string substitution; this tests the document builder, which is
      // what writes the running head AND `--cfoai-doc-company`.
      namedHtml: books.exportHtml("agras", {
        ...statements, companyName: REAL_NAME, periodLabel: REAL_PERIOD,
      }),
      pageTexts: reader.pageTexts,
      pageBoxesMm: reader.pageBoxesMm,
    };
  } finally {
    delete globalThis.__dirname;
    await server.close();
  }
}

// ── greyscale ─────────────────────────────────────────────────────────

function lstar(hex) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return Y > 216 / 24389 ? 116 * Y ** (1 / 3) - 16 : (Y * 24389) / 27;
}

// ── run ───────────────────────────────────────────────────────────────

const { html, company, period, namedHtml, pageTexts, pageBoxesMm } = await loadFromRepo();
const { renderReport, renderPdf, closeBrowser } = await import(
  join(ROOT, "services/pdf/render.mjs")
);

const first = await renderReport(html, { company, period });
const second = await renderReport(html, { company, period });

// EVERY page's box, not the document default. A pack whose contents
// page silently printed Letter while the rest printed A4 would have
// passed the old single-regex check.
const boxes = pageBoxesMm(first.bytes);
const offA4 = boxes
  .map((b, i) => ({ i: i + 1, b }))
  .filter(({ b }) => Math.abs(b.w - 210) >= 0.6 || Math.abs(b.h - 297) >= 0.6);
check(
  "G1",
  boxes.length === first.pages && offA4.length === 0,
  boxes.length !== first.pages
    ? `read ${boxes.length} page boxes out of a ${first.pages}-page document`
    : offA4.length === 0
      ? `all ${boxes.length} pages are ${boxes[0].w.toFixed(1)}×${boxes[0].h.toFixed(1)} mm (A4 is 210×297)`
      : `${offA4.length} page(s) are not A4: ` +
        offA4.slice(0, 4).map(({ i, b }) => `p${i} ${b.w.toFixed(1)}×${b.h.toFixed(1)}`).join(", "),
);

const texts = pageTexts(first.bytes);
check(
  "G0",
  texts.length === first.pages,
  `read text from ${texts.length} of ${first.pages} pages`,
);

const upperCompany = company.toUpperCase();
const upperPeriod = period.toUpperCase();
const missingHead = [];
for (let i = 1; i < texts.length; i += 1) {
  const t = texts[i].toUpperCase().replace(/\s+/g, " ");
  const flat = t.replace(/ /g, "");
  if (!flat.includes(upperCompany.replace(/\s+/g, "")) ) missingHead.push(`p${i + 1}:company`);
  if (!flat.includes(upperPeriod.replace(/\s+/g, ""))) missingHead.push(`p${i + 1}:period`);
}
check(
  "G2",
  missingHead.length === 0,
  missingHead.length === 0
    ? `company + period repeat on all ${texts.length - 1} body pages`
    : `running head missing on ${missingHead.length} page-halves: ${missingHead.slice(0, 6).join(", ")}`,
);

const badCounter = [];
for (let i = 1; i < texts.length; i += 1) {
  const want = `Page ${i + 1} of ${first.pages}`;
  if (!texts[i].replace(/\s+/g, " ").includes(want)) badCounter.push(`p${i + 1} wants "${want}"`);
}
check(
  "G3",
  badCounter.length === 0,
  badCounter.length === 0
    ? `every body page numbers itself, out of ${first.pages}`
    : `wrong or missing page number on ${badCounter.length}: ${badCounter.slice(0, 4).join("; ")}`,
);

const cover = (texts[0] ?? "").replace(/\s+/g, " ");
check(
  "G4",
  !/Page \d+ of \d+/.test(cover),
  /Page \d+ of \d+/.test(cover)
    ? "the cover carries a page number"
    : "the cover carries no page number and no running head",
);

// G5 — every section opens a page.
const SECTION_TITLES = [
  "Financial Statements",
  "Cash and Net Debt",
  "Liquidity & Working Capital",
  "Profitability",
  "Leverage & Coverage",
  "Credit & Distress",
  "What the numbers say",
  "Recommendations",
  "Basis of Preparation",
];
const notOpening = [];
// A section "opens" a page when its title is the first thing on it that
// is not PAGE FURNITURE. Searching the whole page — or even its first
// 220 characters — would also match the printed CONTENTS page, which
// lists all ten titles in a row, and the gate would pass with every
// section mid-page.
//
// The furniture is dropped BY LINE, not by character offset. The
// offset spelling ("everything up to the end of `Page N of M`") was
// written against a reader that emitted a page as one flow; the running
// head prints at the TOP of the page and the counter at the BOTTOM, so
// against a reader that returns lines in visual order it skipped the
// whole page and reported all nine sections missing. Lines are what
// "the first thing on the page" means, so lines are what this reads.
const FURNITURE = new RegExp(
  `^(?:Page\\s*\\d+\\s*of\\s*\\d+|${
    // The running head, as the document flattens it: company then period,
    // which Skia may emit as one run with no space between them.
    [company, period, company + period]
      .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"))
      .join("|")
  })$`,
  "i",
);
const firstRealLine = (t) => {
  for (const raw of t.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "" || FURNITURE.test(line)) continue;
    return line;
  }
  return "";
};
for (const title of SECTION_TITLES) {
  const flat = title.replace(/\s+/g, "").toUpperCase();
  const opens = texts.some((t, i) => {
    if (i === 1) return false; // the printed contents page lists them all
    return firstRealLine(t).replace(/\s+/g, "").toUpperCase().startsWith(flat);
  });
  if (!opens) notOpening.push(`${title} (never the first thing on a page)`);
}
check(
  "G5",
  notOpening.length === 0,
  notOpening.length === 0
    ? `all ${SECTION_TITLES.length} sections open a page of their own`
    : `sections not opening a page: ${notOpening.join("; ")}`,
);

check(
  "G6",
  Buffer.compare(first.bytes, second.bytes) === 0,
  Buffer.compare(first.bytes, second.bytes) === 0
    ? `two renders of the same HTML are byte-identical (${first.bytes.length} bytes, ${first.pages} pages)`
    : `two renders of the same HTML differ (${first.bytes.length} vs ${second.bytes.length} bytes)`,
);

check(
  "G7",
  /^[A-Za-z0-9_]+\.pdf$/.test(first.filename),
  `filename is ${JSON.stringify(first.filename)}`,
);

// ── G12 — A REAL COMPANY NAME, ALL THE WAY THROUGH ────────────────────
//
// THE COMMITTED BOOK IS CALLED `input`, AND THAT IS NOT A PLACEHOLDER
// MISTAKE — IT IS WHAT PRODUCTION COMPUTES. `pipeline.py:783`
// (`_deterministic_tb_parsed`) sets
//
//     "company_name": (doc["original_filename"] or "Imported entity").rsplit(".", 1)[0]
//
// and every corpus case's source file is literally `corpus/<case>/input.xlsx`,
// so the capture in `tests/engine/fixtures/firm/*.json` faithfully
// records the product's own derivation. Renaming the fixture would make
// it agree with nothing.
//
// What the name DOES hide is this gate's own coverage. "input" has no
// space, no diacritic, no punctuation and no reserved stem, so on the
// committed book `filename.mjs`'s transliteration table, its
// non-alphanumeric allowlist, its Windows-reserved-stem guard and its
// 60-character truncation were all exercised by NOTHING, and G7 was an
// assertion about a string that could not have failed it.
//
// So a second document is rendered with a name of the shape a Romanian
// accounting firm actually uploads — diacritics in both the
// comma-below and the cedilla spelling, a legal form ending in a stop,
// quotes, and a slash — and the gate asserts THE SAME NAME reaches all
// three places a reader sees it: the printed running head, the
// document's own `--cfoai-doc-company` property, and the saved file.
// The three are built from one interpolation; this is what proves they
// still are.
const named = await renderReport(namedHtml, { company: "IGNORED", period: "IGNORED" });
const namedTexts = pageTexts(named.bytes);
// Diacritics fold to their base letters in the filename, and everything
// outside [A-Za-z0-9] collapses to a single underscore — so the expected
// stem is stated here in full rather than recomputed by importing the
// module under test, which would let a broken `filenamePart` agree with
// itself.
const WANT_FILE = "S_C_AGRICOLA_STEFANESTI_ARGES_TARA_S_R_L_FY_2025_CFO_Report.pdf";
// The head, as the document prints it: uppercased by CSS, and Skia may
// emit company and period with no space between them.
const flatWanted = (REAL_NAME + REAL_PERIOD).replace(/\s+/g, "").toUpperCase();
const headPages = namedTexts
  .slice(1)
  .filter((t) => t.replace(/\s+/g, "").toUpperCase().includes(flatWanted)).length;
const nameProblems = [];
if (named.filename !== WANT_FILE) {
  nameProblems.push(`filename is ${JSON.stringify(named.filename)}, wanted ${JSON.stringify(WANT_FILE)}`);
}
if (!/^[A-Za-z0-9_]+\.pdf$/.test(named.filename)) {
  nameProblems.push("the filename left the safe alphabet — this string goes into a Content-Disposition header");
}
if (headPages !== namedTexts.length - 1) {
  nameProblems.push(
    `the running head carries the real name on ${headPages} of ${namedTexts.length - 1} body pages`,
  );
}
check(
  "G12",
  nameProblems.length === 0,
  nameProblems.length === 0
    ? `a real Romanian name (diacritics, quotes, a slash, stops) prints on all ${headPages} body ` +
      `pages and saves as ${JSON.stringify(named.filename)}`
    : nameProblems.join("; "),
);

// G10 — the file is named from the DOCUMENT, not from what the caller
// said. The two must agree, and the way to prove they do is to make the
// caller LIE and watch the filename ignore it. Otherwise a page headed
// "AGRAS IMPEX" can be saved as `Other_Company_…_CFO_Report.pdf`, and
// the person who receives the file has the wrong company's name on it.
const lied = await renderReport(html, { company: "WRONG COMPANY", period: "WRONG PERIOD" });
check(
  "G10",
  lied.filename === first.filename && !/WRONG/i.test(lied.filename),
  `caller claimed "WRONG COMPANY" / "WRONG PERIOD"; file is named ${JSON.stringify(lied.filename)}`,
);

// G8 — the greyscale ladder, read out of the shipped token file rather
// than restated here, so a token edit is what moves this gate.
const tokens = readFileSync(join(ROOT, "frontend/lib/charts/tokens.ts"), "utf-8");
const rampBlock = /export const RAMP[^=]*=\s*\[([\s\S]*?)\]/.exec(tokens);
const ramp = rampBlock === null ? [] : [...rampBlock[1].matchAll(/"(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
const gaps = ramp.slice(1).map((h, i) => Math.abs(lstar(h) - lstar(ramp[i])));
const MIN_L_GAP = 12;
check(
  "G8",
  ramp.length >= 5 && gaps.every((g) => g >= MIN_L_GAP),
  ramp.length < 5
    ? `read only ${ramp.length} ramp tones out of tokens.ts`
    : `chart ramp L* gaps ${gaps.map((g) => g.toFixed(1)).join(" / ")} (floor ${MIN_L_GAP})`,
);

// G9 — a table that spans a page repeats its header.
//
// No table in the Agras book happens to span a break, so the condition
// is CONSTRUCTED: eighty rows are cloned into the P&L body. A gate that
// only asserts what today's data happens to exercise is not a gate.
const plHeaderMatch = /<table class="fin">\s*<thead>([\s\S]*?)<\/thead>/.exec(html);
const rowMatch = /<table class="fin">[\s\S]*?<tbody>\s*(<tr[\s\S]*?<\/tr>)/.exec(html);
if (plHeaderMatch === null || rowMatch === null) {
  check("G9", false, "could not find a `table.fin` with a thead and a first row to clone");
} else {
  const headerWords = [...plHeaderMatch[1].matchAll(/>([^<>]{3,40})</g)]
    .map((m) => m[1].replace(/\s+/g, "").toUpperCase())
    .filter((w) => /^[A-Z&]+$/.test(w));
  const stretched = html.replace(rowMatch[1], rowMatch[1].repeat(80));
  const long = await renderReport(stretched, { company, period });
  const longTexts = pageTexts(long.bytes);
  const word = headerWords[0] ?? "";
  const countPagesWith = (list) =>
    list.filter((t) => t.replace(/\s+/g, "").toUpperCase().includes(word)).length;
  const withRepeat = countPagesWith(longTexts);

  // THE CONTROL. "The header appears on 11 pages" is not evidence on its
  // own — `BALANCE SHEET` is words that occur elsewhere in the document.
  // So the same stretched document is rendered a second time with the
  // repeat TURNED OFF, and the gate asserts the count FALLS. That makes
  // G9 self-proving: it cannot pass on a document where the rule does
  // nothing. (This is the TC-2 plant, built into the gate, because the
  // condition it tests does not occur in any committed book.)
  const defeated = stretched.replace(
    "</style>",
    "@media print { table.fin thead { display: table-row-group !important; } }</style>",
  );
  const withoutRepeat = countPagesWith(pageTexts((await renderReport(defeated, { company, period })).bytes));

  check(
    "G9",
    word !== "" && withRepeat >= 2 && withRepeat > withoutRepeat,
    word === ""
      ? "could not read a header word out of the table's thead"
      : `header ${JSON.stringify(word)} on ${withRepeat} of ${long.pages} pages with ` +
        `table-header-group, ${withoutRepeat} with it defeated`,
  );
}

// G11 — THE SANDBOX. This renderer loads caller-supplied HTML into a
// browser, which is an SSRF and local-file-read primitive unless it is
// closed off. `render.mjs` closes it three ways (JS off, every network
// request aborted, no base URL); this asserts all three at once, on a
// document written to exercise them.
//
// ── EVERY LEG NEEDS A CONTROL, AND TWO OF THEM DID NOT HAVE ONE ───────
//
// THE NETWORK LEG. A first cut pointed the hostile `<img>` at
// 169.254.169.254 — the cloud metadata address, the classic SSRF
// target. Removing the network abort did NOT red it: that host is
// unreachable from this machine either way, so the gate was passing on
// a coincidence rather than on the rule. It now serves the target
// ITSELF, on an ephemeral port, and asserts the server received ZERO
// requests. A reachable listener is the only thing that can tell
// "blocked" from "unroutable". Re-measured 2026-09-08 by removing
// `page.route(…abort)` from a copy of `renderPdf`: the listener took 1
// request and the response body PRINTED INTO THE PDF. The leg bites.
//
// THE FILE LEG had the same defect and kept it. Measured the same day,
// four renders of one hostile document:
//
//   as shipped                        file read: no    net: 0 requests
//   network abort removed             file read: NO    net: 1 request
//   abort removed + JS on             file read: NO    net: 1 request
//   loaded from a file:// URL         file read: YES   net: 0 (aborted)
//
// So `<iframe src="file:///etc/passwd">` is refused whatever this gate's
// three guards do — Chromium blocks an `about:blank` document (which is
// what `setContent` produces) from reaching a `file:` URL, and blocks
// one `file:` directory from reaching another. The leg was green because
// the browser said no, not because `render.mjs` did, and it would have
// stayed green through a rewrite of `renderPdf` that opened the document
// from disk.
//
// The guard that actually stops the read is the THIRD one — `setContent`
// with no base URL — and what it stops is a SAME-DIRECTORY relative
// reference. So that is what is tested, and it is tested WITH A CONTROL:
// the identical document is also opened from a `file://` URL in the
// directory holding the canary, on the same browser, and the canary must
// appear there. If it does not, this leg is proving nothing and the gate
// says so and fails, rather than reporting a pass it did not earn. (Same
// shape as G9's defeated-repeat control, and for the same reason.)
const { createServer: createHttpServer } = await import("node:http");
let hits = 0;
const decoy = createHttpServer((_req, res) => {
  hits += 1;
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("SECRET");
});
await new Promise((r) => decoy.listen(0, "127.0.0.1", r));
const decoyUrl = `http://127.0.0.1:${decoy.address().port}/metadata`;

// The canary is written to a temp directory and named with a token that
// occurs nowhere else in this repo, so "the PDF contains it" cannot be a
// coincidence of the document's own words.
const sandboxDir = mkdtempSync(join(tmpdir(), "pdf-sandbox-"));
const CANARY = "CANARYNEIGHBOURFILE";
writeFileSync(join(sandboxDir, "neighbour.txt"), `${CANARY}\n`);

const hostile = [
  "<!doctype html><html><head><title>t</title></head><body>",
  '<p id="a">SCRIPT DID NOT RUN</p>',
  // Absolute, cross-directory: the classic phrasing. Kept because it
  // costs nothing, NOT counted as evidence — see the note above.
  '<p>ETC: <iframe src="file:///etc/passwd" width="300" height="60"></iframe></p>',
  // Same directory, relative: the one that a base URL would resolve, and
  // the one the control below proves is readable when it is allowed.
  '<p>NEIGHBOUR: <iframe src="./neighbour.txt" width="300" height="40"></iframe></p>',
  `<p>NET: <img src="${decoyUrl}" alt="IMG DID NOT LOAD" width="200"></p>`,
  `<p>FRAME: <iframe src="${decoyUrl}" width="200" height="40"></iframe></p>`,
  `<script>document.getElementById('a').textContent='SCRIPT RAN';fetch(${JSON.stringify(decoyUrl)});</script>`,
  "</body></html>",
].join("\n");
const sandboxed = await renderPdf(hostile);
const sandboxText = pageTexts(sandboxed.bytes).join(" ").replace(/\s+/g, " ");

// THE CONTROL. Same browser, same document, no sandbox — opened from
// disk so its origin IS the directory holding the canary. Network is
// aborted here too, so the control isolates the FILE guard alone and a
// stray request cannot make it pass.
writeFileSync(join(sandboxDir, "doc.html"), hostile);
const controlBrowser = await (await import(join(ROOT, "services/pdf/render.mjs"))).browser();
const controlCtx = await controlBrowser.newContext({ javaScriptEnabled: false });
let controlText = "";
try {
  const controlPage = await controlCtx.newPage();
  await controlPage.route("**/*", (route) => {
    // Let the file: document and its same-directory neighbour load;
    // abort anything that would leave the machine.
    if (route.request().url().startsWith("file:")) return route.continue();
    return route.abort();
  });
  await controlPage.goto(pathToFileURL(join(sandboxDir, "doc.html")).href, { waitUntil: "load" });
  await controlPage.emulateMedia({ media: "print" });
  controlText = pageTexts(await controlPage.pdf({ preferCSSPageSize: true, printBackground: true }))
    .join(" ")
    .replace(/\s+/g, " ");
} finally {
  await controlCtx.close();
}
decoy.close();

const escaped = [];
if (hits > 0) escaped.push(`${hits} request(s) reached a live server the document named`);
if (sandboxText.includes("SCRIPT RAN")) escaped.push("script executed");
if (!sandboxText.includes("SCRIPT DID NOT RUN")) escaped.push("static text missing — the read failed");
if (/root:x:|daemon:x:|nobody:/.test(sandboxText)) escaped.push("read /etc/passwd");
if (sandboxText.includes(CANARY)) escaped.push("read a neighbouring file off the local disk");
if (sandboxText.includes("SECRET")) escaped.push("rendered a response from the network");
// The control is an assertion, not a diagnostic: a control that cannot
// read the canary means the file leg above tested nothing.
if (!controlText.includes(CANARY)) {
  escaped.push(
    "THE CONTROL FAILED — the same document opened from a file:// origin did not read the " +
      "neighbouring file either, so the file leg of this gate is proving nothing. Fix the " +
      "control before trusting the pass.",
  );
}
check(
  "G11",
  escaped.length === 0,
  escaped.length === 0
    ? "hostile document: no script ran, a live listener it named got 0 requests, and the " +
      "neighbouring file it referenced was NOT read — while the same document opened from a " +
      "file:// origin read it, so the guard is what stopped it"
    : `the sandbox leaked: ${escaped.join("; ")}`,
);

await closeBrowser();

// ── report ────────────────────────────────────────────────────────────

process.stdout.write("REPORT PDF GATE\n");
process.stdout.write("=".repeat(62) + "\n");
process.stdout.write(
  `GATE-WORK report-pdf units=${notes.length + failures.length} floor=13 label=rendered-pdf-assertions\n`,
);
for (const line of notes) process.stdout.write(line + "\n");
for (const line of failures) process.stdout.write(line + "\n");
process.stdout.write("-".repeat(62) + "\n");

if (process.env.REPORT_PDF_OUT) {
  const dir = mkdtempSync(join(tmpdir(), "report-pdf-"));
  const out = process.env.REPORT_PDF_OUT || join(dir, first.filename);
  writeFileSync(out, first.bytes);
  process.stdout.write(`wrote ${out}\n`);
}

if (failures.length > 0) {
  process.stdout.write(`FAIL — ${failures.length} of ${notes.length + failures.length}\n`);
  process.exit(1);
}
process.stdout.write(`PASS — ${notes.length} assertions, ${first.pages} pages\n`);
