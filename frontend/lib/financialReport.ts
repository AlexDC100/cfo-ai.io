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

// BS totals gateway — every Balance-Sheet TOTAL consumed in this file goes
// through `factsFrom(statements)` (frontend/lib/servedFacts.ts): the served,
// reconciliation-ADJUSTED figures on canonical periods, envelope totals or
// deriveTotals bucket sums on legacy ones. deriveTotals stays exported for
// P&L concepts + debt decomposition (not carried by canonical_bs), but no
// consumer below reads BS grand totals from it directly anymore.
import { factsFrom, presentStatus } from "./servedFacts";
// ABSENCE-AWARE ARITHMETIC — see absentAware.ts for why `safeDiv` had to
// go. Every ratio below is built out of `Fig`s so a missing input or a
// zero denominator produces a stated refusal instead of a confident 0.
import {
  absent,
  add,
  atLeast,
  div,
  known,
  mul,
  num,
  pctOf,
  sub,
  type Fig,
  type FigureAbsence,
} from "./absentAware";

export type { FigureAbsence } from "./absentAware";
// TYPE-ONLY, AND DELIBERATELY SO. `financialValuation.ts` imports values
// from this file; a value import back would be a runtime cycle. The credit
// reader's RESULT is threaded in from the caller instead — which is also
// the point: this module holds no scoring model of its own any more, so it
// cannot answer a credit question without being handed the one answer.
import type { CreditScoreResult } from "./financialValuation";
// VALUE import, and safe: `creditModel.ts` is a leaf that imports nothing,
// which is why the composer was moved there. This document must spell the
// ladder with the SAME function the screens do — it had its own inline
// sort/map/join, which is a second spelling of one table.
import { spellLadder } from "./creditModel";

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

/** A named line on either statement — the vocabulary an absence manifest
 *  and a reported-total override speak. */
export type StatementInput = keyof BalanceSheet | keyof IncomeStatement;

/** Totals a SOURCE reported directly, rather than ones reconstructed from
 *  the line items. */
export type ReportedTotalKey =
  | "totalCurrentAssets"
  | "totalNonCurrentAssets"
  | "totalAssets"
  | "totalCurrentLiabilities"
  | "totalNonCurrentLiabilities"
  | "totalLiabilities"
  | "totalEquity"
  | "grossProfit"
  | "ebitda"
  | "ebit"
  | "pbt"
  | "netIncome"
  | "totalDebt"
  | "workingCapital"
  | "netDebt";

// ─── canonical_bs v2 — the engine-owned Balance Sheet authority ─────────────
// Contract: docs/CANONICAL_BS_V2_CONTRACT.md. Computed ONCE at write time by
// the engine assembler, persisted in the period envelope, and served verbatim
// by /api/period as `statements.canonical_bs`. Consumers (BS tab builder,
// periodFacts, Excel + HTML exports) render rows/sections/totals/status
// DIRECTLY from this object — zero local arithmetic, no residual plugs.
// Absent on legacy periods (pre-bs_v2), where every consumer keeps its
// existing fallback path unchanged.

export type CanonicalBsStatus =
  | "BALANCED"
  | "MINOR_DRIFT"
  | "MATERIAL_IMBALANCE"
  // RECONCILIATION FLOW (contract §"RECONCILIATION FLOW") — a fourth,
  // explicitly-entered state. Never produced by the build itself; only by
  // the validator-gated POST /api/period/{id}/reconcile. RECONCILED is
  // never BALANCED — altered numbers can't claim the pristine verdict.
  | "RECONCILED";

/** Receipt stored alongside an accepted reconciliation (contract §4).
 *  Keyed by provenance content_hash server-side; the FE renders it as the
 *  one-line receipt under the green chip and as the synthetic row's
 *  tooltip (rationale + origin + timestamp). Source cents are NEVER
 *  overwritten — this object describes the reversible synthetic entry. */
export interface CanonicalBsReconciliation {
  content_hash?: string;
  original_difference: number;
  applied_delta: number;
  target_row_id?: string;
  origin: "deterministic" | "llm_proposed";
  diagnosis_code?: string | null;
  /** Human-readable reason for the adjusting entry (proposal rationale). */
  rationale?: string | null;
  model?: string | null;
  prompt_version?: string | null;
  applied_at?: string | null;
  applied_by?: string | null;
  reversible?: boolean;
}

export interface CanonicalBsExtraction {
  /** "mechanical_mapped" = the dual-path consensus lane: structure was
   *  AI-interpreted, every NUMBER was read mechanically from the grid and
   *  cross-verified by two independent readings. Distinct from "llm"
   *  (numbers read by AI) — it must NOT render the "AI-read" badge. */
  method: "deterministic" | "llm" | "mechanical_mapped";
  parser_version: string;
  source_format: string;
  number_locale: "ro" | "anglo";
  sheet?: string;
  header_row_index?: number;
  /** AI lane only — the model that read the document. The engine persists
   *  model id + prompt versions from its single config module on every
   *  run; the FE surfaces them in the AI-read badge tooltip. */
  model?: string | null;
  prompt_version?: string | null;
}

/** AI lane — how the extracted rows were CLASSIFIED into the canonical
 *  sections. On the AI lane this is permanently `method: "llm"` (and the
 *  status can never be BALANCED); deterministic periods either omit the
 *  object or carry `method: "deterministic"`. Additive + optional so
 *  pre-AI-lane envelopes stay valid. */
export interface CanonicalBsClassification {
  method?: "deterministic" | "llm";
  model?: string | null;
  prompt_version?: string | null;
  /** AI lane parks a survives-serving copy of the low-confidence list
   *  here, because the auto-reconcile serve stage owns the top-level
   *  `needs_review` key (boolean semantics). Read as fallback. */
  needs_review?: CanonicalBsNeedsReviewEntry[] | null;
}

/** AI lane — one low-confidence classified line awaiting human mapping.
 *  These values sit in the Unclassified rows (they ARE included in the
 *  totals per the closing-identity convention) until a human confirms the
 *  mapping. Field aliases (`code`/`name`) tolerated because the engine
 *  side ships in parallel. */
export interface CanonicalBsNeedsReviewEntry {
  account_code?: string | null;
  /** Alias of account_code. */
  code?: string | null;
  label?: string | null;
  /** Alias of label. */
  name?: string | null;
  amount?: number | null;
  /** Classifier confidence — either 0..1 or 0..100; the FE normalizes. */
  confidence?: number | null;
  /** One-line model rationale for the proposed classification. */
  rationale?: string | null;
  section?: string | null;
}

/** Resolved accounting jurisdiction (country pack) for the period. The
 *  engine may serve a bare code string or the structured object; the FE
 *  normalizes (see buildBsStatement.canonicalMetaFromBs). */
export interface CanonicalBsJurisdiction {
  /** Country-pack code — "RO" | "HU" | "INTL" (open set). */
  resolved?: string | null;
  /** How it was decided: "auto" (detection) | "hint" (upload dropdown) |
   *  "override" (post-scan re-extraction). */
  source?: string | null;
  pack_version?: string | null;
}

/** DUAL-PATH CONSENSUS (additive) — comparison metadata for two
 *  independent readings of the same document. Served values are NEVER
 *  taken from the second reading (E4); any value disagreement surfaces
 *  in `disagreements` / `needs_review` (E3). `eligible_balanced` is the
 *  engine's three-leg E9 verdict — the FE renders it, never re-derives. */
export interface CanonicalBsConsensusDisagreement {
  code?: string | null;
  name?: string | null;
  field?: string | null;
  /** The SERVED reading (classic / framing A), integer cents. */
  classic_cents?: number;
  /** The second reading (mapped / framing B), integer cents. */
  mapped_cents?: number;
  source_ref?: { sheet?: string | null; row?: number | null; col?: number | null } | null;
}

export interface CanonicalBsConsensusLeg {
  leg: string;
  /** null = the leg could not be run — it FAILS the verdict (fail closed). */
  pass: boolean | null;
}

