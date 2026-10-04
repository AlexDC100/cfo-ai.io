// THE READER'S FIGURE FORMAT FOR MODEL-WRITTEN PROSE — the browser's half.
//
// WHY THIS EXISTS (owner order 2026-10-04): "make chat and briefings write
// numbers in Romanian format in Romanian text (413.727.560 RON, ~77,4 mil.
// EUR), currency after the figure. Use the product's own formatting standard,
// with a gate." On screen that day Ask CFO AI answered, in a Romanian
// sentence, "~EUR 77.4M (convertit din RON 413,727,560 la cursul BNR
// 0.1871)": the code before the figure, English separators, an English
// magnitude. A prompt can ASK a model for a format; nothing HELD what the
// reader saw. This module is what holds it, in the browser:
//
//   · an Ask CFO AI reply, when it arrives (before it is stored) and again
//     when it is rendered — so a reply stored before this release, or written
//     under an older function's prompt, reads right too;
//   · an Explain answer, fresh or cached;
//   · the briefing the dashboard card shows (a briefing narrated after the
//     release is already stored right by the engine's twin).
//
// The command bar's answer is NOT a caller: it carries no digit by contract,
// its figures are printed by the interface from named facts, and its guard
// must read the model's text exactly as the function returned it.
//
// THE ONE AUTHORITY IS lib/money. This module prints nothing from a value: it
// holds MARKS (FIGURE_STANDARD) — held equal to
// tests/engine/fixtures/ai_figures/standard.json, which a law writes from
// lib/money (formatMoneyFrom through moneyLocaleFor) and re-generates on
// every run — and it exchanges a token's separators for the reader's.
//
// NO FIGURE'S VALUE MAY CHANGE. A token is rewritten by swapping its
// separator characters one by one — its digits never pass through a number
// type — and ONLY when
//
//   · its numeric reading is UNIQUE, and
//   · something positive says it is a figure: a currency, a unit, a
//     magnitude, a range partner that has one, a leading "0.", or a figure
//     the model was handed (`anchors`).
//
// Everything else is left exactly as written and COUNTED (`left`, one reason
// each):
//
//   single_group    "1,234" / "1.234" — one group of three digits has two
//                   readings (1234 or 1.234). Never guessed: the whole token
//                   stays — number, magnitude and currency position.
//   bare_decimal    "1.16" with nothing beside it and no handed figure.
//   bare_groups     "401,404,408" — a run of three-digit groups with nothing
//                   beside it (an account list reads the same).
//   reference       after "art.", "IAS", "cont", "secțiunea", …
//   outline         "2.1 Lichiditate" at the start of a line.
//   possible_date   "la 25.03", "ora 14.30".
//   leading_zero    "01.02", "007.5".
//   possible_year   "EUR 2025".
//   tenor           "ROBOR 3M".
//   bare_magnitude  "5M" with no currency and an unchanged number.
//   two_currencies  a code on both sides of one number.
//   glued           "v2.1", "1.5T" — part of a word; a number that touches a
//                   date or a clock time ("1,234:99").
//   open_amount     a code-first amount that is NOT READ TO ITS END, left as
//                   one expression exactly as written: a range or a list
//                   ("EUR 1.5-2.5M", "EUR 40 și 55 milioane"), a number that
//                   goes on ("RON 64 567 890"), a magnitude the standard does
//                   not print ("RON 4.58 mil", "EUR 1 milion"), another
//                   currency named beside it ("$7.5M CAD"), a code between
//                   two numbers ("31.12 RON 5.2M").
//   code_before     a code that stays before its figure, counted so the
//                   report says what the reader still sees: after a rate
//                   word, before a percentage, behind two spaces / a bracket /
//                   emphasis marks, a "$" the reply names another dollar for.
//   text_held       the text holds a lone three-digit group AND figures the
//                   pass would rewrite: it is returned WHOLE, as written.
//   proof_failed    the run-time proof below refused the result.
//
// A handed figure is EVIDENCE that a value-unique token is a figure — it
// never chooses between two readings.
//
// A CODE MOVES ONLY BEHIND AN AMOUNT READ TO ITS END (review 2026-10-05). "EUR
// 1.5-2.5M" is not "1,5 EUR-2,5 mil.", "RON 4.58 mil" is not "4,58 RON mil",
// "EUR 12 300 000" is not "12 EUR 300 000": every digit was kept and the
// figure was bound to something else. Whatever the pass cannot read to its
// end it leaves exactly as written — the code, the number, what follows — and
// counts.
//
// NEVER HALF A TEXT. A lone three-digit group is read by the notation of the
// figures around it. Rewriting those and leaving it would make "RON 386,102"
// read as 386 lei among Romanian figures. A text that holds one is returned
// whole: every figure in it still reads the way it did.
//
// RUN-TIME PROOF (every call): the digit sequence of the output equals the
// input's; every sign and ratio mark is the same character in the same order;
// every number keeps its magnitude and the currency bound to it (read with
// tables of the proof's own) — or the text is returned exactly as it came.
//
// WHICH LANGUAGE. The format follows the language the TEXT is written in —
// never the UI language: a Romanian-interface reader who asks in English gets
// an English answer, and English text keeps English figures. A text's
// language is read on positive evidence only (`proseLanguageOf`): Romanian
// needs a word no other narration language has ("este" and "dar" are Spanish
// and Portuguese too); English words around Romanian letters decide nothing;
// and a few words of evidence are never followed AGAINST the question the
// text answers. A text whose language cannot be told — or is German, French,
// Spanish, Italian, Portuguese, Dutch, Polish — is not touched.
//
// THE TWIN. src/engine/ai/figure_format.py is the same rule set in the
// engine (briefings). Both are run over the same reply_corpus.json and
// grid.json and must agree byte for byte. Edit one, edit the other.
//
// Pure: no Intl, no clock, no storage. NO LOOKBEHIND in any pattern of this
// file — an old iOS WebView throws at PARSE time on one, and the mobile shell
// is a WebView: the whole app would fail to boot (a law reads this file).

export type FigureLang = "ro" | "en";

export type LeftReason =
  | "single_group" | "bare_decimal" | "bare_groups" | "bare_magnitude" | "two_currencies"
  | "reference" | "outline" | "possible_date" | "leading_zero" | "possible_year" | "tenor"
  | "glued" | "open_amount" | "code_before" | "text_held" | "proof_failed"
  // displayModelText only: the text's language could not be told, so nothing was read.
  | "language_unknown";

export interface LeftToken { token: string; reason: LeftReason }
export interface NormaliseResult { text: string; rewritten: number; left: LeftToken[] }

const NBSP = "\u00a0";
const NARROW_NBSP = "\u202f";
const MINUS = "\u2212"; // "−", the typographic minus sign
const EN_DASH = "\u2013";
const EM_DASH = "\u2014";
const EURO = "\u20ac";

/** THE STANDARD AS DATA — equal to tests/engine/fixtures/ai_figures/
 *  standard.json (written from lib/money; gate ai-figures). The joiners are
 *  the bytes the product prints: U+00A0 before a Romanian magnitude word and
 *  before the ISO code. */
export const FIGURE_STANDARD = {
  codes: ["RON", "EUR", "USD"],
  symbols: { [EURO]: "EUR", $: "USD" } as Record<string, string>,
  languages: {
    ro: {
      locale: "ro-RO", group: ".", decimal: ",",
      magnitudes: { K: "mii", M: "mil.", B: "mld." },
      magnitude_joiner: NBSP, code_joiner: NBSP,
    },
    en: {
      locale: "en-US", group: ",", decimal: ".",
      magnitudes: { K: "K", M: "M", B: "B" },
      magnitude_joiner: "", code_joiner: NBSP,
    },
  },
} as const;

