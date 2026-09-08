// forecastFacts.ts — THE frontend gateway over PROJECTED figures.
//
// The sibling of `servedFacts.ts`, and deliberately not compatible with it.
// `servedFacts` answers questions about the SERVED statements: every figure
// it returns resolves to a cell in the uploaded book. This module answers
// questions about a PROJECTION: every figure it returns resolves to the
// assumptions that produced it. Those are different kinds of claim, and the
// owner's requirement is architectural, not cosmetic:
//
//     "No forecast figure may ever be served through an accessor that a
//      consumer could mistake for an actual — separate namespace, gated."
//
// ── HOW THE MISTAKE IS MADE A COMPILE ERROR ──────────────────────────────
//
// The repo has met this class of defect twice in writing — `periodFacts.ts`
// at the `CanonicalBsKey` note, and the D1 note in
// `frontend/lib/__tests__/envelopeKeySpace.test.ts`: a lookup that "compiles
// clean and then MISSES on every lookup", silently, for the life of the
// product. Both were fixed the same way: name the key space in the type so
// the wrong name is a type error rather than a silent miss.
//
// The same move, one level up. A projected amount is NOT typed as a number.
// It is `ProjectedMinor`, an opaque nominal type whose runtime value happens
// to be an integer count of minor units, and TypeScript will not let it into
// any position expecting a number:
//
//     const total = actualMinor + figure.amountMinor;   // ERROR
//     formatRon(figure.amountMinor);                    // ERROR
//     <Amount value={figure.amountMinor} />             // ERROR
//
// The ONLY way to reach the number is `unwrapProjected(figure, consumer)`,
// and the consumer's signature is `(value, marker) => T` — you cannot receive
// the value without receiving, in the same call, the marker that says what it
// is. That is the data-level carrier B3 asks for: not a CSS class the export
// renderer can forget (four of five known defects in this product lived in
// exactly that gap), but a parameter the type checker makes every renderer
// take delivery of.
//
// ── THE SHAPE THIS READS IS THE SHAPE THE ENGINE SERVES ─────────────────
//
// `readProjection` is fed `ProjectionGateway.as_dict()` — the engine's WIRE
// form, not the input payload the engine is handed. Those are different
// dicts, and for the whole of wave 1 this module could not read the first
// one. MEASURED on the engine's own bytes:
//
//     readProjection(gateway.as_dict())
//       -> 15 figures, 0 served, 15 refused
//       -> {"projected":true,"refused":true,"code":"no_assumptions_behind_it"}
//
// which `components/forecast/ProjectedAmount.tsx` paints as an em-dash. So
// every projected figure on every surface would have rendered "—" while the
// engine held the number and considered it served. The cause was two field
// names: the wire form renamed the amount and replaced `assumption_ids` with
// an expanded `basis`, and `basisFor()` below resolves a basis from
// `assumption_ids` and nothing else.
//
// Neither suite could see it, because neither ever fed the served shape
// back: the Python suite called `as_dict()` seven times and inspected it,
// and this module's suite only ever read a hand-written INPUT-shaped
// fixture. A shape nobody feeds back is a shape nobody has read. The engine
// now emits both names, `tests/engine/fixtures/forecast/fp1_agras_served
// .json` is the committed SERVED bytes, and the vitest suite reads them.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
//
// No formatting. This module contains no `toFixed`, no `toLocaleString`, no
// `Intl` — it returns typed objects, and painting them is the surface's job
// (see `components/forecast/ProjectedAmount.tsx`, the one sanctioned way).
// No forecasting either: it computes no driver and rolls no balance forward.
// It mirrors `engine/forecast_serving` on the FE side and nothing more.

// ─── The fp1 wire contract, pinned ──────────────────────────────────────
// Mirrors src/engine/forecast_serving/contract.py. The vitest suite asserts
// these against the Python module's own constants, so a rename on either
// side fails a gate before it can fail a reader.

export const FORECAST_CONTRACT_VERSION = "fp1";
export const PROJECTION_KIND = "projection";
export const PROJECTED_MARKER = "projected";

