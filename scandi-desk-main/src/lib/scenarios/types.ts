// F6.0.5 Phase 1 foundation (2026-06-20) — Scenario type definitions.
//
// A scenario is a NAMED, SAVED what-if exercise built on top of a baseline
// trial balance. Each scenario carries a list of adjustments + metadata.
// The cascade engine (cascade.ts) takes scenario adjustments and produces
// a new ConceptContext shape — pure function, deterministic, testable.
//
// Persistence is intentionally device-local for Phase 1 (localStorage via
// the Context store). Backend persistence + cross-device sync is Phase 1b
// after the math has been validated against multiple real Romanian SME
// trial balances. Same pattern as F5.0 learning-mode preferences.
//
// Vocabulary (locked, do not synonymize):
//   · "Scenario" — the user-facing term. NEVER "model" (Excel power-users
//     have specific expectations of "model" that we do not yet meet).
//   · "Adjustment" — a single targeted change (e.g. Revenue −15%).
//   · "Target" — what's being adjusted (concept / account / driver).
//   · "Operation" — how it's adjusted (pct_change / absolute / set / driver).
//   · "Cascade" — the deterministic propagation of one or more adjustments
//     through P&L → BS → CF → Ratios.
//   · "Baseline" — the source-of-truth dataset the scenario derives from.
//     Sacred. Never mutated. Scenarios produce a NEW derived context.

import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";

/** Driver keys — translate "I want DIO = 90 days" into the underlying
 *  field changes (e.g. inventory = cogs × 90 / 365). Limited initial set;
 *  the cascade engine has a `applyDriverAdjustment` switch that handles
 *  each one. Adding a new driver = add the key here + the case in
 *  cascade.ts. */
export type DriverKey =
  | "dio_days"
  | "dso_days"
  | "dpo_days"
  | "gross_margin"
  | "ebitda_margin"
  | "net_margin"
  | "effective_tax_rate"
  | "capex_pct_revenue"
  | "da_pct_revenue";

/** Three target types — what the adjustment is pointing at:
 *  - concept: a top-level ReportingMetrics key (revenue, cogs, opex, ...).
 *  - account: a specific RAS account code (e.g. "701"). Affects only that
 *    account's contribution; the aggregate recomputes from the changed
 *    account + the other untouched accounts. NOT YET wired in cascade.ts
 *    for Phase 1 (concept-level adjustments cover 95% of use cases).
 *  - driver: a derived ratio that the cascade translates into the
 *    underlying field. See applyDriverAdjustment in cascade.ts. */
export type AdjustmentTarget =
  | { type: "concept"; conceptKey: keyof ReportingMetrics }
  | { type: "account"; accountCode: string }
  | { type: "driver"; driverKey: DriverKey };

/** Four operation types — how the value changes:
 *  - pct_change: multiply by (1 + value). value = -0.15 means -15%.
 *  - absolute_change: add value (signed). value = -500_000 means -€500K.
 *  - set_value: replace existing value entirely.
 *  - set_driver: paired with a driver target; value is in driver-native
 *    units (e.g. 90 = 90 days for DIO; 0.30 = 30% for margins). */
export type AdjustmentOperation =
  | { type: "pct_change"; value: number }
  | { type: "absolute_change"; value: number }
  | { type: "set_value"; value: number }
  | { type: "set_driver"; driverValue: number };

export interface Adjustment {
  /** Stable client-generated id for the row. localStorage-only in Phase 1. */
  id: string;
  target: AdjustmentTarget;
  operation: AdjustmentOperation;
  /** Free-text rationale captured at creation. Surfaces in the scenario
   *  editor's adjustment-card details. */
  note?: string;
  /** ISO 8601 string. Audit trail — when this adjustment was added. */
  createdAt: string;
}

/** The full saved scenario record. Persisted in localStorage under
 *  `cfo:scenarios:v1`. */
export interface SavedScenario {
  id: string;
  name: string;
  description?: string;
  /** The actual/budget dataset this scenario cascades from. Required. */
  parentDatasetId: string;
  /** Optional second baseline for comparison-style scenarios where the
   *  user wants to see the scenario against TWO baselines (e.g. actual
   *  vs budget vs scenario). Phase 1b feature; can be null. */
  comparisonDatasetId?: string | null;
  adjustments: Adjustment[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  /** Bumped whenever adjustments change. Used as a cache-bust key for
   *  the cascade memoization in ConceptContextProvider (future F6.0.5
   *  integration phase). */
  cascadeVersion: number;
}

/** Covenant test result — produced by the covenant engine when a
 *  scenario's cascaded ratios are tested against the user's covenants. */
export interface CovenantBreach {
  covenantId: string;
  metric: string;
  actual: number;
  threshold: number;
  operator: "<" | "<=" | ">" | ">=" | "=";
  /** "breach" = active violation. "warning" = within warningBuffer of
   *  threshold but not yet breached. */
  severity: "breach" | "warning";
  /** Human-readable covenant name (e.g. "Senior facility net leverage"). */
  name: string;
}
