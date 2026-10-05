// ONE FIGURE STANDARD, THREE RUNTIMES (owner order 2026-10-04: "make chat
// and briefings write numbers in Romanian format in Romanian text
// (413.727.560 RON, ~77,4 mil. EUR), currency after the figure. Use the
// product's own formatting standard, with a gate.")
//
// The product's formatter — frontend/lib/money through moneyLocaleFor, and
// the ratio table's printer for a percentage and a multiple — is the ONE
// authority for what a figure looks like. Two other runtimes have to say the
// same thing and can import neither:
//
//   · the chat Edge Function (supabase/functions/chat-llm/prompt.ts) TEACHES
//     the format: its figure-format rule and its conversion note carry
//     example strings;
//   · the engine (src/engine/ai/figure_format.py) tells the briefing's model
//     the format and normalises what it wrote — it has no formatter at all,
//     only marks, magnitude words and example strings.
//
// So this file RUNS the product's formatter and holds each copy to it:
//
//   1. every example string in the function's prompt is the product's print
//      of FIGURE_FORMAT_VALUES — none is typed on one side only;
//   2. tests/engine/fixtures/ai_figures/standard.json (the marks, the
//      magnitude words, the joiners, the codes and the engine's hint
//      examples) and grid.json (a figure as lib/money prints it in one
//      language → the other language's print) are REGENERATED here on every
//      run and compared with the committed bytes. The engine's gate
//      (tests/engine/test_ai_figure_format.py) holds its constants to
//      standard.json and runs its normaliser over grid.json; the browser's
//      normaliser is held to the same two files by its own law.
//      To re-write them after a deliberate change of the standard:
//        AI_FIGURES_WRITE=1 npx vitest run --root . frontend/lib/__tests__/chatLlmFigureFormat.test.ts
//   3. the prompt the chat really receives holds no figure of the wrong
//      language in either language's bullet and no currency before a digit —
//      read by the repository's INDEPENDENT number-shape detector
//      (frontend/test/numberLanguage.ts), never by the printer that made the
//      strings (CLAUDE.md: "never compare a printed figure only against the
//      same printer");
//   4. the rule rides ONLY where a display currency is sent — Ask CFO AI. The
//      command bar's and Explain's real requests carry none, so their prompt
//      holds no digit example (the command bar's contract is "write NO
//      digits").
//
// WHAT IT REDS ON (TC-11): an example retyped in prompt.ts; lib/money or the
// ratio printer changing what it prints (the fixtures then differ from the
// committed bytes — re-write them, and the engine's gate reds until its
// constants follow); a magnitude word differing from the packs'
// money_display; the old "~EUR 918k (converted from RON 4.58M …)" shape, or
// "USD 1,000", coming back into a prompt; the rule moved into a persona (the
// command bar would then be handed digit examples).
//
// WHAT IT CANNOT SEE: what a model WRITES under the prompt (the rendered
// reply is held by the normaliser's own gates, with no model in the loop);
// the deployed function's source (the coordinator diffs the download).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { currencyLabel, formatMoneyFrom, moneyLocaleFor } from "@/lib/money";
import { formatRatioSide } from "@/lib/ratioTable";
import type { Currency, Rates } from "@/lib/rates";
import {
  CURRENCY_BEFORE_FIGURE,
  foreignNumber,
  foreignNumbersInProse,
  maskNotProse,
  plainSpaces,
} from "@/test/numberLanguage";
import {
  FIGURE_FORMAT_EXAMPLES,
  FIGURE_FORMAT_SECTION,
  FIGURE_FORMAT_VALUES,
  buildCurrencyDirective,
  buildSystemPrompt,
  conversionExample,
  type LlmChatRequest,
} from "../../../supabase/functions/chat-llm/prompt";

const REPO = resolve(__dirname, "../../..");
const FIXTURES = resolve(REPO, "tests/engine/fixtures/ai_figures");
const WRITE = process.env.AI_FIGURES_WRITE === "1";

type Lang = "ro" | "en";
const LANGS: Lang[] = ["ro", "en"];
/** No conversion anywhere below: every figure is printed in its own currency.
 *  The keys ARE the product's currencies (the type refuses any other set). */
