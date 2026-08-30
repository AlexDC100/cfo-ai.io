// THE CAPSULE — THE ONE ASK CORPUS.
//
// ══ WHY THIS FILE REPLACED TWO OTHERS ═══════════════════════════════════
//
// The Tier-0 coverage claim was being measured twice, by two lanes, over
// two different question sets:
//
//   · the speed lane's `capsuleTier0Fixtures.ts` — 34 pinned questions,
//     reporting 64.7% answered
//   · the gates lane's `capsuleAskGates.test.ts` — 30 questions DERIVED
//     at run time from three files and then `.slice(0, 30)`, reporting
//     56.7%
//
// Two numbers for one gate means neither is the number. Worse, the
// derived one was not stable: this wave added three how-to fixtures to
// `capsuleRouterFixtures.ts` for an unrelated reason, and because the
// router fixtures sort ahead of the suggestion strings, the `.slice(0,
// 30)` silently swapped three questions out of the denominator. The
// percentage moved without the surface changing at all. A denominator
// that shifts when a sibling file grows is not a measurement.
//
// So there is now ONE corpus, PINNED, with every question carrying the
// exact place it came from. It is the UNION of everything both lanes
// were reading — nothing was dropped to make a number, and nothing was
// added to make one either.
//
// ══ WHAT THE UNION COSTS, STATED UP FRONT ═══════════════════════════════
//
// The union is 72 questions and 24 of them are the product's own
// SUGGESTION CHIPS, which exist to start a model conversation and are
// therefore judgement-shaped by design ("Why did inventory get flagged
// this month?"). The `.slice(0, 30)` kept six of those twenty-four.
// Restoring the other eighteen pushes measured Tier-0 coverage DOWN, and
// that movement is not a regression in the surface — it is the
// denominator no longer being chosen.
//
// The gate reports the single figure over this corpus and splits the
// misses into "wants a judgement" and "real coverage gap", because those
// two are what a reader can act on. See `capsuleAskGates.test.ts` §K3.
//
// ══ THE PINS ════════════════════════════════════════════════════════════
//
// `TIER0_PINS` is a VIEW of this corpus, not a second corpus: 34 of the
// 72 entries carry a pinned Tier-0 expectation, asserted question by
// question in `capsuleTier0.test.ts`. Every pinned query must exist in
// `CAPSULE_ASK_CORPUS` — the file's own gate asserts that, so a pin can
// never drift into naming a question the corpus does not contain.
//
// Pure data. No i18n, no React, no clock — importable by a test, a
// benchmark and a worker alike.

import type { Tier0Kind } from "./capsuleTier0";

/** Where a question came from. Ordered by fidelity as argued above. */
export type AskCorpusSource =
  | "production_log"
  | "answer_fixture"
  | "router_fixture"
  | "brief"
  | "suggestion";

export interface AskCorpusEntry {
  /** Exactly what the user types (or clicks). */
  query: string;
  source: AskCorpusSource;
  /** The identifier INSIDE that source — a fixture id, a strings key,
   *  the table the log was read from. "Which questions came from where"
   *  is answerable per line, not just per section. */
  origin: string;
}

/**
 * THE corpus. Deterministically ordered by source, then by the order
 * each source lists them, so the reported percentage is reproducible.
 */
