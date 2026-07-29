// Currency conversion + display formatting.
//
// All monetary values entering this module are in the CANONICAL UNIT —
// the unit the rest of the app currently stores values in. Per
// lib/currency.ts comment "values arrive already in display currency
// from the derive layer", the canonical unit is EUR (the derive layer
// pre-converts kRON → kEUR via FX_RON_TO_EUR=4.97).
//
// formatMoney() takes the canonical-EUR value, converts to the user's
// chosen display currency, and formats it via Intl.NumberFormat. The
// display locale follows the CURRENCY, not the UI language toggle —
// people who think in RON expect "1.234.567,89 RON" formatting; people
// who switch to USD expect "$1,234,567.89".

import type { Currency, Rates } from "./rates";

// ── Locale per currency (display locale follows currency, not UI lang) ──
const LOCALE_BY_CURRENCY: Record<Currency, string> = {
  RON: "ro-RO",
  EUR: "de-DE",
  USD: "en-US",
};

// ── Intl.NumberFormat instance cache ──
// Instantiation is expensive (~1ms); we render hundreds of <Money>
// instances per page. Cache by composite key so the hot path is just
// a dict lookup + format() call.
const _formatterCache: Map<string, Intl.NumberFormat> = new Map();

function getFormatter(
  currency: Currency,
  opts: {
    compact: boolean;
    signed: boolean;
    fractionDigits: number;
    locale?: string;
  },
): Intl.NumberFormat {
  const locale = opts.locale ?? LOCALE_BY_CURRENCY[currency];
  const key = `${locale}|${currency}|${opts.compact ? "c" : "s"}|${opts.signed ? "1" : "0"}|${opts.fractionDigits}`;
  let fmt = _formatterCache.get(key);
  if (fmt) return fmt;
  fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: opts.compact ? "compact" : "standard",
    compactDisplay: "short",
    maximumFractionDigits: opts.compact ? 1 : opts.fractionDigits,
    minimumFractionDigits: opts.compact ? 0 : opts.fractionDigits,
    signDisplay: opts.signed ? "always" : "auto",
  });
  _formatterCache.set(key, fmt);
  return fmt;
}

export interface FormatMoneyOptions {
  /** Render as "1,2M RON" / "€485k" instead of full digits. */
  compact?: boolean;
  /** Force a leading sign on positives (e.g. "+€1,234"). Defaults false. */
  signed?: boolean;
  /** Override the locale (rare; default follows currency convention). */
  locale?: string;
  /** Decimal places. Default 2 for normal, 1 for compact. */
  fractionDigits?: number;
}

/** Convert a canonical-EUR amount to the display currency + format.
 *
 *  Returns the formatted string (e.g. "1.234.567,89 RON", "$1,234.56").
 *  Negative values render with leading minus, never parentheses.
 *  Zero renders as "0 RON" / "€0" / "$0" — never em-dash.
 */
export function formatMoney(
  valueInEur: number,
  display: Currency,
  rates: Rates,
  opts: FormatMoneyOptions = {},
): string {
  const rate = rates[display];
  if (typeof rate !== "number" || !isFinite(rate)) {
    // Defensive: missing rate → render in canonical EUR with a marker.
    return `${valueInEur.toFixed(2)} EUR`;
  }
  const converted = valueInEur * rate;
  return getFormatter(display, {
    compact: !!opts.compact,
    signed: !!opts.signed,
    fractionDigits: opts.fractionDigits ?? 2,
    locale: opts.locale,
  }).format(converted);
}

/** Em-dash for missing data (vs "0" which is real zero). */
export const MONEY_MISSING = "—";

/** Convenience: convert a value WITHOUT formatting. Useful for
 *  derived numbers that flow further (e.g., chart axes). */
export function convertMoney(
  valueInEur: number,
  display: Currency,
  rates: Rates,
): number {
  const rate = rates[display];
  if (typeof rate !== "number" || !isFinite(rate)) return valueInEur;
  return valueInEur * rate;
}

/** Format a converted amount WITHOUT the currency symbol — for table
 *  cells in P&L / BS / CF views that already show the currency in a
 *  separate header chip. The number is converted via convertFromTo
 *  then formatted in the display currency's locale (so digit grouping
 *  matches the chip).
 *
 *  Always 2 decimal places, Unicode minus for negatives (U+2212),
 *  em-dash for missing/zero (matches the existing formatRON contract
 *  so existing table cells don't visually regress).
 */