export interface CanonicalBsConsensus {
  schema: "consensus_v1";
  mode?: "dual_map" | "classic_vs_mapped";
  consensus_pct: number;
  atoms_compared: number;
  disagreements: CanonicalBsConsensusDisagreement[];
  structural: { row_count_a?: number; row_count_b?: number; aligned?: boolean };
  totals_match: "MATCHED" | "DIVERGED" | "NO_ANCHOR";
  legs: CanonicalBsConsensusLeg[];
  eligible_balanced: boolean;
  /** Disagreement atoms in the needs-review entry shape (kept INSIDE the
   *  consensus block — the top-level needs_review key keeps its two
   *  existing meanings untouched). */
  needs_review?: CanonicalBsNeedsReviewEntry[] | null;
  framings?: Record<string, unknown> | null;
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
  /** RECONCILIATION FLOW — true only on the "Diferențe de reconciliere"
   *  adjusting row injected by an accepted reconciliation (leaf_ids []).
   *  Renders with a visible marker + tooltip; never a source figure. */
  synthetic?: boolean;
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
  /** RECONCILIATION FLOW trigger — computed deterministically on every
   *  build: true iff 0 < |difference| / max(assets, e+l) ≤ 0.1% AND no
   *  accepted reconciliation is stored. Drives the amber "Off by …"
   *  chip + Reconcile button; the FE never derives this itself. */
  reconcile_offer?: boolean;
  /** Present iff status is RECONCILED — the stored, reversible receipt. */
  reconciliation?: CanonicalBsReconciliation | null;
  /** AI lane (additive) — classification provenance; permanently
   *  `method: "llm"` on AI-lane periods. */
  classification?: CanonicalBsClassification | null;
  /** Two engine meanings, one field (both additive):
   *  · boolean `true` — the AUTO-RECONCILE stage ran and was rejected
   *    (drives the "Needs manual mapping" strip state);
   *  · an ARRAY — AI-lane low-confidence lines pending human mapping
   *    (drives the collapsible needs-review panel). */
  needs_review?: boolean | CanonicalBsNeedsReviewEntry[] | null;
  /** Resolved jurisdiction — structured object or a bare pack code. */
  jurisdiction?: CanonicalBsJurisdiction | string | null;
  /** DUAL-PATH CONSENSUS (additive) — absent on periods no consensus
   *  lane probed; render-only, never re-derived. */
  consensus?: CanonicalBsConsensus | null;
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
  /** Fiscal code. OPTIONAL and, as of today, NEVER EMITTED: the engine
   *  builds this blob in `pipeline.py` from companyName / industry /
   *  currency / periodLabel / balanceSheet / incomeStatement /
   *  supplementary, and no path adds `cui`. Declared (rather than
   *  asserted at the read site with a cast, which is what
   *  `periodDetect.ts` used to do) so the always-null result is a stated
   *  gap instead of a lookup that merely looks live.
   *
   *  Consequence while it stays absent — worth an engine-side fix:
   *  `entitiesConflict()` says "a fiscal code is the identity; a renamed
   *  company keeps its CUI", but with one side's CUI always null that
   *  branch never fires and the guard falls through to fuzzy name
   *  matching, which treats one name containing the other as the same
   *  company. */
  cui?: string | null;
  industry?: string;
  currency: string;
  periodLabel: string; // e.g. "FY 2025"
  balanceSheet: BalanceSheet;
  incomeStatement: IncomeStatement;
  supplementary: SupplementaryData;

  // ── WHAT THE SOURCE DID NOT CARRY ───────────────────────────────────
  //
  // `BalanceSheet` and `IncomeStatement` are all-number types, so a field
  // the source never reported has to be written as SOMETHING — and every
  // adapter wrote `0`. On a trial balance that is honest: a bucket with
  // no accounts in it really is zero. On a vendor feed that bundles line
  // items it is not: `interest_expense_bank` absent from a Sharadar SF1
  // envelope means Apple's interest expense was not in the feed, not that
  // Apple paid none — and `computeRatios` then divided by it and reported
  // `interest_coverage 0.00x critical`, with a provenance card on it.
  //
  // These two fields let a source say what it actually knows without
  // widening the numeric types (and so without changing the statement
  // renderers, which already paint the gap glyph below 0.005).

  /**
   * Line items the SOURCE did not report. A name listed here is ABSENT —
   * whatever number the field holds is a placeholder, and every ratio
   * that needs it refuses instead of computing.
   *
   * Absent or empty on the private path: a trial balance is complete by
   * construction, so a zero bucket is a measured zero.
   */
  absentInputs?: readonly StatementInput[];
  /**
   * Totals the SOURCE reported directly. Preferred over reconstructing
   * them from the line items — which is what makes a feed that reports
   * EBITDA but no cost breakdown usable at all: `deriveTotals` would
   * rebuild EBITDA as `revenue − 0 − 0`, i.e. revenue, and every margin
   * and coverage ratio downstream would be computed against it.
   *
   * Never set on the private path, where the line items ARE the source.
   */
  reportedTotals?: Partial<Record<ReportedTotalKey, number>>;

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

/** "unknown" is a REFUSAL, not a fifth band: the ratio has no value, so
 *  it has no verdict either. It exists so nothing downstream can grade a
 *  figure that was never computed — the pre-2026-09-04 code returned 0
 *  from a division it could not perform and `verdictFromBands` graded
 *  that 0 as "critical", which is how the AAPL page came to show
 *  `interest_coverage 0.00x CRITICAL` for a company whose EBIT in the
 *  same fixture is 123,216,000,000. */
export type RatioVerdict = "strong" | "healthy" | "watch" | "critical" | "unknown";

export interface Ratio {
  key: string;
  label: string;
  /** NULL when the ratio could not be computed. `unavailable` then says
   *  why, and every renderer must state that rather than print a figure. */
  value: number | null;
  unit: "x" | "%" | "days" | "ratio";
  verdict: RatioVerdict;
  benchmark: string;
  /** Present iff `value` is null. Carries the reason in a form the UI can
   *  turn into the product's own words — which inputs the filing did not
   *  carry, or which denominator is zero. */
  unavailable?: FigureAbsence;
  commentary: string;
}

// ── `bankruptcy` IS NOT A FIELD OF THIS BUNDLE, AND THAT IS THE FIX ────
//
// It used to be — one row, `altman_z`, built by a Z″ formula written
// inline in `computeRatios`. That made THREE arithmetics in this codebase
// claiming the name "Altman Z″ (1995 EM)": the engine's, the credit
// reader's FE fallback (`altmanZScore`) and this one. Measured on the real
// Scandia period, engine envelope intact:
//
//     credit reader (Risks tab · hero · /report · workbook)   0.22
//     computeRatios().bankruptcy, no engine metric map        0.18590918
//
// and the second one is what `renderReportHtml` rendered, because it
// called `computeRatios(s)` with no map. The printed board pack said
// Z″ 0.19, badge "Critical", "Bankruptcy risk: distress zone. Action
// required." while every screen said 0.22.
//
// ⚠ THREADING THE ENGINE MAP IS NOT THE FIX. It makes them agree only
// while `calculated_metrics.altman_z_score` happens to arrive: delete
// that ONE row and the reader still answers 0.22 (it falls back to the
// credit envelope's own `altman_z_score`) while this group falls back to
// its inline formula and answers 0.18590918 again. Measured. The
// workbook learned this first (financialExports.ts:303) and stopped
// exporting the group; the group is now gone from the type, so tsc
// enumerates every surface that used to render it instead of a human
// remembering to.
//
// THE ONE Altman row every surface renders is `altmanRatio(credit)`
// below — the credit reader's `AltmanResult`, wearing the `Ratio` shape.
export interface RatioBundle {
  liquidity: Ratio[];
  profitability: Ratio[];
  leverage: Ratio[];
  coverage: Ratio[];
  efficiency: Ratio[];
}

const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b);
const pct = (a: number, b: number): number => safeDiv(a, b) * 100;

/** The word a sentence uses where a figure would have gone. Not "—": a
 *  dash inside prose reads as a typesetting accident, and a reader who
 *  has to guess what it means guesses "zero". */
export const UNREPORTED_WORD = "not reported";

/** Reader-facing words for a statement line. A refusal names the CONCEPT
 *  the filing is missing, not the camelCase field the code happens to
 *  call it — a reader checking their own statements is looking for
 *  "interest expense", not `interestExpense`. */
