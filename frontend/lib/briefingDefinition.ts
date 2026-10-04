// WHAT OF A STORED BRIEFING A READER MAY SEE — the one chokepoint.
//
// The dashboard card (lib/activePeriod), the CFO Report, the chat snapshot
// and the command bar all read the served `briefing` through
// `briefingVisibility()`; none of them reads `briefing.body` itself.
//
// 1. A BRIEFING WRITTEN UNDER ANOTHER EBITDA DEFINITION IS NOT SHOWN.
//    Owner ruling 2026-09-26 (design A9): the one EBITDA includes the stock
//    variation (711) and own work capitalised (72x). Every briefing is stamped
//    with the definition its prose was written under, and `GET /api/period`
//    serves `briefing.definition` = { written_under, current_definition,
//    written_under_previous_definition, note {ro, en} }. A briefing written
//    under an earlier definition quotes an EBITDA the page no longer prints,
//    so it is HIDDEN, and the engine's one-line note stands in its place —
//    never shown with stale numbers, never silently dropped.
//
//    A payload with no `definition` block (a sample, a pre-stamp capture the
//    route never re-served) is shown as before: the route serves the block on
//    every stored briefing, so its absence is not a claim about the prose.
//
// 2. A FAILURE TEXT IS NEVER PROSE. Owner ruling 2026-10-02: a failed
//    narration never replaces a stored briefing; the last good one is kept
//    and marked stale. The route serves a row that holds a failure text as
//    `body: null, unavailable: true`, and a kept briefing with
//    `stale: {since, reason}`. Rows written before the ruling can still hold
//    the sentinel or a provider's error sentence, and a tab can meet an
//    engine that predates the served flag — so the same text predicate runs
//    here: an unusable body is `unavailable`, with a note, never printed.
//
// New properties are left UNDEFINED when not set: a usable, current briefing
// reads exactly `{ body, hiddenNote: null }`.

import type { Bilingual } from "./servedOneEbitda";

/** A kept briefing whose later narration failed (served `briefing.stale`). */
export interface BriefingStale {
  since: string | null;
  /** A neutral code (provider_error, no_api_key, …) — never provider text. */
  reason: string | null;
}

export interface BriefingVisibility {
  /** The prose to show; null when hidden, unavailable, or when there is none. */
  body: string | null;
  /** The engine's note when the prose is hidden for its definition. */
  hiddenNote: Bilingual | null;
  /** Set when the stored row holds no usable narration. */
  unavailable?: true;
  /** The note standing in for an unavailable briefing. */
  unavailableNote?: Bilingual;
  /** Set when the prose shown is the last good one, kept after a failure. */
  stale?: BriefingStale;
  /** The language stamp the route served for the prose, when it served one. */
  language?: string;
}

/** The note for an unavailable briefing. Held equal to `dash.narrativeUnavailable`
 *  in both locale files by components/cfo/__tests__/briefingExplicitRegenerate.test.tsx. */
export const BRIEFING_UNAVAILABLE_NOTE: Bilingual = {
  ro: "Briefingul AI nu este disponibil pentru această perioadă — cifrele analizei nu sunt afectate.",
  en: "The AI briefing is unavailable for this period — the analysis figures are unaffected.",
};

// Every text a failed narration has ever been stored as, recognised by the
// SHAPE of the body — never by a phrase somewhere inside it. THE SAME
// PREDICATE AS THE ENGINE'S `stored_briefing_failure_code`
// (src/engine/api/pipeline.py); change both together:
//   · the sentinel;
//   · a body that BEGINS "Narrative unavailable…" (the empty-reply fallback,
//     and the old provider branch, which appended the provider's error);
//   · a body that BEGINS with the SDK's own error text ("Error code: 400 …");
//   · the two configuration sentences and the numeral-guard sentence, at the
//     start of the body;
//   · the head of a raw model reply stored as the body: it begins with `{`
//     or a backtick. No briefing does.
//
// Until 2026-10-03 the provider's phrases ("credit balance is too low",
// "invalid_request_error", "Error code: N") and "Narrative unavailable" were
// searched ANYWHERE in the body. "Credit balance" (sold creditor) is this
// product's own vocabulary: a good briefing saying a supplier's "credit
// balance is too low" — one the engine serves as usable — was hidden here.
// A false positive is not a harmless refusal: it hides a good briefing.
const SENTINEL = "[NARRATIVE_UNAVAILABLE]";
// Case as the engine reads it: the three sentences and the reply head exactly,
// "Narrative unavailable" and "Error code:" in any case.
const FAILURE_SENTENCE_AT_THE_START =
  /^(?:Set ANTHROPIC_API_KEY|anthropic SDK not installed|The briefing was withheld:|[{`])/;
const FAILURE_PREFIX_AT_THE_START = /^(?:narrative unavailable|Error code: \d)/i;

/** True when a body is not prose a reader may be shown: absent, empty, or a
 *  failure text. */
export function isUnusableNarrative(s: string | null | undefined): boolean {
  if (!s || !s.trim()) return true;
  const text = s.trim();
  return (
    text.includes(SENTINEL) ||
    FAILURE_SENTENCE_AT_THE_START.test(text) ||
    FAILURE_PREFIX_AT_THE_START.test(text)
  );
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** What of the served briefing a reader may see. */
export function briefingVisibility(briefing: unknown): BriefingVisibility {
  if (!isRec(briefing)) return { body: null, hiddenNote: null };
  const served = typeof briefing.body === "string" && briefing.body.trim() ? briefing.body : null;
  // Unavailable: the route says so, or the body it served is a failure text.
  if (briefing.unavailable === true || (served !== null && isUnusableNarrative(served))) {
    return { body: null, hiddenNote: null, unavailable: true, unavailableNote: BRIEFING_UNAVAILABLE_NOTE };
  }
  const body = served;
  const def = isRec(briefing.definition) ? briefing.definition : null;
  if (body !== null && def && def.written_under_previous_definition === true) {
    const note = isRec(def.note) ? def.note : null;
    const ro = typeof note?.ro === "string" ? note.ro : null;
    const en = typeof note?.en === "string" ? note.en : null;
    return {
      body: null,
      hiddenNote:
        ro && en
          ? { ro, en }
          : {
              ro: "Comentariul a fost scris sub o definiție anterioară a EBITDA și este ascuns; reanalizați perioada pentru un comentariu nou.",
              en: "This briefing was written under an earlier EBITDA definition and is hidden; re-analyse the period for a new one.",
            },
    };
  }
  const out: BriefingVisibility = { body, hiddenNote: null };
  if (body !== null) {
    if (isRec(briefing.stale)) {
      out.stale = { since: strOrNull(briefing.stale.since), reason: strOrNull(briefing.stale.reason) };
    }
    const language = strOrNull(briefing.language);
    if (language) out.language = language;
  }
  return out;
}
