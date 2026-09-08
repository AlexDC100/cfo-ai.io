// THE RENDERER — one HTML document in, one A4 PDF out.
//
// ── WHY A BROWSER AND NOT A PDF LIBRARY ───────────────────────────────
//
// The report is already a document: `frontend/lib/financialReport.ts`
// builds a standalone HTML file with a cover, a contents page, ten
// sections, thirty-five tables and twenty-six inline SVG charts, and
// `reportPrintCss.ts` gives it its A4 rules. A PDF library (pdfkit,
// pdfmake, jsPDF) would have to RE-BUILD that document in a second
// language, and the moment there are two builders there are two
// answers, and the export laws say a figure that differs between
// formats is the defect.
//
// So the PDF is not a second rendering. It is the SAME BYTES the HTML
// export writes, paginated. Format parity is structural, not asserted.
//
// ── WHY CHROMIUM AND NOT WEASYPRINT ───────────────────────────────────
//
// Both were run against the real Agras export on 2026-09-08. Full
// numbers are in `pdf-lane1.md`; the decisive line is that WeasyPrint
// ignores the CSS `fill`, `font-size` and `text-anchor` that
// `charts/primitives.ts` sets on SVG text through class selectors, so
// every chart label rendered at the default size, at the default
// anchor, in black — the balance-sheet chart printed "PP&E" and
// "RON 11,055,450" ON TOP OF EACH OTHER, and the band tracks' tick
// labels collided into an unreadable smear. It was also six times
// slower (2,431 ms against 396 ms). Chromium renders the document as
// designed. WeasyPrint's genuine advantage — it resolves
// `target-counter()`, so the printed contents page carries real page
// numbers, which Chromium leaves blank — did not come close to paying
// for ten broken charts.
//
// ── DETERMINISM ───────────────────────────────────────────────────────
//
// Measured: rendering the same HTML twice produces two files of
// identical length differing in exactly EIGHT bytes, all of them inside
// `/CreationDate` and `/ModDate`. Nothing else in Skia's PDF output
// varies — no `/ID`, no object shuffling, no timestamp in a stream.
//
// So this module normalises those two fields and the claim becomes
// exact and testable: SAME HTML IN, SAME BYTES OUT. The renderer adds
// no clock of its own.
//
// It cannot promise more than that. The HTML it is handed carries
// `Report generated: <today>` from a `new Date()` upstream in
// `financialReport.ts`, so the same BOOK produces different HTML on
// different days. That is a real gap, it is named in `pdf-lane1.md`,
// and it belongs to the document builder — not here. Pretending to fix
// it here (by rewriting a date inside someone else's markup) would be
// this module inventing a fact.

import { chromium } from "playwright";

import { reportFilename, filenameIsSafe } from "./filename.mjs";

/**
 * The sentinel written into `/CreationDate` and `/ModDate`.
 *
 * The POSIX epoch, chosen precisely BECAUSE it is obviously not a real
 * timestamp. A reader who opens the file properties and sees 1 January
 * 1970 knows the field means nothing and looks at the document's own
 * "Report generated" line, which is a real date. A reader who sees a
 * plausible-but-arbitrary date believes it.
 *
 * Same byte length as what Skia writes (23 characters), so the
 * substitution never moves an xref offset.
 */
const PDF_DATE_SENTINEL = "D:19700101000000+00'00'";
const PDF_DATE_RE = /D:\d{14}[+-]\d{2}'\d{2}'/g;

/**
 * Replace every PDF date string with the sentinel, IN PLACE.
 *
 * Length-preserving by construction: the check below refuses to
 * substitute anything that is not exactly as long as the sentinel,
 * because a shorter or longer replacement would shift every byte after
 * it and invalidate the cross-reference table — a corrupt PDF is far
 * worse than a non-deterministic one.
 */
export function normalisePdfDates(bytes) {
  const latin = Buffer.from(bytes).toString("latin1");
  let substitutions = 0;
  const out = latin.replace(PDF_DATE_RE, (match) => {
    if (match.length !== PDF_DATE_SENTINEL.length) return match;
    substitutions += 1;
    return PDF_DATE_SENTINEL;
  });
  return { bytes: Buffer.from(out, "latin1"), substitutions };
}

/** How many pages the produced PDF has, read out of its own page tree. */
export function countPages(bytes) {
  const latin = Buffer.from(bytes).toString("latin1");
  // Every `/Type /Page` object that is not `/Pages`. Counting the
  // objects rather than trusting a `/Count` entry: `/Count` appears in
  // several nodes of the tree and picking the wrong one silently
  // under-reports a long document.
  const matches = latin.match(/\/Type\s*\/Page(?![s\w])/g);
  return matches === null ? 0 : matches.length;
}

