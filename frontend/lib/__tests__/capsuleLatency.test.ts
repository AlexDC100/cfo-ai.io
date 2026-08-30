// THE CAPSULE — LATENCY GATE (A3), and the lane's published numbers.
//
// Two jobs, deliberately in one file.
//
// FIRST, the instrument is tested like any other module: the refusals
// (NaN over a missing mark, NaN over an empty sample, a discarded
// negative interval), the ring cap, the percentiles, the tool trace.
// An instrument nobody has tested is a number generator.
//
// SECOND — and this is the part that matters — the instrument is USED,
// against the same two REAL served periods the other suites run on, and
// the resulting distribution is PRINTED. The lane's write-up quotes
// these lines, not the targets.
//
// ── What this file can and cannot measure ────────────────────────────
//
// It measures, for real, in-process:
//   · fact-index build      (the Tier-0 precondition)
//   · Tier-0 resolve        (the compute half of Tier-0 first paint)
//   · speculative resolve   (the as-you-type prefetch)
//
// It CANNOT measure, and does not pretend to:
//   · Tier-0 first meaningful PAINT — resolve + React commit + browser
//     paint. This file has no DOM commit and no compositor, so it
//     reports the resolve component and says so. The paint component is
//     the surface lane's to record with the same `mark`/`measure` calls.
//   · Tier-1 fact-card paint and first model token. There is no model in
//     this lane. The hooks are published (`LAT_TIER1_FACT_CARD`,
//     `LAT_FIRST_TOKEN`) and the budget table carries their numbers, but
//     NOTHING here has exercised them. Reported as UNMEASURED rather
//     than inferred from the budget — a target is not evidence.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  mark,
  measure,
  record,
  hasMark,
  snapshotLatency,
  resetLatency,
  percentile,
  latencyReport,
  createToolTrace,
  __setLatencyClock,
  MAX_SAMPLES,
  LATENCY_BUDGETS_MS,
  LAT_CAPSULE_OPEN,
  LAT_TIER0_PAINT,
  LAT_TIER1_FACT_CARD,
  LAT_FIRST_TOKEN,
  LAT_INDEX_BUILD,
  LAT_SPECULATIVE,
} from "@/lib/capsuleLatency";
import { buildFactIndex } from "@/lib/capsuleFactIndex";
import { resolveTier0, createSpeculativeResolver } from "@/lib/capsuleTier0";
import { CAPSULE_ASK_CORPUS } from "@/lib/capsuleAskCorpus";
import type { Statements } from "@/lib/financialReport";

import carniprodJson from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";
import retailJson from "./fixtures/capsuleTier0/period_retail_fy2024.json";

const carniprod = carniprodJson as unknown as Statements;
const retail = retailJson as unknown as Statements;

const snapshot = () => ({
  activePeriodId: "p-2025",
  periods: [
    { periodId: "p-2025", periodLabel: "FY 2025", statements: carniprod, docId: "d1" },
    { periodId: "p-2024", periodLabel: "FY 2024", statements: retail, docId: "d2" },
  ],
});

// ══════════════════════════════════════════════════════════════════════
// The instrument
// ══════════════════════════════════════════════════════════════════════

