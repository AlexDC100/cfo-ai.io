// PUBLIC_SUMMARY lane of the FE facts gateway (frontend/lib/servedFacts.ts).
//
// The engine's public-data lane can hand the FE an envelope whose statements
// carry `public_summary` (ps1 — reduced open-data filing, data.gov.ro
// I1..I20 indicators) and NO canonical_bs. The storefront is server-rendered
// HTML; this FE lane only makes in-app rendering SAFE if such an envelope
// appears:
//   · `source` becomes "public_summary" (the sanctioned presence probe);
//   · totals resolve from the indicators (whole RON → cents ×100);
//   · status stays in the null family (like the legacy lane) so
//     `presentStatus` lands in the UNVERIFIED arm — NEVER in the
//     `case "MATERIAL_IMBALANCE": default:` arm (the exact leak the
//     gateway map flags: an unknown status renders red imbalance copy).

import { describe, expect, it } from "vitest";

import { factsFrom } from "@/lib/servedFacts";
import type { Statements } from "@/lib/financialReport";

const INDICATORS = {
  I1: 1_000_000,
  I2: 2_500_000,
  I6: 50_000,
  I7: 1_200_000,
  I10: 2_300_000,
  I13: 5_400_000,
  I18: 420_000,
  I19: 0,
  I20: 37,
};

function summaryStatements(): Statements {
  return {
    companyName: "Synthetic Public SRL",
    currency: "RON",
    periodLabel: "FY 2024",
    balanceSheet: {},
    incomeStatement: {},
    supplementary: {},
    public_summary: {
      version: "ps1",
      cui: 12345678,
      year: 2024,
      dataset_version: "situatii_financiare_2024",
      status: "PUBLIC_SUMMARY",
      indicators: INDICATORS,
      derived: { total_assets: 3_550_000, net_result: 420_000 },
      provenance: {
        source: "data.gov.ro/mfp",
        dataset_version: "situatii_financiare_2024",
        fetch_date: "2026-08-01",
        cui: 12345678,
        year: 2024,
        content_hash: "ps-hash-abc123",
      },
    },
  } as unknown as Statements;
}

describe("public_summary lane (servedFacts)", () => {
  it("resolves source public_summary with indicator-derived totals", () => {
    const facts = factsFrom(summaryStatements());
    expect(facts.source).toBe("public_summary");
    expect(facts.isCanonical).toBe(false);
    expect(facts.totalAssets()).toBe(3_550_000); // derived I1+I2+I6
    expect(facts.totalEquity()).toBe(2_300_000); // I10 CAPITALURI TOTAL
    expect(facts.totalLiabilities()).toBe(1_200_000); // I7 DATORII
  });

  it("carries no engine verdict (status null family, like legacy)", () => {
    const facts = factsFrom(summaryStatements());
    expect(facts.status()).toBeNull();
    expect(facts.needsReview()).toBe(false);
    expect(facts.mappingVersion()).toBeNull();
  });

  it("presentStatus lands in the UNVERIFIED arm, never the MATERIAL_IMBALANCE default", () => {
    const presentation = factsFrom(summaryStatements()).presentStatus();
    expect(presentation.machineStatus).toBe("UNVERIFIED");
    expect(presentation.band).toBe("unverified");
    expect(presentation.machineStatus).not.toBe("MATERIAL_IMBALANCE");
    expect(presentation.band).not.toBe("material_imbalance");
    expect(presentation.balancedFamily).toBe(false);
  });

  it("claims no drift — the summary layout has no balance identity", () => {
    const facts = factsFrom(summaryStatements());
    // 2026-09-04 (F3): this used to assert 0, which reads as "the drift
    // was measured and came out zero". The lane has no balance identity
    // at all — I10+I7 deliberately omits I8/I9 — so the honest value is
    // NULL, and every surface then states the absence instead of a clean
    // zero. See `differenceOrigin` in servedFacts.ts.
    expect(facts.difference()).toBeNull();
    expect(facts.differenceOrigin()).toBe("unavailable");
  });

  it("canonical and legacy lanes are untouched", () => {
    const legacy = factsFrom({
      companyName: "L",
      currency: "RON",
      periodLabel: "FY 2024",
      balanceSheet: {},
      incomeStatement: {},
      supplementary: {},
      assembled_bs: {
        total_assets: 100,
        total_equity: 60,
        total_liabilities: 40,
        bs_balance_delta: 0,
      },
    } as unknown as Statements);
    expect(legacy.source).toBe("legacy");
    expect(legacy.totalAssets()).toBe(100);
  });
});
