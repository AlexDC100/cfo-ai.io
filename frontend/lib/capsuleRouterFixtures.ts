// THE CAPSULE — the router's fixture set (gate C4).
//
// Forty-six queries a real operator of this product actually types,
// each pinned to the lane it must land in. The gate asserts 100%: not "most
// of them", not "no regressions" — every line, every run. A router that
// is right 90% of the time is a router that sends one question in ten to
// the wrong surface, and the ones it gets wrong are the interesting
// ones.
//
// Two properties are load-bearing beyond the lane label:
//
//   · NAV_NEVER_MODEL — the navigation, entity and action queries must
//     never put the Ask row under the default selection. Typing
//     "dashboard" and pressing Enter has to be free. Anthropic credits
//     are live; a router that quietly bills a model call for navigation
//     is a bug with an invoice attached.
//   · AMBIGUOUS — queries that legitimately read two ways ("is the
//     balance sheet balanced" is a question that names a page) must
//     return BOTH the page and the Ask row, never one at the other's
//     expense.
//   · HOW-TO — the interrogative form of an action query ("how do i
//     export the balance sheet") lands in the lane its IMPERATIVE lands
//     in, because the imperative already navigates for free and a
//     question mark is not worth a model call.
//
// EN and RO both appear throughout, because this product is used in
// both and a router tuned only on English quietly demotes half the
// users to the fallback lane.

import type { CapsuleLane, CapsuleRouterContext } from "./capsuleRouter";

export interface CapsuleRouterFixture {
  /** Exactly what the user types. */
  query: string;
  /** The lane it must classify into. */
  lane: CapsuleLane;
  /** Why this line is in the set — read on failure. */
  note: string;
}

/** The universe the fixtures are classified against. Small and fixed:
 *  the gate must fail on a ROUTER change, never on a data refresh. */
export const FIXTURE_CONTEXT: CapsuleRouterContext = Object.freeze({
  tickers: Object.freeze([
    { ticker: "TLV", name: "Banca Transilvania" },
    { ticker: "SNP", name: "OMV Petrom" },
    { ticker: "AAPL", name: "Apple Inc" },
  ]),
});

