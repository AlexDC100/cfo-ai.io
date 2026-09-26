// comparisonRefusal.ts — the engine's refusal of a comparison, in words.
//
// `GET /api/period/{id}/comparatives` refuses with a CODE and a message
// (src/engine/api/_comparatives.py, pipeline.get_period_comparatives). The
// message is the engine's own diagnostic line, and one of them carries a raw
// period id: `period_not_in_workspace` says "period '<uuid>' is not in this
// workspace". On 2026-09-26 that line reached the dashboard Overview verbatim
// ("No comparison: period '<uuid>' is not in this workspace").
//
// So every surface reads the CODE only and prints the sentence written for it
// here; a code without a sentence of its own prints the general one. The
// engine's message is never printed — the views and the exports do not even
// carry it.

/** The refusal codes the comparatives route answers with. */
export const COMPARISON_REFUSAL_CODES = [
  "same_period",
  "period_not_in_workspace",
  "period_not_servable",
] as const;

/** The i18n key of the sentence for a refusal code. */
export function comparisonRefusalKey(code: string | null | undefined): string {
  switch (code) {
    case "same_period":
      return "statements.cmp.refusedSame";
    case "period_not_in_workspace":
      return "statements.cmp.refusedNotInWorkspace";
    case "period_not_servable":
      return "statements.cmp.refusedNotServable";
    default:
      return "statements.cmp.refusedGeneric";
  }
}

/** The same sentences in English, for the exports (the report and the
 *  workbook are written in English). Held equal to en.json by
 *  lib/__tests__/comparisonRefusal.test.ts. */
export const COMPARISON_REFUSAL_ENGLISH: Readonly<Record<string, string>> = {
  "statements.cmp.refusedSame": "A period cannot be compared with itself.",
  "statements.cmp.refusedNotInWorkspace": "The comparison period belongs to another company.",
  "statements.cmp.refusedNotServable": "The comparison period has no analysed figures to compare.",
  "statements.cmp.refusedGeneric": "These two periods can't be compared.",
};

/** A refusal code's sentence in English. */
export function comparisonRefusalEnglish(code: string | null | undefined): string {
  return COMPARISON_REFUSAL_ENGLISH[comparisonRefusalKey(code)];
}

/** The English sentence as a clause inside another sentence ("… refused
 *  the comparison (code): the comparison period belongs to another company
 *  — so …"): first letter lower-cased, closing full stop dropped. */
export function comparisonRefusalEnglishInline(code: string | null | undefined): string {
  const sentence = comparisonRefusalEnglish(code);
  const clause = sentence.endsWith(".") ? sentence.slice(0, -1) : sentence;
  return clause.charAt(0).toLowerCase() + clause.slice(1);
}
