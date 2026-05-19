// Educational knowledge map for every ratio in `computeRatios()`.
//
// Used by the `RatioDetailDrawer` to render the 8-section explainer
// the spec asks for:
//   1. What the ratio is        → `definition`
//   2. Formula / how it's computed → `formula`
//   3. Why it matters            → `whyItMatters`
//   4. What a good range looks   → `goodRange`
//   5. This company's value      → rendered from the live `Ratio` object
//   6. What may be driving it    → `drivers`
//   7. What management should focus on → derived from the verdict
//   8. Related ratios            → `related` keys
//
// NOTE: This is presentation/education content. It does NOT change how
// `computeRatios()` calculates anything — the file is purely a lookup
// keyed by `ratio.key`.
//
// Keys mirror the ones emitted in `src/lib/financialReport.ts:computeRatios()`.

import type { Ratio } from "./financialReport";
import type { TraceableSource } from "./traceableSource";

/** Resolver keys — each value identifies a numeric field the drawer
 *  pulls live from `Totals` or `Statements.balanceSheet` /
 *  `incomeStatement`. Adding a new key means extending
 *  `resolveFormulaInput()` to handle it. */
export type FormulaValueKey =
  // Balance Sheet
  | "cash"
  | "accountsReceivable"
  | "inventory"
  | "totalCurrentAssets"
  | "totalAssets"
  | "accountsPayable"
  | "shortTermDebt"
  | "totalCurrentLiabilities"
  | "longTermDebt"
  | "totalLiabilities"
  | "totalEquity"
  | "totalDebt"
  | "netDebt"
  // P&L (Phase C)
  | "revenue"
  | "costOfGoodsSold"
  | "operatingExpenses"
  | "depreciationAmortization"
  | "ebitda"
  | "ebit"
  | "interestExpense"
  | "netIncome";

/** A single piece of the rendered formula. Either inert text ("(",
 *  " + ", " ÷ ") or a live numeric value that the drawer renders as a
 *  `<TraceableNumber>` linking to its source row. */
export type FormulaPart =
  | { kind: "text"; value: string }
  | {
      kind: "value";
      /** Short label rendered next to the number — e.g. "Cash", "AR". */
      label: string;
      /** Live-value resolver key — see `FormulaValueKey`. */
      valueKey: FormulaValueKey;
      /** Where this number lives in the statements. */
      source: TraceableSource;
    };

export interface RatioKnowledge {
  /** Plain-English definition. */
  definition: string;
  /** How the ratio is computed — math expression as a string.
   *  Kept as a static fallback for ratios that don't yet have
   *  structured `formulaParts`. */
  formula: string;
  /** Structured formula with live, clickable source numbers. When
   *  present, the drawer renders this in place of the plain `formula`
   *  string. Each `kind: "value"` part becomes a `<TraceableNumber>`
   *  pulling the actual figure from the company's statements. */
  formulaParts?: FormulaPart[];
  /** Why a CFO should care. */
  whyItMatters: string;
  /** Generic "good" range — context-free guidance, NOT a personalised
   *  recommendation. The drawer pairs this with the company's actual
   *  value + verdict so the user sees "good range" vs "your value"
   *  side-by-side. */
  goodRange: string;
  /** Common drivers — what moves this ratio up or down in real life. */
  drivers: string[];
  /** Related ratios (by `Ratio.key`) the user might want to inspect next. */
  related: string[];
  /** Bucketed category — drives the eyebrow chip color in the drawer. */
  category: "liquidity" | "profitability" | "leverage" | "coverage" | "efficiency" | "distress";
}

