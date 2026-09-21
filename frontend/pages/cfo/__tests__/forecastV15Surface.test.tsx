/**
 * THE v1.5 COMPONENTS — the four charts and the lever rail, rendered over the
 * REAL served bytes (`fp1_2_agras_served.json`, the agras book through the
 * real route) — and what the Forecast COCKPIT keeps of the v1.5 page: the
 * collapsed statements' grain, the banner's base period, and the source scan.
 *
 * THE PAGE CHANGED UNDER THIS FILE (2026-09-21). The Forecast page became the
 * cockpit: four numbers, one chart, sliders (pages/cfo/__tests__/
 * forecastCockpit.test.tsx owns it, over a synthetic double of the cockpit
 * route). The executive strip and the growth-basis panel were deleted with
 * the page they served — the cockpit's four numbers and slider bases replace
 * them, served by the engine in both languages — and so was the fp1.2
 * appendix with its months-of-year-one toggle: the cockpit's statements are
 * the engine's plan-year aggregates, year 0 beside them. The four charts and the lever
 * rail REMAIN in the product (the Scenarios page mounts the cash curve and the
 * rail), so their laws are held here at COMPONENT level, over the same served
 * bytes, instead of being dropped with the page that used to host them.
 *
 * WHAT IT REDS ON (TC-11, i.e. after the repairs, not before)
 *   · a projected figure painted without the marker `<ProjectedAmount>`
 *     carries — chart readout or table cell;
 *   · THE CODE COMPUTING. The page, the cockpit painters and the lever rail
 *     may not reach a projected value at all, and the chart module may unwrap
 *     only for geometry — never combining two unwrapped values;
 *   · a lever cell that eats a decimal point, goes dead while its recompute is
 *     in flight, or hides the engine's bounds; a reset that could send a
 *     second set mid-flight;
 *   · the banner naming the app's period instead of the one the projection
 *     stands on.
 *
 * WHAT IT CANNOT SEE
 *   · whether the projection is a good forecast — the engine's suite owns that;
 *   · pixels. A chart's shape is asserted through the data it is built from.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { useState } from "react";

import Forecast from "../Forecast";
import {
  CapexDepreciationChart,
  CashCurveChart,
  FreeCashFlowChart,
  RevenueEbitdaChart,
} from "@/components/forecast/ForecastCharts";
import { LeverRail, cellToWire } from "@/components/forecast/LeverRail";
import { readProjection, type ProjectionView } from "@/lib/forecastFacts";
import { applyLeverEdit, planYearLabels, type LeverEdit } from "@/lib/forecastLevers";
import { CfoApiError } from "@/lib/cfoApi";
import { SYNTH_BASE, syntheticCockpit } from "@/components/forecast/cockpit/__tests__/syntheticCockpit";

const PERIOD = { id: "p-1", label: "Dec 2025" };

vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => PERIOD,
}));

const forecast = vi.fn();
const forecastRecompute = vi.fn();
// forecast-scenarios-live: the page resolves the COMPANY ON SCREEN
// (lib/pageCompany) before it projects. These suites are about the
// projection, so the period above is the one on screen and the workspace
// layer answers "loaded, nothing else to say".
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: null, status: "ready" }),
}));
vi.mock("@/lib/org", () => ({
  useActiveOrg: () => ({
    org: null, orgs: [], archived: [], loading: false, loadError: false,
    needsOnboarding: false, refresh: async () => undefined, switchOrg: async () => undefined,
    createWorkspace: async () => null, renameWorkspace: async () => false,
    setWorkspaceIndustry: async () => false, archiveWorkspace: async () => false,
    restoreWorkspace: async () => false, purgeWorkspace: async () => false,
  }),
  daysUntilPurge: () => 30,
}));
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return {
    ...actual,
    cfoApi: {
      // the cockpit's one route; its answer is this fp1.2 body (+ a cockpit
      // block these real bytes predate)
      forecastCockpit: (...args: unknown[]) => forecast(...args),
      forecastRecompute: (...args: unknown[]) => forecastRecompute(...args),
    },
  };
});

const REPO = resolve(__dirname, "../../../..");
const SERVED = JSON.parse(
  readFileSync(
    resolve(REPO, "tests/engine/fixtures/forecast/fp1_2_agras_served.json"),
    "utf8",
  ),
) as Record<string, any>;

/** The v1.5 composition of the four charts, over one served view — the
 *  props the old page passed, so each chart's law is tested as the product
 *  mounts it. */