type Magnitude = "K" | "M" | "B";

const CODES: readonly string[] = FIGURE_STANDARD.codes;
const SYMBOL_CODE: Record<string, string> = FIGURE_STANDARD.symbols;

// A magnitude as a model writes it: glued English letters, or a Romanian word
// after one space. Read in EITHER language's text.
const MAG_GLUED: readonly (readonly [string, Magnitude])[] = [["Bn", "B"], ["bn", "B"], ["K", "K"], ["k", "K"], ["M", "M"], ["B", "B"]];
const MAG_WORDS: readonly (readonly [string, Magnitude])[] = (["M", "B", "K"] as const).map((key) => [FIGURE_STANDARD.languages.ro.magnitudes[key], key] as const);

// Words after a figure that make it a quantity (never rewritten themselves).
// A RATIO word says the number is not money at all ("12 zile", "3 ori"); a
// MONEY word is a magnitude or a currency in words ("55 milioane", "5 lei").
const RATIO_WORDS = [
  "zile", "zi", "days", "day", "ani", "years", "year", "luni", "months", "month", "ori", "times",
  "pp", "p.p.", "puncte", "points",
];
const MONEY_WORDS = [
  "milioane", "miliarde", "million", "millions", "billion", "billions", "thousand", "lei", "leu",
  "euro", "euros", "dolari", "dollars",
];
const UNIT_WORDS = [...RATIO_WORDS, ...MONEY_WORDS];
// A word that CONTINUES an amount — a magnitude the standard does not print
// ("4.58 mil", "2.5 mld", "4.58 M", "3.2 trillion", "1 milion"). After a
// code-first number one of these means the amount does not end at the number:
// the code is never moved in between ("RON 4.58 mil" is not "4,58 RON mil").
const MAG_LIKE: ReadonlySet<string> = new Set([
  "mil", "mld", "mii", "mie", "mio", "mln", "mlrd", "mrd", "bn", "bln", "tn", "trn", "tril", "m",
  "mm", "b", "k", "t", "milion", "milioane", "miliard", "miliarde", "trilion", "trilioane",
  "million", "millions", "billion", "billions", "trillion", "trillions", "thousand", "thousands",
  "hundred", "hundreds", "sute", "mn",
]);
// A number after one of these is a reference, not a figure.
const REF_STEMS = [
  "§", "art", "alin", "pct", "punct", "lit", "cap", "sec", "anex", "nota", "note", "tabel", "table", "figur", "fig",
  "pag", "page", "nr", "no", "ias", "ifrs", "isa", "ifric", "sic", "omfp", "oug", "hg", "leg", "law", "vers", "cont",
  "account", "acct", "ct", "item", "step", "pas", "etap", "chapter", "clause", "paragraph", "par",
];
const DATE_WORDS = [
  "la", "pe", "din", "până", "pana", "data", "termen", "termenul", "scadența", "scadenta", "scadență", "scadent",
  "scadentă", "ora", "orele", "on", "by", "until", "dated", "due", "since", "from", "at",
];
// "curs EUR 4.97": the code names the rate, not the figure's denomination.
const RATE_WORDS = ["curs", "cursul", "cursului", "rata", "rate", "paritate", "paritatea", "fx", "kurs"];
const RANGE_JOINERS = [" și ", " si ", " and ", " to ", " la ", " până la ", " pana la "];
const RANGE_OPENERS = ["între", "intre", "between", "from", "la"]; // "de la 1.5 la 2.5 mil."
// What can stand between two numbers of ONE expression ("40 și 55 milioane",
// "10, 12 sau 15 mil."). "la" joins only after a range opener ("de la 1.5 la
// 2.5"): "RON 5.2M la 31.12" is an amount and a date.
const JOIN_WORDS = ["și", "si", "and", "to", "sau", "or", "ori", "respectiv", "&", "până la", "pana la"];
const TENOR_WORDS = ["robor", "euribor", "libor", "sofr", "ircc", "saron", "estr", `${EURO}str`];

const SIGNS = ["-", MINUS, "+"];
const DASHES = ["-", EN_DASH, " - ", ` ${EN_DASH} `];
const DASH_CHARS = ["-", EN_DASH, EM_DASH, MINUS];
const APOSTROPHES = ["'", "\u2019"];
// What may stand right after an amount that has ended: closing punctuation.
// Anything else against the number — a symbol, a bracket that opens, "=",
// "+" — and the amount is not read to its end.
const CLOSERS = ".,;:!?)]}\"'\u00bb\u201d\u2019\u2026*_|";
// What may stand between a code and the number it was written before without
// making it another sentence: spaces, a sign, an approximation mark, an
// opening bracket, markdown emphasis ("RON  5", "RON (5)", "**RON** 5").
const LOOSE_BETWEEN = ` ${NBSP}${NARROW_NBSP}\t-${MINUS}+${EN_DASH}${EM_DASH}~\u2248(*_`;

const isDigit = (c: string) => c >= "0" && c <= "9";
// A Unicode LETTER on ONE UTF-16 unit: "×" and "÷" are not letters.
const isLetter = (c: string) => c !== "" && /\p{L}/u.test(c);
const isSpace = (c: string) => c === " " || c === NBSP || c === NARROW_NBSP;
// "€" / "$" — an own key of the standard's symbol table (never a prototype's).
const isSymbol = (c: string) => c !== "" && Object.prototype.hasOwnProperty.call(SYMBOL_CODE, c);
const digitsOf = (s: string) => s.replace(/[^0-9]/g, "");
const plainJoiners = (s: string) => s.split(NBSP).join(" ");

// NEVER ENTERED: fenced and inline code, a URL, a markdown link target, a
// placeholder ({{money:fact}}, {name}), an e-mail address, a date, a clock
// time.
const EMAIL_SOURCE = "[\\w.+-]+@[\\w-]+\\.[\\w.-]+";
const PROTECTED_SOURCES = [
  "```[\\s\\S]*?```", "`[^`\\n]*`", "https?:\\/\\/[^\\s)]+", "\\]\\([^)\\n]*\\)",
  "\\{\\{[^{}\\n]*\\}\\}", "\\{[A-Za-z_][A-Za-z0-9_.]*\\}", EMAIL_SOURCE,
  "\\d{4}-\\d{2}-\\d{2}", "\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}", "\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}", "\\d{1,2}:\\d{2}(?::\\d{2})?",
];
const PROTECTED_SOURCE = PROTECTED_SOURCES.join("|");
const PROTECTED_SOURCE_NO_EMAIL = PROTECTED_SOURCES.filter((p) => p !== EMAIL_SOURCE).join("|");

/** The protected spans of `text`, as a fresh global pattern. The e-mail
 *  alternative retries from every character of an unbroken run of word
 *  characters (quadratic in the run's length — this runs on the render
 *  thread of a phone's WebView); it can only match where an "@" is, so a text
 *  without one is read without it. Same matches, by construction. */
function protectedSpans(text: string): RegExp {
  return new RegExp(text.indexOf("@") < 0 ? PROTECTED_SOURCE_NO_EMAIL : PROTECTED_SOURCE, "g");
}

interface Notation { fg: string; fd: string; ng: string; nd: string }

/** The marks of `lang` (native) and of the OTHER language (foreign). */
function notation(lang: FigureLang): Notation {
  const native = FIGURE_STANDARD.languages[lang];
  const foreign = FIGURE_STANDARD.languages[lang === "ro" ? "en" : "ro"];
  return { fg: foreign.group, fd: foreign.decimal, ng: native.group, nd: native.decimal };
}

