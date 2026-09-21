// changeKind.ts — THE ONE SIGN-FLIP CLASSIFIER, TypeScript twin
// (plan_contract_v2 section 7, R21; batch B1).
//
// A change from a base value to a plan value is one of seven kinds:
//
//   absent_base       the base is null
//   absent_plan       the plan is null
//   compared          both within the zero floor (no percentage), or both
//                     non-zero with the same sign (a percentage)
//   from_zero         the base is within the floor, the plan is not
//   to_zero           the plan is within the floor, the base is not
//   flip_to_negative  base > 0 and plan < 0
//   flip_to_positive  base < 0 and plan > 0
//
// Only "compared" with a non-zero base carries deltaPct. Every other kind
// renders as WORDS beside the absolute change, never as a percent and
// never as a multiplier: 6.1M becoming -107.6M is "turned negative", not
// "-19x" (defect 0.4).
//
// ONE CLASSIFIER PER RUNTIME. src/engine/serving/change_kind.py is the
// Python twin; both are tested against
// tests/fixtures/contracts/change_kind_truth_table.json and must agree to
// the byte. So this module computes on the EXACT value of its inputs: a
// binary64 is a dyadic rational, decomposed here into BigInts, the same
// value Python's Fraction reads. deltaPct is rounded once, half away from
// zero, to changeKindPack.json's delta_pct_places (the pack mirror of
// packs/serving/change_kind.yaml; the Python test reds when they differ).
//
// Pure: no React, no stores, no I/O.

import pack from "./changeKindPack.json";

export type ChangeKind =
  | "compared"
  | "flip_to_negative"
  | "flip_to_positive"
  | "from_zero"
  | "to_zero"
  | "absent_base"
  | "absent_plan";

export const CHANGE_KINDS: readonly ChangeKind[] = [
  "compared",
  "flip_to_negative",
  "flip_to_positive",
  "from_zero",
  "to_zero",
  "absent_base",
  "absent_plan",
];

export interface ChangeResult {
  kind: ChangeKind;
  /** Decimal string with DELTA_PCT_PLACES places, or null. */
  deltaPct: string | null;
}

/** packs/serving/change_kind.yaml#delta_pct_places, via the JSON mirror. */
export const DELTA_PCT_PLACES: number = pack.delta_pct_places;

/** packs/serving/change_kind.yaml#rounded_money_zero_floor — the zero floor
 *  for rounded major-unit money (comparatives' PCT_BASE_FLOOR). Integer
 *  minor units use a floor of 0. */
export const ROUNDED_MONEY_ZERO_FLOOR: number = Number(pack.rounded_money_zero_floor);

interface Rational {
  n: bigint;
  d: bigint;
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

/** The exact rational value of a finite binary64. */
function exact(x: number, name: string): Rational {
  if (typeof x !== "number") throw new TypeError(`${name} must be a number`);
  if (!Number.isFinite(x)) throw new RangeError(`${name} must be finite, got ${x}`);
  if (x === 0) return { n: ZERO, d: ONE };
  if (Number.isSafeInteger(x)) return { n: BigInt(x), d: ONE };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const negative = hi >>> 31 === 1;
  const biased = (hi >>> 20) & 0x7ff;
  const fracHi = BigInt(hi & 0xfffff);
  let mantissa = (fracHi << BigInt(32)) | BigInt(lo);
  let exponent: number;
  if (biased === 0) {
    exponent = -1074; // subnormal
  } else {
    mantissa |= ONE << BigInt(52);
    exponent = biased - 1075;
  }
  const signed = negative ? -mantissa : mantissa;
  if (exponent >= 0) return { n: signed << BigInt(exponent), d: ONE };
  return { n: signed, d: ONE << BigInt(-exponent) };
}

const abs = (v: bigint): bigint => (v < ZERO ? -v : v);

/** a < b for rationals with positive denominators. */
const lessThan = (a: Rational, b: Rational): boolean => a.n * b.d < b.n * a.d;

function render(num: bigint, den: bigint, places: number): string {
  // num / den, den > 0; round once, half away from zero.
  const scaled = abs(num) * TEN ** BigInt(places);
  let whole = scaled / den;
  const rem = scaled % den;
  if (TWO * rem >= den) whole += ONE;
  let digits = whole.toString();
  let text: string;
  if (places > 0) {
    digits = digits.padStart(places + 1, "0");
    text = `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  } else {
    text = digits;
  }
  return num < ZERO && whole !== ZERO ? `-${text}` : text;
}

/**
 * Classify the change from `base` to `plan`. `zeroFloor` is 0 for integer
 * minor units and ROUNDED_MONEY_ZERO_FLOOR for rounded money. A value is
 * within the floor when it is exactly zero or its magnitude is strictly
 * below the floor.
 */
export function classifyChange(
  base: number | null | undefined,
  plan: number | null | undefined,
  zeroFloor: number,
  places: number = DELTA_PCT_PLACES,
): ChangeResult {
  const floor = exact(zeroFloor, "zeroFloor");
  if (floor.n < ZERO) throw new RangeError(`zeroFloor must be non-negative, got ${zeroFloor}`);
  if (base === null || base === undefined) return { kind: "absent_base", deltaPct: null };
  if (plan === null || plan === undefined) return { kind: "absent_plan", deltaPct: null };
  const b = exact(base, "base");
  const p = exact(plan, "plan");
  const within = (v: Rational) => v.n === ZERO || lessThan({ n: abs(v.n), d: v.d }, floor);
  const bZero = within(b);
  const pZero = within(p);
  if (bZero && pZero) return { kind: "compared", deltaPct: null };
  if (bZero) return { kind: "from_zero", deltaPct: null };
  if (pZero) return { kind: "to_zero", deltaPct: null };
  if (b.n > ZERO && p.n < ZERO) return { kind: "flip_to_negative", deltaPct: null };
  if (b.n < ZERO && p.n > ZERO) return { kind: "flip_to_positive", deltaPct: null };
  // (p - b) / |b| = (p.n*b.d - b.n*p.d) / (p.d*b.d) * (b.d / |b.n|)
  const num = (p.n * b.d - b.n * p.d) * b.d;
  const den = p.d * b.d * abs(b.n);
  return { kind: "compared", deltaPct: render(num, den, places) };
}

/** The kinds that render as words, never as a percent or multiplier. */
export function isWordKind(kind: ChangeKind): boolean {
  return kind !== "compared";
}

/** i18n key (locale namespace changeKind) for a word kind. */
export function changeKindWordKey(kind: ChangeKind): string {
  return `changeKind.${kind}`;
}

/** i18n key for "compared, both within the zero floor": no percentage,
 *  no movement. */
export const CHANGE_KIND_NO_CHANGE_KEY = "changeKind.no_change";

/** The ratio as a JS number for a display formatter — only ever from a
 *  served/classified deltaPct string, never recomputed. */
export function deltaPctNumber(result: ChangeResult): number | null {
  return result.kind === "compared" && result.deltaPct !== null ? Number(result.deltaPct) : null;
}
