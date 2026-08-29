// Market taxonomy — DISPLAY layer only (global-positioning directive,
// 2026-08-29). Positioning is GLOBAL: Romania is the deterministic home
// market; everything else is ONE group with ONE story. Hungary is one
// country in a list, never a headline.
//
// Deliberately a FRONTEND data module, not pack metadata: pack files
// feed pack_hash, and gate G1 freezes every existing hash — so display
// names live where they can never touch an engine identifier. Pack ids,
// directory names, cache keys and wire values (RO / HU / INTL) stay
// byte-identical; this module maps them to what a person reads.

export interface MarketDisplay {
  /** Wire/pack code where one exists ("RO", "HU") — FROZEN, never shown
   *  as the label. Marquee-only markets carry their ISO code. */
  code: string;
  displayName: { en: string; ro: string };
  /** "romania" (deterministic home market) | "international". */
  displayGroup: "romania" | "international";
  /** Position in any UI that lists markets. Romania is rank 0 by group;
   *  marquee ranks 1..7; everything else Infinity → A→Z. */
  marqueeRank: number;
}

/** Marquee ordering for any surface that lists markets: United States,
 *  Germany, United Kingdom, France, Italy, Spain, UAE — then all others
 *  A→Z (Hungary lands there, unremarked). */
export const MARQUEE: MarketDisplay[] = [
  { code: "US", displayName: { en: "United States", ro: "Statele Unite" }, displayGroup: "international", marqueeRank: 1 },
  { code: "DE", displayName: { en: "Germany", ro: "Germania" }, displayGroup: "international", marqueeRank: 2 },
  { code: "GB", displayName: { en: "United Kingdom", ro: "Regatul Unit" }, displayGroup: "international", marqueeRank: 3 },
  { code: "FR", displayName: { en: "France", ro: "Franța" }, displayGroup: "international", marqueeRank: 4 },
  { code: "IT", displayName: { en: "Italy", ro: "Italia" }, displayGroup: "international", marqueeRank: 5 },
  { code: "ES", displayName: { en: "Spain", ro: "Spania" }, displayGroup: "international", marqueeRank: 6 },
  { code: "AE", displayName: { en: "UAE", ro: "Emiratele Arabe Unite" }, displayGroup: "international", marqueeRank: 7 },
];

/** The home market — always first, its own group. */
export const ROMANIA: MarketDisplay = {
  code: "RO",
  displayName: { en: "Romania", ro: "România" },
  displayGroup: "romania",
  marqueeRank: 0,
};

/** Non-marquee markets that have a wire code today. Hungary sits here:
 *  one country in the A→Z tail, exactly as the directive orders. */
export const OTHER_MARKETS: MarketDisplay[] = [
  { code: "HU", displayName: { en: "Hungary", ro: "Ungaria" }, displayGroup: "international", marqueeRank: Number.POSITIVE_INFINITY },
];

/** Every market a listing surface renders, in canonical order:
 *  Romania → marquee 1..7 → the rest A→Z by English name. */
export function orderedMarkets(): MarketDisplay[] {
  const tail = [...OTHER_MARKETS].sort((a, b) =>
    a.displayName.en.localeCompare(b.displayName.en),
  );
  return [ROMANIA, ...MARQUEE, ...tail];
}

/** Tier blueprint language — the ONLY roadmap phrasing product surfaces
 *  may use ("Tier II · Europe (Big Five)", never a country headline). */
export const TIER_LABELS = {
  tier1: { en: "Tier I · Romania", ro: "Tier I · România" },
  tier2: { en: "Tier II · Europe (Big Five)", ro: "Tier II · Europa (Big Five)" },
  tier3: { en: "Tier III · US + UAE → worldwide", ro: "Tier III · SUA + EAU → global" },
} as const;

/** Approved acceptance phrasing (gate G3): "any country" claims describe
 *  ACCEPTANCE and the dual-verified process — never certification. */
export const ACCEPTANCE_LINE = {
  en: "Any country accepted — structure read by AI, numbers machine-verified twice.",
  ro: "Orice țară acceptată — structura citită de AI, cifrele verificate mecanic de două ori.",
} as const;