export const CAPSULE_ASK_CORPUS: readonly AskCorpusEntry[] = Object.freeze([

  // ── A. THE PRODUCTION LOG (3) ───────────────────────────────────────
  //
  // Read read-only from `chat_messages` on the production backend. It is
  // THIN: five user rows, three distinct strings, and all three are canned
  // suggestion chips rather than typed questions. All three are here, and
  // all three are interpretation requests — which is the finding, not a
  // gap. Three judgement questions are not a sample you can tune a lookup
  // tier against.

  {
    query: "Explain our current cash flow position in plain language for the management team.",
    source: "production_log",
    origin: "chat_messages",
  },
  {
    query: "What is our biggest financial risk right now? Cite the period and figures you used.",
    source: "production_log",
    origin: "chat_messages",
  },
  {
    query: "Tell me more about Operating Revenue (413.73M RON) for my company. What does this value mean in context?",
    source: "production_log",
    origin: "chat_messages",
  },

  // ── B. THE ANSWER LANE'S RETRIEVAL BRANCHES (12) ────────────────────
  //
  // `capsuleAnswerFixtures.ANSWER_FIXTURES` — one question per retrieval
  // branch the answer pipeline has to cover. `origin` is the fixture id.

  {
    query: "what are our total assets",
    source: "answer_fixture",
    origin: "assets",
  },
  {
    query: "what is the equity ratio",
    source: "answer_fixture",
    origin: "equity-ratio",
  },
  {
    query: "what is our working capital",
    source: "answer_fixture",
    origin: "working-capital",
  },
  {
    query: "how did revenue change vs last month",
    source: "answer_fixture",
    origin: "compare-revenue",
  },
  {
    query: "show me the revenue trend over time",
    source: "answer_fixture",
    origin: "trend-revenue",
  },
  {
    query: "what is sitting in account 461",
    source: "answer_fixture",
    origin: "account-461",
  },
  {
    query: "what findings fired this month",
    source: "answer_fixture",
    origin: "findings",
  },
  {
    query: "cum stăm cu lichiditatea curentă",
    source: "answer_fixture",
    origin: "liquidity-ro",
  },
  {
    query: "what if revenue drops 10%",
    source: "answer_fixture",
    origin: "scenario",
  },
  {
    query: "how are we doing overall",
    source: "answer_fixture",
    origin: "health",
  },
  {
    query: "how do i export the balance sheet",
    source: "answer_fixture",
    origin: "help",
  },
  {
    query: "care e marja netă față de luna trecută",
    source: "answer_fixture",
    origin: "margin-ro",
  },

  // ── C. THE ROUTER'S ASK-LANE FIXTURES (14) ──────────────────────────
  //
  // `capsuleRouterFixtures.CAPSULE_ROUTER_FIXTURES`, written as "queries a
  // real operator of this product actually types". Every fixture whose
  // pinned lane is `ask` is here.
  //
  // ONE router fixture is deliberately ABSENT: the bare opener "how do i".
  // It is a PREFIX, not a question — nobody presses Enter on it — and K9
  // already drives every prefix of every fixture. Counting a fragment as a
  // question Tier 0 failed to answer would be padding the denominator.

  {
    query: "why is cash down this month?",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "what changed vs last month",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "how much do we owe suppliers",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "de ce a scăzut profitul?",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "explain the 461 balance",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "is the balance sheet balanced",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "compare December and November revenue",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "show me the biggest risk in this period",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "can we afford a 500k capex",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "what is EBITDA",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "ce înseamnă datorie netă",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "cine sunt cei mai mari clienți",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "how do i improve cash flow",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },
  {
    query: "how do i reduce inventory",
    source: "router_fixture",
    origin: "capsuleRouterFixtures",
  },

  // ── D. THE METRIC CLASSES THE BRIEF ENUMERATES (19) ─────────────────
  //
  // One question per metric class named in the Tier-0 brief, each with its
  // Romanian counterpart, plus the three shapes Tier 0 must NOT claim.
  // These are the lookups the tier exists for; they are also the reason a
  // corpus made only of them would flatter it.

  {
    query: "total assets",
    source: "brief",
    origin: "brief",
  },
  {
    query: "revenue",
    source: "brief",
    origin: "brief",
  },
  {
    query: "how much cash do we have",
    source: "brief",
    origin: "brief",
  },
  {
    query: "net debt",
    source: "brief",
    origin: "brief",
  },
  {
    query: "what is the EBITDA margin",
    source: "brief",
    origin: "brief",
  },
  {
    query: "current ratio",
    source: "brief",
    origin: "brief",
  },
  {
    query: "how many periods",
    source: "brief",
    origin: "brief",
  },
  {
    query: "is it balanced",
    source: "brief",
    origin: "brief",
  },
  {
    query: "what changed vs FY 2024",
    source: "brief",
    origin: "brief",
  },
  {
    query: "cifra de afaceri",
    source: "brief",
    origin: "brief",
  },
  {
    query: "cât e numerarul",
    source: "brief",
    origin: "brief",
  },
  {
    query: "care este profitul net",
    source: "brief",
    origin: "brief",
  },
  {
    query: "total datorii",
    source: "brief",
    origin: "brief",
  },
  {
    query: "câte perioade avem",
    source: "brief",
    origin: "brief",
  },
  {
    query: "e echilibrat bilanțul?",
    source: "brief",
    origin: "brief",
  },
  {
    query: "cash conversion cycle by product line",
    source: "brief",
    origin: "brief",
  },
  {
    query: "cash conversion cycle",
    source: "brief",
    origin: "brief",
  },
  {
    query: "revenue vs FY 2024",
    source: "brief",
    origin: "brief",
  },
  {
    query: "working capital",
    source: "brief",
    origin: "brief",
  },

  // ── E. THE SUGGESTIONS THE PRODUCT ITSELF OFFERS (24) ───────────────
  //
  // `capsuleEmptyStrings.json` → `capsuleEmpty.suggest.*`, resolved with the
  // fixture book's own period label. A user clicking one of these IS an
  // asked question, which makes this the highest-fidelity source in the
  // repository — and also the most judgement-heavy, because a suggestion
  // chip exists to START a conversation. `origin` is the key under
  // `capsuleEmpty.suggest.`.

  {
    query: "Dec 2025 has no file yet — what should I upload?",
    source: "suggestion",
    origin: "unattached.simple",
  },
  {
    query: "Dec 2025 is unattached — which document unlocks the statements?",
    source: "suggestion",
    origin: "unattached.pro",
  },
  {
    query: "Why did inventory get flagged this month?",
    source: "suggestion",
    origin: "finding.simple",
  },
  {
    query: "inventory — what drove it, and what does the first fix cost?",
    source: "suggestion",
    origin: "finding.pro",
  },
  {
    query: "Why doesn't Dec 2025 balance?",
    source: "suggestion",
    origin: "trust.imbalance.simple",
  },
  {
    query: "Dec 2025 — where does the imbalance sit, and on which side?",
    source: "suggestion",
    origin: "trust.imbalance.pro",
  },
  {
    query: "Is the drift in Dec 2025 something to worry about?",
    source: "suggestion",
    origin: "trust.drift.simple",
  },
  {
    query: "Dec 2025 drift — material, or rounding I can sign off?",
    source: "suggestion",
    origin: "trust.drift.pro",
  },
  {
    query: "What was adjusted to make Dec 2025 balance?",
    source: "suggestion",
    origin: "trust.reconciled.simple",
  },
  {
    query: "Dec 2025 reconciliation — placement, origin and rationale?",
    source: "suggestion",
    origin: "trust.reconciled.pro",
  },
  {
    query: "Can I still cover the loan payments?",
    source: "suggestion",
    origin: "covenant.dscr.simple",
  },
  {
    query: "DSCR headroom at current run-rate?",
    source: "suggestion",
    origin: "covenant.dscr.pro",
  },
  {
    query: "Can I keep paying the interest?",
    source: "suggestion",
    origin: "covenant.interestCover.simple",
  },
  {
    query: "Interest cover headroom at current run-rate?",
    source: "suggestion",
    origin: "covenant.interestCover.pro",
  },
  {
    query: "Is my debt getting heavy for the business?",
    source: "suggestion",
    origin: "covenant.leverage.simple",
  },
  {
    query: "Net debt / EBITDA headroom against a typical senior test?",
    source: "suggestion",
    origin: "covenant.leverage.pro",
  },
  {
    query: "Do I have enough to cover the next few months?",
    source: "suggestion",
    origin: "covenant.liquidity.simple",
  },
  {
    query: "Current-ratio headroom against a typical liquidity test?",
    source: "suggestion",
    origin: "covenant.liquidity.pro",
  },
  {
    query: "Nothing was flagged — what did you check?",
    source: "suggestion",
    origin: "silence.simple",
  },
  {
    query: "Clean month — which rules ran, and how close were the margins?",
    source: "suggestion",
    origin: "silence.pro",
  },
  {
    query: "What pushed inventory up this period?",
    source: "suggestion",
    origin: "move.up.simple",
  },
  {
    query: "inventory moved up — which drivers, and is it repeatable?",
    source: "suggestion",
    origin: "move.up.pro",
  },
  {
    query: "What pulled inventory down this period?",
    source: "suggestion",
    origin: "move.down.simple",
  },
  {
    query: "inventory moved down — which drivers, and how much is structural?",
    source: "suggestion",
    origin: "move.down.pro",
  },
]);

