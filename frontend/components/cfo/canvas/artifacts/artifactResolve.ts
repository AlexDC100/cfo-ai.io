// THE ARTIFACTS — RESOLUTION. Where a spec becomes figures.
//
// `artifactSpec` proved the model wrote no digits. This module supplies
// the digits, and it may only take them from ONE place: the evidence the
// facts gateway returned. It reads `evidence.factMeta` and
// `evidence.values`; it never reads model prose, never re-derives a
// gateway total, and never fills an absence.
//
// ── Minor units, because a waterfall adds up ──────────────────────────
//
// A waterfall is the signature chart of this lane and it is the one that
// does arithmetic: an EBITDA bridge is a running sum of deltas. Summing
// floats produces a closing bar that misses the engine's own total by a
// cent and reads as a rounding bug in the balance sheet. So every
// derivation here runs on INTEGER MINOR UNITS (`amount_minor`, the field
// the engine already publishes on every money value), exactly as
// `servedFacts` does internally, and converts once at the edge.
//
// When the spec also names the engine's own closing `total`, the
// resolver COMPARES its derived cumulative against it in minor units and
// records `totalAgrees`. It never silently adopts one or the other: a
// disagreement is surfaced on the card, because two totals that differ
// is information, and picking the prettier one is how a wrong number
// gets a chart drawn around it.
//
// ── ABSENT IS NOT ZERO, one more time ────────────────────────────────
//
// A `null` cell resolves to a `ResolvedFigure` with `present: false` and
// NO value field. There is no zero anywhere in this module's output for
// a fact that was not supplied — the renderers show the missing glyph.
// A chart point that cannot be resolved drops the whole series rather
// than plotting a gap at zero, which is a lie with a shape.

