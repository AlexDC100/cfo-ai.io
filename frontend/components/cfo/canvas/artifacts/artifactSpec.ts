// THE ARTIFACTS — THE SPEC, AND THE PARSE THAT REFUSES A MODEL DIGIT.
//
// Part B of the generative workspace. The law is the same one the prose
// lane already enforces, moved one level up:
//
//     THE MODEL COMPOSES AND EXPLAINS; THE ENGINE COMPUTES.
//
// An artifact spec is the model's COMPOSITION — which shape, which
// facts, in which order, under which heading. It is not the data. Every
// figure that will ever appear inside the rendered artifact is named
// here by its FACT NAME and resolved from `CapsuleEvidence` (the facts
// gateway payload) at render time, through `<Amount>`.
//
// ── Why a chart label is not an exception ─────────────────────────────
//
// The tempting carve-out is "an axis tick is just a label". It is not.
// A chart is read as a measurement; a tick the model typed is a
// measurement with no source cell, no snapshot, no currency and no way
// to be wrong out loud. The 461 defect was exactly this shape one layer
// down — a correct ratio rendered beside a figure that had slipped the
// conversion boundary — and it survived review because the number
// looked plausible. So the rule here has no exceptions and is enforced
// mechanically rather than by prompt:
//
//   L1  NO NUMBER TYPE ANYWHERE. `typeof x === "number"` in a spec tree
//       is a violation, full stop. There is no field in this schema
//       that accepts a number, so a spec carrying one was not authored
//       against this schema.
//   L2  EVERY FIGURE IS A REFERENCE. A data position holds a FACT NAME
//       (a string) that must exist in `evidence.facts` AND carry a unit
//       in `evidence.factUnits`. Absent → refuse. Undeclared unit →
//       refuse. Never assume money.
//   L3  FREE TEXT OBEYS THE PROSE LAW. Titles, captions, series labels
//       and row labels are run through `guardAnswer` — the SAME parser
//       the answer lane uses. A digit in a title is legal only when the
//       evidence itself supplied that string (a period label, an
//       account code, a ticker) or when it sits inside a resolved
//       `{{money:fact}}` placeholder.
//   L4  ONE UNIT PER SERIES, ONE CURRENCY PER ARTIFACT. A series mixing
//       money with a ratio, or RON with EUR, is refused rather than
//       rendered with two rulers.
//   L5  NO CROSS-STANDARD BLENDING. A comparison whose columns declare
//       different accounting standards is refused — the same law
//       `benchmarkGroups.computeBenchmarkStats` throws on, applied to
//       an artifact instead of a percentile.
//
// ── Structural tokens carry no digits, on purpose ────────────────────
//
// Every enum in this file is digit-free ("hundredths", not "d2"). That
// is not cosmetic: it makes L1+L3 a clean residual-digit test with an
// EMPTY structural allowlist. The only digit-bearing strings a valid
// spec can contain are fact names in reference positions and literals
// the evidence itself supplied. Add a token like "top10" here and the
// gate's mask acquires an exception, which is how exceptions start.
//
// Pure module: no React, no i18n, no fetch, no clock. Same spec + same
// evidence always produces the same verdict.

