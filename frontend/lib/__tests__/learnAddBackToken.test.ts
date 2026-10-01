// GATE one-ebitda (owner ruling R2, 2026-09-28) — THE LEARN POPOVERS BEHIND
// THE CFO AND FCF TILES NAME THE ADD-BACK FOR WHAT IT SUMS.
//
// The cash-flow formulas add back ALL of 68x. Since R2 the P&L's D&A leaves
// out the 6812 / 6814 provision charges, so on a book that posts them the
// figure these popovers print is not the P&L's D&A — yet both printed it
// under the label "D&A" (review 2026-10-02, low: Scandia 13,649,644.51
// beside a P&L D&A of 11,607,174.27). The Cash Flow tab, /report §4, the
// workbook and the Valuation tab's FCF tile were renamed in the earlier
// rounds (provisionsAddBack.test.tsx); these two tokens were left.
//
// LAW, on the four firm books (real engine output), through the real metric
// snapshot the popover reads (`buildReportingMetricsSnapshot`) and the real
// concept registry: on the three books that post the charges, the add-back
// token of `operating_cash_flow` and of `free_cash_flow` is named for the
// provision charges it holds — in English and in Romanian — and its value is
// the served add-back (all of 68x), which exceeds the P&L's D&A by exactly
// the served charges; on the book that posts none it stays "D&A".
// REDS ON: either token labelled "D&A" over a figure holding the charges, or
// widened on a book posting none; the token's value moving off the add-back.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Statements } from "@/lib/financialReport";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { lookupConcept } from "@/lib/learning/concepts";
import { ADD_BACK_TOKEN_LABEL } from "@/lib/learning/concepts/addBackToken";

type Json = Record<string, unknown>;
const repoRoot = resolve(__dirname, "../../..");
const book = (name: string) =>
  (JSON.parse(
    readFileSync(resolve(repoRoot, `tests/engine/fixtures/firm/saga_10_col_${name}.json`), "utf-8"),
  ) as { statements: Statements & { assembled_pl: Json } }).statements;

function addBackTokenOf(conceptKey: string, s: Statements, locale: "en" | "ro") {
  const concept = lookupConcept(conceptKey);
  expect(concept?.computation, `${conceptKey} has a formula`).toBeDefined();
  const formula = concept!.computation!({ metrics: buildReportingMetricsSnapshot(s), currency: "RON", locale }, 0);
  const tokens = formula.tokens.filter(
    (t): t is Extract<typeof t, { type: "value" }> =>
      t.type === "value" && t.conceptKey === "depreciation_amortization",
  );
  expect(tokens, `${conceptKey}: one add-back token`).toHaveLength(1);
  return tokens[0];
}

describe("the CFO and FCF Learn popovers name the non-cash add-back for what it sums (R2)", () => {
  for (const name of ["agras", "carniprod", "retail"] as const) {
    it(`${name} posts 6812 / 6814 charges: the token is not "D&A", EN and RO`, () => {
      const s = book(name);
      const apl = s.assembled_pl;
      const charges = ((apl.net_provisions as Json).charges as Json).value as number;
      expect(charges).toBeGreaterThan(1);
      for (const key of ["operating_cash_flow", "free_cash_flow"]) {
        const en = addBackTokenOf(key, s, "en");
        expect(en.label, key).toBe(ADD_BACK_TOKEN_LABEL.withProvisionCharges.en);
        expect(en.label).toContain("provision charges (68x)");
        const ro = addBackTokenOf(key, s, "ro");
        expect(ro.label, key).toBe(ADD_BACK_TOKEN_LABEL.withProvisionCharges.ro);
        expect(ro.label).toContain("provizioane (68x)");
        // The figure under the name: all of 68x — the P&L's D&A plus the charges.
        expect(en.value - (apl.depreciation as number), `${key}: the add-back holds the charges`).toBeCloseTo(charges, 2);
        expect(ro.value).toBe(en.value);
      }
    });
  }

  it("realestate posts none: the token stays plain D&A, and is the P&L's D&A", () => {
    const s = book("realestate");
    for (const key of ["operating_cash_flow", "free_cash_flow"]) {
      for (const locale of ["en", "ro"] as const) {
        const tok = addBackTokenOf(key, s, locale);
        expect(tok.label).toBe("D&A");
        expect(tok.value).toBe(s.assembled_pl.depreciation);
      }
    }
  });
});
