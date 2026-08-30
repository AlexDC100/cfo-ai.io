// THE CAPSULE — TIER-0 COVERAGE FIXTURES (gate A1).
//
// Thirty-four questions, each pinned to what Tier 0 must do with it:
// answer it instantly, decline it honestly, or hand it to the model. The
// gate asserts every line, and it reports the MEASURED coverage rather
// than asserting the target — a coverage number you assert is a number
// you have stopped measuring.
//
// ── Where these came from, and what that cost ────────────────────────
//
// The brief says to seed the set from the real recent-questions log. It
// was read (read-only, via `chat_messages` on the production backend)
// and it is THIN: five user rows, three distinct strings, and all three
// are canned suggestion chips rather than typed questions —
//
//     "Explain our current cash flow position in plain language…"
//     "What is our biggest financial risk right now? Cite the period…"
//     "Tell me more about Operating Revenue (413.73M RON)…"
//
// All three are in the set below (marked `source: "production_log"`),
// and all three are NOT Tier-0 questions: they ask for judgement, which
// is exactly what the model tier is for. Three interpretation requests
// are not a sample you can tune a lookup tier against, so the remaining
// thirty come from the two honest alternatives the brief allows:
// the router's own ASK fixtures (`capsuleRouterFixtures.ts`, marked
// `source: "router_fixture"` — real operator phrasings already pinned by
// gate C4) and the metric classes the brief itself enumerates
// (`source: "brief"`), each with its Romanian counterpart.
//
// The honest consequence: the measured coverage below describes THIS
// set. When the log fills with real typed questions, re-seed from it and
// re-measure — do not assume the number transfers.
//
// ── Why the expectations look "wrong" in three places ────────────────
//
//   · "what is EBITDA" is pinned to a FACT here, while the router's
//     fixture note calls it a definition question. In a workspace with a
//     period loaded, the overwhelmingly common intent is the figure;
//     offering the definition alongside it is the surface's job, not the
//     resolver's. Recorded because it is a deliberate divergence from a
//     sibling fixture set, not an oversight.
//   · "compare December and November revenue" is pinned to a REFUSAL,
//     not a compare. The fixture workspace holds FY 2025 and FY 2024;
//     answering about those two would produce a delta that reads exactly
//     like the one asked for. Naming a period the workspace does not
//     hold has to refuse.
//   · "can we afford a 500k capex" is pinned to null even though it is a
//     money question — Tier 0 has no capex fact and no affordability
//     model, and a lookup tier that answers it would be inventing one.

import type { Tier0Kind } from "./capsuleTier0";

export type Tier0FixtureSource = "production_log" | "router_fixture" | "brief";

export interface Tier0Fixture {
  /** Exactly what the user types. */
  query: string;
  /** The kind Tier 0 must return, or null for "hand it to the model". */
  expect: Tier0Kind | null;
  /** For `expect: "fact"` — the factKey it must resolve to. */
  factKey?: string;
  /** True when the expected answer is an honest refusal (facts empty,
   *  note set). Counts as Tier-0 HANDLED but not as Tier-0 ANSWERED. */
  refused?: boolean;
  source: Tier0FixtureSource;
  /** Read this on failure. */
  note: string;
}

