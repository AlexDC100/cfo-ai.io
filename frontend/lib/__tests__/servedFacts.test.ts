// servedFacts — THE frontend facts gateway over the served statements
// object (docs/served_envelope.schema.json, served_v1). Behavior under
// test: source-lane resolution (canonical → envelope legacy → deriveTotals,
// all inside the module), integer-cents internals with one toDisplay edge,
// the placement-aware reconciliation adjustment, rawFactsForAuditOnly's
// reversal, and presentStatus — the ONE wording authority for the chip,
// the HTML export footer and the Excel status cell.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  factsFrom,
  presentStatus,
  rawFactsForAuditOnly,
  toDisplay,
  SERVED_ENVELOPE_VERSION,
} from "@/lib/servedFacts";
import type { Statements } from "@/lib/financialReport";

const FIXTURES = resolve(__dirname, "fixtures");
const load = (name: string): Statements =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), "utf-8")) as Statements;

const balanced = () => load("served_balanced.json");
const reconciledBs = () => load("served_reconciled_bs.json");
const reconciledPnl = () => load("served_reconciled_pnl.json");

describe("factsFrom — canonical lane", () => {
  it("serves canonical totals verbatim (cents-exact), never bucket sums", () => {
    const sf = factsFrom(balanced());
    expect(sf.source).toBe("canonical");
    expect(sf.isCanonical).toBe(true);
    // The fixture's balanceSheet buckets deliberately sum to DIFFERENT
    // values — any bucket recompute would fail these.
    expect(sf.totalAssets()).toBe(39194178.46);
    expect(sf.totalEquity()).toBe(23924083.72);
    expect(sf.totalLiabilities()).toBe(15270094.74);
    expect(sf.equityPlusLiabilities()).toBe(39194178.46);
    expect(sf.currentAssets()).toBe(27397734.37);
    expect(sf.currentLiabilities()).toBe(12934654.2);
    expect(sf.nonCurrentAssets()).toBe(11796444.09);
    expect(sf.nonCurrentLiabilities()).toBe(2335440.54);
    expect(sf.difference()).toBe(0);
    expect(sf.status()).toBe("BALANCED");
    expect(sf.needsReview()).toBe(false);
    expect(sf.mappingVersion()).toBe("ro_omfp1802_v2");
  });

  it("keeps integer minor units internally; toDisplay is the one edge", () => {
    const sf = factsFrom(balanced());
    // The cents fields are ABSENT-CAPABLE now; on a complete served
    // fixture every one of them must be a real integer, and the assertion
    // says so rather than letting a `null` slide through arithmetic.
    const ta = sf.cents.totalAssetsCents;
    const ca = sf.cents.currentAssetsCents;
    const nca = sf.cents.nonCurrentAssetsCents;
    expect(ta).toBe(3919417846);
    expect(Number.isInteger(ta)).toBe(true);
    expect(Number.isInteger(sf.cents.currentLiabilitiesCents)).toBe(true);
    expect(toDisplay(ta as number)).toBe(sf.totalAssets());
    // Cents math is exact where float subtraction would drift.
    expect(ca).not.toBeNull();
    expect(nca).toBe((ta as number) - (ca as number));
  });

  it("RECONCILED serves the ADJUSTED totals and a 0 difference", () => {
    const sf = factsFrom(reconciledBs());
    expect(sf.status()).toBe("RECONCILED");
    expect(sf.difference()).toBe(0);
    // Liabilities include the +117.43 adjusting line.
    expect(sf.totalLiabilities()).toBe(4000117.43);
    expect(sf.currentLiabilities()).toBe(2500117.43);
    // Equity untouched on a balance_sheet placement.
    expect(sf.totalEquity()).toBe(6000000);
  });

  it("PNL-placed RECONCILED: equity carries the delta (adjusted figure)", () => {
    const sf = factsFrom(reconciledPnl());
    expect(sf.status()).toBe("RECONCILED");
    expect(sf.difference()).toBe(0);
    // ⚠ THE intentional number change: the served, ADJUSTED equity — the
    // raw 5,000,052.18 must never come out of an analytical accessor.
    expect(sf.totalEquity()).toBe(5000000);
  });
});