type Shape = "foreign_full" | "foreign_decimal" | "single_group" | "native_or_plain" | "not_a_number";

function shapeOf(tok: string, lang: FigureLang): Shape {
  const { fg, fd } = notation(lang);
  const esc = (c: string) => (c === "." ? "\\." : c);
  const G = esc(fg), D = esc(fd);
  if (new RegExp(`^\\d{1,3}(?:${G}\\d{3})+${D}\\d+$`).test(tok)) return "foreign_full";
  if (new RegExp(`^\\d{1,3}(?:${G}\\d{3}){2,}$`).test(tok)) return "foreign_full";
  if (new RegExp(`^\\d{1,3}${G}\\d{3}$`).test(tok)) return "single_group";
  if (new RegExp(`^\\d+${D}\\d+$`).test(tok)) {
    if (new RegExp(`^[1-9]\\d{0,2}${D}\\d{3}$`).test(tok)) return "single_group";
    return "foreign_decimal";
  }
  // The text's own notation (the marks change places), or a plain integer.
  if (new RegExp(`^(?:\\d+|\\d{1,3}(?:${D}\\d{3})+(?:${G}\\d+)?|\\d+${G}\\d+)$`).test(tok)) return "native_or_plain";
  // "77,4,2025", "12.5.999,99": a number in NEITHER notation — never touched.
  return "not_a_number";
}

/** The token in `lang`'s marks: separators exchanged one character at a time
 *  — no digit is read, added, dropped or moved. (An object so a law can plant
 *  a swap that drops a digit and watch the proof refuse it.) */
export const figureSwap = {
  swap(tok: string, lang: FigureLang): string {
    const { fg, fd, ng, nd } = notation(lang);
    let out = "";
    for (const c of tok) out += c === fg ? ng : c === fd ? nd : c;
    return out;
  },
};

interface Reading { scaled: number; places: number }

function reading(tok: string, dec: string): Reading {
  const at = tok.lastIndexOf(dec);
  const places = at < 0 ? 0 : tok.length - at - 1;
  return { scaled: Number(tok.replace(/[.,]/g, "")), places };
}

/** Is the token one of the handed figures, rounded or cut to its places? */
function anchoredBy(anchors: readonly number[], r: Reading): boolean {
  // A token of several hundred digits is not a figure anyone was handed (and
  // 10 ** places would overflow, making every comparison Infinity === Infinity):
  // never proved. The engine's twin has the same guard.
  if (!anchors.length || !Number.isFinite(r.scaled) || r.places > 300) return false;
  const p = Math.pow(10, r.places);
  for (const a of anchors) {
    const x = Math.abs(a) * p;
    if (!Number.isFinite(x)) continue;
    if (Math.floor(x + 0.5) === r.scaled || Math.floor(x + 1e-9) === r.scaled) return true;
  }
  return false;
}

interface Tail {
  mag: Magnitude | null; magLen: number; unit: boolean;
  /** The unit says the number is not money ("%", "x", "zile"). */
  ratio: boolean;
  /** The unit is written against the number ("2.3pp", "82.4/100"). */
  gluedUnit: boolean;
  currency: string | null; currencyLen: number;
}

/** What stands right AFTER the number that ends at `i`: a magnitude, a unit,
 *  a currency. */
function readTail(s: string, i: number): Tail {
  const t: Tail = { mag: null, magLen: 0, unit: false, ratio: false, gluedUnit: false, currency: null, currencyLen: 0 };
  let j = i;
  for (const [g, key] of MAG_GLUED) {
    const next = s[j + g.length] ?? "";
    if (s.startsWith(g, j) && !isLetter(next) && !isDigit(next)) { t.mag = key; t.magLen = g.length; break; }
  }
  if (!t.mag && isSpace(s[j] ?? "")) {
    for (const [w, key] of MAG_WORDS) {
      if (s.startsWith(w, j + 1) && !isLetter(s[j + 1 + w.length] ?? "")) { t.mag = key; t.magLen = 1 + w.length; break; }
    }
  }
  j += t.magLen;
  if (s[j] === "%" || s[j] === "‰" || s[j] === "×" || (s[j] === "x" && !isLetter(s[j + 1] ?? ""))) { t.unit = t.ratio = true; return t; }
  if (!t.mag) {
    // "2.3pp", "82.4/100": a unit written against the number.
    if (s.startsWith("pp", j) && !isLetter(s[j + 2] ?? "")) { t.unit = t.ratio = t.gluedUnit = true; return t; }
    const after = s[j + 4] ?? "";
    if (s.startsWith("/100", j) && !isDigit(after) && !isLetter(after) && !((after === "." || after === ",") && isDigit(s[j + 5] ?? ""))) {
      t.unit = t.ratio = t.gluedUnit = true; return t;
    }
  }
  let k = j;
  if (isSpace(s[k] ?? "")) k += 1; else if (!isSymbol(s[k] ?? "")) return t;
  if (s[k] === "%") { t.unit = t.ratio = true; return t; }
  const de = s.startsWith("de", k) && isSpace(s[k + 2] ?? "") ? 3 : 0; // "64.567.890 de lei"
  const at = k + de;
  if (de === 0) {
    for (const code of CODES) {
      const next = s[at + 3] ?? "";
      if (s.startsWith(code, at) && !isLetter(next) && !isDigit(next)) { t.currency = code; t.currencyLen = at + 3 - j; return t; }
    }
    const next = s[at + 1] ?? "";
    // ("5 €$3": a symbol against another symbol is not this number's)
    if (isSymbol(s[at] ?? "") && !isLetter(next) && !isDigit(next) && !isSymbol(next)) { t.currency = SYMBOL_CODE[s[at]]; t.currencyLen = at + 1 - j; return t; }
  }
  for (const w of UNIT_WORDS) if (s.startsWith(w, at) && !isLetter(s[at + w.length] ?? "")) { t.unit = true; t.ratio = RATIO_WORDS.includes(w); return t; }
  return t;
}

interface Head {
  currency: string | null; start: number; sign: string; evidenceOnly: boolean;
  /** Where a code or bare symbol starts that is read but NOT this figure's
   *  to move (after a rate word; a "$" the reply names another dollar for). */
  stays: number | null;
}

function wordBefore(s: string, at: number): string {
  let j = at;
  while (j > 0 && isSpace(s[j - 1])) j--;
  let i = j;
  while (i > 0 && !isSpace(s[i - 1]) && s[i - 1] !== "(" && s[i - 1] !== "\n") i--;
  return s.slice(i, j).toLowerCase().replace(/[:;,]+$/, "");
}

/** The (up to) three words before `at`, nearest first. */
function wordsBefore(s: string, at: number): string[] {
  const out: string[] = [];
  let j = at;
  for (let n = 0; n < 3; n++) {
    while (j > 0 && isSpace(s[j - 1])) j--;
    let i = j;
    while (i > 0 && !isSpace(s[i - 1]) && s[i - 1] !== "(" && s[i - 1] !== "\n") i--;
    if (i === j) break;
    out.push(s.slice(i, j).toLowerCase().replace(/[:;,.]+$/, ""));
    if (i > 0 && (s[i - 1] === "(" || s[i - 1] === "\n")) break;
    j = i;
  }
  return out;
}

function startsWithAny(word: string, stems: readonly string[]): boolean {
  const bare = word.replace(/\.$/, "");
  return stems.some((st) => bare === st || (st.length >= 3 && bare.startsWith(st)) || word === st + ".");
}

/** Three ASCII capitals standing as a word at `k` — the shape of an ISO
 *  currency code ("CAD", "AUD", "MXN"), whichever it is. */