/** The `schema` stamps the projection ENGINE puts on its OWN output.
 *
 *  fp1 is what the backend SERVES. It is not what the producer EMITS:
 *  `engine.forecast.Projection.as_dict()` stamps `schema: "forecast_v1"` and
 *  carries none of fp1's markers — no `kind`, no `projected`, bare floats. So
 *  `looksProjected` reads both vocabularies, exactly as
 *  `engine/forecast_serving/boundary.py::_is_projection_node` does.
 *
 *  Keyed on the VALUE, never on the key `schema` alone: the canonical balance
 *  sheet stamps `schema: "bs_v2"` on an ACTUALS payload, so a guard keyed on
 *  the key name would flag every book in the product. */
export const PRODUCER_SCHEMAS = ["forecast_v1"] as const;

/** The keys under which a projection may name the ACTUAL book it stands on.
 *  Everything beneath one of these is exempt from the source-cell ban.
 *  fp1 says `base_period`; the engine's own serialization says `opening`.
 *  Mirrors `contract.BASE_PERIOD_KEYS` — the vitest suite compares the two
 *  files, so a rename on either side fails a gate before it fails a reader. */
export const BASE_PERIOD_KEYS = [
  "base_period",
  "basePeriod",
  "opening",
] as const;

/** The units an assumption may be stated in. A driver whose unit is not one
 *  of these cannot be rendered honestly beside its figure. */
export const ASSUMPTION_UNITS = [
  "pct",
  "days",
  "ratio",
  "money_minor",
  "count",
  "months",
  // The one non-quantitative unit: a stated rule with no number. A HELD
  // balance-sheet line ("other receivables at 2028-12-31 will be exactly
  // what they were at 2025-12-31") is a falsifiable claim the model made,
  // so it must name its reason — and it has no rate to name. A convention
  // carries `null` in every period and renders as its basis sentence, so
  // nothing downstream can mistake it for a quantity.
  "convention",
] as const;
export type AssumptionUnit = (typeof ASSUMPTION_UNITS)[number];

/** Provenance field names that belong to an ACTUAL figure — each one names a
 *  cell in a source document. A projected figure carrying any of them is the
 *  LACKS_SHOWS bucket of design_review/PROVENANCE_CENSUS.json: an affordance
 *  over a payload with nothing behind it. */
export const ACTUAL_PROVENANCE_FIELDS = [
  "snapshot_id",
  "line_id",
  "source_cell",
  "source_document_id",
  "content_hash",
  "sheet",
  "cell",
  "row_index",
] as const;

// ─── The opaque projected amount ────────────────────────────────────────

declare const PROJECTED_MINOR: unique symbol;

/** An integer count of minor units that is NOT a `number` to the type
 *  checker. Nominal, not structural: there is no widening path to `number`,
 *  so a projected amount cannot be added to an actual, passed to a money
 *  formatter, or handed to a figure primitive built for actuals.
 *
 *  Its runtime representation IS a plain number — that is deliberate, so the
 *  wire form stays ordinary JSON and no serializer has to know about this
 *  type. The nominality is a compile-time instrument; `unwrapProjected` is
 *  the single documented door, and it is grep-able. */
export type ProjectedMinor = { readonly [PROJECTED_MINOR]: "projected_minor" };

/** Handed to every consumer of a projected value, in the same call as the
 *  value itself. A renderer physically cannot take delivery of the number
 *  without taking delivery of this. */
export interface ProjectedMarker {
  /** Always literally true. A discriminant, not a flag to branch on. */
  readonly projected: true;
  /** Which projected year this figure belongs to, e.g. "FY+2". */
  readonly period: string;
  /** The assumptions this figure resolves to. Never empty — a figure that
   *  resolves to nothing is a `ProjectionRefusal`, not a figure. */
  readonly basis: readonly AssumptionRef[];
  /** The arithmetic, as the projection states it. */
  readonly formula: string;
  /** The ACTUAL period the whole projection stands on. A pointer, at the
   *  projection level; no single projected number came out of a cell in it. */
  readonly basePeriodLabel: string;
}

// ─── The types ──────────────────────────────────────────────────────────