describe("factsFrom — reconciliation adjustment per placement", () => {
  it("balance_sheet placement → bs detail with the applied delta", () => {
    const adj = factsFrom(reconciledBs()).reconciliationAdjustment();
    expect(adj).toEqual({
      placement: "balance_sheet",
      placementDetail: "bs",
      amount: 117.43,
      label: "Diferențe de reconciliere",
    });
  });

  it("pnl placement → mirrors assembled_pl.reconciliation_adjustment", () => {
    const adj = factsFrom(reconciledPnl()).reconciliationAdjustment();
    expect(adj).toEqual({
      placement: "pnl",
      placementDetail: "pl_other_expense",
      amount: -52.18,
      label: "Diferențe de reconciliere",
    });
  });

  it("pnl placement without the served P&L block derives detail by sign", () => {
    const s = reconciledPnl();
    delete (s.assembled_pl as Record<string, unknown>).reconciliation_adjustment;
    const adj = factsFrom(s).reconciliationAdjustment();
    expect(adj?.placement).toBe("pnl");
    expect(adj?.placementDetail).toBe("pl_other_expense"); // delta < 0 → expense
    expect(adj?.amount).toBe(-52.18);
  });

  it("no reconciliation → null", () => {
    expect(factsFrom(balanced()).reconciliationAdjustment()).toBeNull();
  });
});

describe("factsFrom — legacy lane (fallback lives INSIDE the module)", () => {
  it("uses the envelope totals written onto assembled_bs when present", () => {
    const s = balanced();
    delete (s as { canonical_bs?: unknown }).canonical_bs;
    const sf = factsFrom(s);
    expect(sf.source).toBe("legacy");
    expect(sf.status()).toBeNull(); // no engine verdict claimed
    expect(sf.totalAssets()).toBe(39194178.46);
    expect(sf.totalEquity()).toBe(23924083.72);
    expect(sf.totalLiabilities()).toBe(15270094.74);
    expect(sf.difference()).toBe(0);
    expect(sf.currentAssets()).toBe(27397734.37);
    expect(sf.nonCurrentLiabilities()).toBe(2335440.54);
  });

  it("falls back to deriveTotals bucket sums when no envelope totals exist", () => {
    const s = balanced();
    delete (s as { canonical_bs?: unknown }).canonical_bs;
    delete (s as { assembled_bs?: unknown }).assembled_bs;
    const sf = factsFrom(s);
    expect(sf.source).toBe("legacy");
    // Bucket sums from the fixture's balanceSheet: CA 27M + NCA 11M;
    // CL 12.5M + NCL 6M; equity 23.1M.
    expect(sf.totalAssets()).toBe(38000000);
    expect(sf.totalEquity()).toBe(23100000);
    expect(sf.totalLiabilities()).toBe(18500000);
    expect(sf.currentAssets()).toBe(27000000);
    expect(sf.currentLiabilities()).toBe(12500000);
    expect(sf.difference()).toBe(-3600000);
  });

  it("never mixes lanes: a partial assembled_bs triple falls back whole", () => {
    const s = balanced();
    delete (s as { canonical_bs?: unknown }).canonical_bs;
    s.assembled_bs = { total_assets: 999999 } as Record<string, number>;
    const sf = factsFrom(s);
    // total_assets alone is NOT consumed — a mixed engine/FE triple would
    // mint a fake drift. All three come from deriveTotals.
    expect(sf.totalAssets()).toBe(38000000);
    expect(sf.totalEquity()).toBe(23100000);
  });
});

describe("rawFactsForAuditOnly — audit/receipt/undo surfaces only", () => {
  it("reverses a balance_sheet placement onto liabilities", () => {
    const raw = rawFactsForAuditOnly(reconciledBs());
    expect(raw.placement).toBe("balance_sheet");
    expect(raw.appliedDelta).toBe(117.43);
    expect(raw.originalDifference).toBe(117.43);
    expect(raw.totalLiabilities).toBe(4000000); // pre-adjustment
    expect(raw.totalAssets).toBe(10000117.43); // untouched
    expect(raw.totalEquity).toBe(6000000); // untouched
  });

  it("reverses a pnl placement onto equity (the raw book)", () => {
    const raw = rawFactsForAuditOnly(reconciledPnl());
    expect(raw.placement).toBe("pnl");
    expect(raw.totalEquity).toBe(5000052.18); // the RAW figure — here only
    expect(raw.originalDifference).toBe(-52.18);
  });

  it("is the identity on non-reconciled periods", () => {
    const raw = rawFactsForAuditOnly(balanced());
    expect(raw.placement).toBeNull();
    expect(raw.appliedDelta).toBe(0);
    expect(raw.totalEquity).toBe(23924083.72);
    expect(raw.originalDifference).toBe(0);
  });
});

