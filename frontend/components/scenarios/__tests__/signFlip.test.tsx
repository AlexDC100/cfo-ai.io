// @vitest-environment jsdom
// S7 SIGN FLIPS — the rendered half (plan_contract_v2 section 7, 26.2 S7;
// vitest canary of the S7 row, batch B1).
//
// Defect 0.4, measured on the live Scenarios page for Scandia FY2025: the
// Recession cascade took cash from 6,104,815.29 to -107,630,000 and the
// Change badge read "−19×"; EBITDA went from 54.444M to -20.257M and read
// "−137.2%". A sign flip is a WORD beside the absolute change.
//
// This renders every converted DOM consumer of section 7 with a flipping
// pair and asserts the word and the absence of any percent or multiplier,
// with a same-sign control on each surface so the check is not vacuous
// (a surface that stopped painting any change would otherwise pass).
//
// After the repair this reds on (TC-11): any money change across zero or
// sign rendered as a percent or a multiplier on ScenarioComparison,
// VarianceTable, KpiVarianceStrip, Money/DeltaBadge, KeyMetricsRow,
// StoryOverview, CmpCells or BsCmpCells; a flip rendered without its word
// (en or ro); a same-sign control that stops rendering its percent.
//
// The Scenarios half is RETIRED with its surface (forecast-scenarios-live):
// ScenarioComparison, the client cascade's change table where defect 0.4 was
// measured, is deleted with the cascade. The engine-backed Scenarios page
// renders no change at all — two served columns side by side, no delta — so
// there is no Scenarios flip left to render (scenariosEngine.test.tsx, "every
// digit on the page is served", reds on any computed delta). The remaining
// consumers below are held exactly as before.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

import i18n from "@/i18n";
import { CurrencyProvider } from "@/stores/currency";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VarianceTable } from "@/components/comparison/VarianceTable";
import { KpiVarianceStrip } from "@/components/comparison/KpiVarianceStrip";
import { buildVarianceRows } from "@/lib/comparison/buildVariance";
import type { VarianceLineKey } from "@/lib/comparison/types";
import { Money } from "@/components/ui/Money";
import { KeyMetricsRow } from "@/components/cfo/KeyMetricsRow";
import { StoryOverview } from "@/components/cfo/simple/StoryOverview";
import { BsCmpCells, CmpCells, ComparativeProvider } from "@/components/cfo/ComparativeCells";
import type { ComparativesResponse } from "@/lib/comparatives";
import { Amount } from "@/components/instrument/Amount";
import { classifyChange } from "@/lib/changeKind";

const CASH_BASE = 6_104_815.29;
const CASH_PLAN = -107_630_000;
const EBITDA_BASE = 54_444_000;
const EBITDA_PLAN = -20_257_000;

/** A percent or a multiplier glyph anywhere in the node's text. */
const RATIO_GLYPH = /[%×]/;