import {
  guardAnswer,
  type GuardViolation,
  type GuardInput,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerGuard";
import {
  asUnit,
  type CapsuleEvidence,
  type CapsuleUnit,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

// ── CROSS-LANE: there are TWO artifact spec contracts in this repo ────
//
// `frontend/lib/artifactSpec.ts` (the pipeline lane) is the WIRE
// contract with `src/engine/api/_artifact_spec.py`: its kinds are
// `line | bar | table | kpi_grid | delta_table` and its version token
// is `"as1"`. THIS file is the CANVAS contract: its kinds are the eight
// below and its payloads are a different shape entirely. That lane's
// header already names this file as the canvas authority, so the
// boundary is agreed from both sides.
//
// What was NOT agreed, and is fixed here: both modules export a symbol
// called `ARTIFACT_SPEC_VERSION`, and both originally carried the value
// `"as1"`. Two different payloads stamped with the same token means a
// spec built for one parser can be handed to the other and get a long
// way in before anything complains — the failure would surface as a
// pile of `shape` violations rather than as "this is not my contract".
//
// So the canvas token is DISTINCT. A wire-lane payload now fails this
// guard on its first check, by name (`bad_version`), which is the
// difference between failing closed and failing confusingly.
// `check_artifact_law.mjs` additionally refuses any import of
// `@/lib/artifactSpec` from inside this lane, so the two vocabularies
// cannot meet in one file and quietly resolve to the wrong one.

/** Contract version the model must stamp. A spec without it is refused
 *  rather than assumed current — a silently upgraded spec is a spec
 *  nobody validated. */
export const ARTIFACT_SPEC_VERSION = "canvas-as1";

// ══════════════════════════════════════════════════════════════════════
// THE EIGHT
// ══════════════════════════════════════════════════════════════════════

export const ARTIFACT_KINDS = [
  "chart",
  "table",
  "spreadsheet",
  "slide",
  "document",
  "scenario",
  "comparison",
  "finding",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const CHART_FORMS = ["bar", "line", "stacked", "waterfall", "donut"] as const;
export type ChartForm = (typeof CHART_FORMS)[number];

/** Column semantics. `delta` gets the signed treatment; `label` is the
 *  row's own name and never holds a fact. */
export const COLUMN_ROLES = ["label", "value", "delta", "share"] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

/** Digit-free precision vocabulary (see the header note). */
export const PRECISIONS = ["auto", "whole", "tenths", "hundredths"] as const;
export type Precision = (typeof PRECISIONS)[number];

/** How wide a driver may be pushed. Code owns the actual span; the model
 *  only says how far it thinks the question reaches. */
export const DRIVER_SPANS = ["tight", "normal", "wide"] as const;
export type DriverSpan = (typeof DRIVER_SPANS)[number];

/** What a comparison is comparing. Declared, never inferred — the
 *  grouping law needs to know which axis it is policing. */
export const COMPARISON_BASES = ["period", "peer", "budget", "scenario"] as const;
export type ComparisonBasis = (typeof COMPARISON_BASES)[number];

/** Emphasis is a rendering hint, never a claim about direction being
 *  good. A fall in expenses and a fall in revenue share a sign. */
export const EMPHASES = ["none", "last", "negative", "total"] as const;
export type Emphasis = (typeof EMPHASES)[number];

// ══════════════════════════════════════════════════════════════════════
// THE SPEC SHAPES
// ══════════════════════════════════════════════════════════════════════

export interface ArtifactSpecBase {
  version: string;
  kind: ArtifactKind;
  /** Free text — obeys L3. */
  title: string;
  /** Optional prose, placeholders allowed — obeys L3. */
  caption?: string;
}

export interface ChartSeriesSpec {
  label: string;
  /** ORDERED fact names. Reference positions — obey L2. */
  points: string[];
  /** Point labels, one per point. Free text — obeys L3. Length must
   *  match `points`, or the series is refused: a chart whose ticks and
   *  bars are off by one is worse than no chart. */
  pointLabels?: string[];
}

export interface ChartSpec extends ArtifactSpecBase {
  kind: "chart";
  form: ChartForm;
  series: ChartSeriesSpec[];
  /** Waterfall only. The engine's own closing total, for the
   *  cross-check in `artifactResolve` — never used to DRAW, only to
   *  disagree loudly when the deltas do not add up to it. */
  total?: string;
  axisLabel?: string;
  emphasis?: Emphasis;
  precision?: Precision;
}

export interface TableColumnSpec {
  label: string;
  role: ColumnRole;
}

export interface TableRowSpec {
  label: string;
  /** One entry per non-label column. `null` is a TYPED ABSENCE — it
   *  renders as the missing-data glyph, never as zero. */
  cells: Array<string | null>;
  /** Account codes behind the row. Must appear in the evidence's
   *  literals; a code the evidence never mentioned is fabricated
   *  provenance, which is worse than none. */
  accounts?: string[];
  children?: TableRowSpec[];
}

export interface TableSpec extends ArtifactSpecBase {
  kind: "table";
  columns: TableColumnSpec[];
  rows: TableRowSpec[];
  /** Rendered under the ledger double-hairline. */
  totalRow?: TableRowSpec;
  precision?: Precision;
}

export interface SpreadsheetSheetSpec {
  name: string;
  columns: TableColumnSpec[];
  rows: TableRowSpec[];
  totalRow?: TableRowSpec;
  /** When set, the total row is written as a live SUM formula over the
   *  rows above instead of a static value. The engine decides whether
   *  it can express it; this only asks. */
  liveTotals?: boolean;
}

export interface SpreadsheetSpec extends ArtifactSpecBase {
  kind: "spreadsheet";
  sheets: SpreadsheetSheetSpec[];
}

export interface SlideBlockSpec {
  /** `headline` is one line; `metrics` is a KPI strip; `bullets` is
   *  prose; `table` embeds a table spec's body. */
  block: "headline" | "metrics" | "bullets" | "table";
  /** headline/bullets: free text (L3). */
  lines?: string[];
  /** metrics: fact names (L2). */
  facts?: string[];
  /** metrics: one label per fact (L3). */
  factLabels?: string[];
  /** table: columns + rows, same law as TableSpec. */
  columns?: TableColumnSpec[];
  rows?: TableRowSpec[];
}

export interface SlideSpec extends ArtifactSpecBase {
  kind: "slide";
  slides: Array<{ heading: string; blocks: SlideBlockSpec[] }>;
}

export interface DocumentSectionSpec {
  heading: string;
  /** Paragraph templates — placeholders resolved by NarrativeText. */
  paragraphs: string[];
}

export interface DocumentSpec extends ArtifactSpecBase {
  kind: "document";
  sections: DocumentSectionSpec[];
}

export interface ScenarioDriverSpec {
  /** Registry id from `artifactScenario.DRIVERS` — never a formula. */
  driver: string;
  label: string;
  span?: DriverSpan;
}

export interface ScenarioSpec extends ArtifactSpecBase {
  kind: "scenario";
  drivers: ScenarioDriverSpec[];
  /** Registry ids of the outputs to recompute. */
  outputs: string[];
}

export interface ComparisonColumnSpec {
  label: string;
  /** Accounting standard as `benchmarkGroups` spells it. Declared per
   *  column so L5 is checkable without a lookup. */
  standard: string;
  /** Currency of this column's money facts. */
  currency?: string;
  /** One fact name per row, aligned with `rows`. */
  cells: Array<string | null>;
}

export interface ComparisonSpec extends ArtifactSpecBase {
  kind: "comparison";
  basis: ComparisonBasis;
  /** Row labels — free text (L3). */
  rows: string[];
  columns: ComparisonColumnSpec[];
}

export interface FindingSpec extends ArtifactSpecBase {
  kind: "finding";
  /** The finding's own key, as the engine emitted it. */
  findingKey: string;
  /** Facts the card re-states, in the engine's own order. */
  facts: string[];
  factLabels?: string[];
  /** Metric to recompute with the finding's subject removed. Registry
   *  id, never a formula. */
  recomputeMetric?: string;
  /** The fact holding the amount to remove. */
  recomputeExclude?: string;
}

export type ArtifactSpec =
  | ChartSpec
  | TableSpec
  | SpreadsheetSpec
  | SlideSpec
  | DocumentSpec
  | ScenarioSpec
  | ComparisonSpec
  | FindingSpec;

// ══════════════════════════════════════════════════════════════════════
// THE GUARD
// ══════════════════════════════════════════════════════════════════════

export type SpecViolationKind =
  | GuardViolation["kind"]
  | "number_literal"
  | "unknown_kind"
  | "bad_version"
  | "shape"
  | "unit_mixed"
  | "currency_mixed"
  | "cross_standard"
  | "unknown_account"
  | "length_mismatch";

export interface SpecViolation {
  kind: SpecViolationKind;
  /** Dotted path into the spec, so a regeneration can be told WHERE. */
  path: string;
  sample: string;
}

export interface SpecGuardResult {
  ok: boolean;
  violations: SpecViolation[];
  /** Fact names the spec actually references, first-appearance order. */
  citedFacts: string[];
  /** How many positions the walk examined. A spec that produced ZERO
   *  examined positions is not a clean spec — it is an empty walk, and
   *  the gate reads this rather than trusting `ok` (TC-9). */
  examined: number;
}

interface WalkState {
  input: GuardInput;
  evidence: CapsuleEvidence;
  violations: SpecViolation[];
  citedFacts: string[];
  examined: number;
}

function push(st: WalkState, kind: SpecViolationKind, path: string, sample: string): void {
  st.violations.push({ kind, path, sample });
}

/** L1 — a number anywhere in the tree. Runs over the RAW parsed object
 *  before any shape narrowing, so a number hiding in a field this build
 *  does not know about is still caught. */
function scanForNumbers(node: unknown, path: string, st: WalkState): void {
  st.examined += 1;
  if (typeof node === "number") {
    push(st, "number_literal", path, String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => scanForNumbers(child, `${path}[${i}]`, st));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      scanForNumbers(v, path ? `${path}.${k}` : k, st);
    }
  }
}

/** L3 — free text goes through the SAME parser the prose lane uses. */
function checkText(value: unknown, path: string, st: WalkState, required: boolean): void {
  st.examined += 1;
  if (value === undefined || value === null) {
    if (required) push(st, "shape", path, "missing");
    return;
  }
  if (typeof value !== "string") {
    push(st, "shape", path, typeof value);
    return;
  }
  if (!value.trim()) {
    if (required) push(st, "empty", path, "");
    return;
  }
  const r = guardAnswer(value, st.input);
  for (const v of r.violations) {
    push(st, v.kind, path, v.sample);
  }
  for (const f of r.citedFacts) {
    if (!st.citedFacts.includes(f)) st.citedFacts.push(f);
  }
}

/** L2 — a reference position. Returns the declared unit, or null when
 *  the reference was refused. */
function checkFactRef(
  value: unknown,
  path: string,
  st: WalkState,
  allowNull: boolean,
): CapsuleUnit | null {
  st.examined += 1;
  if (value === null || value === undefined) {
    if (!allowNull) push(st, "shape", path, "missing");
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    push(st, "shape", path, String(value));
    return null;
  }
  const known = Object.prototype.hasOwnProperty.call(st.input.facts, value);
  const unit = asUnit(st.input.factUnits[value]);
  if (!known || unit === null) {
    push(st, "unknown_fact", path, value);
    return null;
  }
  if (!st.citedFacts.includes(value)) st.citedFacts.push(value);
  return unit;
}

/** L4 — one unit across a set of references. */
function requireOneUnit(units: Array<CapsuleUnit | null>, path: string, st: WalkState): void {
  const present = units.filter((u): u is CapsuleUnit => u !== null);
  const distinct = Array.from(new Set(present));
  if (distinct.length > 1) {
    push(st, "unit_mixed", path, distinct.join("+"));
  }
}

/** L4 — one currency across the money references of one artifact. */
function requireOneCurrency(facts: readonly string[], st: WalkState, path: string): void {
  const currencies = new Set<string>();
  for (const f of facts) {
    const meta = st.evidence.factMeta[f];
    if (meta && meta.unit === "money" && meta.currency) currencies.add(meta.currency);
  }
  if (currencies.size > 1) {
    push(st, "currency_mixed", path, Array.from(currencies).sort().join("+"));
  }
}

/** Provenance may not be invented: an account code the evidence never
 *  mentioned is a citation with nothing behind it. */
function checkAccounts(value: unknown, path: string, st: WalkState): void {
  if (value === undefined) return;
  st.examined += 1;
  if (!Array.isArray(value)) {
    push(st, "shape", path, typeof value);
    return;
  }
  const literals = st.input.literals;
  value.forEach((code, i) => {
    st.examined += 1;
    if (typeof code !== "string") {
      push(st, "shape", `${path}[${i}]`, typeof code);
      return;
    }
    if (!literals.includes(code)) {
      push(st, "unknown_account", `${path}[${i}]`, code);
    }
  });
}

function checkEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  st: WalkState,
  required: boolean,
): T | null {
  st.examined += 1;
  if (value === undefined || value === null) {
    if (required) push(st, "shape", path, "missing");
    return null;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    push(st, "shape", path, String(value));
    return null;
  }
  return value as T;
}

function checkColumns(cols: unknown, path: string, st: WalkState): number {
  st.examined += 1;
  if (!Array.isArray(cols) || cols.length === 0) {
    push(st, "shape", path, "columns must be a non-empty array");
    return 0;
  }
  let valueCols = 0;
  cols.forEach((c, i) => {
    const col = c as Partial<TableColumnSpec>;
    checkText(col?.label, `${path}[${i}].label`, st, true);
    const role = checkEnum(col?.role, COLUMN_ROLES, `${path}[${i}].role`, st, true);
    if (role && role !== "label") valueCols += 1;
  });
  return valueCols;
}

function checkRows(
  rows: unknown,
  path: string,
  st: WalkState,
  valueCols: number,
  units: Array<CapsuleUnit | null>,
  depth: number,
): void {
  st.examined += 1;
  if (!Array.isArray(rows)) {
    push(st, "shape", path, "rows must be an array");
    return;
  }
  if (depth > 4) {
    push(st, "shape", path, "nesting deeper than four levels");
    return;
  }
  rows.forEach((r, i) => {
    const row = r as Partial<TableRowSpec>;
    const rowPath = `${path}[${i}]`;
    checkText(row?.label, `${rowPath}.label`, st, true);
    st.examined += 1;
    if (!Array.isArray(row?.cells)) {
      push(st, "shape", `${rowPath}.cells`, "cells must be an array");
    } else {
      if (valueCols > 0 && row.cells.length !== valueCols) {
        push(
          st,
          "length_mismatch",
          `${rowPath}.cells`,
          `${row.cells.length} cell(s) for ${valueCols} value column(s)`,
        );
      }
      row.cells.forEach((cell, ci) => {
        units.push(checkFactRef(cell, `${rowPath}.cells[${ci}]`, st, true));
      });
    }
    checkAccounts(row?.accounts, `${rowPath}.accounts`, st);
    if (row?.children !== undefined) {
      checkRows(row.children, `${rowPath}.children`, st, valueCols, units, depth + 1);
    }
  });
}

// ── per-kind walks ─────────────────────────────────────────────────────

function walkChart(spec: ChartSpec, st: WalkState): void {
  checkEnum(spec.form, CHART_FORMS, "form", st, true);
  checkEnum(spec.emphasis, EMPHASES, "emphasis", st, false);
  checkEnum(spec.precision, PRECISIONS, "precision", st, false);
  checkText(spec.axisLabel, "axisLabel", st, false);
  st.examined += 1;
  if (!Array.isArray(spec.series) || spec.series.length === 0) {
    push(st, "shape", "series", "series must be a non-empty array");
    return;
  }
  const allUnits: Array<CapsuleUnit | null> = [];
  spec.series.forEach((s, i) => {
    const p = `series[${i}]`;
    checkText(s?.label, `${p}.label`, st, true);
    st.examined += 1;
    if (!Array.isArray(s?.points) || s.points.length === 0) {
      push(st, "shape", `${p}.points`, "points must be a non-empty array");
      return;
    }
    const seriesUnits = s.points.map((pt, j) =>
      checkFactRef(pt, `${p}.points[${j}]`, st, false),
    );
    requireOneUnit(seriesUnits, `${p}.points`, st);
    allUnits.push(...seriesUnits);
    if (s.pointLabels !== undefined) {
      st.examined += 1;
      if (!Array.isArray(s.pointLabels)) {
        push(st, "shape", `${p}.pointLabels`, typeof s.pointLabels);
      } else {
        if (s.pointLabels.length !== s.points.length) {
          push(
            st,
            "length_mismatch",
            `${p}.pointLabels`,
            `${s.pointLabels.length} label(s) for ${s.points.length} point(s)`,
          );
        }
        s.pointLabels.forEach((l, j) => checkText(l, `${p}.pointLabels[${j}]`, st, true));
      }
    }
  });
  // A stacked or donut chart puts its series in ONE plane; mixed units
  // there are two rulers on one axis.
  if (spec.form === "stacked" || spec.form === "donut" || spec.form === "waterfall") {
    requireOneUnit(allUnits, "series", st);
  }
  if (spec.total !== undefined) {
    const tu = checkFactRef(spec.total, "total", st, false);
    requireOneUnit([...allUnits, tu], "total", st);
  }
}

function walkTable(spec: TableSpec, st: WalkState): void {
  checkEnum(spec.precision, PRECISIONS, "precision", st, false);
  const valueCols = checkColumns(spec.columns, "columns", st);
  const units: Array<CapsuleUnit | null> = [];
  checkRows(spec.rows, "rows", st, valueCols, units, 0);
  if (spec.totalRow !== undefined) {
    checkRows([spec.totalRow], "totalRow", st, valueCols, units, 0);
  }
  // Columns are the unit boundary in a table — a column may be money
  // while its neighbour is a percent. Nothing to assert across them.
}

function walkSpreadsheet(spec: SpreadsheetSpec, st: WalkState): void {
  st.examined += 1;
  if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
    push(st, "shape", "sheets", "sheets must be a non-empty array");
    return;
  }
  spec.sheets.forEach((sheet, i) => {
    const p = `sheets[${i}]`;
    checkText(sheet?.name, `${p}.name`, st, true);
    const valueCols = checkColumns(sheet?.columns, `${p}.columns`, st);
    const units: Array<CapsuleUnit | null> = [];
    checkRows(sheet?.rows, `${p}.rows`, st, valueCols, units, 0);
    if (sheet?.totalRow !== undefined) {
      checkRows([sheet.totalRow], `${p}.totalRow`, st, valueCols, units, 0);
    }
    st.examined += 1;
    if (sheet?.liveTotals !== undefined && typeof sheet.liveTotals !== "boolean") {
      push(st, "shape", `${p}.liveTotals`, typeof sheet.liveTotals);
    }
  });
}

