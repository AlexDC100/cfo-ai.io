// Build the EPRA NAV cascade (Book / Adjusted / NNNAV) from period_facts.
//
// PRIMARY VALUATION FOR CRE. For real-estate-commercial entities, this
// replaces DCF + EV/EBITDA as the headline number. The methodology
// follows the EPRA Best Practice Recommendations:
//
//   Layer 1 — Book NAV       = total equity per balance sheet
//   Layer 2 — Adjusted NAV   = Book + fair-value uplift on assets
//                              (property via cap rate, affiliates via
//                              dividend yield, immaterial items at face)
//   Layer 3 — EPRA NNNAV     = Adjusted − deferred tax on revaluations
//                              (existing revaluation reserve + new uplift)
//
// The asset adjustment engine reads per-account line items from the
// canonical assembled statements and applies an account-pattern rule
// table to compute the going-concern fair value of each asset class.
// Every adjustment is traceable to a specific RO COA code so a CFO can
// reconcile the NNNAV back to the trial balance row by row.
//
// Sensitivity: 3×3 grid of cap rate × affiliate yield around the central
// case so the user sees the bracket, not a single point estimate.
//
// Cross-method convergence: NNNAV side-by-side with cap rate, Graham, and
// EV/EBITDA. The first three should converge in ~20-30% band for a healthy
// CRE entity; EV/EBITDA sits below by design (the classic signature of an
// asset-yielding business — captures operating cash flow but not asset value).

import type { ApiLineItem } from "./plStructure";
import type {
  AdjustmentMethod,
  AssetAdjustment,
  HiddenItem,
  LiabilityAdjustment,
  NavCascade,
  NavCrossMethods,
  NavLayer,
  NavSensitivityCell,
} from "./navStructure";

// ─── Account-pattern adjustment rules ────────────────────────────────────
// Each rule maps RO COA accounts to a going-concern fair-value method.
// `pattern` accepts either an exact code string (matched as prefix) or a
// RegExp for ranges like 213x.

interface AdjustmentRule {
  pattern: string | RegExp;
  method: AdjustmentMethod;
  /** Custom params per method — haircut_pct, etc. */
  params?: Record<string, number>;
  /** Label for the adjustment column in the ladder. */
  labelOverride?: string;
}

const ASSET_RULES: AdjustmentRule[] = [
  // ── Real estate (investment property) — cap-rate mark to market ────
  { pattern: "215", method: "cap_rate" },
  // Own-use buildings (rare for CRE SPV) — same method
  { pattern: "212", method: "cap_rate" },
  // ── Operating PP&E (equipment, vehicles, furniture) — no uplift ─
  { pattern: /^213/, method: "face_value" },
  { pattern: "214", method: "face_value" },
  // ── Construction in Progress — at cost if on schedule ───────────
  { pattern: "231", method: "face_value" },
  // ── Investments in affiliates — capitalize dividend stream ──────
  { pattern: /^261/, method: "dividend_yield" },
  // ── Trade receivables (current, doubtful) — face / haircut ──────
  { pattern: "4111", method: "face_value" },
  { pattern: "4118", method: "face_value" }, // already provisioned via 491
  // ── Intercompany receivables — face value (assume solvent) ──────
  { pattern: "461", method: "face_value" },
  // ── Prepaid expenses — 50% haircut (partial recoverability) ─────
  { pattern: "471", method: "haircut", params: { haircut_pct: 0.50 } },
  // ── VAT recoverable — face value (claimable from ANAF) ──────────
  { pattern: "4424", method: "face_value" },
  // ── Cash + bank — face value ────────────────────────────────────
  { pattern: /^51|^5311/, method: "face_value" },
  // ── Advances for fixed assets — face value ──────────────────────
  { pattern: "4093", method: "face_value" },
  // ── Other long-term receivables (2678) — face value ─────────────
  { pattern: "2678", method: "face_value" },
];

function findRule(code: string): AdjustmentRule | null {
  for (const rule of ASSET_RULES) {
    if (typeof rule.pattern === "string") {
      if (code === rule.pattern || code.startsWith(rule.pattern)) return rule;
    } else if (rule.pattern.test(code)) {
      return rule;
    }
  }
  return null;
}

