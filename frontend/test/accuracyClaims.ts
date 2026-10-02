// accuracyClaims — what a TYPED ACCURACY CLAIM looks like, for the gate
// `landing-proof` (law L12) and nobody else.
//
// The first version of that gate knew two shapes — a percentage or an
// "N of M" beside a fixed vocabulary ("drift", "reconcil", "calibr" …) — and
// read the landing's string table only. A verifier typed, one at a time:
//
//   "Verified on 9 of 9 real books — every balance sheet reconciles within
//    0.1%."                                  (markup, above the proof block)
//   "…all nine real books are byte-identical."            (a number word)
//   "We tested 20 real company books and every one matched."
//   "Tested on 40 real company books, all correct."
//   "Correct on 100% of the books we tested."
//   "99.9% accurate on 9 of 9 calibration books"            (/signup)
//
// and every gate stayed green. The rules here are stated on SHAPE, not on a
// list of sentences:
//
//   percentage  a figure (or a number word) with "%", "percent", "la sută",
//               "procente";
//   n-of-m      "N of M", "N din M", "N out of M", "N / M" — digits or
//               number words;
//   count       a digit or a number word in the same CLAUSE as a word of
//               measuring the engine: books, balanțe, fixtures, tested,
//               verified, correct, accurate (and their Romanian forms).
//
// What is NOT a measurement and is removed before the rules read a sentence:
// an account or class number ("account 121", "class 6/7"), a calendar date
// ("29 Sept 2026"), and a rate ("3 trial balances / month", "10/day").
//
// The rules do not decide whether a number is true. They say "this is a
// number of the kind only engineProof.json may supply"; the gate decides
// where it came from.

/** Two and up: "one" / "un" / "o" are articles as often as counts. */
const NUMBER_WORD =
  "(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|" +
  "seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen|" +
  "doi|două|trei|patru|cinci|șase|șapte|opt|nouă|zece|unsprezece|doisprezece|douăsprezece|treisprezece|" +
  "paisprezece|cincisprezece|șaisprezece|șaptesprezece|optsprezece|nouăsprezece|douăzeci|treizeci|patruzeci|" +
  "cincizeci|șaizeci|șaptezeci|optzeci|nouăzeci|sută|sute|mie|mii|zeci)";

const L = "\\p{L}";
const word = (body: string) => `(?<![${L}\\d])${body}(?![${L}\\d])`;

const NUMBER = new RegExp(`\\d|${word(NUMBER_WORD)}`, "iu");

/** The vocabulary of measuring the engine (owner's list, 2026-10-02), in
 *  both languages. "book" singular is "this book" — one company's file, the
 *  word the sample page uses for its own ledger — and is not here. */
const MEASURING = new RegExp(
  [
    word("books"), word("fixtures?"), word("tested"), word("verified"), word("correct(?:ly|ness)?"),
    word("accura\\p{L}*"), word("calibrat\\p{L}*"),
    word("balanțe(?:le|lor)?"), word("fișiere(?:le)? de test"), word("testat\\p{L}*"), word("verificat\\p{L}*"),
    word("corect\\p{L}*"), word("acurat\\p{L}*"), word("precis\\p{L}*"), word("precizi\\p{L}*"),
    word("calibr\\p{L}*"),
  ].join("|"),
  "iu",
);

const PERCENT = new RegExp(
  `(?:\\d|${word(NUMBER_WORD)})\\s*(?:%|${word("percent")}|${word("per cent")}|${word("la sută")}|${word("procente?")})|%\\s*\\d`,
  "iu",
);

const N = `(?:\\d{1,4}|${NUMBER_WORD})`;
const N_OF_M = new RegExp(
  [
    // "9 of 9", "nine of our nine", "9 din cele 9", "9 out of 9"
    `(?<![${L}\\d/.,-])${N}\\s+(?:of|out of|din|dintre)\\s+(?:the\\s+|our\\s+|cele\\s+|cei\\s+)?${N}(?![${L}\\d])`,
    // "9 / 9", "9/9" — never a date ("31/12/2025") or a register number ("J99/9999/2099")
    `(?<![${L}\\d/.,-])\\d{1,3}\\s*/\\s*\\d{1,3}(?![${L}\\d/.,])`,
  ].join("|"),
  "iu",
);

// ── what is not a measurement ─────────────────────────────────────────

const MONTH =
  "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|ian|mai|iun|iul|noi)[\\p{L}]*\\.?";

/** Account and class numbers, calendar dates, rates. Each is replaced by a
 *  space, so what is left of the sentence still reads as words. */
export function withoutIdentifiers(text: string): string {
  return text
    // "account 121", "accounts 331 + 345", "contul 121", "class 6/7", "class-6/7"
    .replace(
      new RegExp(
        `(${word("accounts?|contul|contului|conturile|conturilor|cont|class(?:es)?|clasa|clasele|claselor")})` +
          `[\\s-]+\\d[\\dx]*(?:\\s*(?:[/+,]|and|și|or|sau)\\s*\\d[\\dx]*)*`,
        "giu",
      ),
      "$1 ",
    )
    // "29 Sept 2026", "2 oct. 2026", "2026-10-02", "31.12.2025"
    .replace(new RegExp(`\\b\\d{1,2}\\s+${MONTH}\\s+\\d{4}\\b`, "giu"), " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, " ")
    // a rate: "3 trial balances / month", "10 chats / day", "50 / month", "10/zi"
    .replace(
      new RegExp(
        `\\d+(?:[.,]\\d+)?(\\s*(?:(?:de\\s+)?[${L}-]+\\s+){0,4}?/\\s*(?:month|mo|day|year|lună|zi|an)(?![${L}]))`,
        "giu",
      ),
      "$1",
    );
}

/** Tags and the entities the landing's string table uses. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&mdash;/g, "—").replace(/&middot;/g, "·")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ClaimRule = "percentage" | "n-of-m" | "count";

export interface Claim {
  rule: ClaimRule;
  /** The characters that matched. */
  hit: string;
  /** The sentence (identifiers removed) the rule read. */
  sentence: string;
}

const sentencesOf = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+|\s·\s/).map((s) => s.trim()).filter(Boolean);

/** A clause: a count is "beside" a measuring word when no dash, colon,
 *  semicolon or bracket stands between them. */
const clausesOf = (sentence: string): string[] =>
  sentence.split(/\s[—–-]\s|[;:()]/).map((c) => c.trim()).filter(Boolean);

export interface ClaimOptions {
  /** A percentage is a claim wherever it stands (the landing, /pricing,
   *  /signup: nothing there may print one outside the proof block). When
   *  false — the sample page, whose ratios are the fictional company's — a
   *  percentage is a claim only beside a measuring word. */
  percentAnywhere: boolean;
}

/** Every typed accuracy claim in `text`. */
export function accuracyClaims(text: string, options: ClaimOptions): Claim[] {
  const out: Claim[] = [];
  for (const sentence of sentencesOf(withoutIdentifiers(text))) {
    const pct = PERCENT.exec(sentence);
    if (pct && (options.percentAnywhere || MEASURING.test(sentence))) {
      out.push({ rule: "percentage", hit: pct[0], sentence });
    }
    const pair = N_OF_M.exec(sentence);
    if (pair) out.push({ rule: "n-of-m", hit: pair[0], sentence });
    for (const clause of clausesOf(sentence)) {
      const vocabulary = MEASURING.exec(clause);
      const number = NUMBER.exec(clause);
      if (vocabulary && number) {
        out.push({ rule: "count", hit: `${number[0]} … ${vocabulary[0]}`, sentence: clause });
      }
    }
  }
  return out;
}
