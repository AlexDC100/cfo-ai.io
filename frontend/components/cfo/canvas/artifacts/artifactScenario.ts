// THE ARTIFACTS — SCENARIO: drivers the reader moves, arithmetic the
// reader can audit, and a parity check that refuses the whole card when
// the arithmetic disagrees with the engine at rest.
//
// ── Who computes ─────────────────────────────────────────────────────
//
// The law says the ENGINE computes. A slider that round-trips to the
// backend on every pixel of drag is unusable, so the honest way to hold
// the law on a live control is not "compute in the browser and hope" —
// it is:
//
//   1. THE MODEL AUTHORS NO ARITHMETIC. A scenario spec names driver
//      ids and output ids out of the frozen registry below. There is no
//      formula field anywhere in the spec schema, so a model cannot
//      introduce one.
//   2. THE FORMULAS ARE A TRANSCRIPTION, NOT AN INVENTION. Each output
//      below is one of the same native-unit derivations
//      `capsuleFactIndex` already performs (`ebitda_margin = ebitda /
//      revenue`, `net_debt_ebitda = net_debt / ebitda`), with the same
//      refusals: a zero or absent denominator produces NOTHING.
//   3. BASELINE PARITY IS ASSERTED, NOT ASSUMED. With every driver at
//      rest, each output is recomputed and compared against the ENGINE'S
//      OWN value for that same metric. Agreement is the licence to move
//      the slider at all. Disagreement is reported as `drift` and the
//      card refuses to project — a transcription that cannot reproduce
//      the engine's number at rest will not reproduce it at 1.1×, and
//      hiding that behind a plausible curve is the whole failure mode.
//
// So the browser evaluates, but only formulas it did not choose, only
// over facts the gateway supplied, and only after proving it agrees with
// the engine on the one point where the answer is already known.
//
// ── Units ────────────────────────────────────────────────────────────
//
// Native-unit math throughout (`capsuleFactIndex` F3): operands come
// from ONE period in their SOURCE currency, so a ratio is dimensionless
// and invariant under the display-currency dial. Percent facts are
// FRACTIONS here, matching `amountFormat.formatPercentDelta`.
//
// Pure module: no React, no i18n, no fetch, no clock.