function walkSlide(spec: SlideSpec, st: WalkState): void {
  st.examined += 1;
  if (!Array.isArray(spec.slides) || spec.slides.length === 0) {
    push(st, "shape", "slides", "slides must be a non-empty array");
    return;
  }
  spec.slides.forEach((slide, i) => {
    const sp = `slides[${i}]`;
    checkText(slide?.heading, `${sp}.heading`, st, true);
    st.examined += 1;
    if (!Array.isArray(slide?.blocks) || slide.blocks.length === 0) {
      push(st, "shape", `${sp}.blocks`, "blocks must be a non-empty array");
      return;
    }
    slide.blocks.forEach((b, j) => {
      const bp = `${sp}.blocks[${j}]`;
      const block = checkEnum(
        b?.block,
        ["headline", "metrics", "bullets", "table"] as const,
        `${bp}.block`,
        st,
        true,
      );
      if (block === "headline" || block === "bullets") {
        st.examined += 1;
        if (!Array.isArray(b?.lines) || b.lines.length === 0) {
          push(st, "shape", `${bp}.lines`, "lines must be a non-empty array");
        } else {
          b.lines.forEach((l, k) => checkText(l, `${bp}.lines[${k}]`, st, true));
        }
      } else if (block === "metrics") {
        st.examined += 1;
        if (!Array.isArray(b?.facts) || b.facts.length === 0) {
          push(st, "shape", `${bp}.facts`, "facts must be a non-empty array");
        } else {
          b.facts.forEach((f, k) => checkFactRef(f, `${bp}.facts[${k}]`, st, false));
          if (b.factLabels !== undefined) {
            st.examined += 1;
            if (!Array.isArray(b.factLabels) || b.factLabels.length !== b.facts.length) {
              push(
                st,
                "length_mismatch",
                `${bp}.factLabels`,
                `${Array.isArray(b.factLabels) ? b.factLabels.length : "non-array"} label(s) for ${b.facts.length} fact(s)`,
              );
            } else {
              b.factLabels.forEach((l, k) => checkText(l, `${bp}.factLabels[${k}]`, st, true));
            }
          }
        }
      } else if (block === "table") {
        const valueCols = checkColumns(b?.columns, `${bp}.columns`, st);
        const units: Array<CapsuleUnit | null> = [];
        checkRows(b?.rows, `${bp}.rows`, st, valueCols, units, 0);
      }
    });
  });
}

