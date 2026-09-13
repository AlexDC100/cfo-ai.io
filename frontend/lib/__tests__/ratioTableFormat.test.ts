// Gates for the ONE ratio formatter (frontend/lib/ratioTable.ts).
//
// Scope (TC-13): the pure formatter functions and the statements.ratioCmp
// i18n bundle. It does not render any surface; the dashboard, report and
// workbook readers carry their own gates and call these functions.
//
// G1  every unit prints the served string verbatim.
//     Reds AFTER repair on: any reformatting of a served value_q, delta or
//     pct_change (toFixed, Number(), Intl grouping, a dropped sign), any
//     hardcoded unit suffix that bypasses i18n, and a display or delta unit
//     added to the enumeration without a suffix key in both languages.
// G2  delta colour follows the served `favourable`, never the sign or
//     higher_is_better.
//     Reds AFTER repair on: a tone derived from anything but `favourable`,
//     an inverted mapping, and a movement tone that ignores the served
//     status.
// G3  a null side or delta prints the sentence for its served reason code.
//     Reds AFTER repair on: a dash (MONEY_MISSING), an empty cell, a raw
//     key, an English sentence under RO, and a declared reason code with no
//     sentence in either language (TC-12 coverage).
// G4  EN and RO carry the same statements.ratioCmp keys and placeholders,
//     and no string in the bundle writes a number (TC-10).
//     Reds AFTER repair on: a key present in one language only, a
//     placeholder missing from one spelling, and a digit in any value.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { MONEY_MISSING } from "@/lib/money";
import {
  RATIO_DELTA_UNITS,
  RATIO_DISPLAY_UNITS,
  RATIO_READER_REASONS,
  RATIO_REASON_CODES,
  bandWordKey,
  deltaTone,
  formatRatioBand,
  formatRatioDelta,
  formatRatioMovement,
  formatRatioSide,
  movementTone,
  reasonKey,
  type RatioCompareRow,
  type RatioDelta,
  type RatioDisplayUnit,
  type RatioDeltaUnit,
  type RatioSide,
} from "@/lib/ratioTable";

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

const tEn = i18n.getFixedT("en");
const tRo = i18n.getFixedT("ro");

// ── G1 ────────────────────────────────────────────────────────────────

describe("G1 every unit prints the served string verbatim", () => {
  // Served strings chosen so that ANY reformatting shows: a leading "+",
  // a trailing zero, a zero-decimal days figure, three-digit integers.
  const SIDE_CASES: Record<RatioDisplayUnit, { served: string; en: string; ro: string }> = {
    x: { served: "1.80", en: "1.80×", ro: "1,80×" },
    pct: { served: "12.0", en: "12.0%", ro: "12,0%" },
    days: { served: "145", en: "145 days", ro: "145 zile" },
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
    // A null pct_change on turns is a sentence, not a blank.
    const nob = formatRatioDelta(delta({ unit: "turns", value: "+0.22" }), "en");
    expect(nob.secondary).toBe(tEn("statements.ratioCmp.pctNoBase"));
    // Other units carry no secondary.
    expect(formatRatioDelta(delta({ unit: "pp", value: "+1.0", pct_change: "9.9" }), "en").secondary).toBeNull();
  });

  it("singular only for the served string '1', a string comparison", () => {
    expect(formatRatioDelta(delta({ unit: "days", value: "+1" }), "en").primary).toBe("+1 day");
    expect(formatRatioDelta(delta({ unit: "notches", value: "-1" }), "ro").primary).toBe("-1 treaptă");
    expect(formatRatioDelta(delta({ unit: "points", value: "+1.0" }), "en").primary).toBe("+1.0 pts");
  });

  it("refuses a served string that is not a plain decimal instead of printing it", () => {
    const refusal = tEn("statements.ratioCmp.reason.malformed_value");
    expect(formatRatioSide(side({ value_q: "1E+2" }), "days", "en")).toBe(refusal);
    expect(formatRatioDelta(delta({ unit: "pp", value: "NaN" }), "en").primary).toBe(refusal);
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
    movement: {
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
    },
    finding_id: null,
  };

  it("improved under higher_is_better=false renders the improved tone", () => {
    expect(dso.higher_is_better).toBe(false);
    expect(dso.delta.value?.startsWith("-")).toBe(true);
    expect(deltaTone(dso.delta.favourable)).toBe("success");
  });

  it("deteriorated with a positive delta renders the deteriorated tone", () => {
    expect(deltaTone("deteriorated")).toBe("alert");
  });

  it("none and null are neutral", () => {
    expect(deltaTone("none")).toBe("neutral");
    expect(deltaTone(null)).toBe("neutral");
  });

  it("movement tone reads the served status, and a contradiction is amber", () => {
    const up = { ...dso.movement, status: "crossed_up" as const, from: "watch" as const, rungs_crossed: 1 };
    const down = { ...dso.movement, status: "crossed_down" as const, to: "watch" as const, rungs_crossed: -1 };
    expect(movementTone(up)).toBe("success");
    expect(movementTone(down)).toBe("alert");
    expect(movementTone(dso.movement)).toBe("neutral");
    expect(movementTone({ ...up, rungs_crossed: -1 })).toBe("caution");
    expect(movementTone({ ...dso.movement, status: "not_comparable", reason_code: "band_not_graded" })).toBe("neutral");
    expect(formatRatioMovement(up, "en")).toBe("Watch → Healthy");
    expect(formatRatioMovement(up, "ro")).toBe("De urmărit → Sănătos");
  });
});

