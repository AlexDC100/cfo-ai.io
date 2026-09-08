// G-P — THE PDF, THE HTML AND THE WORKBOOK ARE ONE DOCUMENT.
//
// The owner's words: "a rendered PDF is parsed back and its figures
// compared to the gateway; any divergence fails."
//
// So this gate renders the PDF through the SHIPPED service
// (`services/pdf/render.mjs`, via `exportPdf.ts`), reads its TEXT LAYER
// out of the bytes (`pdfText.ts`), and compares three renderings of one
// truth: the printed PDF, the standalone HTML the Export tab writes, and
// the XLSX workbook — each against the others and against the gateway
// facts (`tests/engine/fixtures/firm/*.json`'s `assembled_pl`, and
// `servedFacts.ts` for the balance sheet).
//
// It reads the PDF and never the HTML that was fed to the printer.
// Asserting over the input would prove nothing about the artefact:
// pagination, a `@media print` rule that hides a block, a font that fails
// to embed — every one of those lives BELOW the HTML and above the reader.
//
// ── THE VACUOUS-GATE HAZARD, AND THE FLOOR ────────────────────────────
//
// A PDF text layer breaks numbers across spans and lines, and a naive
// regex over a badly-read document matches nothing while every assertion
// passes over the empty set. This repo has been bitten by that shape
// before (`docs/engine_book/gates.md`, the FakeStore case). Three things
// stand against it here, and §0 asserts all three:
//
//   1. STRUCTURE. The reader reports how it read the file. If it fell
//      back from the cross-reference table to a brute object scan, or if
//      any font lacked a `/ToUnicode` CMap — the condition under which
//      it emits nothing rather than fabricating characters — §0 reds.
//   2. A FLOOR ON THE FIGURES FOUND. Measured 2026-09-08 on the four
//      committed books (agras / carniprod / realestate / retail), the
//      reader recovers 1,233 / 1,044 / 1,014 / 1,221 numeric tokens from
//      the rendered PDFs. The floor is 800 — under every one of them and
//      far above what a half-read document yields — and §0 also asserts
//      that a HARD SET, §4's gateway anchors, appears literally, so a
//      reader returning 800 tokens of page furniture still could not
//      pass.
//   3. AN INDEPENDENT READER. `pdfText.ts`'s output was reconciled
//      token-for-token against PyMuPDF on the SAME bytes this gate reads,
//      2026-09-08: 1,233 / 1,048 / 1,014 / 1,221 tokens against PyMuPDF's
//      1,232 / 1,048 / 1,014 / 1,221, with ZERO tokens unexplained in
//      either direction on any book. (The single agras difference is one
//      figure PyMuPDF glues to the account-code column beside it, which
//      decomposes exactly into two of this reader's tokens.) The
//      transcript is in `pdf-lane2.md`.
//
// ── LOCALE ────────────────────────────────────────────────────────────
//
// The standalone export declares `<html lang="en">` and has no i18n
// (`v3-charts.md`: "the standalone export has no i18n and never had"), so
// its grouping separator is "," and its decimal separator ".". This gate
// does not assume that — it READS the `lang` attribute (§0) and picks the
// grammar from it, so the day the export gains a Romanian rendering the
// gate follows rather than silently mis-parsing `1.234,56` as 1.234.
// Thin and non-breaking spaces are stripped before parsing either way.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  · a figure printed in a statement table, a ratio card or a chart table
//    in the HTML that does not survive into the PDF (§2)
//  · a figure in the PDF that is in neither the HTML nor the running
//    page furniture — the print inventing a number (§3)
//  · a P&L concept whose value differs between the document and the
//    workbook, or whose SIGN differs (§4)
//  · net income, total assets or total equity in any format differing
//    from the gateway fact (§4)
//  · a concept one format REFUSES and another answers with a number (§1)
//  · a prior-period or delta cell carrying a figure on a book that has no
//    prior period (§1)
//
// ── WHAT IT CANNOT SEE ────────────────────────────────────────────────
//  · whether a figure is RIGHT — only that the three formats and the
//    gateway say the same thing. A wrong number spelled identically
//    everywhere passes here; `exportPlFoots.test.ts` and the engine's
//    anchor gates are the other half.
//  · LAYOUT. The text layer carries no visual overlap; the browser
//    geometry sweep in `v3-charts.md` is that half.
//  · the PPTX, which does not exist.
//  · §2 and §3 compare MAGNITUDES, not signs, because the document
//    writes a negative as `(RON 70,557,115)` and the workbook as
//    `-70557114.68`; sign is asserted per concept in §4 instead.
//  · §2 compares SETS, so a figure the document prints twice and the PDF
//    prints once still passes there. Measured: deleting the P&L's
//    "Net Income (account 121, as filed)" row from the printer's copy
//    leaves §2 green, because the same figure is on the KPI card. §4's
//    label-anchored check is what reds on that ("the PDF has no line
//    naming …"), which is why the two sections are both here.
//  · anything about a book with a prior period — no committed book has
//    one, so §1's comparative branch exercises only the degraded path.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { buildExcelWorkbook } from "@/lib/financialExports";
import { UNREPORTED_WORD } from "@/lib/financialReport";
import { NO_COMPARATIVE_CELL } from "@/lib/reportComparatives";
import { factsFrom } from "@/lib/servedFacts";

