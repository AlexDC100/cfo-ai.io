// PM1-PM7 — the FRONTEND half of the GLOBAL PUBLIC MARKETS gates.
//
// The engine half lives in scripts/check_public_market_gates.py (the
// checks) and tests/engine/test_public_market_gates.py (the plants that
// prove each check can fail). This file is the same idea on this side of
// the wire, and it is deliberately NOT a second functional suite:
//
//   · benchmarkHonesty.test.ts   already tests the grouping law and the
//                                small-n states, thoroughly;
//   · marketApi.test.ts          already tests ordering, tabs, fetch
//                                fallback and refusal passthrough;
//   · marketRegistryDrift.test.ts already pins the bundled mirror to
//                                markets.yaml;
//   · marketHonestStates.test.tsx already tests what those states RENDER.
//
// Re-asserting any of that here would be a mirror, and mirrors drift.
// What this file owns is the part no functional suite covers:
//
//   THE PLANTS   — a deliberately wrong implementation fed to the same
//                  predicate, asserted to trip. A predicate nobody has
//                  watched fail is a green light wired to nothing.
//   THE SEAMS    — properties that span two lanes and therefore belong
//                  to neither: the back door around the grouping gate,
//                  the small-n threshold that must be ONE number across
//                  three surfaces, and whether a market added to
//                  markets.yaml alone actually reaches a tab.
//
// Anything here that records a KNOWN GAP says so in its name and is
// mirrored in design_review/markets/GATES.md.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BenchmarkIntegrityError,
  MIN_N_FOR_PERCENTILES,
  assertHomogeneous,
  benchmarkKeyOf,
  computeBenchmarkStats,
  isRefusalState,
  partitionByKey,
  type BenchmarkMember,
  type BenchmarkStats,
} from "@/lib/benchmarkGroups";
import {
  BUNDLED_MARKETS,
  BUNDLED_REGISTRY,
  MARKET_STATUSES,
  fetchMarketRegistry,
  orderMarkets,
  type MarketEntry,
} from "@/lib/marketApi";

const REPO = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

// ─────────────────────────────────────────────────────────────────────
// Fixtures — the smallest rows that are still real rows
// ─────────────────────────────────────────────────────────────────────

function member(
  ticker: string,
  exchange: string,
  value: number,
  overrides: Partial<BenchmarkMember> = {},
): BenchmarkMember {
  return {
    ticker,
    name: `${ticker} SA`,
    exchange,
    currency: exchange === "BVB" ? "RON" : "USD",
    fiscalLabel: "FY2024",
    value,
    ...overrides,
  };
}

const BVB = (t: string, v: number) => member(t, "BVB", v);
const US = (t: string, v: number) => member(t, "NASDAQ", v);
const DE = (t: string, v: number) => member(t, "XETRA", v, { currency: "EUR" });

const HIGH_IS_GOOD = { goodHigh: true } as const;

// ═════════════════════════════════════════════════════════════════════
// PM2 — no cross-standard / cross-market blending
//
// The grouping law itself is covered by benchmarkHonesty.test.ts. What
// is gated here is the BACK DOOR: whether a percentile can be reached
// without passing the law.
// ═════════════════════════════════════════════════════════════════════

