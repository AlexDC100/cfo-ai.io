// THE DIAL — shared display-currency conversion for headline figures.
//
// Extracted from the Pro overview's KeyMetricsRow so BOTH modes convert
// and label figures through ONE code path: values convert to the display
// currency here (one place), and the display symbol resolves identically.
// Gate M1 (mode parity) leans on this: Simple's StoryOverview and Pro's
// key-metric row cannot drift because they share this hook.
//
// <Amount> joins magnitude suffix and currency directly ("15,1 M€") —
// right for symbols, unreadable for codes ("MRON"). Codes get a narrow
// no-break space so the unit reads "M RON".

import type { Currency } from "@/lib/rates";
import { convertFromTo } from "@/lib/money";
import { useDisplayCurrency, useRates } from "@/stores/currency";

export function displaySymbolFor(display: string): string {
  return display === "EUR" ? "€" : display === "USD" ? "$" : ` ${display}`;
}

/** Convert a set of raw statement-currency values to the user's display
 *  currency. Returns the converted values (same order) and the display
 *  symbol to pass to <Amount currency>. */
export function useConvertedAmounts(
  values: Array<number | null | undefined>,
  currency: string,
): { converted: Array<number | null>; symbol: string } {
  const display = useDisplayCurrency();
  const rates = useRates();
  const converted = values.map((v) =>
    v == null
      ? null
      : convertFromTo(v, (currency || "RON") as Currency, display, rates.rates),
  );
  return { converted, symbol: displaySymbolFor(display) };
}
