// industryGroups.ts — display-group mapping for the industry catalog.
//
// The backend `industry_profiles` table stores raw sector keys like
// `food_manufacturing` and `professional_services_generic`. Those are
// stable database identifiers — they shouldn't change. But product
// copy moves: the spec wants users to see "Food & FMCG" instead of
// "food_manufacturing" and wants a specific ordered display sequence
// (Food first, Retail second, etc.).
//
// This module owns the mapping. Components import:
//   · `INDUSTRY_GROUP_ORDER`  — ordered list of display-group keys
//   · `INDUSTRY_GROUP_LABELS` — display-group key → human label
//   · `sectorToDisplayGroup(sector)` — raw sector → display group key
//
// The sector → group lookup is intentionally many-to-one so multiple
// related sectors can roll up under one display group when product
// copy benefits from it (e.g., manufacturing_generic + automotive_oem
// share the "Manufacturing" group).
//
// Adding a new sector: append it to `_SECTOR_TO_GROUP`. Adding a new
// display group: append to `_GROUPS` and `INDUSTRY_GROUP_ORDER`.

// ──────────────────────────────────────────────────────────────────────
// Display groups — ordered, English-only labels.
// ──────────────────────────────────────────────────────────────────────

export type IndustryGroupKey =
  | "food_fmcg"
  | "retail_distribution"
  | "manufacturing"
  | "real_estate"
  | "construction"
  | "services"
  | "logistics"
  | "agriculture"
  | "energy"
  | "healthcare"
  | "hospitality"
  | "it_software_media"
  | "other";

const _GROUPS: Record<IndustryGroupKey, string> = {
  food_fmcg:           "Food & FMCG",
  retail_distribution: "Retail & Distribution",
  manufacturing:       "Manufacturing",
  real_estate:         "Real Estate",
  construction:        "Construction",
  services:            "Services",
  logistics:           "Logistics",
  agriculture:         "Agriculture",
  energy:              "Energy & Utilities",
  healthcare:          "Healthcare",
  hospitality:         "Hospitality",
  it_software_media:   "IT, Software & Media",
  other:               "Other",
};

/** Ordered display sequence — matches the spec §12. */
export const INDUSTRY_GROUP_ORDER: IndustryGroupKey[] = [
  "food_fmcg",
  "retail_distribution",
  "manufacturing",
  "real_estate",
  "construction",
  "services",
  "it_software_media",
  "logistics",
  "hospitality",
  "healthcare",
  "agriculture",
  "energy",
  "other",
];

export const INDUSTRY_GROUP_LABELS: Record<IndustryGroupKey, string> = _GROUPS;

// ──────────────────────────────────────────────────────────────────────
// Sector key → display group
// ──────────────────────────────────────────────────────────────────────
// Sector keys MUST match `industry_profiles.sector` values in the
// backend catalog (see src/engine/api/seed/industries.yaml). Drift here
// is silent — an unmapped sector falls through to "other".

const _SECTOR_TO_GROUP: Record<string, IndustryGroupKey> = {
  food_manufacturing:           "food_fmcg",
  trade_distribution_generic:   "retail_distribution",
  manufacturing_generic:        "manufacturing",
  real_estate:                  "real_estate",
  construction:                 "construction",
  professional_services_generic:"services",
  it_software_media:            "it_software_media",
  transport_logistics:          "logistics",
  hospitality:                  "hospitality",
  healthcare:                   "healthcare",
  agriculture:                  "agriculture",
  energy_utilities:             "energy",
};

/** Map a raw `industry_profiles.sector` value to its display group key. */
export function sectorToDisplayGroup(sector: string | null | undefined): IndustryGroupKey {
  if (!sector) return "other";
  return _SECTOR_TO_GROUP[sector] ?? "other";
}

/** Human-readable group label for a raw sector key. Convenience wrapper. */
export function sectorDisplayLabel(sector: string | null | undefined): string {
  return INDUSTRY_GROUP_LABELS[sectorToDisplayGroup(sector)];
}

/** Order index — lower comes first. Used for sorting grouped catalog
 *  output (e.g., the picker's section headers). */
export function sectorOrderIndex(sector: string | null | undefined): number {
  const group = sectorToDisplayGroup(sector);
  const idx = INDUSTRY_GROUP_ORDER.indexOf(group);
  return idx === -1 ? INDUSTRY_GROUP_ORDER.length : idx;
}
