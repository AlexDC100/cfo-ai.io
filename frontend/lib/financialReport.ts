// Financial statement engine — types, ratios, recommendations, HTML report.
//
// Pure TypeScript: takes a Statements object (balance sheet + P&L + a few
// supplementary fields) and produces:
//   - computeRatios()           → liquidity / profitability / leverage / coverage / efficiency
//   - generateRecommendations() → prioritized actions (critical / high / medium)
//   - renderReportHtml()        → standalone HTML doc (board-pack template)
//
// The HTML renderer outputs a fully self-contained <!doctype html> string so
// the user can save the result as an .html file, open in a browser, and "Print
// to PDF" without any tooling. The visual language is a navy + neutral
// board-pack template designed for institutional financial reporting.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BalanceSheet {
  // Current assets
  cash: number;
  accountsReceivable: number;
  inventory: number;
  otherCurrentAssets: number;
  // Non-current assets
  propertyPlantEquipment: number;
  intangibles: number;
  otherNonCurrentAssets: number;
  // Current liabilities
  accountsPayable: number;
  shortTermDebt: number;
  otherCurrentLiabilities: number;
  // Non-current liabilities
  longTermDebt: number;
  otherNonCurrentLiabilities: number;
  // Equity
  shareCapital: number;
  retainedEarnings: number;
  otherEquity: number;
}

export interface IncomeStatement {
  revenue: number;
  costOfGoodsSold: number;
  operatingExpenses: number;
  depreciationAmortization: number;
  interestExpense: number;
  otherIncome: number;
  taxExpense: number;
  /** Non-operating financial income — dividends received, interest income, etc.
   *  Sits below EBIT (does not feed EBITDA). Optional for simple samples. */
  financialIncome?: number;
  /** Non-operating financial expense (excluding interest) — FX revaluation,
   *  bank fees, etc. Sits below EBIT. Optional for simple samples. */
  financialExpense?: number;
  /** RAS account 711 (Variația stocurilor) — non-cash inventory variation
   *  memo. Carved out by `/api/period/{id}` rebuild so cash EBITDA can
   *  exclude it. When present, `deriveTotals` subtracts this from
   *  `otherIncome` for ratio math (defensive fallback against stale
   *  payloads that bundle 711 into `otherIncome`). */
  inventoryVariationMemo?: number;
  /** Capitalized own-work (RAS 722) memo — surfaced for transparency
   *  but EXCLUDED from cash EBITDA. */
  capitalizedOwnWork?: number;
}

export interface SupplementaryData {
  /** Annual lease/rent obligations, used in adjusted DSCR. */
  annualLeaseExpense?: number;
  /** Property/asset market value, used in LTV. */
  propertyMarketValue?: number;
  /** Number of FTEs — drives revenue-per-employee. */
  employees?: number;
  /** Period-end day count (default 365). */
  periodDays?: number;
  /** Capex outflow for the period. Defaults to D&A if absent. */
  capex?: number;
  /** Risk-free rate for valuation (default 4.5%). */
  riskFreeRate?: number;
  /** Equity risk premium (default 5.5%). */
  equityRiskPremium?: number;
  /** Levered beta vs. market (default 1.0). */
  beta?: number;
  /** Effective cost of debt before tax (default = interest / total debt). */
  costOfDebt?: number;
  /** Effective tax rate (default = tax / PBT). */
  taxRate?: number;
  /** Long-term FCF growth rate for DCF terminal value (default 2.5%). */
  terminalGrowthRate?: number;
  /** Forecast horizon in years (default 5). */
  forecastYears?: number;
  /** Forecast FCF growth rate for the explicit horizon (default 5%). */
  forecastGrowthRate?: number;
  /** Outstanding shares, for per-share metrics. */
  sharesOutstanding?: number;
  /** Last close price per share, for valuation upside calc. */
  marketPricePerShare?: number;
}

export interface PriorPeriod {
  periodLabel: string;
  balanceSheet: BalanceSheet;
  incomeStatement: IncomeStatement;
}

// ─── canonical_bs v2 — the engine-owned Balance Sheet authority ─────────────
// Contract: docs/CANONICAL_BS_V2_CONTRACT.md. Computed ONCE at write time by
// the engine assembler, persisted in the period envelope, and served verbatim
// by /api/period as `statements.canonical_bs`. Consumers (BS tab builder,
// periodFacts, Excel + HTML exports) render rows/sections/totals/status
// DIRECTLY from this object — zero local arithmetic, no residual plugs.
// Absent on legacy periods (pre-bs_v2), where every consumer keeps its
// existing fallback path unchanged.

export type CanonicalBsStatus = "BALANCED" | "MINOR_DRIFT" | "MATERIAL_IMBALANCE";

export interface CanonicalBsExtraction {
  method: "deterministic" | "llm";
  parser_version: string;
  source_format: string;
  number_locale: "ro" | "anglo";
  sheet?: string;
  header_row_index?: number;
}

export interface CanonicalBsSourceAnchorPair {
  file_debit: number;
  file_credit: number;
  extracted_debit: number;
  extracted_credit: number;
  delta_debit: number;
  delta_credit: number;
}

export interface CanonicalBsSourceAnchor {
  totals_row_found: boolean;
  /** Per column pair (si / rl / rc / sf); null when the format lacks the block. */
  pairs: Partial<Record<"si" | "rl" | "rc" | "sf", CanonicalBsSourceAnchorPair | null>>;
  anchor_status: "MATCHED" | "DIVERGED" | "NO_ANCHOR";
  source_balanced: boolean;
}

export interface CanonicalBsRow {
  id: string;
  /** Section id — matches an entry in `CanonicalBs.sections`. */
  section: string;
  /** Optional i18n key; `label` is the render-as-is fallback. */
  label_key?: string;
  /** Presentation label — consumers render this verbatim. */
  label: string;
  account_codes: string[];
  amount: number;
  opening: number | null;
  /** Drill-down to envelope leaves (traceability). */
  leaf_ids?: string[];
}

export interface CanonicalBsSection {
  id: string;
  subtotal: number;
}

export interface CanonicalBsTotals {
  assets: number;
  equity: number;
  liabilities: number;
  equity_plus_liabilities: number;
  current_assets: number;
  current_liabilities: number;
}

export interface CanonicalBsDiagnosis {
  /** Deterministic code D0–D8 (see contract "Diagnostic codes"). */
  code: string;
  detail: string;
  leaf_ids?: string[];
}

export interface CanonicalBs {
  schema: "bs_v2";
  mapping_version: string;
  extraction?: CanonicalBsExtraction;
  source_anchor?: CanonicalBsSourceAnchor;
  /** Presentation-ready, ordered; consumers render as-is. */
  rows: CanonicalBsRow[];
  /** OMFP 1802 bilanț sections with engine subtotals, in render order. */
  sections: CanonicalBsSection[];
  totals: CanonicalBsTotals;
  /** assets − (equity + liabilities) — THE drift; banner % derives from this. */
  difference: number;
  status: CanonicalBsStatus;
  /** Populated when status != BALANCED, deterministic order D0–D8. */
  diagnosis?: CanonicalBsDiagnosis[];
  unmapped?: { code: string; name?: string; sf_d?: number; sf_c?: number; reason?: string }[];
  excluded?: { code: string; reason?: string }[];
  invariants?: Record<string, unknown>;
  reprocessed?: { changed: boolean; previous_totals?: Record<string, number> };
}

/** Display geometry for one canonical section id — which side of the
 *  statement it belongs to plus its header/subtotal labels. Render ORDER
 *  always follows the object's own `sections` array; this table supplies
 *  presentation only, never numbers. */
export interface CanonicalBsSectionMeta {
  side: "assets" | "equity_liabilities";
  header: string;
  subtotalLabel: string;
  /** Traceable bucket key for the subtotal row (same taxonomy as the
   *  legacy BS builder) — only for the four subtotals other tabs link to. */
  subtotalBucket?: string;
}

const CANONICAL_BS_SECTION_META: Record<string, CanonicalBsSectionMeta> = {
  non_current_assets: { side: "assets", header: "NON-CURRENT", subtotalLabel: "Total non-current" },
  current_assets: { side: "assets", header: "CURRENT", subtotalLabel: "Total current", subtotalBucket: "totalCurrentAssets" },
  prepaid_expenses: { side: "assets", header: "PREPAID EXPENSES", subtotalLabel: "Total prepaid expenses" },
  equity: { side: "equity_liabilities", header: "EQUITY", subtotalLabel: "Total equity", subtotalBucket: "totalEquity" },
  provisions: { side: "equity_liabilities", header: "PROVISIONS", subtotalLabel: "Total provisions" },
  non_current_liabilities: { side: "equity_liabilities", header: "NON-CURRENT LIABILITIES", subtotalLabel: "Total non-current liabilities", subtotalBucket: "totalNonCurrentLiabilities" },
  current_liabilities: { side: "equity_liabilities", header: "CURRENT LIABILITIES", subtotalLabel: "Total current liabilities", subtotalBucket: "totalCurrentLiabilities" },
  deferred_income: { side: "equity_liabilities", header: "DEFERRED INCOME", subtotalLabel: "Total deferred income" },
};

export function canonicalBsSectionMeta(id: string): CanonicalBsSectionMeta {
  const known = CANONICAL_BS_SECTION_META[id];
  if (known) return known;
  // Contract-deviation guard: an unknown section id (from a future
  // mapping_version) must still render rather than silently dropping its
  // rows. The side heuristic affects placement only — totals always come
  // from `totals`, never from summing sides.
  const words = id.replace(/_/g, " ");
  return {
    side: id.includes("asset") ? "assets" : "equity_liabilities",
    header: words.toUpperCase(),
    subtotalLabel: `Total ${words}`,
  };
}

