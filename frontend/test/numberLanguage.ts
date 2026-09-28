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
//             figure ("413,7 mil.", "1,2 mld.").
//   English   a dot decimal of one or two digits ("413.7", "…,640.82"); two
//             or more comma thousands groups ("2,577,640"); a comma group
//             before a dot decimal ("1,234.56"); an English magnitude letter
//             glued to a figure before a currency code ("413.7M RON").
//
// Neither matches a bare three-digit group ("1,234" / "1.234"), which is the
// one shape both languages can print with different meanings, nor a
// Romanian date ("31.12.2025": the dot is followed by more digits or a dot).

export const ROMANIAN_NUMBER =
  /\d,\d{1,2}(?![\d,])|\d\.\d{3}(?:\.\d{3})+(?!\d)|\d\.\d{3},\d|\d[\s ](?:mil|mld|tril)\./;

export const ENGLISH_NUMBER =
  /\d\.\d{1,2}(?![\d.])|\d,\d{3}(?:,\d{3})+(?!\d)|\d,\d{3}\.\d|\d[KMBT][\s ](?:RON|EUR|USD)\b/;

/** The first figure in `text` printed in the OTHER language's format — a
 *  Romanian number on an English surface, or the reverse — or null. */
export function foreignNumber(text: string, lang: "en" | "ro"): string | null {
  const m = (lang === "en" ? ROMANIAN_NUMBER : ENGLISH_NUMBER).exec(text);
  return m ? m[0] : null;
}

/** Non-breaking spaces (Intl joins "413,7 mil. RON" and "413.7M RON" with
 *  U+00A0) read as plain spaces, so a law can state the owner's strings. */
export function plainSpaces(text: string | null | undefined): string {
  return (text ?? "").replace(/[  ]/g, " ");
}
