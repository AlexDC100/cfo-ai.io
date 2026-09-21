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
import { CfoApiError } from "@/lib/cfoApi";

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

describe("a refused recompute does not take the page away", () => {
  afterEach(() => vi.useRealTimers());

  /** Drive one lever edit through the pack's own debounce, with the recompute
   *  answering `answer`. Returns once the POST has been made. */
  async function editThrough(value: string) {
    renderPage();
    await screen.findByTestId("forecast-levers");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(screen.getByTestId("forecast-lever-input-revenue_growth-0"), {
      target: { value },
    });
    await act(async () => {
      vi.advanceTimersByTime(SERVED.client.debounce_ms + 25);
    });
    await waitFor(() => expect(forecastRecompute).toHaveBeenCalled());
    vi.useRealTimers();
  }

  it("keeps the last projection the SERVER produced, and says why it did not move", async () => {
    // The engine refuses a value outside the bounds it serves, by design. That
    // refusal is the reader having asked a question the plan cannot answer —
    // it is not the projection ceasing to exist. Before this repair the whole
    // body unmounted and the only ways back were a horizon switch, which
    // discards every edit, or a reload.
    const sentence =
      "revenue_growth 9.000000 is outside the bounds this engine accepts";
    forecastRecompute.mockRejectedValue(
      new CfoApiError(sentence, 422, {
        code: "out_of_bounds",
        text: sentence,
        field: "revenue_growth",
      }),
    );
    await editThrough("900");

    await waitFor(() =>
      expect(screen.getByTestId("forecast-recompute-error").textContent).toContain(
        sentence,
      ),
    );
    for (const id of [
      "forecast-strip",
      "forecast-chart-revenue-ebitda",
      "forecast-chart-cash-curve",
      "forecast-chart-fcf",
      "forecast-chart-capex-depreciation",
      "forecast-levers",
      "forecast-block-pl",
    ]) {
      expect(
        screen.queryByTestId(id),
        `${id} was unmounted by a refusal the reader can produce by typing. ` +
          `A refused recompute leaves the last SERVED projection on screen ` +
          `with the engine's sentence beside the control that caused it.`,
      ).not.toBeNull();
    }
    // "No projection" is the copy for the FIRST read failing. Saying it here
    // tells the reader the book cannot be projected, which is false.
    expect(screen.queryByTestId("forecast-refusal")).toBeNull();
    // The strip still holds the figures of the projection that WAS produced.
    expect(
      screen.getByTestId("forecast-strip-closing-cash").querySelector(
        '[data-projected="true"]',
      ),
    ).not.toBeNull();
    // And the page says, in its own row, that what is shown is not the edit.
    expect(screen.getByTestId("forecast-stale-notice")).toBeTruthy();
    // The offending control is marked, so the reader knows which cell to undo.
    expect(
      screen
        .getByTestId("forecast-lever-input-revenue_growth-0")
        .getAttribute("data-refused"),
    ).toBe("true");
  });

  it("renders the engine's SENTENCE, not the envelope it travels in", async () => {
    // The route raises `HTTPException(422, {"code", "text", "field"})`, so the
    // refusal arrives as a structured detail and the api client's fallback
    // stringifies the whole object. Printing `{"code":"out_of_bounds",...}` at
    // a reader is not the engine speaking in its own words — and `field` names
    // the lever outright, which is better than reading the key back out of the
    // prose.
    forecastRecompute.mockRejectedValue(
      new CfoApiError(
        JSON.stringify({ code: "out_of_bounds", text: "x", field: "dso_days" }),
        422,
        {
          code: "out_of_bounds",
          text: "dso_days: 400 is outside 0 to 365",
          field: "dso_days",
        },
      ),
    );
    await editThrough("900");
    await waitFor(() =>
      expect(screen.getByTestId("forecast-recompute-error").textContent).toBe(
        "dso_days: 400 is outside 0 to 365",
      ),
    );
    expect(
      screen.getByTestId("forecast-lever-input-dso_days-0").getAttribute("data-refused"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("forecast-lever-input-revenue_growth-0")
        .getAttribute("data-refused"),
    ).toBeNull();
  });

  it("puts the engine's OWN bounds on the control, so the refusal is not the first thing a reader finds", async () => {
    renderPage();
    await screen.findByTestId("forecast-levers");
    const input = screen.getByTestId(
      "forecast-lever-input-revenue_growth-0",
    ) as HTMLInputElement;
    const bounds = SERVED.drivers.revenue_growth.bounds;
    expect(bounds.min).toBeTruthy();
    expect(bounds.max).toBeTruthy();
    // Shown in the DISPLAYED unit, like the value and the step beside them:
    // a ratio bound of "3" is 300% on screen, never 3. Rendered as a sentence
    // the reader can read rather than as `min`/`max` on the element, which the
    // browser only uses to tint the field after the fact — it does not stop
    // anyone typing 400 — and which a text field ignores outright.
    const range = screen.getByTestId("forecast-lever-bounds-revenue_growth");
    expect(range.getAttribute("data-min")).toBe("-100");
    expect(range.getAttribute("data-max")).toBe("300");
    expect(range.textContent).toContain("-100");
    expect(range.textContent).toContain("300");
    const dso = screen.getByTestId("forecast-lever-bounds-dso_days");
    expect(dso.getAttribute("data-min")).toBe("0");
    expect(dso.getAttribute("data-max")).toBe("365");
    // The step is the pack's own `reach_step`, in the unit the cell is in:
    // 0.01 of a ratio is ONE percentage point on a field measured in percent.
    expect(SERVED.drivers.revenue_growth.reach_step).toBe("0.01");
    expect(
      screen.getByTestId("forecast-lever-step-revenue_growth").textContent,
    ).toContain("1");
    expect(
      screen.getByTestId("forecast-lever-step-revenue_growth").textContent,
    ).not.toContain("0.0001");
  });

  it("an answer landing mid-word does not rewrite what the reader is typing", async () => {
    // `<input type="number">` reports `value === ""` the instant a decimal
    // point is typed ("12." is not a valid floating-point number), this page
    // reads an empty cell as "leave the year at the engine's own value", and
    // the re-sync then wrote the SERVED figure back under the cursor. Measured
    // in Chrome, one keypress at a time: "1" -> "1", "2" -> "12", "." -> "2.5",
    // "5" -> "2.55". The cell is a text field now, and the re-sync stops while
    // the cell has focus.
    renderPage();
    await screen.findByTestId("forecast-levers");
    const input = screen.getByTestId(
      "forecast-lever-input-revenue_growth-0",
    ) as HTMLInputElement;
    expect(
      input.getAttribute("type"),
      "a number input eats the decimal point out of every lever on this page",
    ).toBe("text");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "12" } });
    // The empty read is exactly what a number input hands back mid-decimal;
    // whatever produces it, the served value must not land on top of the
    // reader while the cell is theirs.
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "12.5" } });
    expect(input.value).toBe("12.5");
    // On blur the re-sync is live again — and what it syncs TO is the value
    // the cell stands on, which is still the reader's own pending edit. A
    // blurred cell showing the engine's old figure while the override is in
    // flight would be the page contradicting the request it just sent.
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe("12.5"));
    // Drop the override and the cell goes back to the engine's figure.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe("2.5"));
  });

  it("a cell stays typeable while its own recompute is in flight", async () => {
    // The debounce already coalesces keystrokes and a stale answer is dropped
    // by the query key. Disabling the field for the round trip drops every
    // keystroke after the first — and in a real browser it also BLURS the
    // field, because disabling a focused element blurs it. "12.5" became "1".
    forecastRecompute.mockImplementation(() => new Promise(() => {}));
    await editThrough("1");
    const input = screen.getByTestId(
      "forecast-lever-input-revenue_growth-0",
    ) as HTMLInputElement;
    expect(
      input.disabled,
      "the lever cell is disabled while the server answers, so a multi-digit " +
        "value cannot be typed at normal speed",
    ).toBe(false);
    fireEvent.change(input, { target: { value: "12.5" } });
    expect(input.value).toBe("12.5");
    // The page still says a recompute is in flight — the rail reports the
    // state, it just no longer takes the keyboard away to report it.
    expect(
      screen.getByTestId("forecast-recompute-state").getAttribute("data-recomputing"),
    ).toBe("true");
  });

  it("the buttons that would send a DIFFERENT set are the ones held back", async () => {
    // Reset and adopt each replace the whole lever in one click, so firing one
    // mid-flight would queue a second set behind the first. They stay disabled;
    // the number cells do not. Served over a copy whose revenue growth stands
    // on `user`, which is what makes the reset control render at all.
    const edited = JSON.parse(JSON.stringify(SERVED));
    edited.drivers.revenue_growth.basis.original = {
      ...edited.drivers.revenue_growth.basis,
      tier: "macro",
    };
    edited.drivers.revenue_growth.basis.tier = "user";
    forecast.mockResolvedValue(edited);
    forecastRecompute.mockImplementation(() => new Promise(() => {}));
    await editThrough("1");
    expect(
      (screen.getByTestId("forecast-lever-reset-revenue_growth") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("forecast-lever-input-revenue_growth-0") as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });
});