export interface Statements {
  companyName: string;
  industry?: string;
  currency: string;
  periodLabel: string; // e.g. "FY 2025"
  balanceSheet: BalanceSheet;
  incomeStatement: IncomeStatement;
  supplementary: SupplementaryData;
  /** Optional prior-period statements for trend lines. */
  prior?: PriorPeriod;
  /** Optional multi-year history (oldest → newest, NOT including current). */
  historicalPeriods?: PriorPeriod[];
  /** Canonical period_facts views — single source of truth across DCF,
   *  Graham, Valuation tab, Alerts, briefing. Populated by the backend
   *  /api/period response from `assembled_pl_canonical` /
   *  `assembled_bs_canonical` / `assembled_cf_canonical`. When present,
   *  every downstream consumer reads from here. */
  assembled_pl?: Record<string, number>;
  assembled_bs?: Record<string, number>;
  assembled_cf?: Record<string, number>;
  /** F4.1e — country-agnostic canonical envelope, embedded under
   *  `statements` by the backend's `/api/period` + briefing-regenerate
   *  paths (see `src/engine/api/pipeline.py:3511`). The
   *  `methodology.ebitda` block carries the four named YAML variants
   *  (reported / strict / cash / adjusted) that the F4.2-PARITY gate
   *  hard-locks to be byte-identical to the in-code legacy fields per
   *  ADR Lock #8 (3 of 4 HARD as of 3b.6-B; adjusted gated when
   *  operator addbacks land per [F3.16-3b6-ADJUSTED-LATER]).
   *
   *  Consumed by `buildCanonicalMetrics` / `buildCanonicalMetricsFromInputs`
   *  when the `F36_CUTOVER_METRICS_HUB` flag is on (the
   *  `[F3.16-3b6-CONSUMER-CUTOVER]` cutover landing point — see
   *  docs/SAGA-CALIBRATION-2026Q2.md §9). */
  assembled_canonical_v1?: {
    methodology?: {
      ebitda?: {
        reported?: number;
        strict?: number;
        cash?: number;
        adjusted?: number;
      };
    };
    [key: string]: unknown;
  };
  /** canonical_bs v2 — the single Balance Sheet authority (docs/
   *  CANONICAL_BS_V2_CONTRACT.md). Served verbatim by /api/period on
   *  bs_v2 periods; absent on legacy periods. When present, the BS tab,
   *  periodFacts and both exports consume it directly — zero recompute. */
  canonical_bs?: CanonicalBs;
  /** F3.11 — Source-data quality telemetry. Populated upstream of any
   *  engine routing from raw sf_d/sf_c sums in the trial balance.
   *  When `warn` is true (imbalance > 2%), the dashboard shows a
   *  prominent WARN banner above the analysis explaining that engine
   *  drift will exceed normal range because the source file itself
   *  is imbalanced. Falsy/missing on Claude-extracted uploads and on
   *  pre-F3.11 cached analyses — banner simply does not render. */
  sourceDataQuality?: {
    raw_imbalance_pct: number;
    raw_imbalance_abs: number;
    sum_closing_debit: number;
    sum_closing_credit: number;
    warn: boolean;
    warn_threshold_pct?: number;
  };
}

// ─── Derived totals ─────────────────────────────────────────────────────────

export interface DerivedTotals {
  totalCurrentAssets: number;
  totalNonCurrentAssets: number;
  totalAssets: number;
  totalCurrentLiabilities: number;
  totalNonCurrentLiabilities: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
  grossProfit: number;
  ebitda: number;
  ebit: number;
  netFinancialResult: number;
  pbt: number; // profit before tax
  netIncome: number;
  totalDebt: number;
  workingCapital: number;
  netDebt: number;
}

export function deriveTotals(s: Statements): DerivedTotals {
  const bs = s.balanceSheet;
  const is = s.incomeStatement;

  const totalCurrentAssets =
    bs.cash + bs.accountsReceivable + bs.inventory + bs.otherCurrentAssets;
  const totalNonCurrentAssets =
    bs.propertyPlantEquipment + bs.intangibles + bs.otherNonCurrentAssets;
  const totalAssets = totalCurrentAssets + totalNonCurrentAssets;

  const totalCurrentLiabilities =
    bs.accountsPayable + bs.shortTermDebt + bs.otherCurrentLiabilities;
  const totalNonCurrentLiabilities =
    bs.longTermDebt + bs.otherNonCurrentLiabilities;
  const totalLiabilities = totalCurrentLiabilities + totalNonCurrentLiabilities;
  const totalEquity = bs.shareCapital + bs.retainedEarnings + bs.otherEquity;

  const grossProfit = is.revenue - is.costOfGoodsSold;
  // Cash-view EBITDA — `is.otherIncome` must contain ONLY genuine
  // other operating income (758/740). The BE's /api/period rebuild
  // now carves account 711 (Variația stocurilor — non-cash inventory
  // accrual) out of the otherIncome bucket and surfaces it on the
  // separate `inventoryVariationMemo` field. Without that BE-side
  // split, Scandia FY2025 reported EBITDA = 684M (165% margin)
  // instead of the correct 54.4M (13.2% margin).
  const ebitda = grossProfit - is.operatingExpenses + is.otherIncome;
  const ebit = ebitda - is.depreciationAmortization;
  const finIn = is.financialIncome ?? 0;
  const finEx = is.financialExpense ?? 0;
  const pbt = ebit + finIn - is.interestExpense - finEx;
  const netIncome = pbt - is.taxExpense;

  const totalDebt = bs.shortTermDebt + bs.longTermDebt;
  const workingCapital = totalCurrentAssets - totalCurrentLiabilities;
  const netDebt = totalDebt - bs.cash;

  return {
    totalCurrentAssets,
    totalNonCurrentAssets,
    totalAssets,
    totalCurrentLiabilities,
    totalNonCurrentLiabilities,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    grossProfit,
    ebitda,
    ebit,
    netFinancialResult: finIn - is.interestExpense - finEx,
    pbt,
    netIncome,
    totalDebt,
    workingCapital,
    netDebt,
  };
}

// ─── Ratios ─────────────────────────────────────────────────────────────────

export type RatioVerdict = "strong" | "healthy" | "watch" | "critical";

export interface Ratio {
  key: string;
  label: string;
  value: number;
  unit: "x" | "%" | "days" | "ratio";
  verdict: RatioVerdict;
  benchmark: string;
  commentary: string;
}

export interface RatioBundle {
  liquidity: Ratio[];
  profitability: Ratio[];
  leverage: Ratio[];
  coverage: Ratio[];
  efficiency: Ratio[];
  bankruptcy: Ratio[];
}

const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b);
const pct = (a: number, b: number): number => safeDiv(a, b) * 100;

function verdictFromBands(
  value: number,
  bands: { critical?: number; watch?: number; healthy?: number; strong?: number },
  higherIsBetter = true,
): RatioVerdict {
  // Bands are thresholds. higherIsBetter=true means values ≥ threshold are
  // at least that good. Walk from best → worst.
  if (higherIsBetter) {
    if (bands.strong !== undefined && value >= bands.strong) return "strong";
    if (bands.healthy !== undefined && value >= bands.healthy) return "healthy";
    if (bands.watch !== undefined && value >= bands.watch) return "watch";
    return "critical";
  }
  if (bands.strong !== undefined && value <= bands.strong) return "strong";
  if (bands.healthy !== undefined && value <= bands.healthy) return "healthy";
  if (bands.watch !== undefined && value <= bands.watch) return "watch";
  return "critical";
}