const INPUT_WORDS: Partial<Record<StatementInput, string>> = {
  cash: "cash",
  accountsReceivable: "trade receivables",
  inventory: "inventory",
  otherCurrentAssets: "other current assets",
  propertyPlantEquipment: "property, plant & equipment",
  intangibles: "intangible assets",
  otherNonCurrentAssets: "other non-current assets",
  accountsPayable: "trade payables",
  shortTermDebt: "short-term debt",
  otherCurrentLiabilities: "other current liabilities",
  longTermDebt: "long-term debt",
  otherNonCurrentLiabilities: "other non-current liabilities",
  shareCapital: "share capital",
  retainedEarnings: "retained earnings",
  otherEquity: "other equity",
  revenue: "revenue",
  costOfGoodsSold: "cost of sales",
  operatingExpenses: "operating expenses",
  depreciationAmortization: "depreciation & amortization",
  interestExpense: "interest expense",
  otherIncome: "other operating income",
  taxExpense: "income tax",
  financialIncome: "financial income",
  financialExpense: "financial expense",
};

function inputWord(name: string): string {
  return INPUT_WORDS[name as StatementInput] ?? name;
}

/** The i18n coordinates of a refusal: which of the three sentences, and
 *  the interpolation values it needs.
 *
 *  ── WHY THIS EXISTS ────────────────────────────────────────────────
 *  `describeAbsence` returns hard-coded English. On the ratio card and in
 *  the ratio drawer, the verdict chip beside it renders
 *  `t("dashV2.ratioVerdictUnknown")` — "Neraportat" in Romanian — so a
 *  Romanian reader saw a translated chip sitting directly on top of an
 *  English sentence. A half-translated refusal is a half-built refusal:
 *  the reader can see the product knows the figure is missing and cannot
 *  read WHY, which is the only part that tells them what to do next.
 *
 *  The structured form is what the UI renders; `describeAbsence` stays as
 *  the ENGLISH surface for the English-by-design outputs (the generated
 *  HTML board pack, the Excel workbook, `Ratio.commentary` as a
 *  non-React fallback). Both are built from this one function, so the two
 *  spellings can never diverge in substance. */
export function absenceI18n(a: FigureAbsence): {
  /** Key under the `ratioAbsence` bundle (components/cfo/ratioAbsenceI18n). */
  key: "undefinedRatio" | "missingNamed" | "missingUnnamed";
  /** Interpolation values, already reader-worded (never camelCase). */
  vars: { denominator?: string; inputs?: string };
  /** Canonical input words, in order — for a caller that lays them out
   *  itself rather than using the joined string. */
  inputWords: readonly string[];
} {
  if (a.kind === "undefined_ratio") {
    return { key: "undefinedRatio", vars: { denominator: a.denominator }, inputWords: [] };
  }
  const words = a.inputs.map(inputWord);
  if (words.length === 0) return { key: "missingUnnamed", vars: {}, inputWords: [] };
  const list =
    words.length === 1
      ? words[0]
      : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return { key: "missingNamed", vars: { inputs: list }, inputWords: words };
}

/** Turn an absence into the ENGLISH sentence a reader sees.
 *
 *  The two kinds are genuinely different situations and the reader's next
 *  move differs, so they get different sentences: one says their filing
 *  is missing something, the other says this quantity has no value for
 *  this company. Neither is ever a blank.
 *
 *  ⚠ ENGLISH ONLY. Every localized surface renders `absenceI18n()` through
 *  `components/cfo/ratioAbsenceI18n`; this stays for the outputs that are
 *  English by contract (generated HTML report, Excel workbook). */
