// The PRINTED report, parsed from its own bytes, for each of the four
// firm books.
//
// `frontend/lib/__tests__/reportBooks.tsx` is the same idea for the
// on-screen `/report` page. This is its half for the OTHER deliverable —
// the standalone HTML the Export tab writes to disk (`buildReportHtml`),
// which is the artefact the owner reads. The two surfaces render from the
// same served envelope and had drifted apart: on 2026-09-07 the screen's
// P&L build-up footed to the cent and carried its bridge to account 121,
// while the printed document jumped 6,572,426.01 RON between "Profit
// Before Tax − Tax expense" and "Net Income" with no line and no name.
//
// Every gate that reads this harness asserts over the RENDERED document
// (TC-7): the labels, the printed figures, the caption sentences and the
// recommendation prose a reader actually sees, parsed back out of the
// `<!doctype html>` string. Nothing here asserts over `computeRatios`'
// return value alone — a defect that lives in the render is invisible
// there, and three of the five defects this wave repaired did.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildReportHtml } from "@/lib/financialExports";
import type { Statements } from "@/lib/financialReport";

export const BOOKS = ["agras", "carniprod", "realestate", "retail"] as const;
export type Book = (typeof BOOKS)[number];

const repoRoot = resolve(__dirname, "../../..");
const firm = (name: string) => resolve(repoRoot, "tests/engine/fixtures/firm", name);

const SERVED_METRICS = JSON.parse(
  readFileSync(firm("served_metrics.json"), "utf-8"),
) as Record<Book, Record<string, number | null>>;

export type BookStatements = Statements & {
  assembled_pl?: Record<string, number>;
  assembled_bs?: Record<string, number>;
};

export function statementsFor(book: Book): BookStatements {
  const fx = JSON.parse(readFileSync(firm(`saga_10_col_${book}.json`), "utf-8")) as {
    statements: BookStatements;
  };
  return fx.statements;
}

export function metricsFor(book: Book): Record<string, number | null> {
  return SERVED_METRICS[book] ?? {};
}

// ── THE WORKSPACE SETTING, WHICH THE BOOK ALONE DOES NOT CARRY ────────
//
// `saga_10_col_*.json` is captured from a book with no workspace
// attached, so every one of them carries `industry: null`. A null
// industry agrees with nothing and disagrees with nothing — so the case
// the owner actually met, a LIVE Agras report headed "Real estate ·
// residential rental" over a book of 301/341/345/371 and 70.5M of cost
// of sales, was reachable from no committed artefact and the block that
// exists for it was exercised only by payloads a test built by hand.
//
// These three files are the served response, in the three pieces the
// route assembles it from (pipeline.py:7711):
//
//   saga_10_col_<book>.json   .statements          ← the book
//   workspace_industry.json   .displays[<key>]     ← statements.industry
//   industry_signal.json      [<book>][<key>]      ← statements.industry_signal
//
// All three are real engine output. `servedAs()` performs the join and
// nothing else; no test composes it privately any more.

interface WorkspaceIndustryFixture {
  displays: Record<string, string>;
  books: Record<Book, { structural_family: string; agrees: string; disputes: string }>;
}

const WORKSPACE_INDUSTRY = JSON.parse(
  readFileSync(firm("workspace_industry.json"), "utf-8"),
) as WorkspaceIndustryFixture;

const INDUSTRY_SIGNALS = JSON.parse(
  readFileSync(firm("industry_signal.json"), "utf-8"),
) as Record<Book, Record<string, unknown>>;

/** Which workspace key each book agrees with, and which it disputes. */
export function workspaceKeys(book: Book): { agrees: string; disputes: string } {
  const row = WORKSPACE_INDUSTRY.books[book];
  return { agrees: row.agrees, disputes: row.disputes };
}

export function workspaceDisplay(key: string): string {
  const display = WORKSPACE_INDUSTRY.displays[key];
  if (display === undefined) {
    throw new Error(`workspace_industry.json states no display for key ${JSON.stringify(key)}`);
  }
  return display;
}

/** The book as `GET /api/period/{id}` serves it for one workspace setting. */
export function servedAs(book: Book, key: string): BookStatements {
  const signal = INDUSTRY_SIGNALS[book][key];
  if (signal === undefined) {
    throw new Error(
      `industry_signal.json carries no ${book}/${key}; it carries: ` +
        Object.keys(INDUSTRY_SIGNALS[book]).join(", "),
    );
  }
  return {
    ...statementsFor(book),
    industry: workspaceDisplay(key),
    industry_signal: signal,
  };
}

/** THE OWNER'S CASE, per book: the mix and the workspace disagree. */
export function disputedBook(book: Book): BookStatements {
  return servedAs(book, workspaceKeys(book).disputes);
}