export function formatAmountFrom(
  valueInSource: number | null | undefined,
  fromCurrency: Currency,
  display: Currency,
  rates: Rates,
  opts: { signed?: boolean; sign?: "positive" | "negative"; paren?: boolean; compact?: boolean } = {},
): string {
  if (valueInSource === null || valueInSource === undefined) return "—";
  if (!Number.isFinite(valueInSource)) return "—";
  if (Math.abs(valueInSource) < 0.005) return "—";
  const converted = convertFromTo(valueInSource, fromCurrency, display, rates);
  const locale = LOCALE_BY_CURRENCY[display] ?? "en-US";
  // 2026-06-02 — `compact` opt added so mobile callers can collapse long
  // Romanian-formatted amounts like "10.922.666,19" → "10,9 mil." that
  // fit comfortably in a 160px grid cell. Intl handles the locale-aware
  // compact unit ("mil."/"mld." for ro-RO, "M"/"B" for en-US, "Mio."/
  // "Mrd." for de-DE). Desktop callers still get full precision.
  const absStr = opts.compact
    ? Math.abs(converted).toLocaleString(locale, {
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: 1,
      })
    : Math.abs(converted).toLocaleString(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  if (opts.sign === "positive") return `+${absStr}`;
  if (opts.sign === "negative") return `−${absStr}`;
  if (opts.paren) return converted < 0 ? `(${absStr})` : absStr;
  if (opts.signed) return converted < 0 ? `−${absStr}` : `+${absStr}`;
  return converted < 0 ? `−${absStr}` : absStr;
}

/** Inverse: take a value in display currency and return canonical EUR.
 *  Used when the user types into an input that should round-trip. */
export function toCanonicalEur(
  valueInDisplay: number,
  display: Currency,
  rates: Rates,
): number {
  const rate = rates[display];
  if (typeof rate !== "number" || !isFinite(rate) || rate === 0) return valueInDisplay;
  return valueInDisplay / rate;
}

/** Convert any source currency to any display currency.
 *
 *  Rates table is `{EUR: 1.0, RON: 5.2488, USD: 1.16}` (X units per 1 EUR
 *  from BNR). To convert source → display:
 *    EUR-equivalent = value_in_source / rates[source]
 *    value_in_display = EUR-equivalent * rates[display]
 *
 *  Examples (BNR 2026-05-22):
 *    convert(1_000_000, "RON", "EUR") → 190_521  (1M RON / 5.2488)
 *    convert(1_000_000, "RON", "USD") → 221_088  (1M RON / 5.2488 * 1.16)
 *    convert(1_000_000, "EUR", "RON") → 5_248_800
 *
 *  Defensive: missing/invalid rates → returns source value unchanged
 *  (so a misconfigured rates payload never silently zeroes financial figures).
 */
export function convertFromTo(
  valueInSource: number,
  fromCurrency: Currency,
  toCurrency: Currency,
  rates: Rates,
): number {
  if (fromCurrency === toCurrency) return valueInSource;
  const sourceRate = rates[fromCurrency];
  const targetRate = rates[toCurrency];
  if (
    typeof sourceRate !== "number" || !isFinite(sourceRate) || sourceRate === 0 ||
    typeof targetRate !== "number" || !isFinite(targetRate)
  ) {
    return valueInSource; // safe fallback — never zero out money on bad rate data
  }
  return (valueInSource / sourceRate) * targetRate;
}

/** Format a value from any source currency in any display currency.
 *
 *  This is the canonical entry point for the Money component when the
 *  value is NOT pre-converted to EUR. Use this instead of formatMoney()
 *  when feeding values straight from the engine (which stores in the
 *  period's source currency, typically RON).
 */
export function formatMoneyFrom(
  valueInSource: number,
  fromCurrency: Currency,
  display: Currency,
  rates: Rates,
  opts: FormatMoneyOptions = {},
): string {
  const converted = convertFromTo(valueInSource, fromCurrency, display, rates);
  return getFormatter(display, {
    compact: !!opts.compact,
    signed: !!opts.signed,
    fractionDigits: opts.fractionDigits ?? 2,
    locale: opts.locale,
  }).format(converted);
}

/** Currency-code → symbol-or-code label for chips/badges (NOT for prose). */
export function currencyLabel(c: Currency): string {
  if (c === "EUR") return "€ EUR";
  if (c === "USD") return "$ USD";
  return "RON";
}
