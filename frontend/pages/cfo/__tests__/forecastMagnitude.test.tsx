/**
 * FC1 + FC2 — THE RENDERED NUMBER IS THE NUMBER.
 *
 * ── WHAT THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * The forecast page shipped rendering EVERY figure at one HUNDREDTH of its
 * value. Revenue for the year showed RON 4,137,276 while the assumption
 * schedule directly above it printed 413,727,560.16 in its own basis
 * sentence. One screen, two numbers, same concept, 100× apart — and the
 * document therefore contradicted itself in front of a lender.
 *
 * The cause was a second division. `projectedDisplay` in
 * `lib/forecastFacts.ts` does `minor / 100` and its docstring calls itself
 * "the single division, at the edge"; the page's own formatter divided
 * again. The producer was right, the serving lane was right, the boundary
 * was right. The PAGE was wrong.
 *
 * Nothing caught it. `forecastPage.test.tsx` asserts markers, refusals,
 * ordering and copy — every structural property — and never once asserts
 * that a painted number equals the number behind it. A gate that checks
 * everything about a figure except its VALUE is the gate this file adds.
 *
 * ── WHAT IT REDS ON (TC-11) ─────────────────────────────────────────────
 *   · any painted figure differing from its payload value (FC1);
 *   · a figure quoted inside BASIS PROSE differing from the same figure
 *     rendered in the table, to the cent (FC1 — the prose was outside
 *     every existing one-concept-one-value gate);
 *   · projected year-one revenue outside a declared band of the source
 *     period's revenue with no growth driver to explain it (FC2).
 * ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────
 *   · whether the engine's arithmetic is right. `test_forecast_model.py`
 *     owns that. This file only asserts that what the engine said is what
 *     the reader sees.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import Forecast from "../Forecast";

const PERIOD = { id: "p-1", label: "Dec 2025" };
vi.mock("@/lib/activePeriod", () => ({ useActivePeriod: () => PERIOD }));

const forecast = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return { ...actual, cfoApi: { forecast: (...a: unknown[]) => forecast(...a) } };
});

/** THE ENGINE'S OWN BYTES.
 *
 *  `fp1_agras_served.json`, the fixture that was already committed, is a
 *  hand-built five-line payload with three drivers whose bases read
 *  "supplied by the caller". It quotes no figure, so it could not have
 *  caught this defect and did not: the 100× error shipped past it.
 *
 *  This one is the real engine's output on the real agras book — 25
 *  drivers with the bases it derived ("cost of sales as a share of revenue
 *  = 70,557,114.68 (assembled_pl.cogs) / 118,576,819.64
 *  (assembled_pl.revenue)"), 57 figures, and it round-trips through
 *  `ProjectionContract` unchanged. Scoped to ONE period of the horizon,
 *  which is a valid fp1 payload and not a doctored one — every figure's
 *  period is in `horizon`, which is all the contract asks — because the
 *  full three-year payload is 3.6 MB (every figure inlines the full basis
 *  of every driver it names) and a fixture a human must review has to be
 *  reviewable. */
