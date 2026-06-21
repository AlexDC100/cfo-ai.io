// F6.1b (2026-06-21) — "Last year from a period" helpers.
//
// Turns ANY period (a separately-uploaded prior-year period, or one of the
// active period's in-statement historical years) into the per-P&L-line values
// used for the variance report's "Last year" column — computed through the
// SAME canonical pipeline as the live Actual column, so the comparison is
// apples-to-apples (operating revenue / statutory EBITDA / statutory net
// profit reconcile to the dashboard tiles).

import type { Statements, PriorPeriod } from "@/lib/financialReport";
import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { buildDashboardCanonical } from "@/lib/scenarios/dashboardCanon";
import { buildActualLines } from "./buildVariance";
import { convertFromTo } from "@/lib/money";
import type { Currency, Rates } from "@/lib/rates";
import type { VarianceLineKey } from "./types";

export type LineMap = Record<VarianceLineKey, number | null>;

const VALID = ["RON", "EUR", "USD"] as const;

/** Per-line ACTUAL values for an arbitrary period — same builder the live
 *  variance page uses for the current period, so a prior period diffs cleanly. */
export function actualLinesFor(
  statements: Statements,
  lineItems: PeriodLineItem[] = [],
  metricRows: PeriodMetric[] = [],
): LineMap {
  const snap = buildReportingMetricsSnapshot(statements);
  const canon = buildDashboardCanonical(statements, lineItems, metricRows);
  return buildActualLines(snap, canon);
}

/** Lift a PriorPeriod into a minimal Statements (mirrors multiPeriodSeries). */
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

export interface LastYearCandidate {
  /** "hist:<label>" for an in-statement year, or the backend period uuid. */
  id: string;
  label: string;
  sublabel: string;
  kind: "historical" | "period";
  /** Native currency of the source (for conversion to the active currency). */
  currency: string;
  /** Pre-computed line values — present for historical (client-side); a
   *  backend period is fetched + computed lazily by the picker. */
  lines?: LineMap;
}

/** In-statement historical years of the active period — newest first. No
 *  network: the prior years already travel inside the period's Statements
 *  (e.g. the multi-year demo, or any future multi-year upload). */
export function historicalCandidates(statements: Statements | null): LastYearCandidate[] {
  const hist = statements?.historicalPeriods;
  if (!statements || !hist?.length) return [];
  const ccy = statements.currency ?? "RON";
  return hist
    .map((p) => ({
      id: `hist:${p.periodLabel}`,
      label: p.periodLabel,
      sublabel: "from this analysis",
      kind: "historical" as const,
      currency: ccy,
      lines: actualLinesFor(priorToStatements(p, statements)),
    }))
    .reverse(); // historicalPeriods is oldest→newest; show last year first
}

/** Convert a line map between currencies (no-op when equal/unknown). */
export function convertLines(
  lines: LineMap,
  from: string,
  to: string,
  rates: Rates,
): LineMap {
  if (!from || !to || from === to) return lines;
  if (!VALID.includes(from as Currency) || !VALID.includes(to as Currency)) return lines;
  const out = {} as LineMap;
  for (const [k, v] of Object.entries(lines) as [VarianceLineKey, number | null][]) {
    out[k] = v === null ? null : convertFromTo(v, from as Currency, to as Currency, rates);
  }
  return out;
}
