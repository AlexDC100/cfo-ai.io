/**
 * THE v1.5 SURFACE — the executive strip, the four charts and the lever rail,
 * rendered over the REAL served bytes (`fp1_2_agras_served.json`, the agras
 * book through the real route).
 *
 * WHAT IT REDS ON (TC-11, i.e. after the repairs, not before)
 *   · a projected figure painted anywhere on this page without the marker
 *     `<ProjectedAmount>` carries — strip headline, chart readout or table cell;
 *   · a refused figure painting a number, a zero especially: the covenant slot
 *     is a standing engine refusal and must render the engine's sentence, never
 *     "none in horizon", which is an absent read as a negative;
 *   · THE PAGE COMPUTING. The strip, growth-basis and lever modules may not
 *     reach a projected value at all, and the chart module may unwrap only for
 *     geometry — never combining two unwrapped values, which is the browser
 *     re-deriving a total the engine either served or refused;
 *   · a lever edit firing more than one POST per settled change, or firing one
 *     before the pack's own debounce has elapsed;
 *   · a figure moving before the server answers (optimistic UI).
 *
 * WHAT IT CANNOT SEE
 *   · whether the projection is a good forecast — it is arithmetic over stated
 *     drivers and the engine's suite owns that;
 *   · pixels. A chart's shape is asserted through the data it is built from,
 *     not through its path geometry.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import Forecast from "../Forecast";

const PERIOD = { id: "p-1", label: "Dec 2025" };

vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => PERIOD,
}));

const forecast = vi.fn();
const forecastRecompute = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return {
    ...actual,
    cfoApi: {
      forecast: (...args: unknown[]) => forecast(...args),
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

describe("the executive strip", () => {
  it("paints its served figures WITH the projected marker", async () => {
    renderPage();
    const strip = await screen.findByTestId("forecast-strip");
    for (const id of ["peak-funding", "cumulative-fcf", "closing-cash"]) {
      const cell = within(strip).getByTestId(`forecast-strip-${id}`);
      const painted = cell.querySelector('[data-projected="true"]');
      expect(
        painted,
        `${id} paints a number with no projected marker — the one thing this ` +
          `page may never let a reader mistake`,
      ).not.toBeNull();
      expect(painted?.querySelector('[data-projected-mark="true"]')).not.toBeNull();
    }
  });

  it("the covenant slot renders the ENGINE's refusal, not a zero and not 'none'", async () => {
    renderPage();
    const slot = await screen.findByTestId("forecast-strip-breach-refusal");
    expect(slot.textContent).toBe("this is not served in this build");
    const cell = screen.getByTestId("forecast-strip-first-breach");
    expect(cell.textContent).not.toMatch(/\b0\b/);
    expect(cell.textContent?.toLowerCase()).not.toMatch(/none in horizon/);
  });

  it("a peak funding gap of zero says the plan never draws", async () => {
    renderPage();
    const cell = await screen.findByTestId("forecast-strip-peak-funding");
    // agras never draws: the amount is a real 0 and the period is null. That
    // is an ANSWER, and it is not the same claim as an absent figure.
    expect(SERVED.strip.peak_funding_gap.period).toBeNull();
    expect(cell.textContent).toMatch(/never draws/i);
  });
});

describe("the charts", () => {
  it("render from served figures, each stating the grain it is on", async () => {
    renderPage();
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
    renderPage();
    await screen.findByTestId("forecast-chart-fcf");
    expect(screen.getByTestId("forecast-chart-fcf-grain-note").textContent)
      .toMatch(/no financial-year total/i);
  });

  it("the chart readouts carry the marker too", async () => {
    renderPage();
    const trough = await screen.findByTestId("forecast-chart-trough");
    expect(trough.querySelector('[data-projected="true"]')).not.toBeNull();
    const peak = screen.getByTestId("forecast-chart-revenue-peak");
    expect(peak.querySelector('[data-projected="true"]')).not.toBeNull();
  });

  it("the shaded band is the SERVED funding-gap span", async () => {
    renderPage();
    await screen.findByTestId("forecast-chart-cash-curve");
    const shaded = document.querySelectorAll("[data-testid^='forecast-chart-gap-']");
    expect(shaded.length).toBe(SERVED.summary.funding_gap_periods.length);
  });

  it("the trough marker sits on the period the engine named", async () => {
    renderPage();
    await screen.findByTestId("forecast-chart-cash-curve");
    const mark = document.querySelector('[data-testid="forecast-chart-trough-mark"]');
    expect(SERVED.summary.cash_trough.period).toBeTruthy();
    expect(mark).not.toBeNull();
  });
});

describe("the lever rail", () => {
  it("offers only levers the engine declares, and lists the ones it does not", async () => {
    renderPage();
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
    renderPage();
    const rail = await screen.findByTestId("forecast-levers");
    const tier = within(rail).getByTestId("forecast-lever-tier-revenue_growth");
    expect(tier.getAttribute("data-tier")).toBe(SERVED.drivers.revenue_growth.basis.tier);
    expect(
      within(rail).getByTestId("forecast-lever-basis-revenue_growth").textContent,
    ).toBe(SERVED.drivers.revenue_growth.basis.sentence.text);
  });

  it("a per-year lever shows one cell per plan year, in the DISPLAYED unit", async () => {
    renderPage();
    await screen.findByTestId("forecast-levers");
    const cells = document.querySelectorAll(
      "[data-testid^='forecast-lever-input-revenue_growth-']",
    );
    expect(cells.length).toBe(SERVED.drivers.revenue_growth.values.length);
    // 25000 ratio micros is 2.5 percent on screen, not 0.025 and not 25000.
    expect((cells[0] as HTMLInputElement).value).toBe("2.5");
  });
});

describe("recompute", () => {
  afterEach(() => vi.useRealTimers());

  it("fires exactly ONE POST per settled edit, after the pack's own debounce", async () => {
    forecastRecompute.mockResolvedValue(SERVED);
    renderPage();
    await screen.findByTestId("forecast-levers");
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const input = screen.getByTestId(
      "forecast-lever-input-revenue_growth-0",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.change(input, { target: { value: "3.5" } });
    fireEvent.change(input, { target: { value: "4" } });

    // NOTHING is sent BEFORE the pack's own debounce has elapsed. Measured
    // just short of it, with the queue flushed, so a page that typed its own
    // shorter wait (or none) is caught here rather than passing because the
    // assertion happened to run first.
    await act(async () => {
      vi.advanceTimersByTime(SERVED.client.debounce_ms - 20);
    });
    expect(
      forecastRecompute,
      `a POST went out before ${SERVED.client.debounce_ms} ms — the debounce ` +
        `is the pack's own \`client.debounce_ms\`, read off the payload, not ` +
        `a number chosen on the page`,
    ).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(25);
    });
    await waitFor(() => expect(forecastRecompute).toHaveBeenCalledTimes(1));

    const [periodId, body] = forecastRecompute.mock.calls[0];
    expect(periodId).toBe("p-1");
    // The value goes back as an EXACT decimal string in the driver's own
    // natural unit — 4% typed is "0.04" sent, never 4 and never 0.04000001.
    expect(body.overrides.revenue_growth.values[0]).toBe("0.04");
    // A per-year override must carry exactly total_years values or the engine
    // answers 422 `override_length`.
    expect(body.overrides.revenue_growth.values.length).toBe(body.horizon.total_years);
    expect(body.horizon.monthly_months).toBe(12);
  });

  it("NOTHING on the page moves until the server answers", async () => {
    let resolve_: (v: unknown) => void = () => {};
    forecastRecompute.mockImplementation(
      () => new Promise((r) => { resolve_ = r; }),
    );
    renderPage();
    await screen.findByTestId("forecast-levers");
    const before = screen.getByTestId("forecast-strip-closing-cash").textContent;
    vi.useFakeTimers({ shouldAdvanceTime: true });

    fireEvent.change(
      screen.getByTestId("forecast-lever-input-revenue_growth-0"),
      { target: { value: "9" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(SERVED.client.debounce_ms + 5);
    });
    await waitFor(() => expect(forecastRecompute).toHaveBeenCalled());

    // In flight: the strip still shows the answer the server last gave, and
    // the page says it is recomputing. A projection computed here to fill the
    // wait would be a different model wearing the same labels.
    expect(screen.getByTestId("forecast-strip-closing-cash").textContent).toBe(before);
    expect(
      screen.getByTestId("forecast-recompute-state").getAttribute("data-recomputing"),
    ).toBe("true");
    await act(async () => {
      resolve_(SERVED);
    });
  });
});

describe("the statement grain", () => {
  it("opens on FY columns and offers the months of year one", async () => {
    renderPage();
    const pl = await screen.findByTestId("forecast-block-pl");
    const periods = Array.from(
      pl.querySelectorAll("td[data-period]"),
    ).map((c) => c.getAttribute("data-period"));
    // FY2026 is a SERVED aggregate (`projected_aggregate` rows), not a sum of
    // months done in the browser.
    expect(periods).toContain(SERVED.horizon.labels_annual[0]);
    expect(periods).not.toContain("2026-02");

    fireEvent.click(screen.getByTestId("forecast-grain-toggle"));
    const monthly = Array.from(
      screen.getByTestId("forecast-block-pl").querySelectorAll("td[data-period]"),
    ).map((c) => c.getAttribute("data-period"));
    expect(monthly).toContain("2026-02");
    // One response carries both grains; the toggle spends no request.
    expect(forecast).toHaveBeenCalledTimes(1);
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
  const PAINTERS = [
    "frontend/pages/cfo/Forecast.tsx",
    "frontend/components/forecast/ExecutiveStrip.tsx",
    "frontend/components/forecast/GrowthBasis.tsx",
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
