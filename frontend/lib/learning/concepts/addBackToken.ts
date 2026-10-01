// THE NON-CASH ADD-BACK TOKEN of the cash-flow formulas (CFO, FCF).
//
// Owner ruling R2 (2026-09-28) took the 6812 / 6814 provision charges out
// of the P&L's D&A — their net is its own line. The cash-flow walk still
// adds back ALL of 68x (`ReportingMetrics.depreciation`), so on a book that
// posts those charges the figure these formulas add is NOT the P&L's D&A:
// Scandia's popover printed 13,649,644.51 under "D&A" beside a P&L whose D&A
// is 11,607,174.27 (review 2026-10-02). The Cash Flow tab, /report §4, the
// workbook and the Valuation tab's FCF tile already name that row for what
// it sums; the Learn popovers behind the CFO and FCF tiles did not.
//
// ONE token for both formulas: named "D&A" only when the add-back IS the
// P&L's D&A, else for the charges it also holds — by the same test every
// other surface uses (`addBackHoldsProvisionCharges`). The value is the
// served add-back either way; nothing is computed here.
import { addBackHoldsProvisionCharges } from "@/lib/buildCashFlowStatement";
import type { ConceptContext, FormulaToken } from "./_schema";

export const ADD_BACK_TOKEN_LABEL = {
  plain: "D&A",
  withProvisionCharges: {
    en: "D&A and provision charges (68x)",
    ro: "Amortizări și provizioane (68x)",
  },
} as const;

export function addBackToken(ctx: ConceptContext): FormulaToken {
  const m = ctx.metrics ?? {};
  const widened = addBackHoldsProvisionCharges(m.depreciation, m.plDepreciation);
  return {
    type: "value",
    value: m.depreciation ?? 0,
    conceptKey: "depreciation_amortization",
    label: widened
      ? ADD_BACK_TOKEN_LABEL.withProvisionCharges[ctx.locale === "ro" ? "ro" : "en"]
      : ADD_BACK_TOKEN_LABEL.plain,
    format: "currency",
  };
}