describe("the free-cash-flow chart is readable", () => {
  it("draws the per-period bars on their own scale, not squashed under the running total", async () => {
    // A per-period FLOW and a RUNNING TOTAL do not share a range: the
    // cumulative's last point set the domain and every bar rendered two to
    // five pixels in a 166 px plot — the chart read as a flat line on the axis.
    renderPage();
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
  it("quotes the payload's own base period, never the app's active-period context", async () => {
    // These two can disagree. `useActivePeriod()` is the app-wide selection
    // and is mocked here to "Dec 2025"; the served projection stands on
    // `base_period.label`. The banner is the page's honesty statement about
    // the one ACTUAL figure underneath every projection on screen, so it
    // must name the period the payload was computed from — and it must not
    // read as a hole when the app context has not resolved.
    forecast.mockResolvedValue(SERVED);
    renderPage();
    const banner = await screen.findByTestId("forecast-banner");
    await waitFor(() => expect(screen.getByTestId("forecast-strip")).toBeTruthy());
    const label = SERVED.base_period.label as string;
    expect(banner.textContent, `the banner names ${label}`).toContain(label);
    expect(banner.textContent, "and does not name the app's active period instead")
      .not.toContain(PERIOD.label);
    expect(banner.textContent, "and never renders its anchor as an em dash")
      .not.toContain("of —");
  });

  it("keeps naming it while a REFUSED recompute holds the projection on screen", async () => {
    // The refusal repair keeps the last SERVED projection rendered. The
    // sentence that explains what those figures stand on has to stay true
    // for exactly as long as they are visible — it reads off the held view,
    // not off the query that just errored.
    forecast.mockResolvedValue(SERVED);
    const sentence = "dso_days: 400 is outside 0 to 365";
    forecastRecompute.mockRejectedValue(
      new CfoApiError(sentence, 422, { code: "out_of_bounds", text: sentence, field: "dso_days" }),
    );
    renderPage();
    await screen.findByTestId("forecast-levers");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(screen.getByTestId("forecast-lever-input-dso_days-0"), {
      target: { value: "400" },
    });
    await act(async () => {
      vi.advanceTimersByTime(SERVED.client.debounce_ms + 25);
    });
    await waitFor(() => expect(forecastRecompute).toHaveBeenCalled());
    vi.useRealTimers();

    await waitFor(() => expect(screen.getByTestId("forecast-stale-notice")).toBeTruthy());
    expect(screen.queryByTestId("forecast-strip"), "the projection is still on screen")
      .not.toBeNull();
    const banner = screen.getByTestId("forecast-banner");
    expect(
      banner.textContent,
      "the held projection still stands on a named period, not on an em dash",
    ).toContain(SERVED.base_period.label as string);
    expect(banner.textContent).not.toContain("of —");
  });
});
