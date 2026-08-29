// THE INSTRUMENT — number presentation engine (Prompt 11, Part A1).
//
// This module owns HOW a figure is allowed to appear on screen. It is
// deliberately pure (no React, no stores) so gate D9 can test every rule
// as a table. The <Amount> component is the only intended consumer;
// screens never call Intl directly for data values.
//
// Rules encoded here, each with a named rationale:
//
//  MAGNITUDE GROUPS — a row of KPIs picks ONE scale for all members.
//    "15,1 M€" beside "41.944,6 €" reads as two different instruments;
//    a group renders "15,1 M€" / "0,04 M€" instead, full precision in
//    the provenance tooltip. Mixed formats in one row are impossible by
//    construction because the scale is computed from the whole group.
//
//  PERCENTAGE SANITY — |Δ| ≤ 999% renders as a percent; beyond that a
//    percent stops carrying meaning for a reader ("↓10834.3%") and the
//    value renders as a signed multiplier ("−108×"), exact percent in
//    the tooltip.
//
//  CAPPED VALUES — a cap renders as "≥99×", never a bare ">99×": the
//    instrument states the bound it is sure of, the tooltip carries the
//    computed value.
//
//  ACCOUNTING NEGATIVES — negatives render in parentheses, the ledger
//    convention, with a non-breaking hair space between number and
//    currency so a wrapped line can never orphan the symbol.
//
// Locale follows the UI LANGUAGE setting (ro-RO: 1.234.567,8 · en:
// 1,234,567.8) — per the A1 spec, and unlike lib/money.ts whose legacy
// surfaces follow the currency. New Instrument surfaces use this module.

export type AmountKind = "money" | "percent" | "multiple" | "count";

export interface Magnitude {
  /** Divisor applied to raw values before formatting. */
  divisor: number;
  /** Suffix rendered after the number ("M", "k", or ""). */
  suffix: string;
  /** Fraction digits appropriate for this scale. */
  fractionDigits: number;
}

export const MAGNITUDE_UNIT: Magnitude = { divisor: 1, suffix: "", fractionDigits: 0 };
export const MAGNITUDE_K: Magnitude = { divisor: 1e3, suffix: "k", fractionDigits: 1 };
export const MAGNITUDE_M: Magnitude = { divisor: 1e6, suffix: "M", fractionDigits: 1 };
export const MAGNITUDE_B: Magnitude = { divisor: 1e9, suffix: "B", fractionDigits: 2 };

/** One scale for the whole group: the LARGEST member decides, so small
 *  members render as "0,04 M" rather than dragging the group down to a
 *  unit scale that would print the large ones as walls of digits. */
export function pickMagnitude(values: Array<number | null | undefined>): Magnitude {
  let max = 0;
  for (const v of values) {
    if (typeof v === "number" && isFinite(v)) max = Math.max(max, Math.abs(v));
  }
  if (max >= 1e9) return MAGNITUDE_B;
  if (max >= 1e6) return MAGNITUDE_M;
  if (max >= 1e5) return MAGNITUDE_K;
  return MAGNITUDE_UNIT;
}

const LOCALE_ALIASES: Record<string, string> = { ro: "ro-RO", en: "en-US" };

function resolveLocale(locale: string | undefined): string {
  if (!locale) return "en-US";
  return LOCALE_ALIASES[locale] ?? locale;
}

const _nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, min: number, max: number): Intl.NumberFormat {
  const key = `${locale}|${min}|${max}`;
  let f = _nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
      useGrouping: true,
    });
    _nfCache.set(key, f);
  }
  return f;
}

/** Em-dash: value ABSENT (never a stand-in for a real zero). */
export const AMOUNT_MISSING = "—";

/** Narrow no-break space — the thin joint between number and unit. */
const NNBSP = " ";

export interface FormatAmountOptions {
  locale?: string;
  currency?: string | null;
  magnitude?: Magnitude;
  /** Override fraction digits (else the magnitude decides). */
  fractionDigits?: number;
  /** Accounting negatives (parentheses). Default true for money. */
  accounting?: boolean;
  /** Force an explicit + on positive values (delta chips). */
  signed?: boolean;
}