function codeLike(s: string, k: number): boolean {
  if (k < 0 || k + 3 > s.length) return false;
  for (let n = k; n < k + 3; n++) if (!(s[n] >= "A" && s[n] <= "Z")) return false;
  const after = s[k + 3] ?? "", before = s[k - 1] ?? "";
  return !(isLetter(after) || isDigit(after) || isLetter(before) || isDigit(before));
}

/** Does a number start at `k`, after at most one space and one sign? */
function figureFollows(s: string, k: number): boolean {
  if (isSpace(s[k] ?? "")) k += 1;
  if (SIGNS.includes(s[k] ?? "")) k += 1;
  return isDigit(s[k] ?? "");
}

/** A currency written BEFORE the number that starts at `i` (never reaching
 *  back past `floor`, the end of the previous figure). */
function readHead(s: string, i: number, floor: number): Head {
  let j = i, sign = "";
  if (j > floor && SIGNS.includes(s[j - 1])) { sign = s[j - 1]; j -= 1; }
  let k = j;
  if (k > floor && isSpace(s[k - 1])) k -= 1;
  if (k > floor && isSymbol(s[k - 1])) {
    const b = s[k - 2] ?? "";
    // "US$", "C$", "$B$2": a symbol with a letter, a digit or another symbol
    // before it is not this standard's to name.
    if (isLetter(b) || isDigit(b) || isSymbol(b)) return { currency: null, start: i, sign: "", evidenceOnly: true, stays: null };
    // "CAD $7.5M": the reply itself says which dollar — it is not named USD.
    if (isSpace(b) && codeLike(s, k - 5)) return { currency: null, start: i, sign: "", evidenceOnly: true, stays: k - 1 };
    return { currency: SYMBOL_CODE[s[k - 1]], start: k - 1, sign, evidenceOnly: false, stays: null };
  }
  if (k - 3 >= floor) {
    const code = s.slice(k - 3, k);
    const before = s[k - 4] ?? "";
    if (CODES.includes(code) && !isLetter(before) && !isDigit(before) && before !== "/") {
      if (RATE_WORDS.includes(wordBefore(s, k - 3))) return { currency: null, start: i, sign: "", evidenceOnly: true, stays: k - 3 };
      return { currency: code, start: k - 3, sign, evidenceOnly: false, stays: null };
    }
  }
  return { currency: null, start: i, sign: "", evidenceOnly: false, stays: null };
}

/** Where a product code or a bare symbol starts that still stands BEFORE the
 *  number at `st` with something the strict reader does not cross in between
 *  (two spaces, a tab, an en dash, a bracket, emphasis marks) — or null. It
 *  is never moved; it is COUNTED, so the report says what the reader sees. */
function looseHead(s: string, st: number, floor: number): number | null {
  let k = st, n = 0;
  while (k > floor && n < 8 && LOOSE_BETWEEN.includes(s[k - 1])) { k -= 1; n += 1; }
  if (k > floor && isSymbol(s[k - 1])) {
    const b = s[k - 2] ?? "";
    if (isLetter(b) || isDigit(b) || isSymbol(b)) return null;
    return k - 1;
  }
  if (k - 3 >= floor && CODES.includes(s.slice(k - 3, k))) {
    const before = s[k - 4] ?? "";
    if (!isLetter(before) && !isDigit(before) && before !== "/") return k - 3;
  }
  return null;
}

