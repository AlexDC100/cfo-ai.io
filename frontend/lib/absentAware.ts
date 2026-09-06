// ARITHMETIC THAT CAN SAY "I DON'T KNOW", AND SAY WHY.
//
// ── why this module exists ─────────────────────────────────────────────
//
// `financialReport.ts` computed every ratio through one line:
//
//     const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b);
//
// Two lies in fourteen characters. A division by zero is UNDEFINED, not
// zero — and worse, by the time a value reached `safeDiv` an ABSENT input
// had already become a `0` somewhere upstream, so the function was
// dividing by a figure the filing never reported and returning a
// confident number for it. On the repo's own real AAPL fixture that
// produced `interest_coverage 0.00x critical` for a company whose EBIT in
// the same file is 123,216,000,000 — the interest expense is simply not
// in the feed. The figure then wore a provenance card reading
// "derived · computeRatios · interest_coverage", a receipt for a number
// nothing computed.
//
// ── the shape ─────────────────────────────────────────────────────────
//
// A `Fig` is a number that may be absent, and an absent one CARRIES ITS
// REASON. That second half is the point: a refusal a reader cannot act on
// ("—") teaches them the product is broken; a refusal that names the
// missing input ("this filing does not carry interest expense") teaches
// them something true about their data.
//
// Reasons combine the way the arithmetic does. Add three figures where
// two are missing and the result names both, so a refusal upstream never
// gets rewritten into a vaguer one downstream.
//
// ── the rules, stated once ────────────────────────────────────────────
//
//   · ABSENT + anything = ABSENT. There is no neutral element for a
//     figure that was never reported: adding 0 for it asserts it is zero.
//   · x / 0 = ABSENT, with reason `undefined_ratio`. Distinct from a
//     missing input, because the reader's next step differs: one is "your
//     filing is incomplete", the other is "this quantity has no value for
//     this company".
//   · x / ABSENT = ABSENT, reason `missing`.
//   · A NON-FINITE number entering the algebra is ABSENT, not a value.
//
// Nothing here formats, and nothing here decides copy — `financialReport`
// owns the ratio vocabulary and the UI owns the wording.

/** Why a figure has no value. */
export type FigureAbsence =
  /** One or more inputs were not carried by the source. `inputs` are
   *  canonical field names; the UI maps them to reader-facing words. */
  | { kind: "missing"; inputs: readonly string[] }
  /** Every input was present, but the ratio is undefined — the
   *  denominator is zero. `denominator` names which one. */
  | { kind: "undefined_ratio"; denominator: string };

/** A number, or an absence that knows why. */
export interface Fig {
  readonly value: number | null;
  readonly absence: FigureAbsence | null;
}

const PRESENT_CACHE_NONE: FigureAbsence | null = null;

/** A figure that is present. Non-finite input is an absence, not a value:
 *  a NaN that reached here came out of arithmetic on something missing. */
export function num(name: string, v: number | null | undefined): Fig {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { value: null, absence: { kind: "missing", inputs: [name] } };
  }
  return { value: v, absence: PRESENT_CACHE_NONE };
}

/** A figure known to be present — a constant, a day count, a coefficient.
 *  Takes no name because it can never be the reason for a refusal. */
export function known(v: number): Fig {
  return Number.isFinite(v)
    ? { value: v, absence: PRESENT_CACHE_NONE }
    : { value: null, absence: { kind: "missing", inputs: ["(non-finite constant)"] } };
}

/** An absence declared directly — the source told us it did not carry
 *  this. Same shape as a non-finite `num`, stated at the call site so the
 *  intent is readable. */
export function absent(...inputs: string[]): Fig {
  return { value: null, absence: { kind: "missing", inputs } };
}

/** Union the reasons of several figures. `missing` wins over
 *  `undefined_ratio` when both are present in one expression: an input
 *  that was never reported is the more actionable of the two, and a
 *  denominator that is "zero" only because an absent term was read as
 *  zero is not really a zero denominator at all. */
function combine(figs: readonly Fig[]): FigureAbsence | null {
  const inputs: string[] = [];
  let undef: FigureAbsence | null = null;
  for (const f of figs) {
    const a = f.absence;
    if (!a) continue;
    if (a.kind === "missing") {
      for (const i of a.inputs) if (inputs.indexOf(i) < 0) inputs.push(i);
    } else if (!undef) {
      undef = a;
    }
  }
  if (inputs.length > 0) return { kind: "missing", inputs };
  return undef;
}

function fold(figs: readonly Fig[], f: (values: number[]) => number): Fig {
  const absence = combine(figs);
  if (absence) return { value: null, absence };
  const out = f(figs.map((x) => x.value as number));
  return Number.isFinite(out)
    ? { value: out, absence: PRESENT_CACHE_NONE }
    : { value: null, absence: { kind: "missing", inputs: ["(non-finite result)"] } };
}

export function add(...figs: Fig[]): Fig {
  return fold(figs, (v) => v.reduce((a, b) => a + b, 0));
}

export function sub(a: Fig, b: Fig): Fig {
  return fold([a, b], ([x, y]) => x - y);
}

export function mul(...figs: Fig[]): Fig {
  return fold(figs, (v) => v.reduce((a, b) => a * b, 1));
}

/**
 * a / b. ABSENT when either side is; ABSENT with reason
 * `undefined_ratio` when the denominator is a real, reported zero.
 *
 * `denominatorName` is what the refusal will call it, so it reads as the
 * product's own vocabulary rather than as a field name.
 */
export function div(a: Fig, b: Fig, denominatorName: string): Fig {
  const absence = combine([a, b]);
  if (absence) return { value: null, absence };
  const bv = b.value as number;
  if (bv === 0) {
    return { value: null, absence: { kind: "undefined_ratio", denominator: denominatorName } };
  }
  const out = (a.value as number) / bv;
  return Number.isFinite(out)
    ? { value: out, absence: PRESENT_CACHE_NONE }
    : { value: null, absence: { kind: "undefined_ratio", denominator: denominatorName } };
}

/** a / b × 100. Same refusals; the ×100 is a unit change, not a term. */
export function pctOf(a: Fig, b: Fig, denominatorName: string): Fig {
  return mul(div(a, b, denominatorName), known(100));
}

/** The larger of a figure and a constant floor — used where a formula
 *  guards its own denominator (`max(debt + equity, 1)`). Absence passes
 *  straight through: flooring an unknown does not make it known. */
export function atLeast(f: Fig, floor: number): Fig {
  return f.value === null ? f : known(Math.max(f.value, floor));
}
