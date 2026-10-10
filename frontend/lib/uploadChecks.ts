// uploadChecks — THE sentence that says which checks run on every upload.
//
// One string, two languages, read by BOTH the landing (the how-it-works
// step, the proof block's note, the FAQ — through the `{checks.upload}`
// token of lib/engineProof) and the app (the dashboard hero and the
// accuracy receipt, through `uploadChecksSentence`).
//
// WHY IT IS ONE STRING (2026-10-02). The landing said "two checks run on
// your own file every time: the balance sheet must close and net income
// must equal account 121". The app said "the balance sheet closes and the
// source's debits and credits agree — those are the two checks run on
// every upload". Two surfaces, two different pairs, each called "the two
// checks". Three checks run:
//
//   1. the source's own totals — Σ closing debit against Σ closing credit
//      (served as `source_data_quality.raw_imbalance_pct`; the accuracy
//      receipt and the source-quality banner print the difference);
//   2. the balance sheet as served — assets against equity plus
//      liabilities (`bs_balance_delta`, the BALANCED verdict);
//   3. net income against the closing balance of account 121 (the
//      account-121 anchor; the result rebuilt from classes 6 and 7 is
//      printed beside it with any gap).
//
// The sentence names all three and counts none of them: a number word in
// it would be one more thing to keep true. It speaks of "your own file" /
// "fișierul tău" so that landing-proof L11 (a sentence about the visitor's
// own file promises nothing no check on that file backs) reads it.
//
// On a CLOSED book the third check holds by construction: the engine
// anchors net income on account 121, and the stock-variation line is the
// bridge to it. The public sample says so beside its own reading
// (pages/cfo/sampleStrings.ts) — this sentence promises the check, not
// that it can fail on every book.

export type UploadChecksLang = "en" | "ro";

export const UPLOAD_CHECKS_SENTENCE: Record<UploadChecksLang, string> = {
  en: "Your own file is checked on its own figures every time: the source's debits must equal its credits, the balance sheet must close, and net income must equal account 121. Any difference is shown on the report.",
  ro: "Fișierul tău este verificat de fiecare dată pe propriile lui cifre: debitele din sursă trebuie să fie egale cu creditele, bilanțul trebuie să se închidă, iar rezultatul net trebuie să fie egal cu contul 121. Orice diferență este afișată în raport.",
};

/** The checks sentence in the reader's language (English unless Romanian). */
export function uploadChecksSentence(lang: string | null | undefined): string {
  return UPLOAD_CHECKS_SENTENCE[(lang ?? "").toLowerCase().startsWith("ro") ? "ro" : "en"];
}