const RATES: Rates = { RON: 1, EUR: 1, USD: 1 };
const CODES = Object.keys(RATES) as Currency[];

/** The product's print of an amount in RON, in `lang`. */
function money(value: number, lang: Lang, opts: { fractionDigits?: number; compact?: boolean } = {}, code: Currency = "RON"): string {
  return formatMoneyFrom(value, code, code, RATES, { locale: moneyLocaleFor(lang), ...opts });
}
/** …and the figure alone (the trailing joiner + code removed, bytes kept). */
function figure(printed: string, code: Currency = "RON"): string {
  const m = new RegExp(`^(.*\\S)[\\s\\u00a0]${code}$`).exec(printed);
  if (!m) throw new Error(`lib/money did not print the code after the figure: ${JSON.stringify(printed)}`);
  return m[1];
}
const ratio = (value_q: string, unit: "pct" | "x", lang: Lang) => formatRatioSide({ value_q } as never, unit as never, lang);

// ── 1. the function's examples ARE the product's prints ───────────────────

describe("the chat function's example figures are the product's own prints", () => {
  it.each(LANGS)("%s: every example string, from lib/money and the ratio printer", (lang) => {
    const v = FIGURE_FORMAT_VALUES;
    const printed = {
      whole: plainSpaces(figure(money(v.whole, lang, { fractionDigits: 0 }))),
      decimals: plainSpaces(figure(money(v.decimals, lang, { fractionDigits: 2 }))),
      compact: plainSpaces(figure(money(v.compact, lang, { compact: true }))),
      percent: plainSpaces(ratio(v.percent, "pct", lang)),
      multiple: plainSpaces(ratio(v.multiple, "x", lang)),
      // A rate is a bare decimal: the same marks at four places.
      rate: new Intl.NumberFormat(moneyLocaleFor(lang), { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(Number(v.rate)),
    };
    expect(printed).toEqual(FIGURE_FORMAT_EXAMPLES[lang]);
    // …and each one is IN the rule the model reads.
    for (const s of Object.values(FIGURE_FORMAT_EXAMPLES[lang])) expect(FIGURE_FORMAT_SECTION, s).toContain(s);
  });

  it("the rule's bullets and the conversion note: each language's line holds no figure of the other language, and the code is after the figure", () => {
    const lines = FIGURE_FORMAT_SECTION.split("\n");
    const ro = lines.filter((l) => l.includes("Romanian text —"));
    const en = lines.filter((l) => l.includes("English text —"));
    expect([ro.length, en.length]).toEqual([1, 1]);
    expect(foreignNumbersInProse(ro[0], "ro")).toEqual([]);
    expect(foreignNumbersInProse(en[0], "en")).toEqual([]);
    // POSITIVE CONTROL: the detector does read these lines — each is foreign to the other language.
    expect(foreignNumbersInProse(ro[0], "en").length).toBeGreaterThan(3);
    expect(foreignNumbersInProse(en[0], "ro").length).toBeGreaterThan(3);
    expect(CURRENCY_BEFORE_FIGURE.test(FIGURE_FORMAT_SECTION)).toBe(false);

    const note = conversionExample("EUR", "RON", "BNR");
    const [roNote, enNote] = note.split("; English text: ");
    expect(roNote).toBe(`Romanian text: "~${FIGURE_FORMAT_EXAMPLES.ro.compact} EUR (convertit din ${FIGURE_FORMAT_EXAMPLES.ro.whole} RON la cursul BNR)"`);
    expect(enNote).toBe(`"~${FIGURE_FORMAT_EXAMPLES.en.compact} EUR (converted from ${FIGURE_FORMAT_EXAMPLES.en.whole} RON at the BNR rate)"`);
    expect(foreignNumbersInProse(roNote, "ro")).toEqual([]);
    expect(foreignNumbersInProse(enNote, "en")).toEqual([]);
    expect(CURRENCY_BEFORE_FIGURE.test(note)).toBe(false);
    // The amount the rule tells the model NOT to write is the lone group of
    // the same example — cut out of it, not typed beside it.
    const lone = FIGURE_FORMAT_EXAMPLES.ro.decimals.split(",")[0];
    expect(lone).toMatch(/^\d{1,3}\.\d{3}$/);
    expect(FIGURE_FORMAT_SECTION).toContain(`(${FIGURE_FORMAT_EXAMPLES.ro.decimals} RON, not ${lone} RON)`);
    expect(foreignNumber(`${lone} RON`, "ro")).toBeNull(); // …the shape no detector can call wrong: hence the rule
  });
});

// ── the detector itself ──────────────────────────────────────────────────

describe("the prose detector every law of this lane reads with", () => {
  it("POSITIVE CONTROL: it sees the shapes the base patterns cannot — a short decimal that ends a sentence, a decimal of three or more places, a lower-case magnitude, a currency before the figure", () => {
    // The base pattern's two measured blind spots …
    expect(foreignNumber("iar Z este 2.87.", "ro")).toBeNull();
    expect(foreignNumber("la cursul BNR 0.1905", "ro")).toBeNull();
    // … seen (each pattern starts at ONE digit, so a hit is the tail of the figure).
    expect(foreignNumbersInProse("iar Z este 2.87.", "ro")).toEqual(["2.87"]);
    expect(foreignNumbersInProse("la cursul BNR 0.1905", "ro")).toEqual(["0.1905"]);
    expect(foreignNumbersInProse("creanțe de 918k EUR", "ro")).toEqual(["8k EUR"]);
    expect(foreignNumbersInProse("the score is 2,87.", "en")).toEqual(["2,87"]);
    expect(foreignNumbersInProse("at a rate of 0,1905", "en")).toEqual(["0,1905"]);
    for (const before of ["EUR 12", "RON -4", "~USD 1", "€12", "$391"]) expect(CURRENCY_BEFORE_FIGURE.test(`de ${before}`), before).toBe(true);
    // A pair, a foreign dollar, a spreadsheet reference, a longer word, a code after the figure, another currency: not this standard's to name.
    for (const not of ["EUR/RON 4,97", "US$ 5", "$B$2", "EURO 5", "12 EUR", "TRY 3"]) expect(CURRENCY_BEFORE_FIGURE.test(`de ${not}`), not).toBe(false);
  });

  it("a date, a clock time, a URL and a code span are not prose — and a lone three-digit group is matched by nothing", () => {
    expect(foreignNumbersInProse("La 31.12.2025, ora 12:30, vezi `RON 4.58M` și https://example.test/a?v=1.5", "ro")).toEqual([]);
    // …blanked, at the same length (an index into the mask is an index into the text).
    expect(maskNotProse("vezi `RON 4.58M` acum")).toBe("vezi " + " ".repeat("`RON 4.58M`".length) + " acum");
    expect(foreignNumbersInProse("162,365 RON sau 162.365 RON", "ro")).toEqual([]);
    expect(foreignNumbersInProse("162,365 RON or 162.365 RON", "en")).toEqual([]);
  });
});

// ── 3 + 4. the prompt the chat really receives ────────────────────────────

const q = [{ role: "user" as const, content: "q" }];
const FX = { source_currency: "RON", display_currency: "EUR", rate: 0.2011, rate_date: "2026-10-02", provider: "BNR" };
/** What frontend/components/cfo/chat/chatTurns.ts sends: always a display currency and the FX context. */
const CHAT_EUR: LlmChatRequest = { messages: q, mode: "workspace", page: "Ask CFO AI", company_name: "Invented SRL", dataset_summary: "Period: FY2025", display_currency: "EUR", fx_context: FX };
const CHAT_RON: LlmChatRequest = { ...CHAT_EUR, display_currency: "RON", fx_context: { ...FX, display_currency: "RON", rate: 1 } };
const CHAT_TICKER: LlmChatRequest = {
  ...CHAT_EUR,
  public_company: {
    ticker: "ZZZZ", company_name: "Invented Corp.", source: "demo", revenue: 1234567, ebitda: 300000, net_income: 200000, total_assets: 5000000,
    total_equity: 2000000, cash: 400000, net_debt: 100000, free_cash_flow: 250000, market_cap: 9000000, enterprise_value: 9100000,
  },
};
/** The command bar's request (capsuleAnswerClient.ts: display currency and FX "DELIBERATELY not sent") and Explain's (lib/explain.ts). */
const CAPSULE: LlmChatRequest = { messages: q, mode: "workspace", page: "Command bar", company_name: "Invented SRL", dataset_summary: "Periods in scope: FY2025\nRetrieved facts: net_turnover" };
const EXPLAIN: LlmChatRequest = { messages: q, mode: "workspace", page: "panel-margins", company_name: "Invented SRL" };
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
/** A built prompt without the snapshot the frontend supplied (its figures are the frontend's to print). */
const withoutSnapshot = (p: string) => p.replace(/=== (?:Active workspace|Current portfolio) snapshot ===[\s\S]*?=== End snapshot ===/, "");

describe("the figure-format rule in the prompt the model is sent", () => {
  it.each([["converted (EUR over RON)", CHAT_EUR], ["display = stored (RON)", CHAT_RON], ["with a public company", CHAT_TICKER]] as const)(
    "Ask CFO AI, %s: the rule is there once, inside the display-currency rule, in both personas",
    (_name, req) => {
      for (const mode of ["workspace", "inventory"]) {
        const p = buildSystemPrompt({ ...req, mode });
        expect(count(p, FIGURE_FORMAT_SECTION)).toBe(1);
        const rule = p.slice(p.indexOf("=== Display-currency rule ==="), p.indexOf("=== End rule ==="));
        expect(rule).toContain(FIGURE_FORMAT_SECTION);
        expect(p).toContain(FIGURE_FORMAT_SECTION + "=== End rule ===\n");
      }
    },
  );

  it("the command bar's and Explain's real requests carry no display currency: their prompt holds no figure-format rule and no digit example", () => {
    for (const req of [CAPSULE, EXPLAIN]) {
      const p = buildSystemPrompt(req);
      expect(p).not.toContain("Figure format");
      expect(p).not.toContain("Display-currency rule");
      for (const s of [...Object.values(FIGURE_FORMAT_EXAMPLES.ro), ...Object.values(FIGURE_FORMAT_EXAMPLES.en)]) expect(p, s).not.toContain(s);
    }
    expect(buildCurrencyDirective(null, null)).toBe("");
    expect(buildCurrencyDirective(undefined, undefined)).toBe("");
  });

  it("no built prompt holds a currency before a digit — not the conversion note, not the public-company block", () => {
    for (const req of [CHAT_EUR, CHAT_RON, CHAT_TICKER, CAPSULE, EXPLAIN]) {
      for (const mode of ["workspace", "inventory"]) {
        const p = withoutSnapshot(buildSystemPrompt({ ...req, mode }));
        expect(CURRENCY_BEFORE_FIGURE.exec(maskNotProse(p))?.[0] ?? null).toBeNull();
      }
    }
    const ticker = buildSystemPrompt(CHAT_TICKER);
    expect(ticker).toContain("  · Revenue          1,234,567 USD");
    // The shape the old prompt taught — and the chat printed in production on 2026-10-04.
    expect(buildSystemPrompt(CHAT_EUR)).not.toMatch(/~EUR 918k|RON 4\.58M|e\.g\. "~/);
    // POSITIVE CONTROL: the detector sees that shape.
    expect(CURRENCY_BEFORE_FIGURE.test('"~EUR 918k (converted from RON 4.58M at BNR rate)"')).toBe(true);
    expect(CURRENCY_BEFORE_FIGURE.test("  · Revenue          USD 1,000")).toBe(true);
  });

  it("the rule is static text: the same bytes for every request, and it names no figure of the request", () => {
    const sections = [CHAT_EUR, CHAT_RON, CHAT_TICKER].map((r) => {
      const p = buildSystemPrompt(r);
      const at = p.indexOf("Figure format (non-negotiable):\n");
      return p.slice(at, p.indexOf("=== End rule ===", at));
    });
    expect(new Set(sections).size).toBe(1);
    expect(sections[0]).toBe(FIGURE_FORMAT_SECTION);
    // …so the fragment it rides in stays byte-stable across the turns of a
    // conversation (the prompt-cache audit in prompt.ts).
    for (const ofTheRequest of [FX.rate.toFixed(4), FX.rate_date, "Invented SRL", "Ask CFO AI"]) expect(FIGURE_FORMAT_SECTION).not.toContain(ofTheRequest);
  });
});

// ── 2. the shared standard and the grid ───────────────────────────────────

/** JSON with every non-ASCII character escaped — a U+00A0 joiner is visible
 *  in a diff and survives any editor. */
const ascii = (s: string) => s.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** The magnitude word of a pack's money_display template ("{value} mil. RON" → "mil."). */
function packMagnitudes(file: string): Record<"million" | "thousand", Record<Lang, string>> {
  const text = readFileSync(resolve(REPO, file), "utf-8");
  const block = /^money_display:\n((?:  .*\n)+)/m.exec(text)?.[1] ?? "";
  const out = {} as Record<"million" | "thousand", Record<Lang, string>>;
  for (const size of ["million", "thousand"] as const) {
    const m = new RegExp(`^  ${size}: \\{ro: "\\{value\\}(.*?) RON", en: "\\{value\\}(.*?) RON"\\}$`, "m").exec(block);
    if (!m) throw new Error(`${file}: money_display.${size} is not "{value}<word> RON" in ro and en`);
    out[size] = { ro: m[1].trim(), en: m[2].trim() };
  }
  return out;
}

const HINT_VALUES = { whole: 1234567, decimals: 1234567.89, compact: 12300000, percent: "8.75", multiple: "2.35" } as const;

function buildStandard(): unknown {
  const packs = packMagnitudes("packs/ratios/margin_meaning.yaml");
  const languages: Record<string, unknown> = {};
  const hint: Record<string, unknown> = { values: HINT_VALUES };
  for (const lang of LANGS) {
    const full = figure(money(1234567.89, lang, { fractionDigits: 2 }));
    const marks = /^1(\D)234(?:\1)567(\D)89$/.exec(full);
    if (!marks) throw new Error(`lib/money printed an unexpected shape: ${JSON.stringify(full)}`);
    const magnitude = (value: number) => {
      const m = /^[\d.,]+([\s\u00a0]*)(\D+)$/.exec(figure(money(value, lang, { compact: true })));
      if (!m) throw new Error(`lib/money printed no magnitude for ${value} in ${lang}`);
      return { joiner: m[1], word: m[2] };
    };
    const million = magnitude(12_300_000), billion = magnitude(2_300_000_000);
    const code = /^[\d.,]+([\s\u00a0]+)RON$/.exec(money(1234567, lang, { fractionDigits: 0 }));
    if (!code) throw new Error("lib/money printed no joiner before the code");
    languages[lang] = {
      locale: moneyLocaleFor(lang),
      group: marks[1],
      decimal: marks[2],
      // K is the packs' word: Node's ICU prints "K" for a Romanian compact
      // thousand where Chromium prints "mii" — so no row here or in the grid
      // is a compact thousand, and the word comes from the engine's packs.
      magnitudes: { K: packs.thousand[lang], M: million.word, B: billion.word },
      magnitude_joiner: million.joiner,
      code_joiner: code[1],
    };
    hint[lang] = {
      whole: plainSpaces(figure(money(HINT_VALUES.whole, lang, { fractionDigits: 0 }))),
      decimals: plainSpaces(figure(money(HINT_VALUES.decimals, lang, { fractionDigits: 2 }))),
      compact: plainSpaces(figure(money(HINT_VALUES.compact, lang, { compact: true }))),
      percent: plainSpaces(ratio(HINT_VALUES.percent, "pct", lang)),
      multiple: plainSpaces(ratio(HINT_VALUES.multiple, "x", lang)),
    };
  }
  const symbols: Record<string, string> = {};
  for (const c of CODES) {
    const [symbol, code] = currencyLabel(c).split(" ");
    if (code) symbols[symbol] = code;
  }
  return {
    _about:
      "THE FIGURE STANDARD AS DATA — written from frontend/lib/money (formatMoneyFrom through moneyLocaleFor), the ratio table's printer " +
      "and the packs' money_display by frontend/lib/__tests__/chatLlmFigureFormat.test.ts (AI_FIGURES_WRITE=1), which regenerates and compares it " +
      "on every run. Never edit by hand. `hint` strings carry plain spaces (they are prompt text); the joiners are the bytes the product prints.",
    codes: CODES,
    symbols,
    languages,
    hint,
  };
}

/** Invented amounts: every digit-count class, with and without decimals. */
const GRID_VALUES = [
  0.5, 1, 12, 123, 999.99, 1000, 1234, 1234.5, 12345.67, 99999, 162365.46, 552340, 999999,
  1000000, 1234567, 4580000, 16778901, 64567890, 2300000000, 12345678.48,
];
const GRID_FRAMES: Record<Lang, string> = { ro: "Valoarea este de {figure} acum.", en: "The value is {figure} this year." };
type GridRow = [target: Lang, written: string, print: string, outcome: "rewritten" | "single_group" | "code_before"];

function buildGrid(): GridRow[] {
  const rows: GridRow[] = [];
  for (const target of LANGS) {
    const source: Lang = target === "ro" ? "en" : "ro";
    for (const code of CODES) for (const sign of [1, -1]) for (const v of GRID_VALUES) {
      const variants: [string, string, GridRow[3]][] = [];
      const add = (src: string, want: string, outcome: GridRow[3]) => {
        variants.push([src, want, outcome]);
        // …and the same figure with the code BEFORE it (the shape the old prompt taught): "RON 4,580,000", "-RON 4,580,000".
        // A BARE INTEGER beside a code is not known to be an amount ("cont RON
        // 5121", "În EUR 3 scenarii": round 2 of the review) — named here from
        // the SHAPE lib/money printed, not by any normaliser: no separator, no
        // magnitude. Such a row must come back byte-identical, counted.
        const num = figure(src, code);
        variants.push([`${num.startsWith("-") ? "-" : ""}${code} ${num.replace(/^-/, "")}`, want, /^-?\d+$/.test(num) ? "code_before" : outcome]);
      };
      for (const fractionDigits of [0, 2]) {
        if (fractionDigits === 0 && !Number.isInteger(v)) continue;
        // The ONE shape with two readings — a lone three-digit group — is
        // named here from the VALUE, not by any normaliser: a whole amount
        // of four to six digits, printed with no decimals.
        const lone = fractionDigits === 0 && v >= 1000 && v <= 999999;
        add(money(sign * v, source, { fractionDigits }, code), money(sign * v, target, { fractionDigits }, code), lone ? "single_group" : "rewritten");
      }
      if (v >= 1e6) add(money(sign * v, source, { compact: true }, code), money(sign * v, target, { compact: true }, code), "rewritten");
      for (const [src, want, outcome] of variants) rows.push([target, src, want, outcome]);
    }
  }
  return rows;
}

function gridFile(rows: GridRow[]): string {
  const head = {
    _about:
      "A figure as frontend/lib/money prints it in ONE language (code after it, and the same figure with the code before it), set in a " +
      "sentence of the OTHER language (`frames`). Row: [language of the text, the figure as written, lib/money's print in that language, outcome]. " +
      "outcome 'rewritten': a normaliser must turn the sentence into the frame holding the print, byte for byte. outcome 'single_group': the " +
      "figure is a lone three-digit group (two readings) — the sentence must come back byte-identical, counted single_group. outcome " +
      "'code_before': a bare integer written after a code — not known to be an amount: byte-identical, counted code_before. Written and " +
      "compared by frontend/lib/__tests__/chatLlmFigureFormat.test.ts (AI_FIGURES_WRITE=1). Never edit by hand.",
    frames: GRID_FRAMES,
  };
  return ascii(`{\n "_about": ${JSON.stringify(head._about)},\n "frames": ${JSON.stringify(head.frames)},\n "rows": [\n${rows.map((r) => "  " + JSON.stringify(r)).join(",\n")}\n ]\n}\n`);
}

describe("the shared standard: what lib/money prints NOW is what the engine and the browser's normaliser are held to", () => {
  const standard = buildStandard();
  const standardText = ascii(JSON.stringify(standard, null, 1)) + "\n";
  const rows = buildGrid();
  const gridText = gridFile(rows);

  it("POSITIVE CONTROL: the generator reads lib/money — marks, magnitude words and joiners per language; the codes and symbols are the product's", () => {
    const s = standard as { codes: string[]; symbols: Record<string, string>; languages: Record<Lang, Record<string, unknown>>; hint: Record<Lang, Record<string, string>> };
    expect(s.codes).toEqual(["RON", "EUR", "USD"]);
    expect(s.symbols).toEqual({ "€": "EUR", "$": "USD" });
    expect(s.languages.ro).toEqual({ locale: "ro-RO", group: ".", decimal: ",", magnitudes: { K: "mii", M: "mil.", B: "mld." }, magnitude_joiner: "\u00a0", code_joiner: "\u00a0" });
    expect(s.languages.en).toEqual({ locale: "en-US", group: ",", decimal: ".", magnitudes: { K: "K", M: "M", B: "B" }, magnitude_joiner: "", code_joiner: "\u00a0" });
    // The owner's two strings, in shape: "413.727.560 RON" and "~77,4 mil. EUR".
    expect(plainSpaces(money(64567890, "ro", { fractionDigits: 0 }))).toBe("64.567.890 RON");
    expect(plainSpaces(money(12300000, "ro", { compact: true }, "EUR"))).toBe("12,3 mil. EUR");
    expect(plainSpaces(money(12300000, "en", { compact: true }, "EUR"))).toBe("12.3M EUR");
    for (const lang of LANGS) {
      expect(foreignNumbersInProse(Object.values(s.hint[lang]).join("; "), lang)).toEqual([]);
      expect(foreignNumbersInProse(Object.values(s.hint[lang]).join("; "), lang === "ro" ? "en" : "ro").length).toBeGreaterThan(2);
    }
  });

  it("the magnitude words are the packs' money_display — both packs, both languages (the engine prints its own money with them)", () => {
    const s = standard as { languages: Record<Lang, { magnitudes: Record<string, string> }> };
    for (const file of ["packs/ratios/margin_meaning.yaml", "packs/forecast/cockpit.yaml"]) {
      const pack = packMagnitudes(file);
      for (const lang of LANGS) {
        expect(pack.million[lang], `${file} million.${lang}`).toBe(s.languages[lang].magnitudes.M);
        expect(pack.thousand[lang], `${file} thousand.${lang}`).toBe(s.languages[lang].magnitudes.K);
      }
    }
  });

  it("the grid: every row's print passes the detector in its own language; the lone groups are exactly the whole amounts of four to six digits", () => {
    expect(rows.length).toBe(984);
    const lone = rows.filter((r) => r[3] === "single_group");
    expect(lone.length).toBe(120);
    for (const [, written] of lone) expect(written).toMatch(/^-?(?:[A-Z]{3} )?\d{1,3}[.,]\d{3}(?:\u00a0[A-Z]{3})?$/);
    const bare = rows.filter((r) => r[3] === "code_before");
    expect(bare.length).toBe(36);
    for (const [, written] of bare) expect(written).toMatch(/^-?[A-Z]{3} \d{1,3}$/);
    for (const [target, written, print, outcome] of rows) {
      expect(foreignNumbersInProse(print, target), print).toEqual([]);
      expect(CURRENCY_BEFORE_FIGURE.test(print), print).toBe(false);
      if (outcome === "single_group") expect(written).not.toMatch(/\d[.,]\d{1,2}(?!\d)|[.,]\d{3}[.,]/);
    }
    // eslint-disable-next-line no-console
    console.log(`GATE-WORK ai-figures-standard grid=${rows.length} lone=${lone.length} examples=${2 * Object.keys(FIGURE_FORMAT_EXAMPLES.ro).length}`);
  });

  it("standard.json and grid.json are what the product prints now (regenerated, compared with the committed bytes)", () => {
    if (WRITE) {
      if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(resolve(FIXTURES, "standard.json"), standardText, "utf-8");
      writeFileSync(resolve(FIXTURES, "grid.json"), gridText, "utf-8");
    }
    expect(readFileSync(resolve(FIXTURES, "standard.json"), "utf-8")).toBe(standardText);
    expect(readFileSync(resolve(FIXTURES, "grid.json"), "utf-8")).toBe(gridText);
    // Committed files only: a write mode left on would make this law compare a file with itself.
    expect(WRITE, "AI_FIGURES_WRITE=1 re-writes the fixtures: run again without it").toBe(false);
  });
});
