// THE CAPSULE — scope honesty (Part F.6).
//
// The Capsule answers two different kinds of question with one input:
// questions about YOUR books ("why did receivables jump"), and general
// finance questions the assistant is genuinely good at ("what is a
// covenant"). Both are legitimate — the chat surface has always answered
// both (CFOChatShell's "No workspace loaded — open-domain mode"). What is
// NOT legitimate is letting the second look like the first.
//
// So every answer wears a scope label, and the honest one is the loud
// one: an answer that cites nothing from your period says so, in words,
// next to itself.
//
// ── Why this is derived, not asked ────────────────────────────────────
//
// The scope is NOT a guess about the question's wording. Classifying
// intent from the query would be a heuristic that fails exactly where it
// matters (a general-sounding question CAN be grounded, and vice versa).
// It is derived from what the answer actually CITED: the count of
// resolved fact placeholders bound against the tool payload's `facts`
// bridge. Zero cited facts is, by definition, not from your books.
//
// Pure — no i18n, no React, no clock. The label component renders it.

export type CapsuleAnswerScope = "books" | "general" | "mixed";

export interface CapsuleScopeInput {
  /** A period is loaded — there are books to cite at all. */
  hasPeriod: boolean;
  /** How many fact placeholders the answer actually resolved. */
  citedFactCount: number;
  /** The answer also drew on general knowledge — set by the answer lane
   *  when the model's response carried a general-knowledge segment
   *  alongside grounded ones. Absent is treated as false, which is the
   *  conservative reading: an answer that cites facts is called grounded
   *  only when nothing says otherwise. */
  usedGeneralKnowledge?: boolean;
}

/**
 * What an answer may honestly claim.
 *
 *   general  cited nothing from the period — general finance knowledge
 *   mixed    cited the period AND leaned on general knowledge
 *   books    cited the period, and only the period
 *
 * With no period loaded the answer is ALWAYS "general": a citation count
 * cannot be meaningful when there is nothing to cite, so a non-zero count
 * arriving with `hasPeriod: false` is treated as the contradiction it is
 * and clamped — the label degrades toward honesty, never away from it.
 */
export function scopeOfAnswer(input: CapsuleScopeInput): CapsuleAnswerScope {
  const cited = input.hasPeriod
    ? Math.max(0, Math.trunc(input.citedFactCount ?? 0))
    : 0;
  if (cited === 0) return "general";
  return input.usedGeneralKnowledge ? "mixed" : "books";
}

/** i18n key for the label text. `books` interpolates `{{period}}` when
 *  the caller has a period label; without one it falls back to the
 *  period-free wording rather than printing an empty interpolation. */
export function scopeLabelKey(
  scope: CapsuleAnswerScope,
  hasPeriodLabel: boolean,
): string {
  if (scope === "books") {
    return hasPeriodLabel ? "capsuleEmpty.scope.books" : "capsuleEmpty.scope.booksNoPeriod";
  }
  return scope === "mixed" ? "capsuleEmpty.scope.mixed" : "capsuleEmpty.scope.general";
}

/** i18n key for the explanatory line, or null when the label says it all
 *  (a grounded answer needs no apology). */
export function scopeHintKey(scope: CapsuleAnswerScope): string | null {
  if (scope === "general") return "capsuleEmpty.scope.generalHint";
  if (scope === "mixed") return "capsuleEmpty.scope.mixedHint";
  return null;
}