const fmt = new Intl.NumberFormat("en-GB", { style: "currency", currency: "RON", maximumFractionDigits: 0 });
const format = (v: number) => fmt.format(v);
function Charts({ view }: { view: ProjectionView }) {
  const chartProps = { basePeriodLabel: view.basePeriodLabel, format, projectedLabel: "projected" };
  const fy = planYearLabels(view.horizon, view.horizonAnnual);
  const fyFlow = (line: string) => fy.map((period) => ({ period, result: view.figure(line, period) }));
  return (
    <div>
      <RevenueEbitdaChart revenue={fyFlow("pl.revenue")} ebitda={fyFlow("pl.ebitda")} {...chartProps} />
      <CashCurveChart
        closingCash={view.series("closing_cash")}
        minCash={view.series("min_cash")}
        troughPeriod={view.summary.cashTrough.period}
        troughResult={view.summary.cashTrough.result}
        fundingGapPeriods={view.summary.fundingGapPeriods}
        {...chartProps}
      />
      <FreeCashFlowChart fcf={view.series("fcf")} cumulative={view.series("fcf_cumulative")} {...chartProps} />
      <CapexDepreciationChart capex={fyFlow("cf.capital_expenditure")} depreciation={fyFlow("pl.depreciation")} {...chartProps} />
    </div>
  );
}
function renderCharts() {
  return render(<Charts view={readProjection(SERVED) as ProjectionView} />);
}

/** The lever rail as a host mounts it: the reader's edits in state, the
 *  engine's refusal and the in-flight flag passed in (the Scenarios page's
 *  own loop, lib/forecastLevers.applyLeverEdit). */
function Rail({
  payload = SERVED,
  recomputing = false,
  error = null,
  refusedKey = null,
}: {
  payload?: Record<string, any>;
  recomputing?: boolean;
  error?: string | null;
  refusedKey?: string | null;
}) {
  const view = readProjection(payload) as ProjectionView;
  const [edits, setEdits] = useState<readonly LeverEdit[]>([]);
  const length = planYearLabels(view.horizon, view.horizonAnnual).length;
  return (
    <LeverRail
      view={view}
      edits={edits}
      recomputing={recomputing}
      error={error}
      refusedKey={refusedKey}
      onChange={(key, index, text) => {
        const lever = view.lever(key);
        if (!lever) return;
        const n = lever.shape === "scalar" ? 1 : length;
        setEdits((prev) => applyLeverEdit(prev, key, index, text === "" ? null : cellToWire(text, lever), n));
      }}
      onReset={(key) => setEdits((prev) => prev.filter((e) => e.key !== key))}
      onAdopt={(key, values) =>
        setEdits((prev) => [...prev.filter((e) => e.key !== key), { key, values: [...values] }])
      }
    />
  );
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Forecast />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  forecast.mockReset();
  forecastRecompute.mockReset();
  forecast.mockResolvedValue(SERVED);
});

describe("the charts", () => {
  it("render from served figures, each stating the grain it is on", async () => {
    renderCharts();
    for (const id of ["revenue-ebitda", "cash-curve", "fcf", "capex-depreciation"]) {
      const chart = await screen.findByTestId(`forecast-chart-${id}`);
      expect(chart.querySelector("svg")).not.toBeNull();
      expect(within(chart).getByTestId(`forecast-chart-grain-${id}`).textContent)
        .toBeTruthy();
    }
    // A FLOW is a total over a length, so the two flow charts stand on the
    // engine's own FY aggregates — a month beside a year on one axis steps
    // twelvefold and reads as growth that is not there.
    expect(
      screen.getByTestId("forecast-chart-grain-revenue-ebitda").textContent,
    ).toContain(SERVED.horizon.labels_annual[0]);
    expect(
      screen.getByTestId("forecast-chart-grain-capex-depreciation").textContent,
    ).toContain(SERVED.horizon.labels_annual[0]);
    // CASH is a level and is comparable at either grain, so it keeps every
    // served point — with the step where the grain changes drawn and labelled.
    expect(
      screen.getByTestId("forecast-chart-grain-cash-curve").textContent,
    ).toContain(SERVED.series.closing_cash[0].period);
    expect(document.querySelectorAll("[data-testid='forecast-chart-grain-break']").length)
      .toBeGreaterThan(0);
  });

  it("free cash flow bars stop where the served monthly periods do", async () => {
    // There is no FY aggregate for `fcf` on the wire and summing twelve months
    // in the browser would state a total the projection never did. The bars
    // stop, the note says why, and the cumulative line runs the horizon.
    renderCharts();
    await screen.findByTestId("forecast-chart-fcf");
    expect(screen.getByTestId("forecast-chart-fcf-grain-note").textContent)
      .toMatch(/no financial-year total/i);
  });

  it("the chart readouts carry the marker too", async () => {
    renderCharts();
    const trough = await screen.findByTestId("forecast-chart-trough");
    expect(trough.querySelector('[data-projected="true"]')).not.toBeNull();
    const peak = screen.getByTestId("forecast-chart-revenue-peak");
    expect(peak.querySelector('[data-projected="true"]')).not.toBeNull();
  });

  it("the shaded band is the SERVED funding-gap span", async () => {
    renderCharts();
    await screen.findByTestId("forecast-chart-cash-curve");
    const shaded = document.querySelectorAll("[data-testid^='forecast-chart-gap-']");
    expect(shaded.length).toBe(SERVED.summary.funding_gap_periods.length);
  });

  it("the trough marker sits on the period the engine named", async () => {
    renderCharts();
    await screen.findByTestId("forecast-chart-cash-curve");
    const mark = document.querySelector('[data-testid="forecast-chart-trough-mark"]');
    expect(SERVED.summary.cash_trough.period).toBeTruthy();
    expect(mark).not.toBeNull();
  });
});

