// THE VALUATION TAB NEVER SAVES A REFUSED EBITDA AS A 0 OVERRIDE.
//
// A refused EBITDA is served as `inputs.ebitda_used = null` with its typed
// reason. The component used to seed its local EBITDA state with
// `ebitda_used ?? 0` and send `ebitda_used: overrides.ebitda ?? ebitda` on
// EVERY save — so editing Total debt or moving the multiple slider on a
// refused period PUT `{"ebitda_used": 0, ...}`. The engine then applied the
// user override (`_first(ua.ebitda_used, computed)` = 0.0), routed on
// `ebitda_not_positive`, and the page showed an editable "EBITDA RON 0"
// in place of the refusal. The same save also pinned a SERVED EBITDA as a
// user assumption whenever only debt / cash / the multiple moved.
//
// REDS ON: any save that sends an EBITDA the user did not type — a 0 on a
// refused period, or the served figure on a served one. CANNOT SEE: the
// engine's handling of a null override (tests/engine/
// test_valuation_one_ebitda.py pins that half).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  }),
}));

import { renderWithProviders } from "@/test/renderWithProviders";
import { ValuationSection } from "@/components/cfo/ValuationSection";
import type { PeriodValuation } from "@/lib/activePeriod";

type Put = { url: string; body: Record<string, unknown> };
let puts: Put[] = [];

beforeEach(() => {
  puts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") puts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function valuationOf(over: Partial<PeriodValuation>): PeriodValuation {
  return {
    primary_method: "asset_based",
    confidence: "low",
    multiples_source: null,
    multiples_as_of_date: null,
    formula_text: "",
    method_warnings: [],
    inputs: { ebitda_used: null, revenue_used: 1_000_000, total_debt_used: 0, cash_used: 0 },
    primary: {
      method: "asset_based", multiple_p25: 6, multiple_p50: 8, multiple_p75: 10,
      ev_p25: null, ev_p50: null, ev_p75: null, equity_p25: null, equity_p50: null, equity_p75: null,
    },
    cross_checks: {
      revenue_multiple: { multiple_p25: null, multiple_p50: null, multiple_p75: null, equity_p25: null, equity_p50: null, equity_p75: null },
      dcf: { wacc: null, terminal_growth: null, enterprise_value: null, equity_value: null, sensitivity_low: null, sensitivity_high: null },
    },
    football_field: [],
    user_assumptions: null,
    ...over,
  } as PeriodValuation;
}

const REFUSED = valuationOf({
  ebitda_refusal: { code: "account_121_anchor_absent", text_en: "account 121 is absent" },
  routing: { basis: "ebitda_refused" },
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("a refused EBITDA is never saved as a 0 override", () => {
  it("editing Total debt sends no EBITDA", async () => {
    renderWithProviders(<ValuationSection periodId="p" currency="RON" valuation={REFUSED} />);
    const debt = screen.getByTestId("valuation-input-debt");
    fireEvent.change(debt, { target: { value: "5000" } });
    fireEvent.blur(debt);
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain("/api/period/p/valuation-assumptions");
    expect(puts[0].body.debt_used).toBe(5000);
    expect(puts[0].body.ebitda_used).toBeNull();
    // the refusal is still what the page states
    expect(screen.getByTestId("valuation-ebitda-refused").textContent).toContain("account 121 is absent");
    expect(screen.queryByTestId("valuation-input-ebitda")).toBeNull();
  });

  it("moving the multiple slider sends no EBITDA", async () => {
    vi.useFakeTimers();
    renderWithProviders(<ValuationSection periodId="p" currency="RON" valuation={REFUSED} />);
    fireEvent.change(screen.getByTestId("valuation-input-multiple"), { target: { value: "9" } });
    await act(async () => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].body.multiple_used).toBe(9);
    expect(puts[0].body.ebitda_used).toBeNull();
    expect(Object.values(puts[0].body)).not.toContain(undefined);
  });
});

describe("a served EBITDA is saved only when the user typed it", () => {
  const SERVED = valuationOf({
    primary_method: "ev_ebitda",
    inputs: { ebitda_used: 11_848_065.27, revenue_used: 110_798_309.14, total_debt_used: 0, cash_used: 0 },
  });

  it("editing Cash does not pin the served EBITDA as a user assumption", async () => {
    renderWithProviders(<ValuationSection periodId="p" currency="RON" valuation={SERVED} />);
    const cash = screen.getByTestId("valuation-input-cash");
    fireEvent.change(cash, { target: { value: "1000" } });
    fireEvent.blur(cash);
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].body.cash_used).toBe(1000);
    expect(puts[0].body.ebitda_used).toBeNull();
  });

  it("a typed EBITDA is sent, and kept on the next save", async () => {
    renderWithProviders(<ValuationSection periodId="p" currency="RON" valuation={SERVED} />);
    const e = screen.getByTestId("valuation-input-ebitda");
    fireEvent.change(e, { target: { value: "9000000" } });
    fireEvent.blur(e);
    await flush();
    const debt = screen.getByTestId("valuation-input-debt");
    fireEvent.change(debt, { target: { value: "5000" } });
    fireEvent.blur(debt);
    await flush();
    expect(puts.map((p) => p.body.ebitda_used)).toEqual([9_000_000, 9_000_000]);
  });

  it("an EBITDA override saved earlier is kept when only debt moves", async () => {
    renderWithProviders(
      <ValuationSection
        periodId="p"
        currency="RON"
        valuation={valuationOf({
          primary_method: "ev_ebitda",
          inputs: { ebitda_used: 9_000_000, revenue_used: 110_798_309.14, total_debt_used: 0, cash_used: 0 },
          user_assumptions: { ebitda_used: 9_000_000, multiple_used: null, debt_used: null, cash_used: null },
        })}
      />,
    );
    const debt = screen.getByTestId("valuation-input-debt");
    fireEvent.change(debt, { target: { value: "5000" } });
    fireEvent.blur(debt);
    await flush();
    expect(puts[0].body.ebitda_used).toBe(9_000_000);
  });
});

