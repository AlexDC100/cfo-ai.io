// Number / date formatting — English locale only.
//
// Kept as small helpers for any legacy imports. The new CFO components
// use Intl directly or via MoneyValue.

export type Lang = "en";

const LOCALE = "en-GB";

export function formatNumber(value: number, _lang: Lang = "en", opts: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat(LOCALE, opts).format(value);
}

export function formatPct(value: number, _lang: Lang = "en", digits = 1) {
  const n = formatNumber(value, "en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n}%`;
}

export function formatSigned(value: number, _lang: Lang = "en", digits = 1) {
  if (value < 0) {
    const n = formatNumber(Math.abs(value), "en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return `(${n})`;
  }
  return formatNumber(value, "en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatDateLong(iso: string, _lang: Lang = "en") {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}
