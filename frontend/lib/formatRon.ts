// Reference-format number formatters for the P&L / BS renderer.
//
// Three rules:
//   1. Always 2 decimal places, thousands separators in the ACTIVE UI
//      locale (ro-RO → "1.234.567,89", en → "1,234,567.89"). Was
//      hardcoded en-US, which showed US separators to Romanian users.
//   2. Zero / missing → em-dash "—".
//   3. Financial-items lines render with EXPLICIT sign — "+" for positives,
//      Unicode minus "−" (U+2212) for negatives. NEVER hyphen "-" (U+002D).
//
// Pair with `font-variant-numeric: tabular-nums` so digits align across rows.

/**
 * Format a number for P&L line items.
 *
 *   formatRON(2727103.68) → "2,727,103.68"
 *   formatRON(12.52)      → "12.52"
 *   formatRON(0)          → "—"
 *   formatRON(undefined)  → "—"
 *   formatRON(-355607)    → "−355,607.00"   (Unicode minus, not hyphen)
 */
import { activeLocale } from "@/lib/locale";

export function formatRON(value: number | undefined | null): string {
  if (value === null || value === undefined) return "—";
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.005) return "—";

  const absStr = Math.abs(value).toLocaleString(activeLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `−${absStr}` : absStr;
}

/**
 * Format a financial-items line with EXPLICIT sign prefix.
 *
 *   formatRONSigned(694377.16, "positive") → "+694,377.16"
 *   formatRONSigned(338580.67, "negative") → "−338,580.67"
 *
 * Always uses Unicode minus (U+2212) for negatives — not hyphen.
 */
export function formatRONSigned(value: number, sign: "positive" | "negative"): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return "—";
  const formatted = Math.abs(value).toLocaleString(activeLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return sign === "positive" ? `+${formatted}` : `−${formatted}`;
}

/**
 * Format a ratio as a one-decimal percentage.
 *
 *   formatPercent(0.437) → "43.7%"
 *   formatPercent(0.029) → "2.9%"
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format a number using parenthesis-for-negative accounting convention.
 * Standard in cash flow statements for investing/financing outflows:
 *
 *   formatRONParen(2164080)  → "2,164,080.00"
 *   formatRONParen(-2164080) → "(2,164,080.00)"
 *   formatRONParen(0)        → "—"
 *
 * Always uses regular hyphen-free parens; the negative sign is encoded
 * positionally so the column visually aligns.
 */
export function formatRONParen(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.005) return "—";
  const abs = Math.abs(value).toLocaleString(activeLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `(${abs})` : abs;
}
