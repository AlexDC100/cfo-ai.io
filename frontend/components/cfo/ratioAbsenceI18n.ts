// Refused-ratio sentences, in both languages (2026-09-04).
//
// ── THE DEFECT THIS CLOSES ────────────────────────────────────────────
//
// `financialReport.describeAbsence()` returns hard-coded English:
//
//     "Not reported — this filing does not carry interest expense."
//
// and it was rendered directly as `ratio.commentary` under a verdict chip
// that IS translated (`t("dashV2.ratioVerdictUnknown")` → "Neraportat").
// A Romanian reader therefore saw a Romanian chip sitting on top of an
// English sentence. That is a HALF-BUILT REFUSAL: the chip tells them the
// number is missing, the sentence — the only part that says WHICH input is
// missing and therefore what to do about it — is unreadable.
//
// The refusal is structured at the source (`absenceI18n()` returns a key
// plus its interpolation values), so the two languages are two spellings
// of one decision rather than two decisions.
//
// ── WHY THE KEYS ARE REGISTERED HERE ─────────────────────────────────
//
// i18n/locales/{en,ro}.json are owned by the i18n workstream. Same pattern
// as `bsCanonicalStatusI18n.ts` and `components/dashboard/metricsV2I18n.ts`:
// register at module load with `overwrite=false`, so if these keys are
// later merged into the locale JSONs the merged values win and this
// becomes a harmless no-op.
//
// ── THE INPUT WORDS ──────────────────────────────────────────────────
//
// `absenceI18n().vars.inputs` is a joined ENGLISH list ("cost of sales and
// interest expense") because `financialReport.INPUT_WORDS` is the English
// vocabulary. `RATIO_ABSENCE_INPUT_RO` translates each word; the renderer
// re-joins with the Romanian conjunction, so the Romanian sentence never
// carries an English fragment. A word with no Romanian entry falls back to
// the English one — visible, and better than dropping the term the reader
// needs to go find in their own books.

import i18n from "@/i18n";
import { absenceI18n } from "@/lib/financialReport";
import type { FigureAbsence } from "@/lib/absentAware";

const ratioAbsenceEn = {
  undefinedRatio:
    "Undefined — {{denominator}} is zero, so this ratio has no value for this period.",
  missingNamed: "Not reported — this filing does not carry {{inputs}}.",
  missingUnnamed: "Not reported — an input this ratio needs is missing from the filing.",
};

const ratioAbsenceRo = {
  undefinedRatio:
    "Nedefinit — {{denominator}} este zero, deci acest indicator nu are valoare pentru această perioadă.",
  missingNamed: "Neraportat — această raportare nu conține {{inputs}}.",
  missingUnnamed:
    "Neraportat — o valoare de care are nevoie acest indicator lipsește din raportare.",
};

i18n.addResourceBundle("en", "translation", { ratioAbsence: ratioAbsenceEn }, true, false);
i18n.addResourceBundle("ro", "translation", { ratioAbsence: ratioAbsenceRo }, true, false);

/** Reader-facing Romanian for each `financialReport.INPUT_WORDS` value.
 *  Keyed by the ENGLISH word, because that is what `absenceI18n` emits. */
const RATIO_ABSENCE_INPUT_RO: Record<string, string> = {
  "cash": "disponibilități",
  "trade receivables": "creanțe comerciale",
  "inventory": "stocuri",
  "other current assets": "alte active circulante",
  "property, plant & equipment": "imobilizări corporale",
  "intangible assets": "imobilizări necorporale",
  "other non-current assets": "alte active imobilizate",
  "trade payables": "datorii comerciale",
  "short-term debt": "datorii financiare pe termen scurt",
  "other current liabilities": "alte datorii curente",
  "long-term debt": "datorii financiare pe termen lung",
  "other non-current liabilities": "alte datorii pe termen lung",
  "share capital": "capital social",
  "retained earnings": "rezultat reportat",
  "other equity": "alte elemente de capitaluri proprii",
  "revenue": "cifra de afaceri",
  "cost of sales": "costul vânzărilor",
  "operating expenses": "cheltuieli de exploatare",
  "depreciation & amortization": "amortizare",
  "interest expense": "cheltuieli cu dobânzile",
  "other operating income": "alte venituri din exploatare",
  "income tax": "impozit pe profit",
  "financial income": "venituri financiare",
  "financial expense": "cheltuieli financiare",
  // Gateway totals — these reach a refusal through `computeRatios`'
  // `gate(...)` closures when the served envelope did not carry the total.
  "current assets": "active circulante",
  "current liabilities": "datorii curente",
  "total assets": "total active",
  "total equity": "total capitaluri proprii",
  "total liabilities": "total datorii",
  "working capital": "capital de lucru",
};

/** The denominator name inside the `undefinedRatio` sentence. Falls back
 *  to the English term rather than dropping it. */
function localizeTerm(word: string, lang: string): string {
  if (!lang.toLowerCase().startsWith("ro")) return word;
  return RATIO_ABSENCE_INPUT_RO[word] ?? word;
}

/** Build the reader's refusal sentence in the ACTIVE language.
 *
 *  `t` is the caller's translator (from `useTranslation()`), so the
 *  sentence follows the same language as the chip rendered beside it —
 *  which is the entire point of this module. */
export function absenceSentence(
  t: (key: string, opts?: Record<string, unknown>) => string,
  a: FigureAbsence,
  lang: string = i18n.language ?? "en",
): string {
  const d = absenceI18n(a);
  // `lng` is passed explicitly so the SENTENCE and the INPUT WORDS can
  // never disagree about which language this is. Without it the caller's
  // `t` follows i18n's active language while `localizeTerm` follows
  // `lang`, which produces the very thing this module exists to stop —
  // half a sentence in each language.
  const opts = (extra: Record<string, unknown> = {}) => ({ lng: lang, ...extra });
  if (d.key === "undefinedRatio") {
    return t(
      "ratioAbsence.undefinedRatio",
      opts({ denominator: localizeTerm(d.vars.denominator ?? "", lang) }),
    );
  }
  if (d.key === "missingUnnamed") return t("ratioAbsence.missingUnnamed", opts());
  const words = d.inputWords.map((w) => localizeTerm(w, lang));
  const conj = lang.toLowerCase().startsWith("ro") ? "și" : "and";
  const list =
    words.length <= 1
      ? (words[0] ?? "")
      : `${words.slice(0, -1).join(", ")} ${conj} ${words[words.length - 1]}`;
  return t("ratioAbsence.missingNamed", opts({ inputs: list }));
}

export { ratioAbsenceEn, ratioAbsenceRo, RATIO_ABSENCE_INPUT_RO };
