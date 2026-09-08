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
 *   G11 the render sandbox opens — a script runs, a remote image loads,
 *       or a `file://` reference is followed
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
import { fileURLToPath } from "node:url";

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

async function buildAgrasHtml() {
  // Vite's own SSR loader, so the document is built by the SAME
  // TypeScript the app ships — not a re-implementation, and not a
  // committed snapshot that would go stale the day the builder changes.
  const server = await createServer({
    configFile: join(ROOT, "vitest.config.ts"),
    root: ROOT,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const mod = await server.ssrLoadModule("/frontend/lib/financialExports.ts");
    const fx = JSON.parse(readFileSync(firm("saga_10_col_agras.json"), "utf-8"));
    const served = JSON.parse(readFileSync(firm("served_metrics.json"), "utf-8"));
    const insights = JSON.parse(readFileSync(firm("insights.json"), "utf-8"));
    const statements = { ...fx.statements, insights: insights.agras };
    return {
      html: mod.buildReportHtml(statements, { metricsByName: served.agras ?? {} }),
      company: statements.companyName,
      period: statements.periodLabel,
    };
  } finally {
    await server.close();
  }
}

// ── reading the produced PDF ──────────────────────────────────────────
//
// `scripts/_pdf_text.mjs` — no new dependency, and it carries the two
// traps that made a first cut of this gate report a false RED (Skia
// shows text as HEX strings against per-font ToUnicode CMaps, and its
// page tree is nested two levels deep).

import { mediaBoxMm, pageTexts } from "./_pdf_text.mjs";

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

const { html, company, period } = await buildAgrasHtml();
const { renderReport, renderPdf, closeBrowser } = await import(
  join(ROOT, "services/pdf/render.mjs")
);

const first = await renderReport(html, { company, period });
const second = await renderReport(html, { company, period });

const box = mediaBoxMm(first.bytes);
check(
  "G1",
  box !== null && Math.abs(box.w - 210) < 0.6 && Math.abs(box.h - 297) < 0.6,
  box === null
    ? "the produced PDF states no /MediaBox"
    : `page is ${box.w.toFixed(1)}×${box.h.toFixed(1)} mm (A4 is 210×297)`,
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
// The running head and the page counter are the first thing on every
// page, so a section "opens" a page when its title is the first thing
// AFTER them. Searching the whole page — or even its first 220
// characters — would also match the printed CONTENTS page, which lists
// all ten titles in a row, and the gate would pass with every section
// mid-page.
const headLength = (t) => {
  const m = /Page\s*\d+\s*of\s*\d+/.exec(t.replace(/\s+/g, " "));
  return m === null ? 0 : m.index + m[0].length;
};
for (const title of SECTION_TITLES) {
  const flat = title.replace(/\s+/g, "");
  const opens = texts.some((t, i) => {
    if (i === 1) return false; // the printed contents page lists them all
    const norm = t.replace(/\s+/g, " ");
    const after = norm.slice(headLength(t)).replace(/\s+/g, "");
    return after.startsWith(flat);
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
// THE HONEST HOST. A first cut pointed the hostile `<img>` at
// 169.254.169.254 — the cloud metadata address, the classic SSRF
// target. Removing the network abort did NOT red it: that host is
// unreachable from this machine either way, so the gate was passing on
// a coincidence rather than on the rule. It now serves the target
// ITSELF, on an ephemeral port, and asserts the server received ZERO
// requests. A reachable listener is the only thing that can tell
// "blocked" from "unroutable".
const { createServer: createHttpServer } = await import("node:http");
let hits = 0;
const decoy = createHttpServer((_req, res) => {
  hits += 1;
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("SECRET");
});
await new Promise((r) => decoy.listen(0, "127.0.0.1", r));
const decoyUrl = `http://127.0.0.1:${decoy.address().port}/metadata`;

const hostile = [
  "<!doctype html><html><head><title>t</title></head><body>",
  '<p id="a">SCRIPT DID NOT RUN</p>',
  '<p>FILE: <iframe src="file:///etc/passwd" width="300" height="60"></iframe></p>',
  `<p>NET: <img src="${decoyUrl}" alt="IMG DID NOT LOAD" width="200"></p>`,
  `<p>FRAME: <iframe src="${decoyUrl}" width="200" height="40"></iframe></p>`,
  `<script>document.getElementById('a').textContent='SCRIPT RAN';fetch(${JSON.stringify(decoyUrl)});</script>`,
  "</body></html>",
].join("\n");
const sandboxed = await renderPdf(hostile);
const sandboxText = pageTexts(sandboxed.bytes).join(" ").replace(/\s+/g, " ");
decoy.close();

const escaped = [];
if (hits > 0) escaped.push(`${hits} request(s) reached a live server the document named`);
if (sandboxText.includes("SCRIPT RAN")) escaped.push("script executed");
if (!sandboxText.includes("SCRIPT DID NOT RUN")) escaped.push("static text missing — the read failed");
if (/root:x:|daemon:x:|nobody:/.test(sandboxText)) escaped.push("read /etc/passwd");
if (sandboxText.includes("SECRET")) escaped.push("rendered a response from the network");
check(
  "G11",
  escaped.length === 0,
  escaped.length === 0
    ? "hostile document: no script ran, no file was read, and a live listener it named got 0 requests"
    : `the sandbox leaked: ${escaped.join("; ")}`,
);

await closeBrowser();

// ── report ────────────────────────────────────────────────────────────

process.stdout.write("REPORT PDF GATE\n");
process.stdout.write("=".repeat(62) + "\n");
process.stdout.write(
  `GATE-WORK report-pdf units=${notes.length + failures.length} floor=11 label=rendered-pdf-assertions\n`,
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