import type {
  CapsuleEvidence,
  CapsuleUnit,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";
import type { ScenarioRegistry } from "./artifactSpec";
import type { DriverSpan } from "./artifactSpec";

// ══════════════════════════════════════════════════════════════════════
// THE REGISTRY
// ══════════════════════════════════════════════════════════════════════

export interface DriverDef {
  id: string;
  /** The fact this lever scales. Absent from the evidence → the driver
   *  is not offered. ABSENT != ZERO, and a slider on nothing is worse
   *  than no slider. */
  fact: string;
  labelKey: string;
}

export interface OutputDef {
  id: string;
  unit: CapsuleUnit;
  /** Facts this output reads, in the order the formula names them. */
  inputs: readonly string[];
  labelKey: string;
  /** Native-unit arithmetic over the operands. Returns null to REFUSE
   *  (absent operand, zero denominator) — never a substitute value. */
  compute: (v: Readonly<Record<string, number>>) => number | null;
}

function num(v: Readonly<Record<string, number>>, k: string): number | null {
  const x = v[k];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Levers. Each one scales exactly ONE money fact; a lever that moved
 *  two facts at once would be a model of the business, and this card is
 *  not one — it is a sensitivity read. */
export const DRIVERS: readonly DriverDef[] = Object.freeze([
  { id: "revenue", fact: "revenue", labelKey: "artifact.driver.revenue" },
  { id: "expenses", fact: "expenses", labelKey: "artifact.driver.expenses" },
  // EBITDA is a LEVER, not an output. It is not derivable from the
  // served operand set — the gateway publishes no D&A fact, so
  // "revenue − expenses" is the NET result here, not EBITDA (that is
  // exactly how `capsuleFactIndex` defines `expenses`: revenue minus
  // net result). Writing an `ebitda` output over those two operands
  // would have produced a number that disagrees with the engine's own
  // EBITDA by the whole of D&A, and the parity check below is what
  // surfaced it on the fixtures. So EBITDA is served and moved, never
  // recomputed.
  { id: "ebitda", fact: "ebitda", labelKey: "artifact.driver.ebitda" },
  { id: "cash", fact: "cash", labelKey: "artifact.driver.cash" },
  { id: "current_assets", fact: "current_assets", labelKey: "artifact.driver.current_assets" },
  {
    id: "current_liabilities",
    fact: "current_liabilities",
    labelKey: "artifact.driver.current_liabilities",
  },
  { id: "net_debt", fact: "net_debt", labelKey: "artifact.driver.net_debt" },
  { id: "equity", fact: "equity", labelKey: "artifact.driver.equity" },
  { id: "total_assets", fact: "total_assets", labelKey: "artifact.driver.total_assets" },
]);

/** Outputs. Every formula here is the same one `capsuleFactIndex`
 *  derives, transcribed — not a new metric invented for a chart. */
export const OUTPUTS: readonly OutputDef[] = Object.freeze([
  {
    // The engine's own identity, inverted. `capsuleFactIndex` derives
    // `expenses` as `revenue − net_result`; reading it back the other
    // way is the same arithmetic, which is why it reproduces the
    // engine exactly at rest rather than approximately.
    id: "net_result",
    unit: "money",
    inputs: ["revenue", "expenses"],
    labelKey: "capsule.metric.net_result",
    compute: (v) => {
      const r = num(v, "revenue");
      const e = num(v, "expenses");
      return r === null || e === null ? null : r - e;
    },
  },
  {
    id: "ebitda_margin",
    unit: "percent",
    inputs: ["ebitda", "revenue"],
    labelKey: "capsule.metric.ebitda_margin",
    compute: (v) => {
      const e = num(v, "ebitda");
      const r = num(v, "revenue");
      if (e === null || r === null || r === 0) return null;
      return e / r;
    },
  },
  {
    id: "net_margin",
    unit: "percent",
    inputs: ["net_result", "revenue"],
    labelKey: "capsule.metric.net_margin",
    compute: (v) => {
      const n = num(v, "net_result");
      const r = num(v, "revenue");
      if (n === null || r === null || r === 0) return null;
      return n / r;
    },
  },
  {
    id: "current_ratio",
    unit: "ratio",
    inputs: ["current_assets", "current_liabilities"],
    labelKey: "capsule.metric.current_ratio",
    compute: (v) => {
      const a = num(v, "current_assets");
      const l = num(v, "current_liabilities");
      if (a === null || l === null || l === 0) return null;
      return a / l;
    },
  },
  {
    id: "cash_ratio",
    unit: "ratio",
    inputs: ["cash", "current_liabilities"],
    labelKey: "capsule.metric.cash_ratio",
    compute: (v) => {
      const c = num(v, "cash");
      const l = num(v, "current_liabilities");
      if (c === null || l === null || l === 0) return null;
      return c / l;
    },
  },
  {
    id: "working_capital",
    unit: "money",
    inputs: ["current_assets", "current_liabilities"],
    labelKey: "capsule.metric.working_capital",
    compute: (v) => {
      const a = num(v, "current_assets");
      const l = num(v, "current_liabilities");
      return a === null || l === null ? null : a - l;
    },
  },
  {
    id: "equity_ratio",
    unit: "percent",
    inputs: ["equity", "total_assets"],
    labelKey: "capsule.metric.equity_ratio",
    compute: (v) => {
      const e = num(v, "equity");
      const a = num(v, "total_assets");
      if (e === null || a === null || a === 0) return null;
      return e / a;
    },
  },
  {
    id: "net_debt_ebitda",
    unit: "ratio",
    inputs: ["net_debt", "ebitda"],
    labelKey: "capsule.metric.net_debt_ebitda",
    compute: (v) => {
      const d = num(v, "net_debt");
      const e = num(v, "ebitda");
      if (d === null || e === null || e === 0) return null;
      return d / e;
    },
  },
]);

export const SCENARIO_REGISTRY: ScenarioRegistry = Object.freeze({
  drivers: Object.freeze(DRIVERS.map((d) => d.id)),
  outputs: Object.freeze(OUTPUTS.map((o) => o.id)),
});

export function driverDef(id: string): DriverDef | null {
  return DRIVERS.find((d) => d.id === id) ?? null;
}

export function outputDef(id: string): OutputDef | null {
  return OUTPUTS.find((o) => o.id === id) ?? null;
}

// ══════════════════════════════════════════════════════════════════════
// SPANS — code owns the range, the model only says how far it reaches
// ══════════════════════════════════════════════════════════════════════

export interface Span {
  min: number;
  max: number;
  /** Slider granularity, as a multiplier step. */
  step: number;
}

const SPANS: Readonly<Record<DriverSpan, Span>> = Object.freeze({
  tight: { min: 0.95, max: 1.05, step: 0.005 },
  normal: { min: 0.8, max: 1.2, step: 0.01 },
  wide: { min: 0.5, max: 1.5, step: 0.025 },
});

export function spanFor(span: DriverSpan | undefined): Span {
  return SPANS[span ?? "normal"];
}

/** Rest position. Named rather than written as a literal at ten call
 *  sites, because "is this slider at rest" is the predicate the parity
 *  check turns on. */
export const AT_REST = 1;

// ══════════════════════════════════════════════════════════════════════
// EVALUATION
// ══════════════════════════════════════════════════════════════════════

export type ParityVerdict = "exact" | "drift" | "unverifiable";

export interface OutputReading {
  id: string;
  labelKey: string;
  unit: CapsuleUnit;
  /** Recomputed under the current lever positions. Null = refused. */
  value: number | null;
  /** The engine's own value for this metric, when it supplied one. */
  engineValue: number | null;
  /** Comparison of the RECOMPUTED-AT-REST value against `engineValue`.
   *  `unverifiable` means the engine did not publish this metric, so
   *  there was nothing to check against — reported as its own state
   *  rather than folded into "exact" (a clean result and a no-subject
   *  result must not look the same). */
  parity: ParityVerdict;
  /** Relative gap at rest, for the drift message. Null when parity is
   *  `unverifiable`. */
  parityGap: number | null;
  /** Facts that fed this reading, for the citation. */
  inputs: readonly string[];
}

export interface ScenarioReading {
  /** Baseline native values, straight from the gateway. */
  baseline: Readonly<Record<string, number>>;
  /** Values after the lever positions were applied. */
  applied: Readonly<Record<string, number>>;
  outputs: OutputReading[];
  /** True when EVERY verifiable output reproduced the engine at rest.
   *  The card projects only when this is true. */
  parityHolds: boolean;
  /** Outputs that could be checked at all. Zero means the card has no
   *  evidence it agrees with anything, which is NOT the same as
   *  agreement — see TC-9. */
  verifiedCount: number;
}

/** Relative tolerance for the parity check. A transcription of the
 *  engine's own formula over the engine's own operands should agree to
 *  the last bits of a double; this leaves room for one rounding at the
 *  serialization boundary and nothing more. */
export const PARITY_EPSILON = 1e-9;

function relativeGap(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / scale;
}

/**
 * Resolve the operand set: every fact any requested output reads, taken
 * from the evidence, then overridden by the lever positions.
 *
 * Note the ORDER dependency and why it is safe. `ebitda_margin` reads
 * `ebitda`, which is itself an output. If the levers moved `revenue`,
 * the margin must see the RECOMPUTED ebitda, not the served one. So
 * outputs are evaluated in registry order and each result is folded back
 * into the operand set — and the registry is ordered so a dependency
 * always precedes its dependents. `SCENARIO_REGISTRY` order is therefore
 * load-bearing, and `artifactScenario.test.ts` asserts it.
 */
export function evaluateScenario(
  evidence: CapsuleEvidence,
  outputIds: readonly string[],
  positions: Readonly<Record<string, number>>,
): ScenarioReading {
  const baseline: Record<string, number> = {};
  for (const [k, v] of Object.entries(evidence.facts)) {
    if (typeof v === "number" && Number.isFinite(v)) baseline[k] = v;
  }

  const applied: Record<string, number> = { ...baseline };
  for (const d of DRIVERS) {
    const pos = positions[d.id];
    if (typeof pos !== "number" || !Number.isFinite(pos)) continue;
    const base = baseline[d.fact];
    if (typeof base !== "number") continue; // no fact → no lever
    applied[d.fact] = base * pos;
  }

  // Two passes over the SAME registry order: one at rest (parity), one
  // with the levers applied (the reading).
  const atRest: Record<string, number> = { ...baseline };
  const moved: Record<string, number> = { ...applied };
  const readings: OutputReading[] = [];
  let parityHolds = true;
  let verifiedCount = 0;

  for (const def of OUTPUTS) {
    const restValue = def.compute(atRest);
    if (restValue !== null) atRest[def.id] = restValue;
    const movedValue = def.compute(moved);
    if (movedValue !== null) moved[def.id] = movedValue;

    if (!outputIds.includes(def.id)) continue;

    const engineValue =
      typeof baseline[def.id] === "number" && Number.isFinite(baseline[def.id])
        ? baseline[def.id]
        : null;

    let parity: ParityVerdict = "unverifiable";
    let parityGap: number | null = null;
    if (engineValue !== null && restValue !== null) {
      parityGap = relativeGap(restValue, engineValue);
      parity = parityGap <= PARITY_EPSILON ? "exact" : "drift";
      verifiedCount += 1;
      if (parity === "drift") parityHolds = false;
    }

    readings.push({
      id: def.id,
      labelKey: def.labelKey,
      unit: def.unit,
      value: movedValue,
      engineValue,
      parity,
      parityGap,
      inputs: def.inputs,
    });
  }

  return { baseline, applied, outputs: readings, parityHolds, verifiedCount };
}

/** All levers at rest — the parity probe's own input, and the card's
 *  initial state. */
export function restPositions(driverIds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of driverIds) out[id] = AT_REST;
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// "RECOMPUTE WITHOUT THIS ITEM" — the finding card's second half
// ══════════════════════════════════════════════════════════════════════

export interface ExclusionReading {
  outputId: string;
  labelKey: string;
  unit: CapsuleUnit;
  /** The metric as served. */
  withItem: number | null;
  /** The metric with the excluded amount removed from every operand
   *  that contains it. Null when the recomputation refuses. */
  withoutItem: number | null;
  /** Which operands the exclusion touched — named so the reader can see
   *  the assumption rather than take the delta on trust. */
  touched: readonly string[];
  /** Set when the metric could not be recomputed, naming why. */
  refusal: "absent_metric" | "absent_amount" | "no_operand" | "refused" | null;
}

/**
 * Recompute one registry output with `excludeFact`'s amount removed.
 *
 * The subtraction is applied to the output's MONEY operands only, and
 * only to those whose value is at least as large as the amount removed —
 * removing 7.7M from a 4M operand would produce a negative that never
 * existed. Anything else refuses. This is deliberately conservative: the
 * card's claim is "here is the metric without this item", and a wrong
 * counterfactual is worse than an absent one.
 */
export function evaluateExclusion(
  evidence: CapsuleEvidence,
  outputId: string,
  excludeFact: string,
): ExclusionReading | null {
  const def = outputDef(outputId);
  if (!def) return null;

  const base: Record<string, number> = {};
  for (const [k, v] of Object.entries(evidence.facts)) {
    if (typeof v === "number" && Number.isFinite(v)) base[k] = v;
  }
  const withItem = def.compute(base);
  const amount = base[excludeFact];
  const excludeMeta = evidence.factMeta[excludeFact];

  const shell: ExclusionReading = {
    outputId,
    labelKey: def.labelKey,
    unit: def.unit,
    withItem,
    withoutItem: null,
    touched: [],
    refusal: null,
  };

  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return { ...shell, refusal: "absent_amount" };
  }
  if (!excludeMeta || excludeMeta.unit !== "money") {
    return { ...shell, refusal: "absent_amount" };
  }

  const adjusted: Record<string, number> = { ...base };
  const touched: string[] = [];
  for (const operand of def.inputs) {
    const meta = evidence.factMeta[operand];
    const value = base[operand];
    if (!meta || meta.unit !== "money" || typeof value !== "number") continue;
    if (Math.abs(value) < Math.abs(amount)) continue; // would invent a sign flip
    adjusted[operand] = value - amount;
    touched.push(operand);
  }
  if (touched.length === 0) {
    return { ...shell, refusal: "no_operand" };
  }
  const withoutItem = def.compute(adjusted);
  if (withoutItem === null) {
    return { ...shell, touched, refusal: "refused" };
  }
  return { ...shell, withoutItem, touched };
}
