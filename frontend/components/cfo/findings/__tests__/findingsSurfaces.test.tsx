// WHERE THE CONTRACT LANDS — the two surfaces that used to render the
// measured baseline.
//
// `RecommendationsView` and `StatementNotes` both showed rule-authored
// rows as a title + a rationale paragraph + a bullet list. Neither had a
// slot for a threshold, an impact or a provenance, which is why 80% of
// live rows carried no imperative verb and 58% carried fewer than two
// figures — the shape could not hold them.
//
// Two invariants are checked here, and they are about ROUTING rather
// than about cards:
//
//   ONE LIST PER PERIOD. When contract rows exist they own the surface.
//   Rendering the legacy detector beside them would show one period two
//   recommendation lists in two different voices.
//
//   NO FALSE SILENCE. A period whose rows all predate the rebuild is
//   never told it is quiet — the new rules did not run on it, so nothing
//   on screen may imply they did.
//
// Plus: the chrome translates, and the engine's own claim does not. The
// claim is COMPOSED from typed elements by `_finding.render()`;
// re-writing it client-side would be a narrative mutation with no
// fingerprint check behind it.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() {
      return bag.size;
    },
  },
});

const RATES = { EUR: 1, RON: 5.2489, USD: 1.16 };

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "RON",
    rates: { rates: RATES, as_of: "2026-05-22", source: "BNR", stale: false },
    setDisplay: () => {},
    refresh: async () => {},
    refreshing: false,
  }),
  useDisplayCurrency: () => "RON",
  useRates: () => ({ rates: RATES }),
  useAmountFormatter: () => (v: number | null | undefined) => String(v ?? ""),
}));

// The legacy detector is not under test here — the routing is.
vi.mock("@/lib/recommendationRules", () => ({
  detectConditions: () => [],
  severityRank: () => 0,
}));

const alertsRef: { current: unknown[] } = { current: [] };
vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => ({ alerts: alertsRef.current }),
}));

import i18n from "@/i18n";
import { StatementNotes } from "@/components/cfo/StatementNotes";
import { RecommendationsView } from "@/components/cfo/RecommendationsView";
import type { PeriodFacts } from "@/lib/periodFacts";

import { ENGINE_REPORT } from "./engineFixture";

// TooltipProvider mirrors App.tsx, which mounts one around the whole tree.
// It became REQUIRED here on 2026-09-02: a finding's CITED FIGURES now
// carry the provenance affordance (source, line_refs, snapshot, period),
// and the affordance is a Radix tooltip. These tests going red the moment
// findings figures got one is the measurement that they had none before —
// the card painted provenance DOTS and a provenance LINE for the finding
// as a whole, and nothing at all on the individual number a reader is
// actually looking at.
const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>);


const report = ENGINE_REPORT as { surfaced: unknown[]; demoted: unknown[] };

const FACTS = {
  period_id: "11b8e759",
  entity: "Agras",
  currency: "RON",
} as unknown as PeriodFacts;

/** A row as it exists in production today: prose and facts, no contract. */
const LEGACY_ROW = {
  id: "a1",
  alert_key: "concentration_intercompany_loan:11b8e759",
  rule_key: "concentration_intercompany_loan",
  severity: "high" as const,
  category: "data_quality",
  title: "Intercompany receivable RON 7,692,203 = 19.6% of total assets",
  body: "Recoverability and intent on settlement should be confirmed.",
  facts_cited: { intercompany_loans: 7692202.74 },
  source_currency: "RON",
};

beforeEach(() => {
  cleanup();
  bag.clear();
  alertsRef.current = [];
  i18n.changeLanguage("en");
});

// ── RecommendationsView ────────────────────────────────────────────────

