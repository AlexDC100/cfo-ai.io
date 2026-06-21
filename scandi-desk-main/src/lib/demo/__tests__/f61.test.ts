import { describe, it, expect } from "vitest";
import { buildDemoStatements } from "../demoFinancials";
import { DEMO_COMPANY } from "../demoCompany";
import {
  buildMultiYearSeries,
  seriesForConcept,
  computeCAGR,
} from "@/lib/learning/multiPeriodSeries";
import { deriveTotals } from "@/lib/financialReport";

// ─── Gate 1 — multi-year math ────────────────────────────────────────────
describe("F6.1 Gate 1 — CAGR + multi-year series", () => {
  it("CAGR computed correctly across 4 periods", () => {
    expect(computeCAGR(45_200_000, 50_800_000, 4)).toBeCloseTo(0.0296, 4);
  });
  it("CAGR guards: non-positive endpoints / zero years → null", () => {
    expect(computeCAGR(0, 100, 4)).toBeNull();
    expect(computeCAGR(100, -5, 4)).toBeNull();
    expect(computeCAGR(100, 200, 0)).toBeNull();
  });

  const series = buildMultiYearSeries(buildDemoStatements());

  it("series has all 5 demo years, oldest → newest", () => {
    expect(series.available).toBe(5);
    expect(series.points.map((p) => p.periodLabel)).toEqual([
      "FY2021", "FY2022", "FY2023", "FY2024", "FY2025",
    ]);
  });
  it("revenue series resolves for every year", () => {
    const rev = seriesForConcept(series, "operating_revenue");
    expect(rev).toHaveLength(5);
    expect(rev[0].value).toBeGreaterThan(40_000_000); // FY2021 ~45.2M
  });
  it("a derived ratio (EBITDA margin) resolves across the series too", () => {
    const m = seriesForConcept(series, "ebitda_margin");
    expect(m).toHaveLength(5);
    m.forEach((d) => expect(d.value).toBeGreaterThan(0.05)); // healthy margins
  });
});

// ─── Gate 2 — demo data integrity ────────────────────────────────────────
describe("F6.1 Gate 2 — demo data integrity", () => {
  const demo = buildDemoStatements();
  const t = deriveTotals(demo);

  it("balance sheet balances exactly (A = L + E)", () => {
    expect(t.totalAssets).toBe(t.totalLiabilitiesAndEquity);
  });
  it("FY2025 head revenue matches the growth profile (~56.2M)", () => {
    expect(demo.incomeStatement.revenue).toBeGreaterThan(56_000_000);
    expect(demo.incomeStatement.revenue).toBeLessThan(56_500_000);
  });
  it("includes at least one DOWN year (realism anchor)", () => {
    const revenues = [
      ...(demo.historicalPeriods ?? []).map((p) => p.incomeStatement.revenue),
      demo.incomeStatement.revenue,
    ];
    const hasDownYear = revenues.some((r, i) => i > 0 && r < revenues[i - 1]);
    expect(hasDownYear).toBe(true);
  });
  it("currency is EUR and company is the fictional Meridian", () => {
    expect(demo.currency).toBe("EUR");
    expect(demo.companyName).toBe("Meridian Industries SRL");
    expect(DEMO_COMPANY.industryId).toBe("food_manufacturing");
  });
});

// ─── Gate 5 (automated slice) — discretion: ZERO real identifiers ─────────
describe("F6.1 discretion — no real company identifiers anywhere", () => {
  const blob = JSON.stringify(buildDemoStatements()).toLowerCase();
  const FORBIDDEN = [
    "scandia", "carniprod", "agras", "eei", "imobiliara", "sadu", "bucegi",
    "navodul", "roua", "annabella", "vitalique", "transavia", "picard",
    "yummy", "sibiu", "bitolia", "mateusz", "profi", "kaufland", "metro",
    "carrefour",
  ];
  it.each(FORBIDDEN)("contains no '%s'", (term) => {
    expect(blob).not.toContain(term);
  });
});
