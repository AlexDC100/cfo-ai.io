// benchmarkHonesty.test.ts — the grouping law + small-n honesty.
//
// PM2 (no blended populations) and PM3 (small-n fixtures pinned at n=1
// and n=2) for the benchmarking surface. Everything here drives the real
// module — there is no mirror of the statistic in this file, because a
// second implementation of a percentile is exactly how the first one
// drifts (root CLAUDE.md, "FakeStore doubles hid two total outages").

import { describe, expect, it } from "vitest";

import {
  BenchmarkIntegrityError,
  MIN_N_FOR_PERCENTILES,
  assertHomogeneous,
  assertNativeSample,
  benchmarkKeyId,
  benchmarkKeyLabel,
  benchmarkKeyOf,
  computeBenchmarkStats,
  describeDisplayFx,
  fiscalAlignment,
  fiscalLabelFromIso,
  isRefusalState,
  marketGroupOfExchange,
  partitionByKey,
  type BenchmarkMember,
} from "../benchmarkGroups";

// ── Fixtures ─────────────────────────────────────────────────────────────
// Real-shaped rows: the two BVB names the demo watchlist actually ships
// (this is the n=2 group a user sees TODAY on /public-companies, which is
// what produced the live defect) plus US names for the mixing tests.

function member(over: Partial<BenchmarkMember> & { ticker: string; value: number }): BenchmarkMember {
  return {
    name: over.name ?? over.ticker,
    exchange: "BVB",
    currency: "RON",
    fiscalLabel: "FY2024",
    ...over,
  };
}

/** PM3 — n = 1. One BVB name and nothing to compare it to. */
const FIXTURE_N1: BenchmarkMember[] = [
  member({ ticker: "CFH", name: "Cris-Tim Family Holding S.A.", value: 12.0 }),
];

/** PM3 — n = 2. The demo watchlist's whole BVB cohort. */
const FIXTURE_N2: BenchmarkMember[] = [
  member({ ticker: "CFH", name: "Cris-Tim Family Holding S.A.", value: 12.0 }),
  member({ ticker: "TLV", name: "Banca Transilvania S.A.", value: 45.0 }),
];

/** n = 3, all identical — zero variance. */
const FIXTURE_FLAT: BenchmarkMember[] = [
  member({ ticker: "AAA", value: 8 }),
  member({ ticker: "BBB", value: 8 }),
  member({ ticker: "CCC", value: 8 }),
];

/** n = 5, real spread. */
const FIXTURE_SPREAD: BenchmarkMember[] = [
  member({ ticker: "AAA", value: 4 }),
  member({ ticker: "BBB", value: 8 }),
  member({ ticker: "CCC", value: 12 }),
  member({ ticker: "DDD", value: 16 }),
  member({ ticker: "EEE", value: 20 }),
];

const US = (ticker: string, value: number): BenchmarkMember =>
  member({ ticker, value, exchange: "NASDAQ", currency: "USD" });

const HIGH_IS_GOOD = { goodHigh: true } as const;
const LOW_IS_GOOD = { goodHigh: false } as const;

// ── 1. The grouping key ──────────────────────────────────────────────────

describe("grouping key (market group × currency × accounting standard)", () => {
  it("derives the three axes from the exchange and the member's own currency", () => {
    expect(benchmarkKeyOf(FIXTURE_N1[0]!)).toEqual({
      marketGroup: "ro",
      currency: "RON",
      accountingStandard: "RAS/IFRS",
    });
    expect(benchmarkKeyOf(US("AAPL", 34.4))).toEqual({
      marketGroup: "us",
      currency: "USD",
      accountingStandard: "US_GAAP",
    });
  });

  it("maps every exchange this build knows, and refuses to guess the rest", () => {
    expect(marketGroupOfExchange("BVB")).toBe("ro");
    expect(marketGroupOfExchange("nasdaq")).toBe("us"); // case-insensitive
    expect(marketGroupOfExchange("NYSE")).toBe("us");
    expect(marketGroupOfExchange("XETRA")).toBe("de");
    expect(marketGroupOfExchange("LSE")).toBe("uk");
    expect(marketGroupOfExchange("Euronext Paris")).toBe("fr");
    expect(marketGroupOfExchange("BME")).toBe("es");
    expect(marketGroupOfExchange("HKEX")).toBe("cn");
    expect(marketGroupOfExchange("ADX")).toBe("ae");
    // ABSENT != ZERO: an unheard-of venue gets its own bucket, it is
    // never folded into a known market.
    expect(marketGroupOfExchange("MOEX")).toBe("unknown");
    expect(marketGroupOfExchange(null)).toBe("unknown");
    expect(marketGroupOfExchange("")).toBe("unknown");
  });

  it("labels a cohort with all three axes so the population is legible", () => {
    expect(benchmarkKeyLabel(benchmarkKeyOf(FIXTURE_N1[0]!))).toBe("BVB · RON · RAS/IFRS");
    expect(benchmarkKeyLabel(benchmarkKeyOf(US("AAPL", 1)))).toBe("US · USD · US_GAAP");
    expect(benchmarkKeyId(benchmarkKeyOf(US("AAPL", 1)))).toBe("us|USD|US_GAAP");
  });

  it("lets a member's own currency override the registry default", () => {
    // A US-listed filer reporting in EUR is not in the USD population.
    const eurOnNasdaq = member({ ticker: "XEU", value: 5, exchange: "NASDAQ", currency: "EUR" });
    expect(benchmarkKeyOf(eurOnNasdaq).currency).toBe("EUR");
    expect(benchmarkKeyId(benchmarkKeyOf(eurOnNasdaq))).not.toBe(
      benchmarkKeyId(benchmarkKeyOf(US("AAPL", 1))),
    );
  });
});