export function computeRatios(
  s: Statements,
  // F1.e — Optional engine-canonical margin pair from calculated_metrics
  // (rows `ebitda_margin` and `net_margin`). When supplied, the Profitability
  // section sources `ebitdaMargin` and `netMargin` from the engine instead
  // of recomputing FE-side, so every margin display on a page agrees with
  // every other one. The legacy in-FE arithmetic stays as a fallback for
  // callers that haven't been migrated.
  canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null },
  // F2.2 — Optional engine-canonical metric map (`calculated_metrics` rows
  // keyed by name). When supplied, EVERY ratio that has a direct engine
  // equivalent is sourced from this map; the FE arithmetic stays as a
  // fallback only for pre-v2.1 cached periods. Two ratios remain FE-
  // arithmetic by design: `ltv` (uses user-supplied `propertyMarketValue`,
  // not engine-derived) and `adjusted_dscr` (uses user-supplied
  // `annualLeaseExpense`, not engine-derived). These are NOT canonical
  // duplications — they're legitimate FE arithmetic on user input.
  metricsByName?: Record<string, number | null>,
): RatioBundle {
  const t = deriveTotals(s);
  const bs = s.balanceSheet;
  const is = s.incomeStatement;
  const sup = s.supplementary;
  const days = sup.periodDays ?? 365;

  // F2.2 — Canonical-or-fallback helper. Reads `m` from metricsByName if
  // present and non-null; else returns the FE-arithmetic fallback. Engine
  // emits ratios as decimals (0.132 = 13.2%); pct() in this file returns
  // 0-100 percentages. Where the consuming UI shows a percentage, multiply
  // by 100. Where it shows a multiplier (1.5×), no transformation.
  const m = (name: string): number | null => {
    if (!metricsByName) return null;
    const v = metricsByName[name];
    return typeof v === "number" ? v : null;
  };
  const mOr = (name: string, fallback: number): number => {
    const v = m(name);
    return v === null ? fallback : v;
  };
  const mPctOr = (name: string, fallback: number): number => {
    const v = m(name);
    return v === null ? fallback : v * 100;
  };

  // Liquidity ────────────────────────────────────────────────────────────────
  const currentRatio = mOr("current_ratio", safeDiv(t.totalCurrentAssets, t.totalCurrentLiabilities));
  const quickRatio = mOr(
    "quick_ratio",
    safeDiv(bs.cash + bs.accountsReceivable, t.totalCurrentLiabilities),
  );
  const cashRatio = mOr("cash_ratio", safeDiv(bs.cash, t.totalCurrentLiabilities));

  // Profitability ────────────────────────────────────────────────────────────
  // F1.e + F2.2: prefer engine canonical when supplied (via either the
  // legacy `canonicalMargins` pair or the new `metricsByName` map). Engine
  // emits margins as ratios (0–1); pct() emits 0–100; multiply canonical
  // value by 100 to align units.
  const grossMargin = mPctOr("gross_margin", pct(t.grossProfit, is.revenue));
  const ebitdaMargin = m("ebitda_margin") !== null
    ? (m("ebitda_margin") as number) * 100
    : (canonicalMargins?.ebitdaMargin != null
        ? canonicalMargins.ebitdaMargin * 100
        : pct(t.ebitda, is.revenue));
  const netMargin = m("net_margin") !== null
    ? (m("net_margin") as number) * 100
    : (canonicalMargins?.netMargin != null
        ? canonicalMargins.netMargin * 100
        : pct(t.netIncome, is.revenue));
  const roa = mPctOr("roa", pct(t.netIncome, t.totalAssets));
  const roe = mPctOr("roe", pct(t.netIncome, t.totalEquity));
  // F2.2 — ROIC added as a new Profitability row (engine emits; FE didn't
  // surface previously). Engine formula: operating_profit × (1 − 0.16) /
  // max(total_debt + total_equity, 1) — NOPAT over invested capital.
  const roic = mPctOr(
    "roic",
    pct(t.ebit * (1 - 0.16), Math.max(t.totalDebt + t.totalEquity, 1)),
  );

  // Leverage ─────────────────────────────────────────────────────────────────
  const debtToEbitda = mOr("debt_to_ebitda", safeDiv(t.totalDebt, t.ebitda));
  const debtToEquity = mOr("debt_to_equity", safeDiv(t.totalDebt, t.totalEquity));
  const equityRatio = mPctOr("equity_ratio", pct(t.totalEquity, t.totalAssets));
  // F2.2 — LTV stays FE-arithmetic when propertyMarketValue is supplied
  // (user input, not engine-derived). When no override, read engine's
  // `debt_to_assets` canonical. This is one of the few FE-arithmetic sites
  // that survives F2's canonical-conformance rule because the input is
  // genuinely user-side (the property valuation isn't in the trial balance).
  // DO NOT "fix" this into a pure engine read — that would silently drop the
  // user's market-value input from the LTV displayed value.
  const ltv = sup.propertyMarketValue
    ? pct(t.totalDebt, sup.propertyMarketValue)
    : mPctOr("debt_to_assets", pct(t.totalDebt, t.totalAssets));

  // Coverage ─────────────────────────────────────────────────────────────────
  // F2.2 — interest_coverage switches from FE EBIT-basis to engine
  // EBITDA-basis canonical. Engine emits the same value as
  // `ebitda_to_interest`. Visible value shift expected (small — depreciation
  // delta between EBIT and EBITDA on both fixtures is modest).
  const interestCoverage = mOr("interest_coverage", safeDiv(t.ebit, is.interestExpense));
  // F2.2 — DSCR switches from FE cash-EBITDA basis to engine statutory-
  // EBITDA basis (aligns with F1.e canonical decision). EEI shift is
  // material (statutory adds 722 = 2.16M to numerator). Scandia unchanged
  // because 722 = 0.
  const dscr = mOr("dscr", safeDiv(t.ebitda, is.interestExpense + bs.shortTermDebt));
  // F2.2 — adjusted_dscr stays FE-arithmetic when annualLeaseExpense is
  // supplied (user input, not engine-derived). Same reasoning as LTV —
  // legitimate FE arithmetic on user input. When no lease supplied,
  // fall back to plain `dscr` (now engine canonical).
  const adjustedDscr = sup.annualLeaseExpense
    ? safeDiv(
        t.ebitda + sup.annualLeaseExpense,
        is.interestExpense + bs.shortTermDebt + sup.annualLeaseExpense,
      )
    : dscr;
  // F2.2 — NEW row: DSCR with LT principal proxy (engine canonical).
  // Different definition from `adjusted_dscr` above: principal proxy uses
  // LT debt / 8 (~10-year amortization), not lease expense. Surfaced as
  // a separate row so users can see both views.
  const dscrWithLtPrincipal = mOr(
    "dscr_with_lt_principal",
    // Fallback computation matches engine pipeline.py line 1185 (lt_debt
    // proxy at /8). When the engine row is absent (pre-v2.1), compute
    // inline using the FE bs.longTermDebt.
    safeDiv(t.ebitda, is.interestExpense + bs.longTermDebt / 8),
  );

  // Efficiency ───────────────────────────────────────────────────────────────
  // F2.2 — DIO / DPO / DSO / CCC switch to engine canonical. Engine
  // formulas match the FE's (DIO/DPO use total_operating_expense
  // denominator per the F1.d B1 closure). No definitional shift expected.
  // The narrow-COGS rationale below is retained as comment context for
  // the fallback FE-arithmetic path.
  // DIO / DPO denominator: TOTAL operating expense (COGS + OpEx + D&A), not
  // narrow COGS. Per the methodology calibration (archive/calibration_toolkit/financial_analysis.py
  // lines 543-548, 581): in a manufacturer, inventory absorbs all production
  // costs — materials + labor + utilities + overhead — not just raw-material
  // class-6 accounts (601/602/607). Industry convention uses total operating
  // expense as the DIO/DPO denominator. Using narrow `is.costOfGoodsSold`
  // here inflated Scandia's DIO from the correct ~53d to ~95d.
  const totalOperatingExpense =
    is.costOfGoodsSold + is.operatingExpenses + is.depreciationAmortization;
  const dso = mOr("dso", safeDiv(bs.accountsReceivable, is.revenue) * days);
  const dio = mOr("dio", safeDiv(bs.inventory, totalOperatingExpense) * days);
  const dpo = mOr("dpo", safeDiv(bs.accountsPayable, totalOperatingExpense) * days);
  const ccc = mOr("ccc", dso + dio - dpo);
  const assetTurnover = mOr("asset_turnover", safeDiv(is.revenue, t.totalAssets));

  // Bankruptcy — Altman Z″ (engine canonical, 1995 EM variant) ─────────────
  // F2.2 — Switched from FE inline Z(1968) formula to engine `altman_z_score`
  // canonical. Engine emits Z″ (1995 EM) — the variant designed for non-
  // manufacturing / services / RE / emerging markets. Z″ uses 4 components
  // (no sales/assets X5 term), different coefficients (6.56 / 3.26 / 6.72 /
  // 1.05), different thresholds (safe ≥ 2.60, distress < 1.10).
  //
  // Visible numeric shift expected on BOTH fixtures because the engine
  // formula differs from the FE Z(1968). This is the canonical fix
  // documented in DIAGNOSTIC_ALTMAN_CREDIT_VERDICT.md (F1.h-era).
  //
  // Fallback path (when engine row is absent — pre-v2.1 cached periods):
  // compute Z″ inline ONLY. The Z(1968) and Z'(1983) industry-switch
  // branches are deleted per the F2.2 kickoff ("delete the FE industry-
  // switch Altman path entirely"). Z″ is the single canonical variant.
  const zEngine = m("altman_z_score");
  const z = zEngine !== null
    ? zEngine
    : (
        // FE fallback — Z″ inline (single variant, no industry switch).
        // Z″ = 6.56·(WC/TA) + 3.26·(RE+CurrentNP)/TA + 6.72·(EBIT/TA)
        //    + 1.05·(Equity/TL)
        6.56 * safeDiv(t.workingCapital, t.totalAssets) +
        3.26 * safeDiv(bs.retainedEarnings + t.netIncome, t.totalAssets) +
        6.72 * safeDiv(t.ebit, t.totalAssets) +
        1.05 * safeDiv(t.totalEquity, t.totalLiabilities)
      );

  return {
    liquidity: [
      {
        key: "current_ratio",
        label: "Current Ratio",
        value: currentRatio,
        unit: "x",
        verdict: verdictFromBands(currentRatio, { strong: 2, healthy: 1.5, watch: 1 }),
        benchmark: "≥ 1.5× healthy · ≥ 2.0× strong",
        commentary:
          currentRatio >= 1.5
            ? "Comfortable short-term cushion against current obligations."
            : currentRatio >= 1
              ? "Tight but covered — monitor working capital weekly."
              : "Current liabilities exceed current assets — liquidity stress.",
      },
      {
        key: "quick_ratio",
        label: "Quick Ratio",
        value: quickRatio,
        unit: "x",
        verdict: verdictFromBands(quickRatio, { strong: 1.5, healthy: 1, watch: 0.7 }),
        benchmark: "≥ 1.0× healthy",
        commentary:
          quickRatio >= 1
            ? "Cash + receivables alone cover current liabilities."
            : "Reliance on inventory liquidation to meet short-term obligations.",
      },
      {
        key: "cash_ratio",
        label: "Cash Ratio",
        value: cashRatio,
        unit: "x",
        verdict: verdictFromBands(cashRatio, { strong: 0.5, healthy: 0.2, watch: 0.1 }),
        benchmark: "≥ 0.2× healthy",
        commentary:
          cashRatio >= 0.2
            ? "Adequate cash buffer for operating shocks."
            : "Limited dry cash — exposed to revenue interruption.",
      },
    ],
    profitability: [
      {
        key: "gross_margin",
        label: "Gross Margin",
        value: grossMargin,
        unit: "%",
        verdict: verdictFromBands(grossMargin, { strong: 40, healthy: 25, watch: 15 }),
        benchmark: "Industry-dependent · ≥ 25% healthy",
        commentary: `${grossMargin.toFixed(1)}% gross margin on ${formatCurrency(is.revenue, s.currency)} revenue.`,
      },
      {
        key: "ebitda_margin",
        label: "EBITDA Margin",
        value: ebitdaMargin,
        unit: "%",
        verdict: verdictFromBands(ebitdaMargin, { strong: 25, healthy: 15, watch: 8 }),
        benchmark: "≥ 15% healthy · ≥ 25% strong",
        commentary: `${formatCurrency(t.ebitda, s.currency)} EBITDA — operating cash generation.`,
      },
      {
        key: "net_margin",
        label: "Net Margin",
        value: netMargin,
        unit: "%",
        verdict: verdictFromBands(netMargin, { strong: 15, healthy: 8, watch: 3 }),
        benchmark: "≥ 8% healthy",
        commentary: `${formatCurrency(t.netIncome, s.currency)} bottom-line profit after all costs.`,
      },
      {
        key: "roa",
        label: "Return on Assets",
        value: roa,
        unit: "%",
        verdict: verdictFromBands(roa, { strong: 10, healthy: 5, watch: 2 }),
        benchmark: "≥ 5% healthy",
        commentary:
          roa >= 5
            ? "Assets generating solid returns."
            : "Asset base under-earning — review utilization.",
      },
      {
        key: "roe",
        label: "Return on Equity",
        value: roe,
        unit: "%",
        verdict: verdictFromBands(roe, { strong: 20, healthy: 12, watch: 6 }),
        benchmark: "≥ 12% healthy",
        commentary:
          roe >= 12
            ? "Capital deployed efficiently for shareholders."
            : "Equity returns below cost-of-capital benchmark.",
      },
      // F2.2 — NEW row: ROIC (engine canonical). Surfaced explicitly so the
      // dashboard's Ratios tab shows the return-on-invested-capital row that
      // was previously emitted by the engine but not displayed FE-side.
      {
        key: "roic",
        label: "Return on Invested Capital",
        value: roic,
        unit: "%",
        verdict: verdictFromBands(roic, { strong: 15, healthy: 10, watch: 5 }),
        benchmark: "≥ 10% healthy",
        commentary:
          roic >= 10
            ? "Invested capital earning above typical WACC."
            : "Returns below cost of capital — value-destroying configuration.",
      },
    ],
    leverage: [
      {
        key: "debt_to_ebitda",
        label: "Debt / EBITDA",
        value: debtToEbitda,
        unit: "x",
        verdict: verdictFromBands(
          debtToEbitda,
          { strong: 2, healthy: 3, watch: 4.5 },
          false,
        ),
        benchmark: "≤ 3× healthy · ≤ 2× strong",
        commentary:
          debtToEbitda <= 3
            ? "Debt service comfortably aligned with cash generation."
            : debtToEbitda <= 4.5
              ? "Elevated leverage — refinancing risk if EBITDA contracts."
              : "Stretched balance sheet — covenant risk likely.",
      },
      {
        key: "debt_to_equity",
        label: "Debt / Equity",
        value: debtToEquity,
        unit: "x",
        verdict: verdictFromBands(
          debtToEquity,
          { strong: 0.5, healthy: 1, watch: 2 },
          false,
        ),
        benchmark: "≤ 1.0× healthy",
        commentary:
          debtToEquity <= 1
            ? "Conservatively capitalized."
            : "Leverage exceeds equity cushion.",
      },
      {
        key: "equity_ratio",
        label: "Equity Ratio",
        value: equityRatio,
        unit: "%",
        verdict: verdictFromBands(equityRatio, { strong: 50, healthy: 30, watch: 15 }),
        benchmark: "≥ 30% healthy",
        commentary: `${equityRatio.toFixed(1)}% of assets funded by equity.`,
      },
      {
        key: "ltv",
        label: sup.propertyMarketValue ? "Loan-to-Value" : "Debt-to-Assets",
        value: ltv,
        unit: "%",
        verdict: verdictFromBands(ltv, { strong: 50, healthy: 65, watch: 80 }, false),
        benchmark: "≤ 65% healthy",
        commentary:
          ltv <= 65
            ? "Asset coverage of debt is comfortable."
            : "Limited equity headroom against pledged assets.",
      },
    ],
    coverage: [
      {
        key: "interest_coverage",
        label: "Interest Coverage",
        value: interestCoverage,
        unit: "x",
        verdict: verdictFromBands(
          interestCoverage,
          { strong: 6, healthy: 3, watch: 1.5 },
        ),
        benchmark: "≥ 3× healthy",
        commentary:
          interestCoverage >= 3
            ? "Earnings comfortably absorb interest load."
            : "Interest taking a meaningful bite of operating profit.",
      },
      {
        key: "dscr",
        label: "DSCR (interest + ST debt)",
        value: dscr,
        unit: "x",
        verdict: verdictFromBands(dscr, { strong: 1.5, healthy: 1.25, watch: 1 }),
        benchmark: "≥ 1.25× covenant-typical",
        commentary:
          dscr >= 1.25
            ? "Annual cash service comfortably covered."
            : "Debt service consumes most operating cash.",
      },
      {
        key: "adjusted_dscr",
        label: "Adjusted DSCR (incl. lease)",
        value: adjustedDscr,
        unit: "x",
        verdict: verdictFromBands(
          adjustedDscr,
          { strong: 1.5, healthy: 1.25, watch: 1 },
        ),
        benchmark: "≥ 1.25× including lease commitments",
        commentary: sup.annualLeaseExpense
          ? "Adds lease obligation to fixed charges — lender-style view."
          : "No lease component — same as DSCR.",
      },
      // F2.2 — NEW row: DSCR including LT principal amortization proxy
      // (engine canonical). Different from adjusted_dscr above:
      // numerator is statutory EBITDA, denominator adds LT debt / 8
      // (~10-year amortization proxy) instead of lease expense. Lender-
      // style view of covenant coverage when LT debt is the dominant
      // service component.
      {
        key: "dscr_with_lt_principal",
        label: "DSCR (incl. LT principal proxy)",
        value: dscrWithLtPrincipal,
        unit: "x",
        verdict: verdictFromBands(
          dscrWithLtPrincipal,
          { strong: 1.5, healthy: 1.25, watch: 1 },
        ),
        benchmark: "≥ 1.25× with 10-year amortization proxy",
        commentary:
          dscrWithLtPrincipal >= 1.25
            ? "Comfortable coverage of interest + LT principal amortization."
            : "Including LT principal amortization, coverage is tight — refinancing risk.",
      },
    ],
    efficiency: [
      {
        key: "dso",
        label: "Days Sales Outstanding",
        value: dso,
        unit: "days",
        verdict: verdictFromBands(dso, { strong: 30, healthy: 45, watch: 75 }, false),
        benchmark: "≤ 45 days healthy",
        commentary: `Average ${dso.toFixed(0)}-day collection cycle on receivables.`,
      },
      {
        key: "dio",
        label: "Days Inventory Outstanding",
        value: dio,
        unit: "days",
        verdict: verdictFromBands(dio, { strong: 30, healthy: 60, watch: 100 }, false),
        benchmark: "≤ 60 days for FMCG · varies by industry",
        commentary: `Inventory turns every ${dio.toFixed(0)} days.`,
      },
      {
        key: "dpo",
        label: "Days Payables Outstanding",
        value: dpo,
        unit: "days",
        verdict: verdictFromBands(dpo, { strong: 60, healthy: 45, watch: 30 }),
        benchmark: "Higher = better supplier float (within terms)",
        commentary: `${dpo.toFixed(0)}-day average to settle suppliers.`,
      },
      {
        key: "ccc",
        label: "Cash Conversion Cycle",
        value: ccc,
        unit: "days",
        verdict: verdictFromBands(ccc, { strong: 30, healthy: 60, watch: 100 }, false),
        benchmark: "Lower is better — cash speed",
        commentary: `${ccc.toFixed(0)}-day gap between cash out and cash in.`,
      },
      {
        key: "asset_turnover",
        label: "Asset Turnover",
        value: assetTurnover,
        unit: "x",
        verdict: verdictFromBands(
          assetTurnover,
          { strong: 1.5, healthy: 0.8, watch: 0.4 },
        ),
        benchmark: "≥ 0.8× healthy (industry-dependent)",
        commentary: `${assetTurnover.toFixed(2)}× revenue per unit of assets.`,
      },
    ],
    bankruptcy: [
      // F2.2 — Altman Z″ canonical (engine, 1995 EM variant). Replaces the
      // FE inline Z(1968) formula AND the FE industry-switch path. Single
      // variant, single source of truth. Thresholds updated to Z″:
      // safe ≥ 2.60, grey 1.10–2.60, distress < 1.10 (was Z 1968's
      // 2.60 / 1.80 / —). The label calls out the variant explicitly so
      // users can verify against the Comprehensive Report's credit card.
      {
        key: "altman_z",
        label: "Altman Z″-Score",
        value: z,
        unit: "ratio",
        verdict: verdictFromBands(z, { strong: 3, healthy: 2.6, watch: 1.1 }),
        benchmark: "≥ 2.60 safe · 1.10–2.60 grey · < 1.10 distress (Z″ 1995 EM)",
        commentary:
          z >= 2.6
            ? "Bankruptcy risk: low. Balance sheet structurally sound."
            : z >= 1.1
              ? "Bankruptcy risk: grey zone. Monitor leverage and cash flow."
              : "Bankruptcy risk: distress zone. Action required.",
      },
    ],
  };
}

