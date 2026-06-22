// Alert engine — types and client-side derivation.
//
// The backend ships an authoritative detector at POST /api/alerts that runs
// across the full uploaded dataset (including supplier/customer/channel data
// when present). For the seed workspace and as a fallback when no upload has
// been ingested yet, we derive a parallel set of alerts from the in-browser
// DailyRun via flatten() — same shape, same severity ladder, computed locally.
//
// When the upload flow lands, swap deriveAlertsFromRun() for the alerts array
// returned by /api/alerts (or the upload-excel response which already carries
// `alerts` and `alert_summary` blocks).

import type { DailyRun } from "@/data/dailyRun";
import { flatten, type CfoItem } from "@/lib/cfoDerive";

// ── Types (mirror src/engine/alerts.py:Alert) ─────────────────────────────

export type AlertType =
  | "margin"
  | "price"
  | "cost"
  | "working_capital"
  | "slow_moving"
  | "anchor_health"
  | "opportunity"
  | "customer_profitability"
  | "supplier"
  | "data_quality";

export type Severity = "low" | "medium" | "high" | "critical";

export type AlertStatus =
  | "new"
  | "acknowledged"
  | "assigned"
  | "in_progress"
  | "resolved"
  | "dismissed";

export type AlertActionType =
  | "price_increase"
  | "cost_optimization"
  | "supplier_renegotiation"
  | "reduce_stock"
  | "liquidate"
  | "protect_review"
  | "scale"
  | "data_fix"
  | "manual_review";

export type AlertTargetType =
  | "sku"
  | "category"
  | "customer"
  | "supplier"
  | "channel"
  | "dataset";

export interface ExpectedImpact {
  cash_impact_kron?: number;
  margin_impact_pct?: number;
  roic_impact_pct?: number;
}

export interface Alert {
  id: string;
  alert_type: AlertType;
  severity: Severity;
  status: AlertStatus;
  target_type: AlertTargetType;
  target_id: string;
  target_name: string;
  title: string;
  summary: string;
  explanation: string;
  metric_name: string;
  current_value: number | string;
  benchmark_value?: number | string;
  threshold_value?: number | string;
  delta_value?: number | string;
  recommended_action: string;
  action_type: AlertActionType;
  expected_impact?: ExpectedImpact;
  owner?: string;
  created_at: string;
  updated_at: string;
}

export interface AlertSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
  by_type: Partial<Record<AlertType, number>>;
}

// ── Visual metadata for each alert type ───────────────────────────────────

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  margin: "Margin",
  price: "Price",
  cost: "Cost",
  working_capital: "Working capital",
  slow_moving: "Slow-moving",
  anchor_health: "Anchor health",
  opportunity: "Opportunity",
  customer_profitability: "Customer",
  supplier: "Supplier",
  data_quality: "Data quality",
};