// ── G3 ────────────────────────────────────────────────────────────────

describe("G3 a null prior prints its served reason, never a dash", () => {
  const forbidden = (text: string) => {
    expect(text).not.toBe(MONEY_MISSING);
    expect(text).not.toBe("");
    expect(text).not.toBe("-");
    expect(text).not.toMatch(/^statements\./);
  };

  it("a refused prior side prints the reason sentence in EN and RO", () => {
    const prior = side({ value_q: null, band_status: "refused", reason: { code: "denominator_zero", inputs: ["revenue"] } });
    const enText = formatRatioSide(prior, "x", "en");
    const roText = formatRatioSide(prior, "x", "ro");
    forbidden(enText);
    forbidden(roText);
    expect(enText).toBe(tEn("statements.ratioCmp.reason.denominator_zero"));
    expect(roText).toBe(tRo("statements.ratioCmp.reason.denominator_zero"));
    expect(roText).not.toBe(enText);
  });

  it("a null delta prints its reason_code sentence", () => {
    const d = delta({ unit: "days", value: null, reason_code: "prior_refused" });
    const out = formatRatioDelta(d, "en");
    forbidden(out.primary);
    expect(out.primary).toBe(tEn("statements.ratioCmp.reason.prior_refused"));
  });

  it("a missing reason and an unlisted reason are both visible sentences", () => {
    const unstated = formatRatioSide(side(), "pct", "en");
    forbidden(unstated);
    expect(unstated).toBe(tEn("statements.ratioCmp.reason.unstated"));
    const unlisted = formatRatioSide(side({ reason: { code: "brand_new_code", inputs: [] } }), "pct", "en");
    forbidden(unlisted);
    expect(unlisted).toContain("brand_new_code");
    expect(formatRatioSide(null, "pct", "en")).toBe(tEn("statements.ratioCmp.reason.period_absent"));
  });

  it("a not-comparable movement prints its reason", () => {
    const text = formatRatioMovement(
      {
        status: "not_comparable", from: null, to: "watch", rungs_crossed: 0, rung_crossed: null,
        distance_past_rung: null, band_width: null, band_width_basis: null, distance_fraction: null,
        materiality: null, reason_code: "band_not_graded",
      },
      "ro",
    );
    forbidden(text);
    expect(text).toBe(tRo("statements.ratioCmp.reason.band_not_graded"));
  });

  it("every declared reason code has a sentence in both languages (TC-12 coverage)", () => {
    const codes = [...RATIO_REASON_CODES, ...RATIO_READER_REASONS];
    expect(codes.length).toBeGreaterThan(10);
    const dig = (bag: unknown, key: string) =>
      key.split(".").reduce<unknown>((n, p) => (n && typeof n === "object" ? (n as Record<string, unknown>)[p] : undefined), bag);
    const missing: string[] = [];
    for (const code of codes) {
      const key = code === "unstated" || code === "unlisted" || code === "malformed_value"
        ? `statements.ratioCmp.reason.${code}`
        : reasonKey(code);
      expect(key).toBe(`statements.ratioCmp.reason.${code}`);
      for (const [lang, bag] of [["en", en], ["ro", ro]] as const) {
        if (typeof dig(bag, key) !== "string") missing.push(`${lang}:${key}`);
      }
    }
    expect(missing, `reason sentences missing: ${missing.join(", ")}`).toEqual([]);
    expect(reasonKey(null)).toBe("statements.ratioCmp.reason.unstated");
    expect(reasonKey("brand_new_code")).toBe("statements.ratioCmp.reason.unlisted");
  });

  it("band words use the one spelling the tile uses; statuses carry their own word", () => {
    expect(bandWordKey("watch")).toBe("dashV2.ratioVerdictWatch");
    expect(bandWordKey(null)).toBe("dashV2.ratioVerdictUnknown");
    expect(bandWordKey("BBB")).toBeNull();
    expect(formatRatioBand(side({ band: "BBB" }), "ro")).toBe("BBB");
    expect(formatRatioBand(side({ band: "strong" }), "ro")).toBe(tRo("dashV2.ratioVerdictStrong"));
    expect(formatRatioBand(side({ band_status: "ungraded_sector" }), "en")).toBe(tEn("dashV2.ratioVerdictUngraded"));
    expect(formatRatioBand(side({ band_status: "withheld_sign" }), "en")).toBe(tEn("statements.ratioCmp.band.withheldSign"));
  });
});

// ── G4 ────────────────────────────────────────────────────────────────

describe("G4 statements.ratioCmp EN/RO parity", () => {
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

  const enBag = flatten((en as { statements: { ratioCmp: unknown } }).statements.ratioCmp);
  const roBag = flatten((ro as { statements: { ratioCmp: unknown } }).statements.ratioCmp);

  it("the bundle is not empty (non-vacuity)", () => {
    expect(enBag.size).toBeGreaterThanOrEqual(RATIO_REASON_CODES.length + RATIO_DISPLAY_UNITS.length);
  });

  it("the same keys exist in EN and RO", () => {
    const onlyEn = [...enBag.keys()].filter((k) => !roBag.has(k));
    const onlyRo = [...roBag.keys()].filter((k) => !enBag.has(k));
    expect(onlyEn, `missing in ro: ${onlyEn.join(", ")}`).toEqual([]);
    expect(onlyRo, `missing in en: ${onlyRo.join(", ")}`).toEqual([]);
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
});