const PAYLOAD = JSON.parse(
  readFileSync(
    resolve(__dirname,
      "../../../../tests/engine/fixtures/forecast/fp1_agras_engine_one_period.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

function wrap() {
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

/** Every digit group in a rendered cell, as one number. Currency symbol,
 *  thin spaces and the ◇ marker are stripped; the sign is kept. */
function paintedNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d,.\-−]/g, "").replace(/−/g, "-");
  const digits = cleaned.replace(/[.,](?=\d{3}\b)/g, "").replace(/,/g, ".");
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

beforeEach(() => forecast.mockReset());

describe("FC1 — a painted figure equals its payload value", () => {
  it("no figure renders at a different magnitude from the bytes behind it", async () => {
    forecast.mockResolvedValue(PAYLOAD);
    wrap();
    await screen.findByTestId("forecast-assumptions");

    const figures = (PAYLOAD.figures ?? []) as Array<Record<string, unknown>>;
    const horizon = (PAYLOAD.horizon ?? []) as string[];
    const byKey = new Map<string, number>();
    for (const f of figures) {
      const minor = Number(f.amount_minor);
      if (Number.isFinite(minor)) byKey.set(`${f.line}|${f.period}`, minor / 100);
    }

    let checked = 0;
    for (const row of Array.from(document.querySelectorAll("[data-testid^='forecast-row-']"))) {
      const line = (row.getAttribute("data-testid") || "").replace("forecast-row-", "");
      const cells = Array.from(row.querySelectorAll("td")).slice(1);
      cells.forEach((cell, i) => {
        const period = horizon[i];
        if (!period) return;
        const expected = byKey.get(`${line}|${period}`);
        if (expected === undefined) return;              // refused — its own test
        const painted = paintedNumber(cell.textContent || "");
        if (painted === null) return;
        // Rounded to whole units for display, so the tolerance is one unit
        // — NOT one percent, which would let a 100× error through on a
        // small figure.
        expect(
          Math.abs(painted - expected),
          `${line}/${period}: painted ${painted}, payload ${expected} ` +
            `(ratio ${(expected === 0 ? 0 : painted / expected).toFixed(4)}) — ` +
            `a page that paints a figure at a different magnitude from the ` +
            `bytes behind it contradicts its own assumption schedule`,
        ).toBeLessThanOrEqual(1.0);
        checked += 1;
      });
    }
    expect(checked, "no figure was compared at all — the gate is vacuous").toBeGreaterThan(3);
  });

  it("a figure quoted in BASIS PROSE equals the same figure in the table", async () => {
    forecast.mockResolvedValue(PAYLOAD);
    wrap();
    const schedule = await screen.findByTestId("forecast-assumptions");

    // Every number the engine wrote into a driver's basis sentence.
    const quoted: number[] = [];
    for (const a of (PAYLOAD.assumptions ?? []) as Array<Record<string, unknown>>) {
      for (const m of String(a.basis ?? "").matchAll(/\b\d[\d,]{5,}(?:\.\d+)?\b/g)) {
        const n = Number(m[0].replace(/,/g, ""));
        if (Number.isFinite(n) && n > 1000) quoted.push(n);
      }
    }
    expect(quoted.length, "no basis sentence quotes a figure; gate is vacuous")
      .toBeGreaterThan(0);

    // The prose renders verbatim, so the same digits must be on screen.
    const scheduleText = schedule.textContent || "";
    for (const n of quoted.slice(0, 12)) {
      const asWritten = n.toLocaleString("en-US");
      expect(
        scheduleText.includes(asWritten) || scheduleText.includes(String(n)),
        `the basis prose quotes ${asWritten} and the rendered schedule does ` +
          `not contain it — the page states two values for one concept`,
      ).toBe(true);
    }
  });
});

describe("FC2 — magnitude sanity against the source period", () => {
  it("year-one revenue is within a declared band of the source revenue", async () => {
    forecast.mockResolvedValue(PAYLOAD);
    wrap();
    await screen.findByTestId("forecast-assumptions");

    const horizon = (PAYLOAD.horizon ?? []) as string[];
    const figures = (PAYLOAD.figures ?? []) as Array<Record<string, unknown>>;
    const yearOne = figures
      .filter((f) => String(f.line).endsWith(".revenue") && horizon.includes(String(f.period)))
      .reduce((sum, f) => sum + Number(f.amount_minor || 0) / 100, 0);

    // The source period's revenue, from the driver that names it.
    const basis = ((PAYLOAD.assumptions ?? []) as Array<Record<string, unknown>>)
      .map((a) => String(a.basis ?? ""))
      .find((b) => /revenue/i.test(b) && /\d[\d,]{6,}/.test(b)) ?? "";
    const match = basis.match(/([\d,]{7,}(?:\.\d+)?)/);
    if (!match) return;                                   // no stated source revenue
    const sourceRevenue = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(sourceRevenue) || sourceRevenue <= 0) return;

    // THE BAND, declared here and not inferred: year-one revenue may sit
    // anywhere from a halving to a doubling of the source period without
    // a driver explaining it. That is wide on purpose — it is not a
    // forecasting opinion, it is an ORDER-OF-MAGNITUDE tripwire. A 100×
    // shift is never inside it, and neither is 0.01×.
    const ratio = yearOne / sourceRevenue;
    expect(
      ratio,
      `year-one revenue ${yearOne.toLocaleString()} against source ` +
        `${sourceRevenue.toLocaleString()} is ${ratio.toFixed(4)}× — an ` +
        `order-of-magnitude shift no growth driver explains`,
    ).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });
});
