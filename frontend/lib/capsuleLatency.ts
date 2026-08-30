// THE CAPSULE — LATENCY INSTRUMENT (Part A, tier 3 of 3).
//
// The Capsule's problem was never "the model is slow". It was that EVERY
// question waited on a model round-trip even when the answer was a
// lookup. You cannot fix that by believing you fixed it, so this module
// exists before the fix does: it is the ruler, and the numbers reported
// in the lane's write-up are ITS numbers, not the targets.
//
// ── What it records ───────────────────────────────────────────────────
//
//   capsule.open              the surface opened (the origin mark)
//   capsule.tier0.paint       Tier-0 first meaningful paint — a resolved
//                             fact on screen with ZERO model calls
//   capsule.tier1.factCard    the fact card painted while the model is
//                             still thinking
//   capsule.model.firstToken  the first streamed model token
//
// Every one of those is a DURATION from an earlier mark, so the module
// is two primitives (`mark` / `measure`) plus a reporter. There is no
// timer, no interval, no network, no React. It is a pure accumulator
// with a clock, which is what makes `capsuleLatency.test.ts` able to
// assert distributions instead of eyeballing a devtools waterfall.
//
// ── Three deliberate refusals ─────────────────────────────────────────
//
// R1  `measure(name, from)` on a mark that was never made returns NaN
//     and records NOTHING. Recording a 0 there would be the latency
//     equivalent of ABSENT-as-ZERO: a missing measurement would silently
//     improve the p50. NaN also fails every `< budget` comparison, so a
//     caller that forgets to mark cannot accidentally read as "fast".
// R2  `percentile([])` is NaN, not 0. An empty sample is not a fast one.
// R3  A negative duration (a clock that went backwards, or a `from` mark
//     placed after the measure) is DISCARDED rather than clamped to 0.
//
// ── Bounded by construction ───────────────────────────────────────────
//
// Samples live in a per-name ring capped at `MAX_SAMPLES`. A capsule
// that is open all day cannot grow this into a leak, and the reported
// p95 always describes the RECENT window rather than a diluted lifetime
// average.

// ─── The clock ─────────────────────────────────────────────────────────

type Clock = () => number;

/** `performance.now()` when the host has one (monotonic, sub-ms), else
 *  `Date.now()`. Resolved per call, not captured at module load: jsdom
 *  and the real browser disagree about when `performance` exists. */
function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === "function") return perf.now();
  return Date.now();
}

let clock: Clock = defaultNow;

/** TEST SEAM. Pass a deterministic clock to assert distributions without
 *  sleeping; pass null to restore the real one. Nothing in the product
 *  calls this. */
export function __setLatencyClock(fn: Clock | null): void {
  clock = fn ?? defaultNow;
}

// ─── Marks + samples ───────────────────────────────────────────────────

/** Per-name ring size. Big enough for a real p95, small enough that an
 *  all-day session cannot grow it into a leak. */
export const MAX_SAMPLES = 200;

const marks = new Map<string, number>();
const samples = new Map<string, number[]>();

/** Stamp a named instant. Re-marking the same name overwrites — a mark
 *  is "the last time this happened", which is what a per-question
 *  measurement needs. */
export function mark(name: string): void {
  if (!name) return;
  marks.set(name, clock());
}

/** Duration in ms from the `from` mark to now, recorded under `name`.
 *
 *  Returns NaN — and records nothing — when `from` was never marked (R1)
 *  or when the interval is negative (R3). Callers that compare against a
 *  budget therefore cannot read a missing measurement as a fast one. */
export function measure(name: string, from: string): number {
  if (!name) return Number.NaN;
  const started = marks.get(from);
  if (started === undefined) return Number.NaN;
  const elapsed = clock() - started;
  if (!Number.isFinite(elapsed) || elapsed < 0) return Number.NaN;
  record(name, elapsed);
  return elapsed;
}

/** Record a duration measured elsewhere (a fetch that already reports
 *  its own timing, a streamed first-token delta the transport hands
 *  back). Same refusals as `measure`. */
export function record(name: string, ms: number): void {
  if (!name || !Number.isFinite(ms) || ms < 0) return;
  const bucket = samples.get(name);
  if (!bucket) {
    samples.set(name, [ms]);
    return;
  }
  bucket.push(ms);
  if (bucket.length > MAX_SAMPLES) bucket.splice(0, bucket.length - MAX_SAMPLES);
}

/** Every recorded distribution, copied. The caller cannot mutate the
 *  accumulator by holding the result. */
export function snapshotLatency(): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [name, bucket] of samples) out[name] = bucket.slice();
  return out;
}

/** Drop every mark and every sample. Between tests, and when the capsule
 *  closes a session's worth of measurements. */
export function resetLatency(): void {
  marks.clear();
  samples.clear();
}

/** True when the named mark has been stamped since the last reset. */
export function hasMark(name: string): boolean {
  return marks.has(name);
}

// ─── The named instants ────────────────────────────────────────────────

/** The origin mark: the Capsule opened. Everything else measures from
 *  here or from `LAT_QUESTION_SUBMIT`. */
