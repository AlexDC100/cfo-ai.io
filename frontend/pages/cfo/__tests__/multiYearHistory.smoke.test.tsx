// REPORT PAGES lane — MultiYearHistory render smoke test.
//
// The /multi-year-history route is compile-time gated behind
// PUBLIC_RECORDS_ENABLED=false, so the design screenshot loop cannot
// reach it in the live stack. This smoke test renders the migrated page
// against a fixture extract and asserts the instrument pass holds:
// the page renders, figures flow through the mono <Amount> family, and
// no serif display class survives.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
// TooltipProvider mirrors App.tsx. REQUIRED since 2026-09-03: every
// year row's figures wear the provenance affordance (the document and
// site the extract was read from, the year, the confidence) — a Radix
// tooltip, which throws without its provider.
import { TooltipProvider } from "@/components/ui/tooltip";

// Currency store is context-backed (throws outside its provider) — mock
// the hooks the page consumes, same pattern as servedFactsCrossSurface.
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
// Stable object — the page's fetch effect depends on `toast`; a fresh
// object per render would re-trigger the effect in a loop.
const stableToast = { toast: () => undefined };
vi.mock("@/hooks/use-toast", () => ({ useToast: () => stableToast }));
vi.mock("@/components/cfo/DataDepthBanner", () => ({ DataDepthBanner: () => null }));
vi.mock("@/components/cfo/DocumentSwitcher", () => ({ DocumentSwitcher: () => null }));
vi.mock("@/components/learning/GuideMeButton", () => ({ GuideMeButton: () => null }));
vi.mock("@/components/learning/LearnableNumber", () => ({
  LearnableNumber: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import MultiYearHistory from "@/pages/cfo/MultiYearHistory";

const EXTRACT = {
  extract: {
    id: "x1",
    document: { id: "d1", filename: "listafirme.pdf", status: "done", detected_type: "public_records", created_at: "2026-08-01" },
    company_name: "Exemplu Prod SRL",
    cui: "RO123456",
    reg_com: "J40/1234/2005",
    caen_code: "1013",
    caen_description: "Meat products",
    source_site: "listafirme.ro",
    confidence: 0.97,
    created_at: "2026-08-01",
    years: [
      { year: 2023, cifra_afaceri: 120_000_000, profit_net: 8_000_000, datorii_totale: 30_000_000, active_imobilizate: 40_000_000, active_circulante: 55_000_000, capitaluri_proprii: 60_000_000, total_assets: 95_000_000, salariati: 240, net_margin_pct: 6.7 },
      { year: 2022, cifra_afaceri: 100_000_000, profit_net: -2_000_000, datorii_totale: 35_000_000, active_imobilizate: 38_000_000, active_circulante: 50_000_000, capitaluri_proprii: 52_000_000, total_assets: 88_000_000, salariati: 220, net_margin_pct: -2.0 },
      { year: 2021, cifra_afaceri: 90_000_000, profit_net: 5_000_000, datorii_totale: 28_000_000, active_imobilizate: 35_000_000, active_circulante: 45_000_000, capitaluri_proprii: 50_000_000, total_assets: 80_000_000, salariati: 205, net_margin_pct: 5.6 },
    ],
  },
};

describe("MultiYearHistory (instrument pass)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => EXTRACT,
    })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the extract with mono figures and no serif display", async () => {
    const { container } = render(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/multi-year-history"]}>
          <MultiYearHistory />
        </MemoryRouter>
      </TooltipProvider>,
    );

    // Header (PageHeader, not the old gradient hero)
    expect(await screen.findByText("Exemplu Prod SRL")).toBeTruthy();
    expect(container.textContent).toContain("Multi-year financial history");

    // Table rows render newest → oldest with the ledger present
    expect(screen.getByTestId("multi-year-history")).toBeTruthy();
    // Year figures appear in the ledger AND the chart axis — at least once each.
    expect(screen.getAllByText("2023").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2021").length).toBeGreaterThan(0);

    // Deterministic insights section fires with >= 2 years
    expect(screen.getByTestId("multiyear-insights")).toBeTruthy();

    // Design law: no serif display and no raw teal hex classes survive
    expect(container.innerHTML).not.toContain("font-serif");
    expect(container.innerHTML).not.toMatch(/#(?:2AA89B|5CD3C5|8FE3D9|E6F7F4|1B7268)/i);

    // Figures flow through the mono instrument
    expect(container.querySelector(".font-mono.tabular-nums")).toBeTruthy();
  });
});