/** One driver, and the whole of what a projected figure resolves to.
 *
 *  `value` is the driver's value FOR THIS FIGURE'S PERIOD — a reader looking
 *  at FY+2 revenue is owed the FY+2 growth rate, not a schedule of three.
 *  `null` means the driver exists and its value for this year is not stated:
 *  ABSENT, which is not zero.
 *
 *  `basis` is mandatory prose. A driver a reader cannot interrogate is a
 *  number with an opinion attached.
 *
 *  `derivedFrom` names the ACTUAL facts the DRIVER was fitted on — the only
 *  legitimate source reference in this namespace, and note the two hops it
 *  describes: the figure came from the driver, the driver came from history. */
export interface AssumptionRef {
  readonly id: string;
  readonly label: string;
  readonly unit: AssumptionUnit | string;
  readonly value: number | null;
  /** WHICH PERIOD `value` IS FOR, or `null` when the ref was built without
   *  asking for one.
   *
   *  This exists because `value: null` was carrying two opposite meanings
   *  and a surface read the wrong one. `assumptions` is the DECLARED list —
   *  every driver, schedule and all, valued for no period — so every `value`
   *  in it is null; a driver the book genuinely could not measure is ALSO
   *  null. The forecast page's assumption schedule read the first and
   *  printed the second: `revenue_growth`, supplied at 8%, rendered as "not
   *  measurable from this book". Same shape as the absent-read-as-zero
   *  defects elsewhere in this repo, one level up — a null that means "I
   *  did not ask" read as a null that means "there is nothing to have".
   *
   *  Ask a question about a period (`assumptionsFor`) and this carries that
   *  period. Read the declared list and it is null, which is the ref saying
   *  it was never asked. */
  readonly valuedFor: string | null;
  readonly basis: string;
  readonly derivedFrom: readonly string[];
}

/** One projected number. Note what is NOT here: no `amount_minor`, no
 *  `toFloat`, no `provenance`. Those are the three accessors every actuals
 *  consumer in this repo reaches for, and their absence is the point. */
export interface ProjectedFigure {
  readonly kind: typeof PROJECTION_KIND;
  readonly projected: true;
  readonly line: string;
  readonly period: string;
  readonly currency: string;
  readonly formula: string;
  readonly basis: readonly AssumptionRef[];
  /** Opaque. Reach it through `unwrapProjected`, never directly. */
  readonly amountMinor: ProjectedMinor;
}

/** The projection does not carry that figure, and says why. Returned, never
 *  thrown, and NEVER carrying a number — a refusal with a number in it is a
 *  partial answer, and a partial projected figure is indistinguishable from a
 *  wrong one. */
export interface ProjectionRefusal {
  readonly projected: true;
  readonly refused: true;
  readonly line: string;
  readonly period: string;
  readonly code: "not_projected" | "no_assumptions_behind_it" | "outside_horizon";
  readonly detail: string;
}

export type ProjectedResult = ProjectedFigure | ProjectionRefusal;

export interface BalanceCheckRow {
  readonly period: string;
  readonly differenceMinor: number | null;
  /** Zero to the cent, or it does not balance. There is no tolerance band:
   *  the projection is built in integer minor units precisely so that this
   *  comparison is exact, and a year that does not balance is a hard error,
   *  not a rounding note. */
  readonly balances: boolean;
}

export interface ProjectionView {
  readonly contract: typeof FORECAST_CONTRACT_VERSION;
  readonly currency: string;
  readonly basePeriodLabel: string;
  readonly baseSnapshotId: string | null;
  readonly horizon: readonly string[];
  /** The DECLARED drivers, valued for no period — every `value` here is
   *  null and every `valuedFor` is null, which is the ref saying it was
   *  never asked. To render a number, ask `assumptionsFor(period)`. */
  readonly assumptions: readonly AssumptionRef[];
  /** The same drivers, valued for one period of the horizon. */
  assumptionsFor(period: string): readonly AssumptionRef[];
  readonly balanceCheck: readonly BalanceCheckRow[];
  /** Every projected year whose balance sheet does not close, in horizon
   *  order. Empty is the only shippable state. */
  readonly unbalancedPeriods: readonly string[];
  figure(line: string, period: string): ProjectedResult;
  figures(): readonly ProjectedResult[];
  lines(): readonly string[];
}