// ─── Recommendations ────────────────────────────────────────────────────────

export type RecommendationPriority = "critical" | "high" | "medium" | "info";

export interface Recommendation {
  id: string;
  priority: RecommendationPriority;
  title: string;
  rationale: string;
  action: string;
  /** Estimated annual cash impact, in the company's currency. */
  estimatedImpact?: number;
  /** F5.0 Phase 7 — the registry key of the rule that fired. Used by the
   *  RecommendationCard to render an explainability block ("Triggered by")
   *  showing the metric, threshold and value that crossed it. The rule
   *  generation logic is NOT changed by exposing this — the engine has
   *  always carried it; we just propagate it to the card now. */
  ruleKey?: string;
  /** F5.0 Phase 7 — the structured numeric facts the rule asserted to
   *  fire. Keys match the rule's `factsCited` keys (e.g. dscr, total_debt,
   *  current_ratio). Used to render the explainability block. */
  factsCited?: Record<string, number>;
}

// Inline import avoids the periodFacts ↔ financialReport circular
// dependency. detectConditions consumes a PeriodFacts-shaped object;
// we build a minimal one in-place from canonical statement fields when
// they're present, falling back to legacy derivation only as a safety
// net. The function NEVER goes through deriveTotals(s).ebitda directly
// — that's the operational view that produced the 3 false-alarm cards.
import { detectConditions, severityRank } from "./recommendationRules";