export function describeAbsence(a: FigureAbsence): string {
  const d = absenceI18n(a);
  switch (d.key) {
    case "undefinedRatio":
      return `Undefined — ${d.vars.denominator} is zero, so this ratio has no value for this period.`;
    case "missingUnnamed":
      return "Not reported — an input this ratio needs is missing from the filing.";
    case "missingNamed":
      return `Not reported — this filing does not carry ${d.vars.inputs}.`;
  }
}

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
  // servedFacts gateway — BS totals (assets / equity / liabilities /
  // current splits / working capital) come from the served envelope, so
  // every ratio's denominator agrees to the cent with the BS tab, both
  // exports and periodFacts. P&L concepts + the debt decomposition keep
  // reading `t` (deriveTotals) — canonical_bs carries no debt split.
  const sf = factsFrom(s);
  const bs = s.balanceSheet;
  const is = s.incomeStatement;
  const sup = s.supplementary;
  const days = sup.periodDays ?? 365;

  // ── WHAT THIS SOURCE ACTUALLY REPORTED ──────────────────────────────
  //
  // Everything below is built out of `Fig`s (lib/absentAware). A `Fig` is
  // a number that may be ABSENT and, when it is, carries the reason. The
  // whole file used to run on
  //
  //     const safeDiv = (a, b) => (b === 0 ? 0 : a / b);
  //
  // which told two lies: a division by zero is undefined rather than
  // zero, and by the time a value arrived here an unreported input had
  // already been written as `0` by its adapter, so the "denominator" was
  // a figure the filing never carried. On the repo's own AAPL fixture
  // that produced `interest_coverage 0.00x critical` next to an EBIT of
  // 123,216,000,000, `dpo 0 d`, `dio 232 d` and `current_ratio 0.23x` —
  // fifteen ratios wearing provenance cards over inputs that read
  // `cogs: 0, opex: 0, interestExpense: 0, accountsPayable: 0,
  // longTermDebt: 0`, every one of them an ABSENT leaf.
  const declaredAbsent = new Set<string>(s.absentInputs ?? []);
  /** A balance-sheet line as a figure. */
  const B = (k: keyof BalanceSheet): Fig =>
    declaredAbsent.has(k) ? absent(k) : num(k, bs[k]);
  /** A P&L line as a figure. */
  const I = (k: keyof IncomeStatement): Fig =>
    declaredAbsent.has(k) ? absent(k) : num(k, is[k] as number | undefined);
  /** A total the SOURCE reported, when it did. */
  const R = (k: ReportedTotalKey): number | undefined => {
    const v = s.reportedTotals?.[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  /** Reported total, else the reconstruction from line items. */
  const total = (k: ReportedTotalKey, reconstructed: Fig): Fig => {
    const r = R(k);
    return r === undefined ? reconstructed : known(r);
  };
  // A source that declares absences has no served envelope behind it (the
  // public-company adapter builds neither `canonical_bs` nor
  // `assembled_bs`), so the gateway's totals are bucket sums over exactly
  // the fields the manifest describes and inherit their absences. With no
  // manifest the gateway's own figure is authoritative and this reads it
  // verbatim — the private path's numbers are unchanged.
  const declaresAbsence = declaredAbsent.size > 0 || s.reportedTotals !== undefined;
  // `read` is ABSENT-CAPABLE: the servedFacts accessors return
  // `number | null`, and `num()` turns a null into a Fig that names the
  // missing total. Typing it `() => number` here would have let a null
  // through into the algebra, where it reads as 0.
  const gate = (name: string, read: () => number | null, reconstructed: Fig): Fig =>
    declaresAbsence ? reconstructed : num(name, read());

  const currentAssets = total(
    "totalCurrentAssets",
    gate(
      "current assets",
      () => sf.currentAssets(),
      add(B("cash"), B("accountsReceivable"), B("inventory"), B("otherCurrentAssets")),
    ),
  );
  const currentLiabilities = total(
    "totalCurrentLiabilities",
    gate(
      "current liabilities",
      () => sf.currentLiabilities(),
      add(B("accountsPayable"), B("shortTermDebt"), B("otherCurrentLiabilities")),
    ),
  );
  const totalAssets = total(
    "totalAssets",
    gate(
      "total assets",
      () => sf.totalAssets(),
      add(
        B("cash"), B("accountsReceivable"), B("inventory"), B("otherCurrentAssets"),
        B("propertyPlantEquipment"), B("intangibles"), B("otherNonCurrentAssets"),
      ),
    ),
  );
  const totalEquity = total(
    "totalEquity",
    gate(
      "total equity",
      () => sf.totalEquity(),
      add(B("shareCapital"), B("retainedEarnings"), B("otherEquity")),
    ),
  );
  const totalLiabilities = total(
    "totalLiabilities",
    gate(
      "total liabilities",
      () => sf.totalLiabilities(),
      add(currentLiabilities, B("longTermDebt"), B("otherNonCurrentLiabilities")),
    ),
  );
  const workingCapital = total(
    "workingCapital",
    gate(
      "working capital",
      () => sf.workingCapital(),
      sub(currentAssets, currentLiabilities),
    ),
  );
  const totalDebt = total("totalDebt", add(B("shortTermDebt"), B("longTermDebt")));

  // P&L levels. `reportedTotals` first: a feed that reports EBITDA but no
  // cost breakdown would otherwise have EBITDA rebuilt as
  // `revenue − 0 − 0` — on AAPL that is 391.0 B standing in for the 134.7 B
  // the same envelope reports, and every margin and coverage ratio
  // downstream is then computed against revenue.
  const revenue = I("revenue");
  const grossProfit = total("grossProfit", sub(revenue, I("costOfGoodsSold")));
  const ebitda = total(
    "ebitda",
    add(grossProfit, mul(I("operatingExpenses"), known(-1)), I("otherIncome")),
  );
  const ebit = total("ebit", sub(ebitda, I("depreciationAmortization")));
  // `financialIncome` / `financialExpense` are OPTIONAL by declaration —
  // "not applicable" for a simple sample rather than "not reported" — so
  // an omitted one keeps its documented zero unless the manifest names it.
  const finIn = declaredAbsent.has("financialIncome")
    ? absent("financialIncome")
    : known(is.financialIncome ?? 0);
  const finEx = declaredAbsent.has("financialExpense")
    ? absent("financialExpense")
    : known(is.financialExpense ?? 0);
  const interestExpense = I("interestExpense");
  const pbt = total("pbt", sub(add(ebit, finIn), add(interestExpense, finEx)));
  const netIncome = total("netIncome", sub(pbt, I("taxExpense")));

  // F2.2 — Canonical-or-fallback helper. Reads `m` from metricsByName if
  // present and non-null; else returns the FE-arithmetic fallback. Engine
  // emits ratios as decimals (0.132 = 13.2%); pct() in this file returns
  // 0-100 percentages. Where the consuming UI shows a percentage, multiply
  // by 100. Where it shows a multiplier (1.5×), no transformation.
  const m = (name: string): number | null => {
    if (!metricsByName) return null;
    const v = metricsByName[name];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  /** An engine-served metric outranks any FE reconstruction — it is the
   *  number the rest of the product already agrees on. */
  const mOr = (name: string, fallback: Fig): Fig => {
    const v = m(name);
    return v === null ? fallback : known(v);
  };
  const mPctOr = (name: string, fallback: Fig): Fig => {
    const v = m(name);
    return v === null ? fallback : known(v * 100);
  };

  // Liquidity ────────────────────────────────────────────────────────────────
  const currentRatio = mOr("current_ratio", div(currentAssets, currentLiabilities, "current liabilities"));
  const quickRatio = mOr(
    "quick_ratio",
    div(add(B("cash"), B("accountsReceivable")), currentLiabilities, "current liabilities"),
  );
  const cashRatio = mOr("cash_ratio", div(B("cash"), currentLiabilities, "current liabilities"));

  // Profitability ────────────────────────────────────────────────────────────
  // F1.e + F2.2: prefer engine canonical when supplied (via either the
  // legacy `canonicalMargins` pair or the new `metricsByName` map). Engine
  // emits margins as ratios (0–1); pct() emits 0–100; multiply canonical
  // value by 100 to align units.
  const grossMargin = mPctOr("gross_margin", pctOf(grossProfit, revenue, "revenue"));
  const ebitdaMargin = m("ebitda_margin") !== null
    ? known((m("ebitda_margin") as number) * 100)
    : (canonicalMargins?.ebitdaMargin != null
        ? known(canonicalMargins.ebitdaMargin * 100)
        : pctOf(ebitda, revenue, "revenue"));
  const netMargin = m("net_margin") !== null
    ? known((m("net_margin") as number) * 100)
    : (canonicalMargins?.netMargin != null
        ? known(canonicalMargins.netMargin * 100)
        : pctOf(netIncome, revenue, "revenue"));
  const roa = mPctOr("roa", pctOf(netIncome, totalAssets, "total assets"));
  const roe = mPctOr("roe", pctOf(netIncome, totalEquity, "total equity"));
  // F2.2 — ROIC added as a new Profitability row (engine emits; FE didn't
  // surface previously). Engine formula: operating_profit × (1 − 0.16) /
  // max(total_debt + total_equity, 1) — NOPAT over invested capital.
  const roic = mPctOr(
    "roic",
    pctOf(mul(ebit, known(1 - 0.16)), atLeast(add(totalDebt, totalEquity), 1), "invested capital"),
  );

  // Leverage ─────────────────────────────────────────────────────────────────
  const debtToEbitda = mOr("debt_to_ebitda", div(totalDebt, ebitda, "EBITDA"));
  const debtToEquity = mOr("debt_to_equity", div(totalDebt, totalEquity, "total equity"));
  const equityRatio = mPctOr("equity_ratio", pctOf(totalEquity, totalAssets, "total assets"));
  // F2.2 — LTV stays FE-arithmetic when propertyMarketValue is supplied
  // (user input, not engine-derived). When no override, read engine's
  // `debt_to_assets` canonical. This is one of the few FE-arithmetic sites
  // that survives F2's canonical-conformance rule because the input is
  // genuinely user-side (the property valuation isn't in the trial balance).
  // DO NOT "fix" this into a pure engine read — that would silently drop the
  // user's market-value input from the LTV displayed value.
  const ltv = sup.propertyMarketValue
    ? pctOf(totalDebt, known(sup.propertyMarketValue), "property market value")
    : mPctOr("debt_to_assets", pctOf(totalDebt, totalAssets, "total assets"));

  // Coverage ─────────────────────────────────────────────────────────────────
  // F2.2 — interest_coverage switches from FE EBIT-basis to engine
  // EBITDA-basis canonical. Engine emits the same value as
  // `ebitda_to_interest`. Visible value shift expected (small — depreciation
  // delta between EBIT and EBITDA on both fixtures is modest).
  const interestCoverage = mOr("interest_coverage", div(ebit, interestExpense, "interest expense"));
  // F2.2 — DSCR switches from FE cash-EBITDA basis to engine statutory-
  // EBITDA basis (aligns with F1.e canonical decision). EEI shift is
  // material (statutory adds 722 = 2.16M to numerator). Scandia unchanged
  // because 722 = 0.
  const debtService = add(interestExpense, B("shortTermDebt"));
  const dscr = mOr("dscr", div(ebitda, debtService, "interest + short-term debt"));
  // F2.2 — adjusted_dscr stays FE-arithmetic when annualLeaseExpense is
  // supplied (user input, not engine-derived). Same reasoning as LTV —
  // legitimate FE arithmetic on user input. When no lease supplied,
  // fall back to plain `dscr` (now engine canonical).
  const adjustedDscr = sup.annualLeaseExpense
    ? div(
        add(ebitda, known(sup.annualLeaseExpense)),
        add(debtService, known(sup.annualLeaseExpense)),
        "interest + short-term debt + lease",
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
    div(
      ebitda,
      add(interestExpense, div(B("longTermDebt"), known(8), "8")),
      "interest + LT principal proxy",
    ),
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
  const totalOperatingExpense = add(
    I("costOfGoodsSold"),
    I("operatingExpenses"),
    I("depreciationAmortization"),
  );
  const dayCount = known(days);
  const dso = mOr("dso", mul(div(B("accountsReceivable"), revenue, "revenue"), dayCount));
  const dio = mOr(
    "dio",
    mul(div(B("inventory"), totalOperatingExpense, "total operating expense"), dayCount),
  );
  const dpo = mOr(
    "dpo",
    mul(div(B("accountsPayable"), totalOperatingExpense, "total operating expense"), dayCount),
  );
  const ccc = mOr("ccc", sub(add(dso, dio), dpo));
  const assetTurnover = mOr("asset_turnover", div(revenue, totalAssets, "total assets"));

  // ── THE THIRD ALTMAN LIVED HERE AND IS DELETED ──────────────────────
  //
  // `const z = mOr("altman_z_score", <inline Z″ formula>)` produced the
  // `bankruptcy` group. It was the third arithmetic in this codebase
  // wearing the name "Altman Z″ (1995 EM)", and — because the standalone
  // HTML report calls `computeRatios(s)` with no engine map — it was the
  // one a printed board pack carried. Its verdict sentence banded with
  // `>=` where the methodology (and `zoneFor`, and therefore every other
  // surface) bands with `>`, so it also disagreed at the two boundary
  // values where the word matters most. Measured:
  //
  //     Z″ = 2.60 exactly   this row "Healthy · Bankruptcy risk: low.
  //                          Balance sheet structurally sound."
  //                          every other surface  Grey
  //     Z″ = 1.10 exactly   this row "Watch · grey zone. Monitor…"
  //                          every other surface  Distress
  //
  // Nothing replaces it here. `altmanRatio(credit)` below wears the same
  // `Ratio` shape and is built from the ONE reader, so the Ratios tab,
  // its drawer, the workbook and the printed document render one figure
  // with one ladder and one sentence.

  // ── ONE BUILDER FOR EVERY ROW ───────────────────────────────────────
  //
  // A refused ratio must not be graded, must not be formatted and must
  // not carry commentary about a number nobody has. Routing every row
  // through here is what makes that structural: there is no branch a new
  // ratio can be added on the wrong side of.
  const row = (
    key: string,
    label: string,
    unit: Ratio["unit"],
    f: Fig,
    bands: { critical?: number; watch?: number; healthy?: number; strong?: number },
    higherIsBetter: boolean,
    benchmark: string,
    commentary: (v: number) => string,
  ): Ratio => {
    if (f.value === null) {
      const absence = f.absence ?? { kind: "missing", inputs: [] };
      return {
        key,
        label,
        value: null,
        unit,
        verdict: "unknown",
        benchmark,
        unavailable: absence,
        commentary: describeAbsence(absence),
      };
    }
    return {
      key,
      label,
      value: f.value,
      unit,
      verdict: verdictFromBands(f.value, bands, higherIsBetter),
      benchmark,
      commentary: commentary(f.value),
    };
  };
  /** A money figure for commentary — the gap word when it is absent, so a
   *  sentence never quotes a number the ratios refused. */
  const money = (f: Fig): string =>
    f.value === null ? UNREPORTED_WORD : formatCurrency(f.value, s.currency);

  return {
    liquidity: [
      row("current_ratio", "Current Ratio", "x", currentRatio,
        { strong: 2, healthy: 1.5, watch: 1 }, true,
        "≥ 1.5× healthy · ≥ 2.0× strong",
        (v) =>
          v >= 1.5
            ? "Comfortable short-term cushion against current obligations."
            : v >= 1
              ? "Tight but covered — monitor working capital weekly."
              : "Current liabilities exceed current assets — liquidity stress."),
      row("quick_ratio", "Quick Ratio", "x", quickRatio,
        { strong: 1.5, healthy: 1, watch: 0.7 }, true,
        "≥ 1.0× healthy",
        (v) =>
          v >= 1
            ? "Cash + receivables alone cover current liabilities."
            : "Reliance on inventory liquidation to meet short-term obligations."),
      row("cash_ratio", "Cash Ratio", "x", cashRatio,
        { strong: 0.5, healthy: 0.2, watch: 0.1 }, true,
        "≥ 0.2× healthy",
        (v) =>
          v >= 0.2
            ? "Adequate cash buffer for operating shocks."
            : "Limited dry cash — exposed to revenue interruption."),
    ],
    profitability: [
      row("gross_margin", "Gross Margin", "%", grossMargin,
        { strong: 40, healthy: 25, watch: 15 }, true,
        "Industry-dependent · ≥ 25% healthy",
        (v) => `${v.toFixed(1)}% gross margin on ${money(revenue)} revenue.`),
      row("ebitda_margin", "EBITDA Margin", "%", ebitdaMargin,
        { strong: 25, healthy: 15, watch: 8 }, true,
        "≥ 15% healthy · ≥ 25% strong",
        () => `${money(ebitda)} EBITDA — operating cash generation.`),
      row("net_margin", "Net Margin", "%", netMargin,
        { strong: 15, healthy: 8, watch: 3 }, true,
        "≥ 8% healthy",
        () => `${money(netIncome)} bottom-line profit after all costs.`),
      row("roa", "Return on Assets", "%", roa,
        { strong: 10, healthy: 5, watch: 2 }, true,
        "≥ 5% healthy",
        (v) =>
          v >= 5
            ? "Assets generating solid returns."
            : "Asset base under-earning — review utilization."),
      row("roe", "Return on Equity", "%", roe,
        { strong: 20, healthy: 12, watch: 6 }, true,
        "≥ 12% healthy",
        (v) =>
          v >= 12
            ? "Capital deployed efficiently for shareholders."
            : "Equity returns below cost-of-capital benchmark."),
      // F2.2 — NEW row: ROIC (engine canonical). Surfaced explicitly so the
      // dashboard's Ratios tab shows the return-on-invested-capital row that
      // was previously emitted by the engine but not displayed FE-side.
      row("roic", "Return on Invested Capital", "%", roic,
        { strong: 15, healthy: 10, watch: 5 }, true,
        "≥ 10% healthy",
        (v) =>
          v >= 10
            ? "Invested capital earning above typical WACC."
            : "Returns below cost of capital — value-destroying configuration."),
    ],
    leverage: [
      row("debt_to_ebitda", "Debt / EBITDA", "x", debtToEbitda,
        { strong: 2, healthy: 3, watch: 4.5 }, false,
        "≤ 3× healthy · ≤ 2× strong",
        (v) =>
          v <= 3
            ? "Debt service comfortably aligned with cash generation."
            : v <= 4.5
              ? "Elevated leverage — refinancing risk if EBITDA contracts."
              : "Stretched balance sheet — covenant risk likely."),
      row("debt_to_equity", "Debt / Equity", "x", debtToEquity,
        { strong: 0.5, healthy: 1, watch: 2 }, false,
        "≤ 1.0× healthy",
        (v) => (v <= 1 ? "Conservatively capitalized." : "Leverage exceeds equity cushion.")),
      row("equity_ratio", "Equity Ratio", "%", equityRatio,
        { strong: 50, healthy: 30, watch: 15 }, true,
        "≥ 30% healthy",
        (v) => `${v.toFixed(1)}% of assets funded by equity.`),
      row("ltv", sup.propertyMarketValue ? "Loan-to-Value" : "Debt-to-Assets", "%", ltv,
        { strong: 50, healthy: 65, watch: 80 }, false,
        "≤ 65% healthy",
        (v) =>
          v <= 65
            ? "Asset coverage of debt is comfortable."
            : "Limited equity headroom against pledged assets."),
    ],
    coverage: [
      row("interest_coverage", "Interest Coverage", "x", interestCoverage,
        { strong: 6, healthy: 3, watch: 1.5 }, true,
        "≥ 3× healthy",
        (v) =>
          v >= 3
            ? "Earnings comfortably absorb interest load."
            : "Interest taking a meaningful bite of operating profit."),
      row("dscr", "DSCR (interest + ST debt)", "x", dscr,
        { strong: 1.5, healthy: 1.25, watch: 1 }, true,
        "≥ 1.25× covenant-typical",
        (v) =>
          v >= 1.25
            ? "Annual cash service comfortably covered."
            : "Debt service consumes most operating cash."),
      row("adjusted_dscr", "Adjusted DSCR (incl. lease)", "x", adjustedDscr,
        { strong: 1.5, healthy: 1.25, watch: 1 }, true,
        "≥ 1.25× including lease commitments",
        () =>
          sup.annualLeaseExpense
            ? "Adds lease obligation to fixed charges — lender-style view."
            : "No lease component — same as DSCR."),
      // F2.2 — NEW row: DSCR including LT principal amortization proxy
      // (engine canonical). Different from adjusted_dscr above:
      // numerator is statutory EBITDA, denominator adds LT debt / 8
      // (~10-year amortization proxy) instead of lease expense. Lender-
      // style view of covenant coverage when LT debt is the dominant
      // service component.
      row("dscr_with_lt_principal", "DSCR (incl. LT principal proxy)", "x", dscrWithLtPrincipal,
        { strong: 1.5, healthy: 1.25, watch: 1 }, true,
        "≥ 1.25× with 10-year amortization proxy",
        (v) =>
          v >= 1.25
            ? "Comfortable coverage of interest + LT principal amortization."
            : "Including LT principal amortization, coverage is tight — refinancing risk."),
    ],
    efficiency: [
      row("dso", "Days Sales Outstanding", "days", dso,
        { strong: 30, healthy: 45, watch: 75 }, false,
        "≤ 45 days healthy",
        (v) => `Average ${v.toFixed(0)}-day collection cycle on receivables.`),
      row("dio", "Days Inventory Outstanding", "days", dio,
        { strong: 30, healthy: 60, watch: 100 }, false,
        "≤ 60 days for FMCG · varies by industry",
        (v) => `Inventory turns every ${v.toFixed(0)} days.`),
      row("dpo", "Days Payables Outstanding", "days", dpo,
        { strong: 60, healthy: 45, watch: 30 }, true,
        "Higher = better supplier float (within terms)",
        (v) => `${v.toFixed(0)}-day average to settle suppliers.`),
      row("ccc", "Cash Conversion Cycle", "days", ccc,
        { strong: 30, healthy: 60, watch: 100 }, false,
        "Lower is better — cash speed",
        (v) => `${v.toFixed(0)}-day gap between cash out and cash in.`),
      row("asset_turnover", "Asset Turnover", "x", assetTurnover,
        { strong: 1.5, healthy: 0.8, watch: 0.4 }, true,
        "≥ 0.8× healthy (industry-dependent)",
        (v) => `${v.toFixed(2)}× revenue per unit of assets.`),
    ],
  };
}

// ─── THE ONE ALTMAN ROW ─────────────────────────────────────────────────────

/** The key every Altman surface addresses this measure by. One key, so the
 *  ratio drawer's knowledge entry, the Ratios tab and the printed document
 *  cannot be pointed at two different explanations. */
export const ALTMAN_RATIO_KEY = "altman_z";

/** The Altman row, in `Ratio` shape, built from THE credit reader.
 *
 *  Every field is a projection of one `AltmanResult` — the same object the
 *  Risks tab renders as `data-testid="altman-score"`, the hero chip prints
 *  beside its zone pill, and the workbook's Credit & Risk sheet carries.
 *  Nothing here bands, computes or re-words:
 *
 *    value      `credit.altman.score`      — the reader's number
 *    verdict    a 1:1 rendering of `credit.altman.zone`, NOT a band table.
 *               The old row had a fourth threshold (`strong` at 3.0) that
 *               exists in no methodology and on no other surface; a zone
 *               has three states, so the row has three.
 *    benchmark  spelled from `credit.altman.thresholds` + `variant`, so a
 *               threshold change moves the printed ladder with the number.
 *    commentary `credit.components[0].read` — the reader's own verdict
 *               words — followed by the model that minted them, because a
 *               forwarded document cannot ask which model ran.
 *
 *  A refused score yields a refused row: `value: null`, verdict `unknown`,
 *  and the absence sentence in `commentary`. `verdictColor("unknown")` is
 *  neutral, so an unmeasurable Z″ is never painted like a distressed one. */
export function altmanRatio(credit: CreditScoreResult): Ratio {
  const a = credit.altman;
  // The label is `credit.components[0].label`, not a literal, for the same
  // reason the workbook reuses it: the two deliverables once disagreed
  // about the NAME as well as the number — `Altman Z"-Score` (U+0022) on
  // one sheet and `Altman Z″-Score` (U+2033) on the other — which reads as
  // two measures to anyone scanning the file.
  const label = credit.components[0]?.label ?? `Altman ${a.variant}-Score`;
  const benchmark =
    `≥ ${a.thresholds.safe.toFixed(2)} safe · ` +
    `${a.thresholds.distress.toFixed(2)}–${a.thresholds.safe.toFixed(2)} grey · ` +
    `< ${a.thresholds.distress.toFixed(2)} distress (${a.variant} 1995 EM)`;
  if (a.score === null || a.zone === null) {
    return {
      key: ALTMAN_RATIO_KEY,
      label,
      value: null,
      unit: "ratio",
      verdict: "unknown",
      benchmark,
      unavailable: { kind: "missing", inputs: ["altman_z_score"] },
      commentary: VERDICT_UNAVAILABLE_NOTE,
    };
  }
  return {
    key: ALTMAN_RATIO_KEY,
    label,
    value: a.score,
    unit: "ratio",
    verdict: a.zone === "safe" ? "healthy" : a.zone === "grey" ? "watch" : "critical",
    benchmark,
    commentary: `${credit.components[0]?.read ?? ""} · ${credit.modelLabel}`.trim(),
  };
}

/** The sentence that travels with a REFUSED distress verdict. Same shape as
 *  the workbook's: a recipient who opens a forwarded document cannot ask the
 *  app why the cell is empty, and "no number" must not be read as "distress". */
export const VERDICT_UNAVAILABLE_NOTE =
  "Not enough of the source book was recognised to compute this verdict. " +
  "This is a limit of the extraction, NOT a finding about the company — " +
  "do not read it as distress.";

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
   *  current_ratio). Used to render the explainability block.
   *
   *  A value here is `number | null`: the explainability block is where a
   *  reader CHECKS the card's claim, so a fact the envelope never carried
   *  has to arrive as an absence, not as a 0 that looks measured. */
  factsCited?: Record<string, number | null>;
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
  // servedFacts gateway — BS grand totals (assets / equity / liabilities /
  // current splits) come from the served envelope; the old
  // `pick(ab.total_*, t.total*)` dual path is deleted. Bucket-level fields
  // (cash, dividends, intercompany, debt) keep their assembled_bs reads.
  const sf = factsFrom(s);
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
  const totalAssets = sf.totalAssets();
  const totalEquity = sf.totalEquity();
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
      current_assets: sf.currentAssets(),
      investment_property_net: investmentProp,
      ppe_net: investmentProp,
      non_current_assets: sf.nonCurrentAssets(),
      total_assets: totalAssets,
      suppliers: s.balanceSheet.accountsPayable,
      dividends_payable: apDividends,
      bank_debt_total: bankDebt,
      short_term_liabilities: sf.currentLiabilities(),
      total_liabilities: sf.totalLiabilities(),
      share_capital: s.balanceSheet.shareCapital,
      revaluation_reserves: 0,
      retained_earnings: pick(ab.retained_earnings, s.balanceSheet.retainedEarnings),
      current_year_pnl: niStatutory,
      total_equity: totalEquity,
      // Served drift, not a hardcoded 0 — cross-surface identical with
      // periodFacts.audit and the BS chip by construction.
      bs_balance_check: sf.difference(),
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
    audit: { bs_balance_check: sf.difference(), has_line_items: false, industry_classified: !!s.industry },
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
  // A refused ratio has no spelling as a number. Every caller — the HTML
  // report, the Excel export, the drawer — gets the same word, so none of
  // them can print "0.00×" for a figure nothing computed.
  if (r.value === null || !Number.isFinite(r.value)) return UNREPORTED_WORD;
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

// Palette literals feed the GENERATED standalone report document (its own
// <style> sheet — it cannot read the app's CSS vars), tuned to Paper.
export function verdictColor(v: RatioVerdict): { bg: string; text: string } {
  switch (v) {
    case "unknown":
      // Neutral, not red. A ratio nobody could compute is not a bad
      // ratio; colouring it like one is the grading defect in another
      // costume.
      return { bg: "#F1F1EF", text: "#5C5C57" }; // design-lint-allow-hex standalone generated report doc
    case "strong":
      return { bg: "#E7F3F1", text: "#0A6154" }; // design-lint-allow-hex standalone generated report doc
    case "healthy":
      return { bg: "#E7F3F1", text: "#0E7C6B" }; // design-lint-allow-hex standalone generated report doc
    case "watch":
      return { bg: "#E7F3F1", text: "#0A6154" }; // design-lint-allow-hex standalone generated report doc
    case "critical":
      return { bg: "#fee2e2", text: "#991b1b" }; // design-lint-allow-hex standalone generated report doc
  }
}

export function verdictLabel(v: RatioVerdict): string {
  return v === "strong"
    ? "Strong"
    : v === "healthy"
      ? "Healthy"
      : v === "watch"
        ? "Watch"
        : v === "unknown"
          ? "Not reported"
          : "Critical";
}

// ─── HTML report renderer ───────────────────────────────────────────────────

// ── THE DOCUMENT PEOPLE PRINT AND FORWARD ───────────────────────────────
//
// ⚠ `credit` IS REQUIRED, AND THAT IS THE WHOLE FIX. This function used to
// take `(s)` alone and call `computeRatios(s)` — no engine metric map, no
// credit envelope — then render `ratioGroup("Distress Models", r.bankruptcy)`.
// A renderer that CAN be called without the credit reader is a renderer that
// WILL be, so the parameter is not optional and there is no default: tsc
// names every caller instead of a reviewer noticing one.
//
// Measured on the real Scandia FY2025 period, engine envelope intact, read
// out of the produced bytes:
//
//     Risks tab / hero / /report / workbook   Z″ 0.22   Distress   CC
//     this document                           Z″ 0.19   badge v-critical
//                                             "Bankruptcy risk: distress
//                                              zone. Action required."
//                                             …and no letter, no composite
//                                             and no model ANYWHERE in it.
//
// Planting an engine re-band (letter_grade "B" with its own ladder, Z″ 3.50)
// moved every screen and the workbook to B / 3.50 / Safe. This document did
// not move at all — it had nothing in it that could.
export function renderReportHtml(
  s: Statements,
  credit: CreditScoreResult,
  // The engine metric map THE SAME reader was built over. Compose the two
  // in one place — `financialExports.buildReportHtml` — never by hand.
  metricsByName?: Record<string, number | null>,
): string {
  const t = deriveTotals(s);
  // servedFacts gateway — the report's BS totals + the balance-status
  // footer read the served envelope; this renderer never branches on
  // `s.canonical_bs` presence itself (the module knows).
  const sf = factsFrom(s);
  // PROVENANCE NOTE — the served envelope's own words, only when it
  // carries them (HTML can hold a note; a CSV cannot). Names the sheet the
  // balance sheet was read from, the extraction method and the mapping
  // pack — the same fields the on-screen affordance shows. Absent
  // fields yield no clause, never a dash.
  const provenanceNote = (() => {
    const cbsTop = sf.canonicalForRender();
    if (!cbsTop) return "";
    const parts = [
      cbsTop.extraction?.sheet ? `sheet ${escapeHtml(cbsTop.extraction.sheet)}` : null,
      cbsTop.extraction?.method ? `read ${escapeHtml(cbsTop.extraction.method)}` : null,
      cbsTop.mapping_version ? `mapping pack ${escapeHtml(cbsTop.mapping_version)}` : null,
    ].filter((x): x is string => x !== null);
    if (parts.length === 0) return "";
    return ` Balance-sheet provenance: ${parts.join(" &middot; ")}; each balance-sheet row above names its account codes.`;
  })();
  // The engine metric map the credit reader was built over — so every ratio
  // in this document quotes the engine wherever the engine spoke, exactly as
  // the screen and the workbook do. `computeRatios(s)` alone recomputed
  // FE-side every ratio the engine had already emitted; measured on the real
  // Scandia period that moved Interest Coverage 2.58× (Watch) → 1.46×
  // (Critical) in the printed document only.
  const r = computeRatios(s, undefined, metricsByName);
  const recs = generateRecommendations(s, r);
  // THE ONE ALTMAN, and the letter that travels with it.
  const altman = altmanRatio(credit);

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
        color: #6b7280; /* design-lint-allow-hex standalone generated report doc */
        letter-spacing: 0.04em;
      }
    }

    :root {
      /* Standalone generated document — cannot read the app token sheet;
         Paper palette baked in below (design-lint-allow-hex, whole block).
         Primary + secondary text are near-black / dark-grey (2026-07-25) —
         they were teal, which made the whole report read green.
         The --accent below is kept for accents (borders, labels). */
      --ink: #0B0E0D; /* design-lint-allow-hex standalone generated report doc */
      --ink-soft: #454b56; /* design-lint-allow-hex standalone generated report doc */
      --ink-mute: #6B7280; /* design-lint-allow-hex standalone generated report doc */
      --accent: #0E7C6B; /* design-lint-allow-hex standalone generated report doc */
      --rule: #C9CDD2; /* design-lint-allow-hex standalone generated report doc */
      --rule-soft: #E5E7EB; /* design-lint-allow-hex standalone generated report doc */
      --paper: #FFFFFF; /* design-lint-allow-hex standalone generated report doc (A4 print stays true white) */
      --bg-soft: #F7F8FA; /* design-lint-allow-hex standalone generated report doc */
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
    .badge.v-strong   { background: #E7F3F1; color: #0A6154; border-color: #B9DBD4; } /* design-lint-allow-hex standalone generated report doc */
    .badge.v-healthy  { background: #E7F3F1; color: #0A6154; border-color: #B9DBD4; } /* design-lint-allow-hex standalone generated report doc */
    .badge.v-watch    { background: #E7F3F1; color: #0A6154; border-color: #B9DBD4; } /* design-lint-allow-hex standalone generated report doc */
    .badge.v-critical { background: #F4E8E8; color: #7A1F1F; border-color: #C7A6A6; } /* design-lint-allow-hex standalone generated report doc */
    /* A ratio the period could not produce: quiet grey, never the red a
       reader would take for distress. */
    .badge.v-unknown  { background: #F1F1EF; color: #5C5C57; border-color: #D8D8D3; } /* design-lint-allow-hex standalone generated report doc */
    .ratio-card .value.unreported { font-size: 12pt; font-weight: 400; color: #5C5C57; } /* design-lint-allow-hex standalone generated report doc */

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
    .commentary { border-left-color: #0E7C6B; } /* design-lint-allow-hex standalone generated report doc */
    .risk       { border-left-color: #8B1A1A; } /* design-lint-allow-hex standalone generated report doc */
    .action     { border-left-color: #0A6154; } /* design-lint-allow-hex standalone generated report doc */
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
    .priority-critical { background: #FAF1F1; color: #7A1F1F; border-color: #C7A6A6; } /* design-lint-allow-hex standalone generated report doc */
    .priority-high     { background: #E7F3F1; color: #0A6154; border-color: #B9DBD4; } /* design-lint-allow-hex standalone generated report doc */
    .priority-medium   { background: #E7F3F1; color: #0A6154; border-color: #B9DBD4; } /* design-lint-allow-hex standalone generated report doc */
    .priority-info     { background: #F1F2F4; color: #4B5563; border-color: #C7CCD3; } /* design-lint-allow-hex standalone generated report doc */

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
        <div class="value${rt.value === null ? " unreported" : ""}">${escapeHtml(formatRatio(rt))}</div>
        <div class="meta">
          <span class="badge v-${rt.verdict}">${escapeHtml(verdictLabel(rt.verdict))}</span>
          &nbsp;${escapeHtml(rt.value === null ? rt.commentary : rt.benchmark)}
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

  // ── THE CREDIT SECTION ──────────────────────────────────────────────
  //
  // The letter, the composite, the model, the engine's own ladder, the
  // one Altman and the seven weighted component reads — every one of them
  // a projection of the `credit` this function was handed. This document
  // holds no ladder, no band table and no arithmetic of its own, which is
  // what makes an engine re-band move it on the same deploy as the four
  // screens.
  //
  // A letter NEVER prints without its model. There are two models behind
  // this cell and they disagree (engine CC / 24.4 against client fallback
  // CCC / 36 on this same period), and a printed page cannot be asked
  // which one ran.
  const creditSection = (): string => {
    const letterBlock =
      credit.rating === null
        ? `<div class="risk"><strong>Letter grade: ${escapeHtml(UNREPORTED_WORD)}.</strong> ${escapeHtml(VERDICT_UNAVAILABLE_NOTE)}</div>`
        : `<div class="commentary"><strong>Scoring model:</strong> ${escapeHtml(credit.model)} &mdash; ${escapeHtml(credit.modelLabel)}</div>`;
    // THE LADDER, SPELLED — so a re-band is visible on the page and not
    // only inside the letter. It comes off the reader's `letterBands`, so
    // this document never reaches past the reader into a raw envelope.
    const ladder = spellLadder(credit.letterBands);
    const ladderBlock = ladder
      ? `<div class="commentary" data-report-credit-ladder><strong>Grade ladder (${escapeHtml(credit.model)}):</strong> ${escapeHtml(ladder)}</div>`
      : "";
    const componentRows = credit.components
      .map(
        (c) => `<tr>
          <td>${escapeHtml(c.label)}</td>
          <td class="num">${escapeHtml(c.value === null ? UNREPORTED_WORD : c.value.toFixed(2))}</td>
          <td class="num">${escapeHtml(c.weight === null ? UNREPORTED_WORD : `${(c.weight * 100).toFixed(0)}%`)}</td>
          <td class="num">${escapeHtml(c.contribution === null ? UNREPORTED_WORD : c.contribution.toFixed(1))}</td>
          <td>${escapeHtml(c.read ?? UNREPORTED_WORD)}</td>
        </tr>`,
      )
      .join("");
    return `
    <div class="grid grid-3">
      <div class="ratio-card">
        <div class="label">Composite credit score</div>
        <div class="value${credit.score === null ? " unreported" : ""}" data-report-credit-score>${escapeHtml(credit.score === null ? UNREPORTED_WORD : `${credit.score.toFixed(1)} / 100`)}</div>
        <div class="meta">${escapeHtml(credit.model)}</div>
      </div>
      <div class="ratio-card">
        <div class="label">Letter grade</div>
        <div class="value${credit.rating === null ? " unreported" : ""}" data-report-credit-letter data-model="${escapeHtml(credit.rating === null ? "none" : credit.model)}">${escapeHtml(credit.rating ?? UNREPORTED_WORD)}</div>
        <div class="meta">${escapeHtml(credit.rating === null ? VERDICT_UNAVAILABLE_NOTE : credit.modelLabel)}</div>
      </div>
      ${ratioCard(altman)}
    </div>
    ${letterBlock}
    ${ladderBlock}
    <div class="${altman.verdict === "critical" ? "risk" : "commentary"}" data-report-altman-verdict data-zone="${escapeHtml(credit.altman.zone ?? "none")}">
      <strong>${escapeHtml(altman.label)}:</strong> ${escapeHtml(altman.commentary)}
    </div>
    <table>
      <thead><tr><th>Component</th><th class="num">Value</th><th class="num">Weight</th><th class="num">Contribution</th><th>Read</th></tr></thead>
      <tbody>${componentRows}</tbody>
    </table>
    <div class="commentary">${escapeHtml(credit.caveat)}</div>
  `;
  };

  const balanceSheetTable = (): string => {
    // canonical_bs v2 — serialize the engine object verbatim (contract
    // "Consumption rules": exports serialize canonical rows and totals when
    // present). The object + totals + status all come through the
    // servedFacts gateway (adjusted figures on RECONCILED periods); the
    // status footer wording comes from presentStatus — the same presenter
    // the BS chip and the Excel status cell use, so the three can never
    // word the verdict differently.
    const cbs = sf.canonicalForRender();
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
      // Status footer — ONE presenter (servedFacts.presentStatus) words the
      // verdict for chip + HTML + Excel alike. MATERIAL_IMBALANCE must read
      // as a defect (red .risk block with the engine's diagnosis), never as
      // a clean statement; RECONCILED is machine-distinct from BALANCED and
      // must never export as the pristine verdict (verifier kill-criterion)
      // — the receipt travels with the report.
      const p = sf.presentStatus(s.currency);
      const diagnosisSuffix =
        p.band === "material_imbalance" && (cbs.diagnosis ?? []).length
          ? ` Engine diagnosis: ${(cbs.diagnosis ?? [])
              .map((d) => `${escapeHtml(d.code)} — ${escapeHtml(d.detail)}`)
              .join("; ")}.`
          : "";
      const statusNote = `<div class="${p.band === "material_imbalance" ? "risk" : "commentary"}"><strong>${escapeHtml(p.exportHeadline)}</strong>${p.exportDetail ? ` ${escapeHtml(p.exportDetail)}` : ""}${diagnosisSuffix}</div>`;
      return `
      <table class="fin">
        <thead><tr><th>Balance Sheet</th><th class="num">${escapeHtml(s.periodLabel)}</th></tr></thead>
        <tbody>
          ${sideRows("assets")}
          <tr class="total"><td>Total Assets</td><td class="num">${money(sf.totalAssets(), s.currency)}</td></tr>
          ${sideRows("equity_liabilities")}
          <tr class="subtotal"><td>Total Liabilities</td><td class="num">${money(sf.totalLiabilities(), s.currency)}</td></tr>
          <tr class="total"><td>Total Equity + Liabilities</td><td class="num">${money(sf.equityPlusLiabilities(), s.currency)}</td></tr>
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
          <tr class="subtotal"><td>Current Assets</td><td class="num">${money(sf.currentAssets(), s.currency)}</td></tr>
          <tr class="indent"><td>Cash & equivalents</td><td class="num">${money(bs.cash, s.currency)}</td></tr>
          <tr class="indent"><td>Accounts receivable</td><td class="num">${money(bs.accountsReceivable, s.currency)}</td></tr>
          <tr class="indent"><td>Inventory</td><td class="num">${money(bs.inventory, s.currency)}</td></tr>
          <tr class="indent"><td>Other current assets</td><td class="num">${money(bs.otherCurrentAssets, s.currency)}</td></tr>
          <tr class="subtotal"><td>Non-Current Assets</td><td class="num">${money(sf.nonCurrentAssets(), s.currency)}</td></tr>
          <tr class="indent"><td>Property, plant & equipment</td><td class="num">${money(bs.propertyPlantEquipment, s.currency)}</td></tr>
          <tr class="indent"><td>Intangibles</td><td class="num">${money(bs.intangibles, s.currency)}</td></tr>
          <tr class="indent"><td>Other non-current assets</td><td class="num">${money(bs.otherNonCurrentAssets, s.currency)}</td></tr>
          <tr class="total"><td>Total Assets</td><td class="num">${money(sf.totalAssets(), s.currency)}</td></tr>

          <tr class="subtotal"><td>Current Liabilities</td><td class="num">${money(sf.currentLiabilities(), s.currency)}</td></tr>
          <tr class="indent"><td>Accounts payable</td><td class="num">${money(bs.accountsPayable, s.currency)}</td></tr>
          <tr class="indent"><td>Short-term debt</td><td class="num">${money(bs.shortTermDebt, s.currency)}</td></tr>
          <tr class="indent"><td>Other current liabilities</td><td class="num">${money(bs.otherCurrentLiabilities, s.currency)}</td></tr>
          <tr class="subtotal"><td>Non-Current Liabilities</td><td class="num">${money(sf.nonCurrentLiabilities(), s.currency)}</td></tr>
          <tr class="indent"><td>Long-term debt</td><td class="num">${money(bs.longTermDebt, s.currency)}</td></tr>
          <tr class="indent"><td>Other non-current liabilities</td><td class="num">${money(bs.otherNonCurrentLiabilities, s.currency)}</td></tr>
          <tr class="subtotal"><td>Total Liabilities</td><td class="num">${money(sf.totalLiabilities(), s.currency)}</td></tr>
          <tr class="indent"><td>Share capital</td><td class="num">${money(bs.shareCapital, s.currency)}</td></tr>
          <tr class="indent"><td>Retained earnings</td><td class="num">${money(bs.retainedEarnings, s.currency)}</td></tr>
          <tr class="indent"><td>Other equity</td><td class="num">${money(bs.otherEquity, s.currency)}</td></tr>
          <tr class="subtotal"><td>Total Equity</td><td class="num">${money(sf.totalEquity(), s.currency)}</td></tr>
          <tr class="total"><td>Total Liabilities + Equity</td><td class="num">${money(sf.equityPlusLiabilities(), s.currency)}</td></tr>
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

  <h2>Credit &amp; Distress</h2>
  ${creditSection()}

  <h2>Recommendations</h2>
  ${recs.map(recommendationCard).join("")}

  <aside class="basis-note">
    <strong>Basis of preparation</strong>
    Figures reflect the period&rsquo;s statutory financial statements as ingested by the CFO AI engine. Ratios follow standard lender conventions (Altman Z-Score, DSCR, debt-to-EBITDA, etc.); benchmarks are indicative and industry-dependent. Where the underlying trial-balance reconciliation gap exceeds tolerance, the affected figure is annotated in the relevant statement above. This document is AI-assisted; final analytical judgement and any onward decisions remain with management.${provenanceNote}
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

function money(n: number | null | undefined, currency: string): string {
  // ABSENT-CAPABLE. The servedFacts accessors return `number | null`, and
  // `Math.abs(null)` is 0 — a total the envelope never carried would
  // otherwise print as "RON 0" in the board-pack HTML, which is a
  // reported figure, not a gap.
  if (typeof n !== "number" || !Number.isFinite(n)) return UNREPORTED_WORD;
  // Render full number with thousands separators (e.g. "2,300,000 RON")
  // — board-pack reports show precise figures, not abbreviated.
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${currency} ${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// ── `downloadReport(s)` LIVED HERE AND IS GONE ──────────────────────────
//
// It called `renderReportHtml(s)` — one argument, no credit reader, no
// engine map — and it was wired straight to the Export tab's HTML card.
// The download helper now lives in `financialExports.ts` as
// `downloadHtmlReport(s, envelopes)`, beside `downloadExcelReport`, because
// that module is the one that already imports the credit reader and can
// therefore build BOTH deliverables from ONE envelopes object. Keeping the
// helper here would have meant either a runtime import cycle or a second
// composition point where the two documents could drift apart again.
//
// This is the file-writing half only — it takes bytes, never statements to
// render from, so it cannot grow a rendering path of its own.
export function saveHtmlReport(html: string, s: Statements): void {
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