// ── 2. PM2 — mixing throws, it does not degrade ──────────────────────────

describe("PM2: a heterogeneous sample THROWS", () => {
  it("refuses BVB blended with global names", () => {
    const mixed = [...FIXTURE_N2, US("AAPL", 34.4)];
    expect(() => computeBenchmarkStats(mixed, HIGH_IS_GOOD)).toThrow(BenchmarkIntegrityError);
    try {
      computeBenchmarkStats(mixed, HIGH_IS_GOOD);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as BenchmarkIntegrityError).code).toBe("MIXED_MARKET_GROUP");
    }
  });

  it("refuses US_GAAP blended with IFRS", () => {
    // Same currency (EUR is not involved) — the ONLY difference is the
    // ruler: a US filer and an LSE filer do not measure the same EBITDA.
    const sample = [
      member({ ticker: "AAA", value: 10, exchange: "NASDAQ", currency: "GBP" }),
      member({ ticker: "BBB", value: 12, exchange: "LSE", currency: "GBP" }),
    ];
    try {
      computeBenchmarkStats(sample, HIGH_IS_GOOD);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BenchmarkIntegrityError);
      // Market group is checked first and already separates these two;
      // either refusal is correct, neither is a silent blend.
      expect(["MIXED_MARKET_GROUP", "MIXED_ACCOUNTING_STANDARD"]).toContain(
        (e as BenchmarkIntegrityError).code,
      );
    }
  });

  it("refuses CAS blended with either of the others", () => {
    const sample = [
      member({ ticker: "AAA", value: 10, exchange: "SSE", currency: "CNY" }),
      member({ ticker: "BBB", value: 12, exchange: "XETRA", currency: "CNY" }),
    ];
    expect(() => computeBenchmarkStats(sample, HIGH_IS_GOOD)).toThrow(BenchmarkIntegrityError);
  });

  it("refuses two currencies inside one market group", () => {
    const sample = [
      member({ ticker: "AAA", value: 10, exchange: "NASDAQ", currency: "USD" }),
      member({ ticker: "BBB", value: 12, exchange: "NASDAQ", currency: "EUR" }),
    ];
    try {
      computeBenchmarkStats(sample, HIGH_IS_GOOD);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as BenchmarkIntegrityError).code).toBe("MIXED_CURRENCY");
    }
  });

  it("names the mixed axis and both offending tickers in the message", () => {
    try {
      computeBenchmarkStats([...FIXTURE_N2, US("AAPL", 1)], HIGH_IS_GOOD);
      throw new Error("expected a throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("MIXED_MARKET_GROUP");
      expect(msg).toContain("CFH");
      expect(msg).toContain("AAPL");
    }
  });

  it("assertHomogeneous returns the shared key for a clean sample", () => {
    expect(assertHomogeneous(FIXTURE_N2)).toEqual({
      marketGroup: "ro",
      currency: "RON",
      accountingStandard: "RAS/IFRS",
    });
    expect(assertHomogeneous([])).toBeNull();
  });

  it("partitionByKey turns a mixed list into clean cohorts instead of one lie", () => {
    const cohorts = partitionByKey([...FIXTURE_N2, US("AAPL", 34.4), US("MSFT", 48.1)]);
    expect(cohorts.map((c) => c.id)).toEqual(["ro|RON|RAS/IFRS", "us|USD|US_GAAP"]);
    // Romania is its own group and leads; then the marquee order.
    expect(cohorts[0]!.key.marketGroup).toBe("ro");
    // And every cohort now passes the gate it was built to satisfy.
    for (const c of cohorts) expect(() => assertHomogeneous(c.members)).not.toThrow();
  });

  it("orders cohorts Romania → US, DE, UK, FR, IT, ES, CN, AE → A→Z → unclassified", () => {
    const cohorts = partitionByKey([
      member({ ticker: "Z1", value: 1, exchange: "MOEX", currency: "RUB" }),
      member({ ticker: "A1", value: 1, exchange: "ADX", currency: "AED" }),
      member({ ticker: "C1", value: 1, exchange: "SSE", currency: "CNY" }),
      member({ ticker: "E1", value: 1, exchange: "BME", currency: "EUR" }),
      member({ ticker: "I1", value: 1, exchange: "BIT", currency: "EUR" }),
      member({ ticker: "F1", value: 1, exchange: "EPA", currency: "EUR" }),
      member({ ticker: "U1", value: 1, exchange: "LSE", currency: "GBP" }),
      member({ ticker: "D1", value: 1, exchange: "XETRA", currency: "EUR" }),
      US("S1", 1),
      member({ ticker: "R1", value: 1 }),
    ]);
    expect(cohorts.map((c) => c.key.marketGroup)).toEqual([
      "ro", "us", "de", "uk", "fr", "it", "es", "cn", "ae", "unknown",
    ]);
  });
});

