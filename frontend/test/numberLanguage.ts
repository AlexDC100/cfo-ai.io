// The number shapes of the two UI languages — for the laws that hold every
// figure to the READER'S language (owner ticket 2026-09-28: the English
// interface printed "413,7 mil. RON" on the command bar, the workspace
// cards and the company page, because lib/money chose the locale from the
// currency).
//
// Each pattern matches only a shape the OTHER language cannot produce, so a
// hit is never a matter of taste:
//
//   Romanian  a comma decimal of one or two digits ("413,7", "…,82"); two or
//             more dot thousands groups ("2.577.640"); a dot group before a
//             comma decimal ("1.234,56"); a Romanian magnitude word after a
//             figure ("413,7 mil.", "1,2 mld.", and Chromium's "61,6 mii"
//             where Node's ICU prints "61,6 K").
//   English   a dot decimal of one or two digits ("413.7", "…,640.82"); two
//             or more comma thousands groups ("2,577,640"); a comma group
//             before a dot decimal ("1,234.56"); an English magnitude letter
//             glued to a figure before a currency code ("413.7M RON").
//
// Neither matches a bare three-digit group ("1,234" / "1.234"), which is the
// one shape both languages can print with different meanings, nor a
// Romanian date ("31.12.2025": the dot is followed by more digits or a dot).

export const ROMANIAN_NUMBER =
  /\d,\d{1,2}(?![\d,])|\d\.\d{3}(?:\.\d{3})+(?!\d)|\d\.\d{3},\d|\d[\s\u00a0](?:mii\b|mil\.|mld\.|tril\.)/;

export const ENGLISH_NUMBER =
  /\d\.\d{1,2}(?![\d.])|\d,\d{3}(?:,\d{3})+(?!\d)|\d,\d{3}\.\d|\d[KMBT][\s\u00a0](?:RON|EUR|USD)\b/;

/** The first figure in `text` printed in the OTHER language's format — a
 *  Romanian number on an English surface, or the reverse — or null. */
export function foreignNumber(text: string, lang: "en" | "ro"): string | null {
  const m = (lang === "en" ? ROMANIAN_NUMBER : ENGLISH_NUMBER).exec(text);
  return m ? m[0] : null;
}

/** Non-breaking spaces (Intl joins "413,7 mil. RON" and "413.7M RON" with
 *  U+00A0) read as plain spaces, so a law can state the owner's strings. */
export function plainSpaces(text: string | null | undefined): string {
  return (text ?? "").replace(/[\u00a0\u202f]/g, " ");
}

// ── PROSE A MODEL WROTE (owner order 2026-10-04) ────────────────────────
//
// The patterns above read a surface the PRODUCT printed. A sentence a model
// wrote has shapes they cannot see (measured on the incident's own reply and
// on a briefing):
//
//   · a short decimal that ENDS A SENTENCE ("… iar Z″ este 2.87."): the base
//     pattern refuses a decimal followed by a dot, to spare "31.12.2025";
//   · a decimal of three or more places ("la cursul BNR 0.1905"): the base
//     pattern stops at two;
//   · a lower-case or two-letter magnitude before a code ("918k EUR",
//     "2.45bn USD");
//   · the code, or a currency symbol, BEFORE the figure ("EUR 12.3M",
//     "RON 64,567,890", "€12.3M") — the standard puts the ISO code after it,
//     in both languages.
//
// A lone three-digit group ("1,234" / "1.234") is still matched by nothing:
// it is the one shape both languages print with different values.
//
// The three literals below are read out of THIS FILE by the engine's gate
// (tests/engine/test_ai_figure_format.py compiles them — there is no second
// copy), so each stays a plain regex literal on one line.

/** What is not prose: fenced and inline code, a URL, a markdown link target,
 *  a placeholder, an e-mail address, a date, a clock time. A law masks these
 *  before it looks for a figure. */
export const NOT_PROSE =
  /```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s)]+|\]\([^)\n]*\)|\{\{[^{}\n]*\}\}|\{[A-Za-z_][A-Za-z0-9_.]*\}|[\w.+-]+@[\w-]+\.[\w.-]+|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?/;

const ROMANIAN_NUMBER_IN_PROSE =
  /\d,\d{1,2}(?!\d|,\d)|(?<![\d.,])\d+,\d{4,}(?![\d,])|(?<![\d.,])0,\d{3}(?![\d,])/;

const ENGLISH_NUMBER_IN_PROSE =
  /\d\.\d{1,2}(?!\d|\.\d)|(?<![\d.,])\d+\.\d{4,}(?![\d.])|(?<![\d.,])0\.\d{3}(?![\d.])|\d(?:k|[Bb]n)[\s\u00a0]?(?:RON|EUR|USD)\b/;

/** An ISO code of the product, or a currency symbol, standing BEFORE a
 *  figure. Not a code inside a pair ("EUR/RON 4,97") or a longer word, and
 *  not a symbol that follows a letter, a digit or another symbol ("US$ 5",
 *  "$B$2"): those are not this standard's to name. */
export const CURRENCY_BEFORE_FIGURE =
  /(?:(?<![A-Za-z/])(?:RON|EUR|USD)|(?<![A-Za-z0-9$€])[$€])[ \u00a0]?[-−+~≈]?\d/;

/** EVERY figure in a model's prose written in the OTHER language's format —
 *  the two base patterns, made global, plus the prose shapes above. Code,
 *  URLs, placeholders, dates and times are masked first (NOT_PROSE). An
 *  empty list is the only pass. */
export function foreignNumbersInProse(text: string, lang: "en" | "ro"): string[] {
  const prose = maskNotProse(text);
  const [base, extra] = lang === "en"
    ? [ROMANIAN_NUMBER, ROMANIAN_NUMBER_IN_PROSE]
    : [ENGLISH_NUMBER, ENGLISH_NUMBER_IN_PROSE];
  return [...prose.matchAll(new RegExp(`${base.source}|${extra.source}`, "g"))].map((m) => m[0]);
}

/** `text` with every NOT_PROSE span blanked (same length, so an index into
 *  the result is an index into the text). */
export function maskNotProse(text: string | null | undefined): string {
  return (text ?? "").replace(new RegExp(NOT_PROSE.source, "g"), (m) => " ".repeat(m.length));
}
