// F6.0.1b (2026-06-21) — Variance row builder.
//
// Produces the Actual / Budget / Last-Year rows + deltas for the variance
// report. ACTUAL values reconcile to the dashboard tiles (operating revenue,
// statutory EBITDA, statutory net profit are the canonical values, the same
// ones the dashboard + scenario baseline use); the remaining line items come
// from the period's ReportingMetrics snapshot. BUDGET + LAST-YEAR come from
// the uploaded (or demo) ComparisonDataset.

import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";
import type { DashboardCanonical } from "@/lib/comparison/dashboardCanon";
import { convertFromTo } from "@/lib/money";
import type { Currency, Rates } from "@/lib/rates";
import {
  delta,
  type Delta,
  type DeltaSentiment,
  sentimentFor,
} from "@/lib/learning/computeDeltas";
import {
  VARIANCE_LINES,
  type ComparisonDataset,
  type VarianceLineKey,
} from "./types";

const VALID_CURRENCIES: readonly string[] = ["RON", "EUR", "USD"];

/**
 * Convert a comparison dataset's budget + last-year amounts INTO the period's
 * currency so the variance deltas don't mix currencies (e.g. an uploaded
 * EUR'000 budget deck on a RON workspace). Safe no-op when currencies match,
 * the dataset has no currency, or either currency is unknown.
 */
export function normalizeDatasetCurrency(
  ds: ComparisonDataset,
  toCurrency: string,
  rates: Rates,
): { dataset: ComparisonDataset; convertedFrom: string | null } {
  const from = ds.currency;
  if (
    !from ||
    from === toCurrency ||
    !VALID_CURRENCIES.includes(from) ||
    !VALID_CURRENCIES.includes(toCurrency)
  ) {
    return { dataset: ds, convertedFrom: null };
  }
  const conv = (m: Partial<Record<VarianceLineKey, number>>) => {
    const out: Partial<Record<VarianceLineKey, number>> = {};
    for (const [k, v] of Object.entries(m) as [VarianceLineKey, number][]) {
      out[k] = convertFromTo(v, from as Currency, toCurrency as Currency, rates);
    }
    return out;
  };
  return {
    dataset: { ...ds, budget: conv(ds.budget), lastYear: conv(ds.lastYear), currency: toCurrency },
    convertedFrom: from,
  };
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Build the ACTUAL value for each variance line from the reconciled canonical
 * headline values + the metrics snapshot. Mirrors the dashboard so the
 * Actual column ties to the tiles to the RON.
 */
export function buildActualLines(
  metrics: ReportingMetrics,
  canon: DashboardCanonical,
): Record<VarianceLineKey, number | null> {
  const revenue = num(canon.operatingRevenue);
  const cogs = num(metrics.cogs);
  const ebitda = num(canon.ebitda);
  // THE ONE EBITDA (owner ruling 2026-09-26): gross profit is the served
  // figure (turnover − cost of sales ± the stock variation 711) — `revenue
  // − cogs` left 711 out of it. A refused EBITDA refuses it (null), never a
  // rebuilt figure.
  const grossProfit = canon.ebitda === null ? null : num(canon.grossProfit);
  // EBITDA → EBIT, AS SERVED (owner ruling R2, 2026-09-28). The engine's
  // chain is EBITDA − D&A − net provisions = the operating result, with D&A
  // WITHOUT the 6812 / 6814 charges and their net (less the 7812 / 7814
  // reversals) on its own line outside EBITDA. This function used to compute
  // EBIT here as EBITDA − `metrics.depreciation` — the income statement's
  // whole 68x, which still holds those charges — against an EBITDA that no
  // longer holds the reversals: on Scandia's baseline 32,898,302.52 against
  // a served operating result of 41,313,577.93 (review 2026-10-02). On a
  // period the engine assembled every figure of the chain is read, none
  // subtracted in the browser: D&A is `assembled_pl.depreciation`, net
  // provisions the served block's value, EBIT `assembled_pl.ebit` (null
  // when the engine refused it). Only a payload the engine did NOT assemble
  // (an in-statement historical year) keeps its own arithmetic — it has one
  // D&A bucket and no provisions split to disagree with.
  const dep = canon.served ? num(metrics.plDepreciation) : num(metrics.depreciation);
  const netProvisions = canon.served ? num(metrics.netProvisions) : null;
  const ebit = canon.served
    ? num(canon.ebit)
    : ebitda !== null && dep !== null ? ebitda - dep : null;
  return {
    operating_revenue: revenue,
    cogs,
    gross_profit: grossProfit,
    opex: num(metrics.opex),
    ebitda,
    depreciation: dep,
    net_provisions: netProvisions,
    ebit,
    net_financial_result: num(metrics.netFinancialResult),
    income_tax: num(metrics.incomeTax),
    net_profit: num(canon.netProfit),
  };
}

export interface VarianceRow {
  key: VarianceLineKey;
  label: string;
  emphasis: boolean;
  higherIsBetter: boolean;
  actual: number | null;
  budget: number | null;
  lastYear: number | null;
  /** Δ Actual − Budget (null when either side missing). */
  vsBudget: Delta | null;
  vsBudgetSentiment: DeltaSentiment | null;
  /** Δ Actual − Last Year. */
  vsLastYear: Delta | null;
  vsLastYearSentiment: DeltaSentiment | null;
}

/** One variance cell. `delta()` runs the one sign-flip classifier
 *  (lib/changeKind.ts, plan_contract_v2 section 7), so a line that crosses
 *  zero carries `change.kind` and no `pct` — the renderers state it in
 *  words, never as a percent. */
function rowDelta(
  actual: number | null,
  comparison: number | null,
  higherIsBetter: boolean,
): { d: Delta | null; sentiment: DeltaSentiment | null } {
  if (actual === null || comparison === null) return { d: null, sentiment: null };
  const d = delta(actual, comparison);
  return { d, sentiment: sentimentFor(d, { invert: !higherIsBetter }) };
}

/** Build the full variance row set for the table. The net-provisions row is
 *  printed only where a column carries it: a book posting none, on a period
 *  assembled before the ruling or against a budget that has no such line,
 *  gets no empty row between D&A and EBIT. */
export function buildVarianceRows(
  actual: Record<VarianceLineKey, number | null>,
  dataset: ComparisonDataset | null,
): VarianceRow[] {
  const carried = (v: number | null | undefined): boolean =>
    typeof v === "number" && Number.isFinite(v) && Math.abs(v) >= 0.005;
  return VARIANCE_LINES.filter((def) =>
    def.key !== "net_provisions" ||
    carried(actual.net_provisions) ||
    carried(dataset?.budget.net_provisions) ||
    carried(dataset?.lastYear.net_provisions),
  ).map((def) => {
    const a = actual[def.key] ?? null;
    const b = dataset ? num(dataset.budget[def.key]) : null;
    const ly = dataset ? num(dataset.lastYear[def.key]) : null;
    const vb = rowDelta(a, b, def.higherIsBetter);
    const vl = rowDelta(a, ly, def.higherIsBetter);
    return {
      key: def.key,
      label: def.label,
      emphasis: def.emphasis ?? false,
      higherIsBetter: def.higherIsBetter,
      actual: a,
      budget: b,
      lastYear: ly,
      vsBudget: vb.d,
      vsBudgetSentiment: vb.sentiment,
      vsLastYear: vl.d,
      vsLastYearSentiment: vl.sentiment,
    };
  });
}