// ══════════════════════════════════════════════════════════════════════
// THE PINS — a view of the corpus, not a second corpus
// ══════════════════════════════════════════════════════════════════════
//
// What Tier 0 must DO with a question, for the 34 it has been pinned on.
// Asserted line by line in `capsuleTier0.test.ts` against the two real
// served periods in `__tests__/fixtures/capsuleTier0/`.
//
// Three of these look wrong at a glance and are deliberate:
//
//   · "what is EBITDA" is pinned to a FACT here while the router's
//     fixture note calls it a definition question. In a workspace with a
//     period loaded the overwhelmingly common intent is the figure;
//     offering the definition alongside it is the surface's job, not the
//     resolver's.
//   · "compare December and November revenue" is pinned to a REFUSAL.
//     The fixture workspace holds FY 2025 and FY 2024; answering about
//     those two would produce a delta that reads exactly like the one
//     asked for.
//   · "can we afford a 500k capex" is pinned to null even though it is a
//     money question — Tier 0 has no capex fact and no affordability
//     model, and a lookup tier that answered it would be inventing one.

export interface Tier0Pin {
  /** Must be a `query` present in `CAPSULE_ASK_CORPUS`. */
  query: string;
  /** The kind Tier 0 must return, or null for "hand it to the model". */
  expect: Tier0Kind | null;
  /** For `expect: "fact"` — the factKey it must resolve to. */
  factKey?: string;
  /** True when the expected answer is an honest refusal (facts empty,
   *  note set). Counts as HANDLED but not as ANSWERED. */
  refused?: boolean;
  /** Read this on failure. */
  note: string;
}

