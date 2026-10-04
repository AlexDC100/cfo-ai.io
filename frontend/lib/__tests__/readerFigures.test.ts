// GATE ai-figures — WHAT A MODEL WROTE IS SHOWN IN THE READER'S FORMAT, AND
// NO VALUE CHANGES ON THE WAY (the browser's normaliser).
//
// OWNER ORDER (2026-10-04, verbatim): "Add to the next release: make chat and
// briefings write numbers in Romanian format in Romanian text (413.727.560
// RON, ~77,4 mil. EUR), currency after the figure. Use the product's own
// formatting standard, with a gate."
//
// WHAT WAS TRUE BEFORE. Ask CFO AI answered, in a Romanian sentence, in the
// shape "~EUR 12.3M (convertit din RON 64,567,890 la cursul BNR 0.1905)" —
// and the chat rendered the model's text as it came. Nothing between the
// model and the reader knew what a figure looks like.
//
// "With a gate" means the OUTPUT is held, not the prompt. This file holds
// the rule set itself (frontend/lib/readerFigures.ts); the three files beside
// it in the gate hold what the reader SEES on each surface:
//   components/cfo/chat/__tests__/chatReplyFigures.test.tsx   (Ask CFO AI,
//       and the command bar's guard left alone)
//   lib/__tests__/explainFigures.test.ts                      (Explain)
//   components/cfo/__tests__/briefingCardFigures.test.tsx     (the briefing)
//
// THE LAWS HERE
//   1  THE CORPUS. tests/engine/fixtures/ai_figures/reply_corpus.json —
//      replies a model really writes, `expected` TYPED BY HAND, the first
//      one the incident's sentence in shape. The output is `expected`
//      (through plain spaces) and every token left is the one the corpus
//      names, with the reason it names, in text order. The engine's twin
//      (src/engine/ai/figure_format.py) is held to the same file.
//   2  THE INDEPENDENT DETECTOR. Every expected string and every output is
//      read by frontend/test/numberLanguage.ts — never by the normaliser
//      (CLAUDE.md §26: "never compare a printed figure only against the same
//      printer"). POSITIVE CONTROL: every wrong input IS flagged.
//   3  NO VALUE CHANGES. The digit sequence; an independent reader in this
//      file gives the same value for every rewritten token before and after;
//      a second pass changes nothing; and the run-time proof refuses a swap
//      that drops a digit.
//   4  NEVER GUESSED. A lone three-digit group ("1,234" / "1.234") comes back
//      byte-identical — alone, with a code before or after, a magnitude, a
//      unit, in both languages, with handed figures equal to either reading.
//      Handed figures change nothing but bare decimals and bare groups.
//   5  THE GRID. grid.json — 984 figures as lib/money prints them: the output
//      is lib/money's print byte for byte (U+00A0 joiners included), or — a
//      lone group — the sentence byte-identical.
//   6  THE STANDARD. FIGURE_STANDARD equals standard.json (which
//      chatLlmFigureFormat.test.ts regenerates from lib/money on every run)
//      and what lib/money prints NOW.
//   7  LANGUAGES. A German, French, Spanish, Italian, Portuguese, Dutch or
//      Polish text, and one too short to tell, is not changed by a byte; an
//      English answer that quotes Romanian terms is not read as Romanian; the
//      UI language decides nothing.
//   8  NON-FIGURES. A date, a clock time, a section / article / IAS number,
//      an account list, a spreadsheet reference, a tenor, a year after a
//      code, a pair, a foreign dollar, a code span, a URL, a placeholder.
//   9  THE SOURCE. No lookbehind (an old iOS WebView throws at parse time);
//      no Intl, clock, storage or i18n; imported by exactly five files —
//      never by the command bar, never by lib/cfoApi.
//  10  NEVER HALF A TEXT (review 2026-10-05). A text that holds a lone
//      three-digit group is returned whole, byte for byte, counted
//      `text_held`: rewriting the figures around it would leave the one
//      token with two readings alone in the other notation.
//  11  THE COMPOSED SET. tests/engine/fixtures/ai_figures/compose.json —
//      12,000 texts composed from parts by integer arithmetic: no digit
//      moves, a second pass changes nothing, nothing is half rewritten, and
//      the sha256 of every output equals the fixture's `digest` — the SAME
//      digest the engine's twin must produce. (What each figure is BOUND to
//      — amount, currency, sign, unit — is read by the engine gate's
//      independent reader over the corpus's hand-typed strings, which this
//      file holds the browser to byte for byte, and over that twin.)
//  12  THE RUN-TIME PROOF BEYOND DIGITS. A magnitude read as another, a
//      dropped sign, a code landed on another number: the text as written.
//
// REDS ON, with the repair in place (TC-11): a code moved onto another number
// (before a range, a list, a number that goes on, an unread magnitude, a
// second currency); a text half rewritten around a lone group; a Spanish or
// Portuguese text read as Romanian; a Romanian label list read as English for
// one English gloss; thin evidence of a text's language followed against the
// question it answers; a rule changed in the browser
// only (the corpus / grid / digest differ from the engine's twin); a value guessed; a
// digit dropped or the proof removed; a unit-less number re-printed without
// evidence; a date, a reference, a tenor, a foreign dollar touched; a joiner
// or a magnitude word drifting from lib/money's bytes; a language guessed
// from one word, or taken from the UI; a lookbehind; the normaliser reaching
// the command bar's answer.
//
// CANNOT SEE: what a model WRITES; a text HELD as written (counted; it still
// holds the model's notation — the detector is not run on it); a non-figure
// the pass re-spells because a currency or a unit stands beside it
// ("Versiunea 2.1 RON"); a Romanian text with no diacritics and none of the
// words only Romanian has (it is left as written unless the question reads);
// a token left by design (a lone group
// passes every law and the detector); a figure written in words; whether a
// value is TRUE; "lei" (left as written); the report page and the exports; a
// bundle older than the release.
//
// PLANT LOG: docs/engine_book/gates.md "ai-figures" (stage 2).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { formatMoneyFrom, moneyLocaleFor } from "@/lib/money";
import type { Rates } from "@/lib/rates";
import {
  EN_FUNCTION_WORDS,
  FIGURE_STANDARD,
  RO_DISTINCTIVE_WORDS,
  RO_FUNCTION_WORDS,
  anchorsOfSnapshot,
  displayModelText,
  figureLanguageOf,
  figureProof,
  figureSwap,
  languageHints,
  leftByReason,
  normaliseFigures,
  proseLanguageOf,
  type FigureLang,
} from "@/lib/readerFigures";
import { CURRENCY_BEFORE_FIGURE, foreignNumbersInProse, maskNotProse, plainSpaces } from "@/test/numberLanguage";

const REPO = resolve(__dirname, "../../..");
const FIXTURES = resolve(REPO, "tests/engine/fixtures/ai_figures");
const NBSP = String.fromCharCode(0xa0);

interface Kept { token: string; reason: string }
interface Case {
  id: string; lang: FigureLang; surface: "chat" | "briefing" | "both"; wrong: boolean;
  input: string; expected: string; kept: Kept[]; anchors?: number[]; allowed?: { text: string; rule: string }[];
}
type GridRow = [target: FigureLang, written: string, print: string, outcome: "rewritten" | "single_group"];

const CORPUS: Case[] = JSON.parse(readFileSync(resolve(FIXTURES, "reply_corpus.json"), "utf-8")).cases;
const GRID: { frames: Record<FigureLang, string>; rows: GridRow[] } = JSON.parse(readFileSync(resolve(FIXTURES, "grid.json"), "utf-8"));
const STANDARD_JSON = JSON.parse(readFileSync(resolve(FIXTURES, "standard.json"), "utf-8"));

interface ComposeSpec { count: number; nums: string[]; pre: string[]; post: string[]; words: string[]; seps: string[]; anchor_sets: number[][]; digest: string }
const COMPOSE: ComposeSpec = JSON.parse(readFileSync(resolve(FIXTURES, "compose.json"), "utf-8"));