function atLineStart(s: string, at: number): boolean {
  let i = at;
  while (i > 0 && s[i - 1] !== "\n") i--;
  return /^[\s#>*•\-]*$/.test(s.slice(i, at));
}

interface Item {
  s: number; e: number; tok: string; shape: Shape; head: Head; tail: Tail; adjacent: boolean; ok: boolean;
  floor: number; contested: boolean; frozen: boolean; openToken: string | null;
}

/** Where the figure ends: its number, its magnitude, its code. */
const fullEnd = (it: Item) => it.e + it.tail.magLen + it.tail.currencyLen;

/** Where the figure starts: its code (when one is written before it), its
 *  sign — a "-" written against the digit before it is a dash, not a sign. */
function ownStart(s: string, it: Item): number {
  let st = it.head.currency ? it.head.start : it.s;
  if (st > it.floor && SIGNS.includes(s[st - 1]) && !isDigit(s[st - 2] ?? "")) st -= 1;
  return st;
}

/** What stands between two numbers when they may be ONE expression: "group"
 *  (a space or an apostrophe: "64 567 890", "1'234'567"), "dash" (a range:
 *  "1.5-2.5M", "10 – 12"), "list" (a comma, a joining word: "40 și 55
 *  milioane") — or null: they are two sentences' worth apart. */
function connective(gap: string, opener: boolean): "group" | "dash" | "list" | "weak" | null {
  const g = gap.split(NBSP).join(" ").split(NARROW_NBSP).join(" ").toLowerCase();
  // (nothing in between: the second number's sign is all there is)
  if (g === "") return "dash";
  if (g === " " || APOSTROPHES.includes(g)) return "group";
  for (const d of DASH_CHARS) if (g === d || g === ` ${d} ` || g === ` ${d}` || g === `${d} `) return "dash";
  if (g === "," || g === ", " || g === ";" || g === "; ") return "list";
  for (const w of JOIN_WORDS) {
    if (g === ` ${w} ` || g === `, ${w} ` || g === `; ${w} `) return "list";
  }
  // "la" joins a range only after an opener ("de la 1.5 la 2.5 mil."); on its
  // own it is weak: "RON 5.2M la 31.12" is an amount and a date.
  if (g === " la ") return opener ? "list" : "weak";
  return null;
}

/** Is the word at `k` a magnitude the standard does not print — also after
 *  the "de" Romanian puts before one ("120 de mii", "55 de milioane")? */
function magLikeAt(s: string, k: number): boolean {
  if (s.startsWith("de", k) && isSpace(s[k + 2] ?? "")) k += 3;
  let m = k;
  while (isLetter(s[m] ?? "")) m += 1;
  return MAG_LIKE.has(s.slice(k, m).toLowerCase());
}

/** Does this number carry a magnitude of any spelling — one the standard
 *  prints, a word, or a letter the standard does not read ("14.30m")? */
function hasMagnitude(s: string, it: Item): boolean {
  if (!it.ok || it.tail.mag || (it.tail.unit && !it.tail.ratio)) return true;
  return isSpace(s[it.e] ?? "") && magLikeAt(s, it.e + 1);
}

/** A figure that stands on its own: its own currency, or a ratio's unit. */
const separate = (it: Item) => it.ok && !!(it.head.currency || it.head.evidenceOnly || it.tail.currency || it.tail.ratio);

/** Does the amount a code-first number opens provably END at that number (and
 *  its magnitude)? Only then is the code moved behind it. It does NOT when
 *  the number goes on ("64 567 890", "1'234'567"), when a magnitude the
 *  standard does not print follows ("4.58 mil", "1 milion", "4.58 M"), when
 *  another currency is named beside it ("$7.5M CAD"), or when the next number
 *  belongs to the same expression — a range or a list that shares the code
 *  and, usually, the magnitude ("EUR 1.5-2.5M", "EUR 40 și 55 milioane"). */
function amountEnds(s: string, items: Item[], i: number, joinedRight: boolean): boolean {
  const it = items[i];
  const j = it.e + it.tail.magLen;
  const c = s[j] ?? "";
  if (c === "") {
    // The segment ends at the amount: closed, unless what follows is a span
    // this pass never enters (the amount runs into it).
    if (joinedRight) return false;
  } else if (APOSTROPHES.includes(c) && isDigit(s[j + 1] ?? "")) return false;
  else if (DASH_CHARS.includes(c)) {
    // A hyphen against a word is a compound ("EUR 5-year", "RON 3-lunar"); an
    // en / em dash there is a break in the sentence.
    if (c === "-" && isLetter(s[j + 1] ?? "")) return false;
  } else if (c === "/") {
    // "RON 5.2M/an" is per year. "RON 5M/6M" is two amounts under one code,
    // "EUR 2.5M/USD 2.7M" two currencies: neither ends at the slash.
    if (!isLetter(s[j + 1] ?? "") || codeLike(s, j + 1)) return false;
  } else if (!isSpace(c) && !CLOSERS.includes(c) && !/\s/.test(c)) return false;
  if (isSpace(c)) {
    const d = s[j + 1] ?? "";
    if (isDigit(d) || isSymbol(d)) return false;
    if (d === "(" && codeLike(s, j + 2) && s[j + 5] === ")") return false;
    if (isLetter(d)) {
      if (codeLike(s, j + 1)) return false;
      if (magLikeAt(s, j + 1)) return false;
    }
  }
  if (i + 1 < items.length) {
    const nx = items[i + 1];
    const opener = RANGE_OPENERS.includes(wordBefore(s, ownStart(s, it)));
    const kind = connective(s.slice(j, ownStart(s, nx)), opener);
    if (kind === "dash" || kind === "group") return false;
    if (kind === "list" && (opener || !separate(nx))) return false;
    if (kind === "weak" && !separate(nx) && hasMagnitude(s, nx)) return false;
  }
  return true;
}

/** Does a NUMBER — bare, or with a magnitude of any spelling ("31.12", "3M",
 *  "31.12m", "0.19 milioane") — stand right before the code at `q`? Then the
 *  code has two possible owners. */
function numberBeforeCode(s: string, q: number): boolean {
  let i = q;
  if (i > 0 && isSpace(s[i - 1])) i -= 1;
  const de = s.slice(Math.max(0, i - 3), i) === " de"; // "0.19 milioane de RON 5"
  if (de) i -= 3;
  const end = i;
  while (i > 0 && end - i < 10 && (isLetter(s[i - 1]) || s[i - 1] === ".")) i -= 1;
  const word = s.slice(i, end).toLowerCase().replace(/\.+$/, "");
  const spaced = word !== "" && i > 0 && isSpace(s[i - 1]);
  if (spaced) i -= 1;
  if (!isDigit(s[i - 1] ?? "")) return false;
  if (word === "") return !de;
  if (MAG_LIKE.has(word) || MONEY_WORDS.includes(word)) return true;
  // A letter or two written AGAINST the digits ("31.12m", "4.58T") is a
  // magnitude of some spelling; a short WORD after a space ("și", "la") is not.
  return !spaced && !de && word.length <= 2;
}

/** Leave the expression that starts at item `i` exactly as written: the item
 *  and every number the same expression goes on to. */
function freezeFrom(s: string, items: Item[], i: number): void {
  let last = i;
  while (last + 1 < items.length && last - i < 8) {
    const nx = items[last + 1];
    const kind = connective(s.slice(fullEnd(items[last]), ownStart(s, nx)), true);
    if (kind === null || ((kind === "list" || kind === "weak") && separate(nx))) break;
    last += 1;
  }
  for (let k = i; k <= last; k++) items[k].frozen = true;
  items[i].openToken = s.slice(ownStart(s, items[i]), fullEnd(items[last]));
}

// THE RUN-TIME PROOF's own reading of a text (never the rule set's tables: a
// rule that reads "Bn" as a million must not be able to prove itself).
const PROOF_MARKS = `-${MINUS}+%‰×`;
const PROOF_GLUED: readonly (readonly [string, string])[] = [["Bn", "B"], ["bn", "B"], ["K", "K"], ["k", "K"], ["M", "M"], ["B", "B"]];
const PROOF_WORDS: readonly (readonly [string, string])[] = [["mil.", "M"], ["mld.", "B"], ["mii", "K"]];
const PROOF_CODES = ["RON", "EUR", "USD"];
const PROOF_SYMBOLS: Record<string, string> = { [EURO]: "EUR", $: "USD" };
const proofSymbol = (c: string) => (c !== "" && Object.prototype.hasOwnProperty.call(PROOF_SYMBOLS, c) ? PROOF_SYMBOLS[c] : "");

/** What must not change besides the digits: every sign and ratio mark, in
 *  order; and for each number, in order, the magnitude beside it, the
 *  currency written before it and the currency written after it. */
function structureOf(s: string): { marks: string; figures: [string, string, string][] } {
  let marks = "";
  for (const c of s) if (PROOF_MARKS.includes(c)) marks += c;
  const figures: [string, string, string][] = [];
  const NUM = /\d[\d.,]*\d|\d/g;
  let m: RegExpExecArray | null;
  while ((m = NUM.exec(s)) !== null) {
    const st = m.index;
    let j = st + m[0].length, mag = "";
    for (const [g, key] of PROOF_GLUED) {
      const next = s[j + g.length] ?? "";
      if (s.startsWith(g, j) && !isLetter(next) && !isDigit(next)) { mag = key; j += g.length; break; }
    }
    if (!mag && isSpace(s[j] ?? "")) {
      for (const [w, key] of PROOF_WORDS) {
        if (s.startsWith(w, j + 1) && !isLetter(s[j + 1 + w.length] ?? "")) { mag = key; j += 1 + w.length; break; }
      }
    }
    if (isSpace(s[j] ?? "")) j += 1;
    let after = "";
    const code = s.slice(j, j + 3);
    if (PROOF_CODES.includes(code) && !isLetter(s[j + 3] ?? "") && !isDigit(s[j + 3] ?? "")) {
      // (a code after a plain year and right before a figure is the figure's)
      if (mag || !/^(?:19|20)\d\d$/.test(m[0]) || !figureFollows(s, j + 3)) after = code;
    } else if (proofSymbol(s[j] ?? "") && !isLetter(s[j + 1] ?? "") && !isDigit(s[j + 1] ?? "")) after = proofSymbol(s[j]);
    let b = st;
    if (b > 0 && SIGNS.includes(s[b - 1])) b -= 1;
    if (b > 0 && isSpace(s[b - 1])) b -= 1;
    let before = "";
    if (b > 0 && proofSymbol(s[b - 1])) before = proofSymbol(s[b - 1]);
    else if (b >= 3 && PROOF_CODES.includes(s.slice(b - 3, b))) {
      const pre = s[b - 4] ?? "";
      if (!isLetter(pre) && !isDigit(pre)) before = s.slice(b - 3, b);
    }
    figures.push([mag, before, after]);
  }
  return { marks, figures };
}

/** THE RUN-TIME PROOF beyond the digits: the signs and ratio marks are the
 *  same characters in the same order; every number keeps its magnitude; and a
 *  currency is bound to the number it was bound to — written before it or
 *  after it, never beside another one. (An object so a law can blind it and
 *  watch what it alone was holding.) */
export const figureProof = {
  structureHeld(before: string, after: string): boolean {
    const a = structureOf(before), b = structureOf(after);
    if (a.marks !== b.marks || a.figures.length !== b.figures.length) return false;
    for (let i = 0; i < a.figures.length; i++) {
      const [magA, preA, postA] = a.figures[i], [magB, preB, postB] = b.figures[i];
      if (magA !== magB) return false;
      if ([preA, postA].filter(Boolean).sort().join("|") !== [preB, postB].filter(Boolean).sort().join("|")) return false;
    }
    return true;
  },
};

/** `joined`: a span this pass never enters stands right before / right after
 *  `s` AND meets it with a digit (a date, a clock time) — so a number at that
 *  edge of `s` may be a piece of it. */
function normaliseSegment(s: string, lang: FigureLang, leftOut: LeftToken[], anchors: readonly number[], joined: readonly [boolean, boolean] = [false, false]): { text: string; rewritten: number } {
  const left: LeftToken[] = [];
  const NUM = /\d[\d.,]*\d|\d/g;
  const { fd } = notation(lang);
  const native = FIGURE_STANDARD.languages[lang];
  const items: Item[] = [];
  let m: RegExpExecArray | null;
  let floor = 0;
  while ((m = NUM.exec(s)) !== null) {
    const st = m.index, en = st + m[0].length;
    const prev = s[st - 1] ?? "";
    const head = readHead(s, st, floor);
    const glued = isLetter(prev) || prev === "_" || prev === "#" || prev === "/" || prev === "\\" || prev === "^";
    let tail = readTail(s, en);
    const next = s[en] ?? "";
    // ("31/12" and "1/2" are not figures; "1,250.50/lună" is one, per month)
    let ok = !glued && !(isLetter(next) && !tail.mag && !tail.gluedUnit && !(next === "x" && !isLetter(s[en + 1] ?? ""))) && (next !== "/" || tail.gluedUnit || isLetter(s[en + 1] ?? "")) && next !== "^";
    // A number that TOUCHES a span this pass never enters is a piece of it
    // ("1,234:99" holds the clock time "34:99"; "01.02.1.234" a date): not a
    // number of its own.
    const lead = s.slice(0, st), rest = s.slice(en);
    if ((joined[0] && (lead === "" || lead === "." || lead === ",")) || (joined[1] && (rest === "" || rest === "." || rest === ","))) ok = false;
    const shape = shapeOf(m[0], lang);
    if (shape === "not_a_number") ok = false;
    // A CODE BETWEEN TWO NUMBERS ("31.12 RON 5.2M", "3M RON 5.2M") has two
    // possible owners. After a plain year it is the next figure's ("În 2025
    // RON 413.7M"); otherwise neither number may take it as evidence and
    // neither is touched.
    let contested = false;
    if (tail.currency && figureFollows(s, en + tail.magLen + tail.currencyLen)) {
      if (!tail.mag && !head.currency && /^(?:19|20)\d\d$/.test(m[0])) tail = { ...tail, currency: null, currencyLen: 0 };
      else contested = true;
    }
    items.push({
      s: st, e: en, tok: m[0], shape, head, tail, ok, floor, contested, frozen: false, openToken: null,
      // Something beside the number says it is a figure.
      adjacent: !!(head.currency || head.evidenceOnly || tail.currency || tail.unit || tail.mag),
    });
    floor = en + tail.magLen + tail.currencyLen;
  }

  // WHAT IS LEFT EXACTLY AS WRITTEN, as one expression (`open_amount`):
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // … a code between two numbers, seen from the first …
    if (it.contested && !it.frozen) {
      const hi = Math.min(i + 1, items.length - 1);
      it.frozen = items[hi].frozen = true;
      it.openToken = s.slice(ownStart(s, it), fullEnd(items[hi]));
    }
    // … and from the second: only a dash in between ("31.12-RON 5.2M"), or a
    // number with a magnitude the standard does not read right before the
    // code ("31.12m USD 5", "0.19 milioane USD 1.5M").
    if (i > 0 && it.head.currency && !it.frozen) {
      const prev = items[i - 1];
      const pe = fullEnd(prev), p = ownStart(s, it);
      const between = s.slice(pe, it.head.start);
      const year = prev.e === pe && !prev.head.currency && /^(?:19|20)\d\d$/.test(prev.tok) && (between === " " || between === NBSP || between === NARROW_NBSP);
      if (p === pe || (p - pe === 1 && DASH_CHARS.includes(s[pe])) || (!year && numberBeforeCode(s, it.head.start))) {
        it.frozen = true;
        if (!prev.frozen) {
          prev.frozen = true;
          prev.openToken = s.slice(ownStart(s, prev), fullEnd(it));
        } else if (it.openToken === null && prev.openToken === null) it.openToken = s.slice(p, fullEnd(it));
      }
    }
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // … a code-first amount that is not read to its end.
    if (!it.frozen && it.ok && it.head.currency && !it.tail.currency && !it.tail.unit && !amountEnds(s, items, i, joined[1])) freezeFrom(s, items, i);
  }

  // A range: "1.2-1.5%", "între 8.5 și 13.2%" — the first number takes the
  // second one's evidence. The joiner word counts only after a range opener.
  for (let i = 0; i + 1 < items.length; i++) {
    const a = items[i], b = items[i + 1];
    if (a.frozen || b.frozen) continue;
    const between = s.slice(a.e, b.s);
    const dash = DASHES.includes(between);
    const word = RANGE_JOINERS.includes(between) && RANGE_OPENERS.includes(wordBefore(s, a.s));
    if ((dash || word) && b.adjacent && !a.adjacent && !a.tail.mag) a.adjacent = true;
  }

  let out = s, rewritten = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.frozen) {
      // Left ENTIRELY as written. A lone group inside it is still named: it
      // has two readings wherever it stands.
      if (it.ok && it.shape === "single_group") left.push({ token: it.tok, reason: "single_group" });
      if (it.openToken !== null) left.push({ token: it.openToken, reason: "open_amount" });
      continue;
    }
    if (!it.ok) {
      if (it.shape !== "native_or_plain" && it.shape !== "not_a_number") left.push({ token: it.tok, reason: "glued" });
      continue;
    }
    // A single three-digit group has two values: left ENTIRELY as written.
    if (it.shape === "single_group") { left.push({ token: it.tok, reason: "single_group" }); continue; }
    let ws = it.head.currency ? it.head.start : it.s;
    if (ws > 0 && SIGNS.includes(s[ws - 1])) ws -= 1;
    // The word before the figure — read only where a rule asks for it (it
    // walks back to the previous space: on every plain number of a long
    // unbroken run that is quadratic).
    let beforeWord: string | null = null;
    const before = () => {
      if (beforeWord === null) beforeWord = wordBefore(s, ws);
      return beforeWord;
    };
    let num = it.tok, numChanged = false;
    if (it.shape === "foreign_full") {
      // A run of groups with no decimal part ("28,281,291", "401,404,408")
      // reads the same as a LIST (accounts 28, 281 and 291): it is a figure
      // only with something beside it, or a handed figure.
      const listLike = /^\d{3}(?:[.,]\d{3})+$/.test(it.tok) || !it.tok.includes(fd);
      if (!listLike || it.adjacent || (!startsWithAny(before(), REF_STEMS) && anchoredBy(anchors, reading(it.tok, fd)))) {
        num = figureSwap.swap(it.tok, lang); numChanged = true;
      } else { left.push({ token: it.tok, reason: "bare_groups" }); continue; }
    } else if (it.shape === "foreign_decimal") {
      const [a, b] = it.tok.split(fd);
      if (a.length > 1 && a[0] === "0") { left.push({ token: it.tok, reason: "leading_zero" }); continue; }
      if (it.adjacent) { num = figureSwap.swap(it.tok, lang); numChanged = true; }
      else {
        const dd = Number(a), mm = Number(b);
        const dayMonth = b.length === 2 && dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12;
        const clock = b.length === 2 && dd <= 24 && mm <= 59;
        if (startsWithAny(before(), REF_STEMS)) { left.push({ token: it.tok, reason: "reference" }); continue; }
        if (atLineStart(s, it.s) && /^[.)]?\s+\p{L}/u.test(s.slice(it.e))) { left.push({ token: it.tok, reason: "outline" }); continue; }
        if ((dayMonth || clock) && wordsBefore(s, ws).some((w) => DATE_WORDS.includes(w))) { left.push({ token: it.tok, reason: "possible_date" }); continue; }
        // A handed figure proves a value-unique token IS a figure — never a
        // two-digit DD.MM / HH.MM, never a pair of years, never one decimal.
        const twoDigitDate = a.length === 2 && (dayMonth || clock); // "25.03", "31.12", "14.30"
        const years = /^(?:19|20)\d\d$/.test(a) && /^(?:19|20)\d\d$/.test(b);
        const proved = a === "0" || (b.length >= 2 && !twoDigitDate && !years && anchoredBy(anchors, reading(it.tok, fd)));
        if (proved) { num = figureSwap.swap(it.tok, lang); numChanged = true; }
        else { left.push({ token: it.tok, reason: "bare_decimal" }); continue; }
      }
    }

    const two = !!(it.head.currency && it.tail.currency);
    const currency = it.head.currency ?? it.tail.currency;
    // A year after a code ("EUR 2025") is not an amount.
    if (it.head.currency && !numChanged && !it.tail.mag && /^(?:19|20)\d\d$/.test(it.tok)) { left.push({ token: it.tok, reason: "possible_year" }); continue; }
    let mag = "", magChanged = false;
    const magSrc = out.slice(it.e, it.e + it.tail.magLen);
    if (it.tail.mag) {
      const want = native.magnitude_joiner + native.magnitudes[it.tail.mag];
      if (magSrc !== want && plainJoiners(magSrc) !== plainJoiners(want)) {
        if (TENOR_WORDS.includes(before())) { left.push({ token: it.tok + magSrc, reason: "tenor" }); continue; }
        if (numChanged || currency) { mag = want; magChanged = true; }
        else { mag = magSrc; left.push({ token: it.tok + magSrc, reason: "bare_magnitude" }); }
      } else mag = magSrc;
    }
    if (two) left.push({ token: out.slice(it.head.start, it.e + it.tail.magLen + it.tail.currencyLen), reason: "two_currencies" });
    const tailSrc = out.slice(it.e + it.tail.magLen, it.e + it.tail.magLen + it.tail.currencyLen);
    const tailWant = it.tail.currency ? native.code_joiner + it.tail.currency : "";
    // A code the model already wrote after the figure keeps its own space.
    const tailChanged = !!it.tail.currency && !two && plainJoiners(tailSrc) !== " " + it.tail.currency;
    // A code before a percentage or a multiple ("EUR 30%") is not that
    // number's denomination.
    const moveHead = !!it.head.currency && !two && !it.tail.unit;
    // A CODE THAT STAYS BEFORE THE FIGURE is counted (`code_before`), so the
    // report says what the reader still sees: one that is not this number's
    // to move, one after a rate word, one the strict reader does not reach
    // ("RON  5", "RON (5)", "**RON** 5").
    let stays: number | null = null;
    if (it.head.currency) stays = moveHead || two ? null : it.head.start;
    else if (it.head.stays !== null) stays = it.head.stays;
    else if (!it.head.evidenceOnly) stays = looseHead(s, it.s, it.floor);
    if (stays !== null) left.push({ token: s.slice(stays, it.e), reason: "code_before" });
    if (!numChanged && !magChanged && !tailChanged && !moveHead) continue;
    const from = moveHead ? it.head.start : it.s;
    const to = it.e + it.tail.magLen + (it.tail.currency && !two ? it.tail.currencyLen : 0);
    const piece =
      (moveHead ? it.head.sign : "") + num + mag +
      (moveHead ? native.code_joiner + it.head.currency : tailChanged ? tailWant : it.tail.currency && !two ? tailSrc : "");
    // One stop, not two, where "mil." ends a sentence ("4.58M." → "4,58 mil.").
    const stop = mag.endsWith(".") && magChanged && out[to] === "." && !isDigit(out[to + 1] ?? "") && piece.endsWith(".") ? 1 : 0;
    // English text: "… 2,3 mil. The" — the abbreviation's stop was the
    // sentence's too, and "M" has none. A capitalised WORD starts a sentence;
    // an acronym or a code does not ("4,58 mil. CAD", "2,3 mil. EBITDA").
    const lostStop = lang === "en" && magChanged && magSrc.endsWith(".") && !it.tail.currency && /^(?:\s*$|\s*\n|\s+\p{Lu}(?!\p{Lu}))/u.test(out.slice(it.e + it.tail.magLen)) ? "." : "";
    out = out.slice(0, from) + piece + lostStop + out.slice(to + stop);
    rewritten += 1;
  }
  // THE RUN-TIME PROOF: no digit added, dropped or reordered; no sign, no
  // ratio mark, no magnitude and no currency binding changed.
  if (digitsOf(out) !== digitsOf(s) || !figureProof.structureHeld(s, out)) { leftOut.push({ token: s.slice(0, 40), reason: "proof_failed" }); return { text: s, rewritten: 0 }; }
  for (let i = left.length - 1; i >= 0; i--) leftOut.push(left[i]);
  return { text: out, rewritten };
}

