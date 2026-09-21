// GATE (2026-09-21): the dashboard decides "net profit as filed" ONCE.
//
// The KPI card was moved onto `resolveHeadlineNetProfit`, and two siblings on
// the same page were left on the rung it demotes — a bare lookup in the
// persisted `calculated_metrics`. One page then printed the anchor in its card
// and the reconstruction in its Balance Sheet row and its CFO-AI summary: on
// agras 7,533,676.02 against 14,106,102.03.
//
// WHAT THIS CAN AND CANNOT SEE: the value half is behavioural (the seam's own
// order is exercised below). The "only one site decides" half is structural —
// it counts independent `net_income_statutory` lookups in the page module,
// because rendering that page needs a full router + query client. A structural
// check earns its place only if it reds on the real regression, so the plant
// for it is: restore the old `remotePeriod.metrics.find(...)` useMemo.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveHeadlineNetProfit } from "@/lib/headlineFigures";

const PAGE = resolve(__dirname, "../..", "pages/cfo/FinancialStatements.tsx");
const HEADLINE = resolve(__dirname, "..", "dashboardHeadline.ts");
const ANCHOR = 36_787_352.75;
const RECONSTRUCTION = 36_267_963.64;

describe("net profit as filed — the seam", () => {
  it("prefers the envelope's anchor over a stale persisted metric", () => {
    const v = resolveHeadlineNetProfit(
      { assembled_pl: { net_income_statutory: ANCHOR } } as never,
      [{ name: "net_income_statutory", value: 999_999.99 }] as never,
      { netProfit: RECONSTRUCTION, netProfitStatutory: RECONSTRUCTION },
    );
    expect(v).toBe(ANCHOR);
  });

  it("falls through envelope → metrics → builder, and never invents a figure", () => {
    expect(resolveHeadlineNetProfit(null, [{ name: "net_income_statutory", value: 42 }] as never,
      { netProfit: 1, netProfitStatutory: 2 })).toBe(42);
    expect(resolveHeadlineNetProfit(null, [] as never,
      { netProfit: 1, netProfitStatutory: 2 })).toBe(2);
    expect(resolveHeadlineNetProfit(null, [] as never,
      { netProfit: 1, netProfitStatutory: null })).toBe(1);
  });

  it("a reported zero is a figure, not an absence", () => {
    expect(resolveHeadlineNetProfit(
      { assembled_pl: { net_income_statutory: 0 } } as never, [] as never,
      { netProfit: 99, netProfitStatutory: 99 })).toBe(0);
  });

  it("the page reads net_income_statutory through the seam ONLY — no second lookup", () => {
    const src = readFileSync(PAGE, "utf8");
    const bareLookups = src.match(/\.find\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.name\s*===\s*"net_income_statutory"/g) ?? [];
    expect(bareLookups, `the page looks up net_income_statutory itself ${bareLookups.length} time(s); the seam owns that decision`).toEqual([]);
    expect(src).toMatch(/resolveHeadlineNetProfit\(/);
    // The CARD resolves through lib/dashboardHeadline (forecast-scenarios-live:
    // hoisted so the Forecast page's year 0 is the same computation), and that
    // module must itself resolve through the seam; canonicalNetIncomeStatutory
    // still calls the seam on the page. Two sites, one seam, as before.
    const direct = src.match(/resolveHeadlineNetProfit\(/g) ?? [];
    const viaHeadline = /computeDashboardHeadline\(\{/.test(src) ? 1 : 0;
    const headline = readFileSync(HEADLINE, "utf8");
    expect(headline, "lib/dashboardHeadline.ts no longer resolves net profit through the seam").toMatch(
      /resolveHeadlineNetProfit\(/,
    );
    expect(
      direct.length + viaHeadline,
      "the card and canonicalNetIncomeStatutory should both resolve through the seam",
    ).toBeGreaterThanOrEqual(2);
  });
});
