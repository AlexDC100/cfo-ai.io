import { describe, it, expect } from "vitest";
import { parseNumber } from "../parseBudget";
import { buildVarianceRows } from "../buildVariance";
import { buildDemoComparison } from "../demoSeed";
import type { VarianceLineKey } from "../types";

describe("parseNumber — tolerant EU/US/parenthesis formats", () => {
  it("plain", () => expect(parseNumber("1234")).toBe(1234));
  it("US thousands+decimal", () => expect(parseNumber("1,234.56")).toBeCloseTo(1234.56));
  it("EU thousands+decimal", () => expect(parseNumber("1.234,56")).toBeCloseTo(1234.56));
  it("EU thousands only", () => expect(parseNumber("4.913")).toBe(4913));
  it("comma decimal", () => expect(parseNumber("12,5")).toBeCloseTo(12.5));
  it("parenthesis negative", () => expect(parseNumber("(1,200)")).toBe(-1200));
  it("currency + spaces", () => expect(parseNumber(" 2 100 EUR ")).toBe(2100));
  it("blank → null", () => expect(parseNumber("")).toBeNull());
  it("garbage → null", () => expect(parseNumber("n/a")).toBeNull());
});

const actual: Record<VarianceLineKey, number | null> = {
  operating_revenue: 4_900_000,
  cogs: 500_000,
  gross_profit: 4_400_000,
  opex: 2_300_000,
  ebitda: 2_100_000,
  depreciation: 800_000,
  ebit: 1_300_000,
  net_financial_result: -600_000,
  income_tax: 300_000,
  net_profit: 400_000,
};

describe("buildVarianceRows — deltas + favorable sentiment", () => {
  const ds = {
    budget: { operating_revenue: 5_000_000, ebitda: 2_400_000, cogs: 480_000 } as Record<VarianceLineKey, number>,
    lastYear: { operating_revenue: 4_700_000, ebitda: 1_900_000 } as Record<VarianceLineKey, number>,
    source: "upload" as const,
  };
  const rows = buildVarianceRows(actual, ds);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  it("revenue below budget → unfavorable (negative)", () => {
    const r = byKey.get("operating_revenue")!;
    expect(r.vsBudget!.absolute).toBe(-100_000);
    expect(r.vsBudgetSentiment).toBe("negative");
  });
  it("revenue above last year → favorable (positive)", () => {
    const r = byKey.get("operating_revenue")!;
    expect(r.vsLastYear!.absolute).toBe(200_000);
    expect(r.vsLastYearSentiment).toBe("positive");
  });
  it("COGS below budget → favorable (cost lower is good)", () => {
    const r = byKey.get("cogs")!;
    expect(r.vsBudget!.absolute).toBe(20_000); // actual 500k > budget 480k → cost higher → BAD
    expect(r.vsBudgetSentiment).toBe("negative");
  });
  it("missing comparison value → null delta (em-dash)", () => {
    const r = byKey.get("net_profit")!;
    expect(r.vsBudget).toBeNull();
    expect(r.vsLastYear).toBeNull();
  });
  it("ratio/percentage discipline: pct present for currency lines", () => {
    const r = byKey.get("ebitda")!;
    expect(r.vsBudget!.pct).toBeCloseTo((2_100_000 - 2_400_000) / 2_400_000, 6);
  });
});

describe("demo seed — internally consistent + non-trivial variances", () => {
  const ds = buildDemoComparison(actual);
  it("budget revenue > actual (behind plan)", () => {
    expect(ds.budget.operating_revenue!).toBeGreaterThan(actual.operating_revenue!);
  });
  it("last-year revenue < actual (YoY growth)", () => {
    expect(ds.lastYear.operating_revenue!).toBeLessThan(actual.operating_revenue!);
  });
  it("demo waterfall ties: budget gross = budget rev − budget cogs", () => {
    expect(ds.budget.gross_profit!).toBeCloseTo(ds.budget.operating_revenue! - ds.budget.cogs!, 2);
  });
  it("source is labeled demo", () => expect(ds.source).toBe("demo"));
});
