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
//   glued           "v2.1", "1.5T" — part of a word.
//   proof_failed    the run-time proof below refused the result.
//
// A handed figure is EVIDENCE that a value-unique token is a figure — it
// never chooses between two readings.
//
// RUN-TIME PROOF (every call): the digit sequence of the output equals the
// input's, or the text is returned exactly as it came.
//
// WHICH LANGUAGE. The format follows the language the TEXT is written in —
// never the UI language: a Romanian-interface reader who asks in English gets
// an English answer, and English text keeps English figures. A text's
// language is read on positive evidence only (`proseLanguageOf`); a text
// whose language cannot be told — or is German, French, Spanish, Italian,
// Portuguese, Dutch, Polish — is not touched.
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
  | "glued" | "proof_failed"
  // displayModelText only: the text's language could not be told, so nothing was read.
  | "language_unknown";

export interface LeftToken { token: string; reason: LeftReason }
export interface NormaliseResult { text: string; rewritten: number; left: LeftToken[] }

const NBSP = "\u00a0";
const NARROW_NBSP = "\u202f";
const MINUS = "\u2212"; // "−", the typographic minus sign
const EN_DASH = "\u2013";
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
const UNIT_WORDS = [
  "zile", "zi", "days", "day", "ani", "years", "year", "luni", "months", "month", "ori", "times",
  "pp", "p.p.", "puncte", "points", "milioane", "miliarde", "million", "millions", "billion", "billions", "thousand",
  "lei", "leu", "euro", "euros", "dolari", "dollars",
];
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
const TENOR_WORDS = ["robor", "euribor", "libor", "sofr", "ircc", "saron", "estr", `${EURO}str`];

const SIGNS = ["-", MINUS, "+"];
const DASHES = ["-", EN_DASH, " - ", ` ${EN_DASH} `];

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

type Shape = "foreign_full" | "foreign_decimal" | "single_group" | "native_or_plain";

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
  return "native_or_plain";
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

interface Tail { mag: Magnitude | null; magLen: number; unit: boolean; currency: string | null; currencyLen: number }

/** What stands right AFTER the number that ends at `i`: a magnitude, a unit,
 *  a currency. */
function readTail(s: string, i: number): Tail {
  const t: Tail = { mag: null, magLen: 0, unit: false, currency: null, currencyLen: 0 };
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
  if (s[j] === "%" || s[j] === "\u2030" || s[j] === "\u00d7" || (s[j] === "x" && !isLetter(s[j + 1] ?? ""))) { t.unit = true; return t; }
  let k = j;
  if (isSpace(s[k] ?? "")) k += 1; else if (!isSymbol(s[k] ?? "")) return t;
  if (s[k] === "%") { t.unit = true; return t; }
  const de = s.startsWith("de", k) && isSpace(s[k + 2] ?? "") ? 3 : 0; // "64.567.890 de lei"
  const at = k + de;
  if (de === 0) {
    for (const code of CODES) {
      const next = s[at + 3] ?? "";
      if (s.startsWith(code, at) && !isLetter(next) && !isDigit(next)) { t.currency = code; t.currencyLen = at + 3 - j; return t; }
    }
    const next = s[at + 1] ?? "";
    if (isSymbol(s[at] ?? "") && !isLetter(next) && !isDigit(next)) { t.currency = SYMBOL_CODE[s[at]]; t.currencyLen = at + 1 - j; return t; }
  }
  for (const w of UNIT_WORDS) if (s.startsWith(w, at) && !isLetter(s[at + w.length] ?? "")) { t.unit = true; return t; }
  return t;
}

interface Head { currency: string | null; start: number; sign: string; evidenceOnly: boolean }

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
    if (isLetter(b) || isDigit(b) || isSymbol(b)) return { currency: null, start: i, sign: "", evidenceOnly: true };
    return { currency: SYMBOL_CODE[s[k - 1]], start: k - 1, sign, evidenceOnly: false };
  }
  if (k - 3 >= floor) {
    const code = s.slice(k - 3, k);
    const before = s[k - 4] ?? "";
    if (CODES.includes(code) && !isLetter(before) && !isDigit(before) && before !== "/") {
      if (RATE_WORDS.includes(wordBefore(s, k - 3))) return { currency: null, start: i, sign: "", evidenceOnly: true };
      return { currency: code, start: k - 3, sign, evidenceOnly: false };
    }
  }
  return { currency: null, start: i, sign: "", evidenceOnly: false };
}