export const CAPSULE_ROUTER_FIXTURES: readonly CapsuleRouterFixture[] =
  Object.freeze([
    // ── NAVIGATE (12) — short noun phrases naming a destination ───────
    { query: "dashboard", lane: "navigate",
      note: "the plainest case; must cost nothing" },
    { query: "scenarios", lane: "navigate",
      note: "rail destination by its own name" },
    { query: "benchmark", lane: "navigate",
      note: "rail destination by its own name" },
    { query: "products", lane: "navigate",
      note: "rail destination by its own name" },
    { query: "alerts", lane: "navigate",
      note: "six letters that also read as a ticker shape — the exact "
          + "route name must win" },
    { query: "cash flow", lane: "navigate",
      note: "statement anchor, two words" },
    { query: "balance sheet", lane: "navigate",
      note: "statement anchor; the same words appear inside ask fixtures" },
    { query: "settings", lane: "navigate", note: "rail destination" },
    { query: "public companies", lane: "navigate",
      note: "two-word destination" },
    { query: "bilanț", lane: "navigate",
      note: "RO with diacritics — folding must reach the token" },
    { query: "facturi", lane: "navigate", note: "RO destination" },
    { query: "variance", lane: "navigate", note: "rail destination" },

    // ── ENTITY (8) — shapes, not words ───────────────────────────────
    { query: "TLV", lane: "entity", note: "known BVB ticker" },
    { query: "SNP.BVB", lane: "entity",
      note: "suffixed ticker the known-ticker list does not carry — the "
          + "SHAPE has to catch it" },
    { query: "461", lane: "entity",
      note: "the account behind the worked 461 note" },
    { query: "cont 5121", lane: "entity", note: "RO account prefix" },
    { query: "account 401", lane: "entity", note: "EN account prefix" },
    { query: "RO14399840", lane: "entity",
      note: "CUI with the RO prefix — must not read as a ticker" },
    { query: "AAPL", lane: "entity", note: "known US ticker" },
    { query: "2131", lane: "entity",
      note: "bare four-digit account code" },

    // ── ACTION (8) — verb phrases naming a registered command ────────
    { query: "upload trial balance", lane: "action",
      note: "the product's single most common instruction" },
    { query: "export excel", lane: "action", note: "verb + format" },
    { query: "încarcă balanța", lane: "action",
      note: "RO upload, diacritics and inflection" },
    { query: "switch to dark theme", lane: "action",
      note: "four words, verb-led, no question shape" },
    { query: "new chat", lane: "action",
      note: "contains the word 'chat', which is also a route — the verb "
          + "phrase must win" },
    { query: "download report", lane: "action",
      note: "contains 'report', also a route" },
    { query: "toggle sidebar", lane: "action", note: "chrome command" },
    { query: "exportă raportul", lane: "action",
      note: "RO inflection: 'raportul' must reach the stem 'raport'" },

    // ── ASK (12) — questions, in both languages ──────────────────────
    { query: "why is cash down this month?", lane: "ask",
      note: "trailing question mark, and it names a route word" },
    { query: "what changed vs last month", lane: "ask",
      note: "interrogative lead, no question mark" },
    { query: "how much do we owe suppliers", lane: "ask",
      note: "natural-language opener" },
    { query: "de ce a scăzut profitul?", lane: "ask",
      note: "RO question; 'profit' is also a route token" },
    { query: "explain the 461 balance", lane: "ask",
      note: "an account code inside a question — ask must outrank the "
          + "entity shape" },
    { query: "is the balance sheet balanced", lane: "ask",
      note: "a question that names a page; both must be offered" },
    { query: "compare December and November revenue", lane: "ask",
      note: "comparison shape, no question mark" },
    { query: "cine sunt cei mai mari clienți", lane: "ask",
      note: "RO interrogative lead" },
    { query: "show me the biggest risk in this period", lane: "ask",
      note: "'show' is an action verb with no object — must not be an "
          + "action" },
    { query: "can we afford a 500k capex", lane: "ask",
      note: "modal lead; contains a number that is not an account code" },
    { query: "what is EBITDA", lane: "ask",
      note: "definition question — the help lane answers it, not a route" },
    { query: "ce înseamnă datorie netă", lane: "ask",
      note: "RO definition question" },

    // ── HOW-TO (6) — the interrogative form of an action query ────────
    //
    // The defect this section was written for: "export the balance
    // sheet" classified NAVIGATE and cost nothing, while "how do i
    // export the balance sheet" classified ASK and billed a model call
    // to reach the same page. The question form of a navigation query is
    // still a navigation query, and the navigation lane's promise is
    // that it never spends.
    //
    // The last two lines are the other half of the same rule, and they
    // are why the redirection is safe: route tokens are also ordinary
    // nouns, so a residue carrying an ADVICE VERB stays a question.
    // Without them the redirection would answer "how do i reduce
    // inventory" with the Inventory page.
    { query: "how do i export the balance sheet", lane: "navigate",
      note: "THE defect: the imperative navigates for free, so the "
          + "interrogative must too — same destination, same zero cost" },
    { query: "how do i upload a trial balance", lane: "action",
      note: "the residue is verb + object, so the redirection lands on "
          + "the COMMAND rather than on a page" },
    { query: "cum pot să export raportul", lane: "action",
      note: "RO how-to with diacritics; 'raportul' still reaches the "
          + "stem 'raport' through the action rule's substring match" },
    { query: "how do i improve cash flow", lane: "ask",
      note: "names a route token, but 'improve' is a request for a "
          + "judgement — the model is the right home and the "
          + "redirection must refuse it" },
    { query: "how do i reduce inventory", lane: "ask",
      note: "'inventory' is a destination AND an ordinary noun; without "
          + "the advice-verb guard this would open a page instead of "
          + "answering the question" },
    { query: "how do i", lane: "ask",
      note: "the opener with nothing behind it is not yet a question "
          + "about anything — it must not redirect to a random route" },
  ]);

/** The subset whose Enter key must never reach a model. */
export const NAV_NEVER_MODEL: readonly CapsuleRouterFixture[] =
  CAPSULE_ROUTER_FIXTURES.filter((f) => f.lane !== "ask");

/** Queries that legitimately read as two lanes at once. */
export const AMBIGUOUS_FIXTURES: readonly string[] = Object.freeze([
  "is the balance sheet balanced",
  "why is cash down this month?",
  "new chat",
  "download report",
]);
