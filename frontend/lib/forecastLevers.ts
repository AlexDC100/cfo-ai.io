// FORECAST LEVERS — turning what the reader moves into the body the engine
// accepts, and back.
//
// ── NO FLOAT EVER GOES ON THE WIRE ──────────────────────────────────────
//
// fp1.2 3.12: every decimal in the request is a STRING and the engine refuses
// one that is not exact at the driver's own scale — `"1e-1"` comes back 422
// `not_exact`, by name. So a value is parsed into an INTEGER at that scale by
// string arithmetic and rendered back out of it the same way. `Number(text) *
// 1e6` would hand the engine an IEEE-754 result to check for exactness.
//
// ── THE DISPLAYED UNIT IS NOT ALWAYS THE WIRE UNIT ──────────────────────
//
// A rate rides the wire as a ratio (0.025) and belongs on screen as a percent
// (2.5%). That is a display factor, applied here once, beside the parse that
// undoes it — not two conversions in two components that can drift apart. Days
// and money are shown as they are sent.

import {
  exactDecimal,
  type AssumptionRef,
  type LeverRef,
} from "@/lib/forecastFacts";

/** The levers the product offers, in the order they are shown.
 *
 *  Every key here is one the engine DECLARES — `gross margin` and `opex
 *  growth` are not drivers this engine serves (both answer 422
 *  `unknown_driver`), so they are not in this list and the rail says so from
 *  the payload rather than shipping a slider that fakes them. Cost of sales is
 *  a pool split, not a margin, and `inflation` moves the fixed part of every
 *  opex pool — relabelling either one would be the "Revenue / rent" mistake in
 *  a new place. */
export const OFFERED_LEVERS = [
  "revenue_growth",
  "dso_days",
  "dio_cogs_days",
  "dpo_cogs_days",
  "capex_pct_of_revenue",
  "dividend_payout_pct",
] as const;

/** The levers the product ASKED for that this engine does not declare. Not a
 *  hand-written sentence: the caller passes the keys it looked for and this
 *  returns the ones missing from the payload's own driver list. */
export const REQUESTED_BUT_UNDECLARED = ["gross_margin", "opex_growth"] as const;

/** A ratio driver is shown as a percent. Everything else is shown as sent. */
export function displayFactor(lever: LeverRef): number {
  return lever.unit === "ratio" ? lever.scale / 100 : lever.scale;
}

/** The suffix the reader sees beside the number. */
export function displaySuffix(lever: LeverRef): string {
  if (lever.unit === "ratio") return "%";
  if (lever.unit === "days") return "d";
  if (lever.unit === "index") return "×";
  return "";
}

/** A decimal string -> an integer at `factor`, by string arithmetic.
 *
 *  Digits beyond the scale's own precision are DROPPED, not rounded up: the
 *  reader gets a value at or below what they typed, never one the engine would
 *  refuse and never one larger than they asked for. `null` for anything that
 *  is not a plain decimal — no exponent, no separators. */
export function parseDecimal(text: string, factor: number): number | null {
  const m = /^\s*(-)?(\d*)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m) return null;
  if (!m[2] && !m[3]) return null;
  const digits = String(factor).length - 1;
  const frac = (m[3] ?? "").slice(0, digits).padEnd(digits, "0");
  const whole = Number(m[2] || "0");
  if (!Number.isFinite(whole)) return null;
  const scaled = whole * factor + Number(frac || "0");
  if (!Number.isSafeInteger(scaled)) return null;
  return m[1] ? -scaled : scaled;
}

/** What the reader types -> the exact decimal string the engine takes, in the
 *  driver's own natural unit. `null` when the text is not a number at all. */
export function displayToWire(text: string, lever: LeverRef): string | null {
  const scaled = parseDecimal(text, displayFactor(lever));
  if (scaled === null) return null;
  return exactDecimal(scaled, lever.scale);
}

/** The wire value of one plan year, as the reader sees it. */
export function wireToDisplay(wire: string | null, lever: LeverRef): string {
  if (wire === null) return "";
  const scaled = parseDecimal(wire, lever.scale);
  if (scaled === null) return "";
  return exactDecimal(scaled, displayFactor(lever));
}

/** A bound the ENGINE serves, in the displayed unit.
 *
 *  The engine refuses a value outside `bounds` by design — `dso_days: 400 is
 *  outside 0 to 365`. Putting that same bound on the control turns a refusal
 *  the reader has to read into one the control will not let them reach, and it
 *  is the engine's own number either way (TC-10): nothing here is typed, the
 *  wire value is only moved into the unit the cell is shown in. */
export function displayBound(lever: LeverRef, end: "min" | "max"): string | undefined {
  const wire = end === "min" ? lever.bounds.minText : lever.bounds.maxText;
  if (wire === null) return undefined;
  const scaled = parseDecimal(wire, lever.scale);
  if (scaled === null) return undefined;
  return exactDecimal(scaled, displayFactor(lever));
}

