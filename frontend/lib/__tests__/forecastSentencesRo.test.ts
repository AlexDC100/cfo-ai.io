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
import { digitRuns, driverLabelRo, translateServedRo } from "@/lib/forecastSentencesRo";

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
    expect(servedDriverLabel(en, "dio_cogs_days", "dio cogs days")).toBe("Days inventory on hand");
  });
});