export function formatAmount(
  value: number | null | undefined,
  opts: FormatAmountOptions = {},
): string {
  if (value == null || !isFinite(value)) return AMOUNT_MISSING;
  const locale = resolveLocale(opts.locale);
  const mag = opts.magnitude ?? MAGNITUDE_UNIT;
  const scaled = value / mag.divisor;
  const digits =
    opts.fractionDigits ?? (mag === MAGNITUDE_UNIT && Number.isInteger(value) ? 0 : mag.fractionDigits);
  const accounting = opts.accounting ?? Boolean(opts.currency);

  const body = nf(locale, digits, digits).format(Math.abs(scaled));
  const unit = [mag.suffix, opts.currency ?? ""].filter(Boolean).join("");
  const withUnit = unit ? `${body}${NNBSP}${unit}` : body;

  if (scaled < 0) {
    // Ledger convention. The parentheses hug the WHOLE figure, unit
    // included, so "(15,1 M€)" scans as one negative object.
    if (accounting) return `(${withUnit})`;
    return `−${withUnit}`; // true minus, not hyphen
  }
  if (opts.signed && scaled > 0) return `+${withUnit}`;
  return withUnit;
}

export interface PercentResult {
  /** What the screen shows ("+12,4%" or "−108×"). */
  display: string;
  /** True when the value crossed the 999% sanity bound. */
  asMultiplier: boolean;
  /** The exact percent, formatted, for the tooltip. */
  exactPercent: string;
}

/** |Δ| ≤ 999% renders as a percent; beyond that, a signed multiplier.
 *  `value` is the RATIO delta (0.124 = +12.4%). */
export function formatPercentDelta(
  value: number | null | undefined,
  opts: { locale?: string; fractionDigits?: number } = {},
): PercentResult | null {
  if (value == null || !isFinite(value)) return null;
  const locale = resolveLocale(opts.locale);
  const pct = value * 100;
  const digits = opts.fractionDigits ?? 1;
  const exact = `${pct >= 0 ? "+" : "−"}${nf(locale, digits, digits).format(Math.abs(pct))}%`;
  if (Math.abs(pct) <= 999) {
    return { display: exact, asMultiplier: false, exactPercent: exact };
  }
  const mult = Math.round(Math.abs(value));
  return {
    display: `${value >= 0 ? "+" : "−"}${nf(locale, 0, 0).format(mult)}×`,
    asMultiplier: true,
    exactPercent: exact,
  };
}

export interface MultipleResult {
  display: string;
  capped: boolean;
  /** Exact value for the tooltip when capped. */
  exact: string;
}

/** A ratio multiple ("1,52×"), with the ≥cap discipline: a capped value
 *  states the bound it is sure of ("≥99×"), never a bare ">". */
export function formatMultiple(
  value: number | null | undefined,
  opts: { locale?: string; cap?: number; fractionDigits?: number } = {},
): MultipleResult | null {
  if (value == null || !isFinite(value)) return null;
  const locale = resolveLocale(opts.locale);
  const digits = opts.fractionDigits ?? 2;
  const exact = `${nf(locale, digits, digits).format(value)}×`;
  const cap = opts.cap;
  if (cap != null && value >= cap) {
    return { display: `≥${nf(locale, 0, 0).format(cap)}×`, capped: true, exact };
  }
  return { display: exact, capped: false, exact };
}

/** Full-precision rendering for the provenance tooltip — always the
 *  unscaled figure, standard grouping, up to 2 decimals. */
export function formatExact(
  value: number | null | undefined,
  opts: { locale?: string; currency?: string | null } = {},
): string {
  if (value == null || !isFinite(value)) return AMOUNT_MISSING;
  const locale = resolveLocale(opts.locale);
  const body = nf(locale, 0, 2).format(value);
  return opts.currency ? `${body}${NNBSP}${opts.currency}` : body;
}