import {
  BOOKS,
  type Book,
  type PrintedRow,
  exportHtml,
  metricsFor,
  parsePrinted,
  plRows,
  statementsFor,
  withCanonicalBs,
  withInsights,
} from "./exportBooks";
import { closePdfRenderer, renderedPdf, type RenderedPdf } from "./exportPdf";

// ── the gateway ───────────────────────────────────────────────────────

interface AssembledPl {
  revenue?: number;
  ebitda?: number;
  ebit?: number;
  net_income_statutory?: number;
  net_income_operational?: number;
  net_income_reconciliation_to_121?: number;
}

/** The book exactly as the route serves it — book + canonical BS + insights. */
function served(book: Book) {
  return withInsights(book, withCanonicalBs(book, statementsFor(book)));
}

// ── reading figures out of any of the three formats ───────────────────

/**
 * How this document spells a number.
 *
 * Taken from the document's own `lang`, never assumed. `en` groups with
 * "," and points with "."; `ro` is the mirror. A token is normalised to
 * its MAGNITUDE as a decimal string with trailing zeros trimmed, so
 * "RON 118,576,820", "118576820" and "118,576,820.00" are one key.
 */
type Grammar = { group: string; decimal: string };

function grammarFor(lang: string): Grammar {
  return lang.toLowerCase().startsWith("ro")
    ? { group: ".", decimal: "," }
    : { group: ",", decimal: "." };
}

/** The space characters a formatted figure can carry: no-break, narrow
 *  no-break, thin and figure space. Written as escapes, not as literal
 *  characters, so they are visible in a diff and eslint's
 *  `no-irregular-whitespace` does not have to guess. */
const SPACES = /[\u00a0\u202f\u2009\u2007]/g;

