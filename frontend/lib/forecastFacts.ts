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

// plan/2 B6: the wire speaks fp1.2 (plan_contract_v2 section 3). This constant,
// engine.forecast_serving.contract.PLAN_CONTRACT_VERSION and the route changed
// in ONE commit; GET /api/forecast/{id} and POST .../recompute serve nothing else.
export const FORECAST_CONTRACT_VERSION = "fp1.2";

/** The six tiers a driver's default can stand on (3.3). Rendered as a chip
 *  beside every driver; never inferred from sentence text. */
export const DRIVER_TIERS = [
  "book", "sector", "macro", "user", "convention", "absent",
] as const;
export type DriverTier = (typeof DRIVER_TIERS)[number];
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
  // fp1.2: an index driver (volume, price, input price, pool level); 1 is the
  // anchor level.
  "index",
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
  /** fp1.2 (3.3): the tier the served value stands on; null for a convention. */
  readonly tier: DriverTier | null;
  /** fp1.2 (12): the engine's sentence when moving this driver changes no
   *  figure of this plan; null when it is live. */
  readonly inert: string | null;
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

// ─── v1.5: the blocks the page reads besides `figures` ──────────────────
//
// `strip`, `series`, `summary`, `client` and `history` have been on the wire
// since fp1.2 and no reader read them, which is why the page had no strip, no
// charts and no levers while the engine was already serving all three. NOTHING
// NEW IS COMPUTED HERE. Every amount below is an engine-served figure and comes
// back as a `ProjectedResult` — the same union the statement table paints — so a
// chart axis and a strip headline go through `<ProjectedAmount>` exactly as a
// table cell does, and a refused one paints its own sentence rather than a zero.

/** One point of a served chart series. `result` is a figure or the engine's
 *  own refusal at that period — on a partial refusal the engine serves three
 *  keys at the cut and nothing after it (6.5), and a chart must show that
 *  break rather than smoothing over it. */
export interface SeriesPoint {
  readonly period: string;
  readonly result: ProjectedResult;
}

/** A served amount that may instead be a standing refusal — `strip
 *  .first_breach_period` and `strip.dcf_ev` are refusals in this build, by
 *  the engine's own decision, and the page renders the engine's words. */
export interface StripSlot {
  readonly result: ProjectedResult;
  /** The period the figure belongs to, when the slot names one (the peak
   *  funding gap does). `null` is a real answer for a plan with no draw. */
  readonly period: string | null;
}

export interface StripView {
  readonly peakFundingGap: StripSlot;
  readonly cumulativeFcf: StripSlot;
  readonly closingCash: StripSlot;
  /** Both standing refusals in this build (B8/B12). Rendered as the engine's
   *  sentence; "none in horizon" would be an absent read as a negative. */
  readonly firstBreachPeriod: StripSlot;
  readonly dcfEv: StripSlot;
}

export interface SummaryView {
  readonly cashTrough: StripSlot;
  readonly firstShortfallPeriod: string | null;
  readonly firstShortfallAmount: ProjectedResult | null;
  /** The periods the plan stands on the funding line — the shaded band of the
   *  cash curve. Served, never derived from the revolver series here. */
  readonly fundingGapPeriods: readonly string[];
  readonly fundingInterestTotal: ProjectedResult | null;
  readonly fundingRateSentence: string;
  readonly runwaySentence: string;
  /** plan/2 B13: the served runway count (6.6) — whole monthly periods before
   *  cash first reaches the floor — and whether it is `exact` or an
   *  `at_least` bound. `null` when not served; never defaulted to a number. */
  readonly runwayMonths: number | null;
  readonly runwayBound: "exact" | "at_least" | null;
}

/** fp1.2 `client`: the pack's own latency numbers and the levers it does NOT
 *  serve, each with its sentence. Typing 300 on the page instead of reading
 *  `debounce_ms` would be a cut-off written as prose (TC-10). */
export interface ClientView {
  readonly debounceMs: number;
  readonly analysisDebounceMs: number;
  readonly unserved: readonly { key: string; sentence: string }[];
}

/** fp1.2 `history` (B7): every candidate prior period the engine considered,
 *  with the verdict it left. `held` is what the growth was measured from. */
