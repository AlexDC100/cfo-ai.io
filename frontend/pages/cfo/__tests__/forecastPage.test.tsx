/**
 * THE FORECAST PAGE — what a reader actually sees, and what they must never
 * be able to mistake.
 *
 * DIVISION OF LABOUR, stated because it is what makes this file honest.
 * The SHAPE of the payload below is not asserted here — it is pinned by
 * `tests/engine/test_forecast_route.py`, which takes the real engine's bytes
 * for all four corpus books at both horizons and feeds them back through
 * their own contract. That matters: the fp1 lane's wave-1 defect was exactly
 * a suite that inspected a served shape and never once read it back, and a
 * second one that only ever read a hand-written INPUT-shaped fixture. A shape
 * nobody feeds back is a shape nobody has read.
 *
 * What THIS file owns is the screen: given a valid projection, does the page
 * paint every figure as projected, refuse the ones with nothing behind them,
 * and put the assumptions where a reader meets them before the numbers?
 *
 * WHAT IT REDS ON (TC-11)
 *   · a projected figure painting without its marker;
 *   · a refusal painting a number (a zero especially) instead of an em-dash;
 *   · the assumption schedule moving BELOW the statements, or losing the
 *     basis column — a reader who has not seen the assumptions is not ready
 *     to read the numbers;
 *   · a driver the book could not measure rendering as 0 rather than as the
 *     words that say it was not measurable;
 *   · the "these are projections" banner becoming dismissible or absent;
 *   · a non-closing balance sheet rendering as a note rather than an error.
 *
 * WHAT IT CANNOT SEE
 *   · whether the numbers are right. They are arithmetic over stated
 *     drivers, and `tests/engine/test_forecast_model.py` owns that.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import Forecast from "../Forecast";

const PERIOD = { id: "p-1", label: "Dec 2025" };

vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => PERIOD,
}));

const forecast = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return {
    ...actual,
    cfoApi: { forecast: (...args: unknown[]) => forecast(...args) },
  };
});

/** A projection in the fp1 wire shape. Small on purpose — the real payload
 *  for one 3-year run is ~800 figures, and its shape is pinned on the engine
 *  side against the real bytes. */
function projection(overrides: Record<string, unknown> = {}) {
  return {
    kind: "projection",
    contract: "fp1",
    currency: "RON",
    base_period: { label: "Dec 2025", snapshot_id: "snap-1" },
    horizon: ["FY2026", "FY2027"],
    assumptions: [
      {
        id: "revenue_growth",
        label: "revenue growth",
        unit: "ratio",
        values: { FY2026: 0.08, FY2027: 0.08 },
        basis: "supplied by the caller [caller]",
        derived_from: [],
      },
      {
        id: "depreciation_rate",
        label: "depreciation rate",
        unit: "ratio",
        values: { FY2026: null, FY2027: null },
        basis:
          "this book carries no depreciable base, so no rate is implied [engine_default]",
        derived_from: [],
      },
      {
        id: "held_at_opening_balance",
        label: "held at opening balance",
        unit: "convention",
        values: { FY2026: null, FY2027: null },
        basis:
          "balance-sheet lines this model does not drive are HELD at their opening balance [engine_default]",
        derived_from: [],
      },
    ],
    figures: [
      {
        line: "pl.revenue",
        period: "FY2026",
        amount_minor: 12806296521,
        amount_minor_projected: 12806296521,
        projected: true,
        assumption_ids: ["revenue_growth"],
        basis: [
          {
            id: "revenue_growth",
            label: "revenue growth",
            unit: "ratio",
            value: 0.08,
            basis: "supplied by the caller [caller]",
            derived_from: [],
          },
        ],
        formula: "prior.revenue * (1 + revenue_growth)",
      },
    ],
    balance_check: [
      { period: "FY2026", difference_minor: 0, balances: true },
      { period: "FY2027", difference_minor: 0, balances: true },
    ],
    unbalanced_periods: [],
    ...overrides,
  };
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
});