const RO_ACCOUNT_NAMES: Record<string, string> = {
  "215":  "Investment property",
  "212":  "Buildings",
  "213":  "Equipment",
  "214":  "Furniture & vehicles",
  "231":  "Construction in progress",
  "261":  "Investments in affiliates",
  "4111": "Trade receivables",
  "4118": "Doubtful clients",
  "461":  "Intercompany receivables",
  "471":  "Prepaid expenses",
  "4424": "VAT recoverable",
  "5121": "Bank — RON",
  "5124": "Bank — FX",
  "5311": "Cash on hand",
  "4093": "Advances for fixed assets",
  "2678": "Other long-term receivables",
};

interface BuildArgs {
  /** Canonical PL view (`statements.assembled_pl`). */
  pl: Record<string, number>;
  /** Canonical BS view (`statements.assembled_bs`). */
  bs: Record<string, number>;
  /** Sub-aggregates for property-management-opex carve-out (if available). */
  subAgg?: Record<string, number>;
  /** Per-account line items from the API — used to drive the asset ladder. */
  lineItems: ApiLineItem[];
  /** Industry — drives default cap rate basis label. */
  industry?: string | null;
  /** Override central cap rate (default 0.08 for CRE). */
  capRate?: number;
  /** Override central affiliate yield (default 0.10 for private illiquid). */
  affiliateYield?: number;
  /** Romanian corporate income tax rate (default 0.16). */
  citRate?: number;
}

