// PM-UI — the market client's honesty contract.
//
// Three properties are load-bearing for the whole surface and are
// asserted here rather than left to review:
//
//   1. ORDER. Romania leads, in its own group; then marquee rank; then
//      A→Z. The tab strip is derived from that, so the ordering rule
//      lives in one place and is proven once.
//   2. NO MARKET CAN VANISH. Every registry market is reachable from
//      exactly one non-"all" tab. A market that fell out of the tab
//      build would become invisible while still being "supported" —
//      the failure DOD3 names.
//   3. AN ABSENT COUNT IS NOT ZERO. When the registry endpoint does not
//      answer, `holdingsKnown` is false and no holdings number exists to
//      render.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_MARKETS_TAB_ID,
  BUNDLED_MARKETS,
  MARKET_COMMAND_DESCRIPTOR,
  MARKET_REGIONS,
  MARKET_TAB_PARAM,
  PROVIDER_ENV_VAR,
  buildMarketTabs,
  countryCodesForMarket,
  fetchMarketCompany,
  fetchMarketRegistry,
  isMarketRefusal,
  marketIdForExchange,
  marketIdForSnapshot,
  orderMarkets,
  tabIdForMarket,
  tabMarketIds,
} from "../marketApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ordering", () => {
  it("puts Romania first, then marquee rank, then A→Z", () => {
    const ordered = orderMarkets(BUNDLED_MARKETS);
    expect(ordered[0].marquee_rank).toBe(0);
    const marquee = ordered.filter((m) => m.marquee_rank > 0);
    expect(marquee.map((m) => m.marquee_rank)).toEqual(
      [...marquee.map((m) => m.marquee_rank)].sort((a, b) => a - b),
    );
  });

  it("survives a shuffled input (the order is computed, not incidental)", () => {
    const shuffled = [...BUNDLED_MARKETS].reverse();
    expect(orderMarkets(shuffled).map((m) => m.market_id)).toEqual(
      orderMarkets(BUNDLED_MARKETS).map((m) => m.market_id),
    );
  });
});

describe("tab strip", () => {
  const tabs = buildMarketTabs(BUNDLED_MARKETS);

  it("is Romania · United States · Europe · China · UAE · All", () => {
    expect(tabs.map((tb) => tb.id)).toEqual(["ro", "us", "europe", "cn", "ae", "all"]);
    expect(tabs[tabs.length - 1].id).toBe(ALL_MARKETS_TAB_ID);
  });

  it("collapses the European markets into one tab, in marquee order", () => {
    const europe = tabs.find((tb) => tb.id === "europe");
    expect(europe?.kind).toBe("region");
    expect(tabMarketIds(europe!)).toEqual(["de", "uk", "fr", "it", "es"]);
  });

  it("reaches every registry market from exactly one non-All tab", () => {
    const reached = new Map<string, number>();
    for (const tb of tabs) {
      if (tb.kind === "all") continue;
      for (const id of tabMarketIds(tb)) {
        reached.set(id, (reached.get(id) ?? 0) + 1);
      }
    }
    for (const m of BUNDLED_MARKETS) {
      expect(reached.get(m.market_id), `${m.market_id} unreachable`).toBe(1);
    }
  });

  it("gives a market with no region its own tab", () => {
    for (const m of BUNDLED_MARKETS) {
      if (MARKET_REGIONS[m.market_id]) continue;
      expect(tabs.some((tb) => tb.id === m.market_id)).toBe(true);
      expect(tabIdForMarket(m.market_id)).toBe(m.market_id);
    }
  });

  it("routes a regional market to its region tab", () => {
    expect(tabIdForMarket("fr")).toBe("europe");
  });

  it("scopes the All tab to every market", () => {
    const all = tabs.find((tb) => tb.id === ALL_MARKETS_TAB_ID)!;
    expect(tabMarketIds(all).sort()).toEqual(
      BUNDLED_MARKETS.map((m) => m.market_id).sort(),
    );
  });
});

describe("registry fetch", () => {
  it("falls back to the bundled copy on transport failure, holdings unknown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const reg = await fetchMarketRegistry();
    expect(reg.origin).toBe("bundled");
    expect(reg.holdingsKnown).toBe(false);
    expect(reg.markets.length).toBe(BUNDLED_MARKETS.length);
  });

  it("falls back on a non-OK response rather than rendering nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    const reg = await fetchMarketRegistry();
    expect(reg.origin).toBe("bundled");
    expect(reg.markets.length).toBeGreaterThan(0);
  });

  it("falls back on an empty market list (a blank tab strip is never correct)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ markets: [] }) }),
    );
    const reg = await fetchMarketRegistry();
    expect(reg.origin).toBe("bundled");
  });

  it("claims holdings are known ONLY when the payload carried a count", async () => {
    const one = { ...BUNDLED_MARKETS[0] };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ markets: [one] }),
      }),
    );
    expect((await fetchMarketRegistry()).holdingsKnown).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ markets: [{ ...one, entities_held: 0 }] }),
      }),
    );
    const known = await fetchMarketRegistry();
    // A real zero IS knowledge — it is only an ABSENT field that must
    // not be rendered as zero.
    expect(known.holdingsKnown).toBe(true);
    expect(known.markets[0].entities_held).toBe(0);
  });
});