/** The composite-key separator, and the "no period" sentinel.
 *
 *  Both are U+0000, written as an ESCAPE rather than as a literal NUL in the
 *  source — which is what this file used to carry. A literal NUL makes the
 *  whole file binary to `grep`, and every text-scanning gate in this repo
 *  (`check_no_plants.mjs`, the hardcoded-URL scan, the metric-unit sweeps)
 *  walks the tree with one. The file was invisible to all of them, silently,
 *  which is the same shape as the intercepted route that had no gate. The
 *  bytes the runtime sees are identical; only the source is now readable. */
const KEY_SEP = "\u0000";
const NO_PERIOD = "\u0000";

// ─── The one door to the value ──────────────────────────────────────────

/** Read a projected figure's number — and receive, in the same call, the
 *  marker that says what it is.
 *
 *  There is no overload that returns the bare value. That is not an oversight
 *  and it is not friction for its own sake: an export renderer, a chat
 *  context builder and a screen are three different code paths, and the only
 *  thing that survives all three unchanged is the data they are handed. */
export function unwrapProjected<T>(
  figure: ProjectedFigure,
  basePeriodLabel: string,
  consume: (minorUnits: number, marker: ProjectedMarker) => T,
): T {
  const marker: ProjectedMarker = {
    projected: true,
    period: figure.period,
    basis: figure.basis,
    formula: figure.formula,
    basePeriodLabel,
  };
  return consume(figure.amountMinor as unknown as number, marker);
}

/** The 2-decimal display value, with its marker. The single division, at the
 *  edge, exactly like `Fact.to_float()` on the actuals side. */
export function projectedDisplay<T>(
  figure: ProjectedFigure,
  basePeriodLabel: string,
  consume: (value: number, marker: ProjectedMarker) => T,
): T {
  return unwrapProjected(figure, basePeriodLabel, (minor, marker) =>
    consume(minor / 100, marker),
  );
}

// ─── Discriminators ─────────────────────────────────────────────────────

export function isProjectedFigure(x: unknown): x is ProjectedFigure {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.kind === PROJECTION_KIND && o.projected === true && !("refused" in o);
}

export function isProjectionRefusal(x: unknown): x is ProjectionRefusal {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.projected === true && o.refused === true;
}

/** Anything that claims to be projected, in any shape — including a figure
 *  whose marker was stripped on the way through a serializer, which is the
 *  dangerous case, not the harmless one. */
export function looksProjected(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.kind === PROJECTION_KIND) return true;
  if (o[PROJECTED_MARKER] === true) return true;
  // The producer's own shape. Without this the guard cannot see a real
  // projection at all: `Projection.as_dict()` carries no `kind`, no marker
  // and no `assumption_ids`, so every branch below misses it too.
  if (
    typeof o.schema === "string" &&
    (PRODUCER_SCHEMAS as readonly string[]).includes(o.schema)
  ) {
    return true;
  }
  if ("amount_minor_projected" in o) return true;
  if ("assumption_ids" in o && "amount_minor" in o) return true;
  return false;
}

// ─── The boundary guards, mirroring engine/forecast_serving/boundary.py ──

/** Every path inside an ACTUALS payload that carries a projection. Paths,
 *  not a boolean: a guard that reports "somewhere in this envelope" is a
 *  guard nobody can act on. */
export function projectionLeaksIntoActuals(actuals: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (looksProjected(node)) found.push(path);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (typeof node === "object" && node !== null) {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        walk((node as Record<string, unknown>)[key], `${path}.${key}`);
      }
    }
  };
  walk(actuals, "$");
  return found;
}

export function assertNoProjectionInActuals(actuals: unknown): void {
  const leaks = projectionLeaksIntoActuals(actuals);
  if (leaks.length > 0) {
    throw new Error(
      `forecastFacts: a projected figure is sitting inside an ACTUALS ` +
        `payload at ${leaks.slice(0, 5).join(", ")}. Every figure an actuals ` +
        `accessor serves resolves to a cell in the uploaded book; this one ` +
        `resolves to an assumption.`,
    );
  }
}