describe("presentStatus — the one wording authority", () => {
  it("BALANCED → balanced band, machine token BALANCED", () => {
    const p = factsFrom(balanced()).presentStatus();
    expect(p.machineStatus).toBe("BALANCED");
    expect(p.band).toBe("balanced");
    expect(p.balancedFamily).toBe(true);
    expect(p.chipKey).toBe("bsCanonical.balanced");
    expect(p.exportStatusCell).toBe("BALANCED");
  });

  it("RECONCILED → reconciled band, NEVER a 'balanced'-family display", () => {
    const p = factsFrom(reconciledBs()).presentStatus();
    expect(p.machineStatus).toBe("RECONCILED");
    expect(p.band).toBe("reconciled");
    expect(p.balancedFamily).toBe(true); // green chip COLOR family only
    // sv1 locked invariant (engine.serving.present_status): the display
    // string is "Reconciled" — never a balanced/echilibrat-family word.
    expect(p.displayKey).toBe("bs.status.reconciled");
    expect(p.displayEn).toBe("Reconciled");
    expect(p.displayRo).toBe("Reconciliat");
    expect(p.displayEn.toLowerCase()).not.toMatch(/balanc/);
    expect(p.displayRo.toLowerCase()).not.toMatch(/echilibr/);
    expect(p.microCaption).toBe("auto-adjusted 117.43");
    expect(p.chipKey).toBe("bsCanonical.status.reconciled");
    expect(p.chipCaptionKey).toBe("bsCanonical.reconcile.autoAdjusted");
    expect(p.exportStatusCell).toBe("RECONCILED");
    expect(p.exportStatusCell.toLowerCase()).not.toBe("balanced");
    expect(p.exportHeadline).toContain("RECONCILED");
    expect(p.exportHeadline).toContain("reconciled is not balanced");
    // Receipt travels with the export: amount, placement, origin.
    expect(p.exportDetail).toContain("RON 117.43");
    expect(p.exportDetail).toContain("Diferențe de reconciliere");
    expect(p.exportDetail).toContain("deterministic");
    expect(p.exportDetail).toContain("mapping ro_omfp1802_v2");
  });

  it("mirrors the engine table when no status_presentation is stamped", () => {
    const s = reconciledBs();
    delete (s.canonical_bs as unknown as Record<string, unknown>).status_presentation;
    const p = factsFrom(s).presentStatus();
    // Byte-identical to the served stamp — the mirror IS the engine table.
    expect(p.displayKey).toBe("bs.status.reconciled");
    expect(p.displayEn).toBe("Reconciled");
    expect(p.displayRo).toBe("Reconciliat");
    expect(p.microCaption).toBe("auto-adjusted 117.43");
  });

  it("PNL-placed RECONCILED names the P&L placement + AI origin", () => {
    const p = factsFrom(reconciledPnl()).presentStatus();
    expect(p.exportDetail).toContain("(P&L)");
    expect(p.exportDetail).toContain("AI-proposed, engine-verified");
  });

  it("MINOR_DRIFT + needs_review → needs_review band", () => {
    const p = presentStatus({
      status: "MINOR_DRIFT",
      needsReview: true,
      difference: -46.61,
      currency: "RON",
    });
    expect(p.band).toBe("needs_review");
    expect(p.chipKey).toBe("bsCanonical.reconcile.needsReview");
    expect(p.exportStatusCell).toBe("MINOR_DRIFT");
    expect(p.exportDetail).toContain("-RON 46.61");
  });

  it("MATERIAL_IMBALANCE → blocking band with the signed difference", () => {
    const p = presentStatus({
      status: "MATERIAL_IMBALANCE",
      difference: -46613.06,
      currency: "RON",
    });
    expect(p.band).toBe("material_imbalance");
    expect(p.chipKey).toBe("bsCanonical.material");
    expect(p.exportHeadline).toContain("does not reconcile");
    expect(p.exportDetail).toContain("-RON 46,613.06");
  });

  it("legacy (no status) → UNVERIFIED, never a balanced claim", () => {
    const s = balanced();
    delete (s as { canonical_bs?: unknown }).canonical_bs;
    const p = factsFrom(s).presentStatus();
    expect(p.machineStatus).toBe("UNVERIFIED");
    expect(p.band).toBe("unverified");
    expect(p.balancedFamily).toBe(false);
    expect(p.exportHeadline.toLowerCase()).not.toContain("balance check passed");
  });

  it("pins the envelope version constant", () => {
    expect(SERVED_ENVELOPE_VERSION).toBe("served_v1");
  });
});