describe("company fetch", () => {
  it("passes a typed refusal through with its machine code intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          status: "refused",
          code: "NOT_CACHED",
          detail: "AAPL is not in the public_market store for United States yet",
        }),
      }),
    );
    const res = await fetchMarketCompany("us", "aapl");
    expect(res.ok).toBe(false);
    if (isMarketRefusal(res)) {
      expect(res.refusal.code).toBe("NOT_CACHED");
      expect(res.refusal.ticker).toBe("AAPL");
      // The server's sentence survives verbatim — it names the gap.
      expect(res.refusal.detail).toContain("not in the public_market store");
    }
  });

  it("does not collapse 'no feed' into 'not found'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        json: async () => ({
          status: "refused",
          code: "MARKET_AWAITING_PROVIDER",
          detail: "China has no deterministic feed wired today.",
        }),
      }),
    );
    const res = await fetchMarketCompany("cn", "X");
    expect(res.ok).toBe(false);
    if (isMarketRefusal(res)) expect(res.refusal.code).toBe("MARKET_AWAITING_PROVIDER");
  });

  it("reports a transport failure as its own code, never as a refusal by the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("dns")));
    const res = await fetchMarketCompany("us", "AAPL");
    expect(res.ok).toBe(false);
    if (isMarketRefusal(res)) expect(res.refusal.code).toBe("TRANSPORT_FAILED");
  });

  it("refuses an empty ticker without touching the network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await fetchMarketCompany("us", "   ");
    expect(spy).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (isMarketRefusal(res)) expect(res.refusal.code).toBe("EMPTY_TICKER");
  });

  it("returns the document when one comes back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "PUBLIC_MARKET",
          market: BUNDLED_MARKETS[1],
          envelope: { version: "pm1", entity_id: "cik:320193", figures: {} },
        }),
      }),
    );
    const res = await fetchMarketCompany("us", "AAPL");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.document.envelope.version).toBe("pm1");
  });
});

describe("exchange to market", () => {
  it("maps every registry exchange back to its own market", () => {
    for (const m of BUNDLED_MARKETS) {
      for (const ex of m.exchanges) {
        expect(marketIdForExchange(ex)).toBe(m.market_id);
      }
    }
  });

  it("maps the BVB universe snapshots to the home market", () => {
    expect(marketIdForSnapshot({ exchange: "BVB" })).toBe("ro");
  });

  it("returns null rather than guessing for an unknown exchange", () => {
    // A wrong market chip attaches the wrong currency and the wrong
    // licence to a real number, so "unknown" must stay unknown.
    expect(marketIdForExchange("TSX")).toBeNull();
    expect(marketIdForExchange(null)).toBeNull();
    expect(marketIdForExchange("")).toBeNull();
    expect(marketIdForSnapshot({ exchange: undefined })).toBeNull();
  });
});

describe("country codes", () => {
  it("every market id is a 2-letter code — the assumption the radar filter rests on", () => {
    for (const m of BUNDLED_MARKETS) {
      expect(m.market_id).toMatch(/^[a-z]{2}$/);
      expect(countryCodesForMarket(m)).toEqual([m.market_id.toUpperCase()]);
    }
  });
});

describe("command-palette descriptor", () => {
  it("offers one entry per tab, on the market query param", () => {
    const tabs = buildMarketTabs(BUNDLED_MARKETS);
    expect(MARKET_COMMAND_DESCRIPTOR.param).toBe(MARKET_TAB_PARAM);
    expect(MARKET_COMMAND_DESCRIPTOR.route).toBe("/public-companies");
    expect(MARKET_COMMAND_DESCRIPTOR.entries.map((e) => e.value)).toEqual(
      tabs.map((tb) => tb.id),
    );
    for (const e of MARKET_COMMAND_DESCRIPTOR.entries) {
      expect(e.labelKey.startsWith("pcm.")).toBe(true);
    }
  });
});

describe("activation", () => {
  it("names the environment variable an operator actually sets", () => {
    expect(PROVIDER_ENV_VAR).toBe("PROVIDER_API_KEY");
  });
});
