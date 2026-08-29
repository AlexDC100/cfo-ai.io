// Simple-mode context lines — deterministic templates (Prompt 12, Part B).
//
// Each headline KPI in Simple mode gains ONE sentence computed from
// gateway facts the app already holds. Templates are DATA; inputs come
// from existing accessors; no model call — Simple mode must be fully
// functional with AI unavailable.
//
// Every function returns null when its inputs are absent — a missing
// fact renders NO context line, never a guessed one (ABSENT ≠ ZERO is
// house law and applies to sentences too).

import { formatAmount, MAGNITUDE_UNIT } from "@/lib/amountFormat";

export interface ContextLineInputs {
  locale: string; // "en" | "ro" (activeLocale())
}

function lang(locale: string): "en" | "ro" {
  return locale.startsWith("ro") ? "ro" : "en";
}

/** Cash → "≈ N months of your average costs."
 *  months = cash / (annual operating costs / 12). Needs both facts. */
export function cashRunwayLine(
  cash: number | null | undefined,
  annualOperatingCosts: number | null | undefined,
  { locale }: ContextLineInputs,
): string | null {
  if (cash == null || annualOperatingCosts == null) return null;
  if (!(annualOperatingCosts > 0) || !(cash >= 0)) return null;
  const months = cash / (annualOperatingCosts / 12);
  const n = formatAmount(months, { locale, magnitude: MAGNITUDE_UNIT, fractionDigits: months >= 10 ? 0 : 1 });
  return lang(locale) === "ro"
    ? `≈ ${n} luni din costurile tale medii.`
    : `≈ ${n} months of your average costs.`;
}

/** Net debt → what the figure MEANS, not a recomputation. */
export function netDebtLine({ locale }: ContextLineInputs): string {
  return lang(locale) === "ro"
    ? "Ce ai mai datora după ce ai folosi tot numerarul."
    : "What you'd owe after using all cash.";
}

/** Revenue YoY → words, not just a chip. delta is a ratio (0.06 = +6%). */
export function revenueYoyLine(
  delta: number | null | undefined,
  { locale }: ContextLineInputs,
): string | null {
  if (delta == null || !isFinite(delta)) return null;
  const pct = Math.abs(delta * 100);
  const n = formatAmount(pct, { locale, fractionDigits: pct < 10 ? 1 : 0 });
  const ro = lang(locale) === "ro";
  if (Math.abs(delta) < 0.005) {
    return ro ? "Aproape la fel ca anul trecut." : "About the same as last year.";
  }
  if (delta > 0) {
    return ro ? `Cu ${n}% mai mult decât anul trecut.` : `${n}% more than last year.`;
  }
  return ro ? `Cu ${n}% mai puțin decât anul trecut.` : `${n}% less than last year.`;
}

/** Profit sign → one honest sentence. */
export function profitLine(
  netProfit: number | null | undefined,
  { locale }: ContextLineInputs,
): string | null {
  if (netProfit == null || !isFinite(netProfit)) return null;
  const ro = lang(locale) === "ro";
  if (netProfit > 0) {
    return ro
      ? "Afacerea a câștigat bani în această perioadă."
      : "The business made money this period.";
  }
  if (netProfit < 0) {
    return ro
      ? "Afacerea a pierdut bani în această perioadă."
      : "The business lost money this period.";
  }
  return ro ? "Afacerea a ieșit la zero." : "The business broke even.";
}

/** Debt coverage → plain reading of net debt / EBITDA. */
export function debtCoverageLine(
  netDebtToEbitda: number | null | undefined,
  { locale }: ContextLineInputs,
): string | null {
  if (netDebtToEbitda == null || !isFinite(netDebtToEbitda)) return null;
  const ro = lang(locale) === "ro";
  if (netDebtToEbitda <= 0) {
    return ro
      ? "Ai mai mult numerar decât datorii."
      : "You hold more cash than debt.";
  }
  const n = formatAmount(netDebtToEbitda, { locale, fractionDigits: 1 });
  return ro
    ? `Datoria netă ar fi acoperită din câștigurile a ≈ ${n} ani obișnuiți.`
    : `Net debt equals ≈ ${n} years of typical earnings.`;
}