let browserPromise = null;

/**
 * ONE browser for the process, launched on the first render.
 *
 * `chromium-headless-shell` rather than the full browser: measured
 * byte-identical output (after date normalisation) on the Agras export,
 * at 189 MB installed instead of 336 MB. There is no UI to lose.
 */
export async function browser() {
  if (browserPromise === null) {
    browserPromise = chromium.launch({
      channel: "chromium-headless-shell",
      args: ["--font-render-hinting=none"],
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise !== null) {
    const b = await browserPromise;
    browserPromise = null;
    await b.close();
  }
}

/**
 * Render one document.
 *
 * ── THE SANDBOX, AND WHY IT IS SHAPED LIKE THIS ───────────────────────
 *
 * This function loads a caller-supplied HTML string into a browser. That
 * is an SSRF and local-file-read primitive unless it is closed off, so
 * three things are true of the page it opens:
 *
 *   1. `javaScriptEnabled: false`. The document's only script moves
 *      pre-rendered nodes around for the interactive reader (toggles,
 *      the hover provenance card) — `documentShell.ts` states, and
 *      `reportInteractive.test.ts` gates, that it contains no
 *      arithmetic. Nothing it does affects the printed page, and
 *      turning it off removes the entire scripted-attack surface AND
 *      any timing-dependent output.
 *   2. EVERY network request is aborted. The document is offline by
 *      design — no font CDN, no analytics, no image host; that is
 *      gated upstream by `reportInteractive.test.ts` PLANT 6. The abort
 *      is the belt: even an injected `<img src=http://169.254.169.254/…>`
 *      or `file:///etc/passwd` never leaves the process.
 *   3. `setContent` with no base URL, so relative references resolve
 *      against `about:blank` and cannot reach the filesystem.
 *
 * ── PAGE GEOMETRY COMES FROM THE DOCUMENT, NOT FROM HERE ──────────────
 *
 * `preferCSSPageSize: true` and NO `margin` option. The document's own
 * `@page { size: A4; margin: … }` is the single authority for the
 * printed page; passing a margin here would silently win over it, and
 * then the A4 rules a developer reads in `reportPrintCss.ts` would not
 * be the A4 rules the PDF used.
 */
export async function renderPdf(html, { timeoutMs = 60_000 } = {}) {
  const b = await browser();
  const context = await b.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
    await page.emulateMedia({ media: "print" });
    const raw = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: false,
      timeout: timeoutMs,
    });
    const { bytes, substitutions } = normalisePdfDates(raw);
    return { bytes, pages: countPages(bytes), dateFieldsNormalised: substitutions };
  } finally {
    await context.close();
  }
}

/**
 * Render, and name the file.
 *
 * The name is computed HERE and returned, so the browser writes the name
 * the service decided instead of deriving a second one from the same
 * inputs. `filenameIsSafe` is re-asserted on the result rather than
 * trusted: this string goes into a `Content-Disposition` header, and a
 * regression in `filename.mjs` would otherwise become a header
 * injection instead of a failed render.
 */
export function documentMeta(html) {
  const read = (name) => {
    const m = new RegExp(`--cfoai-doc-${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(html);
    if (m === null) return null;
    // Undo the CSS string escaping `reportPrintCss.ts::cssString` applied.
    return m[1].replace(/\\(.)/g, "$1");
  };
  return { company: read("company"), period: read("period") };
}

export async function renderReport(html, meta, opts) {
  // THE DOCUMENT NAMES ITSELF. `reportPrintCss.ts` writes the company
  // and the period into `:root` as custom properties, from the SAME
  // interpolation that fills the running head, so a filename built from
  // them cannot name a different company than the pages do. The caller's
  // `meta` is only a fallback, for a document built before those
  // properties existed — and a wrong-but-plausible filename on an old
  // document is better than no download at all.
  const inDoc = documentMeta(html);
  const filename = reportFilename(
    inDoc.company ?? meta?.company,
    inDoc.period ?? meta?.period,
  );
  if (!filenameIsSafe(filename)) {
    throw new Error(
      `refusing to serve a filename that failed its own safety assertion: ${JSON.stringify(filename)}`,
    );
  }
  const result = await renderPdf(html, opts);
  return { ...result, filename };
}