function walkDocument(spec: DocumentSpec, st: WalkState): void {
  st.examined += 1;
  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    push(st, "shape", "sections", "sections must be a non-empty array");
    return;
  }
  spec.sections.forEach((s, i) => {
    const p = `sections[${i}]`;
    checkText(s?.heading, `${p}.heading`, st, true);
    st.examined += 1;
    if (!Array.isArray(s?.paragraphs) || s.paragraphs.length === 0) {
      push(st, "shape", `${p}.paragraphs`, "paragraphs must be a non-empty array");
      return;
    }
    s.paragraphs.forEach((para, j) => checkText(para, `${p}.paragraphs[${j}]`, st, true));
  });
}

function walkScenario(spec: ScenarioSpec, st: WalkState, registry: ScenarioRegistry): void {
  st.examined += 1;
  if (!Array.isArray(spec.drivers) || spec.drivers.length === 0) {
    push(st, "shape", "drivers", "drivers must be a non-empty array");
  } else {
    spec.drivers.forEach((d, i) => {
      const p = `drivers[${i}]`;
      checkText(d?.label, `${p}.label`, st, true);
      checkEnum(d?.span, DRIVER_SPANS, `${p}.span`, st, false);
      st.examined += 1;
      if (typeof d?.driver !== "string" || !registry.drivers.includes(d.driver)) {
        push(st, "shape", `${p}.driver`, String(d?.driver));
      }
    });
  }
  st.examined += 1;
  if (!Array.isArray(spec.outputs) || spec.outputs.length === 0) {
    push(st, "shape", "outputs", "outputs must be a non-empty array");
    return;
  }
  spec.outputs.forEach((o, i) => {
    st.examined += 1;
    if (typeof o !== "string" || !registry.outputs.includes(o)) {
      push(st, "shape", `outputs[${i}]`, String(o));
    }
  });
}

