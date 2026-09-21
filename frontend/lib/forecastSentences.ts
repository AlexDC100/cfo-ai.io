// THE ENGINE'S FIXED SENTENCES, in the reader's language
// (forecast-scenarios-live).
//
// The forecast engine serves every explanation as an English sentence with a
// code ({code, text}); the Forecast and Scenarios pages print it verbatim.
// Most of those sentences carry the book's own figures (a basis quoting two
// turnovers, a rate quoting interest and debt) and stay the engine's words.
// A handful are FIXED — the same words on every book, no figure in them —
// and those are the ones a Romanian reader met in English on an otherwise
// Romanian page: the covenant slot's refusal, the runway's "no shortfall",
// the facility limit, the three executive-strip formulas.
//
// This module translates exactly that allowlist, by the served CODE (a
// formula, which the wire serves as a bare string, by its served text).
// English always prints the served text itself, so an engine that rewords a
// sentence is never overruled by a stale copy here; any code or formula not
// on the list — and every sentence carrying a figure — falls through to the
// served words unchanged. Nothing here reads, writes or formats a number.

import type { TFunction } from "i18next";

/** Codes whose served text is the same words on every book. */
const FIXED_CODES = new Set([
  "not_served_in_this_build",
  "runway_none",
  "facility_limit_not_loaded",
  // the lever rail's "not served by this engine" list (client.unserved)
  "fx_rate_move",
  "headcount",
  "avg_personnel_cost",
  "segment_growth",
  "policy_rate_shift",
]);

/** Strip formulas the wire serves as bare strings, by their served text. */
const FORMULAS: Record<string, string> = {
  "sum of operating and investing cash over the served periods": "cumulativeFcf",
  "closing cash of the cash flow statement": "closingCash",
  "opening + funding line draw - funding line repayment": "fundingLine",
};

const isEnglish = (lang: string | undefined) => !lang || lang.toLowerCase().startsWith("en");

/** A served {code, text} sentence in the reader's language. */
export function servedSentence(
  t: TFunction,
  lang: string | undefined,
  code: string | null | undefined,
  text: string,
): string {
  if (isEnglish(lang) || !code || !FIXED_CODES.has(code)) return text;
  return t(`forecast.served.${code}`, { defaultValue: text });
}

/** A served formula string in the reader's language. */
export function servedFormula(t: TFunction, lang: string | undefined, text: string): string {
  const key = FORMULAS[text.trim()];
  if (isEnglish(lang) || !key) return text;
  return t(`forecast.formula.${key}`, { defaultValue: text });
}
