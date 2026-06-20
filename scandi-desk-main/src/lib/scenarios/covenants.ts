// F6.0.5 Phase 1 foundation (2026-06-20) — Covenant detection engine.
//
// A scenario's value to a CFO is largely the covenant tracking: "if I do X,
// do my covenants still pass?" This module is the deterministic test layer.
//
// SCOPE: detection only. The UI (CovenantWarnings.tsx) consumes the
// CovenantBreach[] result to render red/amber/green badges. Storage of
// the user's covenant configuration is in src/stores/covenants.tsx
// (Phase 1b — for now the page can hardcode 2-3 common Romanian SME
// covenants until the UI Settings → Covenants tab ships).
//
// COMMON ROMANIAN SME COVENANTS (pre-populated suggestions in the future
// Settings UI):
//   · Net Debt / EBITDA ≤ 3.0×  — senior facility net leverage
//   · Interest Coverage (EBITDA / Interest) ≥ 4.0×  — debt service capacity
//   · Current Ratio (Current Assets / Current Liabilities) ≥ 1.2  — liquidity
//   · Debt Service Coverage Ratio ≥ 1.25×  — total cash-flow coverage
//     (not yet computed; needs CFO sign-off on the schedule)
//
// MATH DISCIPLINE:
//   · NEVER divide by zero. Every covenant check guards the denominator.
//   · Sign conventions follow the engine: positive EBITDA, positive cash,
//     positive equity. Negative values are real (loss-making periods)
//     and produce real breach signals.
//   · Operator semantics: `<` strictly less than (3.5 < 3.0 → false →
//     BREACH for a "must be < 3.0" covenant).

import type { CovenantBreach } from "./types";
import type { CascadeState } from "./cascade";

/** Metric keys the covenant engine knows how to compute. Adding new
 *  metrics = add the case in `computeMetric` below. */
export type CovenantMetricKey =
  | "net_debt_to_ebitda"
  | "ebitda_to_interest"
  | "current_ratio"
  | "quick_ratio"
  | "debt_to_equity";

/** User's covenant definition. Stored per workspace. */
export interface Covenant {
  id: string;
  /** Human-readable label. Surfaces in the breach card. */
  name: string;
  metric: CovenantMetricKey;
  operator: "<" | "<=" | ">" | ">=";
  threshold: number;
  /** Optional facility/lender tag for the audit trail. */
  facility?: string;
  /** Amber warning band as a fraction of threshold (e.g. 0.1 = warn
   *  when within 10% of threshold but not yet breached). When unset
   *  the engine uses 0.05 (5%) as the default warning buffer. */
  warningBuffer?: number;
}

/** Test a cascaded state against the user's covenant set. Returns a list
 *  of breaches + warnings; empty array means all covenants pass. */
export function detectCovenantBreaches(
  state: CascadeState,
  covenants: Covenant[],
): CovenantBreach[] {
  const out: CovenantBreach[] = [];
  for (const cov of covenants) {
    const actual = computeMetric(state, cov.metric);
    if (actual === null) {
      // Metric uncomputable (denominator zero). Treat as a warning so
      // the user knows the covenant couldn't be evaluated under this
      // scenario, rather than silently passing.
      out.push({
        covenantId: cov.id,
        metric: cov.metric,
        actual: NaN,
        threshold: cov.threshold,
        operator: cov.operator,
        severity: "warning",
        name: cov.name,
      });
      continue;
    }

    const buffer = cov.warningBuffer ?? 0.05;
    const evaluation = evaluateCovenant(actual, cov.operator, cov.threshold);
    const proximity = distanceToThreshold(
      actual,
      cov.operator,
      cov.threshold,
      buffer,
    );

    if (evaluation === "breach") {
      out.push({
        covenantId: cov.id,
        metric: cov.metric,
        actual,
        threshold: cov.threshold,
        operator: cov.operator,
        severity: "breach",
        name: cov.name,
      });
    } else if (proximity === "near") {
      out.push({
        covenantId: cov.id,
        metric: cov.metric,
        actual,
        threshold: cov.threshold,
        operator: cov.operator,
        severity: "warning",
        name: cov.name,
      });
    }
  }
  return out;
}

