// Global-positioning gates G4 + G5 (directive 2026-08-29).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MARQUEE, ROMANIA, TIER_LABELS, orderedMarkets } from "../markets";

describe("G4 — market ordering", () => {
  it("Romania renders first, its own group", () => {
    const all = orderedMarkets();
    expect(all[0]).toBe(ROMANIA);
    expect(all[0].displayGroup).toBe("romania");
  });

  it("marquee order is exactly US, DE, GB, FR, IT, ES, AE", () => {
    expect(MARQUEE.map((m) => m.code)).toEqual([
      "US", "DE", "GB", "FR", "IT", "ES", "AE",
    ]);
    expect(MARQUEE.map((m) => m.marqueeRank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("Hungary is NOT in the first seven markets rendered", () => {
    const firstSeven = orderedMarkets().slice(0, 8); // Romania + marquee 7
    expect(firstSeven.some((m) => m.code === "HU")).toBe(false);
  });

  it("Hungary lands in the A→Z tail, unremarked", () => {
    const all = orderedMarkets();
    const hu = all.find((m) => m.code === "HU");
    expect(hu).toBeDefined();
    expect(all.indexOf(hu!)).toBeGreaterThan(7);
    expect(hu!.marqueeRank).toBe(Number.POSITIVE_INFINITY);
  });

  it("roadmap language is tiers, never a country headline", () => {
    expect(TIER_LABELS.tier2.en).toBe("Tier II · Europe (Big Five)");
    expect(TIER_LABELS.tier3.en).toContain("US + UAE");
    for (const tier of Object.values(TIER_LABELS)) {
      expect(tier.en).not.toMatch(/hungar/i);
      expect(tier.ro).not.toMatch(/ungaria/i);
    }
  });
});

describe("G5 — trust copy is FROZEN", () => {
  // Per-document trust honesty must not drift under positioning work.
  // These strings are snapshot-locked; changing one requires editing
  // THIS test with a written rationale (golden-change discipline).
  it("the AI-lane trust strings are byte-identical to the frozen set", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "components", "cfo", "bsCanonicalStatusI18n.ts"),
      "utf-8",
    );
    // The dual-verification claim (EN + RO) — the heart of the badge.
    expect(src).toContain('dualVerified: "dual-verified"');
    expect(src).toContain('dualVerified: "dublu verificat"');
    // The re-extraction honesty line: AI re-reads, stated plainly.
    expect(src).toContain('reextractBody: "Re-extraction re-reads the document with AI."');
    // The jurisdiction badge label itself.
    expect(src).toContain('badge: "Jurisdiction"');
  });

  it("the generic lane label carries no certification verb", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "components", "cfo", "bsCanonicalStatusI18n.ts"),
      "utf-8",
    );
    expect(src).toContain('intl: "International (IFRS-style reading)"');
    expect(src).not.toMatch(/intl:.*(supported|certified|guaranteed)/i);
  });
});
