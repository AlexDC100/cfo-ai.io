// cmdbar-strings — the command bar's copy in Romanian AND English (design
// C2, stage CB-G): one key set in both languages, the same interpolation
// variables, Romanian written with its diacritics (the owner's own group
// names verbatim; comma-below ș / ț, never the cedilla look-alikes ş / ţ;
// no ASCII-folded word where Romanian has a letter of its own), and every
// name the bar PRINTS for a figure finds that figure when typed back, in
// either language.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a key present in one language
// only; a {{variable}} one language drops; "Raspuns" / "Intreaba" / "in" /
// "si" in the Romanian copy; a cedilla ş or ţ anywhere in the bar's copy or
// its synonym table; a printed answer name that no longer finds its own
// answer. WHAT IT CANNOT SEE: the words' meaning, and strings the bar reads
// from the app's shared en.json / ro.json (their own i18n gates).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import strings from "../cmdbarStrings.json";
import terms from "../cmdbarTerms.json";
import { buildCmdbarIndex, searchCmdbar } from "../cmdbarIndex";

const REPO = resolve(__dirname, "../../../../../..");
const SCANDIA = JSON.parse(
  readFileSync(resolve(REPO, "e2e/fixtures/workspace_v2/scandia_fy2025.json"), "utf-8"),
).period;

type Tree = { [k: string]: string | Tree };

function flat(o: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") out[prefix + k] = v;
    else Object.assign(out, flat(v, `${prefix}${k}.`));
  }
  return out;
}

const EN = flat(strings.en as unknown as Tree);
const RO = flat(strings.ro as unknown as Tree);
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** Romanian words the bar's copy could plausibly contain that are NOT words
 *  without their diacritics (each folded form is either not Romanian or a
 *  different word): și, în, față, balanță, bilanț, acțiune, răspuns,
 *  întreabă, încarcă, adaugă, creanțe, setări, comparație. */
const FOLDED = ["si", "in", "fata", "balanta", "bilant", "actiune", "raspuns", "intreaba", "incarca", "adauga", "creante", "setari", "comparatie"];

describe("cmdbar-strings — one key set, two languages", () => {
  it("every key exists in RO and EN, none is empty, and both carry the same {{variables}}", () => {
    expect(Object.keys(RO).sort()).toEqual(Object.keys(EN).sort());
    for (const k of Object.keys(EN)) {
      expect(EN[k].trim(), `en ${k}`).not.toBe("");
      expect(RO[k].trim(), `ro ${k}`).not.toBe("");
      expect(vars(RO[k]), k).toEqual(vars(EN[k]));
    }
    expect(Object.keys(EN).length).toBeGreaterThanOrEqual(60);
  });

  it("the owner's Romanian names, verbatim — with their diacritics", () => {
    expect(RO["cmdbar.now.title"]).toBe("Ce contează acum");
    expect(RO["cmdbar.group.answer"]).toBe("Răspuns");
    expect(RO["cmdbar.group.account"]).toBe("Cont");
    expect(RO["cmdbar.group.page"]).toBe("Pagină");
    expect(RO["cmdbar.group.action"]).toBe("Acțiune");
    expect(RO["cmdbar.group.ask"]).toBe("Întreabă CFO AI");
    expect(RO["cmdbar.header.searching"]).toMatch(/^Caut în \{\{company\}\} · \{\{period\}\}$/);
    expect(RO["cmdbar.absent.line_absent"]).toBe("nu apare în balanță");
    // The filed-basis label is the owner's, served ONCE with its row (the
    // attention pack's subject, the benchmark page's name): the bar keeps no
    // copy, and never prints it beside the split (merge contract 2026-09-28).
    expect(Object.keys(RO).filter((k) => k.includes("inventory_days_on_turnover"))).toEqual([]);
    expect(Object.values(RO).some((v) => /bază depusă/.test(v))).toBe(false);
    expect(Object.values(EN).some((v) => /filed basis/.test(v))).toBe(false);
    // The retired fallback basis ("closing stock ÷ total operating cost") is
    // gone: the bar prints the served block's basis label.
    expect(Object.keys(EN).filter((k) => k.endsWith("inventoryBasis"))).toEqual([]);
  });

  it("Romanian is written with its own letters: no ASCII-folded word, no cedilla ş / ţ", () => {
    let withDiacritics = 0;
    for (const [k, v] of Object.entries(RO)) {
      const words = v.toLowerCase().split(/[^\p{L}]+/u);
      for (const f of FOLDED) expect(words, `ro ${k}: "${v}" writes "${f}" without its diacritics`).not.toContain(f);
      expect(v, `ro ${k}: cedilla`).not.toMatch(/[şţŞŢ]/);
      if (/[ăâîșțĂÂÎȘȚ]/.test(v)) withDiacritics++;
    }
    // POSITIVE CONTROL: the copy is Romanian, not an English copy.
    expect(withDiacritics).toBeGreaterThanOrEqual(30);
    // The synonym table spells diacritics with comma-below too.
    expect(JSON.stringify(terms), "terms: cedilla").not.toMatch(/[şţŞŢ]/);
  });
});

describe("cmdbar-strings — every printed answer name finds its answer, in both languages", () => {
  const index = buildCmdbarIndex({ body: SCANDIA, pages: [], actions: [] });
  const answers = (terms.answers as { id: string }[]).map((a) => a.id);

  it.each(["en", "ro"] as const)("%s: typing the name the bar prints for a figure opens that figure first", (lang) => {
    const names = lang === "en" ? EN : RO;
    let checked = 0;
    const misses: string[] = [];
    for (const id of answers) {
      const label = names[`cmdbar.answer.${id}`];
      expect(label, `${lang} name for ${id}`).toBeTruthy();
      const g = searchCmdbar(index, label).groups.find((x) => x.group === "answer");
      const top = g?.hits[0]?.entry.id ?? null;
      if (top !== `answer:${id}`) misses.push(`"${label}" → ${top ?? "nothing"} (wanted answer:${id})`);
      checked++;
    }
    expect(misses, `${lang}: printed names that do not find their own figure`).toEqual([]);
    expect(checked).toBe(answers.length);
    expect(checked).toBeGreaterThanOrEqual(11);
  });
});
