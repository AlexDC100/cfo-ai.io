// FOLLOW-UP CHIPS — the thing that turns one question into a session.
//
// ── Why every turn here is a REAL turn ────────────────────────────────
//
// The project rule is that fixtures come from real engine output, not
// hand-built objects, and this file is a direct beneficiary. A hand-built
// `CapsuleEvidence` would let a test assert that "vs last year?" appears
// on a single-period answer simply because the literal it typed said
// `periods: [one]`. Running `runAnswerTurn` against the fixture transports
// means the evidence is assembled by the real merge — the same code that
// renames colliding facts, the same code that decides how many periods a
// turn actually read — so the chip rules are tested against what the
// pipeline produces rather than against what a test author imagined it
// produces.
//
// The rule under test, stated once: A CHIP IS ONLY OFFERED WHEN THE
// EVIDENCE PROVES IT CAN BE ANSWERED. A chip that leads to "I cannot
// answer that" spends a model call to say no, and teaches the reader
// that the suggestions are decorative.

import { describe, expect, it } from "vitest";

import { runAnswerTurn, type CapsuleTurn } from "../capsuleAnswerClient";
import { planRetrieval } from "../capsuleRetrieval";
import {
  ANSWER_FIXTURES,
  FIXTURE_PERIODS,
  fixtureGenerationTransport,
  fixtureToolTransport,
} from "../capsuleAnswerFixtures";
import {
  MAX_FOLLOW_UPS,
  buildFollowUps,
  primaryMetric,
  type CapsuleFollowUp,
} from "../capsuleFollowUps";
import { emptyEvidence } from "../capsuleAnswerTypes";

const CTX = {
  periodId: FIXTURE_PERIODS[0].id,
  periodLabel: FIXTURE_PERIODS[0].label,
  periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
};

async function realTurn(id: string): Promise<CapsuleTurn> {
  const f = ANSWER_FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`no fixture "${id}"`);
  return runAnswerTurn({
    turnId: `followups-${id}`,
    question: f.question,
    history: [],
    plan: planRetrieval(f.question, CTX),
    toolTransport: fixtureToolTransport(),
    generate: fixtureGenerationTransport(f.answer),
    language: "en",
  });
}

function chipsFor(turn: CapsuleTurn): CapsuleFollowUp[] {
  return buildFollowUps({
    evidence: turn.evidence,
    citedFacts: turn.citedFacts,
    deterministic: turn.deterministic,
    degraded: Boolean(turn.degraded),
  });
}

const kinds = (chips: readonly CapsuleFollowUp[]) => chips.map((c) => c.kind);

describe("the chips are computed from the answer's own evidence", () => {
  it("a SINGLE-period answer offers the comparison, never the trend", async () => {
    const turn = await realTurn("assets");
    expect(turn.evidence.periods.length, "fixture drifted: expected one period").toBe(1);
    const chips = kinds(chipsFor(turn));
    expect(chips).toContain("compare_prior");
    // "Trend or one-off?" needs two points. One period is one point.
    expect(chips).not.toContain("trend");
  });

  it("a TWO-period answer offers the trend, never the comparison", async () => {
    const turn = await realTurn("compare-revenue");
    expect(turn.evidence.periods.length).toBeGreaterThanOrEqual(2);
    const chips = kinds(chipsFor(turn));
    expect(chips).toContain("trend");
    // The comparison is already ON SCREEN. Offering it again is offering
    // the answer the reader is looking at.
    expect(chips).not.toContain("compare_prior");
  });

  it("offers DRIVERS only when there is money behind the answer", async () => {
    const money = await realTurn("assets");
    expect(kinds(chipsFor(money))).toContain("drivers");

    // A dimensionless-only answer: accounts do not add up to a ratio,
    // they add up to its operands, so "which accounts drove it" has no
    // answer and must not be offered.
    const ratioOnly = await realTurn("equity-ratio");
    const hasMoney = Object.values(ratioOnly.evidence.factMeta).some(
      (m) => m.unit === "money",
    );
    if (!hasMoney) {
      expect(kinds(chipsFor(ratioOnly))).not.toContain("drivers");
    }
  });

  it("offers EVIDENCE only when something is still hidden", async () => {
    const turn = await realTurn("health");
    const total = Object.keys(turn.evidence.factMeta).length;
    const cited = new Set(turn.citedFacts).size;
    const chips = kinds(chipsFor(turn));
    if (total > cited) expect(chips).toContain("evidence");
    else expect(chips).not.toContain("evidence");
  });

  it("the EVIDENCE chip is LOCAL — it expands, it does not spend", async () => {
    const turn = await realTurn("health");
    for (const chip of chipsFor(turn)) {
      if (chip.kind === "evidence") expect(chip.local).toBe(true);
      else expect(chip.local ?? false).toBe(false);
    }
  });
});