export function buildNavCascade(args: BuildArgs): NavCascade {
  const { pl, bs, lineItems } = args;
  const capRateCentral = args.capRate ?? 0.08;
  const affiliateYieldCentral = args.affiliateYield ?? 0.10;
  const citRate = args.citRate ?? 0.16;
  const capRateBasis = args.industry?.includes("real_estate")
    ? "Bucharest commercial property, 2025-2026 (medical/healthcare prime ~7.5–8.5%)"
    : "Industry-typical cap rate";

  // ── NOI for the cap-rate computation ─────────────────────────────────
  // NOI = rental income − property operating costs (no D&A, no interest).
  // Where the canonical view exposes opex_property_management we use it;
  // else fall back to operating-view EBITDA as a NOI proxy (correct when
  // the entity's only opex IS property opex, which is typical for SPVs).
  const rentalRevenue = pl.revenue ?? 0;
  const propertyMgmtOpex =
    (args.subAgg?.opex_property_management as number | undefined) ?? 0;
  const noi = propertyMgmtOpex > 0
    ? rentalRevenue - propertyMgmtOpex
    : (pl.ebitda_statutory ?? pl.operating_ebitda ?? rentalRevenue);

  // Annual dividend stream for affiliate capitalization.
  const dividendIncome = pl.dividend_income ?? pl.financial_income_other ?? 0;

  // ── Compute per-account asset adjustments ────────────────────────────
  // Group line items by account code (use prefix to bucket sub-accounts
  // back to their parent — e.g., 5121.1 → 5121).
  const bookByCode = new Map<string, number>();
  for (const li of lineItems) {
    if (li.statement !== "BS") continue;
    const code = li.ro_account_code || "";
    if (!code) continue;
    const rule = findRule(code);
    if (!rule) continue;
    // Use the rule's pattern as the grouping key so 5121 and 5311 both
    // bucket to "cash" via the regex, but stay separate for face/haircut.
    const key = typeof rule.pattern === "string" ? rule.pattern : code;
    bookByCode.set(key, (bookByCode.get(key) ?? 0) + Math.abs(li.amount));
  }

  // For investment property (215), net out accumulated depreciation (2815)
  // if present in line items.
  let accumDep215 = 0;
  for (const li of lineItems) {
    if (li.statement === "BS" && li.ro_account_code === "2815") {
      accumDep215 += Math.abs(li.amount);
    }
  }

  function computeAdjustment(
    code: string,
    rule: AdjustmentRule,
    bookValue: number,
    capRate: number,
    affiliateYield: number,
  ): AssetAdjustment {
    const assumptions: Record<string, number | string> = {};
    let fair = bookValue;
    let notes = "No fair-value adjustment";

    if (rule.method === "cap_rate" && code === "215") {
      // Net of accumulated depreciation on the book side
      const netBook = bookValue - accumDep215;
      const propertyValue = noi / capRate;
      assumptions.cap_rate = capRate;
      assumptions.noi = noi;
      notes = `Marked to market at ${(capRate * 100).toFixed(2)}% cap rate on NOI ${noi.toLocaleString()}`;
      return {
        accountCode: "215",
        accountName: RO_ACCOUNT_NAMES["215"] ?? "Investment property",
        bookValue: netBook,
        goingConcernFairValue: propertyValue,
        goingConcernUplift: propertyValue - netBook,
        adjustmentMethod: "cap_rate",
        assumptions,
        notes,
      };
    }
    if (rule.method === "dividend_yield" && code.startsWith("261")) {
      fair = dividendIncome > 0 ? dividendIncome / affiliateYield : bookValue;
      assumptions.yield = affiliateYield;
      assumptions.annual_dividend = dividendIncome;
      notes = dividendIncome > 0
        ? `Capitalized at ${(affiliateYield * 100).toFixed(1)}% yield on annual dividend ${dividendIncome.toLocaleString()}`
        : "No dividend stream observed — held at book";
    } else if (rule.method === "haircut") {
      const haircut = rule.params?.haircut_pct ?? 0;
      fair = bookValue * (1 - haircut);
      assumptions.haircut_pct = haircut;
      notes = `${(haircut * 100).toFixed(0)}% haircut applied — partial recoverability`;
    } else if (rule.method === "face_value") {
      fair = bookValue;
      notes = "Carried at book — no fair-value uplift";
    }

    return {
      accountCode: code,
      accountName: RO_ACCOUNT_NAMES[code] ?? `Account ${code}`,
      bookValue,
      goingConcernFairValue: fair,
      goingConcernUplift: fair - bookValue,
      adjustmentMethod: rule.method,
      assumptions,
      notes,
    };
  }

  function buildAdjustments(
    capRate: number,
    affiliateYield: number,
  ): AssetAdjustment[] {
    const adjustments: AssetAdjustment[] = [];
    for (const [code, bookValue] of bookByCode.entries()) {
      const rule = findRule(code);
      if (!rule || Math.abs(bookValue) < 100) continue;
      adjustments.push(computeAdjustment(code, rule, bookValue, capRate, affiliateYield));
    }
    return adjustments;
  }

  // ── Central case ─────────────────────────────────────────────────────
  const centralAdjustments = buildAdjustments(capRateCentral, affiliateYieldCentral);
  const totalUplift = centralAdjustments.reduce((s, a) => s + a.goingConcernUplift, 0);

  // ── Layer 1: Book NAV ────────────────────────────────────────────────
  const bookNav = bs.total_equity ?? 0;

  // ── Layer 2: Adjusted NAV (gross of deferred tax) ────────────────────
  const adjustedNav = bookNav + totalUplift;

  // ── Layer 3: NNNAV (less deferred tax on revaluations) ───────────────
  // Deferred tax = (existing revaluation reserve + new uplift) × CIT rate.
  // Existing reval reserve sits on account 105 — surfaced through the
  // canonical BS view if extracted, else 0.
  const revaluationReserve = bs.revaluation_reserves ?? 0;
  const deferredTax = (revaluationReserve + totalUplift) * citRate;
  const nnnav = adjustedNav - deferredTax;

  // ── Liability adjustments (face value for fixed-rate RON/EUR bank debt) ─
  const liabilityAdjustments: LiabilityAdjustment[] = [];
  if ((bs.total_debt ?? 0) > 0) {
    liabilityAdjustments.push({
      accountCode: "1621",
      accountName: "Long-term bank debt (Credite bancare pe termen lung)",
      bookValue: bs.total_debt ?? 0,
      fairValue: bs.total_debt ?? 0,
      adjustmentMethod: "face_value",
      notes: "Fixed-rate facility; mark-to-market not material at current rate level.",
    });
  }

  // ── Hidden items ─────────────────────────────────────────────────────
  const hiddenItems: HiddenItem[] = [];
  // Dividends declared but unpaid — already booked to 457 on BS; no adjustment needed
  // Operating leases under RAS — would require a rent_expense extraction; skip until threaded

  // ── Sensitivity matrix (3×3) ─────────────────────────────────────────
  const sensitivityNnnav: NavSensitivityCell[] = [];
  const capRateScenarios = [0.07, 0.08, 0.09];
  const yieldScenarios = [0.08, 0.10, 0.12];
  for (const cr of capRateScenarios) {
    for (const ay of yieldScenarios) {
      const adjs = buildAdjustments(cr, ay);
      const uplift = adjs.reduce((s, a) => s + a.goingConcernUplift, 0);
      const adjusted = bookNav + uplift;
      const dt = (revaluationReserve + uplift) * citRate;
      sensitivityNnnav.push({ capRate: cr, affiliateYield: ay, nnnav: adjusted - dt });
    }
  }

  // ── Cross-method convergence ─────────────────────────────────────────
  // Cap rate equity = property at market + other assets − bank debt.
  const propertyValueAtMarket = noi / capRateCentral;
  const cashVal = bs.cash ?? 0;
  // Other assets = all non-property assets (current assets + non-current except 215)
  const otherAssets =
    (bs.total_assets ?? 0)
    - (bs.ppe_net ?? bs.investment_property_net ?? 0); // strip out book property
  const capRateEquity = propertyValueAtMarket + otherAssets - (bs.total_debt ?? 0);

  // Graham — use statutory NI
  const ni = pl.net_income_statutory ?? 0;
  // V = NI × (8.5 + 2g_pct) × 4.4 / Y_pct ; g=3, Y=4.5
  const grahamValue = ni * (8.5 + 2 * 3) * 4.4 / 4.5;

  // EV/EBITDA — 10.5× mid for CRE-anchored
  const evEbitda = (pl.ebitda_statutory ?? 0) * 10.5 - ((bs.total_debt ?? 0) - cashVal);

  // Convergence band: NNNAV / cap rate / Graham (NOT EV/EBITDA — known undervaluer).
  const convergent = [nnnav, capRateEquity, grahamValue];
  const cLow = Math.min(...convergent);
  const cHigh = Math.max(...convergent);
  const spread = (cHigh - cLow) / Math.max(Math.abs(nnnav), 1);
  const convergenceConfidence: "high" | "medium" | "low" =
    spread < 0.20 ? "high" : spread < 0.40 ? "medium" : "low";

  const crossMethods: NavCrossMethods = {
    capRate: capRateEquity,
    graham: grahamValue,
    evEbitda,
    convergenceBand: [cLow, cHigh],
    convergenceConfidence,
  };

  // ── Layer descriptions ───────────────────────────────────────────────
  const layers: NavLayer[] = [
    {
      layer: 1,
      name: "Book NAV",
      value: bookNav,
      description:
        "Statutory equity per balance sheet. The legal minimum claim and deepest defensible floor.",
      useCases: ["Statutory reporting", "Tax disputes", "Minimum negotiating floor"],
    },
    {
      layer: 2,
      name: "Adjusted NAV",
      value: adjustedNav,
      description:
        "Book NAV plus fair-value uplift on identifiable assets (property marked to market, affiliates capitalized at yield). Gross of deferred tax — the upper bound for a trade sale.",
      useCases: ["Refinancing LTV", "Trade sale ceiling", "Insurance valuation"],
    },
    {
      layer: 3,
      name: "EPRA NNNAV",
      value: nnnav,
      description:
        "Triple-net NAV with deferred tax on revaluations deducted. IFRS-aligned; the single most defensible number for negotiation with a banker or counterparty.",
      useCases: [
        "Bank covenant negotiation",
        "Internal family transfer",
        "IFRS-aligned reporting",
      ],
    },
  ];

  return {
    layers,
    assetAdjustments: centralAdjustments.sort(
      (a, b) => Math.abs(b.goingConcernUplift) - Math.abs(a.goingConcernUplift),
    ),
    totalAssetUpliftGoingConcern: totalUplift,
    liabilityAdjustments,
    hiddenItems,
    keyAssumptions: {
      capRateCentral,
      capRateRange: [capRateCentral - 0.01, capRateCentral + 0.01],
      affiliateYieldCentral,
      affiliateYieldRange: [0.08, 0.12],
      citRate,
      capRateBasis,
    },
    sensitivityNnnav,
    crossMethods,
    useCaseMapping: {
      refinancing: {
        layer: 2,
        rationale: "LTV uses Adjusted NAV — asset value at market, gross of tax.",
      },
      covenantNegotiation: {
        layer: 3,
        rationale: "NNNAV is IFRS-aligned and recognizes deferred tax — defensible to a banker.",
      },
      internalTransfer: {
        layer: 3,
        rationale: "NNNAV balances fairness with tax realism for family-group transfers.",
      },
      tradeSale: {
        layer: 3,
        rationale:
          "NNNAV is the floor for a trade sale; Adjusted NAV (Layer 2) is the upper bound.",
      },
    },
  };
}
