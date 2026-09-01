// THE ENGINE ARTIFACT WIRE — the frontend half of the generation pipeline.
//
// ── WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────
//
// There are two files called `artifactSpec` in this repo and they are
// not duplicates. Read this before adding anything here.
//
//   `frontend/components/cfo/canvas/artifacts/artifactSpec.ts`
//       THE CANVAS SPEC AND ITS PARSE — the rendering lane's schema for
//       what a model may compose on the canvas, with its own L1..L5
//       laws and its own guard over `CapsuleEvidence`. Anything about
//       PARSING a model's spec on the client belongs there.
//
//   this file
//       THE WIRE CONTRACT WITH THE PYTHON PIPELINE — the `as1` spec
//       payload and the `ar1` frames that `engine.api._artifact_spec`
//       and `engine.api._artifact_resolve` actually emit, plus the two
//       things only this side can do: build the value-free FACT INDEX
//       SUMMARY the model is shown, and fold a stream of frames into a
//       view that renders skeleton-first.
//
// A second spec parser here would be a second authority on the same
// question, and the day the two disagree the product ships whichever
// one the caller happened to import. So this file parses nothing. It
// mirrors, it summarises, and it folds.
//
// ── THE THREE LAWS THIS FILE KEEPS ───────────────────────────────────
//
// W1  THE SUMMARY CARRIES NAMES AND SHAPES, NEVER VALUES. What the
//     model is shown before it composes is fact NAMES, units, period
//     ids and labels. Not one figure. A model that has been shown
//     "4,834,908,159" will retype it, and no placeholder discipline
//     downstream can undo that. `buildFactIndexSummary` therefore reads
//     `FactRef.factKey` / `.unit` and never touches `FactRef.value` —
//     and `artifactSpec.test.ts` sweeps its output against every value
//     in the index to prove it.
//
// W2  A VALUE FRAME WITHOUT A FACT AND A PROVENANCE IS REFUSED. The
//     engine attaches both to every cell it emits. A frame arriving
//     without them did not come from the resolver, and rendering it
//     would put an untraceable digit on screen — which is the entire
//     thing this pipeline exists to prevent. `frameViolations` names
//     the defect; `applyArtifactFrame` drops the frame and records it.
//
// W3  THE SKELETON IS THE FIRST FRAME AND CARRIES NO FIGURE. It is the
//     visual equivalent of fact-before-prose: axes, series names and
//     period columns appear immediately, and the values fill in. A
//     cell frame arriving before a skeleton is refused rather than
//     rendered into a shape nobody has seen yet.
//
// ── VOCABULARY DRIFT ─────────────────────────────────────────────────
//
// Every enum below is mirrored from `src/engine/api/_artifact_spec.py`.
// A mirror that drifts silently is worse than no mirror, so
// `ENGINE_VOCABULARY` is a single exported object and its test reads
// the PYTHON SOURCE and compares. Add a kind on one side and the test
// fails on the other.
//
// Pure module: no React, no fetch, no clock, no storage. The same
// frames always fold to the same view.

import type { FactIndex, FactRef } from "./capsuleFactIndex";

// ══════════════════════════════════════════════════════════════════════
// THE MIRRORED VOCABULARY
// ══════════════════════════════════════════════════════════════════════

/** `_artifact_spec.ARTIFACT_SPEC_VERSION` — the spec payload contract. */
export const ARTIFACT_SPEC_VERSION = "as1";

/** `_artifact_resolve.ARTIFACT_VERSION` — the resolved/frame contract. */
export const ARTIFACT_VERSION = "ar1";