const WORK = { corpus: 0, grid: 0, kept: 0, composed: 0 };
/** The case is a text returned whole because it holds a lone group. */
const held = (c: Case) => c.kept.some((k) => k.reason === "text_held");

const digits = (s: string) => s.replace(/[^0-9]/g, "");
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every figure of `text` in the OTHER language's format, and every currency
 *  standing before a figure — after what is not prose, what the standard
 *  leaves by rule (`allowed`) and what was left on purpose (`kept`, as WHOLE
 *  number tokens: "1.2" must not hide inside "11.25") is masked. Empty is the
 *  only pass. The same reading as the engine gate's `findings`. */
function findings(text: string, lang: FigureLang, kept: readonly Kept[] = [], allowed: readonly { text: string }[] = []): string[] {
  let t = maskNotProse(text);
  for (const a of allowed) t = t.split(a.text).join("#".repeat(a.text.length));
  for (const k of kept) t = t.replace(new RegExp(`(?<![0-9.,])${escapeRx(k.token)}(?![0-9]|[.,][0-9])`, "g"), (m) => "#".repeat(m.length));
  const before = [...t.matchAll(new RegExp(CURRENCY_BEFORE_FIGURE.source, "g"))].map((m) => m[0]);
  return [...foreignNumbersInProse(t, lang), ...before];
}

// ── an INDEPENDENT reader of one number token (law 3) ─────────────────────
// Not the normaliser's: it reads a token in a stated notation into a
// canonical decimal string ("64567890.5") or refuses it. Two tokens with the
// same canonical string have the same value — no float in between.
function valueOf(token: string, group: string, decimal: string): string | null {
  const parts = token.split(decimal);
  if (parts.length > 2) return null;
  const [whole, fraction = ""] = parts;
  const groups = whole.split(group);
  if (groups.some((g) => !/^\d+$/.test(g))) return null;
  if (groups.length > 1 && (groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3))) return null;
  if (fraction && !/^\d+$/.test(fraction)) return null;
  return `${groups.join("").replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`;
}
const tokensOf = (text: string) => maskNotProse(text).match(/\d[\d.,]*\d|\d/g) ?? [];
const MARKS: Record<FigureLang, { group: string; decimal: string }> = { ro: { group: ".", decimal: "," }, en: { group: ",", decimal: "." } };
const other = (lang: FigureLang): FigureLang => (lang === "ro" ? "en" : "ro");

/** Every number token of `before` against the same token of `after`: either
 *  the same characters, or the same VALUE read in the foreign notation before
 *  and in the reader's after. */
