// EVERY STRING THE APP CAN PRINT EXISTS IN BOTH LANGUAGES.
//
// WHY THIS EXISTS (review of the no-prior hotfix, 2026-10-04): the product
// ships in English and Romanian, and nothing held the two to the same keys.
// `scripts/check-i18n-coverage.ts` was written for it and never ran: it
// imported `../src/i18n/locales` and an `fr.json`, neither of which exists
// (the bundles live in frontend/i18n/locales; French left on 2026-07-24), so
// it could not even start, and no gate named it. A key present in one
// language only prints the OTHER language's sentence (i18next falls back to
// English) or, with no fallback either, the raw key — in a product whose
// reader chose a language. Each gate that needed a sentence in both
// languages checked its own handful of keys; the bundles as a whole were
// nobody's.
//
// THE LAW, over two sets of strings — the two bundle files, and the store
// i18next actually reads once every module that registers strings in code
// (`i18n.addResourceBundle`, 29 modules today) has loaded:
//
//   1. KEYS. Every key of one language exists in the other. The one
//      exception is i18next's own: a plural key carries one form per plural
//      category of ITS language (`Intl.PluralRules` — read from i18next's
//      resolver below, not restated): English has `_one` / `_other`,
//      Romanian `_one` / `_few` / `_other` ("o zi", "3 zile", "20 de zile").
//      So a Romanian `_few` has no English twin — and a plural key with a
//      form MISSING for its language is a gap: i18next does not fall back
//      to another form of the same language but to the fallback LANGUAGE,
//      so Romanian without `_few` prints the English sentence for 0 and
//      2–19 ("3 days"), and an English-only `_zero` prints English at 0.
//   2. PLACEHOLDERS. The `{{placeholders}}` of a key are the same in both
//      languages. A singular form (`_one`, `_zero`) may spell the count out
//      ("acum o zi") and omit `{{count}}`; nothing else may differ.
//   3. NOT EMPTY. Every value is a non-empty string.
//
// WHAT IT REDS ON, with the bundles in parity (TC-11): a key added to one
// language and not the other (either direction); a plural form missing for
// a language's category, or a form of a category the language does not have;
// a placeholder renamed, dropped or added in one language; an empty or
// non-string value; a module that registers strings in code for one
// language only; a source file that starts calling `addResourceBundle` and
// cannot be loaded here; i18next's plural categories for either language
// changing under an upgrade.
//
// WHAT IT CANNOT SEE: whether a translation is RIGHT, or is a translation at
// all (an English sentence pasted into ro.json passes — the identical-value
// count is printed, not judged: "EBITDA {{year}}" is the same in both);
// a key the source uses that NEITHER bundle has (a raw key on screen — the
// i18n sweep's, e2e/i18n-mobile-sweep.spec.ts); a string that is not in a
// bundle at all — a hard-coded English label in a component, the landing
// page's own table (pages/cfo/landingStrings.ts), sentences the ENGINE
// serves in both languages (packs; `ui-language-figures` holds those it
// names); markup inside a value beyond its placeholders; a `$t(…)` nesting
// reference (none today — counted below, so the first one is seen).

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import i18next from "i18next";

import i18n from "@/i18n";

const REPO = resolve(process.cwd());
const FRONTEND = join(REPO, "frontend");

type Flat = Map<string, unknown>;