import type { AmountProvenance } from "@/components/instrument/Amount";
import {
  isMoneyValue,
  type CapsuleEvidence,
  type CapsuleFactMeta,
  type CapsuleProvenance,
  type CapsuleUnit,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

import type {
  ArtifactSpec,
  ChartSpec,
  ComparisonSpec,
  Precision,
  TableRowSpec,
  TableSpec,
} from "./artifactSpec";

// ══════════════════════════════════════════════════════════════════════
// THE RESOLVED SHAPES
// ══════════════════════════════════════════════════════════════════════

/** One figure, ready for `<Amount>`. `present: false` carries NO value —
 *  the type makes "render the absence" the only reachable branch. */
export type ResolvedFigure =
  | {
      present: true;
      fact: string;
      value: number;
      /** Integer minor units when the engine published them. Null for
       *  dimensionless facts and for money the engine sent as a float
       *  only — derivations refuse rather than guess a scale. */
      minor: number | null;
      unit: CapsuleUnit;
      currency: string | null;
      label: string;
      periodId: string | null;
      periodLabel: string | null;
      snapshot: string | null;
      provenance: AmountProvenance | null;
      /** Set when this figure was DERIVED here rather than served.
       *  Names the facts it came from, so the card can say so. */
      derivedFrom?: readonly string[];
    }
  | { present: false; fact: string | null };

export const ABSENT: ResolvedFigure = { present: false, fact: null };

export interface ResolvedSeries {
  label: string;
  unit: CapsuleUnit;
  currency: string | null;
  points: Array<{ label: string; figure: ResolvedFigure }>;
}

export interface ResolvedWaterfallStep {
  label: string;
  /** The delta itself. */
  figure: ResolvedFigure;
  /** Cumulative AFTER this step, derived in minor units. */
  cumulative: ResolvedFigure;
  /** Bar geometry inputs, in minor units: the span this bar covers. */
  fromMinor: number;
  toMinor: number;
}

export interface ResolvedChart {
  kind: "chart";
  form: ChartSpec["form"];
  series: ResolvedSeries[];
  /** Waterfall only. */
  steps: ResolvedWaterfallStep[] | null;
  /** Waterfall only — the engine's own closing total, when named. */
  total: ResolvedFigure | null;
  /** Waterfall only. `null` when there was nothing to compare. */
  totalAgrees: boolean | null;
  axisLabel: string | null;
  precision: Precision;
}

export interface ResolvedCell {
  role: "label" | "value" | "delta" | "share";
  figure: ResolvedFigure;
}

export interface ResolvedRow {
  label: string;
  cells: ResolvedCell[];
  accounts: readonly string[];
  children: ResolvedRow[];
}

export interface ResolvedTable {
  kind: "table";
  columns: Array<{ label: string; role: "label" | "value" | "delta" | "share" }>;
  rows: ResolvedRow[];
  totalRow: ResolvedRow | null;
  precision: Precision;
}

export interface ResolvedComparison {
  kind: "comparison";
  basis: ComparisonSpec["basis"];
  /** The one standard every column declared. Rendered on the card so
   *  the reader can see WHICH ruler, not just that there is one. */
  standard: string;
  rows: string[];
  columns: Array<{ label: string; currency: string | null; cells: ResolvedFigure[] }>;
}

/** What every card's footer prints. Assembled from the evidence, never
 *  from the spec — the model does not get to name its own sources. */
export interface ArtifactCitation {
  periods: Array<{ id: string; label: string }>;
  snapshots: string[];
  sources: string[];
  currency: string | null;
  /** Engine trust verdict, verbatim, when the evidence carried one. */
  trust: string | null;
  /** True when the evidence carried a gap or a limitation — the footer
   *  says so rather than presenting a partial artifact as complete. */
  incomplete: boolean;
}

export interface ResolvedArtifact {
  spec: ArtifactSpec;
  citation: ArtifactCitation;
  /** Facts that could not be resolved AFTER the guard passed. Should
   *  always be empty in production — the guard rejects unknown facts —
   *  but a spec resolved against DIFFERENT evidence (a refine that
   *  narrowed the retrieval) can produce them, and silently dropping
   *  them is how a chart loses a bar without telling anyone. */
  unresolved: string[];
}

// ══════════════════════════════════════════════════════════════════════
// FIGURE RESOLUTION
// ══════════════════════════════════════════════════════════════════════

function toAmountProvenance(
  p: CapsuleProvenance | undefined,
  meta: CapsuleFactMeta,
): AmountProvenance | null {
  const source =
    (typeof p?.source === "string" && p.source) ||
    (typeof p?.line_id === "string" && p.line_id) ||
    null;
  const snapshot = meta.snapshotId ?? (typeof p?.snapshot_id === "string" ? p.snapshot_id : null);
  const method = typeof p?.tier === "string" ? p.tier : meta.tool || null;
  if (!source && !snapshot && !method) return null;
  const out: AmountProvenance = {};
  if (source) out.source = source;
  if (method) out.method = method;
  if (snapshot) out.snapshot = snapshot;
  return out;
}

/** Minor-unit map, built once per evidence object. Only money values
 *  carry `amount_minor`; a dimensionless fact has no scale and must
 *  never acquire one. */
function minorIndex(evidence: CapsuleEvidence): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of evidence.values) {
    if (isMoneyValue(v) && Number.isInteger(v.amount_minor)) {
      out.set(v.fact, v.amount_minor);
    }
  }
  return out;
}

export interface Resolver {
  figure: (fact: string | null | undefined, label?: string) => ResolvedFigure;
  evidence: CapsuleEvidence;
  unresolved: string[];
}