/** Every path inside a PROJECTION payload carrying a source-cell affordance.
 *  The base-book pointer is the one exemption — the projection as a whole
 *  stands on one book and the reader has to see which. A source cell on a
 *  FIGURE is the false claim.
 *
 *  The exemption is keyed on `BASE_PERIOD_KEYS`, not on the literal word
 *  `base_period`, because the two producers name the same pointer
 *  differently: fp1 says `base_period`, the engine's own serialization says
 *  `opening`. One concept, one value, across BOTH producers. */
export function actualProvenanceOnProjection(projection: unknown): string[] {
  const found: string[] = [];
  const fields = new Set<string>(ACTUAL_PROVENANCE_FIELDS as readonly string[]);
  const baseKeys = new Set<string>(BASE_PERIOD_KEYS as readonly string[]);
  const walk = (node: unknown, path: string, insideBase: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, insideBase));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      const isBase = insideBase || baseKeys.has(key);
      if (fields.has(key) && !isBase) found.push(childPath);
      walk((node as Record<string, unknown>)[key], childPath, isBase);
    }
  };
  walk(projection, "$", false);
  return found;
}

export function assertNoActualProvenance(projection: unknown): void {
  const found = actualProvenanceOnProjection(projection);
  if (found.length > 0) {
    throw new Error(
      `forecastFacts: a projected figure carries an ACTUAL-provenance field ` +
        `at ${found.slice(0, 5).join(", ")}. A projection has no source cell: ` +
        `it resolves to the assumptions that produced it.`,
    );
  }
}

// ─── Reading a projection ───────────────────────────────────────────────

type RawRecord = Record<string, unknown>;

const asRecord = (x: unknown): RawRecord | null =>
  typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as RawRecord)
    : null;

const asString = (x: unknown): string => (typeof x === "string" ? x : "");

/** A finite number, or null. Booleans and NaN are ABSENT, not zero. */
const asNumber = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

const asInt = (x: unknown): number | null =>
  typeof x === "number" && Number.isInteger(x) ? x : null;

function assumptionFrom(raw: RawRecord, period: string): AssumptionRef {
  const values = asRecord(raw.values);
  const derived = raw.derived_from ?? raw.derivedFrom;
  const asked = period !== NO_PERIOD;
  return {
    id: asString(raw.id),
    label: asString(raw.label) || asString(raw.id),
    unit: asString(raw.unit),
    value: asked && values && period in values ? asNumber(values[period]) : null,
    valuedFor: asked ? period : null,
    basis: asString(raw.basis),
    derivedFrom: Array.isArray(derived) ? derived.map((d) => String(d)) : [],
  };
}

/**
 * Build a `ProjectionView` over one fp1 payload, or `null` when the payload is
 * not a projection at all.
 *
 * `null` — not a throw — for something that never claimed to be a projection:
 * a caller sweeping mixed objects should not have to catch anything. A payload
 * that DOES claim `kind: "projection"` and breaks the contract THROWS, because
 * that is a producer defect and swallowing it would serve half a projection.
 */
