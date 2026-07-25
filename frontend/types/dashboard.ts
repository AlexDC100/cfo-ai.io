// F6.0.4 (2026-06-20) — Configurable dashboard types.
//
// The dashboard's fixed 4-tile KPI strip becomes a user-configurable grid
// of metric cards. Each card binds to an F5.0 concept key and renders its
// live value from the active period's ReportingMetrics. Cards can be
// added (from the concept picker), removed, resized, and reordered.
//
// Persistence: localStorage-primary with backend sync as progressive
// enhancement (see src/lib/dashboard/configApi.ts for the rationale —
// the backend table ships as a ready artifact but is gated behind the
// pending Bug #4 PostgREST cache fix + the operator-only migration step).

export type CardSize = "sm" | "md" | "lg";

export interface DashboardCard {
  /** Unique per card INSTANCE (a user may add the same concept twice,
   *  unusual but allowed). Generated via crypto.randomUUID with fallback. */
  id: string;
  /** Links to an F5.0 concept in CONCEPTS_BY_KEY. */
  conceptKey: string;
  /** Grid footprint: sm = 1 col, md = 2 cols, lg = 2 cols × 2 rows. */
  size: CardSize;
  /** Sort order within the grid (0-based). */
  order: number;
  /** Optional per-card title override (defaults to the concept's name). */
  customTitle?: string;
  /** Suppress the period-comparison delta badge on this specific card. */
  hideComparison?: boolean;
}

export interface DashboardConfig {
  cards: DashboardCard[];
  updatedAt: string;
}

/** Hard cap on cards per user — prevents a runaway grid + keeps the
 *  persisted payload small. Spec anti-pattern: "DO NOT allow infinite
 *  cards. Cap at 20 per user." */
export const MAX_DASHBOARD_CARDS = 20;

/** Default dashboard — a STRICT SUPERSET of the legacy fixed 4-tile strip
 *  (operating_revenue, ebitda, net_profit, total_debt) plus the four
 *  metrics the F6.0.4 spec wanted as defaults (ebitda_margin, cash,
 *  current_ratio, net_debt_ebitda). No regression: every metric a user
 *  saw before is still here on first load, and they gain four more +
 *  full configurability.
 *
 *  The first four keys receive canonical-value overrides from the page
 *  (the engine-routed EBITDA / net-profit numbers) so they render
 *  byte-identical to the pre-F6.0.4 tiles. The rest resolve from the
 *  ReportingMetrics snapshot. */
export const DEFAULT_DASHBOARD: DashboardCard[] = [
  { id: "default-operating_revenue", conceptKey: "operating_revenue", size: "md", order: 0 },
  { id: "default-ebitda", conceptKey: "ebitda", size: "md", order: 1 },
  { id: "default-net_profit", conceptKey: "net_profit", size: "sm", order: 2 },
  { id: "default-total_debt", conceptKey: "total_debt", size: "sm", order: 3 },
  { id: "default-ebitda_margin", conceptKey: "ebitda_margin", size: "sm", order: 4 },
  { id: "default-cash", conceptKey: "cash", size: "sm", order: 5 },
  { id: "default-current_ratio", conceptKey: "current_ratio", size: "sm", order: 6 },
  { id: "default-net_debt_ebitda", conceptKey: "net_debt_ebitda", size: "sm", order: 7 },
  // Risk / opportunity COUNT cards (2026-07-25) — the top-3 risks and
  // opportunities surfaced on the overview, as tallies. Values come from the
  // page via overrides (recommendation counts); customTitle names them since
  // there's no concept-registry entry for a count.
  { id: "default-open_risks", conceptKey: "open_risks", size: "sm", order: 8, customTitle: "Risks", hideComparison: true },
  { id: "default-open_opportunities", conceptKey: "open_opportunities", size: "sm", order: 9, customTitle: "Opportunities", hideComparison: true },
];

/** Generate a stable unique id. crypto.randomUUID where available (all
 *  modern browsers); deterministic-enough fallback otherwise. */
export function newCardId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for ancient runtimes — combine time + a counter-ish slice.
  return `card-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
