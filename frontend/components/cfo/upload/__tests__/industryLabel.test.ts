// A company's industry is shown in words, never as its catalog key.
import { beforeEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { industryLabelFor } from "@/components/cfo/upload/industryLabel";

const CATALOG = [
  { key: "food_manufacturing", display_name: "Food manufacturing", display_name_ro: "Producție alimentară" },
  { key: "bakery", display_name: "Bakery", display_name_ro: null },
];

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("industryLabelFor — words, never a key", () => {
  it("a workspace-settings industry uses its own translated label", () => {
    expect(industryLabelFor("agriculture", null, undefined, false)).toBe("Agriculture");
  });

  it("a catalog key takes the catalog's label, Romanian for a Romanian reader", () => {
    expect(industryLabelFor("food_manufacturing", null, CATALOG, false)).toBe("Food manufacturing");
    expect(industryLabelFor("food_manufacturing", null, CATALOG, true)).toBe("Producție alimentară");
    expect(industryLabelFor("bakery", null, CATALOG, true)).toBe("Bakery");
  });

  it("with no catalog, the stored display name — and nothing when there is none", () => {
    expect(industryLabelFor("food_manufacturing", "Food manufacturing", undefined, false)).toBe("Food manufacturing");
    expect(industryLabelFor("food_manufacturing", null, undefined, false)).toBeNull();
    expect(industryLabelFor("food_manufacturing", "food_manufacturing", undefined, false)).toBeNull();
    expect(industryLabelFor(null, "anything", CATALOG, false)).toBeNull();
  });
});