function atLineStart(s: string, at: number): boolean {
  let i = at;
  while (i > 0 && s[i - 1] !== "\n") i--;
  return /^[\s#>*\u2022\-]*$/.test(s.slice(i, at));
}

interface Item { s: number; e: number; tok: string; shape: Shape; head: Head; tail: Tail; adjacent: boolean; ok: boolean }

function normaliseSegment(s: string, lang: FigureLang, leftOut: LeftToken[], anchors: readonly number[]): { text: string; rewritten: number } {
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
    const tail = readTail(s, en);
    const next = s[en] ?? "";
    const ok = !glued && !(isLetter(next) && !tail.mag && !(next === "x" && !isLetter(s[en + 1] ?? ""))) && next !== "/" && next !== "^";
    items.push({
      s: st, e: en, tok: m[0], shape: shapeOf(m[0], lang), head, tail, ok,
      // Something beside the number says it is a figure.
      adjacent: !!(head.currency || head.evidenceOnly || tail.currency || tail.unit || tail.mag),
    });
    floor = en + tail.magLen + tail.currencyLen;
  }
  // A range: "1.2-1.5%", "între 8.5 și 13.2%" — the first number takes the
  // second one's evidence. The joiner word counts only after a range opener.
  for (let i = 0; i + 1 < items.length; i++) {
    const a = items[i], b = items[i + 1];
    const between = s.slice(a.e, b.s);
    const dash = DASHES.includes(between);
    const word = RANGE_JOINERS.includes(between) && RANGE_OPENERS.includes(wordBefore(s, a.s));
    if ((dash || word) && b.adjacent && !a.adjacent && !a.tail.mag) a.adjacent = true;
  }

  let out = s, rewritten = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.ok) {
      if (it.shape !== "native_or_plain") left.push({ token: it.tok, reason: "glued" });
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
      const listLike = /^\d{3}(?:[.,]\d{3})+$/.test(it.tok);
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
    if (!numChanged && !magChanged && !tailChanged && !moveHead) continue;
    const from = moveHead ? it.head.start : it.s;
    const to = it.e + it.tail.magLen + (it.tail.currency && !two ? it.tail.currencyLen : 0);
    const piece =
      (moveHead ? it.head.sign : "") + num + mag +
      (moveHead ? native.code_joiner + it.head.currency : tailChanged ? tailWant : it.tail.currency && !two ? tailSrc : "");
    // One stop, not two, where "mil." ends a sentence ("4.58M." → "4,58 mil.").
    const stop = mag.endsWith(".") && magChanged && out[to] === "." && !isDigit(out[to + 1] ?? "") && piece.endsWith(".") ? 1 : 0;
    // English text: "… 2,3 mil. The" — the abbreviation's stop was the
    // sentence's too, and "M" has none.
    const lostStop = lang === "en" && magChanged && magSrc.endsWith(".") && !it.tail.currency && /^(?:\s*$|\s*\n|\s+\p{Lu})/u.test(out.slice(it.e + it.tail.magLen)) ? "." : "";
    out = out.slice(0, from) + piece + lostStop + out.slice(to + stop);
    rewritten += 1;
  }
  // THE RUN-TIME PROOF: no digit added, dropped or reordered.
  if (digitsOf(out) !== digitsOf(s)) { leftOut.push({ token: s.slice(0, 40), reason: "proof_failed" }); return { text: s, rewritten: 0 }; }
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
      const seg = normaliseSegment(text.slice(at, m.index), lang, left, handed);
      out += seg.text + m[0];
      rewritten += seg.rewritten;
      at = m.index + m[0].length;
    }
    const seg = normaliseSegment(text.slice(at), lang, left, handed);
    out += seg.text;
    // The proof again, over the whole text (each segment already passed).
    if (digitsOf(out) !== digitsOf(text)) return { text, rewritten: 0, left: [{ token: text.slice(0, 40), reason: "proof_failed" }] };
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
export const EN_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "with", "this", "that", "from", "which", "your", "for", "have", "has", "were", "their",
  "its", "than", "between",
]);

/** The language `text` is WRITTEN in — Romanian-only function words against
 *  English ones — or null when it cannot be told (too short, mixed, or
 *  another language: an Italian or Spanish sentence shares "care", "este" or
 *  "con" with nothing here by accident, which is why one word is not enough). */
export function proseLanguageOf(text: string | null | undefined): FigureLang | null {
  if (typeof text !== "string" || !text) return null;
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let ro = 0, en = 0;
  const roSeen = new Set<string>();
  for (const t of tokens) {
    if (RO_FUNCTION_WORDS.has(t)) { ro++; roSeen.add(t); }
    else if (EN_FUNCTION_WORDS.has(t)) en++;
  }
  const roOk = roSeen.size >= 2 || (roSeen.size === 1 && !roSeen.has("este") && !roSeen.has("care") && ro >= 2);
  if (roOk && ro >= 2 && (en === 0 || (ro >= 3 && ro >= 2 * en))) return "ro";
  if (en >= 2 && (ro === 0 || (en >= 3 && en >= 2 * ro))) return "en";
  // Comma-below ș / ț and ă are Romanian's alone among the languages a
  // narration is written in (the cedilla forms are not read: Turkish has them).
  if (en === 0 && /[ăĂșȘțȚ]/.test(text)) return "ro";
  return null;
}

/** The language a model's text is SHOWN in: its own prose; else the first
 *  context TEXT whose language can be read (the question it answers, then
 *  earlier messages — nearest first); else `fallback`, a language the caller
 *  KNOWS (the one Explain asked for, a briefing's `ro` stamp). NEVER the UI
 *  language. null: the text is not to be touched. */
export function figureLanguageOf(
  text: string,
  context: readonly (string | null | undefined)[] = [],
  fallback: FigureLang | null = null,
): FigureLang | null {
  const own = proseLanguageOf(text);
  if (own) return own;
  for (const c of context) {
    const l = proseLanguageOf(c);
    if (l) return l;
  }
  return fallback === "ro" || fallback === "en" ? fallback : null;
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
