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

/** Why a NAV figure is not computed — the engine's typed reason. */
export interface NavRefusal {
  code: string;
  text: { en: string; ro: string };
}

export interface NavLayer {
  layer: NavLayerId;
  name: "Book NAV" | "Adjusted NAV" | "EPRA NNNAV" | "Liquidation NAV";
  /** null — with `refusal` — when book equity is refused: the balance
   *  sheet's total equity excludes a refused year's result
   *  (`assembled_bs.total_equity_refusal`) or is not served. Layers 2 and 3
   *  are built on Layer 1, so they refuse with it. Never 0. */
  value: number | null;
  refusal?: NavRefusal | null;
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
  /** null when book equity is refused (see NavLayer.value). */
  nnnav: number | null;
}

export type NavConvergentMethod = "nnnav" | "cap_rate" | "graham";

export interface NavCrossMethods {
  /** null when the NOI proxy is refused (with EBITDA). */
  capRate: number | null;
  /** null when the net result is refused (no account 121 and a refused
   *  net 711) or not served — `grahamRefusal` says why. */
  graham: number | null;
  grahamRefusal: NavRefusal | null;
  /** On the one EBITDA; null when the engine refused EBITDA. */
  evEbitda: number | null;
  /** low, high — over the methods in `convergentMethods` only (NNNAV and
   *  whichever of cap rate / Graham computed). null with NNNAV alone. */
  convergenceBand: [number, number] | null;
  convergenceConfidence: "high" | "medium" | "low" | null;
  convergentMethods: NavConvergentMethod[];
}

export interface NavUseCaseMapping {
  refinancing: { layer: NavLayerId; rationale: string };
  covenantNegotiation: { layer: NavLayerId; rationale: string };
  internalTransfer: { layer: NavLayerId; rationale: string };
  tradeSale: { layer: NavLayerId; rationale: string };
}

export interface NavCascade {
  layers: NavLayer[];
  /** Why Book NAV (and every layer and the hero built on it) is not
   *  computed; null beside a figure. */
  bookNavRefusal: NavRefusal | null;
  assetAdjustments: AssetAdjustment[];
  totalAssetUpliftGoingConcern: number;
  liabilityAdjustments: LiabilityAdjustment[];
  hiddenItems: HiddenItem[];
  keyAssumptions: NavKeyAssumptions;
  sensitivityNnnav: NavSensitivityCell[];
  crossMethods: NavCrossMethods;
  useCaseMapping: NavUseCaseMapping;
}
