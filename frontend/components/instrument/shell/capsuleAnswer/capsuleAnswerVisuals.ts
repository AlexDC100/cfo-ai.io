// THE CAPSULE — MINI-VISUALS, DERIVED FROM FACTS.
//
// Every visual on the answer surface is computed from `evidence.factMeta`
// — the typed, unit-declared, provenance-carrying values the retrieval
// step returned. NOTHING here reads the model's prose. That is the whole
// rule, and it is worth stating why it is not merely tidy:
//
// A chart parsed out of generated text is a chart with no provenance. It
// cannot be traced to a source cell, it cannot be re-derived, it cannot
// be checked against the statement it claims to summarise, and when the
// model rounds "1.2M" into a sentence the chart silently inherits the
// rounding as a fact. Deriving from `factMeta` instead means a visual
// carries exactly the same integer the balance sheet carries, and every
// point can name the period and snapshot it came from.
//
// This module is pure: no React, no i18n, no formatting. It picks WHICH
// visuals the evidence supports and hands back fact NAMES; the renderer
// resolves those names through `<Amount>`, which is the one component
// allowed to turn a number into pixels.

import type { CapsuleEvidence, CapsuleFactMeta, CapsuleUnit } from "./capsuleAnswerTypes";

export interface CapsuleComparisonVisual {
  kind: "comparison";
  id: string;
  metric: string;
  unit: CapsuleUnit;
  /** Earlier side. */
  factA: string;
  labelA: string;
  /** Later side. */
  factB: string;
  labelB: string;
  /** The engine's own delta — never recomputed here. */
  factDelta: string | null;
  /** Direction of the delta, for the chip's tone. Derived from the
   *  delta's SIGN only; "better" is a judgement this module does not
   *  make (a fall in expenses and a fall in revenue share a sign). */
  direction: "up" | "down" | "flat";
}

export interface CapsuleSparklineVisual {
  kind: "sparkline";
  id: string;
  metric: string;
  unit: CapsuleUnit;
  /** Oldest → newest, in the order the plan asked for them. */
  points: { fact: string; label: string; value: number }[];
}

export type CapsuleVisual = CapsuleComparisonVisual | CapsuleSparklineVisual;

/** How many visuals one answer may carry. The surface is an inline
 *  overlay, not a dashboard; past two, the answer stops being an answer. */
export const MAX_VISUALS = 2;

const COMPARE_SUFFIX_A = "_a";
const COMPARE_SUFFIX_B = "_b";
const COMPARE_SUFFIX_DELTA = "_delta";

function direction(delta: number | undefined): "up" | "down" | "flat" {
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) return "flat";
  return delta > 0 ? "up" : "down";
}

/**
 * Comparisons. `compare_periods` emits `<fact>_a` / `<fact>_b` /
 * `<fact>_delta`; a triple with both sides present is a mini table, a
 * lone delta is a chip.
 */
export function comparisonsFrom(evidence: CapsuleEvidence): CapsuleComparisonVisual[] {
  const out: CapsuleComparisonVisual[] = [];
  const meta = evidence.factMeta;
  for (const name of Object.keys(meta)) {
    if (!name.endsWith(COMPARE_SUFFIX_A)) continue;
    const base = name.slice(0, -COMPARE_SUFFIX_A.length);
    const bName = `${base}${COMPARE_SUFFIX_B}`;
    const deltaName = `${base}${COMPARE_SUFFIX_DELTA}`;
    const a = meta[name];
    const b = meta[bName];
    if (!a || !b) continue;
    // Two sides of one comparison must be the same unit, or the table
    // would put a ratio beside money under one heading.
    if (a.unit !== b.unit) continue;
    const delta = meta[deltaName];
    out.push({
      kind: "comparison",
      id: `cmp:${base}`,
      metric: a.metric || base,
      unit: a.unit,
      factA: name,
      labelA: a.periodLabel ?? a.scope ?? "",
      factB: bName,
      labelB: b.periodLabel ?? b.scope ?? "",
      factDelta: delta ? deltaName : null,
      direction: direction(delta?.value),
    });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

/**
 * Series. Three or more reads of the SAME metric on DIFFERENT periods —
 * which is exactly what the trend plan produces, and nothing else does.
 * Ordered by plan step, which the planner emits oldest → newest.
 */
export function sparklinesFrom(evidence: CapsuleEvidence): CapsuleSparklineVisual[] {
  const byMetric = new Map<string, CapsuleFactMeta[]>();
  for (const meta of Object.values(evidence.factMeta)) {
    // A comparison leg is not a series point — it already has a table.
    if (/_(a|b|delta)$/.test(meta.fact)) continue;
    if (!meta.periodId) continue;
    const key = `${meta.metric}|${meta.unit}`;
    const bucket = byMetric.get(key);
    if (bucket) bucket.push(meta);
    else byMetric.set(key, [meta]);
  }

  const out: CapsuleSparklineVisual[] = [];
  for (const [key, rows] of byMetric) {
    const distinct = new Map<string, CapsuleFactMeta>();
    for (const r of rows) if (!distinct.has(r.periodId!)) distinct.set(r.periodId!, r);
    if (distinct.size < 3) continue;
    const ordered = Array.from(distinct.values()).sort((a, b) => a.step - b.step);
    out.push({
      kind: "sparkline",
      id: `spark:${key}`,
      metric: ordered[0].metric,
      unit: ordered[0].unit,
      points: ordered.map((m) => ({
        fact: m.fact,
        label: m.periodLabel ?? "",
        value: m.value,
      })),
    });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

/** Every visual the evidence supports, capped and deterministically
 *  ordered: series first (they carry the most information per pixel). */
export function visualsFrom(evidence: CapsuleEvidence): CapsuleVisual[] {
  return [...sparklinesFrom(evidence), ...comparisonsFrom(evidence)].slice(0, MAX_VISUALS);
}

// ── geometry ───────────────────────────────────────────────────────────

export interface SparkGeometry {
  /** `M x,y L x,y …` in the given viewBox. */
  path: string;
  /** Plotted point coordinates, for the end dot and hit targets. */
  points: { x: number; y: number }[];
  /** True when every value is identical — the line is drawn flat at the
   *  vertical centre rather than dividing by a zero range. */
  flat: boolean;
}

/**
 * Turn values into a polyline. Pure geometry: no clock, no randomness,
 * no rounding of the underlying values — the same input always draws the
 * same path, which is what makes a screenshot gate meaningful.
 */
export function sparkGeometry(
  values: readonly number[],
  width = 72,
  height = 20,
  pad = 2,
): SparkGeometry {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return { path: "", points: [], flat: true };
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const range = max - min;
  const flat = range === 0;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = usable.length > 1 ? innerW / (usable.length - 1) : 0;
  const points = usable.map((v, i) => ({
    x: round2(pad + step * i),
    // SVG y grows downward — the largest value must sit highest.
    y: round2(flat ? pad + innerH / 2 : pad + innerH - ((v - min) / range) * innerH),
  }));
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`)
    .join(" ");
  return { path, points, flat };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
