// How the cockpit PAINTS one served money value. A formatter, never a model:
// it receives ONE value — already converted from minor units at the gateway
// edge by `projectedDisplay`, inside <ProjectedAmount> — and returns a string.
// It never sees two values, so it cannot combine them.
//
// THE PROJECTION IS FORMATTED IN THE BOOK'S OWN CURRENCY. The display-currency
// toggle converts served ACTUALS at a stated rate on a stated date; pricing a
// five-year projection through it would be an exchange-rate assumption nobody
// declared, riding beside sliders whose whole point is that every assumption
// is written down.
//
// A value under one unit keeps its cents (gate F5: a served 0.01 printed
// "RON 0" is a zero painted where a real value exists).

import { formatMoneyFrom, moneyLocaleFor } from "@/lib/money";
import type { Currency, Rates } from "@/lib/rates";

export type MoneyFormat = (value: number) => string;

// THE SAME PRINTER AS EVERY OTHER MONEY FIGURE (owner ruling 2026-09-29:
// "Forecast cockpit uses the same printer when it opens"): lib/money
// formatMoneyFrom, source = display = the book's currency, the locale the
// READER'S LANGUAGE's through the one mapping (moneyLocaleFor) — "54.4M
// RON" / "54,4 mil. RON", the ISO code after the figure, never en-GB's
// "RON 54.4m". `locale` is the UI locale the page already holds.

/** Whole units (cents under one unit). For the collapsed statements, the
 *  present-mode assumptions and the bank export. */
export function fullMoney(currency: string, locale: string): MoneyFormat {
  const code = (currency || "RON") as Currency;
  const loc = moneyLocaleFor(locale);
  return (value) =>
    formatMoneyFrom(value, code, code, NO_RATES, { fractionDigits: Math.abs(value) >= 1 ? 0 : 2, locale: loc });
}

/** Compact ("54.4M RON" / "54,4 mil. RON") for the four numbers and the
 *  chart, where a reader takes in magnitudes. The full figure is the
 *  statements'. */
export function compactMoney(currency: string, locale: string): MoneyFormat {
  const code = (currency || "RON") as Currency;
  const loc = moneyLocaleFor(locale);
  return (value) =>
    Math.abs(value) >= 1
      ? formatMoneyFrom(value, code, code, NO_RATES, { compact: true, locale: loc })
      : formatMoneyFrom(value, code, code, NO_RATES, { fractionDigits: 2, locale: loc });
}

/** Source = display: no rate is ever read. */
const NO_RATES = {} as Rates;

/** A served plan-year label for a reader: "FY2030" reads "2030". */
export function yearLabel(period: string): string {
  return period.replace(/^FY/, "");
}

/** A served month label ("2027-04") in the reader's language ("aprilie 2027");
 *  anything else (an annual label) as a year. */
export function monthLabel(period: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return yearLabel(period);
  // Noon UTC on the first of the month, formatted in UTC: a month label can
  // never slip into the neighbouring month in a UTC-negative timezone.
  const date = new Date(`${m[1]}-${m[2]}-01T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/** A slider's own position (the exact decimal the wire carries) in the
 *  lever's unit, while the reader drags it — the ENGINE's display replaces it
 *  once it answers. A lever value, never money: "5.2%" / "45 days". */
export function leverText(
  lever: { readonly unit: "pct" | "days" },
  decimal: string,
  locale: string,
  daysWord: string,
): string {
  const unitValue = Number(decimal);
  if (lever.unit === "days") {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(unitValue)} ${daysWord}`;
  }
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(unitValue);
}