export function generateRecommendations(
  s: Statements,
  _ratios?: RatioBundle,
): Recommendation[] {
  // ── DELEGATING IMPLEMENTATION ────────────────────────────────────────
  // The previous in-place rule logic read `t.ebitda` and `t.netIncome`
  // from `deriveTotals(s)` — the OPERATIONAL view (excludes 722). For a
  // healthy CRE company like EEI that produced 3 damaging false alarms:
  //   • "Restore debt service coverage" (DSCR −0.05 on operational EBITDA)
  //   • "Stabilize against distress signals" (Altman Z' 0.53, wrong variant)
  //   • "Restore operating profitability" (EBITDA margin −1.3%, SKU language)
  //
  // The function now delegates to `detectConditions(...)` from the
  // canonical rule registry. Every rule reads STATUTORY values
  // explicitly; every rule has an industry filter; every "true_*"
  // distress rule stays silent unless the underlying condition is
  // genuinely present.
  const t = deriveTotals(s);
  const ap = (s as Statements & { assembled_pl?: Record<string, number> }).assembled_pl ?? {};
  const ab = (s as Statements & { assembled_bs?: Record<string, number> }).assembled_bs ?? {};
  const ac = (s as Statements & { assembled_cf?: Record<string, number> }).assembled_cf ?? {};
  const pick = (canon: number | undefined, legacy: number): number =>
    typeof canon === "number" ? canon : legacy;
  // Build the minimal PeriodFacts the rule registry reads. We populate
  // every field the rules touch — extra fields they don't read are fine
  // to omit. STATUTORY values come from `assembled_*` when present.
  const ebitdaStatutory = pick(ap.ebitda_statutory, t.ebitda);
  const niStatutory = pick(ap.net_income_statutory, t.netIncome);
  const cfo = pick(ac.cash_from_operating, niStatutory + pick(ap.depreciation, s.incomeStatement.depreciationAmortization));
  const capexReal = pick(ac.capex_real, -(ap.capitalized_own_work_memo ?? 0));
  const bankDebt = pick(ab.total_debt, t.totalDebt);
  const totalAssets = pick(ab.total_assets, t.totalAssets);
  const totalEquity = pick(ab.total_equity, t.totalEquity);
  const cash = pick(ab.cash, s.balanceSheet.cash);
  const apDividends = pick(ab.ap_dividends, 0);
  const intercompany = pick(ab.intercompany_loans, 0);
  const investmentProp = pick(ab.ppe_net, s.balanceSheet.propertyPlantEquipment);
  const interest = pick(ap.interest_expense, s.incomeStatement.interestExpense);
  const depreciation = pick(ap.depreciation, s.incomeStatement.depreciationAmortization);
  const tax = pick(ap.tax, s.incomeStatement.taxExpense);
  const rentalRevenue = pick(ap.revenue, s.incomeStatement.revenue);
  const capitalized = pick(ap.capitalized_own_work_memo, 0);
  // APPROXIMATION — annual principal estimated at 10% of debt (a trial
  // balance carries no amortization schedule). Legacy fallback path only;
  // engine periodFacts carry the real figure when available.
  const principalProxy = bankDebt * 0.1;
  const dscr = ebitdaStatutory > 0
    ? ebitdaStatutory / Math.max(interest + Math.max(principalProxy, depreciation), 1)
    : 0;
  const dteAdj = bankDebt > 0 && ebitdaStatutory > 0
    ? bankDebt / (ebitdaStatutory + pick(ap.financial_income_other, 0))
    : 0;
  const safeFacts = {
    period_id: "legacy",
    entity: s.companyName ?? "Entity",
    industry: (s.industry ?? null) as string | null,
    currency: s.currency,
    computed_at: new Date().toISOString(),
    pipeline_version: "legacy",
    pl: {
      rental_revenue: rentalRevenue,
      capitalized_own_work_memo: capitalized,
      revenue: pick(ap.total_operating_revenue, rentalRevenue + capitalized),
      ebitda: ebitdaStatutory,
      ebitda_excl_capitalized: ebitdaStatutory - capitalized,
      depreciation,
      ebit: pick(ap.operating_ebit, ebitdaStatutory - depreciation),
      interest_expense: interest,
      fx_result: 0,
      dividend_income: pick(ap.financial_income_other, 0),
      net_financial_result: 0,
      profit_before_tax: pick(ap.pretax, ebitdaStatutory - depreciation - interest),
      tax,
      net_profit: niStatutory,
    },
    bs: {
      cash,
      cash_fx_component: 0,
      ar_net: s.balanceSheet.accountsReceivable,
      intercompany_loans: intercompany,
      prepayments: 0,
      current_assets: t.totalCurrentAssets,
      investment_property_net: investmentProp,
      ppe_net: investmentProp,
      non_current_assets: t.totalNonCurrentAssets,
      total_assets: totalAssets,
      suppliers: s.balanceSheet.accountsPayable,
      dividends_payable: apDividends,
      bank_debt_total: bankDebt,
      short_term_liabilities: t.totalCurrentLiabilities,
      total_liabilities: pick(ab.total_liabilities, t.totalLiabilities),
      share_capital: s.balanceSheet.shareCapital,
      revaluation_reserves: 0,
      retained_earnings: pick(ab.retained_earnings, s.balanceSheet.retainedEarnings),
      current_year_pnl: niStatutory,
      total_equity: totalEquity,
      bs_balance_check: 0,
      // Concentration heuristics — fed by the periodFacts builder when
      // it has line items. Without them (legacy entry-point), default
      // to undefined; the rules then stay silent rather than guessing.
      lender_concentration_pct: undefined as number | undefined,
      tenant_concentration_pct: undefined as number | undefined,
    },
    cf: {
      cash_from_operating: cfo,
      cash_used_in_investing: capexReal,
      cash_used_in_financing: 0,
      net_change_in_cash: cfo + capexReal,
      opening_cash: 0,
      closing_cash: cash,
      drift: 0,
      dividends_declared_but_unpaid: apDividends > 1000,
    },
    ratios: {
      current_ratio: 0, quick_ratio: 0, cash_ratio: 0,
      debt_to_equity: 0, debt_to_assets: 0, equity_ratio: 0,
      interest_coverage_ebit: 0,
      ebitda_to_interest: interest > 0 ? ebitdaStatutory / interest : 0,
      dscr,
      debt_to_ebitda: ebitdaStatutory > 0 ? bankDebt / ebitdaStatutory : 0,
      debt_to_ebitda_adjusted: dteAdj,
      ebitda_margin_gross: 0, ebitda_margin_clean: 0, net_margin: 0,
      roe: 0, roa: 0, property_yield: 0,
    },
    valuation: {
      primary_method: "asset_based", primary_value: 0, confidence: "low" as const,
      industry_key: s.industry ?? null, ev_ebitda_p50: null,
    },
    audit: { bs_balance_check: 0, has_line_items: false, industry_classified: !!s.industry },
  };
  const conditions = detectConditions(safeFacts as never).sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );

  // ── DetectedCondition → Recommendation mapping ───────────────────────
  const severityToPriority: Record<string, RecommendationPriority> = {
    critical: "critical",
    attention: "high",
    info: "info",
  };
  const out: Recommendation[] = conditions.map((c) => ({
    id: c.ruleKey,
    priority: severityToPriority[c.severity] ?? "medium",
    title: c.title,
    rationale: c.rationaleFallback,
    action: c.actionsFallback.join(" "),
    estimatedImpact:
      typeof c.factsCited.interest_savings_if_repaid === "number"
        ? c.factsCited.interest_savings_if_repaid
        : typeof c.factsCited.potential_savings_per_50bps === "number"
          ? c.factsCited.potential_savings_per_50bps
          : undefined,
    // F5.0 Phase 7 — propagate engine telemetry to the card.
    ruleKey: c.ruleKey,
    factsCited: c.factsCited,
  }));

  if (out.length === 0) {
    out.push({
      id: "all_healthy",
      priority: "info",
      title: "Financials are in healthy range across all dimensions",
      rationale: "No critical or high-priority items detected.",
      action:
        "Maintain current discipline. Consider strategic capital deployment: growth investment, dividend, or buyback.",
    });
  }

  // Sort by priority (critical → info).
  const order: Record<RecommendationPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    info: 3,
  };
  out.sort((a, b) => order[a.priority] - order[b.priority]);
  return out;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

export function formatCurrency(n: number, currency: string): string {
  const abs = Math.abs(n);
  let formatted: string;
  if (abs >= 1_000_000_000) formatted = `${(n / 1_000_000_000).toFixed(2)}B`;
  else if (abs >= 1_000_000) formatted = `${(n / 1_000_000).toFixed(2)}M`;
  else if (abs >= 1_000) formatted = `${(n / 1_000).toFixed(0)}K`;
  else formatted = n.toFixed(0);
  return `${currency} ${formatted}`;
}