export const ALERT_TYPE_DESCRIPTION: Record<AlertType, string> = {
  margin: "Real margin below threshold or category benchmark.",
  price: "Margin compression — a price action would close the gap.",
  cost: "COGS / supplier-side pressure on gross margin.",
  working_capital: "Excess capital tied up in inventory.",
  slow_moving: "Stock with weak rotation — promotion or transfer candidate.",
  anchor_health: "Protected anchor whose margin is slipping.",
  opportunity: "High-margin / fast-rotation product to scale.",
  customer_profitability: "Customer or channel running below the portfolio average.",
  supplier: "Supplier whose product portfolio is dragging margin.",
  data_quality: "Dataset gaps — missing, abnormal, or duplicate values.",
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// Tailwind tokens already wired in tailwind.config.ts:
//   alert / alert-tint   — red   (critical)
//   caution / caution-tint — amber (high)
//   info / info-tint     — blue  (medium)
//   success / success-tint — green (low / opportunity)
export const SEVERITY_CHIP_CLASS: Record<Severity, string> = {
  critical: "bg-alert-tint text-alert border-alert/30",
  high:     "bg-caution-tint text-caution border-caution/30",
  medium:   "bg-info-tint text-info border-info/30",
  low:      "bg-success-tint text-success border-success/30",
};

// ── Backend client ────────────────────────────────────────────────────────

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

export interface FetchAlertsBody {
  rows: Array<{
    category: string;
    sku?: string;
    volume_tons: number;
    revenue_kron: number;
    gross_margin_pct: number;
    dio_days?: number;
    strategic_flag?: boolean;
  }>;
  period_months?: number;
  overrides?: unknown;
}

export interface AlertsResponse {
  alerts: Alert[];
  summary: AlertSummary;
}

export async function fetchAlerts(body: FetchAlertsBody): Promise<AlertsResponse> {
  const res = await fetch(`${API_URL}/api/alerts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ period_months: 10, ...body }),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch { /* keep default */ }
    throw new Error(detail);
  }
  return (await res.json()) as AlertsResponse;
}

// ── Client-side derivation for the seed workspace ─────────────────────────

const ANCHOR_HEALTH_FLOOR_PCT = 5.0;
const THIN_MARGIN_HIGH_PCT = 5.0;
const DIO_HIGH = 100;
const DIO_CRITICAL = 150;
const CAPITAL_TRAP_HIGH_KEUR = 200;     // kEUR
const CAPITAL_TRAP_CRITICAL_KEUR = 400; // kEUR
const OPPORTUNITY_REAL_MARGIN_PCT = 12.0;
const OPPORTUNITY_DIO_MAX = 80;

function nowIso(): string {
  return new Date().toISOString();
}

function idFor(...parts: string[]): string {
  // Lightweight stable id — enough for client-side keys; the server uses a
  // proper SHA-1 hash for the same purpose.
  return parts.join("|").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32);
}

function newAlert(a: Omit<Alert, "status" | "created_at" | "updated_at">): Alert {
  const now = nowIso();
  return { ...a, status: "new", created_at: now, updated_at: now };
}

/**
 * Derive a portfolio of alerts from the in-browser DailyRun.
 *
 * Mirrors src/engine/alerts.py — same alert types, same severity ladder.
 * Customer / supplier alerts are NOT derived here because the seed dataset
 * doesn't carry customer/supplier columns (only the upload path does).
 */
export function deriveAlertsFromRun(run: DailyRun): Alert[] {
  const items = flatten(run);
  if (items.length === 0) return [];

  const out: Alert[] = [];

  // Margin alerts
  for (const i of items) {
    if (i.bucket === "LIQUIDATE") continue; // handled by liquidate flow
    if (i.realMargin >= THIN_MARGIN_HIGH_PCT) continue;
    const severity: Severity =
      i.realMargin < 0 ? "critical" :
      i.realMargin < THIN_MARGIN_HIGH_PCT * 0.5 ? "high" :
      "medium";
    out.push(newAlert({
      id: idFor("margin", i.id),
      alert_type: "margin",
      severity,
      target_type: "category",
      target_id: i.id,
      target_name: i.id,
      title: `${i.id} real margin ${i.realMargin.toFixed(1)}%`,
      summary: `Real margin sits below the ${THIN_MARGIN_HIGH_PCT.toFixed(0)}% threshold — price or cost action needed.`,
      explanation: `After working-capital cost (${i.dioDays}d DIO), ${i.id} is delivering only ${i.realMargin.toFixed(1)}% real margin. Either raise price or reduce trapped capital.`,
      metric_name: "real_margin_pct",
      current_value: Number(i.realMargin.toFixed(1)),
      threshold_value: THIN_MARGIN_HIGH_PCT,
      delta_value: Number((i.realMargin - THIN_MARGIN_HIGH_PCT).toFixed(1)),
      recommended_action: `Run a price-and-cost review for ${i.id}.`,
      action_type: "manual_review",
      expected_impact: { margin_impact_pct: Math.max(0, THIN_MARGIN_HIGH_PCT - i.realMargin) },
    }));
  }

  // Working capital alerts
  for (const i of items) {
    const capKEur = Math.abs(i.capitalMRon) * 1000; // capitalMRon is in M; ×1000 = kEUR
    if (i.dioDays < DIO_HIGH && capKEur < CAPITAL_TRAP_HIGH_KEUR) continue;
    const severity: Severity =
      capKEur >= CAPITAL_TRAP_CRITICAL_KEUR || i.dioDays >= DIO_CRITICAL ? "critical" :
      i.dioDays >= DIO_HIGH || capKEur >= CAPITAL_TRAP_HIGH_KEUR ? "high" :
      "medium";
    out.push(newAlert({
      id: idFor("working_capital", i.id),
      alert_type: "working_capital",
      severity,
      target_type: "category",
      target_id: i.id,
      target_name: i.id,
      title: `${i.id} has ${capKEur.toFixed(0)}k trapped at ${i.dioDays}d DIO`,
      summary: `Working capital tied up in ${i.id} is high relative to its profit contribution.`,
      explanation: `At ${i.dioDays} days of inventory the category locks roughly ${capKEur.toFixed(0)}k of capital. Cutting DIO by 20 days would release a meaningful slug.`,
      metric_name: "capital_trapped_keur",
      current_value: Math.round(capKEur),
      threshold_value: CAPITAL_TRAP_HIGH_KEUR,
      delta_value: Math.round(capKEur - CAPITAL_TRAP_HIGH_KEUR),
      recommended_action: `Reduce reorder quantities for ${i.id} until DIO is below ${Math.max(60, DIO_HIGH - 20)} days.`,
      action_type: "reduce_stock",
      expected_impact: { cash_impact_kron: Math.round(capKEur * 0.25) },
    }));
  }

  // Slow-moving
  for (const i of items) {
    if (i.bucket === "LIQUIDATE") continue;
    if (i.dioDays < DIO_HIGH) continue;
    if (i.volumeT >= 10) continue;
    const severity: Severity = i.dioDays >= DIO_CRITICAL ? "critical" : "high";
    out.push(newAlert({
      id: idFor("slow_moving", i.id),
      alert_type: "slow_moving",
      severity,
      target_type: "category",
      target_id: i.id,
      target_name: i.id,
      title: `${i.id} is rotating slowly (${i.dioDays}d / ${i.volumeT.toFixed(1)}t)`,
      summary: `Inventory sits ${i.dioDays} days on ${i.volumeT.toFixed(1)}t of volume — promotion, transfer, or liquidation candidate.`,
      explanation: `Slow rotation compounds working-capital cost. Clearing inventory here frees cash that the engine can redeploy to scale-bucket products.`,
      metric_name: "dio_days",
      current_value: i.dioDays,
      threshold_value: DIO_HIGH,
      delta_value: i.dioDays - DIO_HIGH,
      recommended_action: `Run a promotion on ${i.id} or transfer stock to higher-velocity channels.`,
      action_type: "reduce_stock",
    }));
  }

  // Anchor health
  for (const i of items) {
    if (!i.isAnchor) continue;
    if (i.realMargin >= ANCHOR_HEALTH_FLOOR_PCT) continue;
    const severity: Severity = i.realMargin < 0 ? "critical" : "high";
    out.push(newAlert({
      id: idFor("anchor_health", i.id),
      alert_type: "anchor_health",
      severity,
      target_type: "category",
      target_id: i.id,
      target_name: i.id,
      title: `${i.id} is a protected anchor at ${i.realMargin.toFixed(1)}% real margin`,
      summary: `Volume keeps it protected, but margin is below the ${ANCHOR_HEALTH_FLOOR_PCT.toFixed(0)}% anchor-health floor.`,
      explanation: `Anchors are kept for traffic and revenue weight, but they still need to clear cost-of-capital. A targeted price or cost action protects the anchor without removing it.`,
      metric_name: "real_margin_pct",
      current_value: Number(i.realMargin.toFixed(1)),
      threshold_value: ANCHOR_HEALTH_FLOOR_PCT,
      delta_value: Number((i.realMargin - ANCHOR_HEALTH_FLOOR_PCT).toFixed(1)),
      recommended_action: `Open a margin-recovery initiative for ${i.id} — price ladder, pack-mix, or supplier renegotiation.`,
      action_type: "protect_review",
      expected_impact: { margin_impact_pct: ANCHOR_HEALTH_FLOOR_PCT - i.realMargin },
    }));
  }

  // Opportunity
  for (const i of items) {
    const isScale = i.bucket === "SCALE";
    const isHighFast = i.realMargin >= OPPORTUNITY_REAL_MARGIN_PCT && i.dioDays <= OPPORTUNITY_DIO_MAX;
    if (!(isScale || isHighFast)) continue;
    out.push(newAlert({
      id: idFor("opportunity", i.id),
      alert_type: "opportunity",
      severity: "medium",
      target_type: "category",
      target_id: i.id,
      target_name: i.id,
      title: `${i.id} is over-performing — scale candidate`,
      summary: `${i.realMargin.toFixed(1)}% real margin at ${i.dioDays}d DIO. Increase allocation and confirm supply.`,
      explanation: `Scale candidates clear cost-of-capital with headroom and rotate fast — products that respond well to additional shelf space, advertising, or purchase volume.`,
      metric_name: "real_margin_pct",
      current_value: Number(i.realMargin.toFixed(1)),
      threshold_value: OPPORTUNITY_REAL_MARGIN_PCT,
      delta_value: Number((i.realMargin - OPPORTUNITY_REAL_MARGIN_PCT).toFixed(1)),
      recommended_action: `Increase ${i.id} purchase allocation by 10-20% next cycle.`,
      action_type: "scale",
      expected_impact: { cash_impact_kron: Math.round(i.absoluteProfit * 0.15) },
    }));
  }

  // Sort by severity, then alert type, then target id — matches backend.
  out.sort((a, b) => {
    const ds = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (ds !== 0) return ds;
    const dt = a.alert_type.localeCompare(b.alert_type);
    if (dt !== 0) return dt;
    return a.target_id.localeCompare(b.target_id);
  });
  return out;
}

export function summarizeAlerts(alerts: Alert[]): AlertSummary {
  const summary: AlertSummary = {
    critical: 0, high: 0, medium: 0, low: 0,
    total: alerts.length,
    by_type: {},
  };
  for (const a of alerts) {
    summary[a.severity] += 1;
    summary.by_type[a.alert_type] = (summary.by_type[a.alert_type] ?? 0) + 1;
  }
  return summary;
}

// Adapter so callers can pass items they already have, instead of the run.
export { type CfoItem };