describe("marks and measures", () => {
  let t = 0;
  beforeEach(() => {
    resetLatency();
    t = 0;
    __setLatencyClock(() => t);
  });
  afterEach(() => __setLatencyClock(null));

  it("measures the interval between a mark and now", () => {
    mark(LAT_CAPSULE_OPEN);
    t = 42;
    expect(measure(LAT_TIER0_PAINT, LAT_CAPSULE_OPEN)).toBe(42);
    expect(snapshotLatency()[LAT_TIER0_PAINT]).toEqual([42]);
  });

  it("R1 — a missing origin mark is NaN and records nothing", () => {
    const result = measure(LAT_TIER0_PAINT, "capsule.never.marked");
    expect(Number.isNaN(result)).toBe(true);
    expect(snapshotLatency()[LAT_TIER0_PAINT]).toBeUndefined();
    // The point of NaN: a forgotten mark cannot read as fast.
    expect(result < LATENCY_BUDGETS_MS[LAT_TIER0_PAINT]).toBe(false);
  });

  it("R3 — a backwards clock is discarded, not clamped to zero", () => {
    t = 100;
    mark(LAT_CAPSULE_OPEN);
    t = 40;
    expect(Number.isNaN(measure(LAT_TIER0_PAINT, LAT_CAPSULE_OPEN))).toBe(true);
    expect(snapshotLatency()[LAT_TIER0_PAINT]).toBeUndefined();
  });

  it("re-marking overwrites — a mark is 'the last time this happened'", () => {
    mark(LAT_CAPSULE_OPEN);
    t = 10;
    mark(LAT_CAPSULE_OPEN);
    t = 15;
    expect(measure(LAT_TIER0_PAINT, LAT_CAPSULE_OPEN)).toBe(5);
  });

  it("hasMark and resetLatency", () => {
    mark(LAT_CAPSULE_OPEN);
    expect(hasMark(LAT_CAPSULE_OPEN)).toBe(true);
    resetLatency();
    expect(hasMark(LAT_CAPSULE_OPEN)).toBe(false);
    expect(snapshotLatency()).toEqual({});
  });

  it("rejects a non-finite or negative recorded duration", () => {
    record(LAT_FIRST_TOKEN, Number.NaN);
    record(LAT_FIRST_TOKEN, -1);
    record(LAT_FIRST_TOKEN, Number.POSITIVE_INFINITY);
    expect(snapshotLatency()[LAT_FIRST_TOKEN]).toBeUndefined();
  });

  it("keeps the ring bounded at MAX_SAMPLES, newest wins", () => {
    for (let i = 0; i < MAX_SAMPLES + 50; i += 1) record(LAT_FIRST_TOKEN, i);
    const bucket = snapshotLatency()[LAT_FIRST_TOKEN];
    expect(bucket).toHaveLength(MAX_SAMPLES);
    expect(bucket[bucket.length - 1]).toBe(MAX_SAMPLES + 49);
    expect(bucket[0]).toBe(50);
  });

  it("snapshot is a copy — a caller cannot mutate the accumulator", () => {
    record(LAT_FIRST_TOKEN, 5);
    snapshotLatency()[LAT_FIRST_TOKEN].push(9999);
    expect(snapshotLatency()[LAT_FIRST_TOKEN]).toEqual([5]);
  });
});

