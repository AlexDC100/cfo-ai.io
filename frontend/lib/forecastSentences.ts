// THE ENGINE'S SENTENCES, in the reader's language
// (forecast-scenarios-live, RO + EN).
//
// The forecast engine serves every explanation as an English sentence with a
// code ({code, text}); the Forecast and Scenarios pages print it in the
// reader's language through this module, and ENGLISH ALWAYS PRINTS THE SERVED
// TEXT ITSELF, so an engine that rewords a sentence is never overruled by a
// stale copy here.
//
// Two kinds of sentence, two routes into Romanian:
//   · FIXED — the same words on every book, no figure in them (the covenant
//     slot's refusal, the runway's "no shortfall", the facility limit, the
//     lever rail's "not served" list, the three executive-strip formulas):
//     translated by the served CODE (a formula by its served text) from the
//     locale bundle, forecast.served.* / forecast.formula.*.
//   · CARRYING FIGURES — a basis quoting two turnovers, a rate quoting
//     interest and debt: re-said by lib/forecastSentencesRo.ts, one rule per
//     engine template, under its DIGIT LAW (every digit printed is one the
//     engine served; the check runs on every call and a breach prints the
//     English). A sentence no rule matches in full prints as served.
// Nothing here reads, computes or rounds a number.

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { driverName, translateServedRo } from "@/lib/forecastSentencesRo";

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
  // owner ruling 2026-09-26: 711 / 72x are inside the actual year's EBITDA
  // and nil in every plan year
  "stock_variation",
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
  if (isEnglish(lang) || !text) return text;
  if (code && FIXED_CODES.has(code)) return t(`forecast.served.${code}`, { defaultValue: text });
  return translateServedRo(t, text) ?? text;
}

/** A served sentence with no code at hand, in the reader's language. */
export function servedText(t: TFunction, lang: string | undefined, text: string): string {
  return servedSentence(t, lang, null, text);
}

/** A driver's name in the reader's language: the locale bundle's name for
 *  the served id, the served label when the bundle has none. */
export function servedDriverLabel(t: TFunction, id: string, served: string): string {
  return driverName(t, id, served || id);
}

/** The page-side binding: `say(text, code?)` in the active language. */
export function useServedText(): (text: string, code?: string | null) => string {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (text: string, code?: string | null) => servedSentence(t, lang, code ?? null, text);
}

/** A served formula string in the reader's language. */
export function servedFormula(t: TFunction, lang: string | undefined, text: string): string {
  const key = FORMULAS[text.trim()];
  if (isEnglish(lang) || !key) return text;
  return t(`forecast.formula.${key}`, { defaultValue: text });
}