export const RATIO_KNOWLEDGE: Record<string, RatioKnowledge> = {
  // ── Liquidity ────────────────────────────────────────────────────
  current_ratio: {
    category: "liquidity",
    definition:
      "How many times the company's current assets cover its short-term obligations.",
    formula: "Current assets ÷ Current liabilities",
    formulaParts: [
      { kind: "value", label: "Current assets", valueKey: "totalCurrentAssets",
        source: { statement: "bs", bucket: "totalCurrentAssets", hint: "Total current — section subtotal on the Balance Sheet" } },
      { kind: "text",  value: " ÷ " },
      { kind: "value", label: "Current liab", valueKey: "totalCurrentLiabilities",
        source: { statement: "bs", bucket: "totalCurrentLiabilities", hint: "Total current liabilities — section subtotal" } },
    ],
    whyItMatters:
      "First lens lenders and auditors use to gauge short-term solvency. A ratio below 1.0 means current assets cannot cover the next 12 months of obligations without raising cash, selling inventory, or accelerating collections.",
    goodRange: "≥ 1.5× healthy · ≥ 2.0× strong · < 1.0× tight",
    drivers: [
      "Receivables build-up (longer DSO)",
      "Inventory accumulation",
      "Short-term debt rolling over",
      "Trade payables stretching",
    ],
    related: ["quick_ratio", "cash_ratio", "working_capital", "ccc"],
  },
  quick_ratio: {
    category: "liquidity",
    definition:
      "Like the current ratio, but excludes inventory — measures coverage with the most liquid assets only.",
    formula: "(Cash + receivables) ÷ Current liabilities",
    formulaParts: [
      { kind: "text",  value: "( " },
      { kind: "value", label: "Cash", valueKey: "cash",
        source: { statement: "bs", bucket: "cash", hint: "Cash & equivalents (5121 + 5124 + 5311)" } },
      { kind: "text",  value: " + " },
      { kind: "value", label: "AR", valueKey: "accountsReceivable",
        source: { statement: "bs", bucket: "accountsReceivable", hint: "Trade receivables (4111)" } },
      { kind: "text",  value: " ) ÷ " },
      { kind: "value", label: "Current liab", valueKey: "totalCurrentLiabilities",
        source: { statement: "bs", bucket: "totalCurrentLiabilities", hint: "Total current liabilities — section subtotal" } },
    ],
    whyItMatters:
      "Strips out the assumption that inventory can be sold quickly. For commodity or slow-turnover businesses this is the more honest read.",
    goodRange: "≥ 1.0× healthy · < 0.7× watch",
    drivers: [
      "Cash burn / dividend distributions",
      "Receivables aging",
      "Short-term borrowings",
    ],
    related: ["current_ratio", "cash_ratio", "dso"],
  },
  cash_ratio: {
    category: "liquidity",
    definition:
      "Pure-cash coverage of current liabilities — the most conservative liquidity measure.",
    formula: "Cash & equivalents ÷ Current liabilities",
    formulaParts: [
      { kind: "value", label: "Cash", valueKey: "cash",
        source: { statement: "bs", bucket: "cash", hint: "Cash & equivalents (5121 + 5124 + 5311)" } },
      { kind: "text",  value: " ÷ " },
      { kind: "value", label: "Current liab", valueKey: "totalCurrentLiabilities",
        source: { statement: "bs", bucket: "totalCurrentLiabilities", hint: "Total current liabilities — section subtotal" } },
    ],
    whyItMatters:
      "Tells you what happens if revenue stops tomorrow. Boards and lenders use this for stress-testing.",
    goodRange: "≥ 0.20× comfortable · < 0.10× exposed",
    drivers: [
      "Dividend or capex policy",
      "Working-capital lockup",
      "Short-term debt schedule",
    ],
    related: ["quick_ratio", "current_ratio"],
  },

  // ── Profitability ───────────────────────────────────────────────
  gross_margin: {
    category: "profitability",
    definition:
      "Share of revenue left after the cost of goods/services sold — the unit economics of the business.",
    formula: "(Revenue − COGS) ÷ Revenue",
    whyItMatters:
      "Sets the ceiling for every other margin. Compresses immediately under cost inflation, pricing power loss, or unfavorable mix.",
    goodRange: "Industry-dependent · ≥ 25% generally healthy",
    drivers: [
      "Input/material cost moves",
      "Pricing power vs customers",
      "Mix shift between product categories",
      "Direct-labour productivity",
    ],
    related: ["ebitda_margin", "net_margin", "asset_turnover"],
  },
  ebitda_margin: {
    category: "profitability",
    definition:
      "Operating earnings before financing, taxes, and non-cash D&A — as a share of revenue.",
    formula: "EBITDA ÷ Revenue",
    whyItMatters:
      "The cleanest read of pure operating performance. Drives EV/EBITDA valuation and is the headline metric most acquirers and lenders use.",
    goodRange: "≥ 15% healthy · ≥ 25% strong",
    drivers: [
      "Gross margin",
      "Operating-expense discipline (SG&A intensity)",
      "Operating leverage as revenue scales",
    ],
    related: ["gross_margin", "net_margin", "debt_to_ebitda", "interest_coverage"],
  },
  net_margin: {
    category: "profitability",
    definition:
      "Bottom-line earnings as a share of revenue — after every cost, including interest and tax.",
    formula: "Net income ÷ Revenue",
    whyItMatters:
      "What actually reaches the equity holders. Sensitive to leverage and tax structure on top of operations.",
    goodRange: "≥ 8% healthy",
    drivers: [
      "EBITDA margin",
      "Interest burden",
      "Effective tax rate",
      "One-off / non-operating items",
    ],
    related: ["ebitda_margin", "interest_coverage", "roe"],
  },
  roa: {
    category: "profitability",
    definition:
      "How efficiently total assets generate earnings — combines profitability and asset productivity.",
    formula: "Net income ÷ Total assets",
    whyItMatters:
      "Captures asset-intensity in the business model. Two companies with the same net margin can have very different ROAs.",
    goodRange: "≥ 5% healthy · ≥ 10% strong",
    drivers: [
      "Net margin",
      "Asset turnover",
      "Capital structure (debt-funded assets push ROA down)",
    ],
    related: ["roe", "asset_turnover", "net_margin"],
  },
  roe: {
    category: "profitability",
    definition:
      "Return generated on book equity — the headline for shareholders.",
    formula: "Net income ÷ Average equity",
    whyItMatters:
      "Directly comparable to cost-of-equity. A persistent ROE below cost-of-capital means equity is being destroyed.",
    goodRange: "≥ 12% healthy · ≥ 20% strong",
    drivers: [
      "Net margin",
      "Asset turnover",
      "Leverage (DuPont: ROE = NM × ATO × Equity multiplier)",
    ],
    related: ["roa", "net_margin", "debt_to_equity", "equity_ratio"],
  },

  // ── Leverage ────────────────────────────────────────────────────
  debt_to_ebitda: {
    category: "leverage",
    definition:
      "How many years of current EBITDA it would take to repay total debt.",
    formula: "Total debt ÷ EBITDA",
    whyItMatters:
      "Lender covenants are typically set around this. > 4× is the line where most banks start declining incremental debt.",
    goodRange: "≤ 3× healthy · ≤ 2× strong · > 4.5× stretched",
    drivers: [
      "Operating cash-flow stability",
      "Debt-funded growth (M&A, capex)",
      "EBITDA contraction in a downcycle",
    ],
    related: ["debt_to_equity", "interest_coverage", "dscr", "ebitda_margin"],
  },
  debt_to_equity: {
    category: "leverage",
    definition:
      "Debt funding relative to equity funding — a structural capital-stack read.",
    formula: "Total debt ÷ Total equity",
    formulaParts: [
      { kind: "value", label: "Total debt", valueKey: "totalDebt",
        source: { statement: "bs", bucket: "longTermDebt", hint: "Total debt = ST bank credit (519) + LT bank loans (1621). Click jumps to LT bank loans." } },
      { kind: "text",  value: " ÷ " },
      { kind: "value", label: "Total equity", valueKey: "totalEquity",
        source: { statement: "bs", bucket: "totalEquity", hint: "Total equity — section subtotal" } },
    ],
    whyItMatters:
      "Above 1× means creditors fund more of the asset base than owners. Increases volatility of returns to equity.",
    goodRange: "≤ 1.0× healthy",
    drivers: [
      "Capital structure decisions (refinancing, buybacks)",
      "Retained earnings (or losses) altering equity",
      "Revaluation reserves",
    ],
    related: ["debt_to_ebitda", "equity_ratio", "roe"],
  },
  equity_ratio: {
    category: "leverage",
    definition:
      "Share of total assets funded by equity — the inverse of leverage intensity.",
    formula: "Total equity ÷ Total assets",
    formulaParts: [
      { kind: "value", label: "Total equity", valueKey: "totalEquity",
        source: { statement: "bs", bucket: "totalEquity", hint: "Total equity — section subtotal" } },
      { kind: "text",  value: " ÷ " },
      { kind: "value", label: "Total assets", valueKey: "totalAssets",
        source: { statement: "bs", bucket: "totalAssets", hint: "Total assets — Balance Sheet grand total" } },
    ],
    whyItMatters:
      "Romanian Law 31/1990 art 153^24 obligates capital reconstitution when equity falls below 50% of share capital — track this carefully.",
    goodRange: "≥ 30% healthy · ≥ 50% conservative",
    drivers: [
      "Accumulated profits / losses",
      "Dividend distribution",
      "New share issuance",
      "Asset revaluations",
    ],
    related: ["debt_to_equity", "debt_to_ebitda", "roe"],
  },
  ltv: {
    category: "leverage",
    definition:
      "Debt as a share of pledged asset value — the lender's coverage view for asset-backed lending.",
    formula: "Total debt ÷ Asset value (market or book)",
    whyItMatters:
      "Real-estate and asset-heavy businesses are typically capped around 70-75% LTV; above that, refinancing becomes expensive or impossible.",
    goodRange: "≤ 65% healthy · ≤ 75% covenant-typical",
    drivers: [
      "Asset revaluation (up or down)",
      "Debt amortization schedule",
      "Refinancing / new draws",
    ],
    related: ["debt_to_ebitda", "dscr", "equity_ratio"],
  },

  // ── Coverage ────────────────────────────────────────────────────
  interest_coverage: {
    category: "coverage",
    definition:
      "How many times operating profit covers interest expense.",
    formula: "EBIT ÷ Interest expense",
    whyItMatters:
      "Below 1.5× the business has almost no cushion against rate hikes or EBIT compression — a top early-warning indicator.",
    goodRange: "≥ 3× healthy · ≥ 6× strong",
    drivers: [
      "Average cost of debt",
      "Debt stock",
      "EBIT trajectory",
    ],
    related: ["dscr", "debt_to_ebitda", "ebitda_margin"],
  },
  dscr: {
    category: "coverage",
    definition:
      "How comfortably operating cash flow covers interest plus near-term principal repayments.",
    formula: "EBITDA ÷ (Interest expense + short-term debt principal)",
    whyItMatters:
      "Most loan covenants test this directly. Below 1.25× is the line of distress for most lenders.",
    goodRange: "≥ 1.25× covenant-typical · ≥ 1.50× comfortable",
    drivers: [
      "Operating cash flow",
      "Debt amortization schedule",
      "Tenor mix (short vs long-term)",
    ],
    related: ["interest_coverage", "debt_to_ebitda", "adjusted_dscr"],
  },
  adjusted_dscr: {
    category: "coverage",
    definition:
      "Same idea as DSCR but counts lease obligations alongside debt service — lender view for businesses with material rent.",
    formula: "(EBITDA + lease) ÷ (Interest + ST principal + lease)",
    whyItMatters:
      "For retail, hospitality, and asset-light models the lease bill is effectively debt. Adjusted DSCR is the metric covenant docs actually use.",
    goodRange: "≥ 1.25× covenant-typical",
    drivers: [
      "Annual lease/rent burden",
      "Operating cash flow",
      "Debt amortization schedule",
    ],
    related: ["dscr", "interest_coverage"],
  },

  // ── Efficiency / working capital ────────────────────────────────
  dso: {
    category: "efficiency",
    definition:
      "Average number of days between making a sale and collecting the cash.",
    formula: "(Receivables ÷ Revenue) × 365",
    whyItMatters:
      "Drives working-capital lockup and cash conversion. Trends matter more than the absolute number.",
    goodRange: "≤ 45 days healthy (industry-dependent)",
    drivers: [
      "Customer mix (retail vs B2B)",
      "Collection discipline",
      "Concessions / payment-term competition",
    ],
    related: ["dpo", "dio", "ccc", "current_ratio"],
  },
  dio: {
    category: "efficiency",
    definition:
      "Average number of days inventory sits on the balance sheet before being sold.",
    formula: "(Inventory ÷ COGS) × 365",
    whyItMatters:
      "Working-capital intensity proxy — high DIO ties up cash and exposes you to obsolescence.",
    goodRange: "Industry-dependent · ≤ 60 days FMCG, 30–90 days manufacturing",
    drivers: [
      "Demand forecasting accuracy",
      "Production lead-times",
      "Stock-out aversion / safety stock policy",
      "SKU complexity",
    ],
    related: ["dso", "dpo", "ccc", "current_ratio"],
  },
  dpo: {
    category: "efficiency",
    definition:
      "Average number of days you take to pay your suppliers — a measure of supplier float.",
    formula: "(Payables ÷ COGS) × 365",
    whyItMatters:
      "Higher DPO funds working capital from suppliers (within agreed terms). Push it too far and supplier risk + missed early-payment discounts erode margin.",
    goodRange: "Higher = more supplier float — bounded by negotiated terms",
    drivers: [
      "Negotiated payment terms",
      "Cash-flow priorities",
      "Strategic supplier relationships",
    ],
    related: ["dso", "dio", "ccc"],
  },
  ccc: {
    category: "efficiency",
    definition:
      "Cash conversion cycle — the gap between paying for inputs and collecting from customers.",
    formula: "DIO + DSO − DPO",
    whyItMatters:
      "The clearest summary of working-capital efficiency. A short or negative CCC means the business is self-funded; a long CCC eats cash.",
    goodRange: "Lower is better · negative CCC = customer-funded",
    drivers: [
      "DSO (collection)",
      "DIO (inventory)",
      "DPO (supplier float)",
    ],
    related: ["dso", "dio", "dpo", "current_ratio"],
  },
  asset_turnover: {
    category: "efficiency",
    definition:
      "Revenue generated per unit of total assets — how productively the asset base is being used.",
    formula: "Revenue ÷ Average total assets",
    whyItMatters:
      "Combined with net margin, this is one of the two levers in DuPont ROE. Low turnover means asset-heavy or under-utilized capacity.",
    goodRange: "Industry-dependent · ≥ 0.8× healthy for asset-light models",
    drivers: [
      "Asset intensity of the business model",
      "Capacity utilization",
      "Capex vs revenue alignment",
    ],
    related: ["roa", "roe", "ccc"],
  },

  // ── Distress ────────────────────────────────────────────────────
  altman_z: {
    category: "distress",
    definition:
      "Altman Z-Score — a multi-factor distress predictor combining working-capital strength, retained earnings, profitability, equity coverage, and asset turnover.",
    formula:
      "1.2·(WC/TA) + 1.4·(RE/TA) + 3.3·(EBIT/TA) + 0.6·(Eq/TL) + 1.0·(Sales/TA)",
    whyItMatters:
      "One of the longest-validated bankruptcy predictors. ≥ 2.6 is the safe zone; the grey zone (1.8–2.6) flags caution; < 1.8 is structurally distressed.",
    goodRange: "≥ 2.60 safe · 1.80–2.60 grey · < 1.80 distress",
    drivers: [
      "Working-capital intensity",
      "Retained-earnings stock (history of profitability)",
      "EBIT productivity",
      "Equity vs liabilities balance",
      "Asset productivity (Sales/TA)",
    ],
    related: ["debt_to_ebitda", "interest_coverage", "equity_ratio", "roa"],
  },
};

/** Helper — return the knowledge entry for a Ratio, or null when the
 *  ratio.key isn't in the map (so callers can degrade gracefully). */
export function getRatioKnowledge(ratio: Ratio): RatioKnowledge | null {
  return RATIO_KNOWLEDGE[ratio.key] ?? null;
}
