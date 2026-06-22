// NAV cascade types — IFRS-aligned EPRA structure (Book / Adjusted / NNNAV).
//
// For CRE the valuation primary is the EPRA NNNAV (Layer 3) — the triple-net
// asset value with property marked to market via cap rate and deferred tax
// deducted on the uplift. This is what listed real estate companies report,
// what Romanian banks compute LTV against, and what a CFO walks into a
// refinancing conversation with.
//
// Layer 1: Book NAV         — statutory equity per balance sheet.
// Layer 2: Adjusted NAV     — Book + fair-value uplift on assets (gross of tax).
// Layer 3: EPRA NNNAV       — Adjusted minus deferred tax on revaluations.
// Layer 4: Liquidation NAV  — fire-sale scenario; deferred for v1.
//
// The view also surfaces:
//   • Asset adjustment ladder (one row per material account, traceable
//     to the trial balance via ro_account_code).
//   • Hidden items: BS-off assets/liabilities (tax NOLs, operating leases).
//   • Sensitivity matrix: 3×3 grid of cap rate × affiliate yield.
//   • Cross-method convergence: NNNAV vs Cap rate vs Graham vs EV/EBITDA.
//   • Use-case mapping: which layer the CFO cites for which conversation.

export type NavLayerId = 1 | 2 | 3 | 4;

export type AdjustmentMethod =
  | "cap_rate"        // mark to market via NOI / cap rate
  | "dividend_yield"  // capitalize annual dividend at illiquid-private yield
  | "face_value"      // no fair-value uplift
  | "haircut"         // partial recovery (prepayments, intangibles)
  | "mark_to_market"; // explicit MtM (loans at current rate)

export interface NavLayer {
  layer: NavLayerId;
  name: "Book NAV" | "Adjusted NAV" | "EPRA NNNAV" | "Liquidation NAV";
  value: number;
  description: string;
  useCases: string[];
}

export interface AssetAdjustment {
  accountCode: string;        // RO COA code (e.g., "215", "261")
  accountName: string;
  bookValue: number;
  goingConcernFairValue: number;
  goingConcernUplift: number; // fairValue − bookValue (can be negative)
  adjustmentMethod: AdjustmentMethod;
  assumptions: Record<string, number | string>;
  notes: string;
}

export interface LiabilityAdjustment {
  accountCode: string;
  accountName: string;
  bookValue: number;
  fairValue: number;
  adjustmentMethod: "face_value" | "mark_to_market" | "capitalize_lease";
  notes: string;
}

export interface HiddenItem {
  description: string;
  type: "asset" | "liability";
  estimatedValue: number;
  confidence: "high" | "medium" | "low";
  evidence: string;
}

export interface NavKeyAssumptions {
  capRateCentral: number;
  capRateRange: [number, number];
  affiliateYieldCentral: number;
  affiliateYieldRange: [number, number];
  citRate: number;
  capRateBasis: string;
}

export interface NavSensitivityCell {
  capRate: number;
  affiliateYield: number;
  nnnav: number;
}

export interface NavCrossMethods {
  capRate: number;
  graham: number;
  evEbitda: number;
  convergenceBand: [number, number]; // low, high (across NNNAV + cap_rate + Graham)
  convergenceConfidence: "high" | "medium" | "low";
}

export interface NavUseCaseMapping {
  refinancing: { layer: NavLayerId; rationale: string };
  covenantNegotiation: { layer: NavLayerId; rationale: string };
  internalTransfer: { layer: NavLayerId; rationale: string };
  tradeSale: { layer: NavLayerId; rationale: string };
}

export interface NavCascade {
  layers: NavLayer[];
  assetAdjustments: AssetAdjustment[];
  totalAssetUpliftGoingConcern: number;
  liabilityAdjustments: LiabilityAdjustment[];
  hiddenItems: HiddenItem[];
  keyAssumptions: NavKeyAssumptions;
  sensitivityNnnav: NavSensitivityCell[];
  crossMethods: NavCrossMethods;
  useCaseMapping: NavUseCaseMapping;
}
