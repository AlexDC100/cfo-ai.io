// Number / date formatting — locale-aware (i18n-driven).
//
// `LOCALE` defaults to en-GB but resolves to the active i18n language
// when available, so a German user sees "1.234,56" and a French user
// sees "1 234,56" automatically. Existing callers passing the legacy
// `Lang = "en"` parameter still work — the param is ignored and the
// active i18n language is used instead.

import i18n from "@/i18n";

export type Lang = "en";

const LOCALE_FOR_LANG: Record<string, string> = {
  en: "en-GB",
  ro: "ro-RO",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
  pt: "pt-PT",
  nl: "nl-NL",
  pl: "pl-PL",
};

function activeLocale(): string {
  const lang = (i18n.language ?? "en").slice(0, 2);
  return LOCALE_FOR_LANG[lang] ?? "en-GB";
}

const LOCALE = "en-GB"; // kept for any legacy direct reads; new code uses activeLocale()

export function formatNumber(value: number, _lang: Lang = "en", opts: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat(activeLocale(), opts).format(value);
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
  return new Intl.DateTimeFormat(activeLocale(), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/**
 * Locale-aware currency formatting.
 *   formatMoney(1_234_567, 'RON')  → "1.234.567 RON"  (ro-RO)
 *   formatMoney(1_234_567, 'EUR')  → "1.234.567 €"     (de-DE)
 *   formatMoney(1_234_567, 'EUR')  → "1 234 567 €"     (fr-FR)
 *   formatMoney(1_234_567, 'EUR')  → "€1,234,567"      (en-GB)
 *
 * Compact mode collapses large amounts: 12_500_000 → "€12.5M" / "12,5 M€".
 */
export function formatMoney(amount: number, currency: string, opts: { compact?: boolean; fractionDigits?: number } = {}): string {
  const locale = activeLocale();
  const fractionDigits = opts.fractionDigits ?? 0;
  if (opts.compact && Math.abs(amount) >= 10_000) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(amount);
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}