function flatten(tree: unknown, prefix = "", out: Flat = new Map()): Flat {
  for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const bundle = (lang: "en" | "ro"): Flat =>
  flatten(JSON.parse(readFileSync(join(FRONTEND, "i18n", "locales", `${lang}.json`), "utf8")));

// ── i18next's plural rule, read from i18next ───────────────────────────

/** The suffixes i18next looks a plural key up under, per language: one per
 *  `Intl.PluralRules` category ("_one", "_few", "_other"). */
function pluralSuffixes(lang: string): string[] {
  const resolver = (i18n.services as unknown as {
    pluralResolver: { getSuffixes(code: string): string[] };
  }).pluralResolver;
  return resolver.getSuffixes(lang);
}
const SUFFIXES = { en: pluralSuffixes("en"), ro: pluralSuffixes("ro") };
/** `_zero` is i18next's own extra form for a count of exactly 0, in any
 *  language. */
const ZERO = "_zero";

/** A plural family: a base key with BOTH of the forms every language has
 *  (`_one` and `_other`) in at least one language. A key that merely ends
 *  in `_other` (a row named "equity_other") is an ordinary key. */
function pluralBases(...flats: Flat[]): Set<string> {
  const bases = new Set<string>();
  for (const flat of flats) {
    for (const key of flat.keys()) {
      if (!key.endsWith("_one")) continue;
      const base = key.slice(0, -"_one".length);
      if (flat.has(`${base}_other`)) bases.add(base);
    }
  }
  return bases;
}

/** Split a key into its plural base and suffix, when it belongs to a family. */
function pluralPartsOf(key: string, bases: Set<string>): { base: string; suffix: string } | null {
  const at = key.lastIndexOf("_");
  if (at < 0) return null;
  const base = key.slice(0, at);
  return bases.has(base) ? { base, suffix: key.slice(at) } : null;
}

// ── The three laws, on any pair ────────────────────────────────────────

const placeholdersOf = (value: unknown): string[] =>
  [...new Set([...String(value).matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)].map((m) => m[1]))].sort();

interface Gaps {
  keys: string[];
  plurals: string[];
  placeholders: string[];
  empty: string[];
}

function gapsBetween(en: Flat, ro: Flat): Gaps {
  const flats = { en, ro };
  const bases = pluralBases(en, ro);
  const gaps: Gaps = { keys: [], plurals: [], placeholders: [], empty: [] };

  // 1. Keys. A plural family is held to its language's categories below.
  for (const [lang, other] of [["en", "ro"], ["ro", "en"]] as const) {
    for (const key of flats[lang].keys()) {
      if (pluralPartsOf(key, bases)) continue;
      if (!flats[other].has(key)) gaps.keys.push(`${key}: in ${lang}, not in ${other}`);
    }
  }
  for (const base of bases) {
    for (const lang of ["en", "ro"] as const) {
      for (const suffix of SUFFIXES[lang]) {
        if (!flats[lang].has(base + suffix)) gaps.plurals.push(`${base}${suffix}: missing in ${lang}`);
      }
      for (const key of flats[lang].keys()) {
        const parts = pluralPartsOf(key, bases);
        if (!parts || parts.base !== base) continue;
        if (parts.suffix !== ZERO && !SUFFIXES[lang].includes(parts.suffix)) {
          gaps.plurals.push(`${key}: ${lang} has no plural category "${parts.suffix.slice(1)}"`);
        }
      }
    }
    // `_zero` is said in both languages or in neither.
    if (en.has(base + ZERO) !== ro.has(base + ZERO)) {
      gaps.plurals.push(`${base}${ZERO}: in ${en.has(base + ZERO) ? "en" : "ro"} only`);
    }
  }

  // 2. Placeholders. A key against its twin; a form only one language has
  //    (Romanian `_few`) against the family's `_other`.
  const SINGULAR = ["_one", ZERO];
  const sameBut = (a: string[], b: string[], optional: string | null) => {
    const strip = (xs: string[]) => xs.filter((x) => x !== optional).join(",");
    return strip(a) === strip(b);
  };
  for (const [key, value] of ro) {
    const parts = pluralPartsOf(key, bases);
    const twin = en.has(key) ? key : parts ? `${parts.base}_other` : null;
    if (!twin || !en.has(twin)) continue; // a key gap, reported above
    const a = placeholdersOf(en.get(twin));
    const b = placeholdersOf(value);
    const singular = !!parts && SINGULAR.includes(parts.suffix);
    if (!sameBut(a, b, singular ? "count" : null)) {
      gaps.placeholders.push(`${key}: en {${a.join(", ")}} / ro {${b.join(", ")}}`);
    }
  }

  // 3. Not empty.
  for (const lang of ["en", "ro"] as const) {
    for (const [key, value] of flats[lang]) {
      if (typeof value !== "string" || value.trim() === "") gaps.empty.push(`${lang}: ${key}`);
    }
  }
  return gaps;
}