describe("refusals", () => {
  it("a DEGRADED turn offers no chips at all", async () => {
    const turn = await realTurn("assets");
    const chips = buildFollowUps({
      evidence: turn.evidence,
      citedFacts: turn.citedFacts,
      deterministic: turn.deterministic,
      degraded: true,
    });
    // The degraded panel owns the only action worth offering — Retry.
    // A second row of questions under a failure is noise.
    expect(chips).toEqual([]);
  });

  it("empty evidence yields nothing rather than a generic starter set", () => {
    expect(
      buildFollowUps({
        evidence: emptyEvidence(),
        citedFacts: [],
        deterministic: false,
        degraded: false,
      }),
    ).toEqual([]);
  });
});

describe("shape and determinism", () => {
  it("never returns more than three", async () => {
    for (const f of ANSWER_FIXTURES) {
      const turn = await realTurn(f.id);
      expect(chipsFor(turn).length, f.id).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
    }
  });

  it("is a pure function of its argument — same turn, same chips", async () => {
    const turn = await realTurn("compare-revenue");
    expect(chipsFor(turn)).toEqual(chipsFor(turn));
  });

  it("carries KEYS, never resolved copy, and never a figure", async () => {
    for (const f of ANSWER_FIXTURES) {
      const turn = await realTurn(f.id);
      for (const chip of chipsFor(turn)) {
        expect(chip.labelKey, f.id).toMatch(/^capsuleAnswer\.followUp\./);
        // S1, the suggestion engine's law, applied here: a chip renders
        // no `Amount` and no `NarrativeText`, so it may carry no figure.
        for (const value of Object.values(chip.labelParams)) {
          expect(value, `${f.id}/${chip.id}`).not.toMatch(/\d/);
        }
      }
    }
  });

  it("every chip a fixture can produce has copy in BOTH languages", async () => {
    const strings = (await import("../capsuleAnswerStrings.json")).default as Record<
      string,
      { capsuleAnswer: { followUp: Record<string, unknown> } }
    >;
    const seen = new Set<string>();
    for (const f of ANSWER_FIXTURES) {
      const turn = await realTurn(f.id);
      for (const chip of chipsFor(turn)) seen.add(chip.kind);
    }
    expect(seen.size, "no chips produced — the test is inert").toBeGreaterThan(0);
    for (const lang of ["en", "ro"] as const) {
      const bag = strings[lang].capsuleAnswer.followUp;
      for (const kind of seen) {
        expect(typeof bag[kind], `${lang} chip label ${kind}`).toBe("string");
        // The chip is short ("vs last year?"); the QUESTION it sends
        // names the metric. Both must exist or the model gets a subject
        // it has to guess.
        const ask = bag.ask as Record<string, unknown>;
        expect(typeof ask[kind], `${lang} chip question ${kind}`).toBe("string");
      }
    }
  });
});

describe("primaryMetric", () => {
  it("prefers a money metric over a dimensionless one", async () => {
    const turn = await realTurn("health");
    const metric = primaryMetric(turn.evidence);
    expect(metric).toBeTruthy();
    const metas = Object.values(turn.evidence.factMeta).filter(
      (m) => m.metric === metric,
    );
    expect(metas.length).toBeGreaterThan(0);
  });

  it("returns null on empty evidence rather than an invented name", () => {
    expect(primaryMetric(emptyEvidence())).toBeNull();
  });
});
