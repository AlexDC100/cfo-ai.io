// A REFUSED EBITDA STAYS REFUSED ON THE SURFACES THE P&L BUILDER FEEDS.
//
// THE ONE EBITDA (owner ruling 2026-09-26). When the stock variation (711)
// cannot be measured — a closed book without account 121, a 121 whose
// opening is not shown cleared — the engine REFUSES EBITDA, EBIT and profit
// before tax with a typed reason. The P&L builder used to fill that hole
// with an EBITDA of its own (the build-up WITHOUT 711 — another
// definition); it now states it refused (null + the reason). Every surface
// downstream of it must then say so, and none may read the null as 0:
// `Math.round(null)` is 0, `null + x` is x, `format(null)` is "RON 0".
//
// THE BOOKS: the two refused CONSTRUCTED books of net-711-rule, captured
// through the real write seam and route
// (fixtures/oneEbitda/constructed_books.json), and the bridge book as the
// control that still prints its figures.
//
// WHAT IT REDS ON (TC-11): the dashboard headline, the year-0 strip, the
// key-metric card or the recommendation facts turning a refused EBITDA (or
// a refused net result) into a zero or a figure; the refusal reason missing
// where the figure would have stood.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { YearZeroStrip } from "@/components/forecast/YearZeroStrip";
import { KeyMetricsRow } from "@/components/cfo/KeyMetricsRow";
import { canonicalMarginsFrom, computeDashboardHeadline } from "@/lib/dashboardHeadline";
import { buildPeriodFacts } from "@/lib/periodFacts";
import type { ActivePeriod, PeriodLineItem } from "@/lib/activePeriod";
import type { ApiLineItem } from "@/lib/plStructure";
import type { Statements } from "@/lib/financialReport";

import constructed from "./fixtures/oneEbitda/constructed_books.json";

type Body = { statements: Statements; line_items: PeriodLineItem[] };
const BOOKS = constructed as unknown as Record<string, Body>;
const book = (name: string): Body => JSON.parse(JSON.stringify(BOOKS[name])) as Body;

function periodOf(name: string): ActivePeriod {
  const b = book(name);
  return {
    id: `p-${name}`, label: name, periodEnd: "2025-12-31", industry: null,
    statements: b.statements, invoices: null, metrics: [], recommendations: [], alerts: [],
    briefing: null, availableTypes: ["bilant", "pl"], isLoaded: true, isLoading: false,
    source: "upload", valuation: null, lineItems: b.line_items, detectedType: "trial_balance",
    sourceDocumentFilename: null, notFound: false, assembled_metrics: null,
  } as ActivePeriod;
}

function headlineOf(name: string) {
  const p = periodOf(name);
  return computeDashboardHeadline({
    statements: p.statements!, lineItems: p.lineItems, metrics: p.metrics,
    entity: "E", canonicalMargins: canonicalMarginsFrom(p.metrics),
  });
}

const refusalOf = (name: string) =>
  (book(name).statements.assembled_pl as unknown as { ebitda_refusal: { code: string; text_ro: string; text_en: string } })
    .ebitda_refusal;

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("the dashboard headline", () => {
  for (const name of ["unanchored", "g6_uncleared"]) {
    it(`${name}: EBITDA is null with the engine's refusal — never a number`, () => {
      const h = headlineOf(name);
      expect(h.tileEbitdaRon).toBeNull();
      expect(h.tileEbitdaRefusal?.code).toBe(refusalOf(name).code);
    });
  }
  it("closed_bridge (control): the served EBITDA, no refusal", () => {
    const h = headlineOf("closed_bridge");
    expect(h.tileEbitdaRon).toBe(
      (book("closed_bridge").statements.assembled_pl as Record<string, number>).ebitda,
    );
    expect(h.tileEbitdaRefusal).toBeNull();
  });
});

describe("the year-0 strip states the refusal in the reader's language", () => {
  it("unanchored: EN and RO — the value cell IS the engine's sentence, no figure beside it", async () => {
    for (const lang of ["en", "ro"] as const) {
      await i18n.changeLanguage(lang);
      render(<YearZeroStrip period={periodOf("unanchored")} currency="RON" locale="en-US" />);
      const r = refusalOf("unanchored");
      const value = screen.getByTestId("forecast-year0-ebitda").querySelector("dd")?.textContent;
      expect(value).toBe(lang === "ro" ? r.text_ro : r.text_en);
      cleanup();
    }
  });
});

describe("the key-metric card states the refusal, never 0", () => {
  it("a refused item prints its reason where the amount would stand", () => {
    renderWithProviders(
      <KeyMetricsRow
        currency="RON"
        items={[
          { label: "EBITDA", desc: "d", value: null, refused: "the stock variation cannot be measured", trend: null, testid: "km-ebitda" },
          { label: "Cash", desc: "d", value: 1234.5, trend: null, testid: "km-cash" },
        ]}
      />,
    );
    expect(screen.getByTestId("km-ebitda-refused").textContent).toBe("the stock variation cannot be measured");
    expect(screen.getByTestId("km-ebitda-amount").textContent ?? "").not.toMatch(/\d/);
    expect(screen.getByTestId("km-cash-amount").textContent ?? "").toMatch(/1/);
  });
});

describe("the recommendation facts carry the absence", () => {
  for (const name of ["unanchored", "g6_uncleared"]) {
    it(`${name}: EBITDA and everything built on it is null, not 0`, () => {
      const b = book(name);
      const facts = buildPeriodFacts({
        periodId: `p-${name}`, statements: b.statements, lineItems: b.line_items as unknown as ApiLineItem[],
        valuation: null, industry: null,
      });
      expect(facts.pl.ebitda).toBeNull();
      // The retired second EBITDA (EBITDA − 722) is no longer a fact at all.
      expect("ebitda_excl_capitalized" in facts.pl).toBe(false);
      expect(facts.ratios.ebitda_margin_gross).toBeNull();
      expect(facts.pl.ebit).toBeNull();
      expect(facts.pl.profit_before_tax).toBeNull();
      expect(facts.ratios.debt_to_ebitda_adjusted).toBeNull();
    });
  }

  it("unanchored: the net result is refused too, and the cash-flow proxy says absent (NaN), not a figure from zero", () => {
    const b = book("unanchored");
    const facts = buildPeriodFacts({
      periodId: "p-unanchored", statements: b.statements, lineItems: b.line_items as unknown as ApiLineItem[],
      valuation: null, industry: null,
    });
    expect(facts.pl.net_profit).toBeNull();
    expect(facts.bs.current_year_pnl).toBeNull();
    expect(Number.isNaN(facts.cf.cash_from_operating)).toBe(true);
  });

  it("closed_bridge (control): the facts are the served figures", () => {
    const b = book("closed_bridge");
    const apl = b.statements.assembled_pl as Record<string, number>;
    const facts = buildPeriodFacts({
      periodId: "p-bridge", statements: b.statements, lineItems: b.line_items as unknown as ApiLineItem[],
      valuation: null, industry: null,
    });
    expect(facts.pl.ebitda).toBe(apl.ebitda);
    expect(facts.pl.net_profit).toBe(apl.net_income_statutory);
  });
});