/** `text` — prose written in `lang` — with every figure PROVEN to be in the
 *  other language's notation rewritten into `lang`'s. `left` names every
 *  token left as written, in text order. Anything that is not a non-empty
 *  string comes back as it was given. Never throws. */
export function normaliseFigures(text: string, lang: FigureLang, anchors: readonly number[] = []): NormaliseResult {
  const left: LeftToken[] = [];
  if (typeof text !== "string" || !text || (lang !== "ro" && lang !== "en")) return { text, rewritten: 0, left };
  try {
    const handed = Array.from(anchors).filter((a) => typeof a === "number" && Number.isFinite(a));
    let out = "", rewritten = 0, at = 0;
    const rx = protectedSpans(text);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const seg = normaliseSegment(text.slice(at, m.index), lang, left, handed, [at > 0 && isDigit(text[at - 1] ?? ""), isDigit(m[0][0] ?? "")]);
      out += seg.text + m[0];
      rewritten += seg.rewritten;
      at = m.index + m[0].length;
    }
    const seg = normaliseSegment(text.slice(at), lang, left, handed, [at > 0 && isDigit(text[at - 1] ?? ""), false]);
    out += seg.text;
    // The proof again, over the whole text (each segment already passed).
    if (digitsOf(out) !== digitsOf(text)) return { text, rewritten: 0, left: [{ token: text.slice(0, 40), reason: "proof_failed" }] };
    // NEVER HALF A TEXT. A lone three-digit group ("386,102") is read by the
    // notation of the figures around it. Rewriting those and leaving it would
    // make it the one token still in the other notation — read a thousand
    // times smaller, or larger, than the model wrote it. So a text that holds
    // one is returned whole, exactly as it was written: every figure in it
    // still reads the way it did.
    if (rewritten + seg.rewritten > 0 && left.some((l) => l.reason === "single_group")) {
      left.push({ token: "", reason: "text_held" });
      return { text, rewritten: 0, left };
    }
    return { text: out, rewritten: rewritten + seg.rewritten, left };
  } catch {
    // A formatter must never break the text it formats.
    return { text, rewritten: 0, left: [{ token: "", reason: "proof_failed" }] };
  }
}