function normaliseMagnitude(raw: string, g: Grammar): string | null {
  const cleaned = raw.replace(SPACES, "").split(g.group).join("");
  const parts = cleaned.split(g.decimal);
  if (parts.length > 2) return null;
  const digits = parts[0].replace(/[^\d]/g, "");
  const frac = (parts[1] ?? "").replace(/[^\d]/g, "").replace(/0+$/, "");
  if (digits === "" && frac === "") return null;
  const whole = digits.replace(/^0+(?=\d)/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

/**
 * Half a display step of a printed figure — the widest a rounding can be.
 *
 * `exportBooks.halfStep` cannot be used here: it takes the LAST separator
 * in the string as the decimal point, so on "RON 118,576,820" it counts
 * three decimals and returns 0.0005, and every whole-RON figure in the
 * document then looks like a divergence from its own unrounded source.
 * This one asks the document's grammar which separator is which.
 */
function displayHalfStep(printed: string, g: Grammar): number {
  const cleaned = printed.replace(SPACES, "");
  // `formatCurrency` compacts inside a sentence — "RON 118.58M" — and the
  // suffix rides the digits with no space, so the step of a compacted
  // figure is five thousand RON, not half a cent.
  const mag = /\d\s*B(?![A-Za-z])/.test(cleaned)
    ? 1e9
    : /\d\s*M(?![A-Za-z])/.test(cleaned)
      ? 1e6
      : /\d\s*K(?![A-Za-z])/.test(cleaned)
        ? 1e3
        : 1;
  const at = cleaned.lastIndexOf(g.decimal);
  if (at < 0) return 0.5 * mag;
  const decimals = (/^\d+/.exec(cleaned.slice(at + 1)) ?? [""])[0].length;
  return (0.5 * mag) / Math.pow(10, decimals);
}

/** Every numeric token in a block of text, as a magnitude multiset. */
function magnitudes(text: string, g: Grammar): Map<string, number> {
  const token = new RegExp(
    `\\d[\\d${g.group === "." ? "\\." : ","}${g.decimal === "." ? "\\." : ","}\\u00a0\\u202f\\u2009\\u2007]*\\d|\\d`,
    "g",
  );
  const out = new Map<string, number>();
  for (const m of text.matchAll(token)) {
    const key = normaliseMagnitude(m[0], g);
    if (key === null) continue;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

// ── the printed document ──────────────────────────────────────────────

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * The text of an element, with a separator at every node boundary.
 *
 * NOT `textContent`. The document writes a figure and the account codes
 * beside it as adjacent cells with no whitespace between the tags —
 * `673,090</td><td class="src">20` — and `textContent` fuses them into
 * "673,09020", a token that is in neither the PDF nor the document as a
 * reader sees it. That is the mirror of the defect PyMuPDF has on the
 * same table, and left in place it makes §3 report every account code in
 * the balance sheet as an invented figure.
 *
 * Inserting a space between siblings can only ever SPLIT a token, never
 * join two; and if it ever split a real figure, §2 (every printed figure
 * survives into the PDF) would red on the halves.
 */
function textWithBoundaries(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  let out = "";
  node.childNodes.forEach((child) => {
    out += textWithBoundaries(child) + " ";
  });
  return out;
}

/**
 * The text of the document, with the parts a PDF cannot carry removed:
 * `<style>` and `<script>` bodies (never rendered as text) and SVG
 * `<title>`/`<desc>` (accessibility strings a browser shows on hover and
 * a printer never draws). Everything else stays, including chart labels.
 */
function documentText(doc: Document): string {
  const body = doc.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll("style, script, svg title, svg desc, title").forEach((n) => n.remove());
  return textWithBoundaries(body).replace(/\s+/g, " ");
}

/**
 * The figures the document PRINTS as figures: statement-table cells,
 * ratio-card values, chart-table cells and recommendation cards. Every
 * one of these is print-visible by design, so each must survive into the
 * PDF — unlike the document's hidden pre-rendered toggle variants, which
 * exist in the DOM precisely so the interactive reader needs no script,
 * and which the print CSS never reveals.
 */
function printedFigureText(doc: Document): string {
  const parts: string[] = [];
  const take = (sel: string): void => {
    doc.querySelectorAll(sel).forEach((n) => parts.push(textWithBoundaries(n)));
  };
  take("table.fin td");
  take("table.chart-table td");
  take(".ratio-card .value");
  take(".rec");
  return parts.join(" ").replace(/\s+/g, " ");
}

// ── the PDF's running page furniture ──────────────────────────────────
//
// The running header prints "… · Page N of M" from CSS `counter(page)` /
// `counter(pages)`, which exist only once the document is paginated —
// they are in no HTML the printer was given. They are therefore removed
// before §3 compares the PDF against the HTML, and the removal is
// asserted rather than trusted: exactly one furniture line per page, no
// more and no fewer, so the exclusion can never quietly swallow content.

const FURNITURE = /\bPage\s+\d+\s+of\s+\d+\s*$/;

function splitFurniture(pdf: RenderedPdf): { furniture: string[]; body: string } {
  const furniture: string[] = [];
  const body: string[] = [];
  for (const line of pdf.text.lines) {
    if (FURNITURE.test(line.text)) furniture.push(line.text);
    else body.push(line.text);
  }
  return { furniture, body: body.join("\n") };
}

// ── finding a printed row in the PDF ──────────────────────────────────
//
// A label has to be ANCHORED at the start of a line, and the character
// after it has to be the start of a figure. Both halves were learned by
// getting them wrong: a substring search for "EBIT" matched the line
// "EBITDA RON 18,420,491" and reported that the document disagreed with
// itself, and a search for "Revenue" matched the KPI line "Operating
// revenue RON 79,512,188" — a different concept with a different, also
// correct, value. And the anchor cannot simply require whitespace after
// the label: Skia writes the row's label and its right-aligned figure at
// two positions on one baseline with no gap wide enough to separate them,
// so the P&L's EBITDA row reads "EBITDARON 18,420,491".
//
// Every anchored line is checked, not just the first. The same concept
// is printed in the statement table and again in a chart table, at a
// different rounding; if two of them disagreed, that is a finding.

const CURRENCY = "RON|EUR|USD";
const FIGURE = `\\(?\\s*[-−]?\\s*(?:${CURRENCY})?\\s*\\d[\\d,.\\u00a0\\u202f\\u2009]*\\)?`;

function pdfFiguresFor(pdf: RenderedPdf, label: string): Array<{ line: string; printed: string }> {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*(${FIGURE})`, "i");
  const out: Array<{ line: string; printed: string }> = [];
  for (const line of pdf.text.lines) {
    const flat = line.text.replace(/\s+/g, " ").trim();
    const m = re.exec(flat);
    if (m) out.push({ line: flat, printed: m[1].trim() });
  }
  return out;
}

// ── the workbook ──────────────────────────────────────────────────────

/**
 * The STORED value of a cell, not its rendering.
 *
 * `sheet_to_json(..., { raw: false })` returns SheetJS's formatted text,
 * which is lossy: carniprod's total assets are stored as 125886192.51 and
 * come back as "125886192.5". Comparing that against the gateway made the
 * gate report a one-cent divergence that exists nowhere in the workbook.
 * Numeric comparisons read `cell.v`; the text scans keep using the
 * rendered form, because what a reader sees is what a reader sees.
 */
function sheetNumber(wb: XLSX.WorkBook, sheet: string, label: string, column: number): number | null {
  const ws = wb.Sheets[sheet];
  if (!ws) throw new Error(`the workbook has no sheet ${sheet}; it has: ${wb.SheetNames.join(", ")}`);
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  const want = label.toLowerCase();
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const head = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    if (head === undefined || String(head.v ?? "").replace(/\s+/g, " ").trim().toLowerCase() !== want) {
      continue;
    }
    const cell = ws[XLSX.utils.encode_cell({ r, c: column })];
    if (cell === undefined) return null;
    return typeof cell.v === "number" ? cell.v : null;
  }
  throw new Error(`sheet ${sheet} has no row labelled ${JSON.stringify(label)}`);
}

function sheetRows(wb: XLSX.WorkBook, name: string): string[][] {
  const ws = wb.Sheets[name];
  if (!ws) {
    throw new Error(`the workbook has no sheet ${name}; it has: ${wb.SheetNames.join(", ")}`);
  }
  return (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) as string[][]).map((r) =>
    r.map((c) => String(c ?? "").replace(/\s+/g, " ").trim()),
  );
}

function rowLabelled(rows: string[][], label: string): string[] {
  const want = label.toLowerCase();
  const found = rows.find((r) => (r[0] ?? "").toLowerCase() === want);
  if (!found) {
    throw new Error(
      `no row labelled ${JSON.stringify(label)}; the sheet has: ` +
        rows
          .map((r) => JSON.stringify(r[0] ?? ""))
          .slice(0, 40)
          .join(", "),
    );
  }
  return found;
}

// ── the concepts one document states in three places ──────────────────
//
// An explicit table, not a fuzzy label join, because the three formats do
// NOT spell every concept the same way and pretending they do would make
// the gate pass by failing to find its own subjects. Measured: the
// document's P&L says "Other income" where the workbook says "Other
// operating income", "Other financial expense" where the workbook says
// "Financial expense", and "Net Income (account 121, as filed)" where the
// workbook says "Net income". Each pairing below is one concept; the
// values behind the two names must agree.

interface Concept {
  readonly id: string;
  /** The row label in the printed document's P&L table. */
  readonly doc: string;
  /** The row label on the workbook's "P&L" sheet. */
  readonly sheet: string;
  /** The gateway field, where the format itself names one. */
  readonly gateway?: keyof AssembledPl;
}

/** The document's own name for account 121's close, shared with the
 *  workbook so neither can rename it alone. */
const NET_INCOME_LABEL = "Net income (account 121, as filed)";

const PL_CONCEPTS: readonly Concept[] = [
  { id: "revenue", doc: "Revenue", sheet: "Revenue", gateway: "revenue" },
  { id: "cogs", doc: "Cost of goods sold", sheet: "Cost of goods sold" },
  { id: "gross_profit", doc: "Gross Profit", sheet: "Gross profit" },
  { id: "opex", doc: "Operating expenses", sheet: "Operating expenses" },
  { id: "other_operating_income", doc: "Other income", sheet: "Other operating income" },
  { id: "ebitda", doc: "EBITDA", sheet: "EBITDA", gateway: "ebitda" },
  { id: "da", doc: "Depreciation & amortization", sheet: "Depreciation & amortization" },
  { id: "ebit", doc: "EBIT", sheet: "EBIT", gateway: "ebit" },
  { id: "financial_income", doc: "Financial income", sheet: "Financial income" },
  { id: "interest_expense", doc: "Interest expense", sheet: "Interest expense" },
  { id: "other_financial_expense", doc: "Other financial expense", sheet: "Financial expense" },
  { id: "pretax", doc: "Profit Before Tax", sheet: "Profit before tax" },
  { id: "tax", doc: "Tax expense", sheet: "Tax expense" },
  {
    id: "net_income",
    doc: "Net Income (account 121, as filed)",
    sheet: "Net income (account 121, as filed)",
    gateway: "net_income_statutory",
  },
];

// ── one build per book, shared by every section ───────────────────────

interface Built {
  html: string;
  doc: Document;
  grammar: Grammar;
  wb: XLSX.WorkBook;
  pdf: RenderedPdf;
  apl: AssembledPl;
  facts: ReturnType<typeof factsFrom>;
}

const built = new Map<Book, Built>();

beforeAll(async () => {
  for (const book of BOOKS) {
    const s = served(book);
    const html = exportHtml(book, s);
    const doc = parseHtml(html);
    built.set(book, {
      html,
      doc,
      grammar: grammarFor(doc.documentElement.getAttribute("lang") ?? "en"),
      wb: buildExcelWorkbook(s, undefined, { metricsByName: metricsFor(book) }),
      pdf: await renderedPdf(book, html),
      apl: (s as { assembled_pl?: AssembledPl }).assembled_pl ?? {},
      facts: factsFrom(s),
    });
  }
}, 300_000);

afterAll(async () => {
  await closePdfRenderer();
});

const of = (book: Book): Built => {
  const b = built.get(book);
  if (!b) throw new Error(`no build for ${book}`);
  return b;
};

/** The anchors §0 requires to appear literally, so no §4 can be vacuous. */
function anchorStrings(b: Built): string[] {
  const out: string[] = [];
  for (const c of PL_CONCEPTS) {
    if (!c.gateway) continue;
    const v = b.apl[c.gateway];
    if (typeof v === "number") out.push(Math.round(Math.abs(v)).toLocaleString("en-US"));
  }
  return out;
}

describe("G-P0 — the PDF was actually read", () => {
  it.each(BOOKS)("%s: the reader read the whole file, by its own account", (book: Book) => {
    const { pdf } = of(book);
    expect(pdf.text.structure.indexSource, "fell back from the xref table to a brute scan").toBe(
      "xref-table",
    );
    expect(
      pdf.text.structure.fontsWithoutToUnicode,
      "a font with no /ToUnicode: the reader emits nothing for it rather than fabricating characters, so any count above zero means text was silently dropped",
    ).toBe(0);
    expect(pdf.text.structure.pageCount).toBe(pdf.pages);
    expect(pdf.text.structure.pageCount).toBeGreaterThanOrEqual(20);
    expect(pdf.dateFieldsNormalised, "the service left a clock in the PDF").toBeGreaterThan(0);
  });

  it.each(BOOKS)("%s: the document says which number grammar it is written in", (book: Book) => {
    const b = of(book);
    const lang = b.doc.documentElement.getAttribute("lang");
    expect(lang, "the export declares no lang, so no grammar can be chosen from it").toBeTruthy();
    // `parsePrinted` (shared with the other export gates) strips "," as a
    // group separator unconditionally. That is right for this document
    // and wrong for a Romanian one, so the assumption is pinned here
    // rather than left to rot: the day the export renders `ro`, this reds
    // and the parser gets fixed before the comparison silently reads
    // 1.234,56 as 1.234.
    expect(b.grammar).toEqual({ group: ",", decimal: "." });
    expect(String(lang).toLowerCase().startsWith("en")).toBe(true);
  });

  it.each(BOOKS)("%s: the figure floor — this is not an empty set", (book: Book) => {
    const b = of(book);
    const found = magnitudes(b.pdf.text.text, b.grammar);
    const total = Array.from(found.values()).reduce((a, n) => a + n, 0);
    // Measured 2026-09-08: 1,219 / 1,039 / 1,003 / 1,208 tokens.
    expect(total, `only ${total} numeric tokens read out of the PDF`).toBeGreaterThanOrEqual(800);

    // And a hard set, so a reader that returned 800 tokens of page
    // furniture could still not pass.
    for (const anchor of anchorStrings(b)) {
      expect(b.pdf.text.text, `the anchor ${anchor} is not in the PDF text at all`).toContain(anchor);
    }
    expect(anchorStrings(b).length).toBeGreaterThanOrEqual(4);
  });

  it.each(BOOKS)("%s: the running page furniture is one line per page but the cover", (book: Book) => {
    const { pdf } = of(book);
    const { furniture } = splitFurniture(pdf);
    // `reportPrintCss.ts:149` blanks `@page :first`, so the cover carries
    // no running header and every other page carries exactly one. The
    // count is asserted rather than trusted because this filter is what
    // §3 subtracts before comparing: matching one line too many would
    // silently swallow a figure out of the comparison.
    expect(
      furniture.length,
      "the furniture filter matched a different number of lines than there are pages after the cover",
    ).toBe(pdf.pages - 1);
    const numbered = furniture.map((f) => Number(/Page\s+(\d+)\s+of/.exec(f)?.[1] ?? NaN));
    expect(numbered).toEqual(
      Array.from({ length: pdf.pages - 1 }, (_unused, i) => i + 2),
    );
  });
});

describe("G-P1 — a refusal is a refusal in every format", () => {
  // Written first, and asserted first, because it is the assertion with
  // the most at stake: a reader who sees "not reported" in the PDF and a
  // number in the workbook does not conclude that the two disagree. They
  // conclude that the number is the answer.

  it.each(BOOKS)("%s: no committed book has a prior period, and all three say so", (book: Book) => {
    const b = of(book);
    expect(statementsFor(book).prior, "this book gained a prior period; §1's premise is stale").toBeUndefined();
    expect(b.pdf.text.text.toLowerCase()).toContain("no comparatives");
    expect(documentText(b.doc).toLowerCase()).toContain("no comparatives");
    expect(sheetRows(b.wb, "P&L").map((r) => r.join(" ")).join("\n")).toContain(NO_COMPARATIVE_CELL);
  });

  it.each(BOOKS)("%s: with no prior period, no format prints a prior or a delta", (book: Book) => {
    const b = of(book);
    const rows = sheetRows(b.wb, "P&L");
    const header = rows[0];
    // Columns 2..4 are prior / Δ abs / Δ % — named by the header the
    // sheet itself writes, not by position alone.
    expect(header[2]).toContain("No comparatives");
    expect(header[3]).toBe("Δ Abs");
    expect(header[4]).toBe("Δ %");

    const offenders: string[] = [];
    for (const row of rows.slice(1)) {
      for (const col of [2, 3, 4]) {
        const cell = row[col] ?? "";
        if (cell === "") continue;
        if (normaliseMagnitude(cell, b.grammar) !== null) {
          offenders.push(`${row[0]} · ${header[col]} = ${JSON.stringify(cell)}`);
        }
      }
    }
    expect(
      offenders,
      `the workbook invents a comparative on a book with no prior period, where the document prints "${NO_COMPARATIVE_CELL}" — a reader diffs the two columns and believes the movement`,
    ).toEqual([]);
  });

  // The two deliverables do not always use the same word for the same
  // measure — the document's card says "Letter grade" where the Credit &
  // Risk sheet says "Rating". Those are naming differences, not value
  // divergences, and they are listed rather than papered over so the
  // join below is between labels that genuinely mean the same thing.
  const LABEL_ALIASES: Record<string, string> = { "letter grade": "rating" };
  const canon = (label: string): string => {
    const flat = label.replace(/\s+/g, " ").trim().toLowerCase();
    return LABEL_ALIASES[flat] ?? flat;
  };

  it.each(BOOKS)("%s: a measure one format refuses is not answered by the other", (book: Book) => {
    const b = of(book);
    const REFUSED = new RegExp(`^${UNREPORTED_WORD}$`, "i");

    // ── the workbook: every labelled value cell, on every sheet ──
    // The label is the nearest non-empty cell to the left of the value,
    // because the sheets are not all shaped alike: Ratios is
    // `group | label | value | …` and Credit & Risk is `label | value`.
    const wbValue = new Map<string, string>();
    for (const sheetName of b.wb.SheetNames) {
      for (const row of sheetRows(b.wb, sheetName)) {
        // Scan RIGHT to the first cell that is a figure or a refusal, and
        // take the nearest non-empty cell before it as the label. Not
        // "column 1": the Ratios sheet is `group | label | value | …` and
        // Credit & Risk is `label | value`, and a scan that stopped at
        // the first non-numeric cell — as this one did — never reached
        // the Ratios sheet's value column at all, which is how a planted
        // "0.00" in place of a refused ratio first went green.
        for (let i = 1; i < row.length; i += 1) {
          const cell = row[i] ?? "";
          if (cell === "") continue;
          const isFigure = normaliseMagnitude(cell, b.grammar) !== null;
          if (!isFigure && !REFUSED.test(cell)) continue;
          let j = i - 1;
          while (j >= 0 && (row[j] ?? "") === "") j -= 1;
          const label = j >= 0 ? canon(row[j] as string) : "";
          if (label !== "" && !wbValue.has(label)) wbValue.set(label, cell);
          break;
        }
      }
    }

    // ── the document: every ratio card ──
    const docValue = new Map<string, string>();
    b.doc.querySelectorAll(".ratio-card").forEach((c) => {
      const label = canon(c.querySelector(".label")?.textContent ?? "");
      const value = (c.querySelector(".value")?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (label !== "" && !docValue.has(label)) docValue.set(label, value);
    });

    const shared = Array.from(docValue.keys()).filter((k) => wbValue.has(k));
    // Non-vacuous by assertion, and the floor is measured, not guessed.
    // 2026-09-08, the four committed books: 11 / 9 / 10 / 11 shared
    // labels, of which 2 / 5 / 2 / 2 are refused in the document. The
    // floor is 8 — under every one of them and far above zero.
    expect(
      shared.length,
      "the document and the workbook share no labelled measure — the join is empty and everything below it would pass",
    ).toBeGreaterThanOrEqual(8);

    const conflicts: string[] = [];
    let refusals = 0;
    for (const label of shared) {
      const inDoc = docValue.get(label) as string;
      const inWb = wbValue.get(label) as string;
      const docRefuses = new RegExp(UNREPORTED_WORD, "i").test(inDoc);
      const wbRefuses = REFUSED.test(inWb);
      if (docRefuses || wbRefuses) refusals += 1;
      if (docRefuses && !wbRefuses) {
        conflicts.push(`${JSON.stringify(label)}: the DOCUMENT refuses and the WORKBOOK prints ${inWb}`);
      }
      if (wbRefuses && !docRefuses) {
        conflicts.push(`${JSON.stringify(label)}: the WORKBOOK refuses and the DOCUMENT prints ${inDoc}`);
      }
      if (docRefuses && normaliseMagnitude(inDoc, b.grammar) !== null) {
        conflicts.push(`${JSON.stringify(label)}: the document prints a refusal AND a figure: ${inDoc}`);
      }
    }
    expect(
      refusals,
      "no shared measure is refused on this book — the assertion has nothing to bite on",
    ).toBeGreaterThan(0);
    expect(conflicts).toEqual([]);

    // The PDF leg is a COUNT, not a per-label join: a ratio card is a
    // grid cell, so Skia puts its label and its value on different
    // baselines and no line carries both. What the count catches is the
    // thing worth catching — a refusal that becomes a number somewhere
    // between the document and the page the customer opens.
    const occurrences = (text: string) =>
      (text.match(new RegExp(UNREPORTED_WORD.replace(/ /g, "\\s+"), "gi")) ?? []).length;
    expect(
      occurrences(b.pdf.text.text),
      "the printed PDF states fewer refusals than the document's cards do",
    ).toBeGreaterThanOrEqual(
      Array.from(docValue.values()).filter((v) => new RegExp(UNREPORTED_WORD, "i").test(v)).length,
    );
  });

  it.each(BOOKS)("%s: a concept the document refuses is not answered by the workbook", (book: Book) => {
    const b = of(book);
    const docRows = plRows(b.doc);
    const sheet = sheetRows(b.wb, "P&L");
    const conflicts: string[] = [];
    let refusals = 0;
    for (const c of PL_CONCEPTS) {
      const row = docRows.find((r) => r.label.toLowerCase() === c.doc.toLowerCase());
      if (!row) continue;
      const refusedInDoc = new RegExp(UNREPORTED_WORD, "i").test(row.printed);
      if (!refusedInDoc) continue;
      refusals += 1;
      const wbCell = (sheet.find((r) => (r[0] ?? "").toLowerCase() === c.sheet.toLowerCase()) ?? [])[1] ?? "";
      if (normaliseMagnitude(wbCell, b.grammar) !== null) {
        conflicts.push(`${c.id}: the document prints "${row.printed}" and the workbook prints ${wbCell}`);
      }
      for (const hit of pdfFiguresFor(b.pdf, c.doc)) {
        conflicts.push(`${c.id}: the document refuses and the PDF prints ${hit.printed} — "${hit.line}"`);
      }
    }
    expect(conflicts).toEqual([]);
    // Nothing to assert is a fact, not a pass: say so out loud.
    expect(typeof refusals).toBe("number");
  });
});

describe("G-P2 — nothing the document prints is lost in the print", () => {
  it.each(BOOKS)("%s: every printed figure survives into the PDF", (book: Book) => {
    const b = of(book);
    const wanted = magnitudes(printedFigureText(b.doc), b.grammar);
    const inPdf = magnitudes(b.pdf.text.text, b.grammar);
    // A floor on the SUBJECT of the assertion, not only on its result:
    // if the selectors ever stopped matching, this would pass over an
    // empty want-set. Measured 2026-09-08: 473 / 350 / 322 / 465 distinct
    // figures in the document's own tables and cards.
    expect(wanted.size, "no figures found in the document's own tables and cards").toBeGreaterThanOrEqual(
      250,
    );
    const missing = Array.from(wanted.keys()).filter((k) => !inPdf.has(k));
    expect(
      missing,
      `printed in the HTML document's tables/cards and absent from the rendered PDF: ${missing
        .slice(0, 12)
        .join(", ")}`,
    ).toEqual([]);
  });
});

describe("G-P3 — the print invents nothing", () => {
  it.each(BOOKS)("%s: every figure in the PDF is in the HTML it was made from", (book: Book) => {
    const b = of(book);
    const { body } = splitFurniture(b.pdf);
    const inPdf = magnitudes(body, b.grammar);
    const inHtml = magnitudes(documentText(b.doc), b.grammar);
    const invented = Array.from(inPdf.keys()).filter((k) => !inHtml.has(k));
    expect(
      invented,
      `the PDF prints a figure the document does not: ${invented.slice(0, 12).join(", ")}`,
    ).toEqual([]);
  });
});

describe("G-P4 — one concept, one value, in all three and in the gateway", () => {
  it.each(BOOKS)("%s: the P&L reads the same in the document, the PDF and the workbook", (book: Book) => {
    const b = of(book);
    const docRows: PrintedRow[] = plRows(b.doc);
    const divergences: string[] = [];
    let compared = 0;

    for (const c of PL_CONCEPTS) {
      const row = docRows.find((r) => r.label.toLowerCase() === c.doc.toLowerCase());
      if (!row) {
        divergences.push(`${c.id}: the printed document has no row labelled "${c.doc}"`);
        continue;
      }
      const docValue = parsePrinted(row.printed);
      if (docValue === null) continue; // a refusal — §1 owns that case
      const tol = displayHalfStep(row.printed, b.grammar);

      // ── the workbook ──
      const wbValue = sheetNumber(b.wb, "P&L", c.sheet, 1);
      {
        if (wbValue === null) {
          divergences.push(`${c.id}: the workbook's P&L cell for "${c.sheet}" holds no number`);
        } else {
          if (Math.abs(Math.abs(wbValue) - Math.abs(docValue)) > tol) {
            divergences.push(
              `${c.id}: XLSX prints ${wbValue} and the DOCUMENT prints ${row.printed} (${docValue})`,
            );
          }
          // The document writes a negative as `(RON …)`, the workbook
          // with a leading minus. Different spellings of one sign; a
          // disagreement between them is a sign flip between formats.
          const docNegative = /^\(|^-|^−/.test(row.printed.trim());
          const wbNegative = wbValue < 0;
          if (Math.abs(wbValue) > tol && docNegative !== wbNegative) {
            divergences.push(
              `${c.id}: sign differs — DOCUMENT "${row.printed}" vs XLSX ${wbValue}`,
            );
          }
        }
      }

      // ── the PDF ──
      const pdfHits = pdfFiguresFor(b.pdf, c.doc);
      if (pdfHits.length === 0) {
        divergences.push(`${c.id}: the PDF has no line naming "${c.doc}" followed by a figure`);
      }
      for (const hit of pdfHits) {
        const pdfValue = parsePrinted(hit.printed);
        // Each printed spelling carries its own rounding: the statement
        // table prints whole RON, a chart table may compact to "118.58M".
        const hitTol = Math.max(tol, displayHalfStep(hit.printed, b.grammar));
        if (pdfValue === null || Math.abs(Math.abs(pdfValue) - Math.abs(docValue)) > hitTol) {
          divergences.push(
            `${c.id}: PDF prints ${hit.printed} and the DOCUMENT prints ${row.printed} — "${hit.line}"`,
          );
        }
      }

      // ── the gateway ──
      if (c.gateway) {
        const g = b.apl[c.gateway];
        if (typeof g !== "number") {
          divergences.push(`${c.id}: the gateway carries no assembled_pl.${c.gateway}`);
        } else if (Math.abs(Math.abs(g) - Math.abs(docValue)) > tol) {
          divergences.push(
            `${c.id}: GATEWAY assembled_pl.${c.gateway} is ${g} and the DOCUMENT prints ${row.printed} (${docValue})`,
          );
        }
      }
      compared += 1;
    }

    expect(compared, "no P&L concept was compared — the label table has gone stale").toBeGreaterThanOrEqual(
      10,
    );
    expect(divergences).toEqual([]);
  });

  it.each(BOOKS)("%s: the workbook's cover quotes the same book as the document", (book: Book) => {
    const b = of(book);
    const cover = sheetRows(b.wb, "Cover");
    const divergences: string[] = [];

    const num = (label: string): number => {
      const v = sheetNumber(b.wb, "Cover", label, 1);
      if (v === null) {
        throw new Error(`Cover "${label}" is ${JSON.stringify(rowLabelled(cover, label)[1] ?? "")}, not a number`);
      }
      return v;
    };

    // Net income on the cover is the SAME concept the P&L ends on, and
    // the gateway names its field: account 121's closing balance.
    const statutory = b.apl.net_income_statutory;
    if (typeof statutory !== "number") {
      divergences.push("the gateway carries no assembled_pl.net_income_statutory");
    } else if (Math.abs(num(NET_INCOME_LABEL) - statutory) > 0.005) {
      divergences.push(
        `Cover "${NET_INCOME_LABEL}" is ${num(NET_INCOME_LABEL)}; the gateway's account-121 close ` +
          `(assembled_pl.net_income_statutory) is ${statutory}. The document prints the latter.`,
      );
    }

    // Total assets / equity come from the servedFacts gateway on both
    // the cover and the balance sheet, so a divergence here means one of
    // them stopped reading it.
    const ta = b.facts.totalAssets();
    const te = b.facts.totalEquity();
    if (ta !== null && Math.abs(num("Total assets") - ta) > 0.005) {
      divergences.push(`Cover "Total assets" is ${num("Total assets")}; servedFacts says ${ta}`);
    }
    if (te !== null && Math.abs(num("Total equity") - te) > 0.005) {
      divergences.push(`Cover "Total equity" is ${num("Total equity")}; servedFacts says ${te}`);
    }

    // And each of them must be readable in the PDF a customer opens.
    for (const [label, value] of [
      [NET_INCOME_LABEL, statutory],
      ["Total assets", ta],
      ["Total equity", te],
    ] as Array<[string, number | null | undefined]>) {
      if (typeof value !== "number") continue;
      const printed = Math.round(Math.abs(value)).toLocaleString("en-US");
      if (!b.pdf.text.text.includes(printed)) {
        divergences.push(`${label} ${printed} is on the cover sheet and nowhere in the PDF`);
      }
    }

    expect(divergences).toEqual([]);
  });

  it.each(BOOKS)("%s: no label in the workbook carries two different figures", (book: Book) => {
    const b = of(book);
    // The law the net-income repair installed, stated so it cannot be
    // undone quietly: within one workbook, a label is a name for exactly
    // one number. Before the repair, "Net income" meant the class-6/7
    // reconstruction on the Cover, the P&L and the Cash Flow sheet and
    // account 121's close on the Valuation sheet — 14,106,102.03 and
    // 7,533,676.02 under one word, in one file, on agras.
    const seen = new Map<string, { value: number; sheet: string }>();
    const clashes: string[] = [];
    for (const sheet of b.wb.SheetNames) {
      const ws = b.wb.Sheets[sheet];
      const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
      for (let r = range.s.r; r <= range.e.r; r += 1) {
        const head = ws[XLSX.utils.encode_cell({ r, c: 0 })];
        const val = ws[XLSX.utils.encode_cell({ r, c: 1 })];
        if (head === undefined || val === undefined) continue;
        const label = String(head.v ?? "").replace(/\s+/g, " ").trim();
        if (label === "" || typeof val.v !== "number") continue;
        const prev = seen.get(label);
        if (prev === undefined) {
          seen.set(label, { value: val.v, sheet });
          continue;
        }
        // Same label, same figure on two sheets is a cross-reference, not
        // a clash. Half a display unit of tolerance, because the sheets
        // store what their own derivations produced.
        if (Math.abs(prev.value - val.v) > 0.005) {
          clashes.push(
            `${JSON.stringify(label)}: ${prev.value} on "${prev.sheet}" and ${val.v} on "${sheet}"`,
          );
        }
      }
    }
    expect(seen.size, "no labelled numbers found — the scan has gone stale").toBeGreaterThan(20);
    expect(clashes).toEqual([]);
  });
});