function walkComparison(spec: ComparisonSpec, st: WalkState): void {
  checkEnum(spec.basis, COMPARISON_BASES, "basis", st, true);
  st.examined += 1;
  if (!Array.isArray(spec.rows) || spec.rows.length === 0) {
    push(st, "shape", "rows", "rows must be a non-empty array");
    return;
  }
  spec.rows.forEach((r, i) => checkText(r, `rows[${i}]`, st, true));
  st.examined += 1;
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    push(st, "shape", "columns", "columns must be a non-empty array");
    return;
  }
  const standards = new Set<string>();
  const currencies = new Set<string>();
  spec.columns.forEach((c, i) => {
    const p = `columns[${i}]`;
    checkText(c?.label, `${p}.label`, st, true);
    st.examined += 1;
    if (typeof c?.standard !== "string" || !c.standard.trim()) {
      push(st, "shape", `${p}.standard`, String(c?.standard));
    } else {
      standards.add(c.standard);
    }
    if (c?.currency !== undefined) {
      st.examined += 1;
      if (typeof c.currency !== "string" || !c.currency.trim()) {
        push(st, "shape", `${p}.currency`, String(c.currency));
      } else {
        currencies.add(c.currency);
      }
    }
    st.examined += 1;
    if (!Array.isArray(c?.cells)) {
      push(st, "shape", `${p}.cells`, "cells must be an array");
      return;
    }
    if (c.cells.length !== spec.rows.length) {
      push(
        st,
        "length_mismatch",
        `${p}.cells`,
        `${c.cells.length} cell(s) for ${spec.rows.length} row(s)`,
      );
    }
    const units = c.cells.map((cell, j) => checkFactRef(cell, `${p}.cells[${j}]`, st, true));
    requireOneUnit(units, `${p}.cells`, st);
  });

  // L5 — the grouping law. Two columns under two accounting standards
  // are two rulers; a reader comparing them is comparing measurement
  // conventions, not companies. `benchmarkGroups` throws on exactly
  // this for percentiles; an artifact gets the same treatment.
  if (standards.size > 1) {
    push(st, "cross_standard", "columns", Array.from(standards).sort().join(" vs "));
  }
  // A peer comparison across currencies is the same defect wearing FX:
  // the columns are not on one scale and no display dial can fix it.
  if (currencies.size > 1) {
    push(st, "currency_mixed", "columns", Array.from(currencies).sort().join(" vs "));
  }
}

