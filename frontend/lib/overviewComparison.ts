// overviewComparison.ts — the Overview's key figures for the PRIOR period.
//
// Owner (2026-09-26): "the dashboard is not showing the comparison between
// years of the same company; it should pick it up automatically". The
// statement tabs already printed the engine's comparatives; the Overview's
// four key figures (revenue, EBITDA, cash, net debt) showed a change only for
// a book that carried its own history (`statements.historicalPeriods`), which
// an uploaded trial balance never does — so for every real company the
// Overview compared nothing.
//
// LIKE FOR LIKE, the rule the page already follows for the prior cash flow:
// each prior figure is the SAME builder as the tile's current figure
// (`computeDashboardHeadline`; net debt through the page's own reader, passed
// in as `netDebtOf` so this module does no balance-sheet arithmetic of its
// own — the import-boundary gate), run over the prior period's own served
// block from the comparatives document (`prior_statements`,
// `prior_line_items`, `prior_metrics`). A prior figure is never a different
// arithmetic wearing the same label, and nothing is invented: no document,
// no prior.

import type { MetricTrend } from "@/components/cfo/KeyMetricsRow";
import type { PeriodMetric } from "@/lib/activePeriod";
import type { ComparativesResponse } from "@/lib/comparatives";
import { canonicalMarginsFrom, computeDashboardHeadline } from "@/lib/dashboardHeadline";
import type { Statements } from "@/lib/financialReport";
import { plLevelsOf } from "@/lib/servedOneEbitda";

export type OverviewFigure = "revenue" | "ebitda" | "cash" | "netDebt";

export interface OverviewPrior {
  /** The prior period's label, as the comparison names it ("Dec 2024"). */
  label: string;
  figures: Record<OverviewFigure, number | null>;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The prior period's Overview figures, or null without a comparison.
 *  `netDebtOf` is the reader the Net debt tile itself uses. */
export function overviewPriorOf(
  doc: ComparativesResponse | null | undefined,
  entity: string,
  netDebtOf: (s: Statements) => number,
  /** The CURRENT period's `assembled_pl.ebitda_definition`. A prior EBITDA
   *  served under another definition is no comparison (the definition
   *  change would read as a move): its trend is withheld. Undefined =
   *  the caller does not know it, and the prior is taken as served. */
  currentEbitdaDefinition?: string | null,
): OverviewPrior | null {
  if (!doc) return null;
  const ps = doc.prior_statements as unknown as Statements | undefined;
  if (!ps || !ps.incomeStatement || !ps.balanceSheet) return null;
  const metrics: PeriodMetric[] = (doc.prior_metrics ?? []).map((m) => ({
    name: m.name,
    value: m.value,
    unit: null,
    direction: null,
  }));
  const headline = computeDashboardHeadline({
    statements: ps,
    lineItems: doc.prior_line_items ?? [],
    metrics,
    entity,
    canonicalMargins: canonicalMarginsFrom(metrics),
  });
  return {
    label: doc.prior.label || ps.periodLabel || "",
    figures: {
      revenue: finite(headline.netTurnover),
      ebitda:
        currentEbitdaDefinition !== undefined &&
        plLevelsOf(ps).definition !== currentEbitdaDefinition
          ? null
          : finite(headline.tileEbitdaRon),
      cash: finite(ps.balanceSheet.cash),
      netDebt: finite(netDebtOf(ps)),
    },
  };
}

/** The tile's move against the prior period, or null when there is none. */
export function trendAgainstPrior(
  prior: OverviewPrior | null,
  figure: OverviewFigure,
  current: number | null | undefined,
): MetricTrend | null {
  const base = prior?.figures[figure] ?? null;
  const now = finite(current);
  if (!prior || base === null || now === null) return null;
  return { base, current: now, prevLabel: prior.label };
}
