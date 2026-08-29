// THE INSTRUMENT × the currency store — the display-currency bridge for
// the analysis screens (Benchmark / Scenarios / Variance).
//
// <Amount> owns HOW a figure appears (mono tabular, magnitude groups,
// accounting negatives, percent sanity). The currency store owns WHICH
// currency the user wants to see. Values on these screens arrive in the
// period's source currency, so this module converts with the same rates
// the legacy <Money> component uses — the RON⇄EUR⇄USD header toggle
// keeps re-rendering every figure live — and then hands the converted
// value to <Amount>. Screens import from here instead of calling the
// store and the instrument separately.

import { ReactNode, useMemo } from "react";

import { Amount, AmountGroup, type AmountProps } from "@/components/instrument/Amount";
import { convertFromTo } from "@/lib/money";
import { useCurrency } from "@/stores/currency";
import type { Currency } from "@/lib/rates";

// Narrow no-break space — same joint amountFormat.ts uses between number
// and unit, so "M" + "RON" reads "295,1 M RON", never "295,1 MRON".
const NNBSP = " ";

/** Display symbol for <Amount currency>. EUR/USD have glyphs; RON keeps
 *  its code, prefixed with the narrow no-break joint (see above). */
export function displaySymbol(display: Currency): string {
  if (display === "EUR") return "€";
  if (display === "USD") return "$";
  return `${NNBSP}RON`;
}

/** The active display currency + a converter bound to the live rates. */
export function useDisplayMoney(): {
  display: Currency;
  symbol: string;
  convert: (value: number | null | undefined, from?: Currency) => number | null;
} {
  const { display, rates } = useCurrency();
  return useMemo(
    () => ({
      display,
      symbol: displaySymbol(display),
      convert: (value, from) =>
        value == null || !isFinite(value)
          ? null
          : convertFromTo(value, from ?? "RON", display, rates.rates),
    }),
    [display, rates],
  );
}

export interface MoneyAmountProps
  extends Omit<AmountProps, "value" | "kind" | "currency"> {
  /** Amount in the SOURCE currency (typically `statements.currency`). */
  value: number | null | undefined;
  fromCurrency?: Currency;
  /** Set false where a header / panel chip already carries the currency
   *  code, so a dense table isn't six columns of repeated units. */
  unit?: boolean;
}

/** A money figure: source-currency in, display-currency out, rendered
 *  through <Amount> (and therefore obeying the enclosing AmountGroup). */
export function MoneyAmount({ value, fromCurrency, unit = true, ...rest }: MoneyAmountProps) {
  const { convert, symbol } = useDisplayMoney();
  return (
    <Amount
      kind="money"
      value={convert(value, fromCurrency)}
      currency={unit ? symbol : null}
      {...rest}
    />
  );
}

/** AmountGroup over source-currency values: converts the group first so
 *  the shared magnitude is picked from what the reader actually sees. */
export function MoneyAmountGroup({
  values,
  fromCurrency,
  children,
}: {
  values: Array<number | null | undefined>;
  fromCurrency?: Currency;
  children: ReactNode;
}) {
  const { convert } = useDisplayMoney();
  // No memo: the map is a handful of divisions and `values` is rebuilt
  // per render anyway; AmountGroup memoises the magnitude pick itself.
  const converted = values.map((v) => convert(v, fromCurrency));
  return <AmountGroup values={converted}>{children}</AmountGroup>;
}

// ── non-money figures the analysis screens share ───────────────────────

/** A percent LEVEL ("11,2%", "−3,2%") — value in PERCENT units. Levels
 *  are unsigned-positive (unlike kind="percent", which is a signed
 *  delta), so this renders through kind="count" with a % joint. */
export function PercentLevel({
  value,
  fractionDigits = 1,
  className,
}: {
  value: number | null | undefined;
  fractionDigits?: number;
  className?: string;
}) {
  if (value == null || !isFinite(value)) {
    return <Amount kind="count" value={null} className={className} />;
  }
  return (
    <span className={`font-mono tabular-nums ${className ?? ""}`.trim()}>
      <Amount kind="count" value={value} fractionDigits={fractionDigits} />%
    </span>
  );
}

/** A percentage-POINT delta ("+2,0 pp") — value in RATIO units (0.02). */
export function PpDelta({
  value,
  fractionDigits = 1,
  className,
}: {
  value: number | null | undefined;
  fractionDigits?: number;
  className?: string;
}) {
  if (value == null || !isFinite(value)) {
    return <Amount kind="count" value={null} className={className} />;
  }
  return (
    <span className={`font-mono tabular-nums ${className ?? ""}`.trim()}>
      <Amount kind="count" value={value * 100} fractionDigits={fractionDigits} signed />
      {NNBSP}pp
    </span>
  );
}

/** A ratio multiple with the ≥cap discipline. A non-finite input (the
 *  engine's wiped-out-denominator sentinel, +Infinity) renders as the
 *  bound the instrument is sure of — "≥99×" — with no fabricated exact
 *  value behind it. */
export function CappedMultiple({
  value,
  cap = 99,
  fractionDigits,
  className,
}: {
  value: number | null | undefined;
  cap?: number;
  fractionDigits?: number;
  className?: string;
}) {
  if (value != null && !Number.isFinite(value)) {
    return (
      <span className={`font-mono tabular-nums ${className ?? ""}`.trim()}>≥{cap}×</span>
    );
  }
  return (
    <Amount
      kind="multiple"
      value={value}
      cap={cap}
      fractionDigits={fractionDigits}
      className={className}
    />
  );
}
