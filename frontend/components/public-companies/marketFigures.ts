// marketFigures.ts — reading a NUMBER out of a pm1 envelope figure.
//
// Extracted from MarketSurface.tsx (2026-08-30, peer-add lane) because a
// second consumer appeared: the "Add as peer" control derives ratios from
// the same figures the card renders. Both must scale a minor-unit integer
// the SAME way, and the alternative — importing the helper back out of
// MarketSurface — would have made MarketSurface ⇄ MarketPeerAdd a module
// cycle, which this repo has been bitten by before (CLAUDE.md §19,
// manualChunks + circular imports).
//
// MarketSurface re-exports `figureMajor` so its existing test import and
// call sites are untouched.

import type { MarketFigure } from "@/lib/marketApi";

// ── minor-unit handling ────────────────────────────────────────────────
// A money figure arrives as an INTEGER in minor units. Converting it to
// major units needs the scale, and GUESSING the scale is how a figure
// silently becomes wrong by 100x — so the scale is only ever taken from
// something the document actually says:
//
//   · the named minor unit, when the document carries one ("cent"), or
//   · the ISO 4217 minor-unit exponent of the document's own currency.
//
// A currency outside the table, or a named unit we do not know, refuses:
// the caller renders an em dash with the unit in a tooltip instead of a
// number the reader would have no way to know was scaled wrong.
const NAMED_MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = { cent: 2 };

/** ISO 4217 minor-unit exponents for every currency the market registry
 *  can name today. Extended deliberately — a zero-decimal currency (JPY,
 *  KRW) MUST be added here before its market goes live, not defaulted. */
const CURRENCY_MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  RON: 2,
  CNY: 2,
  HKD: 2,
  AED: 2,
};

export function figureMajor(fig: MarketFigure): number | null {
  const minor = fig.value_minor;
  if (typeof minor !== "number" || !Number.isInteger(minor)) return null;
  let exponent: number | undefined;
  if (typeof fig.minor_unit === "string" && fig.minor_unit) {
    exponent = NAMED_MINOR_UNIT_EXPONENT[fig.minor_unit];
  } else if (typeof fig.currency === "string" && fig.currency) {
    exponent = CURRENCY_MINOR_UNIT_EXPONENT[fig.currency.toUpperCase()];
  }
  if (exponent === undefined) return null;
  return minor / Math.pow(10, exponent);
}

// ── the figure's own fiscal block ──────────────────────────────────────
//
// `MarketFigure` in lib/marketApi.ts does not declare `fiscal` — that
// module is owned by the registry lane and mirrors the wire body field by
// field. The block IS on the wire (every US figure carries
// `{end, fp, fy, start}`), so it is read structurally here rather than by
// widening a type this lane does not own. A figure that carries no block
// returns null and every guard that needs one refuses.

export interface FigureFiscal {
  end?: string | null;
  start?: string | null;
  fy?: number | null;
  fp?: string | null;
}

export function figureFiscal(fig: MarketFigure | undefined): FigureFiscal | null {
  if (!fig) return null;
  const block = (fig as { fiscal?: FigureFiscal | null }).fiscal;
  return block && typeof block === "object" ? block : null;
}
