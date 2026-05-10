// Tabular currency formatting for CFO surfaces. The display unit is EUR;
// values arrive already in display currency from the derive layer (which
// converts the engine's kRON output via FX). The prop is still named `kron`
// for backwards compatibility but is now treated as "thousands of EUR".
//
// We render thousands as "k" and millions as "M" so the eye reads
// magnitudes without counting commas.

import { CURRENCY } from "@/lib/currency";

interface Props {
  /** Amount in thousands of the display currency. */
  kron: number;
  currency?: string;
  /** Force a particular unit. Auto picks M for ≥1000k, k otherwise. */
  unit?: "auto" | "k" | "M";
  /** Decimals — default 1 for M, 0 for k. */
  decimals?: number;
  className?: string;
}

export function MoneyValue({ kron, currency = CURRENCY, unit = "auto", decimals, className = "" }: Props) {
  const abs = Math.abs(kron);
  const useM = unit === "M" || (unit === "auto" && abs >= 1000);
  const value = useM ? kron / 1000 : kron;
  const dec = decimals ?? (useM ? 1 : 0);
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
  return (
    <span className={`tnum whitespace-nowrap ${className}`}>
      {formatted}
      <span className="text-ink-soft ml-0.5 text-[0.55em] font-medium align-baseline">
        {useM ? "M" : "k"}{currency ? ` ${currency}` : ""}
      </span>
    </span>
  );
}
