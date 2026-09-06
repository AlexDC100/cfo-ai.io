// A PRICE DAY IS NOT A FISCAL PERIOD — the public-company market tiles.
//
// `periodFieldOrigin` set `period: fiscal_period_end` on every figure
// and the valuation tab spread the market block's extras AFTER it, so
// Market Cap, Enterprise Value, EV/EBITDA and P/E each opened a card
// filing the day the price was observed under a fiscal year-end (critic
// finding #6, ea6df1f). `marketFieldOrigin` is the market figures' own
// helper: the served field, the pack, the observation day as computedAt
// — and NO Period row. The ratio helper keeps its period, because a
// ratio over a fiscal period belongs to one.

import { describe, expect, it } from "vitest";

import {
  derivedRatioOrigin,
  marketFieldOrigin,
  periodFieldOrigin,
} from "@/pages/cfo/publicCompanyOrigins";
import type { PublicCompanyPeriod } from "@/lib/publicCompanyApi";

const PERIOD = {
  schema_version: "1",
  normalizer_version: "nasdaq_sf1_normalizer_v3",
  source: "nasdaq_sharadar_sf1",
  ticker: "AAPL",
  dimension: "ARY",
  fiscal_period_end: "2025-09-27",
  currency: "USD",
} as unknown as PublicCompanyPeriod;

describe("marketFieldOrigin — a market figure", () => {
  it("names the served field, the pack and the observation day, and carries NO period", () => {
    const p = marketFieldOrigin(PERIOD, "market_cap", "2026-09-02");
    expect(p).toEqual({
      source: "nasdaq_sharadar_sf1 · market_metrics.market_cap",
      pack: "nasdaq_sf1_normalizer_v3",
      computedAt: "2026-09-02",
    });
    expect(p && "period" in p).toBe(false);
  });

  it("does not let the fiscal year-end leak in as the period of a price", () => {
    const p = marketFieldOrigin(PERIOD, "pe_ratio", "2026-09-02");
    expect(JSON.stringify(p)).not.toContain(PERIOD.fiscal_period_end);
  });
});

describe("periodFieldOrigin — a figure read off the period", () => {
  it("names the field, the pack and the fiscal period, and no timestamp", () => {
    const p = periodFieldOrigin(PERIOD, "headline.revenue");
    expect(p).toEqual({
      source: "nasdaq_sharadar_sf1 · headline.revenue",
      pack: "nasdaq_sf1_normalizer_v3",
      period: "2025-09-27",
    });
  });
});

describe("derivedRatioOrigin — a fiscal ratio", () => {
  it("keeps the fiscal period, because the ratio belongs to one", () => {
    const p = derivedRatioOrigin(PERIOD, "roe");
    expect(p?.period).toBe("2025-09-27");
    expect(p?.method).toBe("derived · computeRatios · roe");
    expect(p?.computedAt).toBeUndefined();
  });
});