/** Compute a single covenant metric from cascaded state. Returns null
 *  when the denominator is zero (signaling uncomputable). */
export function computeMetric(
  state: CascadeState,
  metric: CovenantMetricKey,
): number | null {
  const num = (v: number | null | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  switch (metric) {
    case "net_debt_to_ebitda": {
      const debt = num(state.totalDebt);
      const cash = num(state.cash);
      const ebitda = num(state.ebitda);
      if (ebitda === 0) return null;
      return (debt - cash) / ebitda;
    }
    case "ebitda_to_interest": {
      // ReportingMetrics doesn't carry interestExpense; using
      // netFinancialResult magnitude as a proxy. Negative
      // netFinancialResult typically equals -interest paid; magnitude
      // is the right denominator. If both are zero, return null.
      const ebitda = num(state.ebitda);
      const netFin = num(state.netFinancialResult);
      const interestProxy = Math.abs(netFin);
      if (interestProxy === 0) return null;
      return ebitda / interestProxy;
    }
    case "current_ratio": {
      const ca = num(state.currentAssets);
      const cl = num(state.currentLiabilities);
      if (cl === 0) return null;
      return ca / cl;
    }
    case "quick_ratio": {
      const cash = num(state.cash);
      const ar = num(state.receivables);
      const cl = num(state.currentLiabilities);
      if (cl === 0) return null;
      return (cash + ar) / cl;
    }
    case "debt_to_equity": {
      const debt = num(state.totalDebt);
      const equity = num(state.shareholdersEquity);
      if (equity === 0) return null;
      return debt / equity;
    }
  }
}

function evaluateCovenant(
  actual: number,
  operator: Covenant["operator"],
  threshold: number,
): "pass" | "breach" {
  switch (operator) {
    case "<":
      return actual < threshold ? "pass" : "breach";
    case "<=":
      return actual <= threshold ? "pass" : "breach";
    case ">":
      return actual > threshold ? "pass" : "breach";
    case ">=":
      return actual >= threshold ? "pass" : "breach";
  }
}

function distanceToThreshold(
  actual: number,
  operator: Covenant["operator"],
  threshold: number,
  buffer: number,
): "far" | "near" {
  // Only meaningful for thresholds that aren't zero — otherwise "within
  // 5% of zero" is misleading.
  if (threshold === 0) return "far";
  const distance = Math.abs(actual - threshold) / Math.abs(threshold);
  if (distance > buffer) return "far";

  // Within the buffer band — check if we're on the "safe" side of
  // threshold. If yes, this is a warning (close to breaching but not
  // there yet). If we're past threshold, the evaluateCovenant call
  // already flagged it as "breach" so we don't double-count.
  const eval_ = evaluateCovenant(actual, operator, threshold);
  return eval_ === "pass" ? "near" : "far";
}

/** Sensible default covenants for a Romanian SME just getting started.
 *  Pre-populates the future Settings → Covenants tab with the
 *  ratios most commonly written into RO commercial facility
 *  agreements. Users can edit/delete. */
export const DEFAULT_RO_COVENANTS: Omit<Covenant, "id">[] = [
  {
    name: "Senior facility net leverage",
    metric: "net_debt_to_ebitda",
    operator: "<=",
    threshold: 3.0,
    facility: "Senior facility",
    warningBuffer: 0.1,
  },
  {
    name: "Interest coverage",
    metric: "ebitda_to_interest",
    operator: ">=",
    threshold: 4.0,
    warningBuffer: 0.15,
  },
  {
    name: "Liquidity floor",
    metric: "current_ratio",
    operator: ">=",
    threshold: 1.2,
    warningBuffer: 0.1,
  },
];