function valuesHeld(before: string, after: string, lang: FigureLang): string | null {
  const a = tokensOf(before), b = tokensOf(after);
  if (a.length !== b.length) return `token count ${a.length} → ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const was = valueOf(a[i], MARKS[other(lang)].group, MARKS[other(lang)].decimal);
    const is = valueOf(b[i], MARKS[lang].group, MARKS[lang].decimal);
    if (was === null || is === null || was !== is) return `${a[i]} (${was}) → ${b[i]} (${is})`;
  }
  return null;
}

afterAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { vi.restoreAllMocks(); });

// ══ the corpus is what it says it is ══════════════════════════════════════

describe("POSITIVE CONTROL — the corpus, the detector and the independent reader", () => {
  it("the corpus is not empty, its first case is the incident's sentence in shape, every wrong input IS flagged and every expected string passes", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(154);
    expect(new Set(CORPUS.map((c) => c.id)).size).toBe(CORPUS.length);
    const first = CORPUS[0];
    expect([first.id, first.lang, first.wrong]).toEqual(["incident-shape", "ro", true]);
    expect(first.input).toContain("~EUR 12.3M (convertit din RON 64,567,890 la cursul BNR 0.1905)");
    expect(first.expected).toContain("~12,3 mil. EUR (convertit din 64.567.890 RON la cursul BNR 0,1905)");
    for (const c of CORPUS) {
      expect(c.wrong, c.id).toBe(c.expected !== c.input);
      expect(c.expected.includes(NBSP), c.id).toBe(false);
      if (held(c)) {
        // A text returned whole: it IS what the model wrote — and the detector
        // says so (the hold is counted, never a silent pass).
        expect(c.expected, c.id).toBe(c.input);
        expect(c.kept[c.kept.length - 1], c.id).toEqual({ token: "", reason: "text_held" });
        expect(findings(c.input, c.lang).length, c.id).toBeGreaterThan(0);
      } else expect(findings(c.expected, c.lang, c.kept, c.allowed), c.id).toEqual([]);
      // The detector reads the RAW input of a wrong case: it is what the reader saw before.
      if (c.wrong) expect(findings(c.input, c.lang).length, `not seen as wrong: ${c.id}`).toBeGreaterThan(0);
      for (const k of c.kept) expect(c.input, `${c.id}: ${k.token}`).toContain(k.token);
    }
    expect(CORPUS.filter((c) => c.wrong).length).toBeGreaterThanOrEqual(95);
    expect(CORPUS.filter((c) => c.lang === "en").length).toBeGreaterThanOrEqual(26);
    expect(CORPUS.filter((c) => c.surface !== "briefing").length).toBeGreaterThanOrEqual(130);
    expect(CORPUS.filter(held).length).toBeGreaterThanOrEqual(4);
  });

  it("the detector sees the incident's sentence and passes what the reader must see instead (both typed here)", () => {
    const wrong = "cu o cifră de afaceri netă de ~EUR 12.3M (convertit din RON 64,567,890 la cursul BNR 0.1905).";
    const right = "cu o cifră de afaceri netă de ~12,3 mil. EUR (convertit din 64.567.890 RON la cursul BNR 0,1905).";
    expect(findings(wrong, "ro")).toEqual(["2.3", "4,567,890", "0.1905", "EUR 1", "RON 6"]);
    expect(findings(right, "ro")).toEqual([]);
    expect(findings(right, "en")).toEqual(["2,3", "4.567.890", "0,1905"]);
    // …and a lone three-digit group is matched by NOTHING: no detector can call it wrong.
    expect(findings("Numerarul este 162,365 RON sau 162.365 RON.", "ro")).toEqual([]);
    expect(findings("Numerarul este 162,365 RON sau 162.365 RON.", "en")).toEqual([]);
  });

  it("the independent reader: one value per notation, a refusal for what is not a number in it", () => {
    expect(valueOf("64,567,890", ",", ".")).toBe("64567890.");
    expect(valueOf("64.567.890", ".", ",")).toBe("64567890.");
    expect(valueOf("1,234,567.89", ",", ".")).toBe("1234567.89");
    expect(valueOf("1.234.567,89", ".", ",")).toBe("1234567.89");
    expect(valueOf("0.1905", ",", ".")).toBe("0.1905");
    expect(valueOf("0,1905", ".", ",")).toBe("0.1905");
    expect(valueOf("12.30", ",", ".")).toBe(valueOf("12,3", ".", ","));
    // Read in the WRONG notation the same characters are another number, or none.
    expect(valueOf("64,567,890", ".", ",")).toBeNull();
    expect(valueOf("12,3", ",", ".")).toBeNull();
    expect(valueOf("1.234", ".", ",")).toBe("1234.");
    expect(valueOf("1.234", ",", ".")).toBe("1.234");
    // …and it SEES a changed value: a dropped digit, a moved decimal mark.
    expect(valuesHeld("de RON 7,654,321.50", "de 7.654.321,5 RON", "ro")).toBeNull();
    expect(valuesHeld("de RON 7,654,321.50", "de 7.654.32,50 RON", "ro")).not.toBeNull();
    expect(valuesHeld("de 4,975 RON", "de 4.975 RON", "ro")).toBeNull(); // (the one shape with two values: law 4 holds it, not this reader)
    expect(valuesHeld("marjă 11.25%", "marjă 1,125%", "ro")).not.toBeNull();
  });
});

// ══ 1 + 2 + 3 — the corpus ════════════════════════════════════════════════

describe("1–3 the corpus: the output is the expected string, every token left is named, no value changes", () => {
  it.each(CORPUS.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const out = normaliseFigures(c.input, c.lang, c.anchors ?? []);
    WORK.corpus += 1;
    WORK.kept += out.left.length;
    // 1 — the expected string, typed by hand; the tokens left, with their reasons, in text order.
    expect(plainSpaces(out.text)).toBe(c.expected);
    expect(out.left).toEqual(c.kept);
    // 2 — the independent detector, on what the reader sees (a text HELD whole
    // is the model's own, counted: there is nothing of ours to read in it).
    if (!held(c)) expect(findings(out.text, c.lang, c.kept, c.allowed)).toEqual([]);
    // 10 — never half a text: where anything was rewritten, no lone group is left.
    const reasons = out.left.map((l) => l.reason);
    expect(out.text !== c.input && reasons.includes("single_group")).toBe(false);
    expect(reasons.includes("text_held")).toBe(held(c));
    // 3 — no digit added, dropped or reordered; every rewritten token keeps its value; a second pass changes nothing.
    expect(digits(out.text)).toBe(digits(c.input));
    expect(valuesHeld(c.input, out.text, c.lang)).toBeNull();
    expect(normaliseFigures(out.text, c.lang, c.anchors ?? []).text).toBe(out.text);
    if (c.wrong) expect(out.rewritten).toBeGreaterThanOrEqual(1);
    else {
      expect(out.text).toBe(c.input); // a reply already right is not touched by a byte
      expect(out.rewritten).toBe(0);
    }
  });

  it("every reason a token can be left for is exercised by the corpus (but the proof's refusal, planted below)", () => {
    const reasons = new Set(CORPUS.flatMap((c) => c.kept.map((k) => k.reason)));
    expect([...reasons].sort()).toEqual([
      "bare_decimal", "bare_groups", "bare_magnitude", "code_before", "glued", "leading_zero", "open_amount", "outline",
      "possible_date", "possible_year", "reference", "single_group", "tenor", "text_held", "two_currencies",
    ]);
  });
});

describe("3 the run-time proof", () => {
  it("PLANTED HERE, not in the source: a swap that drops a digit — the text comes back exactly as written, counted proof_failed", () => {
    const text = "EBITDA de RON 7,654,321.50 (marjă 11.85%).";
    const good = normaliseFigures(text, "ro");
    expect(plainSpaces(good.text)).toBe("EBITDA de 7.654.321,50 RON (marjă 11,85%).");
    expect(good.left).toEqual([]);
    const real = figureSwap.swap;
    vi.spyOn(figureSwap, "swap").mockImplementation((tok, lang) => real(tok, lang).slice(0, -1));
    const out = normaliseFigures(text, "ro");
    expect(out.text).toBe(text);
    expect(out.rewritten).toBe(0);
    expect(out.left.map((l) => l.reason)).toEqual(["proof_failed"]);
    // …and through the one entry point a surface calls.
    expect(displayModelText(text, { fallback: "ro" }).text).toBe(text);
  });

  it("a swap that THROWS, a text that is not a string, options that are not what they say: the text as written, never an exception", () => {
    vi.spyOn(figureSwap, "swap").mockImplementation(() => { throw new Error("boom"); });
    const text = "EBITDA de RON 7,654,321.50 și marjă de 11.85% pentru anul acesta.";
    expect(normaliseFigures(text, "ro")).toEqual({ text, rewritten: 0, left: [{ token: "", reason: "proof_failed" }] });
    expect(displayModelText(text).text).toBe(text);
    vi.restoreAllMocks();
    for (const value of [null, undefined, 42, { a: 1 }, ["RON 1,234.50"], ""]) {
      expect(displayModelText(value as unknown as string).text).toBe(value);
      expect(normaliseFigures(value as unknown as string, "ro").text).toBe(value);
    }
    // A language outside the standard, anchors that are not numbers, a fallback that is not a language.
    expect(normaliseFigures("Umsatz RON 64,567,890 (Marge 11.25%).", "de" as FigureLang).text).toBe("Umsatz RON 64,567,890 (Marge 11.25%).");
    expect(normaliseFigures("Rata este 1.42.", "ro", ["1.42", null, true, NaN, Infinity] as unknown as number[]).text).toBe("Rata este 1.42.");
    expect(displayModelText("EBITDA: 4.58M RON.", { fallback: "de" as FigureLang }).text).toBe("EBITDA: 4.58M RON.");
    expect(displayModelText("EBITDA: 4.58M RON.", { context: [null, undefined, 7 as unknown as string, ""] }).text).toBe("EBITDA: 4.58M RON.");
  });

  it("a token of several hundred decimal places is never proved by a handed figure (the engine's twin has the same guard)", () => {
    const long = "1." + "3".repeat(320);
    const text = `Raportul este ${long} acum.`;
    const out = normaliseFigures(text, "ro", [1.3333333333333333]);
    expect(out.text).toBe(text);
    expect(out.left.map((l) => l.reason)).toEqual(["bare_decimal"]);
  });

  it("a reply holding a long unbroken run does not freeze the render thread: 200 KB of word characters, and of dashed digits, in well under the test's time-out", () => {
    for (const run of ["a1".repeat(100_000), "1-".repeat(100_000) + "1"]) {
      const out = normaliseFigures(`Marja este ${run} și 4.5% acum.`, "ro");
      expect(out.rewritten).toBe(1);
      expect(out.text.endsWith("și 4,5% acum.")).toBe(true);
    }
  });
});

// ══ 4 — never guessed ═════════════════════════════════════════════════════

/** A lone three-digit group in every position the spec names. */
const LONE_GROUPS = [
  "{n}", "{n} RON", "RON {n}", `{n}${NBSP}RON`, "-RON {n}", "RON -{n}", "~EUR {n}", "{n} EUR", "{n}M RON",
  "{n} mil. RON", "{n}%", "{n} %", "{n}x", "{n} zile", "{n} lei", "€{n}", "${n}", "({n} RON)", "**{n} RON**",
];

describe("4 a token with two readings is never guessed", () => {
  it.each(["ro", "en"] as const)("%s: a lone three-digit group comes back byte-identical — currency position included — whatever was handed", (lang) => {
    let checked = 0;
    for (const number of ["1,234", "1.234", "162,365", "162.365", "999.999", "7.459"]) {
      const asGroups = Number(number.replace(/[.,]/g, ""));
      const asDecimal = asGroups / 1000;
      const frame = lang === "ro" ? "Valoarea este {x} acum." : "The value is {x} today.";
      for (const shape of LONE_GROUPS) {
        const text = frame.replace("{x}", shape.replace("{n}", number));
        for (const anchors of [[], [asGroups], [asDecimal], [asGroups, asDecimal], [asGroups + 0.12]]) {
          const out = normaliseFigures(text, lang, anchors);
          expect(out.text, `${text} ${JSON.stringify(anchors)}`).toBe(text);
          expect(out.left.map((l) => l.reason), text).toContain("single_group");
          checked += 1;
        }
      }
    }
    expect(checked).toBe(6 * LONE_GROUPS.length * 5);
  });

  it("handed figures change nothing but bare decimals and bare groups — over every corpus case, with every number of the text handed back in both readings", () => {
    let repairedTotal = 0;
    for (const c of CORPUS) {
      const handed: number[] = [];
      for (const t of c.input.match(/\d[\d.,]*\d|\d/g) ?? []) {
        for (const v of [t.replace(/,/g, ""), t.replace(/\./g, "").replace(",", "."), t.replace(/[.,]/g, "")]) {
          const n = Number(v);
          if (Number.isFinite(n)) handed.push(n);
        }
      }
      const bare = normaliseFigures(c.input, c.lang);
      const out = normaliseFigures(c.input, c.lang, handed);
      expect(digits(out.text), c.id).toBe(digits(c.input));
      expect(valuesHeld(c.input, out.text, c.lang), c.id).toBeNull();
      const repaired = bare.left.filter((l) => l.reason !== "text_held");
      // The handed figure proved a token beside a lone group: nothing may then
      // be rewritten at all — the text is returned whole.
      if (out.left.some((l) => l.reason === "text_held")) expect(out.text, c.id).toBe(c.input);
      for (const x of out.left.filter((l) => l.reason !== "text_held")) {
        const at = repaired.findIndex((y) => y.token === x.token && y.reason === x.reason);
        expect(at, `${c.id}: something NEW is left: ${JSON.stringify(x)}`).toBeGreaterThanOrEqual(0);
        repaired.splice(at, 1);
      }
      for (const r of repaired) expect(["bare_decimal", "bare_groups"], `${c.id}: ${JSON.stringify(r)}`).toContain(r.reason);
      repairedTotal += repaired.length;
    }
    expect(repairedTotal).toBeGreaterThanOrEqual(20); // …the law above did not run on nothing
  });

  it("a handed figure proves a value-unique ratio IS a figure; it never proves a date, a clock time, one decimal, or a reference", () => {
    const run = (text: string, anchors: number[]) => plainSpaces(normaliseFigures(text, "ro", anchors).text);
    expect(run("Lichiditatea curentă este 1.16, iar scorul Altman Z este 3.12.", [1.16, 3.12])).toBe("Lichiditatea curentă este 1,16, iar scorul Altman Z este 3,12.");
    expect(run("Lichiditatea curentă este 1.16, iar scorul Altman Z este 3.12.", [])).toBe("Lichiditatea curentă este 1.16, iar scorul Altman Z este 3.12.");
    for (const [text, anchors] of [
      ["La 31.12 soldul era stabil; (31.12) este data închiderii; plata (25.03).", [31.12, 25.03]],
      ["Ședința este la ora 14.30; (14.30).", [14.3]],
      ["Vezi 3.2 de mai sus; Z este 3.2.", [3.2]],
      ["Vezi secțiunea 3.12 și art. 7.25 din contract.", [3.12, 7.25]],
      ["Conturile 401,404,408 sunt furnizori.", [401404408]],
    ] as const) expect(run(text, [...anchors]), text).toBe(text);
  });
});

// ══ 10 — never half a text ════════════════════════════════════════════════

describe("10 a text that holds a lone three-digit group is returned whole", () => {
  const HELD = "Cifra de afaceri este RON 98,765,432.10, EBITDA este RON 9.8M (marjă 10.7%), iar dobânzile sunt RON 386,102 în această perioadă.";

  it("every figure of it stays as the model wrote it, counted — and without the lone group every one IS rewritten", () => {
    const out = normaliseFigures(HELD, "ro");
    expect(out).toEqual({ text: HELD, rewritten: 0, left: [{ token: "386,102", reason: "single_group" }, { token: "", reason: "text_held" }] });
    // POSITIVE CONTROL: the same sentence with a value-unique token in its place.
    const converted = normaliseFigures(HELD.replace("RON 386,102", "RON 386,102.50"), "ro");
    expect(plainSpaces(converted.text)).toBe("Cifra de afaceri este 98.765.432,10 RON, EBITDA este 9,8 mil. RON (marjă 10,7%), iar dobânzile sunt 386.102,50 RON în această perioadă.");
    expect([converted.rewritten, converted.left]).toEqual([4, []]);
    // A handed figure equal to either reading changes nothing: never guessed.
    for (const anchors of [[386102], [386.102], [386101.85], [386102, 386.102]]) expect(normaliseFigures(HELD, "ro", anchors).text).toBe(HELD);
    // Through the one entry point of every surface.
    expect(displayModelText(HELD).text).toBe(HELD);
    expect(leftByReason(displayModelText(HELD).left)).toEqual({ single_group: 1, text_held: 1 });
  });

  it("a lone group with nothing to rewrite beside it holds nothing; one inside an expression left as written holds the text too", () => {
    const alone = "Dobânzile sunt de 386.102 RON, iar marja este 10,7%.";
    expect(normaliseFigures(alone, "ro")).toEqual({ text: alone, rewritten: 0, left: [{ token: "386.102", reason: "single_group" }] });
    const english = "Cash: 1.234 RON; debt 12.345,67 RON; margin 11,25% for the year.";
    expect(normaliseFigures(english, "en").text).toBe(english);
    const ranged = "Valoarea este între EUR 1,500 și 2,500, cu o marjă de 11.25%.";
    const out = normaliseFigures(ranged, "ro");
    expect(out.text).toBe(ranged);
    expect(out.left.map((l) => l.reason)).toEqual(["open_amount", "single_group", "single_group", "text_held"]);
  });
});

// ══ 11 — the composed set, and the twin's digest ══════════════════════════

/** Text `i` of the composed set — the same integer arithmetic as
 *  tests/engine/_figure_compose.py (every product stays under 2**53). */
function compose(spec: ComposeSpec, i: number): { text: string; lang: FigureLang; anchors: number[] } {
  let state = ((i + 1) * 7919) % 2147483647;
  const step = () => (state = (state * 48271) % 2147483647);
  const pick = <T,>(items: readonly T[]): T => items[step() % items.length];
  const parts: string[] = [];
  const blocks = 1 + (step() % 4);
  for (let b = 0; b < blocks; b++) {
    if (step() % 4 === 0) { parts.push(pick(spec.words)); parts.push(pick(["", " "])); }
    const pre = pick(spec.pre), num = pick(spec.nums), post = pick(spec.post);
    parts.push(pre + num + post);
    if (step() % 5 < 3) { const n2 = pick(spec.nums), p2 = pick(spec.post); parts.push(n2 + p2); }
    parts.push(pick(spec.seps));
  }
  const lang: FigureLang = step() % 2 === 0 ? "ro" : "en";
  return { text: parts.join(""), lang, anchors: [...pick(spec.anchor_sets)] };
}

describe("11 the composed set: 12,000 texts neither twin was written against", () => {
  it("no digit moves, a second pass changes nothing, nothing is half rewritten — and the digest is the one the engine's twin produces", () => {
    expect(COMPOSE.count).toBe(12000);
    const hash = createHash("sha256");
    let changed = 0, heldTexts = 0, open = 0;
    for (let i = 0; i < COMPOSE.count; i++) {
      const { text, lang, anchors } = compose(COMPOSE, i);
      const out = normaliseFigures(text, lang, anchors);
      const reasons = out.left.map((l) => l.reason);
      if (digits(out.text) !== digits(text)) throw new Error(`a digit moved: ${JSON.stringify(text)}`);
      if (reasons.includes("text_held")) {
        if (out.text !== text || out.rewritten !== 0 || !reasons.includes("single_group")) throw new Error(`held, and changed: ${JSON.stringify(text)}`);
        heldTexts += 1;
      }
      if (out.text !== text && reasons.includes("single_group")) throw new Error(`half a text: ${JSON.stringify(text)}`);
      if (normaliseFigures(out.text, lang, anchors).text !== out.text) throw new Error(`a second pass changes it: ${JSON.stringify(text)}`);
      if (!figureProof.structureHeld(text, out.text)) throw new Error(`the proof does not hold on what was returned: ${JSON.stringify(text)}`);
      if (out.text !== text) changed += 1;
      if (reasons.includes("open_amount")) open += 1;
      hash.update(`${lang}\x1f${out.text}\x1f${out.rewritten}\x1f${out.left.map((l) => `${l.token}\x1d${l.reason}`).join("\x1e")}\n`, "utf8");
    }
    expect([changed >= 4000, heldTexts >= 500, open >= 1500], JSON.stringify({ changed, heldTexts, open })).toEqual([true, true, true]);
    // THE TWIN. tests/engine/test_ai_figure_format.py holds src/engine/ai/figure_format.py to this same string.
    expect(hash.digest("hex")).toBe(COMPOSE.digest);
    WORK.composed = COMPOSE.count;
  });

  it("POSITIVE CONTROL: the composition is deterministic and varied, and holds the review's shapes", () => {
    expect(compose(COMPOSE, 0)).toEqual(compose(COMPOSE, 0));
    const texts = Array.from({ length: 2000 }, (_, i) => compose(COMPOSE, i).text);
    expect(new Set(texts).size).toBeGreaterThanOrEqual(1990);
    const all = texts.join("\n");
    for (const shape of ["RON ", "$", " mil", " milion", " CAD", NBSP, String.fromCharCode(0x202f), "-", " la ", "386,102", "28,281,291"]) expect(all.includes(shape), JSON.stringify(shape)).toBe(true);
  });
});

// ══ 12 — the run-time proof beyond the digits ═════════════════════════════

describe("12 the run-time proof holds what the digits cannot", () => {
  it("the structure reader sees a magnitude read as another, a dropped sign, a per-mille made a percentage and a code on another number — each with every digit in place", () => {
    const held = (a: string, b: string) => figureProof.structureHeld(a, b);
    // What the pass writes holds …
    expect(held("de ~EUR 12.3M (din RON 64,567,890)", `de ~12,3${NBSP}mil.${NBSP}EUR (din 64.567.890${NBSP}RON)`)).toBe(true);
    expect(held("este RON -4.58M sau -RON 2.5K", `este -4,58${NBSP}mil.${NBSP}RON sau -2,5${NBSP}mii${NBSP}RON`)).toBe(true);
    expect(held("în 2025 RON 64.5M", `în 2025 64,5${NBSP}mil.${NBSP}RON`)).toBe(true);
    // … and each of these does not (all keep the digit sequence).
    for (const [a, b] of [
      ["de USD 4.58Bn în", "de 4,58 mil. USD în"],
      ["de RON +4.58M față", "de 4,58 mil. RON față"],
      ["este 2.5‰ din", "este 2,5% din"],
      ["de RON 64 567 890 în", "de 64 RON 567 890 în"],
      ["de RON 4.58M în", "de 4,58 mil. EUR în"],
      ["de EUR 1.5-2.5M, în", "de 1,5 EUR-2,5 mil., în"],
    ] as const) {
      expect(digits(a)).toBe(digits(b));
      expect(held(a, b), `${a} → ${b}`).toBe(false);
    }
    // WHAT IT CANNOT SEE: a non-figure re-spelt with nothing moved ("la 3M RON
    // 5.2M" → "la 3 mil. RON 5,2 mil."): the structure is the same. The rule
    // that leaves a code between two numbers alone, and the corpus, hold that.
    expect(held("la 3M RON 5.2M este", "la 3 mil. RON 5,2 mil. este")).toBe(true);
    expect(normaliseFigures("Depozitul la 3M RON 5.2M este stabil.", "ro").text).toBe("Depozitul la 3M RON 5.2M este stabil.");
  });

  it("PLANTED HERE, not in the source: with the proof blinded a rule that loses a sign changes what is shown; with the proof, the text comes back as written", () => {
    const text = "Variația este de RON +2.5M față de buget.";
    expect(plainSpaces(normaliseFigures(text, "ro").text)).toBe("Variația este de +2,5 mil. RON față de buget.");
    // The proof is what refuses a result whose structure differs: blind it and
    // hand it a wrong pair — it is the only thing between a slip and the reader.
    const real = figureProof.structureHeld;
    const spy = vi.spyOn(figureProof, "structureHeld").mockImplementation((a, b) => real(a.replace("+", ""), b.replace("+", "")) && false);
    const refused = normaliseFigures(text, "ro");
    expect(refused).toEqual({ text, rewritten: 0, left: [{ token: text.slice(0, 40), reason: "proof_failed" }] });
    expect(spy).toHaveBeenCalled();
  });
});

// ══ 5 — the grid ══════════════════════════════════════════════════════════

describe("5 the grid: every figure lib/money prints comes out as lib/money's print, or untouched", () => {
  it("984 rows: 864 rewritten to the print byte for byte (joiners included), 120 lone groups byte-identical, 0 anything else", () => {
    const outcomes = { rewritten: 0, single_group: 0 };
    expect(GRID.rows.length).toBe(984);
    for (const [target, written, print, outcome] of GRID.rows) {
      const text = GRID.frames[target].replace("{figure}", written);
      const out = normaliseFigures(text, target);
      if (outcome === "single_group") {
        expect(out.text, text).toBe(text);
        expect(out.left.map((l) => l.reason), text).toEqual(["single_group"]);
      } else {
        expect(outcome).toBe("rewritten");
        expect(out.text, text).toBe(GRID.frames[target].replace("{figure}", print));
        expect(out.left, text).toEqual([]);
        expect(findings(out.text, target), out.text).toEqual([]);
        expect(valuesHeld(text, out.text, target), text).toBeNull();
      }
      expect(digits(out.text)).toBe(digits(text));
      expect(normaliseFigures(out.text, target).text).toBe(out.text);
      // Read in the language it was PRINTED in, the same print loses no digit —
      // and where the code already stands after the figure, nothing moves.
      const native = GRID.frames[other(target)].replace("{figure}", written);
      const nout = normaliseFigures(native, other(target));
      expect(digits(nout.text)).toBe(digits(native));
      if (!/^-?[A-Z]{3} /.test(written)) expect(plainSpaces(nout.text), native).toBe(plainSpaces(native));
      outcomes[outcome] += 1;
    }
    expect(outcomes).toEqual({ rewritten: 864, single_group: 120 });
    WORK.grid = GRID.rows.length;
  });
});

// ══ 6 — the standard ══════════════════════════════════════════════════════

describe("6 the standard is lib/money's", () => {
  const RATES: Rates = { RON: 1, EUR: 1, USD: 1 };
  const money = (v: number, lang: FigureLang, opts: { fractionDigits?: number; compact?: boolean }) =>
    formatMoneyFrom(v, "RON", "RON", RATES, { locale: moneyLocaleFor(lang), ...opts });

  it("FIGURE_STANDARD equals standard.json — the file a law regenerates from lib/money, the ratio printer and the packs on every run", () => {
    expect(FIGURE_STANDARD.codes).toEqual(STANDARD_JSON.codes);
    expect(FIGURE_STANDARD.symbols).toEqual(STANDARD_JSON.symbols);
    expect(FIGURE_STANDARD.languages).toEqual(STANDARD_JSON.languages);
    expect(Object.keys(FIGURE_STANDARD).sort()).toEqual(["codes", "languages", "symbols"]);
  });

  it.each(["ro", "en"] as const)("%s: what lib/money prints NOW is made of the standard's marks, magnitude words and joiners", (lang) => {
    const s = FIGURE_STANDARD.languages[lang];
    expect(s.locale).toBe(moneyLocaleFor(lang));
    expect(money(1234567.89, lang, { fractionDigits: 2 })).toBe(`1${s.group}234${s.group}567${s.decimal}89${s.code_joiner}RON`);
    expect(money(12_300_000, lang, { compact: true })).toBe(`12${s.decimal}3${s.magnitude_joiner}${s.magnitudes.M}${s.code_joiner}RON`);
    expect(money(2_300_000_000, lang, { compact: true })).toBe(`2${s.decimal}3${s.magnitude_joiner}${s.magnitudes.B}${s.code_joiner}RON`);
    // The joiners are U+00A0 — the product's bytes, not a plain space.
    expect(s.code_joiner).toBe(NBSP);
    expect(FIGURE_STANDARD.languages.ro.magnitude_joiner).toBe(NBSP);
    // …and a figure the normaliser MOVES a code behind carries exactly them.
    const moved = normaliseFigures(lang === "ro" ? "Valoarea este de RON 12.3M acum." : "The value is RON 12,3 mil. for this year and the next.", lang).text;
    expect(moved).toContain(money(12_300_000, lang, { compact: true }));
  });
});

// ══ 7 — languages ═════════════════════════════════════════════════════════

/** A narration in each language the product narrates in besides ro / en —
 *  with figures the pass would rewrite if it read the text as Romanian or
 *  English. Invented figures. */
const OTHER_LANGUAGE_TEXTS: Record<string, string[]> = {
  de: [
    "Der Umsatz betrug 64.567.890 RON und die EBITDA-Marge lag bei 11,85 %. Das Unternehmen ist nicht verschuldet.",
    "Umsatz RON 64,567,890, EBITDA ~EUR 12.3M (Marge 11.25%), Verschuldung 1.19x, 45.5 Tage.",
  ],
  fr: ["Le chiffre d'affaires est de 64 567 890 RON et la marge d'EBITDA est de 11,85 %. La société est peu endettée, avec EUR 12.3M de dette."],
  es: [
    "La cifra de negocios fue de 64.567.890 RON y el margen EBITDA del 11,85 %. La empresa no está endeudada.",
    "Si la empresa mantiene el margen, con una deuda de 1.19x, no hay riesgo para este año.",
    // "este" and "dar" are everyday Spanish (review 2026-10-05): read as
    // Romanian, "12,3M" became "12,3 mil." — twelve THOUSAND in Spanish.
    "Este ejercicio la empresa registró ingresos de 12,3M EUR y un EBITDA de 2,1M EUR, lo que puede dar lugar a una mejora del margen.",
    "Este año el margen puede dar un resultado de 918K EUR, que este trimestre se suma a los 4.58M RON.",
  ],
  it: [
    "Il fatturato è stato di 64.567.890 RON e il margine EBITDA dell'11,85%. La società non si è indebitata, ma si è rafforzata.",
    "La liquidità è 1.16 e si è ridotta; il debito si è ridotto a EUR 12.3M e non si è più rifinanziato.",
  ],
  pt: [
    "O volume de negócios foi de 64.567.890 RON e a margem EBITDA de 11,85%. A empresa não está endividada.",
    "A empresa tem dívida de 1.19x e, com este nível, não há risco para o ano.",
    "Este exercício a empresa vai dar um resultado de 918K EUR, e este valor pode dar origem a 12,3M EUR de receitas.",
  ],
  nl: ["De omzet bedroeg 64.567.890 RON en de EBITDA-marge was 11,85%. Het bedrijf heeft weinig schulden, EUR 12.3M."],
  pl: ["Przychody wyniosły 64 567 890 RON, a marża EBITDA 11,85%. Firma nie jest zadłużona; dług to EUR 12.3M."],
};

describe("7 the language is the TEXT's — on positive evidence, never the UI's", () => {
  it.each(Object.keys(OTHER_LANGUAGE_TEXTS))("%s: a narration in another language is not changed by a byte", (code) => {
    for (const text of OTHER_LANGUAGE_TEXTS[code]) {
      expect(proseLanguageOf(text), text).toBeNull();
      expect(displayModelText(text), text).toEqual({ text, lang: null, rewritten: 0, left: [{ token: "", reason: "language_unknown" }] });
      // …also as a chat reply to a question in the same language.
      expect(displayModelText(text, { context: [text] }).text).toBe(text);
      // POSITIVE CONTROL: read as Romanian or English, the pass WOULD rewrite it.
      expect([normaliseFigures(text, "ro").rewritten, normaliseFigures(text, "en").rewritten].some((n) => n > 0), text).toBe(true);
    }
  });

  it("a text too short to tell is not touched on its own; it takes the language of the question it answers, then of an earlier turn, then one the caller KNOWS", () => {
    const short = "EBITDA: 4.58M RON.";
    expect(proseLanguageOf(short)).toBeNull();
    expect(displayModelText(short).text).toBe(short);
    const roQuestion = "Care este EBITDA și cum se compară cu anul trecut?";
    const enQuestion = "What is the EBITDA and how does it compare with the prior year?";
    expect(plainSpaces(displayModelText(short, { context: [roQuestion] }).text)).toBe("EBITDA: 4,58 mil. RON.");
    expect(displayModelText(short, { context: [enQuestion] })).toMatchObject({ text: short, lang: "en" });
    expect(displayModelText(short, { context: ["EBITDA?"] }).text).toBe(short);
    // nearest first: the question wins over an older turn in the other language
    expect(figureLanguageOf(short, ["EBITDA?", enQuestion, roQuestion])).toBe("en");
    expect(figureLanguageOf(short, [roQuestion, enQuestion])).toBe("ro");
    expect(figureLanguageOf(short, ["EBITDA?"], "ro")).toBe("ro");
    // the text's OWN prose, when it is strong evidence, beats everything a caller says
    expect(figureLanguageOf("The EBITDA for the year is 4.58M RON and the margin is 11.25%.", [roQuestion], "ro")).toBe("en");
    // a context entry that says "ro" is a TEXT, not a language: it reads as nothing
    expect(figureLanguageOf(short, ["ro"])).toBeNull();
    expect(figureLanguageOf(short, ["en"])).toBeNull();
  });

  it("no word Spanish, Portuguese or Italian shares makes a text Romanian — in any number", () => {
    for (const w of ["este", "dar", "care", "cu", "sau", "din"]) {
      expect(RO_FUNCTION_WORDS.has(w), w).toBe(true);
      expect(RO_DISTINCTIVE_WORDS.has(w), w).toBe(false);
    }
    for (const w of RO_DISTINCTIVE_WORDS) expect(RO_FUNCTION_WORDS.has(w), w).toBe(true);
    expect(proseLanguageOf("Este este este dar dar care care cu sau din 12,3M EUR")).toBeNull();
    // …and ONE word of Romanian's own beside them does.
    expect(proseLanguageOf("Marja este bună, dar datoria este mare pentru 12.3M EUR")).toBe("ro");
    // Romanian without diacritics and without such a word: not read on its own — the question decides.
    const bare = "Marja este buna dar datoria este mare, 12.3M EUR";
    expect(proseLanguageOf(bare)).toBeNull();
    expect(displayModelText(bare).text).toBe(bare);
    expect(plainSpaces(displayModelText(bare, { context: ["Care este marja și cum se compară cu anul trecut?"] }).text)).toBe("Marja este buna dar datoria este mare, 12,3 mil. EUR");
  });

  it("a correct Romanian reply written as labels, with one English gloss, is NOT read as English: its right figures stay right", () => {
    const roQuestion = "Care este situația firmei și cum se compară cu anul trecut?";
    const enQuestion = "What is the position of the company and how does it compare with the prior year?";
    for (const reply of [
      "- Cifra de afaceri: 64.567.890 RON\n- EBITDA: 7.654.321 RON\n- Marjă: 11,85%\n- Free cash flow from the operations: 2.345.678 RON",
      "- Marjă: 11,85%\n- EBITDA (earnings before interest, taxes, depreciation and amortization for the year): 7.654.321 RON",
      "Sursă: \"The company has reported revenue for the year with this definition and that is the total\".\n- Cifră de afaceri: 64.567.890 RON\n- Marjă: 11,85%",
    ]) {
      // POSITIVE CONTROL: read as English, every figure of it WOULD be rewritten.
      expect(normaliseFigures(reply, "en").rewritten, reply).toBeGreaterThanOrEqual(2);
      expect(proseLanguageOf(reply), reply).toBeNull();
      // The question it answers is Romanian: untouched (the words lean English, the letters and the question say Romanian).
      expect(displayModelText(reply, { context: [roQuestion] }).text, reply).toBe(reply);
      // No context at all, and a caller that KNOWS Romanian: untouched.
      expect(displayModelText(reply).text, reply).toBe(reply);
      expect(displayModelText(reply, { fallback: "ro" }).text, reply).toBe(reply);
      // Only where the question itself is English is such a text read as English.
      expect(displayModelText(reply, { context: [enQuestion] }).lang, reply).toBe("en");
    }
  });

  it("thin evidence of a text's own language is followed only where the caller does not say otherwise; strong evidence wins", () => {
    const roQuestion = "Care este situația firmei și cum se compară cu anul trecut?";
    const enQuestion = "What is the position of the company and how does it compare with the prior year?";
    // Two function words: thin.
    const thinRo = "EBITDA: 4.58M RON pentru anul în curs.";
    expect(proseLanguageOf(thinRo)).toBe("ro");
    expect(figureLanguageOf(thinRo)).toBe("ro");
    expect(figureLanguageOf(thinRo, [roQuestion])).toBe("ro");
    expect(figureLanguageOf(thinRo, [enQuestion])).toBeNull();
    expect(figureLanguageOf(thinRo, [], "en")).toBeNull();
    const thinEn = "EBITDA: 4,58 mil. RON for the year.";
    expect(proseLanguageOf(thinEn)).toBe("en");
    expect(figureLanguageOf(thinEn, [enQuestion])).toBe("en");
    expect(figureLanguageOf(thinEn, [roQuestion])).toBeNull();
    expect(displayModelText(thinEn, { context: [roQuestion] }).text).toBe(thinEn);
    // Four or more: the text's own prose beats what any caller says.
    const strongEn = "The EBITDA for the year is 4,58 mil. RON and the margin is 11,25% with this definition.";
    expect(figureLanguageOf(strongEn, [roQuestion], "ro")).toBe("en");
    const strongRo = "EBITDA pentru anul acesta este 4.58M RON, iar marja este 11.25% și este în creștere.";
    expect(figureLanguageOf(strongRo, [enQuestion], "en")).toBe("ro");
  });

  it("an English answer that quotes Romanian terms is English where the question is; a Romanian one that quotes English terms is Romanian; a mixed one is nothing", () => {
    const english = "The cifra de afaceri netă for the year is RON 64,567,890, and the variația stocurilor is inside EBITDA with this definition.";
    const enQuestion = "What is the position of the company and how does it compare with the prior year?";
    // Its words are English, its letters hold ă and ț: undecided on its own, English with an English question.
    expect(proseLanguageOf(english)).toBeNull();
    expect(displayModelText(english).text).toBe(english);
    expect(plainSpaces(displayModelText(english, { context: [enQuestion] }).text)).toBe("The cifra de afaceri netă for the year is 64,567,890 RON, and the variația stocurilor is inside EBITDA with this definition.");
    // …and where the question is ROMANIAN it is not touched: its words lean English, the question says
    // Romanian — reading it as Romanian would re-spell an English sentence's figures.
    const roAsked = "Care este situația firmei și cum se compară cu anul trecut?";
    expect(displayModelText(english, { context: [roAsked] })).toMatchObject({ text: english, lang: null });
    expect(displayModelText(english, { fallback: "ro" }).text).toBe(english);
    // POSITIVE CONTROL: read as Romanian, the pass WOULD move the code and swap the groups.
    expect(normaliseFigures(english, "ro").text).not.toBe(english);
    // The same answer without the Romanian letters reads English by itself.
    expect(proseLanguageOf("The cifra de afaceri for the year is RON 64,567,890, and the stock variation is inside EBITDA with this definition.")).toBe("en");
    // One Romanian word is not evidence ("este" and "care" exist in other languages too).
    expect(proseLanguageOf("The cifra de afaceri netă (net turnover) is RON 64,567,890; Variația stocurilor is inside EBITDA.")).not.toBe("ro");
    const romanian = "Indicatorul net debt / EBITDA este 1.19x, iar working capital este în creștere față de anul trecut.";
    expect(proseLanguageOf(romanian)).toBe("ro");
    expect(proseLanguageOf("Revenue is 5M RON. Cifra de afaceri este 5M RON.")).toBeNull();
    // Romanian without diacritics still reads, on its function words.
    expect(proseLanguageOf("Lichiditatea curenta este 1.16 iar firma este in zona sigura pentru anul acesta, cu datorii mici.")).toBe("ro");
    // The detector's two word lists share no word.
    for (const w of RO_FUNCTION_WORDS) expect(EN_FUNCTION_WORDS.has(w), w).toBe(false);
  });

  it("the UI language decides nothing: a Romanian interface, an English conversation — and the reverse", async () => {
    const enQuestion = "What is the EBITDA and how does it compare with the prior year?";
    const roQuestion = "Care este EBITDA și cum se compară cu anul trecut?";
    const english = "The EBITDA for the year is RON 18,778,901 and the margin is 11.25%.";
    const romanian = "EBITDA pentru anul acesta este RON 18,778,901, iar marja este 11.25%.";
    for (const ui of ["ro", "en"] as const) {
      await i18n.changeLanguage(ui);
      expect(i18n.language).toBe(ui);
      expect(plainSpaces(displayModelText(english).text), ui).toBe("The EBITDA for the year is 18,778,901 RON and the margin is 11.25%.");
      expect(plainSpaces(displayModelText(romanian).text), ui).toBe("EBITDA pentru anul acesta este 18.778.901 RON, iar marja este 11,25%.");
      expect(displayModelText("EBITDA: 4.58M RON.").text, ui).toBe("EBITDA: 4.58M RON.");
      expect(displayModelText("EBITDA: 4.58M RON.", { context: [enQuestion] }).lang, ui).toBe("en");
      expect(displayModelText("EBITDA: 4.58M RON.", { context: [roQuestion] }).lang, ui).toBe("ro");
    }
  });

  it("languageHints: each turn is handed the language of the nearest EARLIER turn that reads; a turn that is nobody's prose gives none", () => {
    const ro = "Care este EBITDA și cum se compară cu anul trecut?";
    const en = "What is the EBITDA and how does it compare with the prior year?";
    expect(languageHints([ro, "EBITDA: 4.58M RON.", en, "ok", null, "EBITDA?"])).toEqual([null, "ro", "ro", "en", "en", "en"]);
    expect(languageHints([null, undefined, "", "12.5%"])).toEqual([null, null, null, null]);
    expect(languageHints([])).toEqual([]);
  });

  it("leftByReason: counts only — what a surface may log holds no token", () => {
    const out = normaliseFigures("Numerar RON 162,365, raport 1.42, vezi art. 7.25 și 1.5 aici.", "ro");
    const counts = leftByReason(out.left);
    expect(counts).toEqual({ single_group: 1, bare_decimal: 2, reference: 1 });
    expect(out.text.startsWith("Numerar RON 162,365")).toBe(true); // (a single group and nothing rewritten: no hold)
    expect(JSON.stringify(counts)).not.toMatch(/\d{2}/);
  });
});

// ══ 8 — what is not a figure ══════════════════════════════════════════════

const NOT_FIGURES_RO = [
  "Anul fiscal s-a încheiat la 31.12.2025 și raportul este din 2026-03-25.",
  "Plata este scadentă la 25.03, iar ședința este la ora 14.30 sau la 14:30.",
  "Factura din 25/03/2026 este achitată.",
  "Vezi secțiunea 3.2, art. 7.1 și alin. 2.5 din contract.",
  "Conform IAS 16.31 și IFRS 15.47, tratamentul este corect.",
  "Conturile 401,404,408 sunt conturi de furnizori.",
  "Formula este în celula $B$2 și în foaia Sheet1!$C$12.",
  "Dobânda este ROBOR 3M plus o marjă, iar pentru euro EURIBOR 6M.",
  "Bugetul EUR 2025 este aprobat, iar cel RON 2026 este în lucru.",
  "Cursul EUR/RON 4.97 este cel de închidere.",
  "Datoria în dolari canadieni este C$ 5 și cea americană US$ 5.",
  "Rulează `RON 4.58M` sau `1,234.56` în consolă.",
  "Detalii la https://example.test/a?v=1.5&x=2,345.67 pentru versiunea v2.1.",
  "Scrie {{money:net_turnover}} și {fact_1.5} exact așa.",
  "Trimite la conta.1.5@example.test până mâine.",
  "2.1 Lichiditate\n2.2 Îndatorare",
  "Codul 007.5 și numărul 01.02 sunt identificatori.",
  "Cantitatea este de 1.5T pe lună.",
];
const NOT_FIGURES_EN = [
  "The fiscal year ended on 31.12.2025 and the report is dated 2026-03-25.",
  "See section 3,2 and note 7,1 for the detail of this account.",
  "The formula is in cell $B$2 and the tenor is EURIBOR 6M for this loan.",
  "Run `1.234,56 RON` and see https://example.test/a?v=1,5 for the detail.",
  "The EUR 2025 budget is approved and the meeting is at 14:30 for the board.",
];

describe("8 what is not a figure is not touched", () => {
  it.each(NOT_FIGURES_RO.map((t) => [t] as const))("ro: %s", (text) => {
    expect(normaliseFigures(text, "ro").text).toBe(text);
    expect(normaliseFigures(text, "ro").rewritten).toBe(0);
  });
  it.each(NOT_FIGURES_EN.map((t) => [t] as const))("en: %s", (text) => {
    expect(normaliseFigures(text, "en").text).toBe(text);
  });

  it("POSITIVE CONTROL: the same sentences WITH a figure beside the non-figure — the figure is rewritten, the non-figure stays", () => {
    const run = (t: string) => plainSpaces(normaliseFigures(t, "ro").text);
    expect(run("La 31.12.2025 cifra de afaceri era RON 64,567,890 (vezi art. 7.1).")).toBe("La 31.12.2025 cifra de afaceri era 64.567.890 RON (vezi art. 7.1).");
    expect(run("Dobânda este ROBOR 3M + 2.5%, pe un credit de EUR 1.2M.")).toBe("Dobânda este ROBOR 3M + 2,5%, pe un credit de 1,2 mil. EUR.");
    expect(run("Cursul EUR/RON 4.97 dă ~EUR 12.3M; vezi `RON 4.58M`.")).toBe("Cursul EUR/RON 4.97 dă ~12,3 mil. EUR; vezi `RON 4.58M`.");
    // A foreign dollar keeps its symbol: only the number beside it follows the language.
    expect(run("Datoria este US$ 4.5M, adică $ 4.5M.")).toBe("Datoria este US$ 4,5 mil., adică 4,5 mil. USD.");
    // "lei" is evidence of a quantity and is never rewritten itself.
    expect(run("Numerarul este de 1,234,567.89 lei.")).toBe("Numerarul este de 1.234.567,89 lei.");
  });

  it("no separator is ever inserted into a plain integer, and no sign changes", () => {
    for (const text of [
      "Cifra de afaceri este 64567890 RON și profitul 1234567 RON.",
      "Pierderea este de -1234567 RON, adică −1234567 RON.",
    ]) expect(normaliseFigures(text, "ro").text).toBe(text);
    const signed = normaliseFigures("Pierderea este -RON 2,577,640.82, adică RON -4.58M sau −EUR 1.2M.", "ro").text;
    expect(plainSpaces(signed)).toBe("Pierderea este -2.577.640,82 RON, adică -4,58 mil. RON sau −1,2 mil. EUR.");
  });
});

// ══ the snapshot's figures as evidence ════════════════════════════════════

describe("anchorsOfSnapshot: the en-US figures above the three prose sections — never a number of a briefing, a recommendation or an alert", () => {
  const SNAPSHOT = [
    "Period: FY2025 (period ending 2025-12-31)",
    "Company: Invented SRL",
    "  · current_ratio: 1.16 ratio",
    "  · Net turnover: 110,798,309.14",
    "  · DSO: 28.05 days",
    "  · accounts 7411 and 2025",
    "",
    "Prior engine-generated briefing:",
    "Lichiditatea curentă este 1,16 și scorul 3,12; la 31.12.2025 soldul 5.000 RON și 9,876.50.",
    "",
    "Recommendations on file:",
    "  · [high] Reduce DSO to 25.5 days",
    "",
    "Alerts on file:",
    "  · [critical] Cash ratio 0.08",
  ].join("\n");

  it("reads the figures the model was handed, skips dates and bare integers, and stops at the first prose section", () => {
    expect(anchorsOfSnapshot(SNAPSHOT)).toEqual([1.16, 110798309.14, 28.05]);
    // POSITIVE CONTROL: with the briefing's heading renamed the cut falls one
    // section later — and the briefing's own numbers ARE read (which is why
    // the three headings are held to the snapshot builder by the chat's gate).
    expect(anchorsOfSnapshot(SNAPSHOT.replace("Prior engine-generated briefing:", "Prior briefing:"))).toEqual([1.16, 110798309.14, 28.05, 5, 9876.5]);
    for (const nothing of [undefined, null, "", "Period: FY2025"]) expect(anchorsOfSnapshot(nothing)).toEqual([]);
  });
});

// ══ 9 — the source ════════════════════════════════════════════════════════

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mts|js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}
const isTest = (p: string) => /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[tj]sx?$/.test(p) || p.startsWith("frontend/test/");

describe("9 the source", () => {
  const SOURCE = readFileSync(resolve(REPO, "frontend/lib/readerFigures.ts"), "utf-8");
  const code = SOURCE.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n");

  it("no lookbehind — an old iOS WebView throws at PARSE time on one, and the mobile shell is a WebView", () => {
    expect(SOURCE).not.toMatch(/\(\?<[=!]/);
    // POSITIVE CONTROL: the pattern sees one (the detector's own file uses them — it never ships).
    expect(readFileSync(resolve(REPO, "frontend/test/numberLanguage.ts"), "utf-8")).toMatch(/\(\?<[=!]/);
  });

  it("pure: it imports nothing and reads no locale, clock, storage or UI language", () => {
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\(/);
    for (const banned of ["Intl.", "toLocaleString", "Date.", "new Date", "localStorage", "sessionStorage", "navigator", "document.", "window.", "i18n", "fetch("]) {
      expect(code.includes(banned), banned).toBe(false);
    }
  });

  it("no invisible character: a joiner is written as an escape, never typed", () => {
    for (const cp of [0xa0, 0x202f, 0x2028, 0x2029, 0xfeff, 0x200b]) expect(SOURCE.includes(String.fromCharCode(cp)), cp.toString(16)).toBe(false);
  });

  it("imported by exactly five files — the chat's three, Explain and the briefing card; never the command bar, never lib/cfoApi", () => {
    const importers = [...sourceFiles(resolve(REPO, "frontend")), ...sourceFiles(resolve(REPO, "supabase/functions")), ...sourceFiles(resolve(REPO, "mobile/src"))]
      .map((p) => relative(REPO, p))
      .filter((p) => !isTest(p) && p !== "frontend/lib/readerFigures.ts")
      .filter((p) => /readerFigures/.test(readFileSync(resolve(REPO, p), "utf-8")))
      .sort();
    expect(importers).toEqual([
      "frontend/components/cfo/CFOBriefingCard.tsx",
      "frontend/components/cfo/chat/CFOMessageBubble.tsx",
      "frontend/components/cfo/chat/CFOMessageList.tsx",
      "frontend/components/cfo/chat/chatTurns.ts",
      "frontend/lib/explain.ts",
    ]);
    // The scan itself: it reads the command bar's folder and the chokepoint.
    const scanned = sourceFiles(resolve(REPO, "frontend")).map((p) => relative(REPO, p));
    expect(scanned).toContain("frontend/components/instrument/shell/capsuleAnswer/capsuleAnswerClient.ts");
    expect(scanned).toContain("frontend/components/instrument/shell/capsuleAnswer/capsuleAnswerGuard.ts");
    expect(scanned).toContain("frontend/lib/cfoApi.ts");
    expect(scanned.length).toBeGreaterThan(900);
  });
});

describe("the canary", () => {
  it("what this file did", () => {
    expect(WORK.corpus).toBe(CORPUS.length);
    expect(WORK.grid).toBe(984);
    expect(WORK.kept).toBe(CORPUS.reduce((n, c) => n + c.kept.length, 0));
    expect(WORK.composed).toBe(12000);
    // eslint-disable-next-line no-console
    console.log(`GATE-WORK ai-figures corpus=${WORK.corpus} grid=${WORK.grid} kept=${WORK.kept} composed=${WORK.composed}`);
  });
});