// ── 3. FX never enters a percentile ──────────────────────────────────────

describe("FX: percentiles consume native values only", () => {
  it("refuses a sample carrying an fxConverted marker", () => {
    const converted = FIXTURE_SPREAD.map((m) => ({ ...m, fxConverted: true }));
    try {
      computeBenchmarkStats(converted, HIGH_IS_GOOD);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as BenchmarkIntegrityError).code).toBe("CONVERTED_VALUE");
    }
  });

  it("refuses a sample carrying a displayCurrency", () => {
    const converted = [...FIXTURE_SPREAD];
    converted[2] = { ...converted[2]!, displayCurrency: "EUR" };
    expect(() => computeBenchmarkStats(converted, HIGH_IS_GOOD)).toThrow(
      /CONVERTED_VALUE/,
    );
  });

  it("refuses converted values at the partition boundary too — there is no back door", () => {
    expect(() => partitionByKey([{ ...FIXTURE_N1[0]!, fxConverted: true }])).toThrow(
      BenchmarkIntegrityError,
    );
    expect(() => assertNativeSample([{ ...FIXTURE_N1[0]!, displayCurrency: "USD" }])).toThrow(
      BenchmarkIntegrityError,
    );
  });

  it("names the offending ticker and the display currency in the refusal", () => {
    try {
      assertNativeSample([{ ...FIXTURE_N1[0]!, displayCurrency: "EUR" }]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as Error).message).toContain("CFH");
      expect((e as Error).message).toContain("EUR");
    }
  });

  it("a clean native sample is accepted — the guard is not vacuous", () => {
    expect(() => assertNativeSample(FIXTURE_SPREAD)).not.toThrow();
    expect(computeBenchmarkStats(FIXTURE_SPREAD, HIGH_IS_GOOD).kind).toBe("percentiles");
  });

  it("display FX renders as a rate + source + date line, or not at all", () => {
    expect(
      describeDisplayFx({ from: "RON", to: "EUR", rate: 0.2012, asOf: "2026-08-29", source: "BNR" }),
    ).toBe("1 RON = 0.2012 EUR · BNR · 2026-08-29");
    expect(
      describeDisplayFx({ from: "EUR", to: "RON", rate: 4.97, asOf: "2026-08-29", source: "BNR" }),
    ).toBe("1 EUR = 4.970 RON · BNR · 2026-08-29");
    // No conversion happening → no line (never a tooltip with nothing in it).
    expect(
      describeDisplayFx({ from: "RON", to: "RON", rate: 1, asOf: "2026-08-29", source: "BNR" }),
    ).toBeNull();
    expect(describeDisplayFx(null)).toBeNull();
    // A rate we do not have is not a rate of 0.
    expect(
      describeDisplayFx({ from: "RON", to: "EUR", rate: 0, asOf: "2026-08-29", source: "BNR" }),
    ).toBeNull();
    expect(
      describeDisplayFx({ from: "RON", to: "EUR", rate: NaN, asOf: "2026-08-29", source: "BNR" }),
    ).toBeNull();
  });
});