describe("percentiles", () => {
  it("R2 — an empty sample is NaN, not zero", () => {
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it("nearest-rank, and stable under input order", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(100);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values.slice().reverse(), 0.5)).toBe(50);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("latencyReport", () => {
  beforeEach(() => resetLatency());

  it("marks a budgeted name as within or over budget", () => {
    for (const ms of [10, 20, 30]) record(LAT_TIER0_PAINT, ms);
    for (const ms of [900, 1500, 3000]) record(LAT_FIRST_TOKEN, ms);
    const report = latencyReport();
    expect(report[LAT_TIER0_PAINT].budgetMs).toBe(100);
    expect(report[LAT_TIER0_PAINT].withinBudget).toBe(true);
    expect(report[LAT_FIRST_TOKEN].withinBudget).toBe(false);
    expect(report[LAT_FIRST_TOKEN].p50).toBe(1500);
  });

  it("omits budget fields for a name that has none", () => {
    record("capsule.custom", 5);
    expect(latencyReport()["capsule.custom"].budgetMs).toBeUndefined();
    expect(latencyReport()["capsule.custom"].withinBudget).toBeUndefined();
  });
});

describe("tool trace — Tier-2 legibility", () => {
  let t = 0;
  beforeEach(() => { t = 0; __setLatencyClock(() => t); });
  afterEach(() => __setLatencyClock(null));

  it("records a sequence and notifies subscribers on every transition", () => {
    const trace = createToolTrace();
    const frames: number[] = [];
    trace.subscribe((steps) => frames.push(steps.length));

    trace.begin("read-2025", "capsuleTier0.trace.reading", { period: "FY 2025" });
    t = 30;
    expect(trace.end("read-2025")).toBe(30);
    trace.begin("compare", "capsuleTier0.trace.comparing", { period: "FY 2024" });
    t = 45;
    trace.end("compare");

    const steps = trace.steps();
    expect(steps.map((s) => s.id)).toEqual(["read-2025", "compare"]);
    expect(steps[0].labelKey).toBe("capsuleTier0.trace.reading");
    expect(steps[0].labelParams).toEqual({ period: "FY 2025" });
    expect(steps[1].ms).toBe(15);
    expect(frames).toEqual([1, 1, 2, 2]);
  });

  it("a step still running has endedAt null and ms NaN", () => {
    const trace = createToolTrace();
    trace.begin("open", "capsuleTier0.trace.reading");
    expect(trace.steps()[0].endedAt).toBeNull();
    expect(Number.isNaN(trace.steps()[0].ms)).toBe(true);
  });

  it("ending an unknown or already-closed step is NaN, never a fake zero", () => {
    const trace = createToolTrace();
    expect(Number.isNaN(trace.end("nope"))).toBe(true);
    trace.begin("x", "k");
    trace.end("x");
    expect(Number.isNaN(trace.end("x"))).toBe(true);
  });

  it("unsubscribe stops the notifications", () => {
    const trace = createToolTrace();
    let calls = 0;
    const off = trace.subscribe(() => { calls += 1; });
    trace.begin("a", "k");
    off();
    trace.begin("b", "k");
    expect(calls).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE PUBLISHED DISTRIBUTION
// ══════════════════════════════════════════════════════════════════════

describe("measured latency — the lane's published numbers", () => {
  it("builds the index and resolves the fixture set, and prints the spread", () => {
    resetLatency();
    __setLatencyClock(null);   // the REAL clock; these are real numbers

    // Warm the JIT so the first sample is not the only slow one; the
    // reported distribution should describe the steady state a user is
    // actually in, not the very first interaction of a cold process.
    for (let i = 0; i < 5; i += 1) buildFactIndex(snapshot());

    const INDEX_BUILDS = 50;
    for (let i = 0; i < INDEX_BUILDS; i += 1) {
      mark("bench.start");
      buildFactIndex(snapshot());
      measure(LAT_INDEX_BUILD, "bench.start");
    }

    const index = buildFactIndex(snapshot());
    const RESOLVE_PASSES = 30;
    for (let pass = 0; pass < RESOLVE_PASSES; pass += 1) {
      for (const entry of CAPSULE_ASK_CORPUS) {
        mark("bench.start");
        resolveTier0(entry.query, index);
        measure(LAT_TIER0_PAINT, "bench.start");
      }
    }

    const resolver = createSpeculativeResolver({ index });
    for (const partial of ["t", "to", "tot", "total", "total a", "total assets",
                           "cif", "cifra", "cifra de afaceri", "what changed vs FY 2024"]) {
      resolver.flush(partial);
    }
    resolver.cancel();

    const report = latencyReport();
    const line = (name: string, label: string) => {
      const s = report[name];
      if (!s) return `  ${label.padEnd(34)} UNMEASURED`;
      const budget = s.budgetMs ? ` (budget ${s.budgetMs} ms → ${s.withinBudget ? "MET" : "MISSED"})` : "";
      return `  ${label.padEnd(34)} n=${String(s.n).padStart(4)}` +
             `  p50 ${s.p50.toFixed(3).padStart(8)} ms` +
             `  p95 ${s.p95.toFixed(3).padStart(8)} ms` +
             `  max ${s.max.toFixed(3).padStart(8)} ms${budget}`;
    };

    // eslint-disable-next-line no-console
    console.log([
      "",
      "── CAPSULE TIER-0 LATENCY (measured, this machine, jsdom) ──",
      line(LAT_INDEX_BUILD, "fact-index build"),
      line(LAT_TIER0_PAINT, "Tier-0 resolve (compute only)"),
      line(LAT_SPECULATIVE, "speculative resolve"),
      line(LAT_TIER1_FACT_CARD, "Tier-1 fact-card paint"),
      line(LAT_FIRST_TOKEN, "first model token"),
      "",
      `  Tier-0 resolve ran ${RESOLVE_PASSES} passes over ` +
        `${CAPSULE_ASK_CORPUS.length} questions = ` +
        `${RESOLVE_PASSES * CAPSULE_ASK_CORPUS.length} calls; n above is the`,
      `  last ${MAX_SAMPLES} (the ring window), which is the distribution by design.`,
      "",
      "  NOT MEASURED HERE: the paint half of Tier-0 first paint (no DOM",
      "  commit in this process), Tier-1 fact-card paint and first model",
      "  token (no model in this lane). Hooks are published; the surface",
      "  and answer lanes must record them with the same primitives.",
      "",
    ].join("\n"));

    // What IS measured must be inside its budget. Both of these are
    // pure compute, so a miss means an algorithmic regression, not a
    // slow machine.
    expect(report[LAT_INDEX_BUILD].withinBudget).toBe(true);
    expect(report[LAT_TIER0_PAINT].withinBudget).toBe(true);

    // And the two unmeasured ones must be honestly absent rather than
    // quietly filled in with the budget.
    expect(report[LAT_TIER1_FACT_CARD]).toBeUndefined();
    expect(report[LAT_FIRST_TOKEN]).toBeUndefined();
  });
});
