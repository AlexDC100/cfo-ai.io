// THE CAPSULE — a Tier-0 answer, as a FINISHED TURN.
//
// ══ WHY THIS FILE EXISTS ════════════════════════════════════════════════
//
// Tier 0 resolves a large share of what people type at this surface in
// microseconds, from the period already in memory, with full provenance
// and no network. The brief's words for it: "INSTANT (<100ms, ZERO MODEL
// CALLS, works offline/credits-down)".
//
// That contract was met by the RESOLVER and broken at the only boundary
// where it costs money. `CapsuleTier0Preview` showed the number while
// you typed, and then Enter called `askModel` unconditionally — so the
// question Tier 0 had already answered took a chat reservation and
// issued a model request anyway. The preview was free; the answer was
// billed, and it was billed for a figure the client already held.
//
// The fix is not a smaller model or a cache. It is that a Tier-0 answer
// is A FULL ANSWER and therefore has to be able to BE one: a turn in the
// thread, with the fact card, the provenance dot, the citation footer
// and the follow-up chips the canvas gives every other answer. A preview
// that dead-ends into a paid re-answer is not a tier, it is a teaser.
//
// So this module builds the turn the pipeline would have built, from
// facts that are already in hand:
//
//     resolveTier0(q, index)  →  CapsuleTurn { status: "done" }
//
// and `CommandPalette` pushes it instead of calling `askModel`. No
// reservation, no request, no `AbortController`, nothing to degrade.
//
// ══ THE FOUR THINGS THIS BUILDER MAY NOT DO ═════════════════════════════
//
// T1  NO PROSE. `blocks` is empty and stays empty. Every sentence on
//     this surface is either reviewed copy or guarded model output;
//     there is no third category, and a locally-composed sentence about
//     a figure would be a fourth. The figures speak, the same way they
//     speak on a deterministic fallback turn.
// T2  NO NEW NUMBERS. Every value here is a `FactRef` the index built
//     from served engine output, carried through unchanged with its
//     DECLARED unit. Nothing is summed, converted, rounded or
//     re-derived on the way in — a compare's delta is the resolver's own
//     `Tier0Delta.delta`, in the fact's own unit, not a subtraction
//     performed here.
// T3  NO ABSENT-AS-ZERO. A refusal (`answer.refused`) and an answer with
//     no facts both return null, which routes the question onward
//     exactly as before. A turn is built only when there is something
//     true to put in it.
// T4  ONE NAMING AUTHORITY. Facts bind through `freeName` — the same
//     function `mergeEvidence` uses — so `revenue` means the same thing
//     whether the evidence came from a tool call or from the local
//     index, and a collision renames rather than overwrites.
//
// ══ THE COMPARE SUFFIXES ════════════════════════════════════════════════
//
// A compare binds `<metric>_a` (baseline), `<metric>_b` (active) and
// `<metric>_delta`. That is not a convention invented here: it is
// exactly what the engine's `compare_periods` tool emits, and it is what
// `comparisonsFrom` in `capsuleAnswerVisuals` reads to build the
// three-row comparison visual. Naming them anything else would give the
// same answer two shapes depending on which tier produced it.

import type { Tier0Answer } from "@/lib/capsuleTier0";
import type { FactRef } from "@/lib/capsuleFactIndex";
import type { Currency } from "@/lib/rates";

import { newTurn, type CapsuleTurn } from "./capsuleAnswerClient";
import { digitTokens, freeName } from "./capsuleRetrieval";
import {
  asUnit,
  emptyEvidence,
  type CapsuleEvidence,
  type CapsuleFactMeta,
} from "./capsuleAnswerTypes";
import { visualsFrom } from "./capsuleAnswerVisuals";

/** The tool name a Tier-0 fact records as its origin. It is not one of
 *  the engine's eight tools, and it must not pretend to be: this figure
 *  came off the client-side index, and the evidence panel says so. */
export const TIER0_TOOL = "tier0_index";

/** Suffixes `capsuleAnswerVisuals.comparisonsFrom` reads. Same strings
 *  the engine's `compare_periods` emits. */
const SUFFIX_A = "_a";
const SUFFIX_B = "_b";
const SUFFIX_DELTA = "_delta";

/** One `FactRef` → one bound fact, or nothing when its unit is not one
 *  this build declares. An undeclared unit is a refusal, never a
 *  default — the same rule `mergeEvidence` applies to a tool payload. */
