// PEER-ADD ACROSS MARKETS — the seam between the market card and the
// Benchmarking panel.
//
// Everything here runs against the REAL committed pm1 bytes
// (fixtures/us_AAPL_pm1.json — Apple's SEC companyfacts document as the
// route serves it). A hand-written peer object would prove only that the
// mock matches the reader; this repo has been burned by exactly that
// (root CLAUDE.md §21, "FakeStore doubles hid two total outages").
//
// The property under test is one sentence: a company added as a peer
// from a non-Romanian market must reach the Benchmarking panel, and must
// reach it as its OWN population. Three ways that can fail, all gated
// below:
//
//   1. it never arrives      — the old `buildBenchGroups` resolved peers
//                              only against the Romania-only universe, so
//                              a US ticker was stored and then silently
//                              dropped;
//   2. it arrives blended    — a peer that loses its market metadata
//                              lands in the home cohort and moves a RON
//                              RAS/IFRS median with USD US_GAAP figures;
//   3. it arrives inflated   — a cohort of one printing a median, a P25
//                              and a P75 against itself.

import { beforeEach, describe, expect, it } from "vitest";

import {
  MIN_N_FOR_PERCENTILES,
  benchmarkKeyOf,
  computeBenchmarkStats,
  isRefusalState,
  partitionByKey,
  type BenchmarkMember,
  type BenchmarkSubject,
} from "@/lib/benchmarkGroups";
import {
  addPeer,
  clearPeers,
  getPeers,
  isPeer,
  peerEntryKey,
  removePeer,
  type PeerEntry,
} from "@/lib/benchmarkPeersStore";
import type { MarketCompanyDocument, MarketEnvelope } from "@/lib/marketApi";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import type { WatchlistRow } from "@/lib/publicCompanyWatchlist";

import {
  peerDraftFromMarketDocument,
  peerFiscalLabel,
  peerMetricsFromEnvelope,
  peerNativeCurrency,
} from "../MarketPeerAdd";
import { buildBenchGroups, defaultBenchGroupKey } from "../pciData";
import fixture from "./fixtures/us_AAPL_pm1.json";

const APPLE = fixture as unknown as MarketCompanyDocument;

beforeEach(() => {
  // clearPeers(), not localStorage.clear() — the store is the authority
  // and this keeps the suite independent of the test env's storage shim.
  clearPeers();
});

// ═════════════════════════════════════════════════════════════════════
// 1. What the document actually supports
// ═════════════════════════════════════════════════════════════════════