describe("the lever rail", () => {
  it("offers only levers the engine declares, and lists the ones it does not", async () => {
    render(<Rail />);
    const rail = await screen.findByTestId("forecast-levers");
    for (const key of [
      "revenue_growth",
      "dso_days",
      "dio_cogs_days",
      "dpo_cogs_days",
      "capex_pct_of_revenue",
      "dividend_payout_pct",
    ]) {
      expect(within(rail).getByTestId(`forecast-lever-${key}`)).toBeTruthy();
    }
    // Both answer 422 `unknown_driver` on this engine. They are named as
    // undeclared rather than shipped as sliders that fake them.
    expect(within(rail).getByTestId("forecast-lever-undeclared-gross_margin")).toBeTruthy();
    expect(within(rail).getByTestId("forecast-lever-undeclared-opex_growth")).toBeTruthy();
    // And the engine's OWN list of levers it was asked for and does not model.
    for (const row of SERVED.client.unserved) {
      expect(
        within(rail).getByTestId(`forecast-lever-unserved-${row.key}`).textContent,
      ).toBe(row.sentence.text);
    }
  });

  it("each lever shows the tier its value stands on and the basis sentence", async () => {
    render(<Rail />);
    const rail = await screen.findByTestId("forecast-levers");
    const tier = within(rail).getByTestId("forecast-lever-tier-revenue_growth");
    expect(tier.getAttribute("data-tier")).toBe(SERVED.drivers.revenue_growth.basis.tier);
    expect(
      within(rail).getByTestId("forecast-lever-basis-revenue_growth").textContent,
    ).toBe(SERVED.drivers.revenue_growth.basis.sentence.text);
  });

  it("a per-year lever shows one cell per plan year, in the DISPLAYED unit", async () => {
    render(<Rail />);
    await screen.findByTestId("forecast-levers");
    const cells = document.querySelectorAll(
      "[data-testid^='forecast-lever-input-revenue_growth-']",
    );
    expect(cells.length).toBe(SERVED.drivers.revenue_growth.values.length);
    // 25000 ratio micros is 2.5 percent on screen, not 0.025 and not 25000.
    expect((cells[0] as HTMLInputElement).value).toBe("2.5");
  });
});

