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
import { delta as deltaFn, sentimentFor } from "@/lib/learning/computeDeltas";
import { DeltaBadge } from "@/components/period/DeltaBadge";

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
  /** F6.0.1 (2026-06-20) — Comparison context for delta rendering.
   *
   *  When provided, the component renders the primary value followed by a
   *  DeltaBadge showing the change vs the comparison amount. Backward-
   *  compatible: every existing call site that doesn't pass `comparison`
   *  renders unchanged.
   *
   *  Two source-currency invariants:
   *    1. `comparison.amount` MUST be in the same source currency as
   *       `value` (typically the period's source currency). The Money
   *       component handles display-currency conversion uniformly across
   *       both via the active `useCurrency()` rates, so as long as both
   *       sides are in the SAME source, the delta math holds.
   *    2. Never pass a ratio (e.g. EBITDA margin = 0.14) through this
   *       prop. Ratios must render in PERCENTAGE POINTS via a dedicated
   *       Percentage component (not yet built — F6.0.1 follow-up).
   *
   *  Set `showAbsolute=true` to display "+€3.2M" instead of the default
   *  relative "+5.4%". Useful when the absolute number tells the story
   *  better than the percentage (small base values).
   */
  comparison?: {
    amount: number;
    showAbsolute?: boolean;
  };
}

export function Money({
  value,
  fromCurrency,
  valueInEur,
  compact,
  signed = false,
  fractionDigits,
  className,
  comparison,
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

  // F6.0.1 (2026-06-20) — Comparison badge.
  //
  // When `comparison` prop is provided AND the primary value is a real
  // number (not missing), render the primary value followed by a small
  // DeltaBadge with the absolute or relative change vs the comparison.
  //
  // Wrapping behavior: inline-flex with items-baseline keeps the badge
  // visually anchored to the digits' baseline, not the bottom of the
  // span. `whitespace-nowrap` propagates from the parent so on narrow
  // viewports the badge may wrap to a new line under the value rather
  // than overflow horizontally.
  if (comparison && typeof numericValue === "number") {
    const d = deltaFn(numericValue as number, comparison.amount);
    const sentiment = sentimentFor(d);
    return (
      <span
        className={cn(
          "inline-flex items-baseline gap-2 tabular-nums",
          className,
        )}
        title={fullFormatted}
      >
        <span className="whitespace-nowrap">{formatted}</span>
        <DeltaBadge
          delta={d}
          sentiment={sentiment}
          showAbsolute={comparison.showAbsolute}
          currency={
            usingSourceAware ? (fromCurrency ?? "RON") : ("EUR" as Currency)
          }
        />
      </span>
    );
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
