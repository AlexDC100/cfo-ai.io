// Dedup pass over period-keyed alerts + recommendations.
//
// Root cause of the duplicates: the engine re-runs (Re-run button, fresh
// uploads, retry-after-error) write fresh alert / recommendation rows
// each time WITHOUT a "delete prior" or "upsert on composite key" pass.
// Result: the Notes & Recommendations panel grows linearly with re-runs.
// Live snapshot 2026-05-19 showed ~80 rows on a single period that
// collapsed to ~15 unique entries (4-6× duplication).
//
// THIS FILE IS THE FE-SIDE WORKAROUND (Phase D-quick). The proper fix
// lives in the backend insert path (Phase D-backend) which will dedupe
// on a composite (period_id, alert_key) / (period_id, recommendation_key)
// before writing — this FE pass exists so users see relief immediately
// and so the FE never regresses when re-runs happen between deploys.
//
// The dedup is order-stable: the FIRST occurrence of a key wins (its
// id/severity/body are kept), subsequent occurrences are folded into
// `duplicateCount` + `sourceIds`. This means a row appears in its
// originally-emitted position; nothing visibly reorders.

import type { PeriodAlertItem, PeriodRecommendation } from "@/lib/activePeriod";

export interface DedupedAlert {
  alert: PeriodAlertItem;
  /** How many times this alert appeared in the source list. ≥ 1 always.
   *  When > 1, the renderer surfaces a "× N" pill next to the title. */
  duplicateCount: number;
  /** Every source row id that collapsed into this entry, in emission
   *  order. The first one is `alert.id`. Useful for the future
   *  Phase D-backend cleanup pass to know which rows to delete. */
  sourceIds: string[];
}

export interface DedupedRecommendation {
  rec: PeriodRecommendation;
  duplicateCount: number;
  sourceIds: string[];
}

/** Build the composite dedup key for an alert.
 *
 *  Preference order:
 *    1. `alert_key` — the engine's intended natural key, stable across re-runs.
 *    2. `rule_key`  — the rule producing this alert; coarser but reliable.
 *    3. fallback hash of `${title}|${severity}|${body?.slice(0,120)}` — used
 *       when both upstream keys are absent (older rows, manual seeds).
 *
 *  We intentionally do NOT include `id` (would defeat the dedup) or
 *  `industry` (an alert is the same alert across industry classifications).
 */
function alertKey(a: PeriodAlertItem): string {
  if (a.alert_key && a.alert_key.trim() !== "") return `ak:${a.alert_key}`;
  if (a.rule_key && a.rule_key.trim() !== "") return `rk:${a.rule_key}`;
  const titleNorm = (a.title || "").trim().toLowerCase();
  const bodyNorm = (a.body || "").trim().toLowerCase().slice(0, 120);
  return `tk:${a.severity}|${titleNorm}|${bodyNorm}`;
}

/** Recommendations don't carry a structural key today — dedup on
 *  normalized title. Title is the user-facing label and is consistent
 *  for the same rule firing across re-runs ("Tighten receivables
 *  collection cycle", "Translate strong credit profile into cheaper
 *  debt", etc.). */
function recommendationKey(r: PeriodRecommendation): string {
  return `t:${(r.title || "").trim().toLowerCase()}`;
}

export function dedupeAlerts(alerts: PeriodAlertItem[]): DedupedAlert[] {
  const order: string[] = [];
  const byKey = new Map<string, DedupedAlert>();
  for (const a of alerts) {
    const key = alertKey(a);
    const existing = byKey.get(key);
    if (existing) {
      existing.duplicateCount += 1;
      existing.sourceIds.push(a.id);
    } else {
      byKey.set(key, { alert: a, duplicateCount: 1, sourceIds: [a.id] });
      order.push(key);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

export function dedupeRecommendations(
  recs: PeriodRecommendation[],
): DedupedRecommendation[] {
  const order: string[] = [];
  const byKey = new Map<string, DedupedRecommendation>();
  for (const r of recs) {
    const key = recommendationKey(r);
    const existing = byKey.get(key);
    if (existing) {
      existing.duplicateCount += 1;
      existing.sourceIds.push(r.id);
    } else {
      byKey.set(key, { rec: r, duplicateCount: 1, sourceIds: [r.id] });
      order.push(key);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** Convenience: returns counts to surface in test/debug logs.
 *  Pure function, no side effects. */
export function dedupeStats(args: {
  alerts: PeriodAlertItem[];
  recommendations: PeriodRecommendation[];
}): {
  alertsIn: number;
  alertsOut: number;
  alertsDuplicatesFolded: number;
  recsIn: number;
  recsOut: number;
  recsDuplicatesFolded: number;
} {
  const dA = dedupeAlerts(args.alerts);
  const dR = dedupeRecommendations(args.recommendations);
  return {
    alertsIn: args.alerts.length,
    alertsOut: dA.length,
    alertsDuplicatesFolded: args.alerts.length - dA.length,
    recsIn: args.recommendations.length,
    recsOut: dR.length,
    recsDuplicatesFolded: args.recommendations.length - dR.length,
  };
}
