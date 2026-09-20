// THE DASHBOARD HEADLINE NET PROFIT — one resolver, one seam.
//
// The dashboard's Net profit KPI card, the `net_profit` tile in the
// All-metrics grid and the `net_profit` entry of `figureProvenanceMap`
// all render ONE number, computed once in `pages/cfo/FinancialStatements`.
// This module is where that number is decided, so it can be exercised as
// conduct instead of living inside a `useMemo` in a 6,000-line page.
//
// Sibling of `headlineProvenance`, which says where the figure CAME FROM;
// this says WHAT it is. The two must agree, and the provenance module's
// branches are kept in the same order as the branches below.

import type { PeriodMetric } from "@/lib/activePeriod";

/** The shape the page hands over: the engine's canonical P&L block, as
 *  `/api/period` serves it under `statements.assembled_pl`. */
export interface HeadlineStatementsLike {
  assembled_pl?: Record<string, number> | null;
}

/** The shape the page hands over from `pickPLBuilder`. */
export interface HeadlinePlLike {
  netProfit: number;
  netProfitStatutory?: number;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The net profit the dashboard prints.
 *
 * Order:
 *   1. `assembled_pl.net_income_statutory` — the engine's account-121
 *      anchor, re-resolved on every request.
 *   2. `calculated_metrics.net_income_statutory` — the persisted snapshot
 *      of the same concept.
 *   3. the P&L builder's own statutory figure, then its operational one —
 *      all a source with no envelope ever has.
 */
export function resolveHeadlineNetProfit(
  statements: HeadlineStatementsLike | null | undefined,
  metrics: readonly PeriodMetric[] | null | undefined,
  pl: HeadlinePlLike,
): number {
  const row = (metrics ?? []).find((m) => m.name === "net_income_statutory");
  const fromMetrics = finite(row?.value);
  if (fromMetrics !== null) return fromMetrics;
  const fromBuilder = finite(pl.netProfitStatutory);
  if (fromBuilder !== null) return fromBuilder;
  return pl.netProfit;
}