export function readProjection(payload: unknown): ProjectionView | null {
  const root = asRecord(payload);
  if (!root || root.kind !== PROJECTION_KIND) return null;

  if (root.contract !== FORECAST_CONTRACT_VERSION) {
    throw new Error(
      `forecastFacts: payload declares contract ${JSON.stringify(
        root.contract,
      )}; this reader speaks ${FORECAST_CONTRACT_VERSION}.`,
    );
  }
  assertNoActualProvenance(root.figures ?? []);

  const currency = asString(root.currency);
  const base = asRecord(root.base_period) ?? asRecord(root.basePeriod) ?? {};
  const basePeriodLabel = asString(base.label);
  const baseSnapshotId = asString(base.snapshot_id) || null;
  const horizon = Array.isArray(root.horizon)
    ? root.horizon.map((h) => String(h))
    : [];

  const rawAssumptions = Array.isArray(root.assumptions) ? root.assumptions : [];
  const assumptionById = new Map<string, RawRecord>();
  const assumptionOrder: string[] = [];
  for (const raw of rawAssumptions) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const id = asString(rec.id);
    if (!id) continue;
    assumptionById.set(id, rec);
    assumptionOrder.push(id);
  }

  const rawFigures = Array.isArray(root.figures) ? root.figures : [];
  const figureByKey = new Map<string, RawRecord>();
  const figureOrder: Array<[string, string]> = [];
  for (const raw of rawFigures) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const line = asString(rec.line);
    const period = asString(rec.period);
    figureByKey.set(`${line}${KEY_SEP}${period}`, rec);
    figureOrder.push([line, period]);
  }

  const basisFor = (raw: RawRecord, period: string): AssumptionRef[] => {
    const ids = raw.assumption_ids ?? raw.assumptionIds;
    if (!Array.isArray(ids)) return [];
    const out: AssumptionRef[] = [];
    for (const id of ids) {
      const declared = assumptionById.get(String(id));
      if (declared) out.push(assumptionFrom(declared, period));
    }
    return out;
  };

  const figure = (line: string, period: string): ProjectedResult => {
    if (horizon.length > 0 && !horizon.includes(period)) {
      return {
        projected: true,
        refused: true,
        line,
        period,
        code: "outside_horizon",
        detail: `the projection runs ${horizon.join(", ")}`,
      };
    }
    const raw = figureByKey.get(`${line}${KEY_SEP}${period}`);
    if (!raw) {
      return {
        projected: true,
        refused: true,
        line,
        period,
        code: "not_projected",
        detail: `this projection does not carry ${line} for ${period}`,
      };
    }
    const basis = basisFor(raw, period);
    if (basis.length === 0) {
      return {
        projected: true,
        refused: true,
        line,
        period,
        code: "no_assumptions_behind_it",
        detail:
          "the assumptions this figure names do not resolve, so the figure " +
          "is not served",
      };
    }
    const minor = asInt(raw.amount_minor ?? raw.amount_minor_projected);
    if (minor === null) {
      return {
        projected: true,
        refused: true,
        line,
        period,
        code: "not_projected",
        detail: "the figure carries no integer minor amount",
      };
    }
    return {
      kind: PROJECTION_KIND,
      projected: true,
      line,
      period,
      currency,
      formula: asString(raw.formula),
      basis,
      amountMinor: minor as unknown as ProjectedMinor,
    };
  };

  const balanceCheck: BalanceCheckRow[] = (
    Array.isArray(root.balance_check) ? root.balance_check : []
  ).flatMap((raw) => {
    const rec = asRecord(raw);
    if (!rec) return [];
    const diff = asInt(rec.difference_minor);
    return [
      {
        period: asString(rec.period),
        differenceMinor: diff,
        balances: diff === 0,
      },
    ];
  });

  const failing = new Set(
    balanceCheck.filter((r) => !r.balances).map((r) => r.period),
  );

  return {
    contract: FORECAST_CONTRACT_VERSION,
    currency,
    basePeriodLabel,
    baseSnapshotId,
    horizon,
    assumptions: assumptionOrder.map((id) =>
      // With no single period in view the driver values do not apply, and
      // ABSENT != ZERO. The refs come back with `valuedFor: null`, which is
      // the ref saying it was never asked — read `assumptionsFor(period)`
      // to get numbers.
      assumptionFrom(assumptionById.get(id) as RawRecord, NO_PERIOD),
    ),
    assumptionsFor: (period: string) =>
      assumptionOrder.map((id) =>
        assumptionFrom(assumptionById.get(id) as RawRecord, String(period)),
      ),
    balanceCheck,
    // Horizon order, never Set order: same input, same bytes.
    unbalancedPeriods: horizon.filter((p) => failing.has(p)),
    figure,
    figures: () => figureOrder.map(([line, period]) => figure(line, period)),
    lines: () =>
      Array.from(new Set(figureOrder.map(([line]) => line))).sort(),
  };
}