// BOOK EQUITY REFUSED (critic fixer round 1, 2026-09-27): the engine
// refuses the asset-based value when total equity excludes a refused
// year's result (`asset_based_refusal`, no primary value). The tab states
// it — never a bare "—" where the primary value would be. A stored row the
// one-EBITDA law withheld (`primary_method: "refused"`) prints its reason.
describe("a refused asset-based value and a withheld stored row print their reason", () => {
  it("book equity refused: the banner and the primary value say refused, with the engine's reason", () => {
    renderWithProviders(<ValuationSection valuation={valuationOf({
      ebitda_refusal: { code: "ebitda_refused", text_en: "account 121 is absent" },
      asset_based_refusal: {
        code: "total_equity_incomplete", cause: "account_121_anchor_absent",
        text_en: "total equity excludes the year's result, which is refused: account 121 is absent",
      },
      primary_equity_value: null,
    })} periodId="p1" currency="RON" />);
    expect(screen.getByTestId("valuation-asset-based-refused").textContent)
      .toContain("total equity excludes the year's result, which is refused: account 121 is absent");
    expect(screen.getByTestId("valuation-equity-p50").textContent).toBe("refused");
  });

  it("a stored row on the previous EBITDA: no EBITDA, the stored row's reason, no EV/EBITDA value", () => {
    renderWithProviders(<ValuationSection valuation={valuationOf({
      primary_method: "refused",
      primary_label: "Valuation refused",
      ebitda_refusal: {
        code: "ebitda_refused",
        text_en: "the stored valuation was computed on another EBITDA (10.78M RON) than the one served (11.85M RON)",
      },
    })} periodId="p1" currency="RON" />);
    expect(screen.getByTestId("valuation-ebitda-refused").textContent)
      .toContain("the stored valuation was computed on another EBITDA (10.78M RON)");
    expect(screen.getByTestId("valuation-equity-p50").textContent).toBe("—");
  });
});