describe("THE PAGE COMPUTES NOTHING — a source scan", () => {
  /** Read the surface modules as TEXT, COMMENTS REMOVED. A behavioural
   *  assertion cannot see a total quietly derived in a branch a fixture never
   *  reaches; this can. Comments are stripped first because these files
   *  explain, at length, the very calls they must not make — a scan that
   *  cannot tell code from prose reds on the documentation that keeps the
   *  rule, which is the gate being wrong. */
  const src = (p: string) =>
    readFileSync(resolve(REPO, p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  /** The modules that PAINT. None of them may reach a projected value at all:
   *  they hand the figure to `<ProjectedAmount>`, which is the one consumer of
   *  the marker. */
  // The cockpit's own painters are held by the stricter
  // components/forecast/cockpit/__tests__/cockpitNoMoneyMath.test.ts; the
  // page and the lever rail stay on this roster too.
  const PAINTERS = [
    "frontend/pages/cfo/Forecast.tsx",
    "frontend/components/forecast/LeverRail.tsx",
  ];

  it.each(PAINTERS)("%s never reaches a projected value, and sums nothing", (path) => {
    const text = src(path);
    for (const banned of [
      "unwrapProjected",
      "projectedDisplay",
      ".amountMinor",
      "amount_minor",
      ".reduce(",
      "/ 100",
      "* 100",
    ]) {
      expect(
        text.includes(banned),
        `${path} contains ${JSON.stringify(banned)}. This module paints; it ` +
          `does not compute. A figure it shows is a figure the engine served, ` +
          `converted for display at the gateway edge and nowhere else.`,
      ).toBe(false);
    }
  });

  it("the charts unwrap ONCE, for geometry, and format no number themselves", () => {
    const path = "frontend/components/forecast/ForecastCharts.tsx";
    const text = src(path);
    // An SVG path needs plain numbers, so ONE unwrap is honest — in `plotted`,
    // where every point is turned into geometry. A second one is a value being
    // reached for some other purpose, which is the purpose to look at.
    expect(
      (text.match(/unwrapProjected\(/g) ?? []).length,
      `${path} unwraps a projected value more than once. The single unwrap is ` +
        `the geometry read; anything else is this module deciding what a ` +
        `number means.`,
    ).toBe(1);
    for (const banned of ["toFixed(", "toLocaleString(", "Intl.", "amount_minor"]) {
      expect(
        text.includes(banned),
        `${path} formats a number itself with ${JSON.stringify(banned)}. Every ` +
          `number a reader sees in a chart is painted by <ProjectedAmount> ` +
          `from the served figure, so the projected marker travels with it.`,
      ).toBe(false);
    }
    // And the readouts really are that primitive, not a string built here.
    expect(text.includes("<ProjectedAmount")).toBe(true);
  });
});

describe("the lever rail under a refusal, and while a recompute is in flight", () => {
  // The page-level half — the last SERVED projection stays on screen with the
  // engine's sentence and a stale notice — belongs to the host page; for the
  // Forecast cockpit it is forecastCockpit.test.tsx ("a refused position keeps
  // the last served answer"). What the RAIL owes, whichever page hosts it, is
  // held here.

  it("prints the engine's sentence verbatim and marks ONLY the lever it names", () => {
    render(<Rail error="dso_days: 400 is outside 0 to 365" refusedKey="dso_days" />);
    expect(screen.getByTestId("forecast-recompute-error").textContent).toBe(
      "dso_days: 400 is outside 0 to 365",
    );
    expect(
      screen.getByTestId("forecast-lever-input-dso_days-0").getAttribute("data-refused"),
    ).toBe("true");
    expect(
      screen.getByTestId("forecast-lever-input-revenue_growth-0").getAttribute("data-refused"),
    ).toBeNull();
  });

  it("puts the engine's OWN bounds on the control, so the refusal is not the first thing a reader finds", () => {
    render(<Rail />);
    const bounds = SERVED.drivers.revenue_growth.bounds;
    expect(bounds.min).toBeTruthy();
    expect(bounds.max).toBeTruthy();
    // Shown in the DISPLAYED unit: a ratio bound of "3" is 300% on screen.
    const range = screen.getByTestId("forecast-lever-bounds-revenue_growth");
    expect(range.getAttribute("data-min")).toBe("-100");
    expect(range.getAttribute("data-max")).toBe("300");
    expect(range.textContent).toContain("-100");
    expect(range.textContent).toContain("300");
    const dso = screen.getByTestId("forecast-lever-bounds-dso_days");
    expect(dso.getAttribute("data-min")).toBe("0");
    expect(dso.getAttribute("data-max")).toBe("365");
    // The step is the pack's own `reach_step`, in the cell's unit: 0.01 of a
    // ratio is ONE percentage point on a field measured in percent.
    expect(SERVED.drivers.revenue_growth.reach_step).toBe("0.01");
    expect(screen.getByTestId("forecast-lever-step-revenue_growth").textContent).toContain("1");
    expect(screen.getByTestId("forecast-lever-step-revenue_growth").textContent).not.toContain("0.0001");
  });

  it("an answer landing mid-word does not rewrite what the reader is typing", async () => {
    // `<input type="number">` reports `value === ""` the instant a decimal
    // point is typed; the cell is a text field, and its re-sync stops while
    // the cell has focus.
    render(<Rail />);
    const input = screen.getByTestId("forecast-lever-input-revenue_growth-0") as HTMLInputElement;
    expect(input.getAttribute("type"), "a number input eats the decimal point").toBe("text");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "12.5" } });
    expect(input.value).toBe("12.5");
    // On blur the re-sync is live again — and it syncs to the reader's own
    // pending edit, not the engine's old figure.
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe("12.5"));
    // Drop the override and the cell goes back to the engine's figure.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe("2.5"));
  });

  it("a cell stays typeable while its own recompute is in flight", () => {
    render(<Rail recomputing />);
    const input = screen.getByTestId("forecast-lever-input-revenue_growth-0") as HTMLInputElement;
    expect(input.disabled, "the lever cell is disabled while the server answers").toBe(false);
    fireEvent.change(input, { target: { value: "12.5" } });
    expect(input.value).toBe("12.5");
    expect(screen.getByTestId("forecast-recompute-state").getAttribute("data-recomputing")).toBe("true");
  });

  it("the buttons that would send a DIFFERENT set are the ones held back", () => {
    // Reset and adopt each replace the whole lever in one click, so firing one
    // mid-flight would queue a second set behind the first.
    const edited = JSON.parse(JSON.stringify(SERVED));
    edited.drivers.revenue_growth.basis.original = { ...edited.drivers.revenue_growth.basis, tier: "macro" };
    edited.drivers.revenue_growth.basis.tier = "user";
    render(<Rail payload={edited} recomputing />);
    expect((screen.getByTestId("forecast-lever-reset-revenue_growth") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("forecast-lever-input-revenue_growth-0") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("the free-cash-flow chart is readable", () => {
  it("draws the per-period bars on their own scale, not squashed under the running total", async () => {
    // A per-period FLOW and a RUNNING TOTAL do not share a range: the
    // cumulative's last point set the domain and every bar rendered two to
    // five pixels in a 166 px plot — the chart read as a flat line on the axis.
    renderCharts();
    const chart = await screen.findByTestId("forecast-chart-fcf");
    const bars = Array.from(
      chart.querySelectorAll("rect[data-testid^='forecast-chart-fcf-bar-']"),
    );
    expect(bars.length).toBeGreaterThan(0);
    const heights = bars.map((b) => Number(b.getAttribute("height")));
    expect(
      Math.max(...heights),
      "the tallest free-cash-flow bar is a sliver: the bars are being scaled " +
        "against the cumulative line's domain instead of their own",
    ).toBeGreaterThan(40);
    // The second scale is declared, and labelled with a served figure.
    expect(chart.querySelector("[data-scale='cumulative']")).not.toBeNull();
    expect(
      screen.getByTestId("forecast-chart-fcf-cumulative").querySelector(
        '[data-projected="true"]',
      ),
    ).not.toBeNull();
    // And the reader is told the two series are not on one vertical scale.
    expect(screen.getByTestId("forecast-chart-fcf-scale-note").textContent)
      .toMatch(/scale/i);
  });
});

// ── ACCEPTANCE (2026-09-21) ──────────────────────────────────────────────
describe("the banner names the period the PROJECTION stands on", () => {
  it("quotes the ENGINE's own base period, never the app's active-period context", async () => {
    // These two can disagree: `useActivePeriod()` is mocked to "Dec 2025";
    // the served cockpit stands on `base_period.label`.
    forecast.mockImplementation(async () => syntheticCockpit());
    renderPage();
    const banner = await screen.findByTestId("forecast-banner");
    await screen.findByTestId("cockpit-numbers");
    expect(banner.textContent, `the banner names ${SYNTH_BASE}`).toContain(SYNTH_BASE);
    expect(banner.textContent, "and does not name the app's active period instead").not.toContain(PERIOD.label);
    expect(banner.textContent, "and never renders its anchor as an em dash").not.toContain("of —");
    expect(banner.querySelector("button"), "the banner is not dismissible").toBeNull();
  });

  it("keeps naming it while a REFUSED slider move holds the projection on screen", async () => {
    // The last SERVED answer stays on screen after a refusal; the sentence
    // saying what those figures stand on must stay true while they are shown.
    forecast.mockImplementation(async () => syntheticCockpit());
    renderPage();
    await screen.findByTestId("cockpit-levers");
    const sentence = "inflation: 1.5 is outside 0 to 1";
    forecast.mockRejectedValue(new CfoApiError(sentence, 422, { code: "out_of_bounds", text: sentence, field: "inflation" }));
    fireEvent.change(screen.getByTestId("cockpit-lever-inflation-input"), { target: { value: "150000" } });
    await waitFor(() => expect(screen.getByTestId("forecast-stale-notice")).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByTestId("cockpit-numbers"), "the projection is still on screen").toBeTruthy();
    const banner = screen.getByTestId("forecast-banner");
    expect(banner.textContent).toContain(SYNTH_BASE);
    expect(banner.textContent).not.toContain(PERIOD.label);
    expect(banner.textContent).not.toContain("of —");
  });
});