function bind(
  ev: CapsuleEvidence,
  fact: FactRef,
  literals: Set<string>,
  step: number,
  name?: string,
): string | null {
  const unit = asUnit(fact.unit);
  if (!unit) return null;
  if (typeof fact.value !== "number" || !Number.isFinite(fact.value)) return null;

  const currency = fact.currency ? (fact.currency as Currency) : null;
  if (unit === "money") {
    // The 461 discipline, structurally: the FIRST money currency seen is
    // the evidence's currency, and a later fact in a different one is
    // not bound at all rather than silently converted.
    if (!ev.currency && currency) ev.currency = currency;
    if (currency && ev.currency && currency !== ev.currency) return null;
  }

  const bound = freeName(name ?? fact.factKey, ev.facts);
  const meta: CapsuleFactMeta = {
    fact: bound,
    metric: fact.factKey,
    unit,
    value: fact.value,
    scope: fact.periodLabel || "",
    labelKey: fact.labelKey ?? "",
    periodId: fact.periodId || null,
    periodLabel: fact.periodLabel || null,
    snapshotId: null,
    currency: unit === "money" ? currency : null,
    tool: TIER0_TOOL,
    alias: bound === fact.factKey ? null : fact.factKey,
    step,
  };
  ev.facts[bound] = fact.value;
  ev.factUnits[bound] = unit;
  ev.factMeta[bound] = meta;

  digitTokens(meta.periodLabel).forEach((d) => literals.add(d));
  for (const code of fact.accountCodes ?? []) literals.add(code);
  if (meta.periodId && meta.periodLabel && !ev.periods.some((p) => p.id === meta.periodId)) {
    ev.periods.push({ id: meta.periodId, label: meta.periodLabel });
  }
  return bound;
}

/**
 * The evidence a Tier-0 answer carries.
 *
 * A COMPARE binds through its `deltas`, so each metric arrives as the
 * `_a` / `_b` / `_delta` triple the comparison visual expects. Anything
 * else binds its facts in the order the resolver returned them, which is
 * deterministic by construction (the resolver has no clock and no
 * randomness).
 */
export function tier0Evidence(answer: Tier0Answer): CapsuleEvidence {
  const ev = emptyEvidence();
  const literals = new Set<string>();
  ev.tools.push(TIER0_TOOL);

  if (answer.kind === "compare" && answer.deltas && answer.deltas.length > 0) {
    answer.deltas.forEach((d, i) => {
      const a = bind(ev, d.from, literals, i, `${d.factKey}${SUFFIX_A}`);
      const b = bind(ev, d.to, literals, i, `${d.factKey}${SUFFIX_B}`);
      // The delta rides the LATER period's own fact shape so its unit,
      // currency and period are the ones the movement is expressed in.
      // T2: `d.delta` is the resolver's number, carried, not recomputed.
      if (a && b) {
        bind(
          ev,
          { ...d.to, value: d.delta },
          literals,
          i,
          `${d.factKey}${SUFFIX_DELTA}`,
        );
      }
    });
  } else {
    answer.facts.forEach((f, i) => bind(ev, f, literals, i));
  }

  ev.literals = Array.from(literals).sort((a, b) => b.length - a.length);
  return ev;
}

/**
 * A finished turn for a Tier-0 answer, or NULL when there is nothing
 * honest to render.
 *
 * Null means "this is not a Tier-0 answer" and the caller falls through
 * to the model exactly as it did before — a refusal, an empty fact list
 * and a fact set that bound nothing all take that path. The builder
 * never returns a turn it had to invent a value for.
 */
export function tier0Turn(
  id: string,
  question: string,
  answer: Tier0Answer | null,
  startedAt: number,
): CapsuleTurn | null {
  if (!answer || answer.refused) return null;
  if (!answer.facts || answer.facts.length === 0) return null;

  const evidence = tier0Evidence(answer);
  const names = Object.keys(evidence.factMeta);
  if (names.length === 0) return null;

  const turn = newTurn(id, question.trim(), startedAt);
  turn.status = "done";
  turn.evidence = evidence;
  turn.visuals = visualsFrom(evidence);
  // Every bound fact is cited: there is no prose to have cited a subset,
  // so the figure list IS the answer and shows all of it.
  turn.citedFacts = names;
  turn.tier0 = true;
  // NOT `deterministic`. That flag means "the model's prose was refused
  // and the figures are what is left", and the surface says so in words.
  // Nothing was refused here — no model was asked.
  turn.deterministic = false;
  turn.timing = { startedAt, retrievalMs: 0, firstTokenMs: null, totalMs: 0 };
  return turn;
}
