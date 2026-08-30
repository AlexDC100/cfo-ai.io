// THE CAPSULE — follow-up chips.
//
// The thing that turns one question into a session. After an answer
// lands, three chips offer the next question — and they are computed
// from THE ANSWER'S OWN EVIDENCE, not from a starter list.
//
// ── The rule that shapes every branch here ────────────────────────────
//
// A follow-up is only offered when the evidence PROVES it can be
// answered. Three examples of the same rule:
//
//   · "vs last year?" appears only when the turn read exactly ONE
//     period. Offering a comparison on a turn that already compared two
//     is offering the answer that is on screen.
//   · "which accounts drove it?" appears only when a money fact is
//     present. On a pure ratio answer there are no accounts to drive
//     anything, and the chip would walk the reader into a refusal.
//   · "show the evidence" appears only when there is evidence to show —
//     at least one fact BEYOND the ones the prose already cited.
//
// A chip that leads to "I cannot answer that" is worse than no chip: it
// spends a model call to say no, and it teaches the reader that the
// suggestions are decorative.
//
// ── No figures, ever (S1, same law as the suggestion engine) ──────────
//
// Chip labels interpolate METRIC LABELS and PERIOD LABELS only. The
// values are on screen already, rendered through `Amount`; putting one
// in a chip would be a second, unprovenanced spelling of the same
// number. `metricKey` is carried instead, and the surface resolves it
// through the same `metricLabel()` the figure list uses — so the chip
// and the row above it can never disagree about what a metric is called.
//
// Pure: no i18n, no React, no clock. Same discipline as
// `lib/capsuleSuggestions.ts`, and for the same reason — this is the
// file the gate can assert without a renderer.

import type { CapsuleEvidence, CapsuleFactMeta } from "./capsuleAnswerTypes";

/** What a chip is FOR. Also the i18n leaf under
 *  `capsuleAnswer.followUp.<kind>`. */
export type CapsuleFollowUpKind =
  | "compare_prior"
  | "drivers"
  | "evidence"
  | "gap_fix"
  | "interpret"
  | "trend";

export interface CapsuleFollowUp {
  id: string;
  kind: CapsuleFollowUpKind;
  /** `capsuleAnswer.followUp.<kind>`. */
  labelKey: string;
  /** Interpolation params. LABELS only — never a value (S1). */
  labelParams: Record<string, string>;
  /** A metric name the surface resolves to a display label, when the
   *  chip is about one metric in particular. */
  metricKey?: string;
  /**
   * `true` when activating this chip does NOT ask a new question — it
   * expands something already on screen. The surface renders those
   * chips without the model's cost and never routes them through `ask`.
   */
  local?: boolean;
  /** Higher runs first. Deterministic ordering (S4). */
  priority: number;
}

/** Three. A fourth chip is a menu, and the follow-up input is right
 *  there for anything the chips do not cover. */
export const MAX_FOLLOW_UPS = 3;

/** Money facts carry accounts behind them; a ratio does not. */
function moneyFacts(evidence: CapsuleEvidence): CapsuleFactMeta[] {
  return Object.values(evidence.factMeta).filter((m) => m.unit === "money");
}

/** The metric a follow-up should be ABOUT: the money metric with the
 *  most facts behind it, falling back to the first fact of any unit.
 *  Deterministic — ties break on the metric name. */
