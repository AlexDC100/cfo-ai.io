// F5.0 Phase 1.5 — Value formatter helpers.
//
// Format a raw numeric value according to its concept's ValueFormat
// hint. Currency values get compact suffix (12.4M, 320K); percentages
// get 1-decimal display; ratios get 2-decimal × suffix; days get integer
// d-suffix; scores get integer display; raw is just toFixed(0).

import type { ValueFormat } from "@/lib/learning/concepts/_schema";

export interface FormatOptions {
  currency?: string;
  /** When true, never use compact (M / K) suffix — useful for popover
   *  headline values that should show full precision. */
  full?: boolean;
}

export function formatValue(
  value: number,
  format: ValueFormat,
  opts: FormatOptions = {},
): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);

  switch (format) {
    case "percentage":
      return `${sign}${(abs * 100).toFixed(1)}%`;
    case "ratio":
      return `${sign}${abs.toFixed(2)}×`;
    case "days":
      return `${sign}${Math.round(abs)}d`;
    case "score":
      return `${sign}${Math.round(abs)}`;
    case "raw":
      return `${sign}${abs.toLocaleString("en-GB", { maximumFractionDigits: 1 })}`;
    case "currency":
    default: {
      const cur = opts.currency ?? "RON";
      if (opts.full || abs < 1_000) {
        return `${sign}${abs.toLocaleString("en-GB", { maximumFractionDigits: 0 })} ${cur}`;
      }
      if (abs >= 1_000_000_000) {
        return `${sign}${(abs / 1_000_000_000).toFixed(2)}B ${cur}`;
      }
      if (abs >= 1_000_000) {
        return `${sign}${(abs / 1_000_000).toFixed(2)}M ${cur}`;
      }
      return `${sign}${(abs / 1_000).toFixed(0)}K ${cur}`;
    }
  }
}
