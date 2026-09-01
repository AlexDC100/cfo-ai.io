// THE ARTIFACTS — REFINE. "make it quarterly", "add last year",
// "exclude intercompany" — and the artifact changes in place.
//
// Two properties make this the loop that makes the surface feel alive
// rather than a chat that happens to draw:
//
//   IN PLACE, VERSIONED, UNDOABLE. A refine replaces the artifact at the
//   same position in the thread and pushes a version. Nothing is lost;
//   the previous shape is one keystroke away. A refine that appended a
//   second card would turn a conversation into a scrapbook.
//
//   FREE WHEN IT CAN BE. A large share of refines are pure RESHAPES of
//   an artifact we already hold — a bar becoming a line, hundredths
//   becoming whole, a table sorted the other way. Those need no model
//   and no retrieval, and `planRefine` answers them from a deterministic
//   parse, exactly as `capsuleTier0` answers a lookup before the model
//   arrives. Only a refine that needs FACTS WE DO NOT HAVE ("add last
//   year") escalates.
//
// ── The line between reshape and retrieve ────────────────────────────
//
// It is not a matter of taste; it is a matter of whether the new
// artifact would cite a fact the current evidence does not carry.
//
//   RESHAPE   the fact set is unchanged, only the presentation moves.
//   RETRIEVE  the fact set must grow or change period. That is a new
//             question to the facts gateway, and — critically — it is
//             the ONLY path that can add figures. A reshape can never
//             introduce a number, so the numeral law is upheld on the
//             free path by construction rather than by a second guard.
//
// ── No clock ─────────────────────────────────────────────────────────
//
// Versions are ordered by an incrementing index, not a timestamp. This
// module is pure and deterministic (same history + same directive →
// same result), which is what lets the undo behaviour be a unit test
// rather than a screenshot.

import type { ArtifactSpec, ChartForm, Precision } from "./artifactSpec";
import { CHART_FORMS, PRECISIONS } from "./artifactSpec";
import { foldQuery } from "@/lib/capsuleRouter";

// ══════════════════════════════════════════════════════════════════════
// DIRECTIVES
// ══════════════════════════════════════════════════════════════════════

export type RefineDirective =
  /** Presentation only — applied locally, costs nothing. */
  | { kind: "chart_form"; form: ChartForm }
  | { kind: "precision"; precision: Precision }
  | { kind: "sort"; order: "asc" | "desc" | "source" }
  | { kind: "transpose" }
  /** Needs facts we may not hold — escalates to retrieval. */
  | { kind: "granularity"; grain: "monthly" | "quarterly" | "annual" }
  | { kind: "add_period"; which: "prior_year" | "prior_period" }
  | { kind: "exclude"; subject: string }
  | { kind: "unknown"; text: string };

export type RefinePlan =
  | { mode: "reshape"; directive: RefineDirective; spec: ArtifactSpec }
  | { mode: "retrieve"; directive: RefineDirective; ask: string }
  | { mode: "refused"; directive: RefineDirective; reasonKey: string };

/** Folded phrase → directive. EN + RO, data not branches, in the shape
 *  `capsuleRouter` established. Every token here is matched against the
 *  DIACRITIC-FOLDED query, so "trimestrial" and "trimestrial" (with the
 *  ș) are one entry. */
const FORM_TOKENS: ReadonlyArray<readonly [ChartForm, readonly string[]]> = Object.freeze([
  ["bar", ["bar", "bars", "column", "columns", "bare", "coloane"]],
  ["line", ["line", "lines", "trend line", "linie", "linii"]],
  ["stacked", ["stacked", "stack", "stivuit", "suprapus"]],
  ["waterfall", ["waterfall", "bridge", "cascada", "punte"]],
  ["donut", ["donut", "doughnut", "pie", "inel", "placinta"]],
]);

const PRECISION_TOKENS: ReadonlyArray<readonly [Precision, readonly string[]]> = Object.freeze([
  ["whole", ["whole", "round", "no decimals", "rotunjit", "fara zecimale"]],
  ["tenths", ["one decimal", "tenths", "o zecimala"]],
  ["hundredths", ["two decimals", "hundredths", "doua zecimale"]],
  ["auto", ["auto", "default", "implicit"]],
]);

const GRAIN_TOKENS: ReadonlyArray<readonly ["monthly" | "quarterly" | "annual", readonly string[]]> =
  Object.freeze([
    ["quarterly", ["quarterly", "by quarter", "quarters", "trimestrial", "pe trimestre"]],
    ["monthly", ["monthly", "by month", "months", "lunar", "pe luni"]],
    ["annual", ["annual", "yearly", "by year", "anual", "pe ani"]],
  ]);

