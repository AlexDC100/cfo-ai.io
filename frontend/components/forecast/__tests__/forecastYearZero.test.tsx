// @vitest-environment jsdom
/**
 * GATE F1 — year 0 of the forecast IS the latest actuals the dashboard shows
 * (frontend half; engine half: tests/engine/test_forecast_f_gates.py F1).
 *
 * The Forecast page's year-0 strip and the dashboard's headline cards are ONE
 * computation (`lib/dashboardHeadline.computeDashboardHeadline`) over ONE
 * served period payload. This renders the strip over the four corpus books'
 * REAL served statements and line items (the same fixtures the dashboard's own
 * headline gates read) and holds:
 *   · every painted year-0 figure is the dashboard function's own output;
 *   · those figures are the served fields the ENGINE's anchor reads
 *     (assembled_pl.revenue, assembled_pl.ebitda, net_income_statutory,
 *     assembled_bs.cash) — the engine half holds its anchor equal to the same
 *     fields, so year 0 on this page, on the dashboard and under the
 *     projection is one set of numbers;
 *   · the dashboard computes its headline through the same function (a second
 *     inline derivation on either surface is how two numbers drift apart).
 *
 * RED ON (TC-11): a year-0 figure that is not the dashboard function's; the
 * dashboard headline no longer computed by that function; a year-0 figure
 * that is not the served field the engine's anchor reads; the strip painting
 * a projection primitive (it is ACTUALS).
 * CANNOT SEE: the dashboard's display-currency conversion (year 0 is printed
 * in the book's own currency, like the projection beside it).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/i18n";
import { YearZeroStrip } from "@/components/forecast/YearZeroStrip";
import { canonicalMarginsFrom, computeDashboardHeadline } from "@/lib/dashboardHeadline";
import type { ActivePeriod, PeriodLineItem } from "@/lib/activePeriod";
import { BOOKS, statementsFor, type Book } from "@/lib/__tests__/exportBooks";

const REPO = resolve(__dirname, "../../../..");

function lineItemsFor(book: Book): PeriodLineItem[] {
  return (JSON.parse(
    readFileSync(resolve(REPO, `tests/engine/fixtures/firm/saga_10_col_${book}.json`), "utf-8"),
  ) as { line_items: PeriodLineItem[] }).line_items;
}

function periodFor(book: Book): ActivePeriod {
  const statements = statementsFor(book);
  return {
    id: `p-${book}`, label: statements.companyName ?? book, periodEnd: "2025-12-31",
    industry: null, statements, invoices: null, metrics: [], recommendations: [],
    alerts: [], briefing: null, availableTypes: ["bilant", "pl"], isLoaded: true,
    isLoading: false, source: "upload", valuation: null, lineItems: lineItemsFor(book),
    detectedType: "trial_balance", sourceDocumentFilename: null, notFound: false,
    assembled_metrics: null,
  } as ActivePeriod;
}

afterEach(() => cleanup());

describe("gate F1: year 0 is the dashboard's headline, on the served fields the engine reads", () => {
  for (const book of BOOKS) {
    it(`${book}: every year-0 figure is the dashboard's, and the engine's anchor field`, async () => {
      await i18n.changeLanguage("en");
      const period = periodFor(book);
      const headline = computeDashboardHeadline({
        statements: period.statements!,
        lineItems: period.lineItems,
        metrics: period.metrics,
        entity: i18n.t("dash.entity"),
        canonicalMargins: canonicalMarginsFrom(period.metrics),
      });
      render(<YearZeroStrip period={period} currency="RON" locale="en-US" />);
      const painted = (id: string) =>
        Number(screen.getByTestId(`forecast-year0-${id}`).getAttribute("data-actual-value"));
      expect(painted("revenue")).toBe(headline.netTurnover);
      expect(painted("ebitda")).toBe(headline.tileEbitdaRon);
      expect(painted("net_profit")).toBe(headline.tileNetProfitRon);
      expect(painted("cash")).toBe(headline.cash);
      // …and they are the served fields the engine's anchor reads.
      const apl = (period.statements as unknown as { assembled_pl: Record<string, number> })
        .assembled_pl;
      const abs = (period.statements as unknown as { assembled_bs: Record<string, number> })
        .assembled_bs;
      expect(painted("revenue")).toBe(apl.revenue);
      expect(painted("ebitda")).toBe(apl.ebitda);
      expect(painted("net_profit")).toBe(apl.net_income_statutory);
      expect(painted("cash")).toBe(abs.cash);
      // The strip is ACTUALS: nothing in it wears the projected mark.
      expect(screen.getByTestId("forecast-year0").getAttribute("data-actual")).toBe("true");
      expect(document.querySelector('[data-projected="true"]')).toBeNull();
      // Painted, formatted, not a dash where a value exists.
      for (const id of ["revenue", "ebitda", "net_profit", "cash"]) {
        const text = screen.getByTestId(`forecast-year0-${id}`).querySelector("dd")?.textContent ?? "";
        expect(text).toMatch(/\d/);
      }
    });
  }

  it("the dashboard computes its headline through the SAME function", () => {
    const page = readFileSync(resolve(REPO, "frontend/pages/cfo/FinancialStatements.tsx"), "utf8");
    const code = page
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).toMatch(/computeDashboardHeadline\(\{/);
    // The inline derivation it replaced may not come back beside it.
    expect(code).not.toMatch(/pl\.sections\[0\]\?\.subtotalAmount\s*\?\?/);
    const strip = readFileSync(resolve(REPO, "frontend/components/forecast/YearZeroStrip.tsx"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(strip).toMatch(/computeDashboardHeadline\(\{/);
    expect(strip).not.toMatch(/forecastFacts|ProjectedMinor|unwrapProjected/);
  });
});