// ── 4. Fiscal alignment is labeled, never silent ─────────────────────────

describe("fiscal alignment", () => {
  it("labels an aligned sample with its single year", () => {
    const fa = fiscalAlignment(FIXTURE_N2);
    expect(fa.aligned).toBe(true);
    expect(fa.label).toBe("FY2024");
  });

  it("labels a mixed sample 'FY2024 vs FY2023', newest first", () => {
    const mixed = [
      member({ ticker: "AAA", value: 1, fiscalLabel: "FY2023" }),
      member({ ticker: "BBB", value: 2, fiscalLabel: "FY2024" }),
      member({ ticker: "CCC", value: 3, fiscalLabel: "FY2024" }),
    ];
    const fa = fiscalAlignment(mixed);
    expect(fa.aligned).toBe(false);
    expect(fa.label).toBe("FY2024 vs FY2023");
    expect(fa.labels).toEqual(["FY2024", "FY2023"]);
  });

  it("carries the alignment on every stats state, including the refusals", () => {
    const mixed = [
      member({ ticker: "CFH", value: 12, fiscalLabel: "FY2024" }),
      member({ ticker: "TLV", value: 45, fiscalLabel: "FY2023" }),
    ];
    const stats = computeBenchmarkStats(mixed, HIGH_IS_GOOD);
    expect(stats.kind).toBe("too_few");
    expect(stats.fiscal.aligned).toBe(false);
    expect(stats.fiscal.label).toBe("FY2024 vs FY2023");
  });

  it("derives a fiscal label from an ISO date, and refuses to guess otherwise", () => {
    expect(fiscalLabelFromIso("2024-12-31")).toBe("FY2024");
    expect(fiscalLabelFromIso("2023-06-30T00:00:00Z")).toBe("FY2023");
    expect(fiscalLabelFromIso(null)).toBe("—");
    expect(fiscalLabelFromIso("")).toBe("—");
    expect(fiscalLabelFromIso("last year")).toBe("—");
  });
});

// ── 5. PM3 — small-n honesty (the live defect) ───────────────────────────

