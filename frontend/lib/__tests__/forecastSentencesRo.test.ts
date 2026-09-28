/**
 * THE ENGINE'S SENTENCES ON A ROMANIAN PAGE (forecast-scenarios-live, RO + EN).
 *
 * Every sentence the Forecast and Scenarios pages can paint, as the REAL route
 * serves it on the four corpus books (tests/engine/fixtures/forecast/
 * served_sentences.json — written by scripts/gen_fp1_2_fixtures.py and pinned
 * to the route by tests/engine/test_forecast_served_sentences.py), put through
 * the one function the pages print a served sentence with.
 *
 * WHAT IT REDS ON (TC-11, after the repair)
 *   · a sentence the pages can paint that does not come out in Romanian —
 *     an engine template no rule says in full, a new code, a reworded
 *     sentence (the engine pin reds first, this names what to add);
 *   · a Romanian rendering that breaks the DIGIT LAW: a digit run the engine
 *     did not serve, or one it served dropped (translateServedRo refuses such
 *     a rendering at run time, so a breach shows up here as untranslated);
 *   · English left inside a Romanian rendering;
 *   · English readers seeing anything but the served text, byte for byte;
 *   · a figure left in the English convention (a thousands comma) in Romanian.
 *
 * WHAT IT CANNOT SEE
 *   · whether the Romanian reads well — that is a reader's judgement;
 *   · sentences the corpus books never provoke (they print in English, as
 *     served, until a book provokes them and this inventory grows).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import i18n from "@/i18n";
import { servedDriverLabel, servedSentence } from "@/lib/forecastSentences";
import {
  INVENTORY_DAYS_REFUSALS,
  digitRuns,
  driverLabelRo,
  translateServedRo,
} from "@/lib/forecastSentencesRo";

const REPO = resolve(__dirname, "../../..");
const FIXTURE = "tests/engine/fixtures/forecast/served_sentences.json";
type Entry = { text: string; code: string; kinds: string[] };
const INVENTORY = JSON.parse(readFileSync(resolve(REPO, FIXTURE), "utf8")) as Entry[];

/** English words that have no business in a Romanian sentence. Chosen so
 *  none is also a Romanian word ("plan", "are" and "rate" are) or part of a
 *  served citation. */
const ENGLISH = /\b(the|this|of|and|is|book|which|from|with|revenue|cash|days|charge|nothing|not|cannot|priced|held)\b/i;

let ro: TFunction;
let en: TFunction;

beforeAll(async () => {
  await i18n.changeLanguage("ro");
  ro = i18n.getFixedT("ro");
  en = i18n.getFixedT("en");
});

