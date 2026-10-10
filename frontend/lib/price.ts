// price — THE ONE PRINTER of a plan price, on the landing and on /pricing.
//
// WHY (2026-10-02). The Romanian /pricing printed "€4.99" on a plan card,
// "0,99 €" in the FAQ under it and the landing printed "4,99 €": three
// formats for one currency on two pages. The product standard (CLAUDE.md
// §26) is the ISO code AFTER the figure, in the reader's number format, for
// every currency and both languages — "4.99 EUR" / "4,99 EUR" — never a
// symbol. Every price a visitor reads now goes through `formatPrice`:
//   · the landing's plan cards and bullets ({price.solo} … tokens of
//     lib/engineProof, filled from PLAN_PRICES_EUR below);
//   · /pricing's cards, intro strip, bill estimator, FAQ and current-plan
//     strip (lib/pricingConfig.formatEur delegates here with the active UI
//     language; the amounts come from GET /api/pricing/config).
//
// PLAN_PRICES_EUR is the landing's mirror of `_pricing_config.py`'s
// defaults. It is not free to drift: lib/__tests__/shippedClaimsMatchCode
// ("quotes only prices the backend charges") parses the backend config and
// reds on any amount here it does not charge.

// DEPENDENCY-FREE on purpose: lib/engineProof imports this module and is
// loaded by node scripts (scripts/build_og_image.mjs) with no browser and no
// i18n instance. The locale rule below is lib/money's `moneyLocaleFor` —
// ro → ro-RO, anything else → en-US numbering — and lib/__tests__/price.test.ts
// holds the two to each other, so there is still one rule.

/** The number locale of a UI language — the same answer as
 *  lib/money.moneyLocaleFor (held by price.test.ts). */
export function priceLocaleFor(lang: string | null | undefined): string {
  return (lang ?? "").toLowerCase().startsWith("ro") ? "ro-RO" : "en-US";
}

/** The amounts the landing prints, by token name (`{price.<name>}`). */
export const PLAN_PRICES_EUR = {
  solo: 4.99,
  pro: 9.99,
  multi: 16.99,
  solo_extra: 1.49,
  pro_extra: 0.99,
  intro: 0.99,
} as const;

export type PlanPriceName = keyof typeof PLAN_PRICES_EUR;

/** Non-breaking space between the figure and its code. */
const CODE_JOINER = "\u00a0";

/** "4.99 EUR" in English, "4,99 EUR" in Romanian: two decimals, the ISO
 *  code after the figure, the number format of the reader's language. */
export function formatPrice(amount: number, lang: string | null | undefined): string {
  const figure = new Intl.NumberFormat(priceLocaleFor(lang), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${figure}${CODE_JOINER}EUR`;
}
