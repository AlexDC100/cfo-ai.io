// <Money> — the canonical money-display primitive. Use this for ALL new
// monetary surfaces. Consumes the currency store + re-renders live on toggle.
//
// Why a wrapper around formatMoney() / formatMoneyFrom():
//   - Single subscription point for the currency store. Toggling RON→USD
//     re-renders every <Money> in one pass.
//   - Tabular numerals applied via className so digits don't shift width
//     between currencies (Intl gives different glyph widths for different
//     symbols; tabular-nums normalises).
//   - Handles the missing-data convention: `null` / `undefined` → em-dash
//     (vs zero, which is data).
//
// API — TWO supported input shapes:
//
//   Source-aware (preferred for engine values):
//     <Money value={1_000_000} fromCurrency="RON" />
//     <Money value={statements.assembled_pl.revenue} fromCurrency={statements.currency} />
//
//   Legacy canonical-EUR (for values that were pre-converted in the derive
//   layer; kept for backward compat — `valueInEur` will be deprecated in a
//   future cleanup once all derive paths emit source-currency values):
//     <Money valueInEur={1234.56} />
//
// For compact rendering ("1.2M RON") use compact=true. For forced sign
// ("+€1,234"), use signed=true.
//
// 2026-05-24 — added `fromCurrency` prop. Backwards-compatible with the
// legacy `valueInEur` shape; new call sites should always pass `value` +
// `fromCurrency`. See CUR-FIX-A in the task list.

import { formatMoney, formatMoneyFrom, MONEY_MISSING } from "@/lib/money";
import { useCurrency } from "@/stores/currency";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { Currency } from "@/lib/rates";

export interface MoneyProps {
  /** Amount in the SOURCE currency (typically `statements.currency`).
   *  When provided, `fromCurrency` MUST also be set. Preferred shape for
   *  engine-emitted values. `null` / `undefined` → em-dash. */
  value?: number | null | undefined;
  /** Source currency the `value` is denominated in. Required when `value`
   *  is set; ignored when `valueInEur` is used. */
  fromCurrency?: Currency;
  /** Legacy: amount pre-converted to canonical EUR by the derive layer.
   *  Kept for backward compat; new code should use `value` + `fromCurrency`. */
  valueInEur?: number | null | undefined;
  /** Render as "1.2M RON" / "€485k".
   *  Tri-state (mobile-consolidation, 2026-06-02):
   *    - `undefined` (default) → AUTO: compact on mobile (<768px), full on desktop
   *    - `true`  → force compact at every breakpoint
   *    - `false` → force full at every breakpoint
   *  Auto-on-mobile keeps long values like "1,234,567,890 RON" from
   *  overflowing iPhone-SE card edges. Existing call sites that explicitly
   *  passed `compact={true}` or `compact={false}` are unaffected. */
  compact?: boolean;
  /** Force leading sign on positives ("+€1,234"). */
  signed?: boolean;
  /** Decimal places. Default 2 for normal, 1 for compact. */
  fractionDigits?: number;
  /** Extra className appended after the default tabular-nums + whitespace-nowrap. */
  className?: string;
}

export function Money({
  value,
  fromCurrency,
  valueInEur,
  compact,
  signed = false,
  fractionDigits,
  className,
}: MoneyProps) {
  const { display, rates } = useCurrency();
  const isMobile = useIsMobile();
  // Tri-state resolution: caller-explicit wins; otherwise auto-by-screen.
  const effectiveCompact = compact ?? isMobile;

  // Resolve which input shape we're using.
  //  · explicit `value` (preferred) → source-aware path
  //  · legacy `valueInEur` → EUR-base path
  //  · neither → render em-dash
  const usingSourceAware = value !== undefined;
  const numericValue = usingSourceAware ? value : valueInEur;

  if (numericValue === null || numericValue === undefined) {
    return (
      <span className={cn("tabular-nums whitespace-nowrap", className)}>
        {MONEY_MISSING}
      </span>
    );
  }

  let formatted: string;
  let fullFormatted: string | undefined;
  if (usingSourceAware) {
    // Default to RON when fromCurrency is omitted on the source-aware
    // path — most engine periods are RON-source. Loud comment so we
    // don't lose track: this default avoids breaking the migration but
    // every call site SHOULD pass fromCurrency explicitly.
    const src: Currency = fromCurrency ?? "RON";
    formatted = formatMoneyFrom(numericValue as number, src, display, rates.rates, {
      compact: effectiveCompact,
      signed,
      fractionDigits,
    });
    // When compact is active, also compute the full-precision string for
    // the native browser tooltip — gives hover/long-press users the exact
    // figure without a Tooltip provider context.
    if (effectiveCompact) {
      fullFormatted = formatMoneyFrom(numericValue as number, src, display, rates.rates, {
        compact: false,
        signed,
        fractionDigits,
      });
    }
  } else {
    // Legacy path: input is canonical EUR.
    formatted = formatMoney(numericValue as number, display, rates.rates, {
      compact: effectiveCompact,
      signed,
      fractionDigits,
    });
    if (effectiveCompact) {
      fullFormatted = formatMoney(numericValue as number, display, rates.rates, {
        compact: false,
        signed,
        fractionDigits,
      });
    }
  }

  return (
    <span
      className={cn("tabular-nums whitespace-nowrap", className)}
      title={fullFormatted}
    >
      {formatted}
    </span>
  );
}
