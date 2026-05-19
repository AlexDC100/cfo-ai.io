// Data-depth abstraction.
//
// Every CFO AI page needs to know how deep the user's data goes — that
// dictates which analyses are honestly possible and which surfaces should
// say "upload deeper data to unlock." We never invent numbers we don't
// have (no fabricated EBITDA from a 6-aggregate listafirme summary,
// no DIO from a P&L-only doc).
//
// Four levels, in increasing detail:
//
//   Level 1  PUBLIC_SUMMARY    listafirme.ro / termene.ro / firme.info PDF
//                              → 6 aggregates × N years + identity (CUI/CAEN)
//                              CAN: revenue trend, profit trend, debt trend,
//                                   employees, equity ratio, simple ratios,
//                                   industry benchmark on aggregates, risk
//                                   trajectory (Altman-like via book equity)
//                              CANNOT: EBITDA, gross margin, cost structure,
//                                      DIO / DSO / DPO, full cash flow,
//                                      working capital decomposition
//
//   Level 2  STATUTORY         F30/F10 statutory filings (more line detail)
//                              → fuller P&L + BS, some CF proxies
//
//   Level 3  TRIAL_BALANCE     full RO trial balance (class 6/7 movements)
//                              → full P&L reconstruction, full BS, EBITDA,
//                                cost structure, working capital, all ratios
//
//   Level 4  OPERATIONAL       trial balance + invoice/ERP/inventory data
//                              → SKU profitability, real margin, CCC,
//                                customer/supplier concentration
//
// A user can hold multiple depths simultaneously (e.g. a public-records
// PDF for a target + a trial balance for their own company). `getDataDepth`
// returns the deepest available depth for a given period/document scope
// so each page can light up to its honest maximum.

export type DataDepthLevel = 1 | 2 | 3 | 4;

export interface DataDepth {
  level: DataDepthLevel;
  label: string;        // "Public Financial Summary" etc.
  shortLabel: string;   // "Level 1" etc.
  /** What the user CAN see at this depth, plain English. */
  available: string[];
  /** What is gated above this depth — surface as "upload X to unlock". */
  unavailable: string[];
  /** One-line CTA telling the user how to deepen the analysis. */
  upgradeHint: string;
}

export const DEPTH_PUBLIC_SUMMARY: DataDepth = {
  level: 1,
  label: "Public Financial Summary",
  shortLabel: "Level 1",
  available: [
    "Company identity (name, CUI, CAEN, registration)",
    "Multi-year revenue, profit, debt, assets, equity, employees",
    "Trend analysis (growth, margin trajectory, leverage history)",
    "Industry benchmark on revenue / profit / leverage / equity ratio",
    "Risk trajectory (equity-ratio, profit streak, debt/equity)",
  ],
  unavailable: [
    "EBITDA (no D&A line in public summary)",
    "Gross margin (no cost-of-goods breakdown)",
    "Cost structure (raw materials, salaries, energy, etc.)",
    "DIO / DSO / DPO / cash conversion cycle",
    "Full cash flow statement",
    "Detailed working-capital decomposition",
  ],
  upgradeHint:
    "Upload a Romanian trial balance (balanță de verificare) " +
    "to unlock EBITDA, cost structure, full P&L, and detailed ratios.",
};

export const DEPTH_STATUTORY: DataDepth = {
  level: 2,
  label: "Statutory Financial Statements",
  shortLabel: "Level 2",
  available: [
    "Multi-year revenue, profit, full balance sheet",
    "Fuller P&L: operating income, financial income, taxes",
    "Some cash-flow proxies",
    "Most financial ratios",
    "Industry benchmark on most metrics",
  ],
  unavailable: [
    "Class 6/7 cost-line detail (raw materials, salaries split)",
    "DIO / DSO / DPO (no per-counterparty receivables/payables)",
    "Reconstructed cash flow at line-item level",
  ],
  upgradeHint:
    "Upload a trial balance to unlock class-6/7 cost detail and exact ratios.",
};

export const DEPTH_TRIAL_BALANCE: DataDepth = {
  level: 3,
  label: "Trial Balance Reconstruction",
  shortLabel: "Level 3",
  available: [
    "Full P&L reconstructed from class 6/7 movements",
    "Full balance sheet from closing balances",
    "EBITDA, gross margin, all profitability ratios",
    "Cost structure (raw materials, personnel, energy, services)",
    "Working capital decomposition",
    "Industry benchmark on every line",
  ],
  unavailable: [
    "SKU profitability / real margin per product",
    "DIO / DSO / DPO at counterparty level",
    "Customer / supplier concentration",
  ],
  upgradeHint:
    "Upload invoice or inventory data (e-Factura, SAF-T, SmartBill) for " +
    "SKU-level intelligence and counterparty concentration.",
};

export const DEPTH_OPERATIONAL: DataDepth = {
  level: 4,
  label: "Operational Detail (Invoices + ERP)",
  shortLabel: "Level 4",
  available: [
    "Everything in Level 3",
    "SKU profitability + real-margin classification",
    "Customer / supplier concentration",
    "DIO / DSO / DPO at counterparty level",
    "Cash conversion cycle from real flow",
    "Operational decisions (anchor / keep / watch / wind-down)",
  ],
  unavailable: [],
  upgradeHint: "",
};

export const DEPTHS_BY_LEVEL: Record<DataDepthLevel, DataDepth> = {
  1: DEPTH_PUBLIC_SUMMARY,
  2: DEPTH_STATUTORY,
  3: DEPTH_TRIAL_BALANCE,
  4: DEPTH_OPERATIONAL,
};

/**
 * Map a backend detected_type or document kind to its data depth.
 * Returns null when the type doesn't map to a known depth (e.g. an
 * arbitrary SKU CSV that wasn't successfully processed).
 */
export function depthForType(
  detectedType: string | null | undefined,
  briefingKind?: string | null,
): DataDepth | null {
  if (briefingKind === "public_records_summary") return DEPTH_PUBLIC_SUMMARY;
  switch (detectedType) {
    case "trial_balance":
      return DEPTH_TRIAL_BALANCE;
    case "statutory_f30_f10":
    case "bilant":
    case "pl":
      return DEPTH_STATUTORY;
    case "annual_report":
      // Annual reports vary — be conservative and call them statutory.
      return DEPTH_STATUTORY;
    case "public_records_summary":
      return DEPTH_PUBLIC_SUMMARY;
    default:
      return null;
  }
}

/**
 * Pick the deepest depth from a list of (detected_type, briefing_kind)
 * pairs. Useful when an org has multiple uploads and we want to know
 * what the user can do at most.
 */
export function deepestOf(
  pairs: Array<{ detected_type?: string | null; briefing_kind?: string | null }>,
): DataDepth | null {
  let best: DataDepth | null = null;
  for (const p of pairs) {
    const d = depthForType(p.detected_type, p.briefing_kind);
    if (!d) continue;
    if (best === null || d.level > best.level) best = d;
  }
  return best;
}