describe("PM3: small-n honesty", () => {
  it("n = 1 → single_comparable, no median, no spread, no leader/laggard", () => {
    const stats = computeBenchmarkStats(FIXTURE_N1, HIGH_IS_GOOD);
    expect(stats.kind).toBe("single_comparable");
    expect(isRefusalState(stats)).toBe(true);
    if (stats.kind !== "single_comparable") throw new Error("narrowing");
    expect(stats.n).toBe(1);
    expect(stats.only.ticker).toBe("CFH");
    expect(stats.only.value).toBe(12.0);
    // The union simply has no field to print a fake statistic from.
    expect(stats).not.toHaveProperty("median");
    expect(stats).not.toHaveProperty("p25");
    expect(stats).not.toHaveProperty("p75");
    expect(stats).not.toHaveProperty("leader");
    expect(stats).not.toHaveProperty("laggard");
  });

  it("n = 1 still names who was in the room", () => {
    const stats = computeBenchmarkStats(FIXTURE_N1, HIGH_IS_GOOD);
    expect(stats.members.map((m) => m.ticker)).toEqual(["CFH"]);
  });

  it("n = 2 → too_few, with the raw members shown", () => {
    const stats = computeBenchmarkStats(FIXTURE_N2, HIGH_IS_GOOD);
    expect(stats.kind).toBe("too_few");
    if (stats.kind !== "too_few") throw new Error("narrowing");
    expect(stats.n).toBe(2);
    expect(stats.minimumN).toBe(MIN_N_FOR_PERCENTILES);
    // Best-first: TLV's 45.0 leads on a higher-is-better metric.
    expect(stats.members.map((m) => m.ticker)).toEqual(["TLV", "CFH"]);
    expect(stats).not.toHaveProperty("median");
    expect(stats).not.toHaveProperty("p25");
    expect(stats).not.toHaveProperty("p75");
  });

  it("n = 2 on a lower-is-better metric reverses the raw ordering, nothing else", () => {
    const stats = computeBenchmarkStats(FIXTURE_N2, LOW_IS_GOOD);
    expect(stats.kind).toBe("too_few");
    expect(stats.members.map((m) => m.ticker)).toEqual(["CFH", "TLV"]);
  });

  it("zero variance at n >= 3 → the value ONCE, no fake P25/P75", () => {
    const stats = computeBenchmarkStats(FIXTURE_FLAT, HIGH_IS_GOOD);
    expect(stats.kind).toBe("zero_variance");
    if (stats.kind !== "zero_variance") throw new Error("narrowing");
    expect(stats.n).toBe(3);
    expect(stats.value).toBe(8);
    expect(stats).not.toHaveProperty("p25");
    expect(stats).not.toHaveProperty("p75");
    expect(stats).not.toHaveProperty("median");
    // No leader/laggard either — with no spread, naming one would be a
    // tie-break dressed up as a finding.
    expect(stats).not.toHaveProperty("leader");
    expect(stats).not.toHaveProperty("laggard");
  });

  it("no finite values → empty, not a zero", () => {
    const stats = computeBenchmarkStats(
      [
        member({ ticker: "AAA", value: NaN }),
        member({ ticker: "BBB", value: Number.POSITIVE_INFINITY }),
      ],
      HIGH_IS_GOOD,
    );
    expect(stats.kind).toBe("empty");
    expect(stats.n).toBe(0);
    expect(stats.members).toEqual([]);
  });

  it("a member with a missing value is dropped from n, never counted as 0", () => {
    const stats = computeBenchmarkStats(
      [...FIXTURE_N2, member({ ticker: "SNP", value: NaN })],
      HIGH_IS_GOOD,
    );
    expect(stats.n).toBe(2);
    expect(stats.kind).toBe("too_few");
    expect(stats.members.map((m) => m.ticker)).toEqual(["TLV", "CFH"]);
  });

  it("n >= 3 with real spread is the ONLY state that earns percentiles", () => {
    const stats = computeBenchmarkStats(FIXTURE_SPREAD, HIGH_IS_GOOD);
    expect(stats.kind).toBe("percentiles");
    expect(isRefusalState(stats)).toBe(false);
    if (stats.kind !== "percentiles") throw new Error("narrowing");
    expect(stats.n).toBe(5);
    expect(stats.median).toBe(12);
    expect(stats.p25).toBe(8);
    expect(stats.p75).toBe(16);
    expect(stats.leader.ticker).toBe("EEE");
    expect(stats.laggard.ticker).toBe("AAA");
    expect(stats.leader.ticker).not.toBe(stats.laggard.ticker);
  });

  it("leader and laggard follow the metric's direction", () => {
    const stats = computeBenchmarkStats(FIXTURE_SPREAD, LOW_IS_GOOD);
    if (stats.kind !== "percentiles") throw new Error("narrowing");
    expect(stats.leader.ticker).toBe("AAA");
    expect(stats.laggard.ticker).toBe("EEE");
    // Percentiles themselves are direction-free — they describe the
    // distribution, not the verdict.
    expect(stats.median).toBe(12);
    expect(stats.p25).toBe(8);
    expect(stats.p75).toBe(16);
  });

  it("n = 3 with spread produces percentiles — the threshold is not off by one", () => {
    const stats = computeBenchmarkStats(FIXTURE_SPREAD.slice(0, 3), HIGH_IS_GOOD);
    expect(stats.kind).toBe("percentiles");
    if (stats.kind !== "percentiles") throw new Error("narrowing");
    expect(stats.median).toBe(8);
  });

  it("ties are broken deterministically, so two renders never disagree", () => {
    const a = computeBenchmarkStats(
      [
        member({ ticker: "ZZZ", value: 5 }),
        member({ ticker: "AAA", value: 5 }),
        member({ ticker: "MMM", value: 9 }),
      ],
      HIGH_IS_GOOD,
    );
    const b = computeBenchmarkStats(
      [
        member({ ticker: "AAA", value: 5 }),
        member({ ticker: "MMM", value: 9 }),
        member({ ticker: "ZZZ", value: 5 }),
      ],
      HIGH_IS_GOOD,
    );
    expect(a.members).toEqual(b.members);
    expect(a.members.map((m) => m.ticker)).toEqual(["MMM", "AAA", "ZZZ"]);
  });

  it("every state carries the cohort key, so a rendered stat can always be attributed", () => {
    for (const sample of [FIXTURE_N1, FIXTURE_N2, FIXTURE_FLAT, FIXTURE_SPREAD]) {
      const stats = computeBenchmarkStats(sample, HIGH_IS_GOOD);
      expect(stats.key).toEqual({
        marketGroup: "ro",
        currency: "RON",
        accountingStandard: "RAS/IFRS",
      });
    }
  });
});