/** The step a control moves in, in the displayed unit. The engine's own
 *  `reach_step`, never a number chosen here (TC-10).
 *
 *  A step arrives on the wire in the driver's natural unit, exactly like a
 *  value does, so it converts exactly like one — parse at the WIRE scale, print
 *  at the DISPLAY factor. This used to compose the two the other way round and
 *  rendered the revenue-growth step as `0.0001` on a field measured in percent,
 *  a spinner tick ten thousand times smaller than the 1 pp the pack states. */
export function displayStep(lever: LeverRef): string | undefined {
  if (!lever.stepText) return undefined;
  const scaled = parseDecimal(lever.stepText, lever.scale);
  if (scaled === null) return undefined;
  return exactDecimal(scaled, displayFactor(lever));
}

/** One lever the reader has moved. `values` are wire strings, one per plan
 *  year (or one entry for a scalar driver); `null` leaves that year at the
 *  engine's own default. */
export interface LeverEdit {
  readonly key: string;
  readonly values: readonly (string | null)[];
}

export interface RecomputeBody {
  horizon: { total_years: number; monthly_months: number };
  overrides: Record<string, { values: (string | null)[] }>;
}

/** The POST body. An edit whose values are all null is DROPPED rather than
 *  sent as an empty override — dropping the override is what "reset to the
 *  engine's own value" means on this contract, and sending `[null, null,
 *  null]` would leave the driver flagged `user` with nothing set. */
export function buildRecomputeBody(
  totalYears: number,
  monthlyMonths: number,
  edits: readonly LeverEdit[],
  levers: readonly LeverRef[],
): RecomputeBody {
  const shapeOf = new Map(levers.map((l) => [l.key, l.shape]));
  const overrides: Record<string, { values: (string | null)[] }> = {};
  for (const edit of edits) {
    if (!edit.values.some((v) => v !== null && v !== "")) continue;
    // A per-year override must carry EXACTLY total_years values; three values
    // against a five-year horizon is 422 `override_length`. The page resizes
    // when the horizon changes rather than discovering it on the wire.
    const length = shapeOf.get(edit.key) === "scalar" ? 1 : totalYears;
    const values: (string | null)[] = [];
    for (let i = 0; i < length; i += 1) {
      const v = edit.values[i];
      values.push(v === undefined || v === "" ? null : v);
    }
    overrides[edit.key] = { values };
  }
  return {
    horizon: { total_years: totalYears, monthly_months: monthlyMonths },
    overrides,
  };
}

/** The plan-year labels, in order, taken from the horizon the engine served:
 *  the FY aggregates of the monthly years first, then the annual periods. */
export function planYearLabels(
  horizon: readonly string[],
  horizonAnnual: readonly string[],
): string[] {
  const monthly = /^\d{4}-\d{2}$/;
  return [...horizonAnnual, ...horizon.filter((p) => !monthly.test(p))];
}

// ── The assumption schedule's own display ────────────────────────────────
//
// Lives here, with the lever conversions, rather than on the page: the page
// PAINTS, and every unit conversion in this lane — a ratio shown as a percent,
// a money driver shown in major units — is one decision made in one module. A
// second conversion beside a figure is how a surface ends up contradicting its
// own assumption schedule, which this page has already done once.

/** A driver's value, in its own unit.
 *
 *  Absent renders as the WORDS, never as a zero: a rate the book could not
 *  measure and a rate of 0% are opposite claims, and the driver's own basis
 *  says which one this is.
 *
 *  `valuedFor === null` is a THIRD state and it is not absence — it is the
 *  ref saying nobody asked it about a period. Rendering the absent label
 *  there would put "not measurable from this book" beside a driver supplied
 *  at 8%, which is what this page did until a test caught it. */
export function assumptionValue(
  a: AssumptionRef,
  locale: string,
  absentLabel: string,
): string {
  if (a.unit === "convention") return "—";
  if (a.valuedFor === null) return "—";
  if (a.value === null || a.value === undefined) return absentLabel;
  const n = a.value;
  if (a.unit === "pct" || a.unit === "ratio") {
    return `${(n * 100).toLocaleString(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    })}%`;
  }
  if (a.unit === "index") {
    return `×${n.toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })}`;
  }
  if (a.unit === "days") {
    return `${n.toLocaleString(locale, { maximumFractionDigits: 1 })}`;
  }
  if (a.unit === "money_minor") {
    // Already in MAJOR units: `WIRE_UNITS` divides at the gateway, exactly
    // like `projectedDisplay` does for a figure.
    return n.toLocaleString(locale, { maximumFractionDigits: 0 });
  }
  return n.toLocaleString(locale, { maximumFractionDigits: 0 });
}