/** The same book under the setting its own account mix seconds. */
export function agreeingBook(book: Book): BookStatements {
  return servedAs(book, workspaceKeys(book).agrees);
}

/** The whole printed document, as the Export tab writes it. */
export function exportHtml(book: Book, statements = statementsFor(book)): string {
  return buildReportHtml(statements, { metricsByName: metricsFor(book) });
}

export function exportDoc(book: Book, statements = statementsFor(book)): Document {
  return new DOMParser().parseFromString(exportHtml(book, statements), "text/html");
}

export interface PrintedRow {
  label: string;
  printed: string;
  /** `subtotal` / `total` carry the document's own row classes. */
  cls: string;
}

/** Every row of the printed P&L table, in document order. */
export function plRows(doc: Document): PrintedRow[] {
  const table = Array.from(doc.querySelectorAll("table.fin")).find((t) =>
    /Profit\s*&\s*Loss/i.test((t.querySelector("th")?.textContent ?? "").trim()),
  );
  if (!table) throw new Error("the printed document carries no Profit & Loss table");
  return Array.from(table.querySelectorAll("tbody tr"))
    .map((tr) => ({ tr, tds: Array.from(tr.querySelectorAll("td")) }))
    .filter(({ tds }) => tds.length >= 2)
    .map(({ tr, tds }) => ({
      label: (tds[0].textContent ?? "").replace(/\s+/g, " ").trim(),
      printed: (tds[1].textContent ?? "").replace(/\s+/g, " ").trim(),
      cls: tr.getAttribute("class") ?? "",
    }));
}

export interface PrintedCard {
  label: string;
  value: string;
  meta: string;
}

/** Every `.ratio-card` in the document — the KPI strip and every ratio. */
export function ratioCards(doc: Document): PrintedCard[] {
  return Array.from(doc.querySelectorAll(".ratio-card")).map((c) => ({
    label: (c.querySelector(".label")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    value: (c.querySelector(".value")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    meta: (c.querySelector(".meta")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  }));
}

export function cardNamed(doc: Document, label: string): PrintedCard {
  const found = ratioCards(doc).find((c) => c.label === label);
  if (!found) {
    throw new Error(
      `the printed document states no card labelled ${JSON.stringify(label)}; it states: ` +
        ratioCards(doc)
          .map((c) => JSON.stringify(c.label))
          .join(", "),
    );
  }
  return found;
}

/** The `.commentary` / `.risk` prose blocks — the document's captions. */
export function proseBlocks(doc: Document): string[] {
  return Array.from(doc.querySelectorAll(".commentary, .risk")).map((c) =>
    (c.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

/** The rendered recommendation cards, as prose. */
export function recommendationTexts(doc: Document): string[] {
  return Array.from(doc.querySelectorAll(".rec")).map((c) =>
    (c.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

// ── reading a printed figure back ─────────────────────────────────────
//
// `money()` in the renderer compacts: 18,420,491.28 prints as
// "RON 18,420,491" in a table and "RON 18.42M" inside a sentence. A gate
// that parsed only one of the two spellings would be blind to half the
// document, and one that compared a compacted figure against an exact one
// without widening its tolerance would be checking a rounding.

// The suffix rides the digits with no space — `formatCurrency` writes
// "RON 7.53M", not "RON 7.53 M" — so a `\bM\b` test never fires (there is
// no word boundary between "3" and "M"). Anchor on the digit instead.
const MAG: Array<[RegExp, number]> = [
  [/\d\s*B(?![A-Za-z])/, 1e9],
  [/\d\s*M(?![A-Za-z])/, 1e6],
  [/\d\s*K(?![A-Za-z])/, 1e3],
];

function magnitudeOf(printed: string): number {
  const t = printed.replace(/[   ]/g, " ");
  for (const [re, mult] of MAG) if (re.test(t)) return mult;
  return 1;
}

/** Parse a printed money / multiple / percentage back to a number. */
export function parsePrinted(printed: string): number | null {
  const text = printed.trim();
  if (text === "" || /not reported/i.test(text)) return null;
  const unit = magnitudeOf(text);
  const cleaned = text
    .replace(/[   ]/g, "")
    .replace(/RON|EUR|USD|€|\$|[KMB]|[×x]|%|days?|\/\s*100/gi, "")
    .replace(/\((.*)\)/, "-$1")
    .replace(/[^\d,.\-−]/g, "")
    .replace(/−/g, "-")
    .trim();
  const n = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(n) ? n * unit : null;
}

/** Half a display step of a printed figure — the widest a rounding can be. */
export function halfStep(printed: string): number {
  const t = printed.replace(/[   ]/g, " ");
  const decimals = (t.match(/[.,](\d+)(?!.*[.,]\d)/) ?? [, ""])[1]?.length ?? 0;
  return magnitudeOf(t) / Math.pow(10, decimals) / 2;
}
