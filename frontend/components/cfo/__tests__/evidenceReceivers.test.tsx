// cmdbar-evidence — the command bar's items OPEN their evidence (design C4):
//
//   ?ratio=<key>        on the ratios tab opens that ratio's detail drawer;
//   /benchmark?row=<k>  highlights (and scrolls to) the sector row.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a `?ratio=` the tab ignores (the
// bar's Răspuns would land on a tab with nothing opened), a closed drawer that
// leaves the parameter behind (Back would reopen it), a `?row=` the benchmark
// section ignores. WHAT IT CANNOT SEE: the account view (`?account=`), which
// is not built yet — the bar's Cont rows land on the statement tab with the
// account's bucket highlighted.

import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";

import { renderWithProviders } from "@/test/renderWithProviders";
import { RatiosTabContent } from "@/components/cfo/ratios/RatiosTab";
import { SectorBenchmarkView } from "@/components/cfo/benchmark/SectorBenchmarkSection";
import { altmanRatio, computeRatios, type Statements } from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import { servedCreditEnvelopes } from "@/lib/ratioCompareView";
import type { SectorBenchmarkDoc } from "@/lib/sectorBenchmark";

import pairJson from "@/lib/__tests__/fixtures/comparatives/pair_served.json";
import sectorJson from "@/lib/__tests__/fixtures/sectorBenchmark/served_pair.json";

function inputs() {
  const body = JSON.parse(JSON.stringify((pairJson as { current_body: unknown }).current_body)) as {
    assembled_metrics: Record<string, unknown>;
    statements: Statements;
    metrics: { name: string; value: number | null }[];
  };
  const metricsByName = Object.fromEntries(body.metrics.map((m) => [m.name, m.value])) as Record<string, number | null>;
  const ratios = computeRatios(
    body.statements,
    { ebitdaMargin: metricsByName.ebitda_margin ?? null, netMargin: metricsByName.net_margin ?? null },
    metricsByName,
  );
  const env = servedCreditEnvelopes(body.assembled_metrics, body.statements, metricsByName);
  const credit = computeCreditScore(body.statements, env.credit, env.piotroski, env.metricsByName);
  return { ratios, statements: body.statements, altman: altmanRatio(credit) };
}

function Location() {
  const l = useLocation();
  return <div data-testid="where">{l.search}</div>;
}

describe("?ratio= opens the ratio's drawer", () => {
  it("the bar's link lands on the drawer for that ratio, and closing it drops the parameter", async () => {
    const { ratios, statements, altman } = inputs();
    renderWithProviders(
      <>
        <RatiosTabContent ratios={ratios} statements={statements} altman={altman} />
        <Location />
      </>,
      { route: "/dashboard?tab=ratios&ratio=current_ratio" },
    );
    const drawer = await screen.findByTestId("ratio-detail-drawer");
    const label = [...ratios.liquidity].find((r) => r.key === "current_ratio")!.label;
    expect(drawer.textContent).toContain(label);
    // While the drawer is open the link stays what the reader followed (a
    // receiver that dropped it in the same commit it opened would make
    // Back and reload lose the evidence — caught live, 2026-09-27).
    expect(screen.getByTestId("where").textContent).toContain("ratio=current_ratio");
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(screen.getByTestId("where").textContent).not.toContain("ratio=");
  });

  it("without the parameter nothing opens (the receiver is not a default)", () => {
    const { ratios, statements, altman } = inputs();
    renderWithProviders(<RatiosTabContent ratios={ratios} statements={statements} altman={altman} />,
      { route: "/dashboard?tab=ratios" });
    expect(screen.queryByTestId("ratio-detail-drawer")).toBeNull();
  });
});

describe("/benchmark?row= highlights the sector row", () => {
  it("the named row, and only it", () => {
    const doc = (sectorJson as { with_prior: SectorBenchmarkDoc }).with_prior;
    const key = doc.rows.find((r) => r.status === "sourced")!.key;
    renderWithProviders(<SectorBenchmarkView doc={doc} />, { route: `/benchmark?row=${key}` });
    const rows = [...document.querySelectorAll<HTMLElement>("[data-sector-row]")];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.dataset.highlighted === "true").map((r) => r.dataset.sectorRow)).toEqual([key]);
  });
});