const total = (g: Gaps) => g.keys.length + g.plurals.length + g.placeholders.length + g.empty.length;

// ── The strings registered in code ─────────────────────────────────────

/** Every source file that registers strings with i18next at module load. */
function registeringModules(dir = FRONTEND, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "test") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) registeringModules(full, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      if (/\.(?:addResourceBundle|addResources?)\(/.test(readFileSync(full, "utf8"))) acc.push(relative(FRONTEND, full));
    }
  }
  return acc.sort();
}

describe("i18n-parity — English and Romanian carry the same strings", () => {
  it("i18next's plural categories are the ones the law is written for", () => {
    // Read from i18next (Intl.PluralRules), not restated in the laws above —
    // and pinned here, so an upgrade that changes them is a decision.
    expect(SUFFIXES.en).toEqual(["_one", "_other"]);
    expect(SUFFIXES.ro).toEqual(["_one", "_few", "_other"]);
    expect(new Intl.PluralRules("ro").select(5)).toBe("few");
    expect(new Intl.PluralRules("ro").select(20)).toBe("other");
    // Why a missing form is a gap and not a nicety: i18next falls back to
    // the other LANGUAGE, never to another form of the same one.
    const probe = i18next.createInstance();
    void probe.init({
      lng: "ro",
      fallbackLng: "en",
      resources: {
        en: { translation: { d_one: "{{count}} day", d_other: "{{count}} days", z_zero: "none", z_one: "one", z_other: "many" } },
        ro: { translation: { d_one: "o zi", d_other: "{{count}} de zile", z_one: "unu", z_other: "multe" } },
      },
    });
    expect(probe.t("d", { count: 1 })).toBe("o zi");
    expect(probe.t("d", { count: 3 })).toBe("3 days"); // no `_few`: English
    expect(probe.t("d", { count: 20 })).toBe("20 de zile");
    expect(probe.t("z", { count: 0 })).toBe("none"); // `_zero` in English only: English
    // What the app prints for a real key, through i18next itself.
    const ro = i18n.getFixedT("ro");
    expect(ro("panels.rel.dayAgo", { count: 1 })).toBe(bundle("ro").get("panels.rel.dayAgo_one"));
    expect(ro("panels.rel.dayAgo", { count: 3 })).toBe(
      String(bundle("ro").get("panels.rel.dayAgo_few")).replace("{{count}}", "3"),
    );
    expect(ro("panels.rel.dayAgo", { count: 20 })).toBe(
      String(bundle("ro").get("panels.rel.dayAgo_other")).replace("{{count}}", "20"),
    );
  });

  it("the laws see each kind of gap — on a pair made for it", () => {
    const en: Flat = new Map<string, unknown>([
      ["a.same", "Same {{name}}"],
      ["a.onlyEn", "English only"],
      ["a.renamed", "Hello {{name}}"],
      ["a.blank", "Filled"],
      ["a.row.equity_other", "Other equity"],
      ["a.files_one", "{{count}} file"],
      ["a.files_other", "{{count}} files"],
      ["a.days_one", "{{count}} day"],
      ["a.days_other", "{{count}} days"],
      ["a.days_zero", "today"],
      ["a.days_few", "{{count}} days"],
    ]);
    const ro: Flat = new Map<string, unknown>([
      ["a.same", "La fel {{name}}"],
      ["a.onlyRo", "Doar în română"],
      ["a.renamed", "Salut {{nume}}"],
      ["a.blank", "  "],
      ["a.row.equity_other", "Alte capitaluri"],
      ["a.files_one", "un fișier"],
      ["a.files_other", "{{count}} de fișiere"],
      ["a.days_one", "o zi"],
      ["a.days_few", "{{n}} zile"],
      ["a.days_other", "{{count}} de zile"],
    ]);
    expect(gapsBetween(en, ro)).toEqual({
      keys: ["a.onlyEn: in en, not in ro", "a.onlyRo: in ro, not in en"],
      plurals: [
        "a.files_few: missing in ro",
        'a.days_few: en has no plural category "few"',
        "a.days_zero: in en only",
      ],
      placeholders: ["a.renamed: en {name} / ro {nume}", "a.days_few: en {count} / ro {n}"],
      empty: ["ro: a.blank"],
    });
    // …and none on a pair in parity, Romanian `_few` and a spelled-out
    // singular included.
    const pairEn: Flat = new Map<string, unknown>([["d_one", "{{count}} day"], ["d_other", "{{count}} days"], ["x", "{{a}}"]]);
    const pairRo: Flat = new Map<string, unknown>([["d_one", "o zi"], ["d_few", "{{count}} zile"], ["d_other", "{{count}} de zile"], ["x", "{{a}}"]]);
    expect(total(gapsBetween(pairEn, pairRo))).toBe(0);
  });

  it("the two bundle files: every key in both, every plural form its language needs, the same placeholders, nothing empty", () => {
    const en = bundle("en");
    const ro = bundle("ro");
    const gaps = gapsBetween(en, ro);
    const bases = pluralBases(en, ro);
    const identical = [...en].filter(([k, v]) => ro.get(k) === v).length;
    const nested = [...en, ...ro].filter(([, v]) => /\$t\(/.test(String(v))).length;
    // eslint-disable-next-line no-console
    console.log(
      `GATE-WORK i18n-parity bundles en_keys=${en.size} ro_keys=${ro.size} plural_families=${bases.size} ` +
        `identical_values=${identical} nested_refs=${nested} gaps=${total(gaps)}`,
    );
    expect(gaps.keys, "a key in one language only").toEqual([]);
    expect(gaps.plurals, "a plural form missing, or of a category the language does not have").toEqual([]);
    expect(gaps.placeholders, "a {{placeholder}} that differs between the languages").toEqual([]);
    expect(gaps.empty, "an empty value").toEqual([]);
    // The bundles are read: plural families exist, and a nesting reference
    // (which this law does not follow) would be the first.
    expect(bases.size).toBeGreaterThan(0);
    expect(nested).toBe(0);
  });

  // Three of the registering modules are pages and panels (the dashboard
  // among them): loading them is the slow part, and slower inside the full
  // suite — hence the timeout.
  it("the store i18next reads, once every module that registers strings in code has loaded: the same laws", async () => {
    const modules = registeringModules();
    expect(modules).toContain("components/instrument/shell/cmdbar/cmdbarI18n.ts");
    await Promise.all(modules.map((rel) => import(/* @vite-ignore */ join(FRONTEND, rel))));
    const store = (lang: "en" | "ro") => flatten(i18n.getResourceBundle(lang, "translation"));
    const en = store("en");
    const ro = store("ro");
    const inCode = [...en.keys()].filter((k) => !bundle("en").has(k)).length;
    const gaps = gapsBetween(en, ro);
    // eslint-disable-next-line no-console
    console.log(
      `GATE-WORK i18n-parity store modules=${modules.length} en_keys=${en.size} ro_keys=${ro.size} ` +
        `registered_in_code=${inCode} gaps=${total(gaps)}`,
    );
    // The modules did register: the store holds more than the files.
    expect(inCode).toBeGreaterThan(0);
    expect(gaps.keys, "a key in one language only").toEqual([]);
    expect(gaps.plurals, "a plural form missing, or of a category the language does not have").toEqual([]);
    expect(gaps.placeholders, "a {{placeholder}} that differs between the languages").toEqual([]);
    expect(gaps.empty, "an empty value").toEqual([]);
  }, 180_000);

  it("the stale checker is gone — this file is the one parity law", () => {
    expect(() => statSync(join(REPO, "scripts", "check-i18n-coverage.ts"))).toThrow();
  });
});
