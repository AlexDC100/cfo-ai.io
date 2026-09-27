// A BRIEFING WRITTEN UNDER ANOTHER EBITDA DEFINITION IS NOT SHOWN.
//
// Owner ruling 2026-09-26 (design A9): the one EBITDA includes the stock
// variation (711) and own work capitalised (72x). Every briefing is stamped
// with the definition its prose was written under, and `GET /api/period`
// serves `briefing.definition` = { written_under, current_definition,
// written_under_previous_definition, note {ro, en} }. A briefing written
// under an earlier definition quotes an EBITDA the page no longer prints,
// so it is HIDDEN, and the engine's one-line note stands in its place —
// never shown with stale numbers, never silently dropped.
//
// A payload with no `definition` block (a sample, a pre-stamp capture the
// route never re-served) is shown as before: the route serves the block on
// every stored briefing, so its absence is not a claim about the prose.

import type { Bilingual } from "./servedOneEbitda";

export interface BriefingVisibility {
  /** The prose to show; null when hidden (or when there is none). */
  body: string | null;
  /** The engine's note when the prose is hidden for its definition. */
  hiddenNote: Bilingual | null;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The served briefing's visibility under the current EBITDA definition. */
export function briefingVisibility(briefing: unknown): BriefingVisibility {
  if (!isRec(briefing)) return { body: null, hiddenNote: null };
  const body = typeof briefing.body === "string" && briefing.body.trim() ? briefing.body : null;
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
              ro: "Comentariul a fost scris sub definiția anterioară a EBITDA și este ascuns.",
              en: "This briefing was written under the previous EBITDA definition and is hidden.",
            },
    };
  }
  return { body, hiddenNote: null };
}
