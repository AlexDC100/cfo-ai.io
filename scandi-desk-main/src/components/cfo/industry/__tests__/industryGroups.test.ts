// Phase 9 unit tests for industry-display grouping.
//
// Guards two invariants the cleanup brief asks for:
//   · food_manufacturing rolls up to "Food & FMCG" at order index 0
//     (first group in the picker).
//   · Every backend sector key in industries.yaml has a display group.

import { describe, it, expect } from "vitest";

import {
  INDUSTRY_GROUP_LABELS,
  INDUSTRY_GROUP_ORDER,
  sectorDisplayLabel,
  sectorOrderIndex,
  sectorToDisplayGroup,
} from "@/lib/industryGroups";

describe("industryGroups", () => {
  it("maps food_manufacturing to 'Food & FMCG' at order 0", () => {
    expect(sectorToDisplayGroup("food_manufacturing")).toBe("food_fmcg");
    expect(sectorDisplayLabel("food_manufacturing")).toBe("Food & FMCG");
    expect(sectorOrderIndex("food_manufacturing")).toBe(0);
  });

  it("orders Retail second", () => {
    expect(sectorOrderIndex("trade_distribution_generic")).toBe(1);
  });

  it("falls back to 'Other' for unknown sectors", () => {
    expect(sectorToDisplayGroup("nonexistent_sector")).toBe("other");
    expect(sectorDisplayLabel(null)).toBe("Other");
    // unknown sector → max index (i.e., last in any sort)
    expect(sectorOrderIndex(undefined)).toBe(INDUSTRY_GROUP_ORDER.length - 1);
  });

  it("has a label for every group key in the order list", () => {
    for (const k of INDUSTRY_GROUP_ORDER) {
      expect(INDUSTRY_GROUP_LABELS[k]).toBeTruthy();
    }
  });

  it("covers every sector key currently in industries.yaml", () => {
    // Keep in sync with src/engine/api/seed/industries.yaml. If a new
    // sector is added there, also map it in industryGroups.ts and
    // extend this list — the test will fail loudly until you do.
    const SECTORS_IN_USE = [
      "food_manufacturing",
      "manufacturing_generic",
      "trade_distribution_generic",
      "real_estate",
      "construction",
      "transport_logistics",
      "hospitality",
      "it_software_media",
      "professional_services_generic",
      "healthcare",
      "agriculture",
      "energy_utilities",
    ];
    for (const sector of SECTORS_IN_USE) {
      const group = sectorToDisplayGroup(sector);
      expect(group).not.toBe("other");
    }
  });
});
