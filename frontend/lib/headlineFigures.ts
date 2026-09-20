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
 * Order — the SAME order `financialReport`'s `anchored()` resolver has
 * used since 2026-09-07, so the card and the sentence under it ("… net
 * profit as filed") cannot name two numbers:
 *
 *   1. `assembled_pl.net_income_statutory` — the engine's account-121
 *      anchor. Re-resolved on EVERY request, which is why it outranks
 *      rung 2: `calculated_metrics` is a snapshot `stage_compute` wrote
 *      once, and a period analysed before the anchor shipped still
 *      carries the pre-anchor value there while its envelope is served
 *      anchored.
 *   2. `calculated_metrics.net_income_statutory` — that snapshot.
 *   3. the P&L builder's own figure. This is a class-6/7 RECONSTRUCTION
 *      wearing the word "statutory", and on the four firm books it is
 *      not the filed result:
 *
 *        book        account 121      builder      factor
 *        agras       7,533,676.02   14,106,102.03   1.87x
 *        carniprod   1,435,533.59    5,843,449.04   4.07x
 *        realestate   −801,604.14  −30,391,418.38  37.91x
 *        retail      3,205,212.62    1,161,957.98   0.36x
 *
 *      It is the right answer only for a source that has no envelope at
 *      all (the public-company adapter), never a preference over one.
 */
export function resolveHeadlineNetProfit(
  statements: HeadlineStatementsLike | null | undefined,
  metrics: readonly PeriodMetric[] | null | undefined,
  pl: HeadlinePlLike,
): number {
  const fromEnvelope = finite((statements?.assembled_pl ?? {})["net_income_statutory"]);
  if (fromEnvelope !== null) return fromEnvelope;
  const row = (metrics ?? []).find((m) => m.name === "net_income_statutory");
  const fromMetrics = finite(row?.value);
  if (fromMetrics !== null) return fromMetrics;
  const fromBuilder = finite(pl.netProfitStatutory);
  if (fromBuilder !== null) return fromBuilder;
  return pl.netProfit;
}
