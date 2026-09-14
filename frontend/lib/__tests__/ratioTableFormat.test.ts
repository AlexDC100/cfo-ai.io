// Gates for the ONE ratio formatter (frontend/lib/ratioTable.ts).
//
// Scope (TC-13): the pure formatter functions, the statements.ratioCmp
// i18n bundle, and the enums this reader mirrors from
// src/engine/ratios/table.py (and src/engine/comparatives/ratio_compare.py
// once it exists). It does not render any surface; the dashboard, report
// and workbook readers carry their own gates and call these functions.
//
// Bundle strings are read from en.json / ro.json directly (`bundle()`),
// never through t(): a missing key makes t() return the key itself on
// BOTH sides of a comparison, which is how a raw key once stayed green.
//
// G1  every unit prints the served string verbatim.
//     Reds AFTER repair on: any reformatting of a served value_q, delta or
//     pct_change (toFixed, Number(), Intl grouping, a dropped sign), a
//     hardcoded unit suffix that bypasses i18n, a unit added to the
//     enumeration without its suffix keys, a wrong count form ("20 zile"),
//     and an unknown unit or a non-letter grade printed instead of refused.
// G2  delta colour follows the served `favourable`, never the sign or
//     higher_is_better.
//     Reds AFTER repair on: a tone derived from anything but `favourable`,
//     an inverted mapping, a zero delta served as improved painted green,
//     and an unknown verdict or movement status painted anything but amber.
// G3  a null side, delta or movement prints the sentence for its served
//     reason, in the reader's language, naming the served inputs.
//     Reds AFTER repair on: a dash (MONEY_MISSING), an empty cell, a raw
//     key, `undefined`, an English sentence under RO for ANY reason code,
//     a sentence that drops the named input, and an unrecognised enum value
//     (status, band_status, band, unit) printed as a word instead of named.
// G4  EN and RO carry the same statements.ratioCmp keys and placeholders,
//     every key the formatter can resolve is a non-empty string in both
//     bundles, and no string writes a number (TC-10).
//     Reds AFTER repair on: a key present in one language only, a key the
//     formatter resolves missing from BOTH languages, a key literal in
//     ratioTable.ts outside the census, a placeholder missing from one
//     spelling, and a digit in any value.
// G5  the reader's enums are the engine's.
//     Reds AFTER repair on: RATIO_REASON_CODES or RATIO_BAND_STATUSES
//     differing (members or order) from the Python tuples, a second
//     assignment to either tuple in table.py, an input name table.py can
//     emit with no operand word (TC-12 coverage printed in the message),
//     and ratio_compare.py declaring a reason code the reader has no
//     sentence for.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { MONEY_MISSING } from "@/lib/money";
import {
  CREDIT_LETTERS,
  RATIO_BAND_STATUSES,
  RATIO_COMPARE_REASON_CODES,
  RATIO_DELTA_UNITS,
  RATIO_DISPLAY_UNITS,
  RATIO_OPERAND_WORD,
  RATIO_READER_REASONS,
  RATIO_REASON_CODES,
  RATIO_REASON_CODES_WITH_INPUTS,
  bandWordKey,
  deltaTone,
  formatRatioBand,
  formatRatioDelta,
  formatRatioMovement,
  formatRatioSide,
  movementTone,
  operandWords,
  ratioCmpKeyCensus,
  reasonKey,
  type RatioCompareRow,
  type RatioDelta,
  type RatioDisplayUnit,
  type RatioDeltaUnit,
  type RatioMovement,
  type RatioSide,
} from "@/lib/ratioTable";

const REPO = resolve(__dirname, "../../..");
const ENGINE_TABLE = resolve(REPO, "src/engine/ratios/table.py");
const ENGINE_COMPARE = resolve(REPO, "src/engine/comparatives/ratio_compare.py");

const side = (over: Partial<RatioSide> = {}): RatioSide => ({
  value: null,
  value_q: null,
  band: null,
  band_status: "graded",
  ladder: null,
  operands: [],
  reason: null,
  ...over,
});

const delta = (over: Partial<RatioDelta> = {}): RatioDelta => ({
  value: null,
  unit: "turns",
  pct_change: null,
  favourable: null,
  reason_code: null,
  ...over,
});

