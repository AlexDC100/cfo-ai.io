// @vitest-environment jsdom
/**
 * FC1 / FC2 — NO 100× ON THE FORECAST COCKPIT.
 *
 * The forecast page once shipped rendering EVERY figure at one HUNDREDTH of
 * its value: `projectedDisplay` had already divided minor units by 100 and the
 * page's formatter divided again. Nothing caught it, because every suite
 * asserted markers and refusals and none compared a painted number with the
 * bytes behind it. This file does, on the cockpit (2026-09-21), over the
 * synthetic double of the engine's cockpit route.
 *
 * RED ON (TC-11):
 *   · FC1 — a statement cell painted at a different magnitude from its served
 *     `amount_minor` (tolerance ONE unit, never a percentage, which would let
 *     a 100× through on a small figure); a chart readout and the statement
 *     cell of the same served figure disagreeing about its size;
 *   · FC1b — one of the four numbers painted from a different field than the
 *     figure it names (the engine's display text vs its own figure);
 *   · FC2 — plan year one's revenue outside a halving-to-doubling band of the
 *     actual year's (an order-of-magnitude tripwire, not a forecasting view).
 * CANNOT SEE: whether the engine's arithmetic is right (its own gates).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import Forecast from "../Forecast";
import { syntheticCockpit } from "@/components/forecast/cockpit/__tests__/syntheticCockpit";

const PERIOD = { id: "p-1", label: "Dec 2025" };
vi.mock("@/lib/activePeriod", () => ({ useActivePeriod: () => PERIOD }));
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
const cockpitCall = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return { ...actual, cfoApi: { forecastCockpit: (...a: unknown[]) => cockpitCall(...a) } };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const PAYLOAD = syntheticCockpit({ caseId: "pesimist", funding: true, dscrBelow: true, seed: 3 }) as Json;

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Forecast />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** "RON 1,234,567" / "−RON 12" → 1234567 / −12; anything else → null. */
function paintedNumber(text: string): number | null {
  const t = text.replace(/ /g, " ").replace(/◇/g, "").trim();
  const neg = /^[-−]/.test(t) || /\(.*\)/.test(t);
  const digits = t.replace(/[^\d.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** "17.2M RON" / "123.5K RON" → units: the product standard, the code
 *  after the figure (owner ruling 2026-09-29) — a readout printed
 *  "RON 17.2M" reads as no figure at all. */
function compactNumber(text: string): number | null {
  const t = text.replace(/ /g, " ").replace(/◇/g, "").trim();
  const m = /(-|−)?([\d.,]+)\s*([kKmM])?\s*RON\b/.exec(t);
  if (!m) return null;
  const base = Number(m[2].replace(/,/g, ""));
  const scale = m[3] ? (m[3].toLowerCase() === "m" ? 1_000_000 : 1_000) : 1;
  return (m[1] ? -1 : 1) * base * scale;
}

beforeEach(() => {
  cockpitCall.mockReset();
  cockpitCall.mockResolvedValue(PAYLOAD);
});
afterEach(() => cleanup());

describe("FC1 — a painted figure equals its payload value", () => {
  it("no statement cell renders at a different magnitude from the bytes behind it", async () => {
    wrap();
    await screen.findByTestId("forecast-block-pl");
    const byKey = new Map<string, number>();
    for (const section of ["pl", "bs", "cf"]) {
      for (const row of PAYLOAD.statements[section] as Json[]) {
        for (const v of row.values as Json[]) byKey.set(`${row.line}|${v.period}`, v.amount_minor / 100);
        if (row.year0 && typeof row.year0.amount_minor === "number") {
          byKey.set(`${row.line}|${row.year0.period}`, row.year0.amount_minor / 100);
        }
      }
    }
    let checked = 0;
    for (const cell of Array.from(document.querySelectorAll("td[data-line][data-period]"))) {
      const expected = byKey.get(`${cell.getAttribute("data-line")}|${cell.getAttribute("data-period")}`);
      if (expected === undefined) continue;
      const painted = paintedNumber(cell.textContent || "");
      if (painted === null) continue;
      expect(
        Math.abs(painted - expected),
        `${cell.getAttribute("data-line")}/${cell.getAttribute("data-period")}: painted ${painted}, payload ${expected}`,
      ).toBeLessThanOrEqual(1.0);
      checked += 1;
    }
    expect(checked, "no figure was compared at all — the gate is vacuous").toBeGreaterThan(20);
  });

  it("a chart readout and the statement cell of the same served EBITDA agree about its size", async () => {
    wrap();
    await screen.findByTestId("cockpit-chart-readouts");
    let checked = 0;
    for (const y of ["FY2026", "FY2027", "FY2028", "FY2029", "FY2030"]) {
      const readout = document.querySelector(
        `[data-testid="cockpit-chart-readouts"] [data-period="${y}"] [data-series="ebitda"] [data-projected-value]`,
      );
      const cell = document.querySelector(`td[data-line="pl.ebitda"][data-period="${y}"] [data-projected-value]`);
      const compact = compactNumber(readout?.textContent ?? "");
      const full = paintedNumber(cell?.textContent ?? "");
      expect(compact, `${y}: the chart paints no EBITDA`).not.toBeNull();
      expect(full, `${y}: the statements paint no EBITDA`).not.toBeNull();
      // compact prints one decimal of the millions: half a hundred thousand
      expect(Math.abs((compact as number) - (full as number)), y).toBeLessThanOrEqual(50_000);
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});

describe("FC1b — the four numbers are the figures they name", () => {
  it("each of the engine's display texts states its own figure's magnitude", async () => {
    wrap();
    await screen.findByTestId("cockpit-numbers");
    const pairs: Array<[string, number]> = [
      ["cockpit-ebitda-final", PAYLOAD.numbers.ebitda_final_year.figure.amount_minor / 100],
      ["cockpit-cumulative-fcf", PAYLOAD.numbers.cumulative_fcf.figure.amount_minor / 100],
      ["cockpit-funding-need", PAYLOAD.numbers.cash.figure.amount_minor / 100],
    ];
    for (const [id, units] of pairs) {
      const painted = compactNumber(
        screen.getByTestId(id).querySelector("[data-projected-value]")?.textContent ?? "",
      );
      expect(painted, id).not.toBeNull();
      expect(Math.abs((painted as number) - units), `${id}: painted ${painted}, figure ${units}`).toBeLessThanOrEqual(50_000);
    }
  });
});

describe("FC2 — magnitude sanity against the actual year", () => {
  it("plan year one's PAINTED revenue is within a declared band of year 0's", async () => {
    wrap();
    await screen.findByTestId("forecast-block-pl");
    const y0 = paintedNumber(document.querySelector('td[data-line="pl.revenue"][data-period="FY2025"]')?.textContent ?? "");
    const y1 = paintedNumber(document.querySelector('td[data-line="pl.revenue"][data-period="FY2026"]')?.textContent ?? "");
    expect(y0, "no actual revenue painted; the band has nothing to stand on").not.toBeNull();
    expect(y1, "no plan-year-one revenue painted").not.toBeNull();
    // An ORDER-OF-MAGNITUDE tripwire, not a forecasting opinion: a 100× shift
    // is never inside it, and neither is 0.01×.
    const ratio = (y1 as number) / (y0 as number);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });
});
