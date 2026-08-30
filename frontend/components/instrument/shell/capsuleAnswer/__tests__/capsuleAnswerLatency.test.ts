// THE LATENCY CONTRACT (C9) — p50 time-to-first-token on the twelve
// fixtures, and the pipeline overhead that sits on top of the transports.
//
// ── What is honestly measurable here, and what is not ─────────────────
//
// The live generation transport is the Ask CFO AI Edge Function, which
// is NOT a streaming endpoint: it returns the whole completion in one
// response. So on production hardware "first token" equals "whole
// answer", and quoting a number measured against a fixture as if it were
// the production number would be theatre.
//
// What this harness measures, therefore, is split in two:
//
//   OVERHEAD   what the pipeline itself costs — planning, the parallel
//              read fan-out, the merge with its collision renaming, and
//              the guard. Real, hardware-measured, and the only part
//              this lane can actually make faster.
//   MODELLED   first-token under a transport that simulates a per-read
//              cost and a generation cost. The p50 is reported so the
//              number is on the record; the ASSERTION is on the
//              overhead, because that is the part that is ours.
//
// When a streaming transport lands, `firstTokenMs` starts meaning what
// its name says with no change to this file — the pipeline already
// stamps it on the transport's first yielded chunk.

import { describe, expect, it } from "vitest";

import { runAnswerTurn } from "../capsuleAnswerClient";
import { planRetrieval } from "../capsuleRetrieval";
import {
  ANSWER_FIXTURES,
  FIXTURE_PERIODS,
  fixtureGenerationTransport,
  fixtureToolTransport,
} from "../capsuleAnswerFixtures";

const CTX = {
  periodId: FIXTURE_PERIODS[0].id,
  periodLabel: FIXTURE_PERIODS[0].label,
  periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
};

/** Modelled transport costs. Reads fan out in parallel, so the read cost
 *  is per-turn, not per-step. */
const TOOL_MS = 40;
const GENERATION_MS = 60;

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function measure(toolMs: number, genMs: number) {
  const rows: { id: string; retrieval: number; firstToken: number; steps: number }[] = [];
  for (const f of ANSWER_FIXTURES) {
    const plan = planRetrieval(f.question, CTX);
    const turn = await runAnswerTurn({
      turnId: `lat-${f.id}`,
      question: f.question,
      history: [],
      plan,
      toolTransport: fixtureToolTransport(toolMs),
      generate: fixtureGenerationTransport(f.answer, {
        chunks: 3,
        firstTokenMs: genMs,
      }),
      language: "en",
    });
    expect(turn.status).toBe("done");
    rows.push({
      id: f.id,
      retrieval: turn.timing.retrievalMs ?? 0,
      firstToken: turn.timing.firstTokenMs ?? 0,
      steps: plan.length,
    });
  }
  return rows;
}

describe("C9 — first-token latency on the fixtures", () => {
  it("reports p50 and holds the pipeline's own overhead near zero", async () => {
    const zero = await measure(0, 0);
    const modelled = await measure(TOOL_MS, GENERATION_MS);

    const overheadP50 = p50(zero.map((r) => r.firstToken));
    const retrievalP50 = p50(zero.map((r) => r.retrieval));
    const modelledP50 = p50(modelled.map((r) => r.firstToken));
    const addedP50 = p50(
      modelled.map((r) => r.firstToken - (TOOL_MS + GENERATION_MS)),
    );

    // Reported, not asserted — the production first-token is dominated by
    // a non-streaming model call this lane does not own.
    console.log(
      [
        "",
        "  CAPSULE ANSWER — C9 latency, 12 fixtures",
        `  pipeline-only p50 first-token : ${overheadP50.toFixed(1)} ms`,
        `  pipeline-only p50 retrieval   : ${retrievalP50.toFixed(1)} ms`,
        `  modelled p50 first-token      : ${modelledP50.toFixed(1)} ms` +
          `  (reads ${TOOL_MS} ms parallel + generation ${GENERATION_MS} ms)`,
        `  overhead ABOVE the transports : ${addedP50.toFixed(1)} ms`,
        `  max steps in any plan         : ${Math.max(...modelled.map((r) => r.steps))}`,
        "",
      ].join("\n"),
    );

    // THE gate: our own code must be a rounding error next to the
    // network. A regression here means the planner, the merge or the
    // guard grew something expensive.
    expect(overheadP50).toBeLessThan(25);
    expect(addedP50).toBeLessThan(40);
  }, 20000);

  it("reads fan out in parallel — a five-step plan is not five times slower", async () => {
    const health = ANSWER_FIXTURES.find((f) => f.id === "health")!;
    const single = ANSWER_FIXTURES.find((f) => f.id === "assets")!;
    const plans = {
      health: planRetrieval(health.question, CTX),
      single: planRetrieval(single.question, CTX),
    };
    expect(plans.health.length).toBeGreaterThan(plans.single.length);

    const time = async (q: string, plan: ReturnType<typeof planRetrieval>, answer: string) => {
      const turn = await runAnswerTurn({
        turnId: `par-${q}`,
        question: q,
        history: [],
        plan,
        toolTransport: fixtureToolTransport(TOOL_MS),
        generate: fixtureGenerationTransport(answer),
        language: "en",
      });
      return turn.timing.retrievalMs ?? 0;
    };

    const many = await time(health.question, plans.health, health.answer);
    const one = await time(single.question, plans.single, single.answer);
    // Serial would be ~5x; parallel is ~1x plus scheduling noise.
    expect(many).toBeLessThan(one + TOOL_MS);
  }, 20000);
});
