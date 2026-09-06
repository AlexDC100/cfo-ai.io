// Mount the Comprehensive Report over a REAL served period response, for
// each of the four firm books. Shared by the two rendered-output gates:
//
//   oneConceptOneValue.test.tsx  (G1) — no two places state a different
//                                       number for the same concept
//   plBuildUpFoots.test.tsx      (G2) — every build-up sums to the
//                                       figure it ends on, to the cent
//
// Both halves of the response come from committed REAL engine output,
// captured by `tests/engine/fixtures/firm/capture.py` (statements) and
// `capture_served_metrics.py` (metrics). Nothing here is hand-built:
// a metrics list written by hand would agree with the statements by
// construction and could not have caught the defect these gates exist
// for, which lives precisely in the disagreement BETWEEN the two halves
// the engine really serves.
//
// `tests/engine/test_one_concept_one_value.py::
// test_the_served_metrics_fixture_matches_the_live_engine` recomputes
// the metrics half live and reds if this fixture goes stale, so these
// gates cannot pass over a payload production never serves.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import ComprehensiveReport from "@/pages/cfo/ComprehensiveReport";

export const BOOKS = ["agras", "carniprod", "realestate", "retail"] as const;
export type Book = (typeof BOOKS)[number];

const repoRoot = resolve(__dirname, "../../..");
const firm = (name: string) =>
  resolve(repoRoot, "tests/engine/fixtures/firm", name);

type Statements = {
  assembled_pl: Record<string, number>;
  assembled_bs: Record<string, number>;
  assembled_cf: Record<string, unknown>;
  incomeStatement: Record<string, number>;
  companyName?: string;
};

type Fixture = {
  currency: string;
  period_end: string;
  statements: Statements;
  line_items?: Array<Record<string, unknown>>;
};

const SERVED_METRICS = JSON.parse(
  readFileSync(firm("served_metrics.json"), "utf-8"),
) as Record<Book, Record<string, number | null>>;

export function fixtureFor(book: Book): Fixture {
  return JSON.parse(
    readFileSync(firm(`saga_10_col_${book}.json`), "utf-8"),
  ) as Fixture;
}

export function metricsFor(book: Book): Record<string, number | null> {
  return SERVED_METRICS[book];
}

/** The shape `GET /api/period/{id}` answers with, for one book. */
export function periodResponse(book: Book) {
  const fx = fixtureFor(book);
  return {
    period: {
      id: `p-${book}`,
      period_end: fx.period_end,
      currency: fx.currency,
      source_document: { filename: `${book}.xlsx`, id: `d-${book}` },
    },
    statements: { companyName: book, ...fx.statements },
    metrics: Object.entries(metricsFor(book)).map(([name, value]) => ({
      name,
      value,
      unit: "RON",
      direction: "neutral",
    })),
    line_items: fx.line_items ?? [],
    alerts: [],
    recommendations: [],
  };
}

/** Render the whole report for one book and hand back its root element. */
export async function mountReport(book: Book): Promise<HTMLElement> {
  const body = periodResponse(book);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[`/report?period=p-${book}`]}>
        <ComprehensiveReport />
      </MemoryRouter>
    </TooltipProvider>,
  );
  return screen.findByTestId("comprehensive-report");
}

/** Every `<tr>` of a section, as `[label, printed amount]`. */
export function tableRows(section: Element): Array<[string, string]> {
  return Array.from(section.querySelectorAll("tr"))
    .map((tr) => Array.from(tr.querySelectorAll("td")))
    .filter((tds) => tds.length >= 2)
    .map(
      (tds) =>
        [
          (tds[0].textContent ?? "").replace(/\s+/g, " ").trim(),
          (tds[1].textContent ?? "").replace(/\s+/g, " ").trim(),
        ] as [string, string],
    );
}

/** The gap glyph `<Amount>` paints for an absent figure. */
export const MISSING = "—";

/** The magnitude suffix `<Amount>` may compact a money figure to. */
function magnitudeOf(printed: string): number {
  const t = printed.replace(/[\u202f\u2009\u00a0]/g, " ");
  if (/\bB\b/.test(t)) return 1e9;
  if (/\bM\b/.test(t)) return 1e6;
  if (/\bK\b/.test(t)) return 1e3;
  return 1;
}

/**
 * Parse a printed money string back to a number.
 *
 * `null` for the gap glyph, `undefined` for text that is not a figure at
 * all. An abbreviated magnitude ("18.4 M RON") parses to 18,400,000 — a
 * faithful reading of what the reader was shown. HOW MUCH PRECISION that
 * reading carries is a separate question, and `halfStep` is how a caller
 * asks it: a gate that compared a compacted figure against an exact one
 * without widening its tolerance would be checking a rounding, and one
 * that refused to read it at all would be blind to half the page.
 */
export function parseMoney(printed: string): number | null | undefined {
  const text = printed.trim();
  if (text === MISSING || text === "") return null;
  const unit = magnitudeOf(text);
  const cleaned = text
    .replace(/[\u202f\u2009\u00a0]/g, "")
    .replace(/RON|EUR|USD|\u20ac|\$|[KMB]/g, "")
    .replace(/\((.*)\)/, "-$1") // accounting negatives
    .replace(/[^\d,.\-\u2212]/g, "")
    .replace(/\u2212/g, "-")
    .trim();
  // en-US grouping: 1,234,567.89
  const n = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(n) ? n * unit : undefined;
}

/**
 * Half a display step of a printed money figure: 50,000 for "18.4 M RON",
 * 0.5 for "18,420,491". Two printings of ONE figure at different
 * magnitudes agree when they fall within the coarser of the two steps;
 * anything wider is a different number wearing the same label.
 */
export function halfStep(printed: string): number {
  const t = printed.replace(/[\u202f\u2009\u00a0]/g, " ");
  const decimals =
    (t.match(/[.,](\d+)(?=\s*(?:[KMB]\b|[A-Z\u20ac$]|$))/) ?? [, ""])[1]?.length ?? 0;
  return magnitudeOf(t) / Math.pow(10, decimals) / 2;
}

/** True when the printing carries every cent — no magnitude compaction. */
export function isCentExact(printed: string): boolean {
  return magnitudeOf(printed) === 1;
}