function walkFinding(spec: FindingSpec, st: WalkState, registry: ScenarioRegistry): void {
  st.examined += 1;
  if (typeof spec.findingKey !== "string" || !spec.findingKey.trim()) {
    push(st, "shape", "findingKey", String(spec.findingKey));
  }
  st.examined += 1;
  if (!Array.isArray(spec.facts) || spec.facts.length === 0) {
    push(st, "shape", "facts", "facts must be a non-empty array");
  } else {
    spec.facts.forEach((f, i) => checkFactRef(f, `facts[${i}]`, st, false));
    if (spec.factLabels !== undefined) {
      st.examined += 1;
      if (!Array.isArray(spec.factLabels) || spec.factLabels.length !== spec.facts.length) {
        push(
          st,
          "length_mismatch",
          "factLabels",
          `${Array.isArray(spec.factLabels) ? spec.factLabels.length : "non-array"} label(s) for ${spec.facts.length} fact(s)`,
        );
      } else {
        spec.factLabels.forEach((l, i) => checkText(l, `factLabels[${i}]`, st, true));
      }
    }
  }
  if (spec.recomputeMetric !== undefined) {
    st.examined += 1;
    if (typeof spec.recomputeMetric !== "string" || !registry.outputs.includes(spec.recomputeMetric)) {
      push(st, "shape", "recomputeMetric", String(spec.recomputeMetric));
    }
    checkFactRef(spec.recomputeExclude, "recomputeExclude", st, false);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ENTRY POINTS
// ══════════════════════════════════════════════════════════════════════

/** The scenario/finding registries, injected so this module stays pure
 *  and `artifactScenario` can own the formulas without a cycle. */
export interface ScenarioRegistry {
  drivers: readonly string[];
  outputs: readonly string[];
}

export const EMPTY_REGISTRY: ScenarioRegistry = { drivers: [], outputs: [] };

function guardInputFrom(evidence: CapsuleEvidence): GuardInput {
  return {
    facts: evidence.facts,
    factUnits: evidence.factUnits,
    literals: evidence.literals,
  };
}

/**
 * Check one model-authored spec against the evidence it was given.
 *
 * Pure and synchronous. The pipeline calls it, the tests call it, and
 * the "regenerate once, then refuse" decision is made on its output
 * alone — exactly the shape `guardAnswer` established for prose.
 */
export function guardArtifactSpec(
  raw: unknown,
  evidence: CapsuleEvidence,
  registry: ScenarioRegistry = EMPTY_REGISTRY,
): SpecGuardResult {
  const st: WalkState = {
    input: guardInputFrom(evidence),
    evidence,
    violations: [],
    citedFacts: [],
    examined: 0,
  };

  st.examined += 1;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    push(st, "shape", "", "spec must be an object");
    return { ok: false, violations: st.violations, citedFacts: [], examined: st.examined };
  }

  // L1 FIRST, over the RAW tree. Before any narrowing, before any field
  // is trusted — a number in a field this build does not know about is
  // still a number the model typed.
  scanForNumbers(raw, "", st);

  const spec = raw as Partial<ArtifactSpecBase> & Record<string, unknown>;

  st.examined += 1;
  if (spec.version !== ARTIFACT_SPEC_VERSION) {
    push(st, "bad_version", "version", String(spec.version));
  }
  const kind = checkEnum(spec.kind, ARTIFACT_KINDS, "kind", st, true);
  if (kind === null) {
    push(st, "unknown_kind", "kind", String(spec.kind));
    return { ok: false, violations: st.violations, citedFacts: st.citedFacts, examined: st.examined };
  }
  checkText(spec.title, "title", st, true);
  checkText(spec.caption, "caption", st, false);

  if (kind === "chart") walkChart(raw as ChartSpec, st);
  else if (kind === "table") walkTable(raw as TableSpec, st);
  else if (kind === "spreadsheet") walkSpreadsheet(raw as SpreadsheetSpec, st);
  else if (kind === "slide") walkSlide(raw as SlideSpec, st);
  else if (kind === "document") walkDocument(raw as DocumentSpec, st);
  else if (kind === "scenario") walkScenario(raw as ScenarioSpec, st, registry);
  else if (kind === "comparison") walkComparison(raw as ComparisonSpec, st);
  else if (kind === "finding") walkFinding(raw as FindingSpec, st, registry);

  // One currency per artifact, across every money fact it cites.
  requireOneCurrency(st.citedFacts, st, "");

  return {
    ok: st.violations.length === 0,
    violations: st.violations,
    citedFacts: st.citedFacts,
    examined: st.examined,
  };
}

/**
 * Parse a model-authored spec. Returns the typed spec, or `null` to mean
 * REFUSE — the caller renders the deterministic fallback rather than a
 * half-built artifact. There is no partial acceptance: an artifact that
 * drops the one bad series still looks authoritative.
 */
export function parseArtifactSpec(
  raw: unknown,
  evidence: CapsuleEvidence,
  registry: ScenarioRegistry = EMPTY_REGISTRY,
): ArtifactSpec | null {
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  if (parsed === undefined) return null;
  const r = guardArtifactSpec(parsed, evidence, registry);
  return r.ok ? (parsed as ArtifactSpec) : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The complaint handed to the single regeneration. Quotes the offending
 *  path AND fragment, so the retry is corrective rather than hopeful. */
export function specViolationBrief(violations: readonly SpecViolation[]): string {
  return violations
    .slice(0, 8)
    .map((v) => {
      switch (v.kind) {
        case "number_literal":
          return `· ${v.path} holds the number ${v.sample}. A spec never carries a number — name the fact instead.`;
        case "numeral":
          return `· ${v.path} contains a numeral you wrote: "${v.sample}". Use a placeholder or drop the claim.`;
        case "unknown_fact":
          return `· ${v.path} names "${v.sample}", which was not retrieved. Only the listed FACTS may be named.`;
        case "unit_mismatch":
          return `· ${v.path} uses the wrong token for that fact's declared unit.`;
        case "unit_mixed":
          return `· ${v.path} mixes units (${v.sample}) in one plane. Split them into separate artifacts.`;
        case "currency_mixed":
          return `· ${v.path} mixes currencies (${v.sample}). One artifact carries one currency.`;
        case "cross_standard":
          return `· ${v.path} compares across accounting standards (${v.sample}). That is two rulers, not one comparison.`;
        case "unknown_account":
          return `· ${v.path} cites account "${v.sample}", which the evidence never mentioned.`;
        case "length_mismatch":
          return `· ${v.path} is misaligned: ${v.sample}.`;
        case "bad_version":
          return `· version must be "${ARTIFACT_SPEC_VERSION}", not "${v.sample}".`;
        case "unknown_kind":
          return `· "${v.sample}" is not one of the eight artifact kinds.`;
        case "malformed_placeholder":
          return `· ${v.path}: "${v.sample}" is not a valid placeholder.`;
        case "empty":
          return `· ${v.path} is empty.`;
        default:
          return `· ${v.path}: ${v.sample}`;
      }
    })
    .join("\n");
}