describe("the forecast page", () => {
  it("paints a projected figure WITH its marker, never as a bare number", async () => {
    forecast.mockResolvedValue(projection());
    renderPage();

    const row = await screen.findByTestId("forecast-row-pl.revenue");
    const painted = row.querySelector('[data-projected="true"]');
    expect(
      painted,
      "a projected figure painted without the projected marker — the marker " +
        "and the value are rendered in the same expression from the same " +
        "marker precisely so there is no path that paints one without the other",
    ).not.toBeNull();
    expect(painted?.getAttribute("data-projected-basis")).toBe("revenue_growth");
    expect(painted?.getAttribute("data-projected-base-period")).toBe("Dec 2025");
    expect(within(row).getByText(/projected/i)).toBeTruthy();
  });

  it("renders a line the projection does not carry as an em-dash, not a zero", async () => {
    forecast.mockResolvedValue(projection());
    renderPage();

    // pl.ebitda is in the page's block list and NOT in this payload.
    const row = await screen.findByTestId("forecast-row-pl.ebitda");
    const refused = row.querySelector('[data-projected="refused"]');
    expect(
      refused,
      "a line the projection does not carry must refuse — 'we did not " +
        "project this' and 'this is zero' are different claims and only one " +
        "of them may look like a number",
    ).not.toBeNull();
    expect(refused?.textContent).toBe("—");
    expect(row.textContent).not.toMatch(/\b0\b/);
  });

  it("puts the assumptions ABOVE the statements, with the basis of each", async () => {
    forecast.mockResolvedValue(projection());
    renderPage();

    const assumptions = await screen.findByTestId("forecast-assumptions");
    const pl = screen.getByTestId("forecast-block-pl");
    expect(
      assumptions.compareDocumentPosition(pl) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the assumption schedule must come first — a reader who has not seen " +
        "the assumptions is not ready to read the numbers",
    ).toBeTruthy();

    const growth = within(assumptions).getByTestId(
      "forecast-assumption-revenue_growth",
    );
    expect(growth.textContent).toMatch(/8\.0+%/);
    expect(growth.textContent).toMatch(/supplied by the caller/);
  });

  it("states an unmeasurable driver in words, never as a zero", async () => {
    forecast.mockResolvedValue(projection());
    renderPage();

    const row = await screen.findByTestId("forecast-assumption-depreciation_rate");
    expect(
      row.textContent,
      "a rate the book could not measure and a rate of 0% are opposite " +
        "claims; only one of them may render as a number",
    ).not.toMatch(/0\.0%/);
    expect(row.textContent).toMatch(/not measurable from this book/i);
    expect(row.textContent).toMatch(/no depreciable base/);
  });

  it("renders a convention with no number at all", async () => {
    forecast.mockResolvedValue(projection());
    renderPage();

    const row = await screen.findByTestId(
      "forecast-assumption-held_at_opening_balance",
    );
    expect(row.getAttribute("data-assumption-unit")).toBe("convention");
    expect(row.textContent).toMatch(/HELD at their opening balance/);
    expect(row.textContent).not.toMatch(/%/);
  });

  it("carries a standing, non-dismissible projection banner", async () => {
    forecast.mockResolvedValue(projection());
    renderPage();

    const banner = await screen.findByTestId("forecast-banner");
    expect(banner.textContent).toMatch(/every figure on this page is a projection/i);
    expect(banner.textContent).toContain("Dec 2025");
    expect(
      banner.querySelector("button"),
      "the banner must not be dismissible — the reader has to be able to " +
        "see, at any scroll position showing a number, that it is projected",
    ).toBeNull();
  });

  it("shows a non-closing balance sheet as an ERROR, not a rounding note", async () => {
    forecast.mockResolvedValue(
      projection({
        unbalanced_periods: ["FY2027"],
        balance_check: [
          { period: "FY2026", difference_minor: 0, balances: true },
          { period: "FY2027", difference_minor: 411, balances: false },
        ],
      }),
    );
    renderPage();

    const check = await screen.findByTestId("forecast-balance-check");
    expect(check.getAttribute("data-balances")).toBe("false");
    expect(check.textContent).toContain("FY2027");
    expect(check.textContent).toMatch(/hard error/i);
  });

  it("hands the engine's own refusal to the reader, verbatim", async () => {
    forecast.mockRejectedValue(
      new Error(
        "the plan carries RON 4,112,004 of property, plant, equipment and " +
          "intangibles in 2026-01 and this book cannot price their " +
          "depreciation. Supply depreciation_rate.",
      ),
    );
    renderPage();

    const detail = await screen.findByTestId("forecast-refusal-detail");
    expect(
      detail.textContent,
      "the engine's sentence names the driver that could not be measured, " +
        "which is the only thing that tells the reader what to do next; a " +
        "generic message throws that away",
    ).toMatch(/Supply depreciation_rate/);
  });

  it("offers only the horizons the engine serves", async () => {
    forecast.mockResolvedValue(projection());
    renderPage();

    const bar = await screen.findByTestId("forecast-horizon");
    const buttons = within(bar).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "3 years",
      "5 years",
    ]);
    // 5 is the default, and it is the one pressed.
    expect(
      buttons.find((b) => b.getAttribute("aria-pressed") === "true")?.textContent,
    ).toBe("5 years");
    expect(forecast).toHaveBeenCalledWith("p-1", 5);
  });
});