export const ARTIFACT_KINDS = [
  "line",
  "bar",
  "table",
  "kpi_grid",
  "delta_table",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const GROUP_BY = ["period", "metric"] as const;
export const SORTS = ["spec", "label"] as const;
export const EMPHASES = ["", "primary", "muted"] as const;
export const DERIVATIONS = ["", "delta", "pct_change", "share"] as const;

/**
 * The ONLY two fields of a spec that hold a number, with their bounds.
 * Mirrored from `_artifact_spec._INT_SLOTS`. Everything else numeric in
 * a spec payload is a value, and a value is not the model's to author.
 */
export const SPEC_INT_SLOTS: Readonly<Record<string, readonly [number, number]>> =
  Object.freeze({
    limit: [0, 50] as const,
    decimals: [0, 4] as const,
  });

/** One object, so the drift test has one thing to compare. */
export const ENGINE_VOCABULARY = Object.freeze({
  specVersion: ARTIFACT_SPEC_VERSION,
  artifactVersion: ARTIFACT_VERSION,
  kinds: ARTIFACT_KINDS,
  groupBy: GROUP_BY,
  sorts: SORTS,
  emphases: EMPHASES,
  derivations: DERIVATIONS,
  intSlots: SPEC_INT_SLOTS,
});

// ══════════════════════════════════════════════════════════════════════
// THE WIRE SHAPES — mirrored field by field from the Python payloads
// ══════════════════════════════════════════════════════════════════════

/** `_artifact_spec.MetricRef.to_payload()`. */
export interface MetricRefPayload {
  metric: string;
  label: string;
  emphasis: string;
}

/** `_artifact_spec.ArtifactSpec.to_payload()`. Reference + presentation
 *  only: there is deliberately no field here that could hold a series. */
export interface ArtifactSpecPayload {
  version: string;
  kind: string;
  metrics: MetricRefPayload[];
  periods: string[];
  group_by: string;
  sort: string;
  derive: string;
  denominator: string;
  title: string;
  subtitle: string;
  note: string;
  x_label: string;
  y_label: string;
  limit: number;
  decimals: number;
}

export interface SeriesHeadPayload {
  series_id: string;
  label: string;
  label_key: string;
  emphasis: string;
  unit: string;
}

export interface SlotHeadPayload {
  slot_id: string;
  label: string;
  currency: string;
}

/** Frame 0. Renderable immediately; carries no figure. */
export interface SkeletonFrame {
  type: "skeleton";
  version: string;
  artifact_id: string;
  kind: string;
  title: string;
  subtitle: string;
  note: string;
  x_label: string;
  y_label: string;
  /** ENGINE-AUTHORED period caption — the one label that carries digits,
   *  which is exactly why the model is refused them in its own prose. */
  caption: string;
  group_by: string;
  derive: string;
  decimals: number;
  series: SeriesHeadPayload[];
  slots: SlotHeadPayload[];
}

export interface CellProvenance {
  period_id?: string;
  period_label?: string;
  entity_id?: string;
  snapshot_id?: string;
  source?: string;
  tier?: string;
  basis?: string;
  from_period_id?: string;
  to_period_id?: string;
  from_snapshot_id?: string;
  to_snapshot_id?: string;
  derived?: string;
}

export interface CellFrame {
  type: "cell";
  artifact_id: string;
  kind: "money" | "ratio";
  series_id: string;
  slot_id: string;
  fact: string;
  unit: string;
  label_key: string;
  scope: string;
  provenance: CellProvenance;
  amount_minor?: number | null;
  value?: number | null;
  currency?: string;
  numerator_minor?: number | null;
  denominator_minor?: number | null;
  operand_currency?: string;
}

export interface GapFrame {
  type: "gap";
  artifact_id: string;
  kind: "gap";
  series_id: string;
  slot_id: string;
  tool: string;
  code: string;
  missing: string[];
  detail: string;
  fix: string;
  upsell_key: string;
}

export interface RefusalFrame {
  type: "refusal";
  artifact_id: string;
  kind: "refusal";
  series_id: string;
  slot_id: string;
  code: string;
  detail: string;
  alternative: string;
}

export interface CompleteFrame {
  type: "complete";
  version: string;
  artifact_id: string;
  cells: number;
  gaps: number;
  refusals: number;
  currency: string | null;
  facts: Record<string, number>;
  fact_units: Record<string, string>;
  notes: string[];
}

export type ArtifactFrame =
  | SkeletonFrame
  | CellFrame
  | GapFrame
  | RefusalFrame
  | CompleteFrame;

// ══════════════════════════════════════════════════════════════════════
// W1 — THE FACT INDEX SUMMARY: names and shapes, never values
// ══════════════════════════════════════════════════════════════════════

/** One fact, as the model is allowed to see it. No `value` field exists
 *  on this type — a summary that could carry a figure is a summary that
 *  eventually will. */
export interface FactSummaryEntry {
  factKey: string;
  unit: string;
  /** Money only. The CODE, never an amount — the model needs to know a
   *  figure is denominated, not what it is. */
  currency?: string;
  labelKey?: string;
  /** How many periods carry this fact. A COUNT of availability, not a
   *  reading of any of them. */
  periods: number;
  engineDeclared: boolean;
}

export interface PeriodSummaryEntry {
  periodId: string;
  /** ENGINE-AUTHORED. Digits here are a fact about the book, not a
   *  figure the model may retype into a title. */
  periodLabel: string;
  currency: string;
  entity: string;
  factCount: number;
  needsReview: boolean;
  isActive: boolean;
}

export interface FactIndexSummary {
  version: string;
  activePeriodId: string | null;
  facts: FactSummaryEntry[];
  periods: PeriodSummaryEntry[];
  kinds: readonly string[];
  derivations: readonly string[];
  groupBy: readonly string[];
  rule: string;
}

const SUMMARY_RULE =
  "Name ids only. Every figure is resolved by the engine from the served " +
  "statements; a digit anywhere in your answer is rejected.";

/**
 * Build the model's input from the local fact index.
 *
 * Reads `factKey`, `unit`, `currency`, `labelKey` and `engineDeclared`.
 * IT NEVER READS `FactRef.value`. That is the whole contract, and the
 * reason the sweep in the test can be exact rather than heuristic: it
 * asserts that no value present in the index appears anywhere in the
 * summary's serialized bytes.
 *
 * Facts are deduplicated by `factKey` and carry a period COUNT instead
 * of per-period entries, so the shape the model sees is "this concept
 * exists, on this many periods, in this unit".
 */
export function buildFactIndexSummary(index: FactIndex | null | undefined): FactIndexSummary {
  const facts: FactSummaryEntry[] = [];
  const byKey = new Map<string, FactSummaryEntry>();

  const refs: readonly FactRef[] = index?.facts ?? [];
  for (const ref of refs) {
    if (!ref || !ref.factKey) continue;
    const existing = byKey.get(ref.factKey);
    if (existing) {
      existing.periods += 1;
      continue;
    }
    const entry: FactSummaryEntry = {
      factKey: ref.factKey,
      unit: ref.unit,
      labelKey: ref.labelKey,
      periods: 1,
      engineDeclared: Boolean(ref.engineDeclared),
    };
    if (ref.currency) entry.currency = ref.currency;
    byKey.set(ref.factKey, entry);
    facts.push(entry);
  }
  facts.sort((a, b) => (a.factKey < b.factKey ? -1 : a.factKey > b.factKey ? 1 : 0));

  const periods: PeriodSummaryEntry[] = (index?.periods ?? []).map((p) => ({
    periodId: p.periodId,
    periodLabel: p.periodLabel,
    currency: p.currency,
    entity: p.entity,
    factCount: p.factCount,
    needsReview: Boolean(p.needsReview),
    isActive: p.periodId === (index?.activePeriodId ?? null),
  }));

  return {
    version: ARTIFACT_SPEC_VERSION,
    activePeriodId: index?.activePeriodId ?? null,
    facts,
    periods,
    kinds: ARTIFACT_KINDS,
    derivations: DERIVATIONS,
    groupBy: GROUP_BY,
    rule: SUMMARY_RULE,
  };
}

// ══════════════════════════════════════════════════════════════════════
// W2/W3 — FOLDING THE STREAM
// ══════════════════════════════════════════════════════════════════════

export interface FrameViolation {
  code: string;
  detail: string;
  frameType: string;
}

/** `series_id|slot_id` — the coordinate a cell, a gap or a refusal
 *  occupies. Exported because the renderer keys off the same string. */
export function cellKey(seriesId: string, slotId: string): string {
  return `${seriesId ?? ""}|${slotId ?? ""}`;
}

const NUMERIC_CELL_FIELDS = [
  "amount_minor",
  "value",
  "numerator_minor",
  "denominator_minor",
] as const;

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * W2/W3 — everything wrong with one frame, or an empty list.
 *
 * A predicate, not a thrower: a malformed frame must not take the whole
 * artifact down, and the surface needs the reason to show rather than a
 * stack trace. `applyArtifactFrame` drops what this refuses.
 */
export function frameViolations(frame: unknown): FrameViolation[] {
  const out: FrameViolation[] = [];
  if (!frame || typeof frame !== "object") {
    return [{ code: "not_a_frame", detail: "frame is not an object", frameType: "" }];
  }
  const f = frame as Record<string, unknown>;
  const type = typeof f.type === "string" ? f.type : "";

  if (type === "skeleton") {
    // W3 — frame 0 is a shape, not a reading.
    for (const key of ["value", "amount_minor", "numerator_minor", "denominator_minor"]) {
      if (key in f) {
        out.push({
          code: "figure_in_skeleton",
          detail: `the skeleton carries ${key}; frame 0 is axes and labels only`,
          frameType: type,
        });
      }
    }
    if (!Array.isArray(f.series) || (f.series as unknown[]).length === 0) {
      out.push({
        code: "empty_skeleton",
        detail: "a skeleton with no series has no shape to show",
        frameType: type,
      });
    }
    return out;
  }

  if (type === "cell") {
    // W2 — a digit with no fact and no provenance did not come from the
    // resolver, and there is nowhere honest to put it.
    if (typeof f.fact !== "string" || !f.fact) {
      out.push({
        code: "value_without_fact",
        detail: "a resolved figure must name the fact it resolved",
        frameType: type,
      });
    }
    const prov = f.provenance as Record<string, unknown> | undefined;
    const hasPeriod =
      !!prov && (typeof prov.period_id === "string" || typeof prov.to_period_id === "string");
    const hasSnapshot =
      !!prov && (typeof prov.snapshot_id === "string" || typeof prov.to_snapshot_id === "string");
    if (!hasPeriod || !hasSnapshot) {
      out.push({
        code: "value_without_provenance",
        detail: "a resolved figure must name its period and its snapshot",
        frameType: type,
      });
    }
    const anyNumber = NUMERIC_CELL_FIELDS.some((k) => isNumber(f[k]));
    if (!anyNumber) {
      out.push({
        code: "cell_without_a_figure",
        detail: "a cell frame that resolved nothing is a gap, not a cell",
        frameType: type,
      });
    }
    if (f.kind === "money" && typeof f.currency !== "string") {
      out.push({
        code: "money_without_currency",
        detail: "a money figure and its currency are inseparable",
        frameType: type,
      });
    }
    if (f.kind === "ratio" && "amount_minor" in f) {
      out.push({
        code: "ratio_as_money",
        detail: "a dimensionless figure must never reach a currency formatter",
        frameType: type,
      });
    }
    return out;
  }

  if (type === "gap" || type === "refusal") {
    // A refusal that carries a number is a partial answer, and a partial
    // answer here is indistinguishable from a wrong one.
    for (const [key, value] of Object.entries(f)) {
      if (isNumber(value)) {
        out.push({
          code: "figure_in_refusal",
          detail: `${type} carries a number at ${key}`,
          frameType: type,
        });
      }
    }
    if (typeof f.code !== "string" || !f.code) {
      out.push({
        code: "unnamed_refusal",
        detail: `a ${type} must name what is missing`,
        frameType: type,
      });
    }
    return out;
  }

  if (type === "complete") return out;

  return [
    { code: "unknown_frame_type", detail: `frame type ${type || "(none)"}`, frameType: type },
  ];
}

export interface ArtifactView {
  artifactId: string;
  /** Null until frame 0 arrives. The renderer shows nothing before it —
   *  there is no shape to put values into yet. */
  skeleton: SkeletonFrame | null;
  cells: Map<string, CellFrame>;
  gaps: Map<string, GapFrame>;
  refusals: RefusalFrame[];
  complete: CompleteFrame | null;
  /** Frames that were REFUSED, with the reason. Kept rather than
   *  discarded: a silently dropped frame looks exactly like a cell that
   *  never resolved, and the two need different fixes. */
  rejected: Array<{ frame: unknown; violations: FrameViolation[] }>;
}

export function createArtifactView(artifactId = ""): ArtifactView {
  return {
    artifactId,
    skeleton: null,
    cells: new Map(),
    gaps: new Map(),
    refusals: [],
    complete: null,
    rejected: [],
  };
}

/**
 * Fold one frame into the view. Returns a NEW view — the caller holds it
 * in state, and a mutated-in-place view would not re-render.
 *
 * W3 is enforced here: a cell, gap or refusal arriving before the
 * skeleton is REJECTED, because there is no shape to place it in and
 * placing it anyway is how a value ends up rendered without its axis.
 */
export function applyArtifactFrame(view: ArtifactView, frame: unknown): ArtifactView {
  const violations = frameViolations(frame);
  const f = (frame ?? {}) as Record<string, unknown>;
  const type = typeof f.type === "string" ? f.type : "";

  if (type !== "skeleton" && type !== "complete" && !view.skeleton) {
    violations.push({
      code: "value_before_skeleton",
      detail: "a value arrived before the shape that gives it an axis",
      frameType: type,
    });
  }

  if (violations.length) {
    return {
      ...view,
      cells: new Map(view.cells),
      gaps: new Map(view.gaps),
      rejected: [...view.rejected, { frame, violations }],
    };
  }

  const next: ArtifactView = {
    ...view,
    cells: new Map(view.cells),
    gaps: new Map(view.gaps),
    refusals: [...view.refusals],
    rejected: [...view.rejected],
  };

  if (type === "skeleton") {
    const skeleton = frame as SkeletonFrame;
    next.skeleton = skeleton;
    next.artifactId = skeleton.artifact_id || view.artifactId;
    return next;
  }
  if (type === "cell") {
    const cell = frame as CellFrame;
    next.cells.set(cellKey(cell.series_id, cell.slot_id), cell);
    return next;
  }
  if (type === "gap") {
    const gap = frame as GapFrame;
    next.gaps.set(cellKey(gap.series_id, gap.slot_id), gap);
    return next;
  }
  if (type === "refusal") {
    next.refusals.push(frame as RefusalFrame);
    return next;
  }
  next.complete = frame as CompleteFrame;
  return next;
}

export function foldArtifactFrames(
  frames: readonly unknown[],
  artifactId = "",
): ArtifactView {
  let view = createArtifactView(artifactId);
  for (const frame of frames) view = applyArtifactFrame(view, frame);
  return view;
}

/**
 * What the renderer draws at one coordinate: a resolved cell, an honest
 * gap, or nothing yet.
 *
 * "Nothing yet" is a real third state and must stay distinguishable from
 * a gap. A skeleton whose values have not arrived is a loading cell; a
 * gap is a permanent absence with a fix attached. Collapsing them would
 * make every slow network look like missing data.
 */
export type SlotState =
  | { state: "resolved"; cell: CellFrame }
  | { state: "gap"; gap: GapFrame }
  | { state: "refused"; refusal: RefusalFrame }
  | { state: "pending" };

/** Does a refusal filed at (series, slot) cover this coordinate? An
 *  empty half means "every one" — the engine files a whole-artifact
 *  refusal as `("", "")` and a whole-slot one as `("", slot)`. */
function covers(refusalId: string, coordinateId: string): boolean {
  return refusalId === "" || refusalId === coordinateId;
}

export function slotState(view: ArtifactView, seriesId: string, slotId: string): SlotState {
  const key = cellKey(seriesId, slotId);
  const cell = view.cells.get(key);
  if (cell) return { state: "resolved", cell };
  const gap = view.gaps.get(key);
  if (gap) return { state: "gap", gap };
  const wholeSlot = view.gaps.get(cellKey("", slotId));
  if (wholeSlot) return { state: "gap", gap: wholeSlot };
  const wholeSeries = view.gaps.get(cellKey(seriesId, ""));
  if (wholeSeries) return { state: "gap", gap: wholeSeries };
  for (const refusal of view.refusals) {
    if (covers(refusal.series_id, seriesId) && covers(refusal.slot_id, slotId)) {
      return { state: "refused", refusal };
    }
  }
  return { state: "pending" };
}

/**
 * True once every coordinate the skeleton declares has an answer — a
 * value, a stated absence, or a stated refusal. Drives the "still
 * filling" affordance.
 *
 * A FIRST DRAFT RETURNED TRUE AS SOON AS ANY REFUSAL EXISTED. That is
 * right for an artifact refused whole and wrong for one where a single
 * series was refused while the rest were still streaming: the reader
 * would be told the artifact had finished with half its bars missing.
 * So a refusal settles only the coordinates it actually covers.
 *
 * Distinct from `view.complete`, which is the STREAM's own end marker.
 * A stream can end while a renderer still has coordinates to fill in
 * (that is a defect, and keeping the two signals separate is how it
 * stays visible).
 */
export function isSettled(view: ArtifactView): boolean {
  if (!view.skeleton) return false;
  for (const series of view.skeleton.series) {
    for (const slot of view.skeleton.slots) {
      if (slotState(view, series.series_id, slot.slot_id).state === "pending") {
        return false;
      }
    }
  }
  return true;
}