export const LAT_CAPSULE_OPEN = "capsule.open";
/** The user committed a question (Enter on the Ask row). */
export const LAT_QUESTION_SUBMIT = "capsule.question.submit";
/** Tier-0 first meaningful paint — a resolved fact on screen, no model. */
export const LAT_TIER0_PAINT = "capsule.tier0.paint";
/** Tier-1 fact card painted, before the model has said anything. */
export const LAT_TIER1_FACT_CARD = "capsule.tier1.factCard";
/** First streamed model token. */
export const LAT_FIRST_TOKEN = "capsule.model.firstToken";
/** Fact index built for the active period (the Tier-0 precondition). */
export const LAT_INDEX_BUILD = "capsule.index.build";
/** One speculative (as-you-type) resolve. */
export const LAT_SPECULATIVE = "capsule.speculative.resolve";

/** The contract this lane is held to. Budgets, not measurements — the
 *  measurements come out of `latencyReport()`, and where one misses its
 *  budget the report says so rather than the budget being moved. */
export const LATENCY_BUDGETS_MS: Readonly<Record<string, number>> = Object.freeze({
  [LAT_TIER0_PAINT]: 100,
  [LAT_TIER1_FACT_CARD]: 500,
  [LAT_FIRST_TOKEN]: 1200,
  [LAT_INDEX_BUILD]: 100,
});

// ─── Reporting ─────────────────────────────────────────────────────────

/** Nearest-rank percentile (p in 0..1). NaN on an empty sample (R2). */
export function percentile(sampleSet: readonly number[], p: number): number {
  if (!sampleSet || sampleSet.length === 0) return Number.NaN;
  const sorted = sampleSet.slice().sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const rank = Math.ceil(clamped * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export interface LatencyStat {
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** Present only for names that carry a published budget. */
  budgetMs?: number;
  /** p95 within budget. Undefined when the name has no budget. */
  withinBudget?: boolean;
}

/** The publishable distribution — one row per measured name. This is
 *  what gets pasted into the lane write-up. */
export function latencyReport(): Record<string, LatencyStat> {
  const out: Record<string, LatencyStat> = {};
  for (const [name, bucket] of samples) {
    const p95 = percentile(bucket, 0.95);
    const budgetMs = LATENCY_BUDGETS_MS[name];
    const stat: LatencyStat = {
      n: bucket.length,
      p50: percentile(bucket, 0.5),
      p95,
      max: bucket.reduce((a, b) => (b > a ? b : a), Number.NEGATIVE_INFINITY),
    };
    if (typeof budgetMs === "number") {
      stat.budgetMs = budgetMs;
      stat.withinBudget = Number.isFinite(p95) && p95 <= budgetMs;
    }
    out[name] = stat;
  }
  return out;
}

// ─── Tier-2 tool trace ─────────────────────────────────────────────────
//
// A deep answer runs several read-only tools across several periods. The
// old surface showed a spinner for all of it, which is why "slow" and
// "stuck" were indistinguishable. A trace turns the wait into a legible
// sequence — "reading Dec 2025 → comparing Dec 2024" — so the same
// elapsed time reads as progress.
//
// Steps carry i18n KEYS, never rendered copy: this module stays pure and
// the surface owns the wording.

export interface ToolTraceStep {
  /** Caller-chosen id, unique within one trace. */
  id: string;
  /** `capsuleTier0.trace.<step>` — the surface resolves it. */
  labelKey: string;
  labelParams?: Record<string, string>;
  startedAt: number;
  /** null while the step is still running. */
  endedAt: number | null;
  /** Duration once ended; NaN while running. */
  ms: number;
}

export interface ToolTrace {
  begin(id: string, labelKey: string, labelParams?: Record<string, string>): void;
  /** Closes the step and returns its duration; NaN if it was never begun
   *  or was already closed. */
  end(id: string): number;
  steps(): readonly ToolTraceStep[];
  /** Fires on every begin/end with the full step list. Returns the
   *  unsubscribe. */
  subscribe(fn: (steps: readonly ToolTraceStep[]) => void): () => void;
}

export function createToolTrace(): ToolTrace {
  const steps: ToolTraceStep[] = [];
  const listeners = new Set<(s: readonly ToolTraceStep[]) => void>();

  const emit = () => {
    const frozen = steps.map((s) => ({ ...s }));
    for (const fn of listeners) fn(frozen);
  };

  return {
    begin(id, labelKey, labelParams) {
      if (!id) return;
      steps.push({
        id,
        labelKey,
        labelParams,
        startedAt: clock(),
        endedAt: null,
        ms: Number.NaN,
      });
      emit();
    },
    end(id) {
      // Last matching OPEN step — a trace may legitimately reuse an id
      // across two passes over the same tool.
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        if (steps[i].id === id && steps[i].endedAt === null) {
          const endedAt = clock();
          const ms = endedAt - steps[i].startedAt;
          steps[i].endedAt = endedAt;
          steps[i].ms = Number.isFinite(ms) && ms >= 0 ? ms : Number.NaN;
          emit();
          return steps[i].ms;
        }
      }
      return Number.NaN;
    },
    steps() {
      return steps.map((s) => ({ ...s }));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