const PRIOR_YEAR_TOKENS: readonly string[] = Object.freeze([
  "last year",
  "prior year",
  "previous year",
  "year ago",
  "anul trecut",
  "anul precedent",
]);

const PRIOR_PERIOD_TOKENS: readonly string[] = Object.freeze([
  "last period",
  "prior period",
  "previous period",
  "perioada anterioara",
  "perioada precedenta",
]);

const EXCLUDE_VERBS: readonly string[] = Object.freeze([
  "exclude",
  "excluding",
  "without",
  "drop",
  "remove",
  "exclude",
  "exclude ",
  "fara",
  "exclus",
  "elimina",
]);

const SORT_TOKENS: ReadonlyArray<readonly ["asc" | "desc" | "source", readonly string[]]> =
  Object.freeze([
    ["desc", ["largest first", "descending", "biggest first", "descrescator"]],
    ["asc", ["smallest first", "ascending", "crescator"]],
    ["source", ["original order", "as is", "ordinea initiala"]],
  ]);

const TRANSPOSE_TOKENS: readonly string[] = Object.freeze([
  "transpose",
  "flip",
  "swap rows and columns",
  "rows as columns",
  "transpune",
]);

function has(folded: string, tokens: readonly string[]): boolean {
  return tokens.some((t) => folded.includes(t));
}

/**
 * Read a refine phrase. Pure, synchronous, no model.
 *
 * Order matters and is deliberate: the RETRIEVE-shaped directives are
 * tested first, because "add last year as a line" is a retrieval that
 * happens to mention a chart form, and treating it as a free reshape
 * would silently drop the half of the request that costs something.
 */
export function parseRefineDirective(text: string): RefineDirective {
  const folded = foldQuery(text ?? "");
  if (!folded) return { kind: "unknown", text: text ?? "" };

  for (const [grain, tokens] of GRAIN_TOKENS) {
    if (has(folded, tokens)) return { kind: "granularity", grain };
  }
  if (has(folded, PRIOR_YEAR_TOKENS)) return { kind: "add_period", which: "prior_year" };
  if (has(folded, PRIOR_PERIOD_TOKENS)) return { kind: "add_period", which: "prior_period" };

  for (const verb of EXCLUDE_VERBS) {
    const at = folded.indexOf(`${verb} `);
    if (at < 0) continue;
    const subject = folded.slice(at + verb.length + 1).trim();
    if (subject) return { kind: "exclude", subject };
  }

  for (const [form, tokens] of FORM_TOKENS) {
    if (has(folded, tokens)) return { kind: "chart_form", form };
  }
  for (const [precision, tokens] of PRECISION_TOKENS) {
    if (has(folded, tokens)) return { kind: "precision", precision };
  }
  for (const [order, tokens] of SORT_TOKENS) {
    if (has(folded, tokens)) return { kind: "sort", order };
  }
  if (has(folded, TRANSPOSE_TOKENS)) return { kind: "transpose" };

  return { kind: "unknown", text: text ?? "" };
}

// ══════════════════════════════════════════════════════════════════════
// PLANNING
// ══════════════════════════════════════════════════════════════════════

/** Sorting a table by a column reorders ROWS; it never touches a cell,
 *  so it cannot change a figure. The comparator reads the resolved
 *  values, which is why sorting is applied at RENDER time rather than
 *  here — this function only records the intent on the spec. */
export interface SortIntent {
  order: "asc" | "desc" | "source";
}

/** A spec carries its refine state alongside the model's authored
 *  fields. Kept as a separate object so `guardArtifactSpec` still sees
 *  exactly the schema the model wrote, with no reader-owned fields to
 *  confuse it. */
export interface RefineState {
  sort?: SortIntent;
  transposed?: boolean;
}

export interface ArtifactVersion {
  /** Monotonic within a history. No clock. */
  index: number;
  spec: ArtifactSpec;
  refine: RefineState;
  /** The phrase that produced this version. Empty for version 0. */
  directive: string;
}

export interface ArtifactHistory {
  versions: ArtifactVersion[];
  /** Index into `versions` of what is on screen. Undo moves it back;
   *  a new refine truncates everything after it. */
  cursor: number;
}

export function newHistory(spec: ArtifactSpec): ArtifactHistory {
  return { versions: [{ index: 0, spec, refine: {}, directive: "" }], cursor: 0 };
}