export function formatNumber(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatRatio(r: Ratio): string {
  switch (r.unit) {
    case "x":
      return `${r.value.toFixed(2)}×`;
    case "%":
      return `${r.value.toFixed(1)}%`;
    case "days":
      return `${r.value.toFixed(0)} days`;
    case "ratio":
      return r.value.toFixed(2);
  }
}

export function verdictColor(v: RatioVerdict): { bg: string; text: string } {
  switch (v) {
    case "strong":
      return { bg: "#E6F7F4", text: "#1B7268" };
    case "healthy":
      return { bg: "#E6F7F4", text: "#2AA89B" };
    case "watch":
      return { bg: "#E6F7F4", text: "#1B7268" };
    case "critical":
      return { bg: "#fee2e2", text: "#991b1b" };
  }
}

export function verdictLabel(v: RatioVerdict): string {
  return v === "strong"
    ? "Strong"
    : v === "healthy"
      ? "Healthy"
      : v === "watch"
        ? "Watch"
        : "Critical";
}

// ─── HTML report renderer ───────────────────────────────────────────────────

export function renderReportHtml(s: Statements): string {
  const t = deriveTotals(s);
  const r = computeRatios(s);
  const recs = generateRecommendations(s, r);

  // Statutory-canonical pick (same pattern as `generateRecommendations` at line
  // 617-621). The standalone HTML report previously read only `is.revenue`,
  // `t.ebitda`, and `t.netIncome` — all the OPERATIONAL view, which excludes
  // account 722 (capitalized own work). For asset-heavy entities like EEI
  // Imobiliara that produced Revenue 2.73M / EBITDA −37k where the engine's
  // canonical statutory view is Revenue 4.89M / EBITDA +2.13M, and the in-app
  // `ComprehensiveReport.tsx` already shows the correct statutory figures.
  // The engine surfaces these on `assembled_pl` — read them here and fall back
  // to the operational legacy fields when they aren't populated (older
  // pipeline payloads).
  const ap = (s as Statements & { assembled_pl?: Record<string, number> }).assembled_pl ?? {};
  const pick = (canon: number | undefined, legacy: number): number =>
    typeof canon === "number" ? canon : legacy;
  const capOwnWork = pick(ap.capitalized_own_work_memo, s.incomeStatement.capitalizedOwnWork ?? 0);
  const operatingRevenue = pick(ap.total_operating_revenue, s.incomeStatement.revenue + capOwnWork);
  const ebitdaStatutory = pick(ap.ebitda_statutory, t.ebitda);
  const ebitdaCash = pick(ap.ebitda_cash, t.ebitda);
  const netIncomeStatutory = pick(ap.net_income_statutory, t.netIncome);
  const ebitStatutory = pick(ap.operating_ebit, ebitdaStatutory - s.incomeStatement.depreciationAmortization);
  const pretaxStatutory = pick(ap.pretax, ebitStatutory - s.incomeStatement.interestExpense + (s.incomeStatement.financialIncome ?? 0) - (s.incomeStatement.financialExpense ?? 0));
  const has722 = Math.abs(capOwnWork) > 1;

  // ─ Style block ─ Lender-grade institutional document.
  // Restrained palette (ink + accent + greys), serif headlines + sans body,
  // tabular lining figures everywhere, hairline tables, A4 print-correct.
  const css = `
    @page {
      size: A4;
      margin: 22mm 18mm 24mm 18mm;
      @bottom-center {
        content: "Financial Analysis · Page " counter(page) " of " counter(pages);
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 8.5pt;
        color: #6b7280;
        letter-spacing: 0.04em;
      }
    }

    :root {
      /* Primary + secondary text are near-black / dark-grey (2026-07-25) —
         they were teal (#1B7268), which made the whole report read green.
         The teal --accent below is kept for accents (borders, labels). */
      --ink: #16181d;
      --ink-soft: #454b56;
      --ink-mute: #6B7280;
      --accent: #2AA89B;
      --rule: #C9CDD2;
      --rule-soft: #E5E7EB;
      --paper: #FFFFFF;
      --bg-soft: #F7F8FA;
      --serif: 'Source Serif Pro', 'Source Serif 4', 'Source Serif', Charter, 'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif;
      --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Helvetica Neue', Arial, sans-serif;
    }

    * { box-sizing: border-box; }
    html, body { background: var(--paper); }

    body {
      font-family: var(--sans);
      font-size: 10.5pt;
      line-height: 1.55;
      color: var(--ink-soft);
      margin: 0 auto;
      padding: 48px 56px 64px;
      max-width: 880px;
      background: var(--paper);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      font-feature-settings: "kern" 1, "liga" 1;
    }

    /* Tabular lining figures for every numeric cell */
    .num,
    .ratio-card .value,
    .rec .impact,
    table.fin td.num,
    table.fin th.num {
      font-variant-numeric: tabular-nums lining-nums;
      font-feature-settings: "tnum" 1, "lnum" 1, "kern" 1;
    }

    /* Running header — one quiet line on top */
    .running-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--rule);
      font-family: var(--sans);
      font-size: 8.5pt;
      color: var(--ink-mute);
      letter-spacing: 0.10em;
      text-transform: uppercase;
      margin-bottom: 28px;
    }
    .running-header .org { color: var(--ink); font-weight: 600; }

    h1 {
      font-family: var(--serif);
      font-size: 26pt;
      font-weight: 600;
      color: var(--ink);
      margin: 0 0 4px;
      letter-spacing: -0.01em;
      line-height: 1.15;
      border: none;
      padding: 0;
      break-after: avoid;
      page-break-after: avoid;
    }

    h2 {
      font-family: var(--serif);
      font-size: 15pt;
      font-weight: 600;
      color: var(--ink);
      background: none;
      padding: 0 0 6px;
      margin: 34px 0 14px;
      border-bottom: 1px solid var(--ink);
      border-radius: 0;
      letter-spacing: -0.005em;
      break-after: avoid;
      page-break-after: avoid;
    }

    h3 {
      font-family: var(--sans);
      font-size: 9.5pt;
      font-weight: 600;
      color: var(--ink);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin: 22px 0 10px;
      padding: 0;
      border: none;
      break-after: avoid;
      page-break-after: avoid;
    }

    p { margin: 8px 0; }

    /* Brief header block — quiet, no fill */
    .header-info {
      background: none;
      border: none;
      border-left: 2px solid var(--accent);
      padding: 2px 14px;
      margin: 8px 0 26px;
      font-size: 9.5pt;
      color: var(--ink-soft);
    }
    .header-info p { margin: 3px 0; }
    .header-info strong { color: var(--ink); font-weight: 600; }

    /* Layout grid */
    .grid { display: grid; gap: 24px 28px; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
    .grid-4 { grid-template-columns: 1fr 1fr 1fr 1fr; }

    /* Metric / ratio card — flat, hairline-separated, no heavy boxes */
    .ratio-card {
      background: none;
      padding: 12px 0 2px;
      border-left: none;
      border-top: 1px solid var(--rule-soft);
      border-radius: 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .ratio-card .label {
      font-family: var(--sans);
      font-size: 8.5pt;
      color: var(--ink-mute);
      text-transform: uppercase;
      letter-spacing: 0.10em;
      margin-bottom: 6px;
      font-weight: 500;
    }
    .ratio-card .value {
      font-family: var(--serif);
      font-size: 19pt;
      font-weight: 600;
      color: var(--ink);
      line-height: 1.1;
      letter-spacing: -0.01em;
    }
    .ratio-card .meta {
      font-size: 8.75pt;
      color: var(--ink-mute);
      margin-top: 6px;
      line-height: 1.45;
    }

    /* Verdict badge — restrained institutional tones */
    .badge {
      display: inline-block;
      font-family: var(--sans);
      font-size: 7.5pt;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 2px;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      border: 1px solid;
      vertical-align: 1px;
    }
    .badge.v-strong   { background: #E6F7F4; color: #1B7268; border-color: #8FE3D9; }
    .badge.v-healthy  { background: #E6F7F4; color: #1B7268; border-color: #8FE3D9; }
    .badge.v-watch    { background: #E6F7F4; color: #1B7268; border-color: #8FE3D9; }
    .badge.v-critical { background: #F4E8E8; color: #7A1F1F; border-color: #C7A6A6; }

    /* Callouts — minimal hairline, no fill */
    .commentary, .risk, .action {
      padding: 10px 14px;
      margin: 10px 0;
      font-size: 9.5pt;
      background: none;
      border-left: 2px solid var(--rule);
      color: var(--ink-soft);
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .commentary { border-left-color: #2AA89B; }
    .risk       { border-left-color: #8B1A1A; }
    .action     { border-left-color: #1B7268; }
    .commentary strong, .risk strong, .action strong { color: var(--ink); font-weight: 600; }

    /* Executive verdict band — rule-bracketed, not a coloured block */
    .insight {
      background: none;
      color: var(--ink);
      padding: 14px 0;
      margin: 12px 0 18px;
      border: none;
      border-top: 1px solid var(--ink);
      border-bottom: 1px solid var(--ink);
      font-size: 11pt;
      font-family: var(--serif);
      line-height: 1.45;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .insight strong {
      font-family: var(--sans);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      font-size: 8.5pt;
      color: var(--accent);
      display: block;
      margin-bottom: 4px;
    }

    .savings-box {
      background: var(--bg-soft);
      color: var(--ink);
      padding: 14px 18px;
      margin: 14px 0;
      text-align: left;
      border-radius: 0;
      border-left: 2px solid var(--accent);
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .savings-box .number {
      font-family: var(--serif);
      font-size: 22pt;
      font-weight: 600;
      display: block;
      margin: 4px 0;
      color: var(--ink);
      font-variant-numeric: tabular-nums lining-nums;
      font-feature-settings: "tnum" 1, "lnum" 1;
    }

    /* Financial statement tables — hairline horizontal rules only, no zebra */
    table.fin {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0 24px;
      font-size: 10pt;
    }
    table.fin thead { display: table-header-group; }
    table.fin tfoot { display: table-footer-group; }
    table.fin th, table.fin td {
      padding: 6.5px 0;
      text-align: left;
      border-bottom: 1px solid var(--rule-soft);
      vertical-align: baseline;
    }
    table.fin th {
      background: none;
      color: var(--ink);
      font-family: var(--sans);
      font-weight: 600;
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      border-bottom: 1px solid var(--ink);
      padding-bottom: 9px;
    }
    table.fin th.num, table.fin td.num {
      text-align: right;
      white-space: nowrap;
      padding-left: 18px;
    }
    table.fin tr.subtotal td {
      font-weight: 600;
      background: none;
      border-top: 1px solid var(--rule);
      border-bottom: 1px solid var(--rule-soft);
      color: var(--ink);
      padding-top: 8px;
    }
    table.fin tr.total td {
      font-weight: 700;
      border-top: 1px solid var(--ink);
      border-bottom: 2px solid var(--ink);
      padding-top: 9px;
      padding-bottom: 9px;
      color: var(--ink);
    }
    table.fin tr.indent td:first-child {
      padding-left: 22px;
      color: var(--ink-soft);
      font-weight: 400;
    }
    table.fin tbody tr { break-inside: avoid; page-break-inside: avoid; }

    /* Priority pills — restrained, bordered chips */
    .priority-pill {
      display: inline-block;
      font-family: var(--sans);
      font-size: 7.5pt;
      font-weight: 600;
      padding: 1.5px 8px;
      border-radius: 2px;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      margin-right: 10px;
      vertical-align: 2px;
      border: 1px solid;
    }
    .priority-critical { background: #FAF1F1; color: #7A1F1F; border-color: #C7A6A6; }
    .priority-high     { background: #E6F7F4; color: #1B7268; border-color: #8FE3D9; }
    .priority-medium   { background: #E6F7F4; color: #1B7268; border-color: #8FE3D9; }
    .priority-info     { background: #F1F2F4; color: #4B5563; border-color: #C7CCD3; }

    /* Recommendations — hairline-separated, no card boxes */
    .rec {
      border: none;
      border-top: 1px solid var(--rule-soft);
      border-radius: 0;
      padding: 16px 0 8px;
      margin: 0;
      background: none;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .rec:first-of-type { border-top: 1px solid var(--ink); }
    .rec h4 {
      margin: 0 0 8px;
      font-family: var(--serif);
      font-size: 11.5pt;
      color: var(--ink);
      font-weight: 600;
      line-height: 1.3;
    }
    .rec p { margin: 4px 0; font-size: 9.75pt; color: var(--ink-soft); line-height: 1.5; }
    .rec p strong { color: var(--ink); font-weight: 600; }
    .rec .impact {
      background: none;
      color: var(--ink);
      font-size: 9pt;
      padding: 5px 10px 5px 12px;
      border-radius: 0;
      border-left: 2px solid var(--accent);
      display: inline-block;
      margin-top: 8px;
      letter-spacing: 0.01em;
    }

    /* Footnoted basis-of-preparation block */
    .basis-note {
      margin-top: 36px;
      padding: 14px 0 0;
      border-top: 1px solid var(--rule);
      font-size: 8.75pt;
      color: var(--ink-mute);
      line-height: 1.55;
    }
    .basis-note strong {
      color: var(--ink-soft);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      font-size: 8pt;
      display: block;
      margin-bottom: 4px;
    }

    /* Document footer — appears once on screen; print uses @page footer */
    .footer {
      margin-top: 18px;
      padding-top: 12px;
      border-top: 1px solid var(--rule-soft);
      font-size: 8.5pt;
      color: var(--ink-mute);
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      letter-spacing: 0.04em;
    }
    .footer .lhs strong { color: var(--ink-soft); font-weight: 600; }

    @media print {
      html, body {
        background: white;
        color: black;
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      body {
        padding: 0;
        max-width: none;
        font-size: 10pt;
      }
      .running-header { margin-bottom: 16px; }
      h1 { font-size: 22pt; }
      h2 { font-size: 13pt; margin-top: 26px; break-after: avoid; page-break-after: avoid; }
      h3 { font-size: 9pt; break-after: avoid; page-break-after: avoid; }
      .rec, .ratio-card, .insight, .savings-box, .commentary, .risk, .action,
      table.fin tr {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .footer { display: none; }  /* superseded by @page bottom-center */
    }
  `;

  const today = new Date().toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Build executive summary block.
  const criticalCount = recs.filter((r) => r.priority === "critical").length;
  const highCount = recs.filter((r) => r.priority === "high").length;
  const overallVerdict =
    criticalCount > 0
      ? `Action required — ${criticalCount} critical item${criticalCount === 1 ? "" : "s"} flagged.`
      : highCount > 0
        ? `Generally healthy with ${highCount} priority area${highCount === 1 ? "" : "s"} to strengthen.`
        : "Financials in healthy range across all dimensions.";

  // ─ Per-section renderers ──────────────────────────────────────────────────
  // Verdict is rendered via scoped `.badge.v-<verdict>` class (CSS-driven)
  // rather than the shared `verdictColor()` palette — keeps the report's
  // restrained institutional tones independent of the live UI's colours.
  const ratioCard = (rt: Ratio): string => `
      <div class="ratio-card">
        <div class="label">${escapeHtml(rt.label)}</div>
        <div class="value">${escapeHtml(formatRatio(rt))}</div>
        <div class="meta">
          <span class="badge v-${rt.verdict}">${escapeHtml(verdictLabel(rt.verdict))}</span>
          &nbsp;${escapeHtml(rt.benchmark)}
        </div>
      </div>
    `;

  const ratioGroup = (title: string, group: Ratio[]): string => `
    <h3>${escapeHtml(title)}</h3>
    <div class="grid grid-3">${group.map(ratioCard).join("")}</div>
    ${group
      .filter((rt) => rt.verdict === "watch" || rt.verdict === "critical")
      .map(
        (rt) =>
          `<div class="${rt.verdict === "critical" ? "risk" : "commentary"}">
            <strong>${escapeHtml(rt.label)}:</strong> ${escapeHtml(rt.commentary)}
          </div>`,
      )
      .join("")}
  `;

  const balanceSheetTable = (): string => {
    // canonical_bs v2 — serialize the engine object verbatim (contract
    // "Consumption rules": exports serialize canonical rows and totals when
    // present). No deriveTotals, no bucket reads on this path; every figure
    // below is a field of `s.canonical_bs`. Legacy fallback (no canonical_bs)
    // keeps the deriveTotals table unchanged.
    const cbs = s.canonical_bs;
    if (cbs) {
      const sideRows = (side: "assets" | "equity_liabilities"): string =>
        cbs.sections
          .filter((sec) => canonicalBsSectionMeta(sec.id).side === side)
          .map((sec) => {
            const meta = canonicalBsSectionMeta(sec.id);
            const rows = cbs.rows.filter((row) => row.section === sec.id);
            if (rows.length === 0 && sec.subtotal === 0) return "";
            return (
              rows
                .map(
                  (row) =>
                    `<tr class="indent"><td>${escapeHtml(row.label)}${
                      row.account_codes.length
                        ? ` <span style="color:var(--ink-mute)">(${escapeHtml(row.account_codes.join(", "))})</span>`
                        : ""
                    }</td><td class="num">${money(row.amount, s.currency)}</td></tr>`,
                )
                .join("") +
              `<tr class="subtotal"><td>${escapeHtml(meta.subtotalLabel)}</td><td class="num">${money(sec.subtotal, s.currency)}</td></tr>`
            );
          })
          .join("");
      // Status footer — MATERIAL_IMBALANCE must read as a defect (red .risk
      // block with the engine's diagnosis), never as a clean statement.
      const statusNote =
        cbs.status === "MATERIAL_IMBALANCE"
          ? `<div class="risk"><strong>Balance check: MATERIAL IMBALANCE.</strong> Assets − (Equity + Liabilities) = ${money(cbs.difference, s.currency)}. This balance sheet does not reconcile; do not rely on it until resolved.${
              (cbs.diagnosis ?? []).length
                ? ` Engine diagnosis: ${(cbs.diagnosis ?? [])
                    .map((d) => `${escapeHtml(d.code)} — ${escapeHtml(d.detail)}`)
                    .join("; ")}.`
                : ""
            }</div>`
          : cbs.status === "MINOR_DRIFT"
            ? `<div class="commentary"><strong>Balance check: minor drift.</strong> Assets − (Equity + Liabilities) = ${money(cbs.difference, s.currency)}.</div>`
            : `<div class="commentary"><strong>Balance check: balanced.</strong> Assets = Equity + Liabilities (engine-verified, mapping ${escapeHtml(cbs.mapping_version)}).</div>`;
      return `
      <table class="fin">
        <thead><tr><th>Balance Sheet</th><th class="num">${escapeHtml(s.periodLabel)}</th></tr></thead>
        <tbody>
          ${sideRows("assets")}
          <tr class="total"><td>Total Assets</td><td class="num">${money(cbs.totals.assets, s.currency)}</td></tr>
          ${sideRows("equity_liabilities")}
          <tr class="subtotal"><td>Total Liabilities</td><td class="num">${money(cbs.totals.liabilities, s.currency)}</td></tr>
          <tr class="total"><td>Total Equity + Liabilities</td><td class="num">${money(cbs.totals.equity_plus_liabilities, s.currency)}</td></tr>
        </tbody>
      </table>
      ${statusNote}
    `;
    }
    const bs = s.balanceSheet;
    return `
      <table class="fin">
        <thead><tr><th>Balance Sheet</th><th class="num">${escapeHtml(s.periodLabel)}</th></tr></thead>
        <tbody>
          <tr class="subtotal"><td>Current Assets</td><td class="num">${money(t.totalCurrentAssets, s.currency)}</td></tr>
          <tr class="indent"><td>Cash & equivalents</td><td class="num">${money(bs.cash, s.currency)}</td></tr>
          <tr class="indent"><td>Accounts receivable</td><td class="num">${money(bs.accountsReceivable, s.currency)}</td></tr>
          <tr class="indent"><td>Inventory</td><td class="num">${money(bs.inventory, s.currency)}</td></tr>
          <tr class="indent"><td>Other current assets</td><td class="num">${money(bs.otherCurrentAssets, s.currency)}</td></tr>
          <tr class="subtotal"><td>Non-Current Assets</td><td class="num">${money(t.totalNonCurrentAssets, s.currency)}</td></tr>
          <tr class="indent"><td>Property, plant & equipment</td><td class="num">${money(bs.propertyPlantEquipment, s.currency)}</td></tr>
          <tr class="indent"><td>Intangibles</td><td class="num">${money(bs.intangibles, s.currency)}</td></tr>
          <tr class="indent"><td>Other non-current assets</td><td class="num">${money(bs.otherNonCurrentAssets, s.currency)}</td></tr>
          <tr class="total"><td>Total Assets</td><td class="num">${money(t.totalAssets, s.currency)}</td></tr>

          <tr class="subtotal"><td>Current Liabilities</td><td class="num">${money(t.totalCurrentLiabilities, s.currency)}</td></tr>
          <tr class="indent"><td>Accounts payable</td><td class="num">${money(bs.accountsPayable, s.currency)}</td></tr>
          <tr class="indent"><td>Short-term debt</td><td class="num">${money(bs.shortTermDebt, s.currency)}</td></tr>
          <tr class="indent"><td>Other current liabilities</td><td class="num">${money(bs.otherCurrentLiabilities, s.currency)}</td></tr>
          <tr class="subtotal"><td>Non-Current Liabilities</td><td class="num">${money(t.totalNonCurrentLiabilities, s.currency)}</td></tr>
          <tr class="indent"><td>Long-term debt</td><td class="num">${money(bs.longTermDebt, s.currency)}</td></tr>
          <tr class="indent"><td>Other non-current liabilities</td><td class="num">${money(bs.otherNonCurrentLiabilities, s.currency)}</td></tr>
          <tr class="subtotal"><td>Total Liabilities</td><td class="num">${money(t.totalLiabilities, s.currency)}</td></tr>
          <tr class="indent"><td>Share capital</td><td class="num">${money(bs.shareCapital, s.currency)}</td></tr>
          <tr class="indent"><td>Retained earnings</td><td class="num">${money(bs.retainedEarnings, s.currency)}</td></tr>
          <tr class="indent"><td>Other equity</td><td class="num">${money(bs.otherEquity, s.currency)}</td></tr>
          <tr class="subtotal"><td>Total Equity</td><td class="num">${money(t.totalEquity, s.currency)}</td></tr>
          <tr class="total"><td>Total Liabilities + Equity</td><td class="num">${money(t.totalLiabilitiesAndEquity, s.currency)}</td></tr>
        </tbody>
      </table>
    `;
  };

  const incomeStatementTable = (): string => {
    const is = s.incomeStatement;
    // 722 (capitalized own work) and the statutory EBITDA / Net Income views
    // are sourced from the engine's canonical `assembled_pl` block at the top
    // of this function. When the entity has no 722 activity (e.g. Scandia food
    // manufacturer), `has722` is false and the row is suppressed — the table
    // looks identical to the pre-fix output. When 722 is material (EEI CRE),
    // the row appears between Other income and EBITDA, and the EBITDA /
    // EBIT / PBT / Net Income lines use the statutory canonical values
    // (which include 722) so the headline ties to account 121.
    return `
      <table class="fin">
        <thead><tr><th>Profit & Loss</th><th class="num">${escapeHtml(s.periodLabel)}</th></tr></thead>
        <tbody>
          <tr><td>Revenue</td><td class="num">${money(is.revenue, s.currency)}</td></tr>
          <tr class="indent"><td>Cost of goods sold</td><td class="num">(${money(is.costOfGoodsSold, s.currency)})</td></tr>
          <tr class="subtotal"><td>Gross Profit</td><td class="num">${money(t.grossProfit, s.currency)}</td></tr>
          <tr class="indent"><td>Operating expenses</td><td class="num">(${money(is.operatingExpenses, s.currency)})</td></tr>
          <tr class="indent"><td>Other income</td><td class="num">${money(is.otherIncome, s.currency)}</td></tr>
          ${has722 ? `<tr class="indent"><td>Capitalized own work (722, non-cash memo)</td><td class="num">${money(capOwnWork, s.currency)}</td></tr>` : ""}
          <tr class="subtotal"><td>EBITDA${has722 ? " (statutory)" : ""}</td><td class="num">${money(ebitdaStatutory, s.currency)}</td></tr>
          ${has722 ? `<tr class="indent"><td>EBITDA (cash view, excl. 722)</td><td class="num">${money(ebitdaCash, s.currency)}</td></tr>` : ""}
          <tr class="indent"><td>Depreciation & amortization</td><td class="num">(${money(is.depreciationAmortization, s.currency)})</td></tr>
          <tr class="subtotal"><td>EBIT</td><td class="num">${money(ebitStatutory, s.currency)}</td></tr>
          <tr class="indent"><td>Interest expense</td><td class="num">(${money(is.interestExpense, s.currency)})</td></tr>
          <tr class="subtotal"><td>Profit Before Tax</td><td class="num">${money(pretaxStatutory, s.currency)}</td></tr>
          <tr class="indent"><td>Tax expense</td><td class="num">(${money(is.taxExpense, s.currency)})</td></tr>
          <tr class="total"><td>Net Income${has722 ? " (statutory, ties to acct 121)" : ""}</td><td class="num">${money(netIncomeStatutory, s.currency)}</td></tr>
        </tbody>
      </table>
    `;
  };

  const recommendationCard = (rec: Recommendation): string => `
    <div class="rec">
      <h4>
        <span class="priority-pill priority-${rec.priority}">${rec.priority}</span>
        ${escapeHtml(rec.title)}
      </h4>
      <p><strong>Why:</strong> ${escapeHtml(rec.rationale)}</p>
      <p><strong>Action:</strong> ${escapeHtml(rec.action)}</p>
      ${
        rec.estimatedImpact
          ? `<div class="impact">Estimated impact: ${escapeHtml(formatCurrency(rec.estimatedImpact, s.currency))} / year</div>`
          : ""
      }
    </div>
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(s.companyName)} — Financial Analysis ${escapeHtml(s.periodLabel)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+Pro:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>${css}</style>
</head>
<body>
  <div class="running-header">
    <span class="org">${escapeHtml(s.companyName)}</span>
    <span class="meta">Financial Analysis &nbsp;·&nbsp; ${escapeHtml(s.periodLabel)}</span>
  </div>

  <h1>${escapeHtml(s.companyName)}</h1>
  <div class="header-info">
    <p><strong>Comprehensive Financial Analysis</strong></p>
    <p>Period: ${escapeHtml(s.periodLabel)} &nbsp;·&nbsp; Currency: ${escapeHtml(s.currency)}${s.industry ? ` &nbsp;·&nbsp; Industry: ${escapeHtml(s.industry)}` : ""}</p>
    <p>Report generated: ${escapeHtml(today)}</p>
  </div>

  <h2>Executive Summary</h2>
  <div class="insight">
    <strong>Overall verdict:</strong> ${escapeHtml(overallVerdict)}
  </div>
  <div class="grid grid-4">
    <div class="ratio-card">
      <div class="label">Operating revenue</div>
      <div class="value">${money(operatingRevenue, s.currency)}</div>
      ${has722 ? `<div class="meta">incl. 722 ${money(capOwnWork, s.currency)}</div>` : ""}
    </div>
    <div class="ratio-card">
      <div class="label">EBITDA${has722 ? " (statutory)" : ""}</div>
      <div class="value">${money(ebitdaStatutory, s.currency)}</div>
      <div class="meta">${(safeDiv(ebitdaStatutory, operatingRevenue) * 100).toFixed(1)}% margin</div>
    </div>
    <div class="ratio-card">
      <div class="label">Net Income${has722 ? " (statutory)" : ""}</div>
      <div class="value">${money(netIncomeStatutory, s.currency)}</div>
      <div class="meta">${(safeDiv(netIncomeStatutory, operatingRevenue) * 100).toFixed(1)}% margin</div>
    </div>
    <div class="ratio-card">
      <div class="label">Total Debt</div>
      <div class="value">${money(t.totalDebt, s.currency)}</div>
      <div class="meta">${ebitdaStatutory > 0 ? `${safeDiv(t.totalDebt, ebitdaStatutory).toFixed(2)}× EBITDA` : "EBITDA ≤ 0"}</div>
    </div>
  </div>

  <h2>Financial Statements</h2>
  ${balanceSheetTable()}
  ${incomeStatementTable()}

  <h2>Liquidity & Working Capital</h2>
  ${ratioGroup("Liquidity", r.liquidity)}
  ${ratioGroup("Working Capital Cycle", r.efficiency)}

  <h2>Profitability</h2>
  ${ratioGroup("Margin & Returns", r.profitability)}

  <h2>Leverage & Coverage</h2>
  ${ratioGroup("Capital Structure", r.leverage)}
  ${ratioGroup("Debt Coverage", r.coverage)}

  <h2>Bankruptcy Risk</h2>
  ${ratioGroup("Distress Models", r.bankruptcy)}

  <h2>Recommendations</h2>
  ${recs.map(recommendationCard).join("")}

  <aside class="basis-note">
    <strong>Basis of preparation</strong>
    Figures reflect the period&rsquo;s statutory financial statements as ingested by the CFO AI engine. Ratios follow standard lender conventions (Altman Z-Score, DSCR, debt-to-EBITDA, etc.); benchmarks are indicative and industry-dependent. Where the underlying trial-balance reconciliation gap exceeds tolerance, the affected figure is annotated in the relevant statement above. This document is AI-assisted; final analytical judgement and any onward decisions remain with management.
  </aside>

  <footer class="footer">
    <span class="lhs"><strong>CFO AI</strong> &nbsp;·&nbsp; Financial Statement Intelligence</span>
    <span class="rhs">Generated ${escapeHtml(today)} &nbsp;·&nbsp; Confidential &mdash; for internal use only</span>
  </footer>
</body>
</html>`;
}

// ─── Local helpers ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(n: number, currency: string): string {
  // Render full number with thousands separators (e.g. "2,300,000 RON")
  // — board-pack reports show precise figures, not abbreviated.
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${currency} ${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// Browser-side helper: triggers a download of the rendered HTML report.
export function downloadReport(s: Statements): void {
  const html = renderReportHtml(s);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = s.companyName.replace(/[^a-z0-9]+/gi, "_");
  a.href = url;
  a.download = `${safeName}_Financial_Analysis_${s.periodLabel.replace(/\s+/g, "_")}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
