// F6.1 (2026-06-21) — Multi-year series builder.
//
// Turns a single `Statements` (with its `historicalPeriods` array) into an
// ordered per-year series of ReportingMetrics — the data the Trend-view
// sparklines + multi-year popover read. No multi-dataset fetching needed:
// the prior years already travel inside one period's Statements.

import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { resolveConceptValue } from "@/lib/dashboard/resolveConceptValue";
import type { Statements, PriorPeriod } from "@/lib/financialReport";
import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";

export interface YearPoint {
  periodLabel: string;
  metrics: ReportingMetrics;
}

export interface MultiYearSeries {
  /** Oldest → newest, INCLUDING the current/head period. */
  points: YearPoint[];
  /** How many periods of history exist (drives Trend-toggle enablement). */
  available: number;
}

/** Lift a PriorPeriod into a minimal Statements so the same snapshot builder
 *  + deriveTotals run on it exactly like the head period. */
function priorToStatements(p: PriorPeriod, base: Statements): Statements {
  return {
    companyName: base.companyName,
    industry: base.industry,
    currency: base.currency,
    periodLabel: p.periodLabel,
    balanceSheet: p.balanceSheet,
    incomeStatement: p.incomeStatement,
    supplementary: {},
  };
}

export function buildMultiYearSeries(statements: Statements | null): MultiYearSeries {
  if (!statements) return { points: [], available: 0 };
  const hist = statements.historicalPeriods ?? [];
  const points: YearPoint[] = hist.map((p) => ({
    periodLabel: p.periodLabel,
    metrics: buildReportingMetricsSnapshot(priorToStatements(p, statements)),
  }));
  points.push({
    periodLabel: statements.periodLabel,
    metrics: buildReportingMetricsSnapshot(statements),
  });
  return { points, available: points.length };
}

export interface SeriesDatum {
  label: string;
  value: number;
}

/** Series of a concept (handles direct fields AND derived ratios like
 *  ebitda_margin / net_debt_ebitda via the shared resolver). Drops periods
 *  where the concept can't be computed. */
export function seriesForConcept(
  series: MultiYearSeries,
  conceptKey: string,
): SeriesDatum[] {
  return series.points
    .map((p) => ({ label: p.periodLabel, value: resolveConceptValue(conceptKey, p.metrics).value }))
    .filter((d): d is SeriesDatum => typeof d.value === "number" && Number.isFinite(d.value));
}

/** CAGR = (end/start)^(1/years) − 1. Null when uncomputable (non-positive
 *  endpoints or zero years) — callers render a dash, never a NaN. */
export function computeCAGR(start: number, end: number, years: number): number | null {
  if (years <= 0 || start <= 0 || end <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}