describe("a peer is read out of the document, never inferred", () => {
  it("carries market, native currency, accounting standard and fiscal label", () => {
    const draft = peerDraftFromMarketDocument(APPLE)!;
    expect(draft).not.toBeNull();
    expect(draft.ticker).toBe("AAPL");
    expect(draft.name).toBe("Apple Inc.");
    expect(draft.marketId).toBe("us");
    expect(draft.accountingStandard).toBe("US_GAAP");
    expect(draft.currency).toBe("USD");
    // FY2025 (period ending 2025-09-27) — the ANNUAL set the ratios came
    // from, not shares_outstanding's later FY2026 Q3 stamp.
    expect(draft.fiscalLabel).toBe("FY2025");
  });

  it("does NOT invent an exchange the filing never named", () => {
    // The US registry lists NYSE *and* NASDAQ; the envelope names
    // neither. Picking one would be a guess that then decides a cohort.
    const draft = peerDraftFromMarketDocument(APPLE)!;
    expect(draft.exchange).toBeNull();
    // ...and the market id alone still resolves the population.
    expect(benchmarkKeyOf({ ...draft, fiscalLabel: "FY2025" }).marketGroup).toBe("us");
  });

  it("computes only the ratios the figures support", () => {
    const m = peerMetricsFromEnvelope(APPLE.envelope);
    // 112.01B / 416.161B = 26.91%
    expect(m.net_margin_pct).toBeCloseTo(26.91, 1);
    // 98.657B / 73.733B = 1.338x
    expect(m.debt_to_equity).toBeCloseTo(1.338, 2);
    // No EBITDA and no cash are extracted for US by design, so every
    // EBITDA- or price-linked metric is ABSENT, not zero.
    expect(m).not.toHaveProperty("ebitda_margin_pct");
    expect(m).not.toHaveProperty("net_debt_to_ebitda");
    expect(m).not.toHaveProperty("ev_ebitda");
    expect(m).not.toHaveProperty("fcf_yield_pct");
    expect(m).not.toHaveProperty("dividend_yield_pct");
    // One filing is one year — no growth rate without a prior one.
    expect(m).not.toHaveProperty("revenue_growth_pct");
  });

  it("PLANT: a ratio across two different fiscal periods is refused", () => {
    const env = structuredClone(APPLE.envelope) as MarketEnvelope;
    // Move net income to a different period end; the pair stops being a
    // fact about one year.
    (env.figures!.net_income as { fiscal?: { end?: string } }).fiscal = {
      end: "2024-09-28",
    };
    expect(peerMetricsFromEnvelope(env)).not.toHaveProperty("net_margin_pct");
    // The untouched pair still computes — the refusal is targeted.
    expect(peerMetricsFromEnvelope(env).debt_to_equity).toBeCloseTo(1.338, 2);
  });

  it("PLANT: a ratio across two currencies is refused", () => {
    const env = structuredClone(APPLE.envelope) as MarketEnvelope;
    env.figures!.equity.currency = "EUR";
    expect(peerMetricsFromEnvelope(env)).not.toHaveProperty("debt_to_equity");
  });

  it("PLANT: a zero denominator is refused, not rendered as Infinity", () => {
    const env = structuredClone(APPLE.envelope) as MarketEnvelope;
    env.figures!.revenue.value_minor = 0;
    expect(peerMetricsFromEnvelope(env)).not.toHaveProperty("net_margin_pct");
  });

  it("declares no native currency when the document mixes them", () => {
    const env = structuredClone(APPLE.envelope) as MarketEnvelope;
    expect(peerNativeCurrency(env)).toBe("USD");
    env.figures!.equity.currency = "EUR";
    expect(peerNativeCurrency(env)).toBeNull();
  });

  it("has no fiscal label to state when the figures carry no fiscal year", () => {
    const env = structuredClone(APPLE.envelope) as MarketEnvelope;
    for (const f of Object.values(env.figures ?? {})) {
      delete (f as { fiscal?: unknown }).fiscal;
    }
    delete env.fiscal_anchor;
    expect(peerFiscalLabel(env)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2. The store keeps (market, ticker) as one identity
// ═════════════════════════════════════════════════════════════════════

describe("peer identity is (market, ticker)", () => {
  it("round-trips the market metadata through the store", () => {
    addPeer(peerDraftFromMarketDocument(APPLE)!);
    const stored = getPeers().find((p) => p.ticker === "AAPL")!;
    expect(stored.marketId).toBe("us");
    expect(stored.accountingStandard).toBe("US_GAAP");
    expect(stored.currency).toBe("USD");
    expect(stored.metrics?.net_margin_pct).toBeCloseTo(26.91, 1);
  });

  it("two markets may each list the same ticker", () => {
    addPeer(peerDraftFromMarketDocument(APPLE)!);
    addPeer({
      ticker: "AAPL",
      name: "A Romanian company that happens to share a ticker",
      sector: null,
      exchange: "BVB",
      currency: "RON",
      marketId: "ro",
    });
    expect(getPeers()).toHaveLength(2);
    expect(new Set(getPeers().map(peerEntryKey)).size).toBe(2);
    expect(isPeer("AAPL", "us")).toBe(true);
    expect(isPeer("AAPL", "ro")).toBe(true);
    expect(isPeer("AAPL", "de")).toBe(false);
  });

  it("adding twice from the same market is a no-op", () => {
    addPeer(peerDraftFromMarketDocument(APPLE)!);
    addPeer(peerDraftFromMarketDocument(APPLE)!);
    expect(getPeers()).toHaveLength(1);
  });

  it("removal is scoped to the market when one is given", () => {
    addPeer(peerDraftFromMarketDocument(APPLE)!);
    addPeer({
      ticker: "AAPL", name: "Other", sector: null,
      exchange: "BVB", currency: "RON", marketId: "ro",
    });
    removePeer("AAPL", "us");
    expect(getPeers().map((p) => p.marketId)).toEqual(["ro"]);
  });

  it("the legacy ticker-only callers still remove what they always did", () => {
    addPeer({ ticker: "TLV", name: "Banca Transilvania", sector: null, exchange: "BVB", currency: "RON" });
    expect(isPeer("TLV")).toBe(true);
    removePeer("TLV");
    expect(getPeers()).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 3. The peer reaches the panel — and reaches it as its own population
// ═════════════════════════════════════════════════════════════════════

const BVB_WATCHLIST: WatchlistRow[] = [
  {
    ticker: "CFH", name: "Cris-Tim Family Holding S.A.",
    sector: "Consumer Defensive", industry: "Food Processing — Meat",
    exchange: "BVB", currency: "RON",
    market_cap_usd: 1_050_000_000, revenue_usd: 1_160_000_000,
    ebitda_margin_pct: 12, net_debt_to_ebitda: 1.2, pe_ratio: 12.1,
    ev_ebitda: 8, fcf_yield_pct: 4.5, dividend_yield_pct: 3,
    revenue_growth_pct: 8, last_updated_iso: "2024-12-31", status: "demo",
  },
];

function bvbSnapshot(ticker: string, netMargin: number): PublicCompanyFinancialSnapshot {
  // Annotated on the declaration rather than asserted with `as`. The
  // assertion was doing real work and hiding it: `missingFields: []`
  // infers `undefined[]`, which does not overlap `string[]`, so the object
  // was NOT a valid snapshot and the cast said it was. A test fixture that
  // asserts its own shape stops being evidence about the real type.
  const snapshot: PublicCompanyFinancialSnapshot = {
    ticker, companyName: `${ticker} S.A.`, exchange: "BVB",
    sector: "Consumer Defensive", currency: "RON", mode: "live",
    netMargin, debtToEquity: 0.8, latestPeriod: "FY2024",
    // "seed_bvb", not "bvb" — `UniverseSource` is
    // "demo" | "nasdaq" | "seed_bvb", and the backend tags BVB seed rows
    // "seed_bvb" (see PublicCompanySourceBadge). "bvb" appeared nowhere
    // else in the codebase; the `as PublicCompanyFinancialSnapshot`
    // assertion removed above was the only reason it compiled.
    lastUpdated: "2025-04-30", source: "seed_bvb", confidence: 1,
    missingFields: [],
  };
  return snapshot;
}

describe("buildBenchGroups — a non-RO peer arrives, in its own group", () => {
  it("REGRESSION: the US peer is no longer dropped on the floor", () => {
    const peers: PeerEntry[] = [
      { ...peerDraftFromMarketDocument(APPLE)!, source: "public", addedAt: "2026-08-30T00:00:00Z" },
    ];
    const groups = buildBenchGroups(BVB_WATCHLIST, [], peers);

    const peerGroup = groups.find((g) => g.key === "peers")!;
    expect(peerGroup, "the peers group must exist once a peer is added").toBeTruthy();
    expect(peerGroup.rows.map((r) => r.ticker)).toContain("AAPL");

    // ...and it is NOT inside the Romanian group. That is the blend.
    const bvb = groups.find((g) => g.key === "bvb")!;
    expect(bvb.rows.map((r) => r.ticker)).not.toContain("AAPL");
    // ...nor in the demo "Global" set, whose AAPL row carries
    // illustrative figures that would silently stand in for the real ones.
    const global = groups.find((g) => g.key === "global");
    expect(global?.rows.some((r) => r.ticker === "AAPL")).toBeFalsy();
  });

  it("the row carries the market id the cohort key needs", () => {
    const peers: PeerEntry[] = [
      { ...peerDraftFromMarketDocument(APPLE)!, source: "public", addedAt: "2026-08-30T00:00:00Z" },
    ];
    const row = buildBenchGroups(BVB_WATCHLIST, [], peers)
      .find((g) => g.key === "peers")!
      .rows.find((r) => r.ticker === "AAPL")!;
    expect(row.market_id).toBe("us");
    expect(row.accounting_standard).toBe("US_GAAP");
    expect(row.currency).toBe("USD");
    expect(row.fiscal_label).toBe("FY2025");
    expect(row.net_margin_pct).toBeCloseTo(26.91, 1);
    // Absent metrics are non-finite, so the statistic drops them rather
    // than counting a zero as a reported value.
    expect(Number.isFinite(row.ebitda_margin_pct)).toBe(false);
  });

  it("a Romanian peer still resolves against the loaded universe", () => {
    const peers: PeerEntry[] = [
      { ticker: "TLV", name: "Banca Transilvania", sector: null, exchange: "BVB",
        currency: "RON", marketId: "ro", source: "public", addedAt: "2026-08-30T00:00:00Z" },
    ];
    const groups = buildBenchGroups(BVB_WATCHLIST, [bvbSnapshot("TLV", 30)], peers);
    expect(groups.find((g) => g.key === "bvb")!.rows.map((r) => r.ticker)).toContain("TLV");
    const peerRow = groups.find((g) => g.key === "peers")!.rows.find((r) => r.ticker === "TLV")!;
    expect(peerRow.net_margin_pct).toBe(30); // the snapshot's own figure
  });

  it("the default group is the one that can actually show a foreign peer", () => {
    const noPeers = buildBenchGroups(BVB_WATCHLIST, [], []);
    expect(defaultBenchGroupKey(noPeers, null)).toBe("bvb"); // unchanged

    const withUsPeer = buildBenchGroups(BVB_WATCHLIST, [], [
      { ...peerDraftFromMarketDocument(APPLE)!, source: "public", addedAt: "2026-08-30T00:00:00Z" },
    ]);
    expect(defaultBenchGroupKey(withUsPeer, null)).toBe("peers");

    // A purely Romanian peer set does NOT hijack the default — the BVB
    // group already shows it.
    const withRoPeer = buildBenchGroups(BVB_WATCHLIST, [bvbSnapshot("TLV", 30)], [
      { ticker: "TLV", name: "Banca Transilvania", sector: null, exchange: "BVB",
        currency: "RON", marketId: "ro", source: "public", addedAt: "2026-08-30T00:00:00Z" },
    ]);
    expect(defaultBenchGroupKey(withRoPeer, null)).toBe("bvb");
  });
});

// ═════════════════════════════════════════════════════════════════════
// 4. DOD5 + DOD4 — a second cohort, labelled, with small-n honesty
// ═════════════════════════════════════════════════════════════════════

/** The exact adapter BenchmarkingPanel uses (rowToSubject), inlined so
 *  this file tests the shape the panel really partitions. */
function subject(r: WatchlistRow): BenchmarkSubject {
  return {
    ticker: r.ticker,
    name: r.name,
    exchange: r.exchange,
    marketId: r.market_id ?? null,
    currency: r.currency,
    fiscalLabel: r.fiscal_label || "FY2024",
  };
}

describe("DOD5 — peer-add creates a SECOND cohort, never a wider first", () => {
  const peers: PeerEntry[] = [
    { ...peerDraftFromMarketDocument(APPLE)!, source: "public", addedAt: "2026-08-30T00:00:00Z" },
    { ticker: "TLV", name: "Banca Transilvania", sector: null, exchange: "BVB",
      currency: "RON", marketId: "ro", source: "public", addedAt: "2026-08-30T00:00:00Z" },
  ];

  const rows = () =>
    buildBenchGroups(BVB_WATCHLIST, [bvbSnapshot("TLV", 30)], peers).find(
      (g) => g.key === "peers",
    )!.rows;

  it("partitions into Romania and US, Romania first", () => {
    const cohorts = partitionByKey(rows().map(subject));
    expect(cohorts.map((c) => c.key.marketGroup)).toEqual(["ro", "us"]);
    expect(cohorts[0].members.map((m) => m.ticker)).toEqual(["TLV"]);
    expect(cohorts[1].members.map((m) => m.ticker)).toEqual(["AAPL"]);
  });

  it("labels each cohort with its accounting standard", () => {
    const cohorts = partitionByKey(rows().map(subject));
    expect(cohorts[0].label).toBe("BVB · RON · RAS/IFRS");
    expect(cohorts[1].label).toBe("US · USD · US_GAAP");
    expect(cohorts[0].key.accountingStandard).not.toBe(cohorts[1].key.accountingStandard);
  });

  it("PLANT: a peer that loses its market metadata still never joins the home cohort", () => {
    // The failure mode this whole lane exists to prevent, simulated: the
    // market id is dropped somewhere between the card and the panel.
    // It must degrade to its OWN unclassified population, never widen
    // the Romanian one with USD US_GAAP figures.
    const stripped = rows().map((r) =>
      r.ticker === "AAPL" ? { ...r, market_id: null, exchange: "" } : r,
    );
    const cohorts = partitionByKey(stripped.map(subject));
    const ro = cohorts.find((c) => c.key.marketGroup === "ro")!;
    expect(ro.members.map((m) => m.ticker)).toEqual(["TLV"]);
    expect(cohorts.map((c) => c.key.marketGroup).sort()).toEqual(["ro", "unknown"]);
  });

  it("DOD4 — the lone US peer is n=1: named, never a percentile", () => {
    const cohorts = partitionByKey(rows().map(subject));
    const us = cohorts.find((c) => c.key.marketGroup === "us")!;
    const members: BenchmarkMember[] = us.members.map((m) => ({
      ...m,
      value: rows().find((r) => r.ticker === m.ticker)!.net_margin_pct!,
    }));

    const stats = computeBenchmarkStats(members, { goodHigh: true });
    expect(stats.n).toBe(1);
    expect(stats.n).toBeLessThan(MIN_N_FOR_PERCENTILES);
    expect(isRefusalState(stats)).toBe(true);
    expect(stats).not.toHaveProperty("median");
    expect(stats).not.toHaveProperty("p25");
    expect(stats).not.toHaveProperty("p75");
    // ...and it still says who was in the room.
    expect(stats.members.map((m) => m.ticker)).toEqual(["AAPL"]);
    expect((stats as { only: { ticker: string } }).only.ticker).toBe("AAPL");
  });

  it("the Romanian cohort's own statistic is untouched by the peer", () => {
    // PM7 restated at the value level: adding AAPL must not change one
    // number on the Romanian side.
    const roOnly = BVB_WATCHLIST.map(subject).map((s, i) => ({
      ...s,
      value: [12, 18, 24][i % 3],
    }));
    const before = computeBenchmarkStats(roOnly, { goodHigh: true });
    const withPeer = partitionByKey([
      ...BVB_WATCHLIST.map(subject),
      subject(rows().find((r) => r.ticker === "AAPL")!),
    ]).find((c) => c.key.marketGroup === "ro")!;
    const after = computeBenchmarkStats(
      withPeer.members.map((m, i) => ({ ...m, value: [12, 18, 24][i % 3] })),
      { goodHigh: true },
    );
    expect(after.n).toBe(before.n);
    expect(after.members).toEqual(before.members);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. The chip row stays truthful once there are three parent groups
// ═════════════════════════════════════════════════════════════════════

describe("sector subgroups name their real parent", () => {
  it("a peers subgroup is not labelled 'Global'", () => {
    // The old label was `parent.key === "bvb" ? "BVB" : "Global"`, which
    // was correct only while exactly two parents existed.
    const roPeers: PeerEntry[] = ["TLV", "BRD", "SNP", "H2O"].map((ticker) => ({
      ticker, name: `${ticker} S.A.`, sector: null, exchange: "BVB",
      currency: "RON", marketId: "ro", source: "public",
      addedAt: "2026-08-30T00:00:00Z",
    }));
    const universe = [
      ...["TLV", "BRD", "SNP"].map((tk) => ({ ...bvbSnapshot(tk, 20), sector: "Financials" })),
      { ...bvbSnapshot("H2O", 30), sector: "Utilities" },
    ];
    const groups = buildBenchGroups(BVB_WATCHLIST, universe, roPeers);
    const sub = groups.find((g) => g.key === "peers-financials");
    expect(sub, "a 3-member sector inside the peers group earns a chip").toBeTruthy();
    expect(sub!.label).toBe("Peers · Financials");
    expect(sub!.label).not.toContain("Global");
    // ...and the BVB parent still names itself the way it always did.
    const bvbSub = groups.find((g) => g.key === "bvb-financials");
    if (bvbSub) expect(bvbSub.label).toBe("BVB · Financials");
  });
});