export interface HistoryView {
  readonly held: readonly HistoryRow[];
  readonly eligible: readonly HistoryRow[];
  readonly excluded: readonly HistoryRow[];
}

export interface HistoryRow {
  readonly periodId: string;
  readonly label: string;
  readonly sentence: string;
}

/** One book fact a driver was fitted on — for revenue growth, the two
 *  turnovers. `valueMinor` is a plain number and NOT a `ProjectedMinor`: it is
 *  an ACTUAL the engine measured, quoted inside the driver's basis, and the
 *  engine already writes it into the basis sentence. */
export interface BookInput {
  readonly fact: string;
  readonly periodEnd: string;
  readonly valueMinor: number | null;
  /** The same figure in MAJOR units, converted here at the gateway edge —
   *  exactly like `projectedDisplay`'s single division — so a surface that
   *  shows a book input formats it and computes nothing. */
  readonly value: number | null;
}

export interface LeverBasisView {
  readonly tier: DriverTier | null;
  readonly sentence: string;
  readonly bookMethod: string | null;
  readonly bookInputs: readonly BookInput[];
  readonly bookPeriodsUsed: readonly string[];
  /** Each rung the ladder tried and what happened — the honest answer when
   *  the page is asked "why is this tier and not book?". */
  readonly fallbackSteps: readonly {
    tier: string;
    outcome: string;
    reason: string;
  }[];
}

/** What the lever this driver is reset TO stands on. `values` are exact
 *  decimal strings in the driver's own natural unit, ready to be sent back. */
export interface LeverAlternativeView {
  readonly tier: DriverTier;
  readonly values: readonly string[];
  readonly sentence: string;
}

/** ONE LEVER, as the engine declares it.
 *
 *  Separate from `AssumptionRef` on purpose: `AssumptionRef` is what a FIGURE
 *  resolves to and it rides inside every `ProjectedMarker`, so widening it
 *  with control metadata would put slider bounds inside every painted number's
 *  provenance. A lever is a different question about the same driver. */
export interface LeverRef {
  readonly key: string;
  readonly label: string;
  /** The display unit, and the divisor that turns the served integer into it.
   *  Both from the wire (`WIRE_UNITS`); the page invents no second table. */
  readonly unit: AssumptionUnit | string;
  readonly scale: number;
  readonly shape: "scalar" | "per_year" | string;
  /** Per plan year (or one entry when `shape` is scalar), in natural units. */
  readonly values: readonly (number | null)[];
  /** The same values as EXACT decimal strings, which is what the request body
   *  takes — the engine refuses "1e-1" and anything not exact at the unit's
   *  own scale (3.12: no float ever enters the engine). */
  readonly valueTexts: readonly (string | null)[];
  readonly bounds: { readonly minText: string | null; readonly maxText: string | null };
  readonly stepText: string | null;
  readonly setVia: string;
  readonly allowedOps: readonly string[];
  readonly panel: string | null;
  readonly railGroup: string | null;
  readonly favourableDirection: string | null;
  readonly inert: string | null;
  readonly basis: LeverBasisView;
  /** fp1.2: the WHOLE pre-user basis, served the moment a user sets the
   *  lever. Reset-to-book needs no extra wire field — it is dropping the
   *  override and re-POSTing, and this is what the value goes back to. */
  readonly original: { values: readonly string[]; basis: LeverBasisView } | null;
  readonly alternatives: readonly LeverAlternativeView[];
}