export function makeResolver(evidence: CapsuleEvidence): Resolver {
  const minors = minorIndex(evidence);
  const unresolved: string[] = [];
  return {
    evidence,
    unresolved,
    figure(fact, label) {
      if (!fact) return ABSENT;
      const meta = evidence.factMeta[fact];
      const value = evidence.facts[fact];
      if (!meta || typeof value !== "number" || !Number.isFinite(value)) {
        if (!unresolved.includes(fact)) unresolved.push(fact);
        return { present: false, fact };
      }
      const own = evidence.values.find((v) => v.fact === fact);
      return {
        present: true,
        fact,
        value,
        minor: minors.has(fact) ? (minors.get(fact) as number) : null,
        unit: meta.unit,
        currency: meta.currency,
        label: label ?? meta.metric ?? fact,
        periodId: meta.periodId,
        periodLabel: meta.periodLabel,
        snapshot: meta.snapshotId,
        provenance: toAmountProvenance(own?.provenance, meta),
      };
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// CITATION
// ══════════════════════════════════════════════════════════════════════

export function citationFrom(evidence: CapsuleEvidence, trust: string | null = null): ArtifactCitation {
  const sources = new Set<string>();
  for (const v of evidence.values) {
    const s = v.provenance?.source;
    if (typeof s === "string" && s) sources.add(s);
  }
  return {
    periods: evidence.periods.slice(),
    snapshots: evidence.snapshots.slice(),
    sources: Array.from(sources).sort(),
    currency: evidence.currency,
    trust,
    incomplete: evidence.gaps.length > 0 || evidence.limitations.length > 0,
  };
}

// ══════════════════════════════════════════════════════════════════════
// CHART
// ══════════════════════════════════════════════════════════════════════

function seriesFrom(spec: ChartSpec, r: Resolver): ResolvedSeries[] {
  const out: ResolvedSeries[] = [];
  for (const s of spec.series) {
    const points = s.points.map((fact, i) => ({
      label: s.pointLabels?.[i] ?? "",
      figure: r.figure(fact),
    }));
    // A series with an unresolvable point is DROPPED whole. Plotting the
    // rest would silently change the shape of the claim — a downward
    // trend can become a flat one by losing its last bar.
    if (points.some((p) => !p.figure.present)) continue;
    const first = points[0].figure;
    if (!first.present) continue;
    out.push({
      label: s.label,
      unit: first.unit,
      currency: first.currency,
      points,
    });
  }
  return out;
}

/** The bridge. Cumulative sums in INTEGER minor units; the running
 *  totals are marked `derivedFrom` so a hover can name every delta that
 *  produced them. Refuses (returns null) when any step lacks minor
 *  units — a bridge summed in floats is a bridge that misses its own
 *  closing bar. */
function waterfallFrom(spec: ChartSpec, r: Resolver): ResolvedWaterfallStep[] | null {
  const flat: Array<{ label: string; figure: ResolvedFigure }> = [];
  for (const s of spec.series) {
    s.points.forEach((fact, i) => {
      flat.push({ label: s.pointLabels?.[i] ?? s.label, figure: r.figure(fact) });
    });
  }
  if (flat.length === 0) return null;
  const figures = flat.map((f) => f.figure);
  if (figures.some((f) => !f.present || f.minor === null)) return null;

  // The minor→major scale the ENGINE implied, taken from the first step
  // that carries a non-zero minor. Derived once rather than assumed to
  // be 100: the scale belongs to the engine's own pair of fields, and a
  // zero-cent currency would make a hard-coded 100 wrong by two orders.
  const scaleFrom = figures.find(
    (f): f is Extract<ResolvedFigure, { present: true }> =>
      f.present && f.minor !== null && f.minor !== 0 && Number.isFinite(f.value),
  );
  if (!scaleFrom || !scaleFrom.minor) return null;
  const perMinor = scaleFrom.value / scaleFrom.minor;

  const steps: ResolvedWaterfallStep[] = [];
  let running = 0;
  const seen: string[] = [];
  for (const step of flat) {
    const fig = step.figure;
    if (!fig.present || fig.minor === null) return null;
    const from = running;
    running += fig.minor;
    seen.push(fig.fact);
    steps.push({
      label: step.label,
      figure: fig,
      fromMinor: from,
      toMinor: running,
      cumulative: {
        present: true,
        fact: `${fig.fact}__cumulative`,
        value: running * perMinor,
        minor: running,
        unit: fig.unit,
        currency: fig.currency,
        label: step.label,
        periodId: fig.periodId,
        periodLabel: fig.periodLabel,
        snapshot: fig.snapshot,
        provenance: fig.provenance,
        derivedFrom: seen.slice(),
      },
    });
  }
  return steps;
}

export function resolveChart(
  spec: ChartSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
): { artifact: ResolvedArtifact; chart: ResolvedChart } {
  const r = makeResolver(evidence);
  const series = seriesFrom(spec, r);
  const steps = spec.form === "waterfall" ? waterfallFrom(spec, r) : null;
  const total = spec.total ? r.figure(spec.total) : null;

  let totalAgrees: boolean | null = null;
  if (steps && steps.length > 0 && total && total.present && total.minor !== null) {
    totalAgrees = steps[steps.length - 1].toMinor === total.minor;
  }

  return {
    artifact: { spec, citation: citationFrom(evidence, trust), unresolved: r.unresolved },
    chart: {
      kind: "chart",
      form: spec.form,
      series,
      steps,
      total,
      totalAgrees,
      axisLabel: spec.axisLabel ?? null,
      precision: spec.precision ?? "auto",
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// TABLE
// ══════════════════════════════════════════════════════════════════════

function resolveRow(
  row: TableRowSpec,
  roles: Array<"label" | "value" | "delta" | "share">,
  r: Resolver,
): ResolvedRow {
  return {
    label: row.label,
    cells: row.cells.map((fact, i) => ({
      role: roles[i] ?? "value",
      figure: r.figure(fact),
    })),
    accounts: row.accounts ?? [],
    children: (row.children ?? []).map((c) => resolveRow(c, roles, r)),
  };
}

export function resolveTable(
  spec: TableSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
): { artifact: ResolvedArtifact; table: ResolvedTable } {
  const r = makeResolver(evidence);
  const valueRoles = spec.columns
    .filter((c) => c.role !== "label")
    .map((c) => c.role as "value" | "delta" | "share");
  return {
    artifact: { spec, citation: citationFrom(evidence, trust), unresolved: r.unresolved },
    table: {
      kind: "table",
      columns: spec.columns.map((c) => ({ label: c.label, role: c.role })),
      rows: spec.rows.map((row) => resolveRow(row, valueRoles, r)),
      totalRow: spec.totalRow ? resolveRow(spec.totalRow, valueRoles, r) : null,
      precision: spec.precision ?? "auto",
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// COMPARISON
// ══════════════════════════════════════════════════════════════════════

export function resolveComparison(
  spec: ComparisonSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
): { artifact: ResolvedArtifact; comparison: ResolvedComparison } {
  const r = makeResolver(evidence);
  const standards = Array.from(new Set(spec.columns.map((c) => c.standard)));
  return {
    artifact: { spec, citation: citationFrom(evidence, trust), unresolved: r.unresolved },
    comparison: {
      kind: "comparison",
      basis: spec.basis,
      // The guard already refused more than one; this is the display of
      // the one that survived, not a re-decision.
      standard: standards[0] ?? "",
      rows: spec.rows.slice(),
      columns: spec.columns.map((c) => ({
        label: c.label,
        currency: c.currency ?? null,
        cells: c.cells.map((fact) => r.figure(fact)),
      })),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// SHARED HELPERS FOR THE RENDERERS
// ══════════════════════════════════════════════════════════════════════

/** Every figure a resolved artifact will render, flattened. Used by the
 *  card for `<AmountGroup>` (one magnitude across the whole artifact)
 *  and by the export builders. */
export function figuresOf(node: unknown, out: ResolvedFigure[] = []): ResolvedFigure[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) figuresOf(child, out);
    return out;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.present === "boolean" && ("fact" in rec)) {
    out.push(rec as unknown as ResolvedFigure);
    return out;
  }
  for (const v of Object.values(rec)) figuresOf(v, out);
  return out;
}

export function presentValues(figures: readonly ResolvedFigure[]): number[] {
  const out: number[] = [];
  for (const f of figures) if (f.present) out.push(f.value);
  return out;
}

/** Decimal places for a precision token. `auto` defers to `<Amount>`,
 *  which owns the default per unit. */
export function precisionDigits(p: Precision): number | undefined {
  if (p === "whole") return 0;
  if (p === "tenths") return 1;
  if (p === "hundredths") return 2;
  return undefined;
}
