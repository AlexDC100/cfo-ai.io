// Tabular currency formatting for CFO surfaces.
//
// HISTORY: this component originally hardcoded EUR display. CUR-3 (currency
// toggle) rewired it to consume the global currency store — every existing
// MoneyValue call site now responds to the RON/EUR/USD top-bar toggle
// without a per-call-site refactor. The `kron` prop name + "k/M" unit
// suffix render are preserved for visual stability across the app.
//
// PROP CONTRACT (unchanged): `kron` is the value in THOUSANDS of the
// canonical unit (EUR per lib/currency.ts convention — the derive layer
// pre-converts kRON → kEUR upstream). The display layer converts to the
// user's chosen currency at render time.
//
// For NEW call sites without the legacy k-suffix convention, prefer
// <Money valueInEur={...} /> from src/components/ui/Money.tsx.

import { useCurrency } from "@/stores/currency";
import { convertMoney } from "@/lib/money";

interface Props {
  /** Amount in thousands of the canonical unit (EUR). */
  kron: number;
  /** DEPRECATED — kept for back-compat only. Ignored when the currency
   *  store is in scope (always, in the live app). Currency comes from
   *  the global toggle. */
  currency?: string;
  /** Force a particular magnitude unit. Auto picks M for ≥1000k, k otherwise. */
  unit?: "auto" | "k" | "M";
  /** Decimals — default 1 for M, 0 for k. */
  decimals?: number;
  className?: string;
}

export function MoneyValue({ kron, unit = "auto", decimals, className = "" }: Props) {
  const { display, rates } = useCurrency();

  // Convert canonical-EUR thousands → display-currency thousands.
  const kInDisplay = convertMoney(kron, display, rates.rates);

  const abs = Math.abs(kInDisplay);
  const useM = unit === "M" || (unit === "auto" && abs >= 1000);
  const value = useM ? kInDisplay / 1000 : kInDisplay;
  const dec = decimals ?? (useM ? 1 : 0);

  // Match the locale to the currency (same convention as <Money>):
  // RON → ro-RO, EUR → de-DE, USD → en-US.
  const locale =
    display === "RON" ? "ro-RO" : display === "EUR" ? "de-DE" : "en-US";

  const formatted = value.toLocaleString(locale, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });

  return (
    <span className={`tnum whitespace-nowrap ${className}`}>
      {formatted}
      <span className="text-ink-soft ml-0.5 text-[0.55em] font-medium align-baseline">
        {useM ? "M" : "k"} {display}
      </span>
    </span>
  );
}
