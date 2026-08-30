// THE SURFACE THAT BROKE — Statements → Notes, rendered at EUR display.
//
// The production audit found 10 of 67 alert rows (6 orgs, 6 periods)
// showing a EUR-display user TWO currencies at once, and every one of
// them on this surface: `StatementNotes` rendered `alert.title` RAW one
// line above a linkified, converting `alert.body`. All five live
// `concentration_intercompany_loan` rows — the reported 461 defect's own
// rule — were still two-currency here after the containment fix, because
// containment landed inside the body's linkifier and the title never went
// through it.
//
// These tests render the real card with the real production row and
// assert the whole card speaks one currency. They fail on the pre-fix
// code (the title's "RON 7,692,203" survives verbatim).

import { describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const RATES = { EUR: 1, RON: 5.2489, USD: 1.16 };

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "EUR",
    rates: { rates: RATES, as_of: "2026-05-22", source: "BNR", stale: false },
    setDisplay: () => {},
    refresh: async () => {},
    refreshing: false,
  }),
  useDisplayCurrency: () => "EUR",
  useRates: () => ({ rates: RATES }),
  useAmountFormatter: () => (v: number | null | undefined) => String(v ?? ""),
}));

import { StatementNotes } from "@/components/cfo/StatementNotes";
import type { PeriodAlertItem } from "@/lib/activePeriod";

// period 11b8e759, verbatim — including the templates the engine now emits.
const ALERT: PeriodAlertItem = {
  id: "a1",
  alert_key: "concentration_intercompany_loan:11b8e759",
  rule_key: "concentration_intercompany_loan",
  severity: "high",
  category: "data_quality",
  title: "Intercompany receivable RON 7,692,203 = 19.6% of total assets",
  body:
    "Account 461 (Debitori diverși) holds RON 7,692,203 due from related " +
    "parties — 19.6% of total assets RON 39,194,178. Recoverability and " +
    "intent on settlement should be confirmed.",
  title_template:
    "Intercompany receivable {{money:intercompany_loans}} = 19.6% of total assets",
  body_template:
    "Account 461 (Debitori diverși) holds {{money:intercompany_loans}} due from related " +
    "parties — 19.6% of total assets {{money:total_assets}}. Recoverability and " +
    "intent on settlement should be confirmed.",
  facts_cited: {
    intercompany_loans: 7692202.74,
    total_assets: 39194178.46,
    pct_of_assets: 0.19625880786990732,
  },
  fact_units: {
    intercompany_loans: "money",
    total_assets: "money",
    pct_of_assets: "percent",
  },
  source_currency: "RON",
  industry: "real_estate_commercial",
};

function renderNotes(alerts: PeriodAlertItem[]) {
  return render(
    <MemoryRouter>
      <StatementNotes recommendations={[]} alerts={alerts} relevantTo="bs" />
    </MemoryRouter>,
  );
}

describe("S1 — the Notes card speaks one currency", () => {
  it("the TITLE no longer keeps its native RON figure beside a converted body", () => {
    cleanup();
    const { container } = renderNotes([ALERT]);
    const text = container.textContent ?? "";
    expect(text).toContain("Intercompany receivable");
    // The exact string 10 live rows still showed a EUR user.
    expect(text).not.toContain("RON 7,692,203");
    expect(text).not.toMatch(/\bRON\b/);
  });

  it("every money figure on the card — title and body — is one currency", () => {
    cleanup();
    const { container } = renderNotes([ALERT]);
    const currencies = Array.from(
      container.querySelectorAll("[data-narrative-money]"),
    ).map((n) => n.getAttribute("data-narrative-currency"));
    expect(currencies.length).toBeGreaterThanOrEqual(3); // 1 title + 2 body
    expect(new Set(currencies).size).toBe(1);
    expect(currencies[0]).toBe("EUR");
  });

  it("the ratio is untouched — it is dimensionless and native by construction", () => {
    cleanup();
    const { container } = renderNotes([ALERT]);
    expect(container.textContent ?? "").toContain("19.6%");
  });

  it("a row written before templates still renders its stored prose", () => {
    cleanup();
    const legacy: PeriodAlertItem = {
      ...ALERT,
      id: "a2",
      title_template: null,
      body_template: null,
      fact_units: null,
      source_currency: null,
    };
    const { container } = renderNotes([legacy]);
    expect(container.textContent ?? "").toContain("Account 461");
  });
});