describe("RecommendationsView routes to the contract when it exists", () => {
  it("renders the findings panel and not the legacy list", () => {
    alertsRef.current = [report.surfaced[0]];
    render(
      <MemoryRouter>
        <RecommendationsView facts={FACTS} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("fnd-panel")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-card-concentration_related_party")).toBeInTheDocument();
    expect(screen.queryByText(/No conditions flagged/i)).toBeNull();
  });

  it("keeps the legacy surface for a period with no contract rows", () => {
    alertsRef.current = [LEGACY_ROW];
    render(
      <MemoryRouter>
        <RecommendationsView facts={FACTS} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("fnd-panel")).toBeNull();
    // ...and it claims nothing about rules it cannot enumerate.
    expect(screen.getByText(/No conditions flagged/i)).toBeInTheDocument();
  });

  it("accepts rows passed in directly, without reading the period", () => {
    render(
      <MemoryRouter>
        <RecommendationsView facts={FACTS} findingRows={[report.surfaced[0]]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("fnd-panel")).toBeInTheDocument();
  });
});

// ── StatementNotes ─────────────────────────────────────────────────────

describe("StatementNotes keeps the two eras apart", () => {
  const renderNotes = (alerts: unknown[]) =>
    render(
      <MemoryRouter>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <StatementNotes recommendations={[]} alerts={alerts as any} relevantTo="bs" />
      </MemoryRouter>,
    );

  it("renders a contract finding as a card, scoped to its statement", () => {
    renderNotes([report.surfaced[0]]);
    expect(screen.getByTestId("statement-findings-bs")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-card-concentration_related_party")).toBeInTheDocument();
  });

  it("does not show a contract finding on a statement it is not about", () => {
    render(
      <MemoryRouter>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <StatementNotes recommendations={[]} alerts={[report.surfaced[0]] as any} relevantTo="cf" />
      </MemoryRouter>,
    );
    // The subject's accounts declare statement "BS", so the cash-flow
    // tab does not claim it — and with no checks in this payload it
    // renders no findings block at all rather than an empty one.
    expect(screen.queryByTestId("fnd-card-concentration_related_party")).toBeNull();
    expect(screen.queryByTestId("fnd-checks-empty")).toBeNull();
  });

  it("never says 'no notes' over a period that has contract rows", () => {
    renderNotes([report.surfaced[0]]);
    expect(screen.queryByText(/No notes generated/i)).toBeNull();
  });

  it("suppresses the legacy filter pills when there are no legacy rows", () => {
    renderNotes([report.surfaced[0]]);
    expect(screen.queryByText(/No items in this filter/i)).toBeNull();
  });

  it("keeps a legacy row on the legacy path, un-upgraded", () => {
    renderNotes([LEGACY_ROW]);
    expect(screen.queryByTestId("statement-findings-bs")).toBeNull();
    expect(screen.getByTestId("statement-notes-bs").textContent).toContain(
      "Intercompany receivable",
    );
  });

  it("renders both eras without mixing them when a period has both", () => {
    renderNotes([report.surfaced[0], LEGACY_ROW]);
    expect(screen.getByTestId("statement-findings-bs")).toBeInTheDocument();
    expect(screen.getByTestId("statement-notes-bs").textContent).toContain(
      "Intercompany receivable",
    );
  });
});

// ── language ───────────────────────────────────────────────────────────

describe("Romanian", () => {
  it("translates the chrome and quotes the engine's claim verbatim", async () => {
    await i18n.changeLanguage("ro");
    bag.set("cfo-view-mode-v1", "pro");
    alertsRef.current = [report.surfaced[0]];
    render(
      <MemoryRouter>
        <RecommendationsView facts={FACTS} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("fnd-card-concentration_related_party");
    // chrome: the element labels are Romanian…
    expect(card.textContent).toContain("Dovezi");
    expect(card.textContent).toContain("Prag depășit");
    expect(card.textContent).toContain("Fă asta");
    // …and the engine's own sentence is quoted, not re-authored.
    expect(card.textContent).toContain("Related-party receivable on 461");
    expect(card.textContent).toContain("Pull the 461 sub-ledger");
    await i18n.changeLanguage("en");
  });
});
