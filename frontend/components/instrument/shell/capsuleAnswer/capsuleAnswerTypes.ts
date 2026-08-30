// THE CAPSULE — ANSWER SURFACE: the wire types.
//
// Everything here mirrors `src/engine/api/_capsule_tools.py`'s
// `ToolResult.to_payload()` (contract "ct1") one field at a time. It is a
// TRANSCRIPTION, not an interpretation: when the engine adds a field this
// file grows a field, and nothing downstream starts inferring.
//
// The single most important pair in this file is `facts` + `fact_units`.
// They are the `{{money:FACT}}` bridge: the engine DECLARES which of its
// values are money (it is the only layer that knows), and the renderer
// binds placeholders against that declaration. Nothing on this side ever
// decides "this looks like money" from a magnitude — that guess is the
// 461 defect, and it is not available here by construction: there is no
// code path in the answer lane that turns an undeclared number into a
// currency-formatted one.

import type { Currency } from "@/lib/rates";

/** Contract version the engine stamps on every payload. */
export const CAPSULE_TOOLS_VERSION = "ct1";

/** Unit vocabulary. Mirrors `_ratio_units` / `narrativeMoney`'s
 *  `NarrativeUnit`. An unknown string is a REFUSAL, never a default. */
export type CapsuleUnit =
  | "money"
  | "ratio"
  | "percent"
  | "days"
  | "count"
  | "score";

export const DIMENSIONLESS_UNITS: readonly CapsuleUnit[] = [
  "ratio",
  "percent",
  "days",
  "count",
  "score",
];

export interface CapsuleProvenance {
  period_id?: string;
  period_label?: string;
  entity_id?: string;
  source?: string;
  tier?: string;
  snapshot_id?: string;
  line_id?: string;
  [key: string]: unknown;
}

export interface CapsuleMoneyValue {
  kind: "money";
  fact: string;
  metric: string;
  unit: "money";
  amount_minor: number;
  value: number;
  currency: string;
  scope: string;
  label_key: string;
  provenance: CapsuleProvenance;
}

export interface CapsuleRatioValue {
  kind: "ratio";
  fact: string;
  metric: string;
  unit: string;
  value: number;
  numerator_minor: number;
  denominator_minor: number;
  operand_currency: string;
  scope: string;
  label_key: string;
  provenance: CapsuleProvenance;
}

export type CapsuleValue = CapsuleMoneyValue | CapsuleRatioValue;

export interface CapsuleRowPayload {
  kind: string;
  id: string;
  fields: Record<string, unknown>;
  money: CapsuleMoneyValue[];
}

/** C5 — a typed ABSENCE. Never carries a substitute value. */
export interface CapsuleGap {
  kind: "gap";
  tool: string;
  code: string;
  missing: string[];
  detail: string;
  fix: string;
  upsell_key: string;
}

/** The data is present; the READ would be dishonest. */
export interface CapsuleLimitation {
  kind: "limitation";
  tool: string;
  rule: string;
  detail: string;
  alternative: string;
}

export interface CapsuleToolPayload {
  version: string;
  tool: string;
  read_only: boolean;
  ok: boolean;
  values: CapsuleValue[];
  rows: CapsuleRowPayload[];
  gaps: CapsuleGap[];
  limitations: CapsuleLimitation[];
  notes: string[];
  facts: Record<string, number>;
  fact_units: Record<string, string>;
  currency: string | null;
}

// ── Evidence — the merge of every tool call in one turn ────────────────

/** What we know about ONE bound fact name, after merging. `alias` is set
 *  when a later tool re-used a name that was already taken by a different
 *  value (the same metric read on two periods does exactly that), and the
 *  fact was renamed so the two cannot collapse into one. */
export interface CapsuleFactMeta {
  fact: string;
  metric: string;
  unit: CapsuleUnit;
  value: number;
  scope: string;
  labelKey: string;
  periodId: string | null;
  periodLabel: string | null;
  snapshotId: string | null;
  currency: string | null;
  tool: string;
  /** Original engine-side name, when this fact was renamed on merge. */
  alias: string | null;
  /** Position of the producing step — the chronological order the
   *  planner asked for, which is what a sparkline is drawn along. */
  step: number;
}

export interface CapsuleEvidence {
  /** `{{money:FACT}}` binding map — name → native value. */
  facts: Record<string, number>;
  /** name → DECLARED unit. Never inferred. */
  factUnits: Record<string, string>;
  /** Full per-fact detail, for visuals, citations and the evidence panel. */
  factMeta: Record<string, CapsuleFactMeta>;
  /** The ONE currency the money facts are denominated in. Null when the
   *  evidence carries no money at all. */
  currency: Currency | null;
  values: CapsuleValue[];
  rows: CapsuleRowPayload[];
  gaps: CapsuleGap[];
  limitations: CapsuleLimitation[];
  notes: string[];
  tools: string[];
  periods: { id: string; label: string }[];
  snapshots: string[];
  /** Digit-bearing strings the model is allowed to reproduce verbatim
   *  (period labels, account codes, tickers). See `capsuleAnswerGuard`. */
  literals: string[];
}

export function emptyEvidence(): CapsuleEvidence {
  return {
    facts: {},
    factUnits: {},
    factMeta: {},
    currency: null,
    values: [],
    rows: [],
    gaps: [],
    limitations: [],
    notes: [],
    tools: [],
    periods: [],
    snapshots: [],
    literals: [],
  };
}

export function isMoneyValue(v: CapsuleValue): v is CapsuleMoneyValue {
  return v.kind === "money";
}

/** Narrow a declared unit string, or null when the engine declared
 *  something this build does not know. Null is a refusal: an undeclared
 *  fact never renders as money. */
export function asUnit(declared: string | undefined | null): CapsuleUnit | null {
  if (declared === "money") return "money";
  if (declared && (DIMENSIONLESS_UNITS as readonly string[]).includes(declared)) {
    return declared as CapsuleUnit;
  }
  return null;
}