// ── the language of a text: positive evidence only ───────────────────────

export const RO_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "și", "în", "este", "sunt", "iar", "pentru", "din", "sau", "că", "cu", "prin", "dar", "fost", "față", "după",
  "între", "către", "această", "acest", "aceste", "care",
]);
/** The Romanian function words NO other narration language uses. "este" and
 *  "dar" are everyday Spanish and Portuguese ("este ejercicio", "puede dar"),
 *  "care" is Italian, "cu" Portuguese, "sau" and "din" are words elsewhere:
 *  those count as evidence only beside one of these. Without one a text is
 *  never Romanian — a Spanish reply read as Romanian had its "12,3M" turned
 *  into "12,3 mil.", which is twelve THOUSAND in Spanish. */
export const RO_DISTINCTIVE_WORDS: ReadonlySet<string> = new Set([
  "și", "în", "sunt", "iar", "pentru", "că", "prin", "fost", "față", "după", "între", "către", "această", "acest",
  "aceste",
]);
export const EN_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "with", "this", "that", "from", "which", "your", "for", "have", "has", "were", "their",
  "its", "than", "between",
]);

/** How many function words make a text's own language STRONG evidence — it
 *  then wins over what a caller says. Fewer is thin: it is followed when
 *  nothing contradicts it, and never against the question the text answers. */
