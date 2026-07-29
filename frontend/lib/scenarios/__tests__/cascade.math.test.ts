// F6.0.5 — load-bearing cascade math proof. Calibrated EEI-like baseline.
import { describe, it, expect } from "vitest";
import { applyCascade } from "../cascade";
import { SCENARIO_LEVERS, leverToAdjustment } from "../levers";
import { computeMetric, DEFAULT_RO_COVENANTS, detectCovenantBreaches } from "../covenants";
import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";

// Calibrated baseline mirroring buildScenarioBaseline's opex/tax plugs.
const REV = 4_900_000, COGS = 500_000, DEP = 800_000, AMORT = 0;
const EBITDA_STAT = 2_100_000, NFR = -600_000, NI_STAT = 400_000;
const opexPlug = REV - COGS + DEP + AMORT - EBITDA_STAT;        // 3.1M
const ebitStat = EBITDA_STAT - DEP - AMORT;                     // 1.3M
const taxPlug = ebitStat + NFR - NI_STAT;                       // 0.3M

const baseline: ReportingMetrics = {
  revenue: REV, cogs: COGS, opex: opexPlug, depreciation: DEP, amortization: AMORT,
  netFinancialResult: NFR, incomeTax: taxPlug,
  ebitda: EBITDA_STAT, ebit: ebitStat, netProfit: NI_STAT,
  totalDebt: 14_100_000, cash: 1_500_000,
  receivables: 600_000, inventory: 200_000, accountsPayable: 400_000,
  currentAssets: 2_500_000, currentLiabilities: 900_000,
  shareholdersEquity: 10_000_000, totalAssets: 25_000_000, capex: 300_000,
};

const lever = (key: string, v: number) =>
  leverToAdjustment(SCENARIO_LEVERS.find((l) => l.key === key)!, v, key, "");

describe("cascade — zero adjustment reproduces baseline (continuity)", () => {
  const z = applyCascade(baseline, []);
  it("reproduces statutory EBITDA / EBIT / net profit", () => {
    expect(z.ebitda).toBeCloseTo(EBITDA_STAT, 2);
    expect(z.ebit).toBeCloseTo(ebitStat, 2);
    expect(z.netProfit).toBeCloseTo(NI_STAT, 2);
  });
  it("reproduces baseline balance-sheet fields exactly", () => {
    expect(z.cash).toBeCloseTo(1_500_000, 2);
    expect(z.shareholdersEquity).toBeCloseTo(10_000_000, 2);
    expect(z.currentLiabilities).toBeCloseTo(900_000, 2);
    expect(z.totalAssets).toBeCloseTo(25_000_000, 2);
  });
  it("net debt / EBITDA matches baseline", () => {
    expect(computeMetric(z, "net_debt_to_ebitda")!).toBeCloseTo((14_100_000 - 1_500_000) / 2_100_000, 4);
  });
});

describe("cascade — A = L + E invariant under adjustments", () => {
  for (const [name, adjs] of [
    ["revenue -20%", [lever("revenue", -20)]],
    ["opex -15% + dso 90", [lever("opex", -15), lever("dso", 90)]],
    ["capex +100%", [lever("capex", 100)]],
    ["growth", [lever("revenue", 25), lever("capex", 50), lever("opex", 15)]],
  ] as const) {
    it(name, () => {
      const s = applyCascade(baseline, adjs as never);
      expect(s.totalAssets!).toBeCloseTo(s.totalEquityAndLiab!, 1);
    });
  }
});

describe("cascade — rent/revenue drop worsens leverage + breaches covenant", () => {
  const covs = DEFAULT_RO_COVENANTS.map((c, i) => ({ ...c, id: `c${i}` }));
  const s = applyCascade(baseline, [lever("revenue", -20)]);
  it("EBITDA falls ~0.2×revenue", () => {
    expect(s.ebitda!).toBeCloseTo(EBITDA_STAT - 0.2 * REV, 1); // 2.1M - 0.98M = 1.12M
  });
  it("net debt / EBITDA rises above baseline", () => {
    const base = computeMetric(baseline, "net_debt_to_ebitda")!;
    const scen = computeMetric(s, "net_debt_to_ebitda")!;
    expect(scen).toBeGreaterThan(base);
  });
  it("senior leverage covenant (≤3.0×) breaches", () => {
    const breaches = detectCovenantBreaches(s, covs);
    const lev = breaches.find((b) => b.metric === "net_debt_to_ebitda");
    expect(lev?.severity).toBe("breach");
  });
});

describe("cascade — effective_tax_rate taxes the CASCADED EBIT (review #4)", () => {
  // revenue -20% cascades EBIT to 0.32M; tax at 16% must be 0.32M×0.16=51,200,
  // NOT baseline EBIT 1.3M×0.16=208,000. netProfit = pretax(-0.28M) − 51,200.
  const s = applyCascade(baseline, [lever("revenue", -20), lever("tax", 16)]);
  it("net profit reflects tax on the recomputed EBIT, not baseline EBIT", () => {
    expect(s.netProfit!).toBeCloseTo(-331_200, 0); // buggy value would be -488,000
  });
});

describe("cascade — wiped-out EBITDA reads as worst-case, not 'improved' (review #7)", () => {
  const covs = DEFAULT_RO_COVENANTS.map((c, i) => ({ ...c, id: `c${i}` }));
  const s = applyCascade(baseline, [lever("revenue", -50)]); // EBITDA goes negative
  it("EBITDA is negative under the shock", () => {
    expect(s.ebitda!).toBeLessThan(0);
  });
  it("net debt / EBITDA returns +Infinity (worst), not a negative ratio", () => {
    expect(computeMetric(s, "net_debt_to_ebitda")).toBe(Number.POSITIVE_INFINITY);
  });
  it("senior leverage covenant still BREACHES (not silently passing)", () => {
    const b = detectCovenantBreaches(s, covs).find((x) => x.metric === "net_debt_to_ebitda");
    expect(b?.severity).toBe("breach");
  });
});

describe("covenants — interest coverage ignores net financial INCOME (review #5)", () => {
  it("returns null (no net interest burden) when netFinancialResult ≥ 0", () => {
    const cashRich = { ...baseline, netFinancialResult: 3_000_000, ebitda: 10_000_000 };
    expect(computeMetric(cashRich, "ebitda_to_interest")).toBeNull();
  });
  it("computes coverage off the expense magnitude when netFin < 0", () => {
    const indebted = { ...baseline, netFinancialResult: -2_000_000, ebitda: 10_000_000 };
    expect(computeMetric(indebted, "ebitda_to_interest")!).toBeCloseTo(5, 4);
  });
});

describe("cascade — never NaN / never mutates baseline", () => {
  it("does not mutate the baseline object", () => {
    const snapshot = JSON.stringify(baseline);
    applyCascade(baseline, [lever("revenue", -30), lever("opex", -10)]);
    expect(JSON.stringify(baseline)).toBe(snapshot);
  });
  it("all displayed metrics finite under a severe shock", () => {
    const s = applyCascade(baseline, [lever("revenue", -100)]);
    for (const k of ["ebitda", "netProfit", "cash", "totalAssets", "currentAssets"] as const) {
      expect(Number.isFinite(s[k] as number)).toBe(true);
    }
  });
});
