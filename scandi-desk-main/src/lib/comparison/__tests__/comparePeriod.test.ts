import { describe, it, expect } from "vitest";
import { buildDemoStatements } from "@/lib/demo/demoFinancials";
import type { Statements } from "@/lib/financialReport";
import {
  actualLinesFor,
  historicalCandidates,
  convertLines,
  type LineMap,
} from "../comparePeriod";
import { buildVarianceRows } from "../buildVariance";
import type { ComparisonDataset, VarianceLineKey } from "../types";
import type { Rates } from "@/lib/rates";

const RATES: Rates = { EUR: 1, RON: 5, USD: 1.1 };

function numericLastYear(lines: LineMap): Partial<Record<VarianceLineKey, number>> {
  const out: Partial<Record<VarianceLineKey, number>> = {};
  for (const [k, v] of Object.entries(lines) as [VarianceLineKey, number | null][]) {
    if (v !== null && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Build a standalone Statements for one of the demo's prior years — exactly
 *  the shape a separately-uploaded period would arrive as from /api/period. */
function priorYearAsPeriod(label: string): Statements {
  const demo = buildDemoStatements();
  const p = (demo.historicalPeriods ?? []).find((x) => x.periodLabel === label)!;
  return {
    companyName: demo.companyName,
    industry: demo.industry,
    currency: demo.currency,
    periodLabel: p.periodLabel,
    balanceSheet: p.balanceSheet,
    incomeStatement: p.incomeStatement,
    supplementary: {},
  };
}

describe("comparePeriod — actualLinesFor + candidates", () => {
  it("computes non-null P&L lines for a period's statements", () => {
    const lines = actualLinesFor(buildDemoStatements());
    expect(lines.operating_revenue).toBeGreaterThan(40_000_000);
    expect(lines.ebitda).not.toBeNull();
    expect(lines.net_profit).not.toBeNull();
    // Revenue line ties to the period's headline revenue.
    expect(lines.operating_revenue).toBe(buildDemoStatements().incomeStatement.revenue);
  });

  it("historicalCandidates returns prior years newest-first, each with lines", () => {
    const cands = historicalCandidates(buildDemoStatements());
    expect(cands).toHaveLength(4);
    expect(cands.map((c) => c.label)).toEqual(["FY2024", "FY2023", "FY2022", "FY2021"]);
    cands.forEach((c) => {
      expect(c.kind).toBe("historical");
      expect(c.currency).toBe("EUR");
      expect(c.lines?.operating_revenue).toBeGreaterThan(0);
    });
  });

  it("returns [] when the period has no historical years", () => {
    const flat: Statements = { ...buildDemoStatements(), historicalPeriods: [] };
    expect(historicalCandidates(flat)).toEqual([]);
  });
});

describe("comparePeriod — convertLines", () => {
  const lines = actualLinesFor(buildDemoStatements());

  it("same currency is an identity no-op", () => {
    expect(convertLines(lines, "EUR", "EUR", RATES)).toBe(lines);
  });
  it("converts EUR→RON by the rate ratio and preserves nulls", () => {
    const ron = convertLines(lines, "EUR", "RON", RATES);
    expect(ron.operating_revenue).toBeCloseTo((lines.operating_revenue as number) * 5, 3);
    // a line that's null stays null
    const withNull: LineMap = { ...lines, income_tax: null };
    expect(convertLines(withNull, "EUR", "RON", RATES).income_tax).toBeNull();
  });
  it("unknown currency is a no-op (never NaN)", () => {
    expect(convertLines(lines, "GBP", "EUR", RATES)).toBe(lines);
  });
});

// ── The real-client proof ────────────────────────────────────────────────
// "Upload last year as its own period and diff it" runs the SAME computation
// the demo path runs. We prove: a separately-sourced prior period, run through
// actualLinesFor (what the picker's backend branch does), yields identical
// numbers to the in-statement historical year, and merging it as `lastYear`
// produces correct Δ-vs-LY deltas.
describe("comparePeriod — backend-period diff equivalence", () => {
  it("a fetched prior period yields the SAME lines as the in-statement year", () => {
    const fromPeriod = actualLinesFor(priorYearAsPeriod("FY2024")); // backend path
    const fromHistorical = historicalCandidates(buildDemoStatements()).find(
      (c) => c.label === "FY2024",
    )!.lines!; // demo path
    expect(fromPeriod).toEqual(fromHistorical);
  });

  it("merging a prior period as Last-year produces correct YoY deltas", () => {
    const head = actualLinesFor(buildDemoStatements()); // FY2025 actuals
    const ly = actualLinesFor(priorYearAsPeriod("FY2024")); // last year, from a period
    const dataset: ComparisonDataset = {
      budget: {},
      lastYear: numericLastYear(ly),
      source: "upload",
    };
    const rows = buildVarianceRows(head, dataset);
    const rev = rows.find((r) => r.key === "operating_revenue")!;

    expect(rev.actual).toBe(head.operating_revenue);
    expect(rev.lastYear).toBe(ly.operating_revenue);
    expect(rev.vsLastYear).not.toBeNull();
    expect(rev.vsLastYear!.absolute).toBeCloseTo(
      (head.operating_revenue as number) - (ly.operating_revenue as number),
      3,
    );
    // FY2025 (recovery) revenue beats FY2024 (the down year).
    expect(rev.actual as number).toBeGreaterThan(rev.lastYear as number);
    expect(rev.vsLastYearSentiment).toBe("positive");
  });

  it("a EUR prior period converts cleanly onto a RON workspace", () => {
    const lyEur = actualLinesFor(priorYearAsPeriod("FY2024"));
    const lyRon = convertLines(lyEur, "EUR", "RON", RATES);
    expect(lyRon.operating_revenue).toBeCloseTo((lyEur.operating_revenue as number) * 5, 2);
    // The converted map is what gets merged → no currency mixing in the table.
    const ds: ComparisonDataset = { budget: {}, lastYear: numericLastYear(lyRon), source: "upload" };
    const rows = buildVarianceRows(convertLines(actualLinesFor(buildDemoStatements()), "EUR", "RON", RATES), ds);
    const rev = rows.find((r) => r.key === "operating_revenue")!;
    expect(rev.lastYear).toBeCloseTo((lyEur.operating_revenue as number) * 5, 2);
    expect(rev.vsLastYear).not.toBeNull();
  });
});