const movement = (over: Partial<RatioMovement> = {}): RatioMovement => ({
  status: "same_band",
  from: "healthy",
  to: "healthy",
  rungs_crossed: 0,
  rung_crossed: null,
  distance_past_rung: null,
  band_width: null,
  band_width_basis: null,
  distance_fraction: null,
  materiality: null,
  reason_code: null,
  ...over,
});

/** A bundle string read from the JSON itself. Throws on a missing or
 *  non-string key, so a deleted key reds instead of comparing key to key. */
const bundle = (lang: "en" | "ro", key: string): string => {
  const v = key
    .split(".")
    .reduce<unknown>(
      (n, p) => (n && typeof n === "object" ? (n as Record<string, unknown>)[p] : undefined),
      lang === "en" ? en : ro,
    );
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${lang}.json has no string at ${key}`);
  return v;
};

/** A printed cell must be a real sentence or figure. */
const printable = (text: unknown) => {
  expect(typeof text).toBe("string");
  const s = text as string;
  expect(s).not.toBe(MONEY_MISSING);
  expect(s).not.toBe("");
  expect(s).not.toBe("-");
  expect(s).not.toMatch(/^statements\./);
  expect(s).not.toMatch(/\bstatements\.ratioCmp\./);
  expect(s).not.toMatch(/\bdashV2\./);
  expect(s).not.toContain("{{");
};

// ── G1 ────────────────────────────────────────────────────────────────

describe("G1 every unit prints the served string verbatim", () => {
  // Served strings chosen so that ANY reformatting shows: a leading "+",
  // a trailing zero, a zero-decimal days figure, three-digit integers.
  const SIDE_CASES: Record<RatioDisplayUnit, { served: string; en: string; ro: string }> = {
    x: { served: "1.80", en: "1.80×", ro: "1,80×" },
    pct: { served: "12.0", en: "12.0%", ro: "12,0%" },
    days: { served: "145", en: "145 days", ro: "145 de zile" },
    z: { served: "2.10", en: "2.10", ro: "2,10" },
    score: { served: "81.0", en: "81.0", ro: "81,0" },
    grade: { served: "BBB", en: "BBB", ro: "BBB" },
  };
  const DELTA_CASES: Record<RatioDeltaUnit, { served: string; en: string; ro: string }> = {
    turns: { served: "+0.10", en: "+0.10×", ro: "+0,10×" },
    pp: { served: "-3.0", en: "-3.0 pp", ro: "-3,0 p.p." },
    days: { served: "+12", en: "+12 days", ro: "+12 zile" },
    z: { served: "-0.40", en: "-0.40", ro: "-0,40" },
    points: { served: "+5.0", en: "+5.0 pts", ro: "+5,0 puncte" },
    notches: { served: "-2", en: "-2 notches", ro: "-2 trepte" },
  };

  it("covers every display and delta unit in the enumeration (non-vacuity)", () => {
    expect(Object.keys(SIDE_CASES).sort()).toEqual([...RATIO_DISPLAY_UNITS].sort());
    expect(Object.keys(DELTA_CASES).sort()).toEqual([...RATIO_DELTA_UNITS].sort());
  });

  it.each(RATIO_DISPLAY_UNITS.map((u) => [u]))("side unit %s", (unit) => {
    const c = SIDE_CASES[unit];
    const s = side({ value_q: c.served, value: 999.123456 });
    expect(formatRatioSide(s, unit, "en")).toBe(c.en);
    expect(formatRatioSide(s, unit, "ro")).toBe(c.ro);
  });

  it.each(RATIO_DELTA_UNITS.map((u) => [u]))("delta unit %s", (unit) => {
    const c = DELTA_CASES[unit];
    const d = delta({ unit, value: c.served, pct_change: unit === "turns" ? "+5.3" : null });
    expect(formatRatioDelta(d, "en").primary).toBe(c.en);
    expect(formatRatioDelta(d, "ro").primary).toBe(c.ro);
  });

  it("prints the full-precision value nowhere: value_q is the only printable form", () => {
    const s = side({ value_q: "1.85", value: 1.84499 });
    expect(formatRatioSide(s, "x", "en")).toBe("1.85×");
  });

  it("turns carry the served percent change as secondary, verbatim", () => {
    const d = delta({ unit: "turns", value: "+0.22", pct_change: "+13.6" });
    expect(formatRatioDelta(d, "en")).toEqual({ primary: "+0.22×", secondary: "+13.6%" });
    expect(formatRatioDelta(d, "ro")).toEqual({ primary: "+0,22×", secondary: "+13,6%" });
    // A null pct_change on turns is the bundle's own sentence, not a blank.
    const nobEn = formatRatioDelta(delta({ unit: "turns", value: "+0.22" }), "en");
    const nobRo = formatRatioDelta(delta({ unit: "turns", value: "+0.22" }), "ro");
    printable(nobEn.secondary);
    printable(nobRo.secondary);
    expect(nobEn.secondary).toBe(bundle("en", "statements.ratioCmp.pctNoBase"));
    expect(nobRo.secondary).toBe(bundle("ro", "statements.ratioCmp.pctNoBase"));
    expect(nobRo.secondary).not.toBe(nobEn.secondary);
    // Other units carry no secondary.
    expect(formatRatioDelta(delta({ unit: "pp", value: "+1.0", pct_change: "9.9" }), "en").secondary).toBeNull();
  });

  it("count forms read the served string: '1' singular, the Romanian 'de' from twenty", () => {
    expect(formatRatioDelta(delta({ unit: "days", value: "+1" }), "en").primary).toBe("+1 day");
    expect(formatRatioDelta(delta({ unit: "notches", value: "-1" }), "ro").primary).toBe("-1 treaptă");
    expect(formatRatioDelta(delta({ unit: "points", value: "+1.0" }), "en").primary).toBe("+1.0 pts");
    const ro = (unit: RatioDeltaUnit, value: string) => formatRatioDelta(delta({ unit, value }), "ro").primary;
    expect(ro("days", "+19")).toBe("+19 zile");
    expect(ro("days", "+20")).toBe("+20 de zile");
    expect(ro("days", "-101")).toBe("-101 zile");
    expect(ro("days", "+100")).toBe("+100 de zile");
    expect(ro("points", "+20.5")).toBe("+20,5 puncte");
    expect(ro("notches", "+25")).toBe("+25 de trepte");
    expect(formatRatioSide(side({ value_q: "20" }), "days", "ro")).toBe("20 de zile");
    expect(formatRatioSide(side({ value_q: "20" }), "days", "en")).toBe("20 days");
  });

  it("refuses a served string that is not printable in its unit", () => {
    const refusalEn = bundle("en", "statements.ratioCmp.reason.malformed_value");
    expect(formatRatioSide(side({ value_q: "1E+2" }), "days", "en")).toBe(refusalEn);
    expect(formatRatioDelta(delta({ unit: "pp", value: "NaN" }), "en").primary).toBe(refusalEn);
    // grade: only a letter of the one ladder prints
    for (const bad of ["", "NaN", "D", "bbb", "12"]) {
      const text = formatRatioSide(side({ value_q: bad }), "grade", "en");
      printable(text);
      expect(text).toBe(refusalEn);
    }
    for (const letter of CREDIT_LETTERS) {
      expect(formatRatioSide(side({ value_q: letter }), "grade", "ro")).toBe(letter);
    }
  });

  it("refuses an unknown display or delta unit, naming it", () => {
    const s = formatRatioSide(side({ value_q: "1.20" }), "ratio" as RatioDisplayUnit, "en");
    printable(s);
    expect(s).toContain('"ratio"');
    expect(s).toContain("display_unit");
    const d = formatRatioDelta(delta({ unit: "grade_steps" as RatioDeltaUnit, value: "+1" }), "ro");
    printable(d.primary);
    expect(d.primary).toContain('"grade_steps"');
    expect(d.primary.startsWith(bundle("ro", "statements.ratioCmp.reason.unrecognised").split("{{")[0])).toBe(true);
  });

  it("the formatter source carries no numeric reformatting primitive", () => {
    const src = readFileSync(resolve(__dirname, "../ratioTable.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const banned of [/\.toFixed\(/, /\bparseFloat\(/, /\bNumber\(/, /\bMath\./, /Intl\.NumberFormat/, /toLocaleString\(/]) {
      expect(code, `ratioTable.ts uses ${banned}`).not.toMatch(banned);
    }
  });
});

// ── G2 ────────────────────────────────────────────────────────────────

describe("G2 delta colour follows the served favourable verdict", () => {
  // DSO fell by 5 days. Lower is better, so the engine served `improved`.
  // The sign alone says "down"; higher_is_better alone says "false". Only
  // the served verdict is read.
  const dso: RatioCompareRow = {
    key: "dso",
    group: "efficiency",
    label_key: "ratio.dso",
    formula_key: "ratio.dso.formula",
    display_unit: "days",
    higher_is_better: false,
    current: side({ value_q: "40", band: "healthy" }),
    prior: side({ value_q: "45", band: "healthy" }),
    delta: delta({ unit: "days", value: "-5", favourable: "improved" }),
    movement: movement(),
    finding_id: null,
  };

  it("improved under higher_is_better=false renders the improved tone", () => {
    expect(dso.higher_is_better).toBe(false);
    expect(dso.delta.value?.startsWith("-")).toBe(true);
    expect(deltaTone(dso.delta.favourable, dso.delta.value)).toBe("success");
  });

  it("deteriorated with a positive delta renders the deteriorated tone", () => {
    expect(deltaTone("deteriorated", "+3.0")).toBe("alert");
  });

  it("none and null are neutral", () => {
    expect(deltaTone("none", "0")).toBe("neutral");
    expect(deltaTone(null)).toBe("neutral");
  });

  it("a zero delta served as improved or deteriorated is a contradiction: amber", () => {
    for (const zero of ["0", "+0.0", "-0.00"]) {
      expect(deltaTone("improved", zero)).toBe("caution");
      expect(deltaTone("deteriorated", zero)).toBe("caution");
    }
    expect(deltaTone("improved", "+0.01")).toBe("success");
  });

  it("an unrecognised verdict is amber, not neutral", () => {
    expect(deltaTone("better" as never, "+1")).toBe("caution");
  });

  it("movement tone reads the served status; a contradiction or an unknown status is amber", () => {
    const up = movement({ status: "crossed_up", from: "watch", rungs_crossed: 1 });
    const down = movement({ status: "crossed_down", to: "watch", rungs_crossed: -1 });
    expect(movementTone(up)).toBe("success");
    expect(movementTone(down)).toBe("alert");
    expect(movementTone(dso.movement)).toBe("neutral");
    expect(movementTone({ ...up, rungs_crossed: -1 })).toBe("caution");
    expect(movementTone(movement({ status: "not_comparable", reason_code: "x" }))).toBe("neutral");
    expect(movementTone(movement({ status: "rebanded" as never }))).toBe("caution");
    expect(formatRatioMovement(up, "en")).toBe("Watch → Healthy");
    expect(formatRatioMovement(up, "ro")).toBe("De urmărit → Sănătos");
  });
});

// ── G3 ────────────────────────────────────────────────────────────────

describe("G3 a missing figure prints its served reason, never a dash", () => {
  it("a refused side names the missing inputs, in EN and RO", () => {
    const prior = side({
      band_status: "refused",
      reason: { code: "operand_absent", inputs: ["incomeStatement.interestExpense", "balanceSheet.cash"] },
    });
    const enText = formatRatioSide(prior, "x", "en");
    const roText = formatRatioSide(prior, "x", "ro");
    printable(enText);
    printable(roText);
    expect(enText).toBe("Not reported: this filing does not carry interest expense and cash.");
    expect(roText).toBe(
      "Neraportat: această raportare nu conține cheltuielile cu dobânzile și disponibilitățile.",
    );
  });

  it("a zero denominator names the denominator; a summed withheld denominator reads as a sum", () => {
    const zero = side({ reason: { code: "zero_denominator", inputs: ["current liabilities"] } });
    expect(formatRatioSide(zero, "x", "en")).toContain("current liabilities");
    expect(formatRatioSide(zero, "x", "ro")).toContain("datoriile curente");
    const summed = operandWords(["balanceSheet.shortTermDebt+balanceSheet.longTermDebt+canonical_bs.equity"], "en");
    expect(summed).toBe("short-term debt plus long-term debt plus total equity");
    expect(operandWords(["a.b", "balanceSheet.cash", "canonical_bs.total_assets"], "en")).toBe(
      "a.b (no reader word for this input yet), cash and total assets",
    );
  });

  it("an unmapped input is shown by name; no inputs is a sentence, not a hole", () => {
    const unmapped = formatRatioSide(side({ reason: { code: "operand_absent", inputs: ["balanceSheet.goodwill"] } }), "x", "ro");
    printable(unmapped);
    expect(unmapped).toContain("balanceSheet.goodwill");
    const none = formatRatioSide(side({ reason: { code: "operand_absent", inputs: [] } }), "x", "en");
    printable(none);
    expect(none).toContain(bundle("en", "statements.ratioCmp.operandUnnamed"));
  });

  it("every reason sentence differs between EN and RO, with and without inputs", () => {
    const inputs = ["incomeStatement.revenue"];
    const same: string[] = [];
    for (const code of RATIO_REASON_CODES) {
      const s = side({ reason: { code, inputs } });
      const e = formatRatioSide(s, "pct", "en");
      const r = formatRatioSide(s, "pct", "ro");
      printable(e);
      printable(r);
      if (e === r) same.push(code);
      if (RATIO_REASON_CODES_WITH_INPUTS.has(code)) {
        expect(e, code).toContain("revenue");
        expect(r, code).toContain("cifra de afaceri");
      }
    }
    for (const code of [...RATIO_COMPARE_REASON_CODES, ...RATIO_READER_REASONS]) {
      if (bundle("en", `statements.ratioCmp.reason.${code}`) === bundle("ro", `statements.ratioCmp.reason.${code}`)) {
        same.push(code);
      }
    }
    expect(same, `English under RO for: ${same.join(", ")}`).toEqual([]);
  });

  it("the sentences that carry {{inputs}} are exactly the codes declared to", () => {
    const withInputs = RATIO_REASON_CODES.filter((c) =>
      bundle("en", `statements.ratioCmp.reason.${c}`).includes("{{inputs}}"),
    );
    expect(new Set(withInputs)).toEqual(RATIO_REASON_CODES_WITH_INPUTS);
  });

  it("a null delta prints its reason_code sentence; an unlisted code is named", () => {
    const d = formatRatioDelta(delta({ unit: "days", value: null, reason_code: "non_finite" }), "ro");
    printable(d.primary);
    expect(d.primary).toBe(bundle("ro", "statements.ratioCmp.reason.non_finite"));
    // `prior_refused` WAS the unlisted example here until ratio_compare.py
    // declared it (B4); it now prints its own sentence, and a code no
    // engine tuple declares is the unlisted case.
    const declared = formatRatioDelta(delta({ unit: "days", value: null, reason_code: "prior_refused" }), "en");
    printable(declared.primary);
    expect(declared.primary).toBe(bundle("en", "statements.ratioCmp.reason.prior_refused"));
    const unlisted = formatRatioDelta(delta({ unit: "days", value: null, reason_code: "brand_new_delta_code" }), "en");
    printable(unlisted.primary);
    expect(unlisted.primary).toContain("brand_new_delta_code");
  });

  it("a missing reason, a missing side and an unlisted reason are all visible sentences", () => {
    const unstated = formatRatioSide(side(), "pct", "en");
    printable(unstated);
    expect(unstated).toBe(bundle("en", "statements.ratioCmp.reason.unstated"));
    const unlisted = formatRatioSide(side({ reason: { code: "brand_new_code", inputs: [] } }), "pct", "ro");
    printable(unlisted);
    expect(unlisted).toContain("brand_new_code");
    expect(formatRatioSide(null, "pct", "en")).toBe(bundle("en", "statements.ratioCmp.reason.period_absent"));
    expect(formatRatioBand(null, "ro")).toBe(bundle("ro", "statements.ratioCmp.reason.period_absent"));
  });

  it("a same-band movement prints the held sentence with its band word", () => {
    const held = movement({ status: "same_band", from: "watch", to: "watch" });
    expect(formatRatioMovement(held, "en")).toBe(`${bundle("en", "statements.ratioCmp.movement.held").replace("{{band}}", "Watch")}`);
    expect(formatRatioMovement(held, "en")).toBe("Unchanged: Watch");
    expect(formatRatioMovement(held, "ro")).toBe("Neschimbat: De urmărit");
    const letter = movement({ status: "same_band", from: "BBB", to: "BBB" });
    expect(formatRatioMovement(letter, "ro")).toBe("Neschimbat: BBB");
  });

  it("a not-comparable movement prints its reason", () => {
    const text = formatRatioMovement(movement({ status: "not_comparable", reason_code: "sector_unconfirmed" }), "ro");
    printable(text);
    expect(text).toBe(bundle("ro", "statements.ratioCmp.reason.sector_unconfirmed"));
  });

  it("an unrecognised served enum value is named, never printed as a word or left blank", () => {
    const cases: [string, string, string][] = [
      [formatRatioMovement(movement({ status: "rebanded" as never }), "en"), "movement.status", '"rebanded"'],
      [formatRatioMovement(movement({ status: "same_band", to: null }), "ro"), "movement.to", "null"],
      [formatRatioMovement(movement({ status: "crossed_up", from: "okay" as never, rungs_crossed: 1 }), "en"), "movement.from", '"okay"'],
      [formatRatioBand(side({ value_q: "1.20", band_status: "graded", band: null }), "en"), "band", "null"],
      [formatRatioBand(side({ value_q: "1.20", band_status: "graded", band: "fine" as never }), "ro"), "band", '"fine"'],
      [formatRatioBand(side({ value_q: "1.20", band_status: "rebanded" as never }), "ro"), "band_status", '"rebanded"'],
    ];
    for (const [text, field, value] of cases) {
      printable(text);
      expect(text).not.toContain("undefined");
      expect(text).toContain(field);
      expect(text).toContain(value);
    }
  });

  it("band words use the one spelling the tile uses; every served status has its own word", () => {
    expect(bandWordKey("watch")).toBe("dashV2.ratioVerdictWatch");
    expect(bandWordKey(null)).toBe("dashV2.ratioVerdictUnknown");
    expect(bandWordKey("BBB")).toBe("");
    expect(formatRatioBand(side({ band: "BBB" }), "ro")).toBe("BBB");
    expect(formatRatioBand(side({ band: "strong" }), "ro")).toBe(bundle("ro", "dashV2.ratioVerdictStrong"));
    const words: Record<string, [string, string]> = {};
    for (const status of RATIO_BAND_STATUSES) {
      if (status === "graded") continue;
      const s = side({ value_q: "1.20", band_status: status });
      const e = formatRatioBand(s, "en");
      const r = formatRatioBand(s, "ro");
      printable(e);
      printable(r);
      expect(e, status).not.toContain("recognise");
      words[status] = [e, r];
    }
    expect(Object.keys(words).length).toBe(RATIO_BAND_STATUSES.length - 1);
    // A present value is never labelled "Not reported" unless it was refused.
    expect(words.not_banded[0]).not.toBe(bundle("en", "dashV2.ratioVerdictUnknown"));
    expect(words.withheld_basis[1]).not.toBe(bundle("ro", "dashV2.ratioVerdictUnknown"));
  });
});

// ── G4 ────────────────────────────────────────────────────────────────

describe("G4 statements.ratioCmp EN/RO parity and the key census", () => {
  const flatten = (bag: unknown, prefix = ""): Map<string, string> => {
    const out = new Map<string, string>();
    if (typeof bag === "string") {
      out.set(prefix, bag);
      return out;
    }
    if (bag && typeof bag === "object") {
      for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
        for (const [kk, vv] of flatten(v, prefix ? `${prefix}.${k}` : k)) out.set(kk, vv);
      }
    }
    return out;
  };
  const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

  const enBag = flatten((en as { statements: { ratioCmp: unknown } }).statements.ratioCmp, "statements.ratioCmp");
  const roBag = flatten((ro as { statements: { ratioCmp: unknown } }).statements.ratioCmp, "statements.ratioCmp");

  it("the bundle is not empty (non-vacuity)", () => {
    expect(enBag.size).toBeGreaterThanOrEqual(RATIO_REASON_CODES.length + RATIO_DISPLAY_UNITS.length);
  });

  it("the same keys exist in EN and RO", () => {
    const onlyEn = [...enBag.keys()].filter((k) => !roBag.has(k));
    const onlyRo = [...roBag.keys()].filter((k) => !enBag.has(k));
    expect(onlyEn, `missing in ro: ${onlyEn.join(", ")}`).toEqual([]);
    expect(onlyRo, `missing in en: ${onlyRo.join(", ")}`).toEqual([]);
  });

  it("every key the formatter can resolve is a non-empty string in BOTH bundles", () => {
    const census = ratioCmpKeyCensus();
    expect(census.length).toBeGreaterThan(60);
    const missing: string[] = [];
    for (const key of census) {
      for (const lang of ["en", "ro"] as const) {
        try {
          bundle(lang, key);
        } catch {
          missing.push(`${lang}:${key}`);
        }
      }
    }
    expect(missing, `census keys missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("every key literal in ratioTable.ts is in the census, and the bundle has no orphan key", () => {
    const census = new Set(ratioCmpKeyCensus());
    const src = readFileSync(resolve(__dirname, "../ratioTable.ts"), "utf8");
    const literals = [...src.matchAll(/["`]((?:statements\.ratioCmp|dashV2)\.[A-Za-z_.]+)(?=["`$])/g)]
      .map((m) => m[1])
      .filter((k) => !k.endsWith("."));
    expect(literals.length).toBeGreaterThan(15);
    const outside = literals.filter((k) => !census.has(k));
    expect(outside, `resolved but not in census: ${outside.join(", ")}`).toEqual([]);
    const orphans = [...enBag.keys()].filter((k) => !census.has(k));
    expect(orphans, `bundle keys no formatter path resolves: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every key carries the same placeholders in both languages, and no empty value", () => {
    const mismatched: string[] = [];
    for (const [k, v] of enBag) {
      const r = roBag.get(k);
      if (r === undefined) continue;
      if (v.trim() === "" || r.trim() === "") mismatched.push(`${k} (empty)`);
      if (placeholders(v).join() !== placeholders(r).join()) mismatched.push(k);
    }
    expect(mismatched).toEqual([]);
  });

  it("no string writes a number (TC-10: thresholds render from data, never prose)", () => {
    const withDigits = [...enBag, ...roBag].filter(([, v]) => /\d/.test(v)).map(([k]) => k);
    expect(withDigits).toEqual([]);
  });

  it("reasonKey maps declared codes to their key and anything else to a named sentence", () => {
    for (const code of RATIO_REASON_CODES) expect(reasonKey(code)).toBe(`statements.ratioCmp.reason.${code}`);
    expect(reasonKey(null)).toBe("statements.ratioCmp.reason.unstated");
    expect(reasonKey("brand_new_code")).toBe("statements.ratioCmp.reason.unlisted");
  });
});

// ── G5 ────────────────────────────────────────────────────────────────

/** String members of a Python `NAME ... = ( ... )` tuple literal. */
const pyTuple = (src: string, name: string): { count: number; members: string[] } => {
  const assigns = [...src.matchAll(new RegExp(`^${name}\\b[^=\\n]*=`, "gm"))];
  const m = src.match(new RegExp(`^${name}\\b[^=\\n]*=\\s*\\(([\\s\\S]*?)^\\)`, "m"));
  const body = (m?.[1] ?? "").replace(/#.*$/gm, "");
  return { count: assigns.length, members: [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]) };
};

/** Bodies of every call `fn(...)`, parentheses balanced, strings skipped. */
const callBodies = (src: string, fn: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${fn}\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/def\s+$/.test(src.slice(Math.max(0, m.index - 4), m.index))) continue;
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    let quote: string | null = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
};

/** Top-level comma split of a call body. */
const topArgs = (body: string): string[] => {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
};

describe("G5 the reader's enums are the engine's (src/engine/ratios/table.py)", () => {
  const src = readFileSync(ENGINE_TABLE, "utf8");

  it("RATIO_REASON_CODES is REASON_CODES, member for member and in order", () => {
    const py = pyTuple(src, "REASON_CODES");
    expect(py.count, "REASON_CODES assigned more than once in table.py").toBe(1);
    expect(py.members.length).toBeGreaterThanOrEqual(10);
    expect([...RATIO_REASON_CODES]).toEqual(py.members);
  });

  it("RATIO_BAND_STATUSES is BAND_STATUSES, member for member and in order", () => {
    const py = pyTuple(src, "BAND_STATUSES");
    expect(py.count, "BAND_STATUSES assigned more than once in table.py").toBe(1);
    expect(py.members.length).toBeGreaterThanOrEqual(4);
    expect([...RATIO_BAND_STATUSES]).toEqual(py.members);
  });

  it("every input name table.py can emit has an operand word (TC-12 coverage)", () => {
    // Anchors: the three leaf readers build their source path this way.
    expect(src).toContain('"balanceSheet." + k');
    expect(src).toContain('"incomeStatement." + k');
    expect(src).toContain('"canonical_bs." + concept');
    expect(src).toContain('"assembled_bs." + legacy');
    const names = new Set<string>();
    // G reads the served totals through _gateway_totals, which labels each
    // one canonical_bs.<concept> (tier 1) or assembled_bs.<legacy> (tier 2);
    // both label sets come from the _TOTAL_CONCEPTS pairs.
    for (const pair of src.matchAll(/\("(\w+)",\s*"(\w+)"\)/g)) {
      if (src.indexOf(pair[0]) > src.indexOf("_TOTAL_CONCEPTS") && src.indexOf(pair[0]) < src.indexOf("def _gateway_totals")) {
        names.add("canonical_bs." + pair[1]);
        names.add("assembled_bs." + pair[2]);
      }
    }
    for (const [fn, prefix] of [["B", "balanceSheet."], ["I", "incomeStatement."], ["G", "canonical_bs."]] as const) {
      for (const body of callBodies(src, fn)) {
        const lit = body.match(/^\s*"(\w+)"\s*$/);
        if (lit) names.add(prefix + lit[1]);
      }
    }
    // Every _leaf source is a literal or one of the three anchored forms.
    const leafSources = callBodies(src, "_leaf").map((b) => topArgs(b)[1]);
    expect(leafSources.length).toBeGreaterThan(3);
    for (const arg of leafSources) {
      const lit = arg.match(/^"([^"]+)"$/);
      if (lit) names.add(lit[1]);
      else if (arg === "source") expect(src, "G's source must come from _gateway_totals").toContain("value, source = totals[concept]");
      else expect(arg, "a _leaf source outside the anchored forms").toMatch(/^"(balanceSheet|incomeStatement|canonical_bs)\." \+ \w+$/);
    }
    for (const m of src.matchAll(/"((?:supplementary|industry_signal|assembled_pl|incomeStatement|balanceSheet|canonical_bs)\.\w+)"/g)) {
      names.add(m[1]);
    }
    for (const fn of ["_div", "_pct_of"]) {
      for (const body of callBodies(src, fn)) {
        const last = topArgs(body).at(-1) ?? "";
        const lit = last.match(/^"([^"]+)"$/);
        // A constant denominator ("8") can never be zero or negative.
        if (lit && /[A-Za-z]/.test(lit[1])) names.add(lit[1]);
      }
    }
    const all = [...names].sort();
    const unmapped = all.filter((n) => !(n in RATIO_OPERAND_WORD));
    const coverage = `${all.length - unmapped.length}/${all.length} engine input names have a word`;
    expect(all.length, coverage).toBeGreaterThanOrEqual(30);
    expect(unmapped, `${coverage}; unmapped: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("ratio_compare.py, once it exists, declares only codes this reader has a sentence for", () => {
    if (!existsSync(ENGINE_COMPARE)) {
      // Measured state on this branch: B4 has not landed. The assertion is
      // on the absence itself, so the gate switches on when the file does.
      expect(existsSync(ENGINE_COMPARE)).toBe(false);
      return;
    }
    const cmp = readFileSync(ENGINE_COMPARE, "utf8");
    const tuples = [...cmp.matchAll(/^([A-Z_]*REASON_CODES)\b[^=\n]*=/gm)].map((m) => m[1]);
    expect(tuples.length, "ratio_compare.py emits reason codes but declares no *REASON_CODES tuple").toBeGreaterThan(0);
    const declared = tuples.flatMap((name) => pyTuple(cmp, name).members);
    const noSentence = declared.filter((c) => reasonKey(c) === "statements.ratioCmp.reason.unlisted");
    expect(noSentence, `engine codes with no reader sentence: ${noSentence.join(", ")}`).toEqual([]);
    // The mirror is the composer's declaration, de-duplicated in order —
    // no reader-only code and no engine code left out.
    expect([...RATIO_COMPARE_REASON_CODES]).toEqual([...new Set(declared)]);
  });
});