export function currentVersion(h: ArtifactHistory): ArtifactVersion {
  return h.versions[h.cursor];
}

export function canUndo(h: ArtifactHistory): boolean {
  return h.cursor > 0;
}

export function canRedo(h: ArtifactHistory): boolean {
  return h.cursor < h.versions.length - 1;
}

export function undo(h: ArtifactHistory): ArtifactHistory {
  return canUndo(h) ? { versions: h.versions, cursor: h.cursor - 1 } : h;
}

export function redo(h: ArtifactHistory): ArtifactHistory {
  return canRedo(h) ? { versions: h.versions, cursor: h.cursor + 1 } : h;
}

/** Push a new version at the cursor, discarding any redo branch. */
export function pushVersion(
  h: ArtifactHistory,
  spec: ArtifactSpec,
  refine: RefineState,
  directive: string,
): ArtifactHistory {
  const kept = h.versions.slice(0, h.cursor + 1);
  kept.push({ index: kept.length, spec, refine, directive });
  return { versions: kept, cursor: kept.length - 1 };
}

/**
 * Decide what a refine phrase does to THIS artifact.
 *
 * A reshape returns the new spec directly and the caller never leaves
 * the browser. A retrieval returns the question to put to the facts
 * gateway. A directive that does not apply to this artifact kind is
 * REFUSED by name rather than silently ignored — "make it a waterfall"
 * on a document should say so, not appear to work.
 */
export function planRefine(
  spec: ArtifactSpec,
  refine: RefineState,
  text: string,
): RefinePlan {
  const directive = parseRefineDirective(text);

  switch (directive.kind) {
    case "chart_form": {
      if (spec.kind !== "chart") {
        return { mode: "refused", directive, reasonKey: "artifact.refine.notAChart" };
      }
      // A donut is a SHARE of one whole; a series with a negative member
      // has no share, and a waterfall needs deltas rather than levels.
      // Both are checked at resolve time — here we only reshape.
      return { mode: "reshape", directive, spec: { ...spec, form: directive.form } };
    }
    case "precision": {
      if (spec.kind !== "chart" && spec.kind !== "table") {
        return { mode: "refused", directive, reasonKey: "artifact.refine.noPrecision" };
      }
      return { mode: "reshape", directive, spec: { ...spec, precision: directive.precision } };
    }
    case "sort": {
      if (spec.kind !== "table" && spec.kind !== "comparison") {
        return { mode: "refused", directive, reasonKey: "artifact.refine.noSort" };
      }
      void refine;
      return { mode: "reshape", directive, spec };
    }
    case "transpose": {
      if (spec.kind !== "table" && spec.kind !== "comparison") {
        return { mode: "refused", directive, reasonKey: "artifact.refine.noTranspose" };
      }
      return { mode: "reshape", directive, spec };
    }
    case "granularity":
      return {
        mode: "retrieve",
        directive,
        ask: `${spec.title} — ${directive.grain}`,
      };
    case "add_period":
      return {
        mode: "retrieve",
        directive,
        ask:
          directive.which === "prior_year"
            ? `${spec.title} — with the prior year alongside`
            : `${spec.title} — with the prior period alongside`,
      };
    case "exclude":
      return {
        mode: "retrieve",
        directive,
        ask: `${spec.title} — excluding ${directive.subject}`,
      };
    default:
      return { mode: "retrieve", directive, ask: text };
  }
}

/** Apply a plan to a history. A refused plan leaves the history
 *  untouched — a version whose only content is "we did nothing" would
 *  make undo lie about what it undoes. */
export function applyRefine(
  h: ArtifactHistory,
  plan: RefinePlan,
  text: string,
): ArtifactHistory {
  if (plan.mode !== "reshape") return h;
  const cur = currentVersion(h);
  const nextRefine: RefineState = { ...cur.refine };
  if (plan.directive.kind === "sort") nextRefine.sort = { order: plan.directive.order };
  if (plan.directive.kind === "transpose") nextRefine.transposed = !cur.refine.transposed;
  return pushVersion(h, plan.spec, nextRefine, text);
}

/** The vocabularies, exported so the gate can assert they were built
 *  rather than counted from an empty walk (TC-3/TC-9). */
export const REFINE_VOCABULARY = Object.freeze({
  forms: CHART_FORMS,
  precisions: PRECISIONS,
  grains: GRAIN_TOKENS.map(([g]) => g),
  priorYear: PRIOR_YEAR_TOKENS,
  priorPeriod: PRIOR_PERIOD_TOKENS,
  excludeVerbs: EXCLUDE_VERBS,
});