function Providers({ children }: { children: ReactNode }) {
  return (
    <CurrencyProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </CurrencyProvider>
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

let checked = 0;
function expectWordNoRatio(node: Element | null, word: string) {
  expect(node).not.toBeNull();
  const text = node!.textContent ?? "";
  expect(text).toContain(word);
  expect(text).not.toMatch(RATIO_GLYPH);
  checked += 1;
}

describe("S7 — a sign flip renders in words on every converted consumer", () => {
  it("VarianceTable and KpiVarianceStrip: EBITDA vs last year crossing zero shows words beside the money change", () => {
    const actual = { ebitda: EBITDA_PLAN, operating_revenue: 330_982_048, net_profit: CASH_PLAN } as Record<
      VarianceLineKey,
      number | null
    >;
    const rows = buildVarianceRows(actual, {
      budget: {},
      lastYear: { ebitda: EBITDA_BASE, operating_revenue: 413_727_560, net_profit: CASH_BASE },
    } as never);
    const table = render(
      <Providers>
        <VarianceTable rows={rows} currency="RON" view="last_year" hasBudget={false} hasLastYear />
      </Providers>,
    );
    const ebitdaRow = table.container.querySelector('[data-testid="variance-row-ebitda"]');
    expectWordNoRatio(ebitdaRow, "turned negative");
    expect(ebitdaRow?.textContent ?? "").toMatch(/\d/); // the money change is beside it
    expect(
      table.container.querySelector('[data-testid="variance-row-operating_revenue"]')?.textContent ?? "",
    ).toMatch(/%/);
    table.unmount();

    const strip = render(
      <Providers>
        <KpiVarianceStrip rows={rows} currency="RON" />
      </Providers>,
    );
    expectWordNoRatio(strip.container.querySelector('[data-testid="kpi-variance-ebitda"]'), "turned negative");
    expect(
      strip.container.querySelector('[data-testid="kpi-variance-operating_revenue"]')?.textContent ?? "",
    ).toMatch(/%/);
  });

  it("Money + DeltaBadge: a comparison across zero and a comparison from zero are words", () => {
    render(
      <Providers>
        <div data-testid="flip">
          <Money value={CASH_PLAN} fromCurrency="RON" compact comparison={{ amount: CASH_BASE }} />
        </div>
        <div data-testid="fromzero">
          <Money value={500} fromCurrency="RON" compact comparison={{ amount: 0 }} />
        </div>
        <div data-testid="control">
          <Money value={120} fromCurrency="RON" compact comparison={{ amount: 100 }} />
        </div>
      </Providers>,
    );
    expectWordNoRatio(within(screen.getByTestId("flip")).getByTestId("delta-badge"), "turned negative");
    expectWordNoRatio(within(screen.getByTestId("fromzero")).getByTestId("delta-badge"), "from zero");
    expect(within(screen.getByTestId("control")).getByTestId("delta-badge").textContent).toContain("+20.0%");
  });

  it("KeyMetricsRow and StoryOverview: a trend across zero is words, never a percent", () => {
    render(
      <Providers>
        <KeyMetricsRow
          currency="RON"
          items={[
            { label: "EBITDA", desc: "d", value: EBITDA_PLAN, testid: "km-ebitda",
              trend: { base: EBITDA_BASE, current: EBITDA_PLAN, prevLabel: "FY2024" } },
            { label: "Revenue", desc: "d", value: 330_982_048, testid: "km-revenue",
              trend: { base: 413_727_560, current: 330_982_048, prevLabel: "FY2024" } },
          ]}
        />
      </Providers>,
    );
    const chip = (id: string) => screen.getByTestId(id).querySelector("[data-change-kind]")?.parentElement ?? null;
    expectWordNoRatio(chip("km-ebitda"), "turned negative");
    expect(screen.getByTestId("km-revenue").textContent).toMatch(/%/);
    cleanup();

    render(
      <Providers>
        <StoryOverview
          currency="RON"
          revenue={-5_000}
          profit={1}
          cash={1}
          netDebt={1}
          totalDebt={1}
          ebitda={null}
          annualOperatingCosts={null}
          revenueTrend={{ base: 250_000, current: -5_000, prevLabel: "FY2024" }}
          recommendations={[]}
        />
      </Providers>,
    );
    const how = screen.getByTestId("story-how");
    expect(how.textContent).toContain("turned negative");
    expect(how.textContent).not.toMatch(RATIO_GLYPH);
    checked += 1;
  });

  it("CmpCells and BsCmpCells: the comparatives Δ % column states the flip", () => {
    const doc = {
      columns: [
        { key: "pl.ebitda", statement: "PL", label: "EBITDA", unit: "RON", requires: "synthetic",
          current: EBITDA_PLAN, prior: EBITDA_BASE, delta: EBITDA_PLAN - EBITDA_BASE, delta_pct: null,
          current_disclosure: "reported", prior_disclosure: "reported", status: "compared",
          note: "both periods reported EBITDA; the change is flip to negative", change_kind: "flip_to_negative" },
        { key: "pl.revenue", statement: "PL", label: "Revenue", unit: "RON", requires: "synthetic",
          current: 120, prior: 100, delta: 20, delta_pct: 0.2,
          current_disclosure: "reported", prior_disclosure: "reported", status: "compared",
          note: "both periods reported Revenue", change_kind: "compared" },
      ],
      common_size: [],
      prior: { label: "FY2024" },
      prior_canonical_bs: null,
    } as unknown as ComparativesResponse;
    const cols = { prior: true, delta: true, deltaPct: true, share: false };
    render(
      <Providers>
        <ComparativeProvider doc={doc} columns={cols} statement="PL" currency="RON">
          <div data-testid="cmp-ebitda"><CmpCells rowKey="pl.ebitda" amount={EBITDA_PLAN} /></div>
          <div data-testid="cmp-revenue"><CmpCells rowKey="pl.revenue" amount={120} /></div>
          <div data-testid="bs-flip">
            <BsCmpCells opening={CASH_BASE} closing={CASH_PLAN} />
          </div>
        </ComparativeProvider>
      </Providers>,
    );
    const pctCell = (id: string) => screen.getByTestId(id).querySelector("[data-change-kind]");
    expectWordNoRatio(pctCell("cmp-ebitda"), "turned negative");
    expect(screen.getByTestId("cmp-revenue").textContent).toContain("+20.0%");
    expectWordNoRatio(screen.getByTestId("bs-flip"), "turned negative");
  });

  it("renders the Romanian words from the changeKind namespace", async () => {
    await i18n.changeLanguage("ro");
    render(
      <Providers>
        <div data-testid="ro">
          <Amount kind="percent" value={null} change={classifyChange(CASH_BASE, CASH_PLAN, 0.005)} />
        </div>
      </Providers>,
    );
    expectWordNoRatio(screen.getByTestId("ro"), "a devenit negativ");
    // TC-12 / TC-13: coverage and scope printed.
    console.log(
      `SIGN-FLIP rendered checks: ${checked} flip renderings across VarianceTable, ` +
        "KpiVarianceStrip, Money/DeltaBadge, KeyMetricsRow, StoryOverview, CmpCells, BsCmpCells, Amount (ro); " +
        "pairs: Scandia FY2025 cash and EBITDA aggregates (defect 0.4), hand-built fixtures, no client book",
    );
    // 9 before the ScenarioComparison case (2 renderings) left with its
    // deleted surface; every surviving consumer still renders its flips.
    expect(checked).toBeGreaterThanOrEqual(7);
  });
});