export interface ProjectionView {
  readonly contract: typeof FORECAST_CONTRACT_VERSION;
  readonly currency: string;
  readonly basePeriodLabel: string;
  readonly baseSnapshotId: string | null;
  readonly horizon: readonly string[];
  /** fp1.2 (3.6): the FY aggregate labels of the monthly plan years. Served
   *  totals; the browser never sums months (F2). */
  readonly horizonAnnual: readonly string[];
  /** fp1.2 (6.5): the last period served; earlier than the horizon's end
   *  only on a partial refusal. */
  readonly servedThrough: string | null;
  readonly bodyHash: string | null;
  readonly refusal: { fromPeriod: string; sentence: string } | null;
  readonly notes: readonly string[];
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
  /** v1.5. The four blocks the page's strip, charts and levers stand on. */
  readonly strip: StripView;
  readonly summary: SummaryView;
  readonly client: ClientView;
  readonly history: HistoryView;
  /** The served keys of `series`, sorted. */
  seriesKeys(): readonly string[];
  /** One served chart series. An unknown key is an EMPTY array — the caller
   *  asked about something this build does not serve (`dscr` until B8), and
   *  a chart with no points renders its own "not served" rather than a flat
   *  line at zero. */
  series(key: string): readonly SeriesPoint[];
  /** The levers, in `driver_order`. Conventions are not levers. */
  readonly levers: readonly LeverRef[];
  lever(key: string): LeverRef | null;
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
  // fp1.2 (plan/2 B6): a figure's kind, or (driver_ids, amount) when a
  // serializer stripped the kind. Mirrors boundary._is_projection_node.
  if (o.kind === "projected" || o.kind === "projected_aggregate") return true;
  if ("driver_ids" in o && ("amount_minor" in o || "value_micros" in o)) return true;
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

/** fp1.2 DRIVER.unit -> the display unit and the divisor that turns the
 *  served integer into it. A unit conversion for display, never arithmetic
 *  BETWEEN served values (F2). */
const WIRE_UNITS: Record<string, [AssumptionUnit, number]> = {
  ratio_micros: ["ratio", 1_000_000],
  index_micros: ["index", 1_000_000],
  micro_days: ["days", 1_000_000],
  // A MONEY DRIVER'S NATURAL UNIT IS THE MAJOR ONE — `min_cash` at 12,000,000
  // rides the wire as 1,200,000,000 minor and the engine takes "12000000"
  // back. This divisor was 1, which left the surface to divide by 100 on its
  // own (it did) and left a lever control sending a hundredfold value (it
  // would have). One divisor, at the gateway, for both readers.
  money_minor: ["money_minor", 100],
};

const sentenceText = (x: unknown): string => asString(asRecord(x)?.text);

/** One served DRIVER (3.2), valued for `period` through horizon.year_of. */
function driverRef(
  raw: RawRecord,
  period: string,
  yearOf: RawRecord,
): AssumptionRef {
  const asked = period !== NO_PERIOD;
  const [unit, divisor] = WIRE_UNITS[asString(raw.unit)] ?? [asString(raw.unit), 1];
  const values = Array.isArray(raw.values) ? raw.values : [];
  let value: number | null = null;
  if (asked) {
    const year = asInt(yearOf[period]);
    const index = raw.shape === "scalar" ? 0 : year === null ? -1 : year - 1;
    const served = index >= 0 ? asInt(values[index]) : null;
    value = served === null ? null : served / divisor;
  }
  const basis = asRecord(raw.basis) ?? {};
  const book = asRecord(basis.book);
  const inputs = book && Array.isArray(book.inputs) ? book.inputs : [];
  const tier = asString(basis.tier);
  return {
    id: asString(raw.key),
    label: sentenceText(raw.label) || asString(raw.key),
    unit,
    value,
    valuedFor: asked ? period : null,
    basis: sentenceText(basis.sentence),
    derivedFrom: inputs.map((i) => asString(asRecord(i)?.fact)).filter(Boolean),
    tier: (DRIVER_TIERS as readonly string[]).includes(tier)
      ? (tier as DriverTier)
      : null,
    inert: sentenceText(raw.inert_in_this_plan) || null,
  };
}

/** An integer at a stated scale as its EXACT decimal string.
 *
 *  Integer string arithmetic, never `value / scale` back into a decimal: the
 *  engine refuses a value that is not exact at the driver's own scale, and
 *  `(46213147 / 1e6).toString()` is an IEEE-754 result being asked to round
 *  trip through a contract that forbids floats. 28045424 at 1e6 is
 *  "28.045424", and that is what goes back on the wire. */
export function exactDecimal(value: number, scale: number): string {
  if (!Number.isInteger(value) || !Number.isInteger(scale) || scale < 1) return "";
  if (scale === 1) return String(value);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const digits = String(scale).length - 1;
  const whole = Math.floor(abs / scale);
  const frac = String(abs - whole * scale).padStart(digits, "0").replace(/0+$/, "");
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

const bookInputsOf = (book: RawRecord | null): BookInput[] => {
  const inputs = book && Array.isArray(book.inputs) ? book.inputs : [];
  return inputs.flatMap((i) => {
    const rec = asRecord(i);
    if (!rec) return [];
    const minor = asInt(rec.value_minor);
    return [
      {
        fact: asString(rec.fact),
        periodEnd: asString(rec.period_end),
        valueMinor: minor,
        value: minor === null ? null : minor / 100,
      },
    ];
  });
};

function leverBasis(basis: RawRecord): LeverBasisView {
  const book = asRecord(basis.book);
  const tier = asString(basis.tier);
  return {
    tier: (DRIVER_TIERS as readonly string[]).includes(tier)
      ? (tier as DriverTier)
      : null,
    sentence: sentenceText(basis.sentence),
    bookMethod: book ? asString(book.method) || null : null,
    bookInputs: bookInputsOf(book),
    bookPeriodsUsed:
      book && Array.isArray(book.periods_used)
        ? book.periods_used.map((p) => String(p))
        : [],
    fallbackSteps: (Array.isArray(basis.fallback_steps) ? basis.fallback_steps : [])
      .flatMap((s) => {
        const rec = asRecord(s);
        if (!rec) return [];
        return [
          {
            tier: asString(rec.tier),
            outcome: asString(rec.outcome),
            reason: sentenceText(rec.reason),
          },
        ];
      }),
  };
}

/** One served DRIVER read as a CONTROL. Same record as `driverRef`, different
 *  question: that one asks what a figure resolves to, this one asks what the
 *  reader may move and what it goes back to. */
function leverRef(raw: RawRecord): LeverRef {
  const wire = asString(raw.unit);
  const [unit, scale] = WIRE_UNITS[wire] ?? [wire, 1];
  const served = Array.isArray(raw.values) ? raw.values : [];
  const ints = served.map((v) => asInt(v));
  const basis = asRecord(raw.basis) ?? {};
  const original = asRecord(basis.original);
  const alternatives = asRecord(raw.alternatives) ?? {};
  const alts: LeverAlternativeView[] = [];
  for (const tier of DRIVER_TIERS) {
    const alt = asRecord(alternatives[tier]);
    if (!alt) continue;
    const altBasis = asRecord(alt.basis) ?? {};
    alts.push({
      tier,
      values: (Array.isArray(alt.values) ? alt.values : []).map((v) => {
        const i = asInt(v);
        return i === null ? "" : exactDecimal(i, scale);
      }),
      sentence: sentenceText(altBasis.sentence),
    });
  }
  const bounds = asRecord(raw.bounds) ?? {};
  return {
    key: asString(raw.key),
    label: sentenceText(raw.label) || asString(raw.key),
    unit,
    scale,
    shape: asString(raw.shape),
    values: ints.map((v) => (v === null ? null : v / scale)),
    valueTexts: ints.map((v) => (v === null ? null : exactDecimal(v, scale))),
    bounds: {
      minText: typeof bounds.min === "string" ? bounds.min : null,
      maxText: typeof bounds.max === "string" ? bounds.max : null,
    },
    stepText: typeof raw.reach_step === "string" ? raw.reach_step : null,
    setVia: asString(raw.set_via),
    allowedOps: (Array.isArray(raw.allowed_ops) ? raw.allowed_ops : []).map((o) =>
      String(o),
    ),
    panel: asString(raw.panel) || null,
    railGroup: asString(raw.rail_group) || null,
    favourableDirection: asString(raw.favourable_direction) || null,
    inert: sentenceText(raw.inert_in_this_plan) || null,
    basis: leverBasis(basis),
    original: original
      ? {
          values: (Array.isArray(original.values) ? original.values : []).map((v) => {
            const i = asInt(v);
            return i === null ? "" : exactDecimal(i, scale);
          }),
          basis: leverBasis(asRecord(original.basis) ?? {}),
        }
      : null,
    alternatives: alts,
  };
}

function conventionRef(raw: RawRecord, period: string): AssumptionRef {
  return {
    id: asString(raw.id),
    label: asString(raw.id).replace(/_/g, " "),
    unit: "convention",
    value: null,
    valuedFor: period !== NO_PERIOD ? period : null,
    basis: asString(raw.sentence),
    derivedFrom: [],
    tier: null,
    inert: null,
  };
}

/** 3.14: the one TypeScript reader of a GET /api/period payload's snapshot
 *  id: statements.assembled_canonical_v1.provenance.content_hash, else
 *  source_document_id (the rule of FactsGateway._snapshot_id_of). */
export function periodPayloadSnapshotId(payload: unknown): string | null {
  const statements = asRecord(asRecord(payload)?.statements);
  const provenance = asRecord(
    asRecord(statements?.assembled_canonical_v1)?.provenance,
  );
  if (!provenance) return null;
  return (
    asString(provenance.content_hash) ||
    asString(provenance.source_document_id) ||
    null
  );
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
  const horizonBlock = asRecord(root.horizon) ?? {};
  const horizon = Array.isArray(horizonBlock.labels)
    ? horizonBlock.labels.map((h) => String(h))
    : [];
  const horizonAnnual = Array.isArray(horizonBlock.labels_annual)
    ? horizonBlock.labels_annual.map((h) => String(h))
    : [];
  const yearOf = asRecord(horizonBlock.year_of) ?? {};
  const servedThrough = asString(horizonBlock.served_through) || null;

  // drivers in driver_order, then conventions: every id a figure may name.
  const drivers = asRecord(root.drivers) ?? {};
  const conventions = asRecord(root.conventions) ?? {};
  const assumptionById = new Map<string, (period: string) => AssumptionRef>();
  const assumptionOrder: string[] = [];
  const order = Array.isArray(root.driver_order) ? root.driver_order : [];
  for (const key of order) {
    const rec = asRecord(drivers[String(key)]);
    if (!rec) continue;
    assumptionById.set(String(key), (p) => driverRef(rec, p, yearOf));
    assumptionOrder.push(String(key));
  }
  for (const id of Object.keys(conventions).sort()) {
    const rec = asRecord(conventions[id]);
    if (!rec) continue;
    assumptionById.set(id, (p) => conventionRef(rec, p));
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
    const ids = raw.driver_ids;
    if (!Array.isArray(ids)) return [];
    const out: AssumptionRef[] = [];
    for (const id of ids) {
      const declared = assumptionById.get(String(id));
      if (declared) out.push(declared(period));
    }
    return out;
  };

  /** One served amount block -> a figure or the engine's own refusal.
   *
   *  `figures[]` rows, `series` points, `strip` slots and `summary` amounts
   *  are the SAME shape on the wire — `{amount_minor, driver_ids, formula}` or
   *  `{refused:{code,text}}` — so they are read by one function. A second
   *  reader for the strip is how a hand-composed block drifts from the
   *  engine's own (B6RV2-5, which cost the cash curve a hole). */
  const amountOf = (
    raw: RawRecord,
    line: string,
    period: string,
  ): ProjectedResult => {
    const refusedBy = asRecord(raw.refused);
    if (refusedBy) {
      // 6.5: a period the partial serve does not reach, or a slot this build
      // does not serve at all. The engine's sentence, verbatim; never a zero.
      return {
        projected: true,
        refused: true,
        line,
        period,
        code: "not_projected",
        detail: asString(refusedBy.text),
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
    const minor = asInt(raw.amount_minor);
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

  const figure = (line: string, period: string): ProjectedResult => {
    if (
      horizon.length > 0 &&
      !horizon.includes(period) &&
      !horizonAnnual.includes(period)
    ) {
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
    return amountOf(raw, line, period);
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

  // ── v1.5 blocks ───────────────────────────────────────────────────────

  /** The period a headline figure belongs to when the slot names none. The
   *  last period the engine actually SERVED, not the last one asked for: on a
   *  partial refusal those differ, and a closing-cash headline stamped with a
   *  period the plan never reached is a figure wearing the wrong date. */
  const lastServed = servedThrough || horizon[horizon.length - 1] || "";

  const slot = (raw: unknown, line: string, period: string | null): StripSlot => {
    const rec = asRecord(raw);
    if (!rec) {
      return {
        result: {
          projected: true,
          refused: true,
          line,
          period: period ?? lastServed,
          code: "not_projected",
          detail: `this projection does not carry ${line}`,
        },
        period,
      };
    }
    // `{amount: {...}, period: ...}` (the peak gap, the trough) or a bare
    // amount block. The nested period is the engine's, never inferred.
    const nested = asRecord(rec.amount);
    const at =
      "period" in rec ? (asString(rec.period) || null) : period;
    const body = nested ?? rec;
    return { result: amountOf(body, line, at ?? lastServed), period: at };
  };

  const stripRaw = asRecord(root.strip) ?? {};
  const strip: StripView = {
    peakFundingGap: slot(stripRaw.peak_funding_gap, "strip.peak_funding_gap", null),
    cumulativeFcf: slot(stripRaw.cumulative_fcf, "strip.cumulative_fcf", lastServed),
    closingCash: slot(stripRaw.closing_cash, "strip.closing_cash", lastServed),
    firstBreachPeriod: slot(
      stripRaw.first_breach_period,
      "strip.first_breach_period",
      null,
    ),
    dcfEv: slot(stripRaw.dcf_ev, "strip.dcf_ev", null),
  };

  const summaryRaw = asRecord(root.summary) ?? {};
  const runway = asRecord(summaryRaw.runway) ?? {};
  const firstShortfallPeriod = asString(summaryRaw.first_shortfall_period) || null;
  const summary: SummaryView = {
    cashTrough: slot(summaryRaw.cash_trough, "summary.cash_trough", null),
    firstShortfallPeriod,
    firstShortfallAmount: asRecord(summaryRaw.first_shortfall_amount)
      ? amountOf(
          asRecord(summaryRaw.first_shortfall_amount) as RawRecord,
          "summary.first_shortfall_amount",
          firstShortfallPeriod ?? lastServed,
        )
      : null,
    fundingGapPeriods: (Array.isArray(summaryRaw.funding_gap_periods)
      ? summaryRaw.funding_gap_periods
      : []
    ).map((p) => String(p)),
    fundingInterestTotal: asRecord(summaryRaw.funding_interest_total)
      ? amountOf(
          asRecord(summaryRaw.funding_interest_total) as RawRecord,
          "summary.funding_interest_total",
          lastServed,
        )
      : null,
    fundingRateSentence: sentenceText(
      asRecord(summaryRaw.funding_rate_basis)?.sentence,
    ),
    runwaySentence: sentenceText(runway.sentence),
    runwayMonths: asInt(runway.months),
    runwayBound:
      runway.bound === "exact" || runway.bound === "at_least" ? runway.bound : null,
  };

  const seriesRaw = asRecord(root.series) ?? {};
  const seriesByKey = new Map<string, SeriesPoint[]>();
  for (const key of Object.keys(seriesRaw)) {
    const points = Array.isArray(seriesRaw[key]) ? (seriesRaw[key] as unknown[]) : [];
    seriesByKey.set(
      key,
      points.flatMap((p) => {
        const rec = asRecord(p);
        if (!rec) return [];
        const at = asString(rec.period);
        return [{ period: at, result: amountOf(rec, `series.${key}`, at) }];
      }),
    );
  }

  const clientRaw = asRecord(root.client) ?? {};
  const client: ClientView = {
    // The pack's own latency, read from the payload. A hand-typed 300 here
    // would be a cut-off written as prose (TC-10).
    debounceMs: asInt(clientRaw.debounce_ms) ?? 0,
    analysisDebounceMs: asInt(clientRaw.analysis_debounce_ms) ?? 0,
    unserved: (Array.isArray(clientRaw.unserved) ? clientRaw.unserved : []).flatMap(
      (u) => {
        const rec = asRecord(u);
        if (!rec) return [];
        return [{ key: asString(rec.key), sentence: sentenceText(rec.sentence) }];
      },
    ),
  };

  const historyRaw = asRecord(root.history) ?? {};
  const historyRows = (bucket: unknown): HistoryRow[] =>
    (Array.isArray(bucket) ? bucket : []).flatMap((r) => {
      const rec = asRecord(r);
      if (!rec) return [];
      return [
        {
          periodId: asString(rec.period_id) || asString(rec.id),
          label: asString(rec.label) || asString(rec.period_end),
          sentence: sentenceText(rec.reason) || sentenceText(rec.sentence),
        },
      ];
    });
  const history: HistoryView = {
    held: historyRows(historyRaw.held),
    eligible: historyRows(historyRaw.eligible),
    excluded: historyRows(historyRaw.excluded),
  };

  const leverByKey = new Map<string, LeverRef>();
  const leverOrder: string[] = [];
  for (const key of order) {
    const rec = asRecord(drivers[String(key)]);
    if (!rec) continue;
    leverByKey.set(String(key), leverRef(rec));
    leverOrder.push(String(key));
  }

  return {
    contract: FORECAST_CONTRACT_VERSION,
    currency,
    basePeriodLabel,
    baseSnapshotId,
    horizon,
    horizonAnnual,
    servedThrough,
    bodyHash: asString(root.body_hash) || null,
    refusal: (() => {
      const r = asRecord(root.refusal);
      return r
        ? { fromPeriod: asString(r.from_period), sentence: sentenceText(r.sentence) }
        : null;
    })(),
    notes: (Array.isArray(root.notes) ? root.notes : [])
      .map((n) => sentenceText(n))
      .filter(Boolean),
    assumptions: assumptionOrder.map((id) =>
      // With no single period in view the driver values do not apply, and
      // ABSENT != ZERO. The refs come back with `valuedFor: null`, which is
      // the ref saying it was never asked — read `assumptionsFor(period)`
      // to get numbers.
      (assumptionById.get(id) as (p: string) => AssumptionRef)(NO_PERIOD),
    ),
    assumptionsFor: (period: string) =>
      assumptionOrder.map((id) =>
        (assumptionById.get(id) as (p: string) => AssumptionRef)(String(period)),
      ),
    balanceCheck,
    // Horizon order, never Set order: same input, same bytes.
    unbalancedPeriods: horizon.filter((p) => failing.has(p)),
    figure,
    figures: () => figureOrder.map(([line, period]) => figure(line, period)),
    lines: () =>
      Array.from(new Set(figureOrder.map(([line]) => line))).sort(),
    strip,
    summary,
    client,
    history,
    seriesKeys: () => Array.from(seriesByKey.keys()).sort(),
    // A key this build does not serve comes back EMPTY, never as a zero
    // line: `dscr` is absent until B8 and a chart drawn flat along the axis
    // would be the page inventing a ratio the engine refused to state.
    series: (key: string) => seriesByKey.get(key) ?? [],
    levers: leverOrder.map((k) => leverByKey.get(k) as LeverRef),
    lever: (key: string) => leverByKey.get(key) ?? null,
  };
}

// ── plan/2 B13 (minimal cut): the Scenarios page's one question of a value ──
//
// The Scenarios page paints served figures side by side and computes nothing.
// It asks exactly one thing of a projected value, and it asks it HERE, at the
// gateway, so no surface ever holds the bare number: is the served cash below
// zero? The engine floors cash at `min_cash` and draws the funding line for
// the shortfall (plan_contract_v2 6.4, S3), so a negative served cash is an
// engine defect — and the page must then paint the funding line it served,
// never a negative cash balance (defect 0.3).

/** The sign of a served projected figure: -1, 0 or 1. `null` for a refusal,
 *  which carries no number and therefore no sign — ABSENT is not zero. */
export function projectedSign(result: ProjectedResult): -1 | 0 | 1 | null {
  if (!isProjectedFigure(result)) return null;
  const minor = result.amountMinor as unknown as number;
  if (typeof minor !== "number" || !Number.isFinite(minor)) return null;
  return minor < 0 ? -1 : minor > 0 ? 1 : 0;
}
// ── end plan/2 B13 ─────────────────────────────────────────────────────────