const STRONG_EVIDENCE = 4;

interface ProseEvidence {
  /** The language the text reads as, or null. */
  lang: FigureLang | null;
  strong: boolean;
  /** English by its function words, but the text holds Romanian letters (ă,
   *  ș, ț): undecided — English only with the context's agreement. */
  lean: FigureLang | null;
}

function proseEvidence(text: string | null | undefined): ProseEvidence {
  const none: ProseEvidence = { lang: null, strong: false, lean: null };
  if (typeof text !== "string" || !text) return none;
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let ro = 0, en = 0, distinctive = false;
  const roSeen = new Set<string>();
  for (const t of tokens) {
    if (RO_FUNCTION_WORDS.has(t)) { ro++; roSeen.add(t); if (RO_DISTINCTIVE_WORDS.has(t)) distinctive = true; }
    else if (EN_FUNCTION_WORDS.has(t)) en++;
  }
  // Comma-below ș / ț and ă are Romanian's alone among the languages a
  // narration is written in (the cedilla forms are not read: Turkish has them).
  const romanianLetters = /[ăĂșȘțȚ]/.test(text);
  if (distinctive && ro >= 2 && (en === 0 || (ro >= 3 && ro >= 2 * en))) return { lang: "ro", strong: ro >= STRONG_EVIDENCE, lean: null };
  if (en >= 2 && (ro === 0 || (en >= 3 && en >= 2 * ro))) {
    // A Romanian reply written as labels ("- Marjă: 11,25%") has no function
    // word at all; one English gloss in it ("free cash flow from the
    // operations") must not make it English and its right figures wrong.
    return romanianLetters ? { ...none, lean: "en" } : { lang: "en", strong: en >= STRONG_EVIDENCE, lean: null };
  }
  if (en === 0 && romanianLetters) return { lang: "ro", strong: false, lean: null };
  return none;
}

/** The language `text` is WRITTEN in — Romanian function words (one of them
 *  Romanian's alone) against English ones — or null when it cannot be told:
 *  too short, mixed, another language, or English words around Romanian
 *  letters. */
export function proseLanguageOf(text: string | null | undefined): FigureLang | null {
  return proseEvidence(text).lang;
}

/** The language a model's text is SHOWN in. Its own prose when that is strong
 *  evidence. Otherwise what the caller says — the first context TEXT whose
 *  language can be read (the question it answers, then earlier messages,
 *  nearest first), else `fallback`, a language the caller KNOWS (the one
 *  Explain asked for, a briefing's `ro` stamp) — and thin evidence of its own
 *  is followed only where the caller does not say otherwise: a text whose few
 *  words point one way while the question points the other is not touched.
 *  NEVER the UI language. null: the text is not to be touched. */
export function figureLanguageOf(
  text: string,
  context: readonly (string | null | undefined)[] = [],
  fallback: FigureLang | null = null,
): FigureLang | null {
  const own = proseEvidence(text);
  if (own.lang && own.strong) return own.lang;
  let said: FigureLang | null = null;
  for (const c of context) {
    const l = proseLanguageOf(c);
    if (l) { said = l; break; }
  }
  if (!said) said = fallback === "ro" || fallback === "en" ? fallback : null;
  if (own.lang) return said === null || said === own.lang ? own.lang : null;
  if (own.lean) return said === own.lean ? own.lean : null;
  return said;
}

/** For each turn of a conversation, oldest first: the language of the
 *  nearest EARLIER turn whose language can be read (null: none before it
 *  reads). A null entry is a turn that is nobody's prose — pending, failed,
 *  refused (the app's own notice, written in the UI language), interrupted —
 *  it is given a hint like any other and gives none. */
export function languageHints(turns: readonly (string | null | undefined)[]): (FigureLang | null)[] {
  const out: (FigureLang | null)[] = [];
  let last: FigureLang | null = null;
  for (const t of turns) {
    out.push(last);
    const l = proseLanguageOf(t);
    if (l) last = l;
  }
  return out;
}

/** The figures of the workspace snapshot the chat hands the model — en-US by
 *  construction ABOVE the briefing / recommendation / alert sections (those
 *  three are prose a model or the engine wrote, in any notation). Dates and
 *  code are removed first; a bare integer is skipped (it proves nothing: a
 *  plain integer is never rewritten). */
export function anchorsOfSnapshot(text: string | null | undefined): number[] {
  let t = typeof text === "string" ? text : "";
  const cut = [/^Prior engine-generated briefing:$/m, /^Recommendations on file:$/m, /^Alerts on file:$/m]
    .map((rx) => { const m = rx.exec(t); return m ? m.index : -1; })
    .filter((i) => i >= 0);
  if (cut.length) t = t.slice(0, Math.min(...cut));
  t = t.replace(protectedSpans(t), " ");
  const out: number[] = [];
  const rx = /\d[\d,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(t)) !== null) {
    if (!/[.,]/.test(m[0])) continue;
    if (!/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+\.\d+$/.test(m[0])) continue;
    const v = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export interface DisplayOptions {
  /** Texts whose language may stand in for the text's own, nearest first. */
  context?: readonly (string | null | undefined)[];
  /** A language the caller KNOWS. Never the UI language. */
  fallback?: FigureLang | null;
  /** Figures the model was handed: evidence that a token is a figure. */
  anchors?: readonly number[];
}
export interface DisplayResult extends NormaliseResult {
  /** The language the text was read in; null when it has no digit (nothing
   *  to format) or its language could not be told (nothing was touched). */
  lang: FigureLang | null;
}

/** A model's text as the reader is shown it: its figures in the format of the
 *  language it is written in. THE one entry point of every surface. Never
 *  throws — any error returns the text as written. */
export function displayModelText(text: string, opts: DisplayOptions = {}): DisplayResult {
  try {
    // No digit, no figure: nothing to read, not even the language.
    if (typeof text !== "string" || !/[0-9]/.test(text)) return { text, lang: null, rewritten: 0, left: [] };
    const lang = figureLanguageOf(text, opts.context ?? [], opts.fallback ?? null);
    if (!lang) return { text, lang: null, rewritten: 0, left: [{ token: "", reason: "language_unknown" }] };
    return { ...normaliseFigures(text, lang, opts.anchors ?? []), lang };
  } catch {
    return { text, lang: null, rewritten: 0, left: [{ token: "", reason: "proof_failed" }] };
  }
}

/** Counts by reason — what a surface may LOG. Never a token, never a figure. */
export function leftByReason(left: readonly LeftToken[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of left) out[l.reason] = (out[l.reason] ?? 0) + 1;
  return out;
}