export const TIER0_PINS: readonly Tier0Pin[] = Object.freeze([
  {
    query: "Explain our current cash flow position in plain language for the management team.",
    expect: null,
    note:
      "the single most-repeated real question, and it is an interpretation request — 'explain' must reach the model",
  },
  {
    query: "What is our biggest financial risk right now? Cite the period and figures you used.",
    expect: null,
    note:
      "'risk' is a judgement; a lookup tier answering it would be inventing an opinion",
  },
  {
    query: "Tell me more about Operating Revenue (413.73M RON) for my company. What does this value mean in context?",
    expect: null,
    note:
      "names a metric AND carries a figure, but asks what it MEANS — 'mean' is an interpretation trigger",
  },
  {
    query: "why is cash down this month?",
    expect: null,
    note:
      "names a metric Tier 0 holds; 'why' must still win",
  },
  {
    query: "what changed vs last month",
    expect: "compare",
    note:
      "the canonical compare shape, with a relative baseline",
  },
  {
    query: "how much do we owe suppliers",
    expect: "fact",
    factKey: "bs.row.ap_trade",
    note:
      "a statement line named by its business meaning, not its label",
  },
  {
    query: "de ce a scăzut profitul?",
    expect: null,
    note:
      "RO 'de ce' — the interpretation gate is bilingual",
  },
  {
    query: "explain the 461 balance",
    expect: null,
    note:
      "an account code inside an explanation request",
  },
  {
    query: "is the balance sheet balanced",
    expect: "meta",
    note:
      "the verdict is the engine's SERVED status, not a local tolerance comparison",
  },
  {
    query: "compare December and November revenue",
    expect: "meta",
    refused: true,
    note:
      "names two periods this workspace does not hold — refuses rather than answering about FY 2025 vs FY 2024",
  },
  {
    query: "show me the biggest risk in this period",
    expect: null,
    note:
      "'risk' again, this time behind an action verb",
  },
  {
    query: "can we afford a 500k capex",
    expect: null,
    note:
      "money-shaped but unanswerable from facts — no capex fact, no affordability model",
  },
  {
    query: "what is EBITDA",
    expect: "fact",
    factKey: "ebitda",
    note:
      "DELIBERATE divergence from the router fixture's note — in a loaded workspace this asks for the figure",
  },
  {
    query: "ce înseamnă datorie netă",
    expect: "meta",
    note:
      "RO definition question. Answered at Tier 0 from the SHIPPED glossary (lib/glossary.ts, entry net_debt) — reviewed copy, zero model, no figure. Paying a model for a sentence the app already wrote is the waste this tier exists to remove",
  },
  {
    query: "cine sunt cei mai mari clienți",
    expect: "meta",
    refused: true,
    note:
      "RO. REFUSED, not routed: a trial balance carries the trade-receivables total and no customer list, and the model works from the same facts — escalating buys a hedge, not an answer",
  },
  {
    query: "total assets",
    expect: "fact",
    factKey: "total_assets",
    note:
      "bare metric, the plainest lookup",
  },
  {
    query: "revenue",
    expect: "fact",
    factKey: "revenue",
    note:
      "methodology revenue_net, not assembled_pl",
  },
  {
    query: "how much cash do we have",
    expect: "fact",
    factKey: "cash",
    note:
      "opener + filler tail around one metric",
  },
  {
    query: "net debt",
    expect: "fact",
    factKey: "net_debt",
    note:
      "a methodology total",
  },
  {
    query: "what is the EBITDA margin",
    expect: "fact",
    factKey: "ebitda_margin",
    note:
      "a derived percent on native operands",
  },
  {
    query: "current ratio",
    expect: "fact",
    factKey: "current_ratio",
    note:
      "must beat 'current assets' on term length",
  },
  {
    query: "how many periods",
    expect: "meta",
    note:
      "a property of the index, not of the business",
  },
  {
    query: "is it balanced",
    expect: "meta",
    note:
      "the short form of the balance question",
  },
  {
    query: "what changed vs FY 2024",
    expect: "compare",
    note:
      "names a period the workspace DOES hold",
  },
  {
    query: "cifra de afaceri",
    expect: "fact",
    factKey: "revenue",
    note:
      "RO, bare metric",
  },
  {
    query: "cât e numerarul",
    expect: "fact",
    factKey: "cash",
    note:
      "RO definite article — 'numerarul', not 'numerar'",
  },
  {
    query: "care este profitul net",
    expect: "fact",
    factKey: "net_result",
    note:
      "RO opener + inflected metric",
  },
  {
    query: "total datorii",
    expect: "fact",
    factKey: "total_liabilities",
    note:
      "RO, two words",
  },
  {
    query: "câte perioade avem",
    expect: "meta",
    note:
      "RO period count",
  },
  {
    query: "e echilibrat bilanțul?",
    expect: "meta",
    note:
      "RO balance question with diacritics and a question mark",
  },
  {
    query: "cash conversion cycle by product line",
    expect: "meta",
    refused: true,
    note:
      "REFUSED as a per-product split. Was pinned to null on the first draft; the no-breakdown rule caught it, and the rule is right — a trial balance has no product dimension, so the model would be guessing from the same facts",
  },
  {
    query: "cash conversion cycle",
    expect: null,
    note:
      "the T2 case proper: 'cash' is a known metric, 'conversion cycle' is real meaning the index does not hold, and nothing here is a refusable concept — so it goes to the model",
  },
  {
    query: "revenue vs FY 2024",
    expect: "compare",
    note:
      "one named metric, one named period — the single-metric compare that populates deltaPct",
  },
  {
    query: "working capital",
    expect: "fact",
    factKey: "working_capital",
    note:
      "gateway accessor, not a bucket sum",
  },
]);

/** Pins whose answer must carry FACTS, not just a verdict. */
export const TIER0_PINS_ANSWERED: readonly Tier0Pin[] =
  TIER0_PINS.filter((p) => p.expect !== null && !p.refused);

/** Pins Tier 0 must handle at all — an answer OR an honest refusal.
 *  Both are free; a refusal costs no model call either. */
export const TIER0_PINS_HANDLED: readonly Tier0Pin[] =
  TIER0_PINS.filter((p) => p.expect !== null);

/**
 * The brief's bar for zero-spend coverage over this corpus.
 *
 * Reported against the MEASURED number by the gate; it is never used to
 * soften an assertion, and it is not moved to meet a measurement. A
 * threshold adjusted to make a gate green is worse than a red gate,
 * because it stops anyone from ever looking again.
 */
export const ASK_COVERAGE_FLOOR = 0.6;