describe("PM2 — the grouping gate has no back door", () => {
  it("PLANT: a blended sample handed straight to the statistic THROWS", () => {
    // Skipping partitionByKey is the obvious shortcut a future caller
    // takes. computeBenchmarkStats must refuse on its own, not trust
    // that someone partitioned first.
    expect(() =>
      computeBenchmarkStats([BVB("TLV", 10), US("AAPL", 20)], HIGH_IS_GOOD),
    ).toThrow(BenchmarkIntegrityError);
  });

  it("PLANT: US_GAAP beside IFRS throws — the market axis catches it first", () => {
    // Worth pinning because it is a NESTING fact, not an accident: the
    // accounting standard is derived from the market group, so two
    // standards can never coexist without two market groups, and the
    // market-group check is the one that fires. If a future build ever
    // lets the standard vary WITHIN a group, benchmarkHonesty.test.ts
    // owns that case directly.
    try {
      computeBenchmarkStats([US("AAPL", 10), DE("SAP", 20)], HIGH_IS_GOOD);
      throw new Error("computeBenchmarkStats returned a blended statistic");
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkIntegrityError);
      expect((err as BenchmarkIntegrityError).code).toBe("MIXED_MARKET_GROUP");
      expect((err as BenchmarkIntegrityError).detail).toContain("AAPL");
      expect((err as BenchmarkIntegrityError).detail).toContain("SAP");
    }
    // ...and the standards really are different, which is what makes the
    // refusal necessary rather than incidental.
    expect(benchmarkKeyOf(US("AAPL", 1)).accountingStandard).not.toBe(
      benchmarkKeyOf(DE("SAP", 1)).accountingStandard,
    );
  });

  it("the refusal is thrown, never returned — a blended stat is unrenderable", () => {
    // A returned refusal object can be ignored by a caller that only
    // reads `.median`. An exception cannot.
    let returned: BenchmarkStats | null = null;
    try {
      returned = computeBenchmarkStats([BVB("TLV", 1), DE("SAP", 2)], HIGH_IS_GOOD);
    } catch {
      /* expected */
    }
    expect(returned).toBeNull();
  });

  it("a clean cohort still computes — the gate is not 'refuse everything'", () => {
    const stats = computeBenchmarkStats(
      [US("AAPL", 30), US("MSFT", 20), US("NVDA", 10)],
      HIGH_IS_GOOD,
    );
    expect(stats.kind).toBe("percentiles");
  });

  // ── the source-level back door ──────────────────────────────────────
  //
  // A second quantile implementation on a market surface is a percentile
  // that never passed the grouping law. `quantile` in benchmarkGroups.ts
  // is module-private precisely so there is one door; this scan makes
  // sure nobody cuts another one.
  const QUANTILE_DECL =
    /(function|const)\s+(median|percentile|quantile|p25|p75)\b/g;

  /** Files allowed to declare their own quantile-shaped helper, each
   *  with the reason. Keyed by path so the exemption is as narrow as the
   *  fact that earns it. An entry without a reason is not an entry. */
  const QUANTILE_ALLOWLIST: Record<string, string> = {
    "frontend/lib/benchmarkGroups.ts":
      "IS the gate — computeBenchmarkStats is the one entry point and its " +
      "quantile is module-private so the grouping law cannot be bypassed",
    "frontend/components/public-companies/MarketPulseStrip.tsx":
      "medians a unit-free day-change (%) over the ALREADY market-scoped " +
      "rows the page hands it, and prints n beside the figure — not a " +
      "cross-standard fundamentals percentile. Flagged in GATES.md: its " +
      "headline median has no minimum-n of its own, it relies on the " +
      "caller's scoping",
  };

  const MARKET_SURFACE_FILES = [
    "frontend/lib/benchmarkGroups.ts",
    "frontend/lib/marketApi.ts",
    "frontend/components/public-companies/MarketPulseStrip.tsx",
    "frontend/components/public-companies/MarketSurface.tsx",
    "frontend/components/public-companies/MarketTabs.tsx",
    "frontend/components/public-companies/MarketsOverview.tsx",
    "frontend/components/public-companies/BenchmarkingPanel.tsx",
    "frontend/components/public-companies/pciData.ts",
  ].filter((p) => existsSync(resolve(REPO, p)));

  it("PLANT: the scan catches a hand-rolled quantile (non-vacuity)", () => {
    const poisoned = "function percentile(xs: number[], q: number) { return 0; }";
    expect([...poisoned.matchAll(QUANTILE_DECL)]).not.toHaveLength(0);
  });

  it("no market surface declares a quantile outside the gate", () => {
    expect(MARKET_SURFACE_FILES.length).toBeGreaterThan(4); // non-vacuity
    const violations: string[] = [];
    for (const file of MARKET_SURFACE_FILES) {
      if (file in QUANTILE_ALLOWLIST) continue;
      const hits = [...read(file).matchAll(QUANTILE_DECL)].map((m) => m[2]);
      if (hits.length > 0) violations.push(`${file}: ${hits.join(", ")}`);
    }
    expect(violations).toEqual([]);
  });

  it("every quantile allowlist entry carries a reason and a real file", () => {
    for (const [file, reason] of Object.entries(QUANTILE_ALLOWLIST)) {
      expect(existsSync(resolve(REPO, file))).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
      // A stale entry silently widens the scan, so the file must still
      // actually declare one.
      expect([...read(file).matchAll(QUANTILE_DECL)].length).toBeGreaterThan(0);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// PM3 — small-n honesty
//
// The states themselves are covered by benchmarkHonesty.test.ts. What is
// gated here is the THRESHOLD: it is one number, and it has to be the
// same number on all three surfaces that use it.
// ═════════════════════════════════════════════════════════════════════

describe("PM3 — the small-n threshold is one number", () => {
  it("PLANT: a stats object claiming percentiles at n=2 trips the predicate", () => {
    const planted = {
      kind: "percentiles",
      n: 2,
      median: 15,
    } as unknown as BenchmarkStats;
    // The predicate under test: below the threshold, only a refusal
    // state is admissible.
    const admissible =
      planted.n >= MIN_N_FOR_PERCENTILES || isRefusalState(planted);
    expect(admissible).toBe(false);
  });

  it.each([1, 2])("n=%i produces a refusal state, never percentiles", (n) => {
    const members = Array.from({ length: n }, (_, i) => US(`T${i}`, 10 + i));
    const stats = computeBenchmarkStats(members, HIGH_IS_GOOD);
    expect(isRefusalState(stats)).toBe(true);
    expect(stats).not.toHaveProperty("median");
  });

  it("n=3 with spread earns percentiles — the threshold is not a refusal", () => {
    const stats = computeBenchmarkStats(
      [US("A", 10), US("B", 20), US("C", 30)],
      HIGH_IS_GOOD,
    );
    expect(isRefusalState(stats)).toBe(false);
  });

  // The same 3 appears in three places. If any one of them drifts, one
  // surface starts publishing a distribution the others refuse to.
  it("matches the engine gate and the public_ro hub threshold", () => {
    const pyGate = read("scripts/check_public_market_gates.py");
    const gateN = /MIN_COHORT_N\s*=\s*(\d+)/.exec(pyGate);
    expect(gateN, "MIN_COHORT_N vanished from the engine gate").not.toBeNull();
    expect(Number(gateN![1])).toBe(MIN_N_FOR_PERCENTILES);

    const seo = read("src/engine/public_ro/seo.py");
    const hubN = /HUB_MIN_COMPANIES\s*=\s*(\d+)/.exec(seo);
    expect(hubN, "HUB_MIN_COMPANIES vanished from public_ro").not.toBeNull();
    expect(Number(hubN![1])).toBe(MIN_N_FOR_PERCENTILES);
  });

  it("a refusal state still names who was in the room", () => {
    // Small-n honesty is not "show nothing" — that would be the blank
    // tab again. The members must survive the refusal.
    const stats = computeBenchmarkStats([US("A", 10), US("B", 20)], HIGH_IS_GOOD);
    expect(stats.kind).toBe("too_few");
    expect((stats as { members: unknown[] }).members).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════
// PM5 — no blank tab (keyless)
// ═════════════════════════════════════════════════════════════════════

describe("PM5 — no blank tab", () => {
  /** The blank-tab predicate: a tab a person could look at and learn
   *  nothing from. One implementation, fed both the plant and the real
   *  registry. */
  function blankTabViolations(markets: readonly MarketEntry[]): string[] {
    const out: string[] = [];
    for (const m of markets) {
      for (const field of [
        "market_id",
        "display_name",
        "currency",
        "accounting_standard",
        "license_notes",
        "coverage_note",
        "status",
      ] as const) {
        if (!String(m[field] ?? "").trim()) out.push(`${m.market_id}: empty ${field}`);
      }
      if (!MARKET_STATUSES.includes(m.status)) {
        out.push(`${m.market_id}: status ${m.status} outside the vocabulary`);
      }
    }
    return out;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PLANT: an unlabeled market trips the predicate", () => {
    const planted = [{ ...BUNDLED_MARKETS[0], display_name: "" }];
    expect(blankTabViolations(planted)).toContain(
      `${planted[0].market_id}: empty display_name`,
    );
  });

  it("PLANT: a market with a status outside the vocabulary trips", () => {
    const planted = [
      { ...BUNDLED_MARKETS[0], status: "coming_soon" as MarketEntry["status"] },
    ];
    expect(blankTabViolations(planted).join(" ")).toContain("outside the vocabulary");
  });

  it("every bundled market is fully labeled", () => {
    expect(BUNDLED_MARKETS.length).toBeGreaterThanOrEqual(8); // non-vacuity
    expect(blankTabViolations(BUNDLED_MARKETS)).toEqual([]);
  });

  it("a dead engine still yields a fully labeled market list", async () => {
    // Keyless AND engineless is the worst honest case; it must still
    // render every market, and must not claim a holdings count it never
    // received.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const registry = await fetchMarketRegistry();
    expect(registry.origin).toBe("bundled");
    expect(registry.holdingsKnown).toBe(false);
    expect(blankTabViolations(registry.markets)).toEqual([]);
  });

  it("Romania leads, in its own group", () => {
    // BUNDLED_REGISTRY, not orderMarkets(BUNDLED_MARKETS): the raw
    // bundle rows carry no `group` — it is derived when the registry
    // value is built, exactly as registry.py derives it server-side.
    const ordered = BUNDLED_REGISTRY.markets;
    expect(ordered[0].market_id).toBe("ro");
    expect(ordered[0].group).toBe("romania");
  });

  it("the marquee is US, DE, UK, FR, IT, ES, CN, AE", () => {
    // The briefed order, pinned on the surface a person actually sees.
    const marquee = BUNDLED_REGISTRY.markets
      .filter((m) => m.group === "marquee")
      .map((m) => m.market_id);
    expect(marquee).toEqual(["us", "de", "uk", "fr", "it", "es", "cn", "ae"]);
  });

  it("ordering is computed, not incidental to file order", () => {
    const shuffled = [...BUNDLED_REGISTRY.markets].reverse();
    expect(orderMarkets(shuffled).map((m) => m.market_id)).toEqual(
      BUNDLED_REGISTRY.markets.map((m) => m.market_id),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════
// PM6 — registry-only extension reaches the UI
//
// The engine half proves a market added to markets.yaml alone reaches
// the API with its honest state and zero engine edits. That is only half
// the promise: if the frontend rendered its own hardcoded list, the new
// market would still have no tab. This is the other half.
// ═════════════════════════════════════════════════════════════════════

describe("PM6 — a market added to markets.yaml alone reaches a tab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** ISO 3166 reserves ZZ for private use and XTS for testing, so this
   *  row can never collide with a real market. Same fixture the engine
   *  gate plants (check_public_market_gates.FICTIONAL_MARKET_YAML). */
  const FICTIONAL: MarketEntry = {
    market_id: "zz",
    display_name: "Zzyzx Exchange (PM6 gate fixture)",
    exchanges: ["ZZX"],
    currency: "XTS",
    accounting_standard: "IFRS",
    price_source: "licensed_provider_slot",
    fundamentals_source: "none",
    refresh_cadence: "none",
    license_notes: "PM6 gate fixture.",
    marquee_rank: null as unknown as number,
    status: "awaiting_provider",
    coverage_note: "Added to markets.yaml only, to prove it reaches a tab.",
    entities_held: 0,
  };

  it("is NOT in the bundled mirror — otherwise this proves nothing", () => {
    expect(BUNDLED_MARKETS.map((m) => m.market_id)).not.toContain("zz");
  });

  it("a market only the API knows about still reaches the ordered list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          schema: BUNDLED_REGISTRY.schema,
          markets: [...BUNDLED_MARKETS, FICTIONAL],
          counts: {},
        }),
      }),
    );
    const registry = await fetchMarketRegistry();
    expect(registry.origin).toBe("api");
    const ids = registry.markets.map((m) => m.market_id);
    expect(ids).toContain("zz");
    // ...in the A→Z tail, never claiming a marquee slot.
    expect(registry.markets.find((m) => m.market_id === "zz")!.group).toBe("rest");
    expect(ids[0]).toBe("ro");
  });

  it("the API is the authority; the bundle is only the fallback", async () => {
    // A frontend that preferred its own copy would silently pin the
    // market list to build time — the hardcoded list, one indirection
    // away.
    const renamed = BUNDLED_MARKETS.map((m) =>
      m.market_id === "us" ? { ...m, display_name: "United States (from API)" } : m,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ markets: renamed, counts: {} }),
      }),
    );
    const registry = await fetchMarketRegistry();
    expect(
      registry.markets.find((m) => m.market_id === "us")!.display_name,
    ).toBe("United States (from API)");
  });

  it("the fictional market is not left behind in the bundle", () => {
    // The revert, asserted: nothing above mutated the module-level
    // bundle that every other surface reads.
    expect(BUNDLED_MARKETS.map((m) => m.market_id)).not.toContain("zz");
    expect(BUNDLED_REGISTRY.markets.map((m) => m.market_id)).not.toContain("zz");
  });
});

// ═════════════════════════════════════════════════════════════════════
// PM7 — the home market is never blended, and peer-add never widens
// ═════════════════════════════════════════════════════════════════════

describe("PM7 — the home market keeps its own cohort", () => {
  it("PLANT: a BVB row beside a global row THROWS, naming the axis", () => {
    try {
      assertHomogeneous([BVB("TLV", 1), US("AAPL", 2)]);
      throw new Error("a BVB + global sample was accepted");
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkIntegrityError);
      expect((err as BenchmarkIntegrityError).code).toBe("MIXED_MARKET_GROUP");
    }
  });

  it("Romania is its own cohort, and it leads", () => {
    const cohorts = partitionByKey([US("AAPL", 1), BVB("TLV", 2), DE("SAP", 3)]);
    expect(cohorts.map((c) => c.key.marketGroup)).toEqual(["ro", "us", "de"]);
    expect(cohorts[0].members.map((m) => m.ticker)).toEqual(["TLV"]);
  });

  it("peer-add creates a SECOND cohort — it never widens the first", () => {
    // The regression this gate exists for: a peer picker that resolves a
    // ticker without re-checking its listing would drop a USD NASDAQ row
    // into a RON BVB median.
    const home = [BVB("TLV", 10), BVB("BRD", 20), BVB("SNP", 30)];
    const before = partitionByKey(home);
    expect(before).toHaveLength(1);
    expect(before[0].members).toHaveLength(3);

    const after = partitionByKey([...home, US("AAPL", 40)]);
    expect(after).toHaveLength(2);
    const ro = after.find((c) => c.key.marketGroup === "ro")!;
    expect(ro.members.map((m) => m.ticker).sort()).toEqual(["BRD", "SNP", "TLV"]);
    expect(ro.members.map((m) => m.ticker)).not.toContain("AAPL");
  });

  it("an unrecognised venue gets its OWN cohort, never the home one", () => {
    // Folding an unknown exchange into a known market is how a wrong
    // number gets a confident label. ABSENT != ZERO applies to venues.
    const cohorts = partitionByKey([BVB("TLV", 1), member("???", "MOEX", 2)]);
    expect(cohorts.map((c) => c.key.marketGroup).sort()).toEqual(["ro", "unknown"]);
  });

  it("the home market's accounting standard is not overwritten by a peer", () => {
    expect(benchmarkKeyOf(BVB("TLV", 1)).accountingStandard).toBe("RAS/IFRS");
    expect(benchmarkKeyOf(US("AAPL", 1)).accountingStandard).toBe("US_GAAP");
  });
});