describe("the served sentence inventory", () => {
  it("is not vacuous: it covers every kind of place the pages paint a sentence", () => {
    expect(INVENTORY.length).toBeGreaterThan(100);
    const kinds = new Set(INVENTORY.flatMap((e) => e.kinds));
    for (const kind of [
      "driver.basis",
      "driver.alternative",
      "driver.ladder",
      "driver.inert",
      "convention",
      "summary.runway",
      "summary.funding_rate",
      "refusal",
      "refused",
      "unserved",
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });
});

describe("Romanian: the DIO driver on a period that is not 365 days", () => {
  it("translates the plan-year restatement, digits exactly the served ones", () => {
    // engine.forecast.assumptions appends the restatement when the period's
    // day count is not the plan's 365-day year (a leap year, a year-to-date
    // book); the served-sentence fixture holds only 365-day books.
    const text =
      "days inventory outstanding, split by stock type on the period-end balance = 31.787827 days = inventory net 8,933,332.42 / cost of production sold + cost of goods resold (607) 102,295,680.81 x 365 days (forecast.dio_split). Beside it, the ratio table's dio (engine.ratios.table) reads 30.2945 days: the same split by stock type on the table's own basis; the plan projects period-end balances, so this driver is the split on the period-end balance; the period counts 366.0 days and the analysis's period-end split is stock / flow x 366.0 days, so this driver is that split restated on the plan's 365-day year";
    const out = servedSentence(ro, "ro", "forecast.dio_split", text);
    expect(out).not.toBe(text);
    expect(digitRuns(out).join(" ")).toBe(digitRuns(text).join(" "));
    expect(out).toContain("anul de 365 de zile al planului");
    expect(ENGLISH.test(out.replace(/[a-z_]+(?:\.[a-z_]+)+/g, ""))).toBe(false);
  });
});

/** The pack's refusals (`packs/ratios/inventory_days.yaml#refusals`), read
 *  from the file the engine words them from — never a hand-typed copy. */
const PACK_REFUSALS = ((): Record<string, { en: string; ro: string }> => {
  const pack = readFileSync(resolve(REPO, "packs/ratios/inventory_days.yaml"), "utf-8");
  const section = /\nrefusals:\n([\s\S]*?)\n(?=[a-z_]+:)/.exec(pack);
  if (!section) throw new Error("packs/ratios/inventory_days.yaml carries no refusals section");
  const out: Record<string, { en: string; ro: string }> = {};
  const entry = /\n  ([a-z_]+):\n    \{ro: "([^"]+)",\s*en: "([^"]+)"\}/g;
  for (let m = entry.exec("\n" + section[1]); m; m = entry.exec("\n" + section[1])) {
    out[m[1]] = { en: m[3], ro: m[2] };
  }
  return out;
})();

describe("Romanian: the DIO driver refused (the refusal's own words, never a bare code)", () => {
  // engine.forecast.assumptions cites the block's reason — its words and its
  // code. The Romanian page printed "(codul motivului a_leg_refused)" with no
  // words: a code where a reason belongs.
  it("the mirror is the pack's refusals, word for word, every code", () => {
    expect(Object.keys(PACK_REFUSALS).length, "no refusal parsed from the pack").toBeGreaterThan(5);
    expect(INVENTORY_DAYS_REFUSALS).toEqual(PACK_REFUSALS);
  });

  it("prints the pack's Romanian reason for every code, digits exactly the served ones", () => {
    for (const [code, words] of Object.entries(PACK_REFUSALS)) {
      const text = `inventory days are refused for this book: ${words.en} (reason code ${code}); no driver is measured, so inventory is HELD at its closing balance of 67,821,213.71`;
      const out = servedSentence(ro, "ro", "forecast.dio_split", text);
      expect(out, code).not.toBe(text);
      expect(out, code).toContain(`: ${words.ro} (codul motivului ${code})`);
      expect(out, code).toContain("67.821.213,71");
      expect(digitRuns(out).join(" "), code).toBe(digitRuns(text).join(" "));
    }
  });

  it("a reason worded otherwise than the pack prints the served English, never a guessed Romanian", () => {
    const text =
      "inventory days are refused for this book: some other words (reason code a_leg_refused); no driver is measured, so inventory is HELD at its closing balance of 1,000.00";
    expect(translateServedRo(ro, text)).toBeNull();
    expect(servedSentence(ro, "ro", null, text)).toBe(text);
  });
});

describe("Romanian: every sentence the pages paint", () => {
  it("comes out in Romanian, digits exactly the served ones, no English left", () => {
    const untranslated: string[] = [];
    const lawBroken: string[] = [];
    const english: string[] = [];
    const commas: string[] = [];
    for (const { text, code } of INVENTORY) {
      const out = servedSentence(ro, "ro", code || null, text);
      if (out === text) {
        // A citation the engine already serves in Romanian ("Codul fiscal,
        // Legea 227/2015, art. 17") is printed as served; anything with an
        // English word in it is not translated.
        if (ENGLISH.test(text)) untranslated.push(`[${code}] ${text}`);
        continue;
      }
      const a = digitRuns(text);
      const b = digitRuns(out);
      if (a.join(" ") !== b.join(" ")) lawBroken.push(`${text}\n  -> ${out}`);
      // Citations are copied as served; check the Romanian words around them.
      const words = out
        .replace(/\((?:[^()]*Legea[^()]*|[^()]*data\.gov\.ro[^()]*)\)/g, "")
        .replace(/[a-z_]+(?:\.[a-z_]+)+/g, "")
        .replace(/packs\/\S+/g, "");
      if (ENGLISH.test(words)) english.push(`${text}\n  -> ${out}`);
      if (/\d,\d{3}\b/.test(out) && !/\d\.\d{3}/.test(out)) commas.push(out);
    }
    expect(untranslated, "painted in English on a Romanian page").toEqual([]);
    expect(lawBroken, "a Romanian rendering changed the served digits").toEqual([]);
    expect(english, "English left inside a Romanian rendering").toEqual([]);
    expect(commas, "a figure left in the English convention").toEqual([]);
  });

  it("re-writes a figure in the Romanian convention without moving a digit", () => {
    const out = translateServedRo(
      ro,
      "days sales outstanding = 37.56333 days = trade receivables net 42,578,040.60 / revenue 413,727,560.16 x 365 days (forecast.dso)",
    );
    expect(out).toBe(
      "zile de încasare a creanțelor = 37,56333 zile = creanțe comerciale nete 42.578.040,60 / venituri 413.727.560,16 x 365 zile (forecast.dso)",
    );
  });

  it("leaves a sentence no rule says in full to the caller, who prints it as served", () => {
    const novel = "a sentence the engine has never served, with 1,234.56 in it";
    expect(translateServedRo(ro, novel)).toBeNull();
    expect(servedSentence(ro, "ro", null, novel)).toBe(novel);
  });

  it("names drivers in Romanian, the pool families by their pool", () => {
    expect(driverLabelRo(ro, "pool_fixed_share.personnel")).toBe("Partea fixă · personal");
    expect(driverLabelRo(ro, "dso_days")).toBe("Zile de încasare a creanțelor");
    expect(servedDriverLabel(ro, "an_unknown_driver", "an unknown driver")).toBe("an unknown driver");
  });
});

describe("English: the served text, byte for byte", () => {
  it("prints every sentence exactly as the engine served it", () => {
    for (const { text, code } of INVENTORY) {
      expect(servedSentence(en, "en", code || null, text)).toBe(text);
    }
  });

  it("names the drivers in plain English, never the wire id", () => {
    expect(servedDriverLabel(en, "pool_fixed_share.cost_of_sales", "pool fixed share.cost of sales")).toBe(
      "Fixed share · Cost of sales",
    );
    expect(servedDriverLabel(en, "dio_cogs_days", "dio cogs days")).toBe("Inventory days (DIO) — period-end balance, plan year");
  });
});