export function primaryMetric(evidence: CapsuleEvidence): string | null {
  const counts = new Map<string, number>();
  for (const m of Object.values(evidence.factMeta)) {
    if (!m.metric) continue;
    const weight = m.unit === "money" ? 2 : 1;
    counts.set(m.metric, (counts.get(m.metric) ?? 0) + weight);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [metric, count] of [...counts.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (count > bestCount) {
      best = metric;
      bestCount = count;
    }
  }
  return best;
}

export interface FollowUpInput {
  evidence: CapsuleEvidence;
  /** Fact names the prose actually cited. Drives the evidence chip: a
   *  turn that already showed every fact has nothing left to reveal. */
  citedFacts: readonly string[];
  /** True when the turn fell back to the deterministic renderer. */
  deterministic: boolean;
  /** True when generation failed. A failed turn offers RETRY, which the
   *  degraded panel already owns — so this returns nothing at all. */
  degraded: boolean;
  /**
   * True when TIER 0 answered this turn locally, with no model call.
   *
   * This is the one input that ADDS a paid chip rather than withholding
   * one, and that is deliberate. A Tier-0 turn is a figure with its
   * provenance and no interpretation, so the reader who wants the
   * interpretation needs a way to ask for it — and it has to be an
   * explicit act, because it is the keystroke that starts spending. The
   * `interpret` chip is that act: one keystroke away, never automatic.
   */
  tier0?: boolean;
}

/**
 * The chips for one finished turn, ranked, capped at three.
 *
 * Returns an EMPTY array freely — a degraded turn, or an answer whose
 * evidence supports no further question, gets no chips. The follow-up
 * input below them is the universal escape hatch, so nothing is lost by
 * showing none.
 */
export function buildFollowUps(input: FollowUpInput): CapsuleFollowUp[] {
  const { evidence, citedFacts, degraded } = input;
  if (degraded) return [];
  const tier0 = Boolean(input.tier0);

  const out: CapsuleFollowUp[] = [];
  const money = moneyFacts(evidence);
  const periods = evidence.periods.length;
  const metric = primaryMetric(evidence);

  // 1. A GAP the answer already named. The most useful next move is
  //    always the one that removes the reason the answer was partial,
  //    and the gap carries its own `fix` text from the engine.
  const gap = evidence.gaps[0];
  if (gap && gap.code) {
    out.push({
      id: `capsule.followUp.gap.${gap.code}`,
      kind: "gap_fix",
      labelKey: "capsuleAnswer.followUp.gap_fix",
      labelParams: {},
      priority: 100,
    });
  }

  // 2. INTERPRETATION — the deliberate door from Tier 0 to Tier 1.
  //
  //    A Tier-0 turn holds the figure and no reading of it. That is the
  //    honest shape of a lookup, and it is also exactly the moment a
  //    reader most often wants a sentence. This chip is how they ask for
  //    one: it is NOT `local`, so activating it goes through the same
  //    paid path any other question does — a reservation, a request, a
  //    guarded answer. Ranked above the rest because on a Tier-0 turn it
  //    is the only chip that adds something the panel does not already
  //    show.
  //
  //    It appears ONLY on a Tier-0 turn. Offering it on a model answer
  //    would be offering to interpret an interpretation.
  if (tier0 && metric) {
    out.push({
      id: "capsule.followUp.interpret",
      kind: "interpret",
      labelKey: "capsuleAnswer.followUp.interpret",
      labelParams: {},
      metricKey: metric,
      priority: 95,
    });
  }

  // 3. COMPARISON — only from a single-period answer. Two periods are
  //    already a comparison; a third question about "last year" would
  //    re-ask what is on screen.
  if (periods === 1 && metric) {
    out.push({
      id: "capsule.followUp.compare_prior",
      kind: "compare_prior",
      labelKey: "capsuleAnswer.followUp.compare_prior",
      labelParams: {},
      metricKey: metric,
      priority: 90,
    });
  }

  // 4. TREND — the mirror case. Two periods on screen means a direction
  //    exists, so "is this a trend or a one-off" is a real question with
  //    a real answer behind it.
  if (periods >= 2 && metric) {
    out.push({
      id: "capsule.followUp.trend",
      kind: "trend",
      labelKey: "capsuleAnswer.followUp.trend",
      labelParams: {},
      metricKey: metric,
      priority: 88,
    });
  }

  // 5. DRIVERS — needs money. "Which accounts drove it" has no answer
  //    for a dimensionless fact, because accounts do not add up to a
  //    ratio; they add up to the operands.
  if (money.length > 0 && metric) {
    out.push({
      id: "capsule.followUp.drivers",
      kind: "drivers",
      labelKey: "capsuleAnswer.followUp.drivers",
      labelParams: {},
      metricKey: metric,
      priority: 80,
    });
  }

  // 6. EVIDENCE — local, free, and only when something is still hidden.
  //    `citedFacts` is what the prose named; the panel holds more.
  const total = Object.keys(evidence.factMeta).length;
  const cited = new Set(citedFacts).size;
  if (total > 0 && total > cited) {
    out.push({
      id: "capsule.followUp.evidence",
      kind: "evidence",
      labelKey: "capsuleAnswer.followUp.evidence",
      labelParams: {},
      local: true,
      priority: 70,
    });
  }

  out.sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out.slice(0, MAX_FOLLOW_UPS);
}