export const CAPSULE_TIER0_FIXTURES: readonly Tier0Fixture[] = Object.freeze([
  // ── The production log, in full (3) ────────────────────────────────
  {
    query: "Explain our current cash flow position in plain language for the management team.",
    expect: null, source: "production_log",
    note: "the single most-repeated real question, and it is an "
        + "interpretation request — 'explain' must reach the model",
  },
  {
    query: "What is our biggest financial risk right now? Cite the period and figures you used.",
    expect: null, source: "production_log",
    note: "'risk' is a judgement; a lookup tier answering it would be "
        + "inventing an opinion",
  },
  {
    query: "Tell me more about Operating Revenue (413.73M RON) for my company. "
         + "What does this value mean in context?",
    expect: null, source: "production_log",
    note: "names a metric AND carries a figure, but asks what it MEANS — "
        + "'mean' is an interpretation trigger",
  },

  // ── Router ASK fixtures (9 of the 12 that are not duplicates) ──────
  {
    query: "why is cash down this month?", expect: null, source: "router_fixture",
    note: "names a metric Tier 0 holds; 'why' must still win",
  },
  {
    query: "what changed vs last month", expect: "compare", source: "router_fixture",
    note: "the canonical compare shape, with a relative baseline",
  },
  {
    query: "how much do we owe suppliers", expect: "fact",
    factKey: "bs.row.ap_trade", source: "router_fixture",
    note: "a statement line named by its business meaning, not its label",
  },
  {
    query: "de ce a scăzut profitul?", expect: null, source: "router_fixture",
    note: "RO 'de ce' — the interpretation gate is bilingual",
  },
  {
    query: "explain the 461 balance", expect: null, source: "router_fixture",
    note: "an account code inside an explanation request",
  },
  {
    query: "is the balance sheet balanced", expect: "meta", source: "router_fixture",
    note: "the verdict is the engine's SERVED status, not a local "
        + "tolerance comparison",
  },
  {
    query: "compare December and November revenue", expect: "meta", refused: true,
    source: "router_fixture",
    note: "names two periods this workspace does not hold — refuses "
        + "rather than answering about FY 2025 vs FY 2024",
  },
  {
    query: "show me the biggest risk in this period", expect: null,
    source: "router_fixture",
    note: "'risk' again, this time behind an action verb",
  },
  {
    query: "can we afford a 500k capex", expect: null, source: "router_fixture",
    note: "money-shaped but unanswerable from facts — no capex fact, no "
        + "affordability model",
  },
  {
    query: "what is EBITDA", expect: "fact", factKey: "ebitda",
    source: "router_fixture",
    note: "DELIBERATE divergence from the router fixture's note — in a "
        + "loaded workspace this asks for the figure",
  },
  {
    query: "ce înseamnă datorie netă", expect: "meta", source: "router_fixture",
    note: "RO definition question. Answered at Tier 0 from the SHIPPED "
        + "glossary (lib/glossary.ts, entry net_debt) — reviewed copy, "
        + "zero model, no figure. Paying a model for a sentence the app "
        + "already wrote is the waste this tier exists to remove",
  },
  {
    query: "cine sunt cei mai mari clienți", expect: "meta", refused: true,
    source: "router_fixture",
    note: "RO. REFUSED, not routed: a trial balance carries the trade-"
        + "receivables total and no customer list, and the model works "
        + "from the same facts — escalating buys a hedge, not an answer",
  },

  // ── The metric classes the brief enumerates, EN (9) ────────────────
  { query: "total assets", expect: "fact", factKey: "total_assets",
    source: "brief", note: "bare metric, the plainest lookup" },
  { query: "revenue", expect: "fact", factKey: "revenue",
    source: "brief", note: "methodology revenue_net, not assembled_pl" },
  { query: "how much cash do we have", expect: "fact", factKey: "cash",
    source: "brief", note: "opener + filler tail around one metric" },
  { query: "net debt", expect: "fact", factKey: "net_debt",
    source: "brief", note: "a methodology total" },
  { query: "what is the EBITDA margin", expect: "fact", factKey: "ebitda_margin",
    source: "brief", note: "a derived percent on native operands" },
  { query: "current ratio", expect: "fact", factKey: "current_ratio",
    source: "brief", note: "must beat 'current assets' on term length" },
  { query: "how many periods", expect: "meta", source: "brief",
    note: "a property of the index, not of the business" },
  { query: "is it balanced", expect: "meta", source: "brief",
    note: "the short form of the balance question" },
  { query: "what changed vs FY 2024", expect: "compare", source: "brief",
    note: "names a period the workspace DOES hold" },

  // ── The same classes, Romanian (6) ─────────────────────────────────
  { query: "cifra de afaceri", expect: "fact", factKey: "revenue",
    source: "brief", note: "RO, bare metric" },
  { query: "cât e numerarul", expect: "fact", factKey: "cash",
    source: "brief", note: "RO definite article — 'numerarul', not 'numerar'" },
  { query: "care este profitul net", expect: "fact", factKey: "net_result",
    source: "brief", note: "RO opener + inflected metric" },
  { query: "total datorii", expect: "fact", factKey: "total_liabilities",
    source: "brief", note: "RO, two words" },
  { query: "câte perioade avem", expect: "meta", source: "brief",
    note: "RO period count" },
  { query: "e echilibrat bilanțul?", expect: "meta", source: "brief",
    note: "RO balance question with diacritics and a question mark" },

  // ── Shapes that must NOT be claimed (3) ────────────────────────────
  {
    query: "cash conversion cycle by product line", expect: "meta",
    refused: true, source: "brief",
    note: "REFUSED as a per-product split. Was pinned to null on the "
        + "first draft; the no-breakdown rule caught it, and the rule is "
        + "right — a trial balance has no product dimension, so the model "
        + "would be guessing from the same facts",
  },
  {
    query: "cash conversion cycle", expect: null, source: "brief",
    note: "the T2 case proper: 'cash' is a known metric, 'conversion "
        + "cycle' is real meaning the index does not hold, and nothing "
        + "here is a refusable concept — so it goes to the model",
  },
  {
    query: "revenue vs FY 2024", expect: "compare", source: "brief",
    note: "one named metric, one named period — the single-metric "
        + "compare that populates deltaPct",
  },
  {
    query: "working capital", expect: "fact", factKey: "working_capital",
    source: "brief", note: "gateway accessor, not a bucket sum" },
]);

/** Queries whose answer must be produced with ZERO model calls. Every
 *  fixture that is not `expect: null` qualifies — including the honest
 *  refusals, which are also free. */
export const TIER0_HANDLED: readonly Tier0Fixture[] =
  CAPSULE_TIER0_FIXTURES.filter((f) => f.expect !== null);

/** The stricter subset: Tier 0 returns FACTS, not just a verdict. */
export const TIER0_ANSWERED: readonly Tier0Fixture[] =
  CAPSULE_TIER0_FIXTURES.filter((f) => f.expect !== null && !f.refused);

/** The brief's bar. Reported against the MEASURED number by the gate;
 *  it is never used to soften an assertion. */
export const TIER0_COVERAGE_TARGET = 0.6;
