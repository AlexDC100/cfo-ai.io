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
// VALUE import, and safe: `industrySignal.ts` is a leaf that imports
// nothing. It is a READER over the engine's served block, not a second
// implementation of the comparison — the reading, the workspace key and
// the block decision are all computed once in
// `src/engine/industry/structural_signal.py`.
import { blocksSectorContent, readIndustrySignal } from "./industrySignal";
// CHARTS + THE DOCUMENT SHELL — `frontend/lib/charts/`. Server-generated
// SVG, no chart library, no runtime dependency: every figure in every
// chart is drawn into the bytes this function returns, so a gate can
// parse it and a reader with no network can see it. The shell (cover,
// contents, provenance card, find, toggles, print rules) lives beside
// the charts because it is the same deliverable — the one HTML file.
import {
  allChartBlocks,
  chartCss,
  contentsPage,
  contentsRail,
  coverPage,
  provAttrs,
  miniTrack,
  provenanceCard,
  readBands,
  renderChartBlock,
  shellCss,
  shellScript,
  toggleBar,
  zonesForKey,
  type ChartBlock,
  type ServedBands,
  type ShellSection,
  type ToggleSpec,
} from "./charts";
// THE FINDINGS, AND NOTHING BUT A READER OF THEM. `insights.ts` is a leaf
// that imports nothing and computes nothing — every digit it prints came
// off an `InsightMeasure` the engine authored, and `formatMeasure` is the
// only thing that turns one into a string. The eight detectors, the
// executive-summary model and the comparatives model were all built,
// tested and served on `statements.insights` — and imported by NO
// renderer, so the printed export was byte-identical with and without the
// block (133,472 bytes either way on agras, measured 2026-09-07). That is
// why the owner read the deployed report and said nothing had changed.
import {
  formatAmount,
  formatMeasure,
  readInsights,
  severityCaption,
  severityLadder,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  type Insight,
  type InsightsBlock,
} from "./insights";
// PAGE ONE'S MODEL. Both of these import values FROM this module, so the
// graph has a cycle — benign because neither side touches the other at
// module-evaluation time (both are called only from inside
// `renderReportHtml`), and exercised on all four books by
// `frontend/lib/__tests__/insightsExport.test.ts`.
import { buildExecutiveSummary, type ExecutiveSummary } from "./executiveSummary";
import {
  formatVariance,
  NO_COMPARATIVE_CELL,
  type ComparativeLine,
  type Comparatives,
} from "./reportComparatives";

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
  /** `organizations.industry_display_name` — a DISPLAY LABEL ("Real
   *  estate · residential rental"), never the key the rule registry
   *  scopes on. Read `industry_signal.workspace.industry_key` for the
   *  key; see `resolveIndustryKey` below for why that distinction cost
   *  two food factories a commercial-real-estate recommendation. */
  industry?: string;
  /** The engine's reading of the ACCOUNT MIX and its verdict on whether
   *  that agrees with the workspace setting — served on
   *  `GET /api/period/{id}`. Absent on older payloads, which blocks
   *  nothing. */
  industry_signal?: unknown;
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
/** `"ungraded"` is the OTHER refusal, and it is not the same one.
 *  `"unknown"` says the ratio has no value. `"ungraded"` says the ratio
 *  has a value and no ladder that may be applied to it here — measured
 *  today only when the workspace's sector and the account mix disagree
 *  and the band was one sector's (see `SECTOR_CALIBRATED_RATIOS`). They
 *  are separate members because they print differently beside a figure:
 *  "Not reported" over a printed 72 days would be a third lie. */
export type RatioVerdict =
  | "strong"
  | "healthy"
  | "watch"
  | "critical"
  | "unknown"
  | "ungraded";

export interface Ratio {
  key: string;
  label: string;
  /** THE ARITHMETIC, IN WORDS, beside the figure it produced.
   *
   *  REQUIRED, so `tsc` enumerates every construction site rather than a
   *  human remembering to fill it in. A rendered ratio a reader cannot
   *  check is a claim, not a measurement, and the report used to print
   *  twenty-two of them with nothing but a label and a benchmark band:
   *  "Interest Coverage 66.28×" beside a credit component labelled
   *  "Interest Coverage (EBIT / Interest)" whose basis gives 55.64× on
   *  the same book, and "Quick Ratio 0.74×" whose value is
   *  (cash + receivables) ÷ current liabilities where the textbook
   *  (current assets − inventory) ÷ current liabilities is 1.42× — the
   *  difference between Watch and Healthy, decided by a definition the
   *  page never stated.
   *
   *  The words here must describe the arithmetic that produced `value`,
   *  including where that value came off the engine rather than out of
   *  the fallback below it. `exportRatioFormulas.test.ts` recomputes each
   *  one from the served envelope and reds when the two disagree. */
  formula: string;
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
  /** THE LADDER THE VERDICT WAS DECIDED BY, carried rather than discarded.
   *
   *  `row()` used to consume the band object and throw it away, so the
   *  only trace of "healthy starts at 1.5×" was the English in
   *  `benchmark`. That makes "what would change the verdict" — how far
   *  this company is from the next rung — unanswerable except by
   *  re-typing the cutoffs somewhere else, which is TC-10's exact
   *  prohibition: a threshold written as prose beside a verdict computed
   *  from a different copy of it.
   *
   *  ABSENT means NO LADDER WAS APPLIED, and that is not the same as an
   *  empty one: a sector-calibrated row under a disputed sector carries
   *  no ladder here precisely so nothing downstream can quote the cutoff
   *  the card refused to print. */
  ladder?: RatioLadder;
}

export interface RatioLadder {
  bands: { critical?: number; watch?: number; healthy?: number; strong?: number };
  /** Which direction the number improves in — without it a band edge is
   *  a number with no side, and "distance to the next rung" has no sign. */
  higherIsBetter: boolean;
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

// ── WHICH BANDS ARE ONE SECTOR'S, AND WHICH ARE EVERY SECTOR'S ────────
//
// Not a taste call. `CLAUDE.md` Appendix A §5 tabulates the benchmark
// for each ratio, and six of them are given as a RANGE THAT MOVES WITH
// THE INDUSTRY — the framework states both ends itself:
//
//   EBITDA margin   food mfg 8–13%   ·  real estate 50%+
//   Net margin      food mfg 3–7%    ·  real estate 20–50%
//   Gross margin    "Industry-dependent"
//   DIO             food mfg 40–70 d ·  real estate 0–5 d
//   DSO             food mfg 30–60 d ·  real estate 15–45 d
//   Asset turnover  "1.0–1.5×", and the row itself says "(industry-dependent)"
//
// Every other band in §5 is given as ONE number for all businesses
// ("Current ratio >1.5× ideal", "Interest coverage >3.0× safe",
// "Equity ratio >30%"). Those are not withheld when the sector is
// disputed, because nothing about them was calibrated on a sector — and
// a block that blanked them too would blank the report and prove
// nothing. Six of twenty-two rows lose their ladder; sixteen keep it.
//
// `sectorBenchmarkLexiconLeak.test.ts` reds if a row outside this set
// prints a band that names a sector.
export const SECTOR_CALIBRATED_RATIOS: ReadonlySet<string> = new Set([
  "gross_margin",
  "ebitda_margin",
  "net_margin",
  "dio",
  "dso",
  "asset_turnover",
]);

/** What a sector-calibrated row prints INSTEAD of a band it may not
 *  assert. Never "—": a dash in the benchmark column reads as "no
 *  benchmark exists", which is the opposite of what happened. */
export const SECTOR_BAND_WITHHELD =
  "Benchmark withheld — this ratio's healthy range differs by sector and the sector is unconfirmed";

// ── TC-10: THE PRINTED BAND IS RENDERED FROM THE LADDER, NEVER TYPED ──
//
// Measured on the rendered agras export, 2026-09-07:
//
//     Days Payables Outstanding   27 days   Critical
//     Higher = better supplier float (within terms)
//
// The word "Critical" was produced by `{ strong: 60, healthy: 45,
// watch: 30 }` and NOT ONE of those three numbers appears anywhere on
// the card. Every other card was only better by degree — "Current Ratio
// … ≥ 1.5× healthy · ≥ 2.0× strong" prints two of its three rungs and
// omits the one that decides Critical, so a reader could not tell why
// 0.99× is Critical and 1.01× is Watch.
//
// `ladderSentence` renders EVERY rung of the object `verdictFromBands`
// just read, in the row's own unit and in the row's own direction. The
// hand-typed `benchmark` prose survives after it as an editorial note
// (some of it is real content — "varies by industry"), but it is no
// longer the only place a cutoff is written down, and
// `ratioLadderHonesty.test.ts` reds if a comparator-anchored number in
// that note is not a rung of this row's own ladder.
const LADDER_ORDER: ReadonlyArray<"strong" | "healthy" | "watch"> = ["strong", "healthy", "watch"];

/** One rung, printed in the row's own unit. Never rounds a cutoff away:
 *  a band at 0.0125 must not print as "0.01". */
function rungFigure(v: number, unit: Ratio["unit"]): string {
  const digits = Math.abs(v) >= 10 || Number.isInteger(v) ? 0 : Math.abs(v) >= 1 ? 2 : 4;
  const shown = Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  return unit === "x" ? `${shown}×` : unit === "%" ? `${shown}%` : unit === "days" ? `${shown} d` : shown;
}

/** THE LADDER, IN WORDS, from the same object the badge was banded with.
 *
 *  `higherIsBetter` decides the comparator, so the sentence cannot state
 *  the cutoff with the wrong side — the defect that made a printed
 *  "≥ 1.25×" sit beside a lower-is-better verdict impossible to write.
 *
 *  The trailing clause names what happens BELOW the last declared rung,
 *  and it is the honest half: a ladder that declares a `watch` rung has
 *  a critical state under it; one that does not, does not. */
export function ladderSentence(ladder: RatioLadder, unit: Ratio["unit"]): string {
  const cmp = ladder.higherIsBetter ? "≥" : "≤";
  const parts: string[] = [];
  for (const name of LADDER_ORDER) {
    const v = ladder.bands[name];
    if (typeof v === "number") parts.push(`${name} ${cmp} ${rungFigure(v, unit)}`);
  }
  if (parts.length === 0) return "";
  const worst = ladder.bands.watch;
  parts.push(
    typeof worst === "number"
      ? `critical ${ladder.higherIsBetter ? "<" : ">"} ${rungFigure(worst, unit)}`
      : "no critical rung on this scale",
  );
  return parts.join(" · ");
}

/** Reader-facing words for a statement line. A refusal names the CONCEPT
 *  the filing is missing, not the camelCase field the code happens to
 *  call it — a reader checking their own statements is looking for
 *  "interest expense", not `interestExpense`. */
const INPUT_WORDS: Partial<Record<StatementInput | keyof SupplementaryData, string>> = {
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
  // Not a statement line — a supplementary input somebody supplies with
  // the period. It still needs a reader's word, because the refusal it
  // produces ("this filing does not carry …") is read by someone
  // checking their own inputs, and `annualLeaseExpense` is not a phrase
  // that appears anywhere in their data.
  annualLeaseExpense: "an annual lease expense",
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
  //
  // ⚠ A LADDER THAT DECLARES NO `watch` RUNG HAS NO CRITICAL STATE.
  // This function used to `return "critical"` off the end unconditionally,
  // which meant a scale could be given a distress verdict it never
  // defined one for. That is not hypothetical: DPO's scale measures
  // supplier float, and "settles suppliers faster than the benchmark"
  // has no distress reading — the worst thing it can say is "below the
  // benchmark float". Omitting `watch` is now how a row DECLARES that,
  // and `ladderSentence` prints "no critical rung on this scale" from
  // the same object, so the reader is told rather than left to infer it
  // from a badge that never appears.
  const floor: RatioVerdict = bands.watch === undefined ? "watch" : "critical";
  if (higherIsBetter) {
    if (bands.strong !== undefined && value >= bands.strong) return "strong";
    if (bands.healthy !== undefined && value >= bands.healthy) return "healthy";
    if (bands.watch !== undefined && value >= bands.watch) return "watch";
    return floor;
  }
  if (bands.strong !== undefined && value <= bands.strong) return "strong";
  if (bands.healthy !== undefined && value <= bands.healthy) return "healthy";
  if (bands.watch !== undefined && value <= bands.watch) return "watch";
  return floor;
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
  /** The engine's assembled P&L, when the source carries one. Read only
   *  by `anchored()` below — the resolver every caption quotes through. */
  const apl = s.assembled_pl ?? {};
  const days = sup.periodDays ?? 365;
  // THE ONE AUTHORITY, asked once. Never re-derived from `s.industry` or
  // from `agreement` at a call site — a second spelling of this question
  // is how a header ends up saying "unconfirmed" while the cards below
  // it keep grading against one sector's ladder.
  const sectorDisputed = blocksSectorContent(readIndustrySignal(s.industry_signal));
  const sectorCalibrated = SECTOR_CALIBRATED_RATIOS;

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
  // ── THE FACT A CAPTION IS ALLOWED TO QUOTE ──────────────────────────
  //
  // A caption is prose ABOUT the number beside it, so it must resolve
  // through the same fact that number resolved. Until 2026-09-07 it did
  // not: `netMargin` came from the engine's `net_margin` (built on
  // account 121, the filed close) while its caption interpolated the
  // FE reconstruction `netIncome` (`pretax − tax`). Measured, printed
  // side by side in the same card on all four firm books:
  //
  //   book         Net Margin   the caption beside it        the anchor
  //   agras            6.3 %    "RON 14.11M bottom-line"     7,533,676.02
  //   carniprod        1.4 %    "RON 5.84M bottom-line"      1,435,533.59
  //   realestate    −493.7 %    "RON −30.39M bottom-line"     −801,604.14
  //   retail           4.0 %    "RON 1.16M bottom-line"      3,205,212.62
  //
  // On agras a reader is shown a 6.3 % margin and, one line below it, a
  // profit that is 1.87× the one the margin was computed from.
  //
  // `anchored` is the one resolver: the engine's assembled figure first,
  // then the served metric of the same name, then the FE reconstruction —
  // which is all a source with no envelope (the public-company adapter)
  // ever has.
  const aplNum = (k: string): number | null => {
    const v = apl[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const anchored = (field: string, metric: string, fallback: Fig): Fig => {
    const a = aplNum(field);
    return a === null ? mOr(metric, fallback) : known(a);
  };
  const anchoredNetIncome = anchored("net_income_statutory", "net_income_statutory", netIncome);
  const anchoredEbitda = anchored("ebitda_statutory", "ebitda_statutory", ebitda);
  const anchoredRevenue = anchored("revenue", "revenue", revenue);

  // ── A MARGIN OVER A COST LINE THAT IS NOT THERE ─────────────────────
  //
  // Measured on the `realestate` book: `cost_of_goods_sold` is 0.00 in
  // the served envelope — a rental business books its costs to opex, not
  // to class 607 — so gross profit IS revenue and the engine's served
  // `gross_margin` is exactly 1.0. Printed, that read
  //
  //     Gross Margin   100.0%   Strong
  //
  // on a book losing 29,038,838 of EBITDA. The number is right; the BADGE
  // is measuring the absence of a cost line and calling it performance.
  // `≥ 40% strong` is a rung about how much revenue survives direct
  // costs, and with no direct costs to survive there is nothing for it to
  // grade.
  //
  // The VALUE stays — 100.0% is a true and useful statement about how
  // this book is structured. The GRADE goes, through the same `ungraded`
  // path the disputed-sector rows use, and `grossMarginUngradedNote`
  // below says why on the card.
  const costOfSales = I("costOfGoodsSold");
  const grossMarginHasCostBase = costOfSales.value !== null && costOfSales.value !== 0;
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
  //
  // The `atLeast(…, 1)` floor is the engine's own guard, and it is the
  // reason this row needs the sign check applied to the UNFLOORED figure:
  // flooring a negative invested capital to 1 does not make the quotient
  // gradable, it makes it enormous. The floor stays (it is what the
  // engine's number was built with); the guard reads the real total.
  const investedCapital = add(totalDebt, totalEquity);
  const roic = mPctOr(
    "roic",
    pctOf(mul(ebit, known(1 - 0.16)), atLeast(investedCapital, 1), "invested capital"),
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
  // legitimate FE arithmetic on user input.
  //
  // ── N1: AN ABSENT INPUT IS NOT A FINDING ABOUT THE COMPANY ─────────
  //
  // It used to fall back to plain `dscr` and print, on all four books:
  //
  //     Adjusted DSCR (incl. lease)   7.43×   Strong
  //     no lease supplied — identical to DSCR above
  //
  // Two defects in one card. (1) It is the SAME NUMBER as the card above
  // it, under a name that says it includes something it does not — R1,
  // one value wearing two names, and the name that is wrong is the one
  // claiming the extra content. (2) "no lease supplied" reads as a
  // statement about the BOOK, and on the agras book it is contradicted
  // by the book's own balance sheet: RON 887,498 sits in account 167,
  // which `packs/ro/omfp1802-v1/classification.yaml:107` (rule `ro.167`)
  // describes as "Datorii din leasing financiar". The document declared
  // no lease on one page while carrying a finance-lease liability on
  // another.
  //
  // `sup.annualLeaseExpense` is a round-tripped USER ASSUMPTION
  // (`pipeline.py:7932`), so its absence means "nobody typed a lease
  // charge", never "this company has no leases". The honest answer to
  // "what is coverage including the lease charge?" when nobody supplied
  // the lease charge is that it has no value — so the row refuses, names
  // the missing input, and says why the balance-sheet liability cannot
  // stand in for it. It asserts nothing either way about whether this
  // book has a lease, because this surface cannot see account 167.
  const adjustedDscr = sup.annualLeaseExpense
    ? div(
        add(ebitda, known(sup.annualLeaseExpense)),
        add(debtService, known(sup.annualLeaseExpense)),
        "interest + short-term debt + lease",
      )
    : absent("annualLeaseExpense");
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
  // NO SIGN GUARD, DELIBERATELY. `ccc` is a difference, not a quotient —
  // a negative cash conversion cycle means the company is paid before it
  // pays, which is the best thing this scale can say, and a refusal here
  // would delete a real strength. It inherits the refusals of its three
  // terms through `sub`/`add`, which is the correct propagation.
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

  /** A money figure for commentary — the gap word when it is absent, so a
   *  sentence never quotes a number the ratios refused. */
  const money = (f: Fig): string =>
    f.value === null ? UNREPORTED_WORD : formatCurrency(f.value, s.currency);

  /** The near-cash the Cash Ratio caption is ABOUT — read from the served
   *  balance sheet's own row (`short_term_investments`, account codes
   *  ['50']), not from any bucket that happens to contain it. ABSENT when
   *  the envelope did not carry a canonical BS, and the caption then
   *  states an unknown rather than a substitute. */
  const shortTermInvestments: Fig = (() => {
    const row = sf
      .canonicalForRender()
      ?.rows.find((x) => x.id === "short_term_investments");
    return row === undefined ? absent("shortTermInvestments") : num("shortTermInvestments", row.amount);
  })();

  // ── EVERY LADDER THAT ASSUMES A POSITIVE DENOMINATOR, AND ITS ONE ───
  // ── TABLE, SO A NEW ROW CANNOT BE ADDED ON THE WRONG SIDE OF IT ─────
  //
  // Measured on the committed `realestate` book, 2026-09-07, the printed
  // export carried
  //
  //     Debt / EBITDA   -0.64×   STRONG
  //     "Debt service comfortably aligned with cash generation."
  //
  // in the same document as EBITDA -29,038,838, DSCR -5.86× Critical,
  // Interest Coverage -25.08× Critical, and a CRITICAL recommendation
  // card reading "the operating model is not generating cash". The band
  // track drew its marker in the strong zone too, because it bands off
  // the same ladder.
  //
  // Dividing by a negative flips the quotient's sign, so a lower-is-better
  // ladder reads the most distressed book in the corpus as beating its
  // best rung, and a higher-is-better one does the reverse. The VALUE is
  // arithmetically fine and stays on the card — it is a true statement
  // about this book. The GRADE is what has no meaning, so the grade is
  // what goes, through the same `ungraded` exit a withheld sector band
  // uses (`RatioVerdict`, line 725: "the ratio has a value and no ladder
  // that may be applied to it here").
  //
  // TWO THINGS MAKE THIS THE FORM OF THE FIX THAT HOLDS:
  //
  // 1. It is applied inside `row()` off ONE table, so every present and
  //    future row is covered by construction rather than by whoever
  //    remembers. `ratioSignGuard.test.ts` reds if a row whose formula
  //    divides by a company figure is missing from the table.
  // 2. It reads the DENOMINATOR FACT, not the value's provenance. The
  //    -0.6388 was the ENGINE's served `debt_to_ebitda`, so a guard
  //    inside the local `div()` would never have run — the local
  //    arithmetic is not evaluated when a served metric exists.
  //
  // NOT LISTED, DELIBERATELY: `interest_coverage`, `dscr`,
  // `dscr_with_lt_principal`, `adjusted_dscr`, `net_margin`,
  // `ebitda_margin`, `roa`, `roe`, `roic`. Their denominators (interest,
  // debt service, revenue, assets, equity, invested capital) are what a
  // NEGATIVE NUMERATOR is divided BY on a loss-making book, and the
  // resulting negative bands correctly — a coverage of -25× IS critical.
  // Withholding those grades would delete a true distress signal, which
  // is the same failure pointing the other way. They join the table only
  // if their own denominator can turn negative, and `roa`/`roe`/`roic`
  // are here for exactly that reason: assets, equity and invested
  // capital CAN go negative, and then their sign flips too.
  const positiveDenominator: ReadonlyArray<{
    keys: readonly string[];
    fig: Fig;
    name: string;
  }> = [
    { keys: ["current_ratio", "quick_ratio", "cash_ratio"], fig: currentLiabilities, name: "current liabilities" },
    { keys: ["gross_margin", "ebitda_margin", "net_margin", "dso"], fig: revenue, name: "revenue" },
    { keys: ["roa", "ltv", "equity_ratio", "asset_turnover"], fig: totalAssets, name: "total assets" },
    { keys: ["roe", "debt_to_equity"], fig: totalEquity, name: "total equity" },
    { keys: ["roic"], fig: investedCapital, name: "invested capital" },
    { keys: ["debt_to_ebitda"], fig: ebitda, name: "EBITDA" },
    { keys: ["dio", "dpo"], fig: totalOperatingExpense, name: "total operating expense" },
  ];
  /** The reason this row's ladder may not be applied, or null. Rendered
   *  from the denominator the verdict would have been decided against —
   *  never a cutoff typed in prose (TC-10). */
  const signWithheld = (key: string): string | null => {
    for (const g of positiveDenominator) {
      if (!g.keys.includes(key)) continue;
      if (g.fig.value === null || g.fig.value >= 0) return null;
      return (
        `Band withheld — this scale's rungs assume ${g.name} is positive, and here it is ` +
        `${money(g.fig)}. Dividing by a negative flips this ratio's sign, so every rung would ` +
        `read backwards; the figure is stated, the verdict is not.`
      );
    }
    return null;
  };

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
    formula: string,
    commentary: (v: number) => string,
    /** Extra prose this row needs and no other does. `absenceNote` is
     *  appended to the refusal sentence — used where "not reported" alone
     *  would let a reader conclude something about the COMPANY from the
     *  absence of an INPUT.
     *
     *  `ungradedBecause`, when present, keeps the VALUE and drops the
     *  BADGE: the number is a true statement about this book and the
     *  ladder is not a scale it sits on. Same shape the disputed-sector
     *  branch below produces, with this row's own reason in place of the
     *  sector one — and the reason is rendered from the data that
     *  produced it, never typed as a cutoff (TC-10). */
    extra?: { absenceNote?: string; ungradedBecause?: string },
  ): Ratio => {
    if (f.value === null) {
      const absence = f.absence ?? { kind: "missing", inputs: [] };
      const note = extra?.absenceNote;
      return {
        key,
        label,
        formula,
        value: null,
        unit,
        verdict: "unknown",
        benchmark,
        unavailable: absence,
        commentary: note ? `${describeAbsence(absence)} ${note}` : describeAbsence(absence),
      };
    }
    // ── THE BAND IS SECTOR CONTENT; THE ARITHMETIC IS NOT ─────────────
    //
    // Measured on the disputed Agras export (the owner's live case: a
    // meat book served under "Real estate · residential rental"), the
    // header promised "no sector benchmark … is included below" and the
    // §Efficiency card three screens down printed
    //
    //     Days Inventory Outstanding   72 days   Watch   ≤ 60 days for FMCG · varies by industry
    //
    // One document, two answers. The value is fine — inventory ÷ total
    // operating expense × days does not know what sector it is in. What
    // does not survive a disputed sector is the LADDER: 60 days is the
    // FMCG rung, and both the printed band AND the badge banded off it
    // are that rung's conclusion. Withholding the sentence while keeping
    // the badge would be TC-10 backwards — a cutoff hidden from the
    // verdict it produced. Both go, together, and the row says why.
    if (sectorCalibrated.has(key) && sectorDisputed) {
      return {
        key,
        label,
        formula,
        value: f.value,
        unit,
        verdict: "ungraded",
        benchmark: SECTOR_BAND_WITHHELD,
        commentary: commentary(f.value),
      };
    }
    // ── THE LADDER MEASURES SOMETHING THIS BOOK HAS NONE OF ───────────
    // Same exit, two more reasons: the denominator's sign (from the one
    // table above, so no row can be forgotten), and a row-specific
    // `ungradedBecause`. Placed AFTER the sector branch so a disputed
    // sector still wins — a withheld sector band is the stronger claim,
    // and stacking two "why" sentences on one card teaches neither.
    const withheld = signWithheld(key) ?? extra?.ungradedBecause ?? null;
    if (withheld !== null) {
      return {
        key,
        label,
        formula,
        value: f.value,
        unit,
        verdict: "ungraded",
        benchmark: withheld,
        commentary: commentary(f.value),
      };
    }
    // The SAME object `verdictFromBands` reads below. "What would change
    // the verdict" bands off this and cannot drift from the badge — and
    // so does the printed band sentence, which is the TC-10 half: the
    // cutoffs a reader sees are the cutoffs the word was decided by,
    // because they are rendered from this object rather than typed
    // beside it.
    const ladder: RatioLadder = { bands, higherIsBetter };
    const spelled = ladderSentence(ladder, unit);
    return {
      key,
      label,
      formula,
      value: f.value,
      unit,
      verdict: verdictFromBands(f.value, bands, higherIsBetter),
      benchmark: spelled === "" ? benchmark : `${spelled} — ${benchmark}`,
      commentary: commentary(f.value),
      ladder,
    };
  };

  return {
    liquidity: [
      row("current_ratio", "Current Ratio", "x", currentRatio,
        { strong: 2, healthy: 1.5, watch: 1 }, true,
        "≥ 1.5× healthy · ≥ 2.0× strong",
        "current assets ÷ current liabilities",
        (v) =>
          v >= 1.5
            ? "Comfortable short-term cushion against current obligations."
            : v >= 1
              ? "Tight but covered — monitor working capital weekly."
              : "Current liabilities exceed current assets — liquidity stress."),
      row("quick_ratio", "Quick Ratio", "x", quickRatio,
        { strong: 1.5, healthy: 1, watch: 0.7 }, true,
        "≥ 1.0× healthy",
        "(cash + trade receivables) ÷ current liabilities — the acid test; other current assets are excluded, which is why this can sit a full band below (current assets − inventory) ÷ current liabilities",
        (v) =>
          v >= 1
            ? "Cash + receivables alone cover current liabilities."
            : "Reliance on inventory liquidation to meet short-term obligations."),
      // ── N3: THE EXCLUSION THAT DECIDED THE BAND, SAID OUT LOUD ──────
      //
      // Measured on the agras export: cash 1,168,047.04 ÷ current
      // liabilities 13,012,976.77 = 0.0898× → Critical. The same book's
      // balance sheet carries RON 906,526 of short-term investments
      // (RAS class 50); the engine's own canonical schema files that
      // bucket UNDER `cash_and_equivalents`
      // (`src/engine/canonical/schema_v1.py:96`), and a cash ratio that
      // counts it reads 2,074,573 ÷ 13,012,976.77 = 0.159× → Watch.
      //
      // ONE BAND EITHER SIDE OF A CHOICE THE DOCUMENT NEVER STATED. The
      // choice itself is defensible — bank balances and petty cash are
      // the only money that settles a payable on the day it falls due —
      // but "cash ÷ current liabilities" beside a Critical badge told a
      // reader nothing about which cash. It says so now, in the formula
      // the gate recomputes, and the caption calls the reading a floor
      // rather than a measurement of everything liquid.
      //
      // ⚠ THE FIGURE IS UNCHANGED and cannot change here: the served
      // `BalanceSheet` shape carries no short-term-investments field, so
      // this surface CANNOT include class 50 even if it decided to. See
      // the envelope request in the wave report.
      //
      // ── D4: THE CAPTION POINTED AT THE WRONG ROW ────────────────────
      //
      // It closed with "the balance sheet's other current assets show how
      // much is at stake". On agras that row is RON 8,861,293 while the
      // near-cash it MEANT is RON 906,526 — so a reader who followed the
      // pointer and re-ran the arithmetic got (1,168,047 + 8,861,293) ÷
      // 13,012,977 = 0.77×, nine times the 0.159× the sentence was about,
      // and two whole bands past it. A caption that sends a reader to a
      // figure and the figure is the wrong one is worse than silence,
      // because the reader does the sum and trusts the answer.
      //
      // The served canonical balance sheet carries the right row by name
      // (`short_term_investments`, account codes ['50']), so the sentence
      // states THAT amount when the envelope carries it. When it does
      // not, the sentence says the amount is not on this surface and
      // points at nothing — an unstated number, never a wrong one.
      row("cash_ratio", "Cash Ratio", "x", cashRatio,
        { strong: 0.5, healthy: 0.2, watch: 0.1 }, true,
        "cash and bank balances only — short-term investments are NOT counted, so this is the floor reading of same-day liquidity",
        "cash and bank balances ÷ current liabilities — cash excludes short-term investments (RAS class 50) and every other current asset",
        (v) =>
          v >= 0.2
            ? "Adequate cash buffer for operating shocks."
            : "Limited dry cash — exposed to revenue interruption. Counting short-term investments as well would raise this reading" +
              (shortTermInvestments.value === null
                ? "; this document does not carry that balance as its own line, so how much it would raise it is not stated here."
                : `; the balance sheet carries ${money(shortTermInvestments)} of them (RAS class 50), and that is the whole of what this reading leaves out.`)),
    ],
    profitability: [
      row("gross_margin", "Gross Margin", "%", grossMargin,
        { strong: 40, healthy: 25, watch: 15 }, true,
        "Industry-dependent · ≥ 25% healthy",
        "gross profit ÷ revenue",
        (v) =>
          grossMarginHasCostBase
            ? `${v.toFixed(1)}% gross margin on ${money(anchoredRevenue)} revenue.`
            : `${v.toFixed(1)}% because this book reports no cost of sales at all — gross profit and revenue are the same figure, ${money(anchoredRevenue)}. Its costs sit in operating expenses; read EBITDA Margin below instead.`,
        grossMarginHasCostBase
          ? undefined
          : {
              ungradedBecause:
                "Band withheld — the rungs measure how much revenue survives cost of sales, and this book reports a cost of sales of " +
                `${money(costOfSales)}. There is nothing for the scale to grade, so the figure is printed without a verdict.`,
            }),
      row("ebitda_margin", "EBITDA Margin", "%", ebitdaMargin,
        { strong: 25, healthy: 15, watch: 8 }, true,
        "≥ 15% healthy · ≥ 25% strong",
        "EBITDA (statutory) ÷ revenue",
        () => `${money(anchoredEbitda)} EBITDA on ${money(anchoredRevenue)} revenue — operating cash generation.`),
      row("net_margin", "Net Margin", "%", netMargin,
        { strong: 15, healthy: 8, watch: 3 }, true,
        "≥ 8% healthy",
        "net profit as filed (account 121) ÷ revenue",
        () => `${money(anchoredNetIncome)} net profit as filed, on ${money(anchoredRevenue)} revenue.`),
      row("roa", "Return on Assets", "%", roa,
        { strong: 10, healthy: 5, watch: 2 }, true,
        "≥ 5% healthy",
        "net profit as filed (account 121) ÷ total assets",
        (v) =>
          v >= 5
            ? "Assets generating solid returns."
            : "Asset base under-earning — review utilization."),
      row("roe", "Return on Equity", "%", roe,
        { strong: 20, healthy: 12, watch: 6 }, true,
        "≥ 12% healthy",
        "net profit as filed (account 121) ÷ total equity",
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
        "EBIT × (1 − 16% tax) ÷ (total debt + total equity) — NOPAT over invested capital. Net profit is NOT an input: this ratio does not move with the account-121 anchor and is not expected to.",
        (v) =>
          v >= 10
            ? "Invested capital earning above typical WACC."
            : "Returns below cost of capital — value-destroying configuration."),
    ],
    leverage: [
      row("debt_to_ebitda", "Debt / EBITDA", "x", debtToEbitda,
        { strong: 2, healthy: 3, watch: 4.5 }, false,
        "≤ 3× healthy · ≤ 2× strong",
        "total debt ÷ EBITDA (statutory)",
        (v) =>
          v <= 3
            ? "Debt service comfortably aligned with cash generation."
            : v <= 4.5
              ? "Elevated leverage — refinancing risk if EBITDA contracts."
              : "Stretched balance sheet — covenant risk likely."),
      row("debt_to_equity", "Debt / Equity", "x", debtToEquity,
        { strong: 0.5, healthy: 1, watch: 2 }, false,
        "≤ 1.0× healthy",
        "total debt ÷ total equity",
        (v) => (v <= 1 ? "Conservatively capitalized." : "Leverage exceeds equity cushion.")),
      row("equity_ratio", "Equity Ratio", "%", equityRatio,
        { strong: 50, healthy: 30, watch: 15 }, true,
        "≥ 30% healthy",
        "total equity ÷ total assets",
        (v) => `${v.toFixed(1)}% of assets funded by equity.`),
      row("ltv", sup.propertyMarketValue ? "Loan-to-Value" : "Debt-to-Assets", "%", ltv,
        { strong: 50, healthy: 65, watch: 80 }, false,
        "≤ 65% healthy",
        sup.propertyMarketValue
          ? "total debt ÷ property market value (supplied by the reader, not from the trial balance)"
          : "total debt ÷ total assets",
        (v) =>
          v <= 65
            ? "Asset coverage of debt is comfortable."
            : "Limited equity headroom against pledged assets."),
    ],
    coverage: [
      // THE LABEL IS THE THING THAT WAS WRONG, NOT THE VALUE. The engine's
      // canonical `interest_coverage` is EBITDA ÷ interest (pipeline.py
      // :2226, `safe(ebitda, interest)`) and every other surface reads it,
      // so moving the number would move the dashboard, the covenant
      // screens and the capsule with it. What the document could not do
      // was print "Interest Coverage 66.28×" three pages above a credit
      // component labelled "Interest Coverage (EBIT / Interest)" whose
      // basis is 55.64× on the same book. Two bases, two numbers, one
      // name. The card now says which one it is.
      row("interest_coverage", "Interest Coverage (EBITDA / Interest)", "x", interestCoverage,
        { strong: 6, healthy: 3, watch: 1.5 }, true,
        "≥ 3× healthy",
        "EBITDA (statutory) ÷ interest expense — NOT EBIT ÷ interest, which the credit component below bands on and which is a different number on every levered book",
        (v) =>
          v >= 3
            ? "Earnings comfortably absorb interest load."
            : "Interest taking a meaningful bite of operating profit."),
      row("dscr", "DSCR (interest + ST debt)", "x", dscr,
        { strong: 1.5, healthy: 1.25, watch: 1 }, true,
        "≥ 1.25× covenant-typical",
        "EBITDA (statutory) ÷ (interest expense + short-term debt)",
        (v) =>
          v >= 1.25
            ? "Annual cash service comfortably covered."
            : "Debt service consumes most operating cash."),
      row("adjusted_dscr", "Adjusted DSCR (incl. lease)", "x", adjustedDscr,
        { strong: 1.5, healthy: 1.25, watch: 1 }, true,
        "≥ 1.25× including lease commitments",
        sup.annualLeaseExpense
          ? "(EBITDA + annual lease expense) ÷ (interest expense + short-term debt + annual lease expense)"
          : "(EBITDA + annual lease expense) ÷ (interest expense + short-term debt + annual lease expense) — not computed: no annual lease expense was supplied for this period",
        () => "Adds lease obligation to fixed charges — lender-style view.",
        {
          absenceNote:
            "The annual lease expense is a period charge somebody supplies with the period; " +
            "a finance-lease liability on the balance sheet is a stock and cannot stand in for it. " +
            "This says nothing about whether this company holds leases — supply the annual lease " +
            "charge and the lender-style view computes.",
        }),
      // F2.2 — NEW row: DSCR including LT principal amortization proxy
      // (engine canonical). Different from adjusted_dscr above:
      // numerator is statutory EBITDA, denominator adds LT debt / 8
      // (~10-year amortization proxy) instead of lease expense. Lender-
      // style view of covenant coverage when LT debt is the dominant
      // service component.
      row("dscr_with_lt_principal", "DSCR (incl. LT principal proxy)", "x", dscrWithLtPrincipal,
        { strong: 1.5, healthy: 1.25, watch: 1 }, true,
        "≥ 1.25× with 10-year amortization proxy",
        "EBITDA (statutory) ÷ (interest expense + long-term debt ÷ 8, a ~10-year amortization proxy)",
        (v) =>
          v >= 1.25
            ? "Comfortable coverage of interest + LT principal amortization."
            : "Including LT principal amortization, coverage is tight — refinancing risk."),
    ],
    efficiency: [
      row("dso", "Days Sales Outstanding", "days", dso,
        { strong: 30, healthy: 45, watch: 75 }, false,
        "≤ 45 days healthy",
        `trade receivables ÷ revenue × ${days} days`,
        (v) => `Average ${v.toFixed(0)}-day collection cycle on receivables.`),
      row("dio", "Days Inventory Outstanding", "days", dio,
        { strong: 30, healthy: 60, watch: 100 }, false,
        "≤ 60 days for FMCG · varies by industry",
        `inventory ÷ TOTAL operating expense (COGS + opex + D&A) × ${days} days — not narrow COGS`,
        (v) => `Inventory turns every ${v.toFixed(0)} days.`),
      // ── N2: A DISTRESS VERDICT ON A SCALE THAT HAS NO DISTRESS END ──
      //
      // Measured on the agras export before this repair:
      //
      //     Days Payables Outstanding   27 days   Critical
      //     Higher = better supplier float (within terms)
      //
      // and, four cards later in the same document, the cycle those very
      // payables are a term of:
      //
      //     Cash Conversion Cycle       31 days   Healthy
      //
      // Three things were wrong and only one of them was the number.
      //
      // (1) TC-10. The cutoffs 60/45/30 that produced the word "Critical"
      //     appeared nowhere on the card; the caption was prose carrying
      //     no threshold at all. Now rendered by `ladderSentence` from
      //     the same object `verdictFromBands` reads.
      //
      // (2) THE `watch: 30` RUNG IS GONE, and that is a claim, not a
      //     widening. Settling suppliers in 27 days is paying early. It
      //     costs free supplier credit; it is not insolvency, and no
      //     lender reads it as one. The scale this row measures is
      //     supplier float — an efficiency scale, with a good end and a
      //     less-good end, not a solvency scale with a distress end. A
      //     ladder that omits `watch` now DECLARES that (see
      //     `verdictFromBands`), the sentence prints "no critical rung on
      //     this scale" from the same object, and nothing downstream can
      //     quote a distress cutoff this row does not have. 27 days reads
      //     "watch" — below the benchmark float — which is what it is.
      //
      // (3) The rungs are general-SME defaults calibrated on a COST OF
      //     GOODS SOLD denominator (CLAUDE.md Appendix A §5 states DPO's
      //     benchmark as payables ÷ COGS × 365, 40–70 days) while this
      //     figure divides by TOTAL operating cost, which also carries
      //     payroll and depreciation — neither of which passes through a
      //     trade payable. Measured across the four committed books the
      //     two bases differ by 1.29× to 1.65× (carniprod: 51.5 d on
      //     total operating cost, 85.1 d on cost of goods sold — the
      //     whole width of the benchmark range and out the top). So the
      //     rungs are indicative here, not calibrated, and the row says
      //     so instead of letting a badge imply otherwise.
      //
      // THE LABEL NAMES ITS DENOMINATOR, and that is R1 across surfaces:
      // the insight engine's `trade_float` detector computes DPO on the
      // cost-of-goods-sold basis over a narrower payables base and gets
      // 37.2 days on this same book. Once both blocks render in one
      // document, "DPO 27 days" and "DPO 37.2 days" cannot both be
      // called DPO. Two bases, two names.
      row("dpo", "Days Payables Outstanding (on total operating cost)", "days", dpo,
        { strong: 60, healthy: 45 }, true,
        "supplier float, not a solvency test — paying faster than the benchmark forgoes free credit, so this scale declares no critical rung; the rungs are general-SME defaults measured on cost of goods sold while this figure divides by total operating cost, so read them as indicative",
        `trade payables ÷ TOTAL operating expense (COGS + opex + D&A) × ${days} days — not narrow COGS`,
        (v) => `${v.toFixed(0)}-day average to settle suppliers.`),
      row("ccc", "Cash Conversion Cycle", "days", ccc,
        { strong: 30, healthy: 60, watch: 100 }, false,
        "Lower is better — cash speed",
        "DSO + DIO − DPO",
        (v) => `${v.toFixed(0)}-day gap between cash out and cash in.`),
      row("asset_turnover", "Asset Turnover", "x", assetTurnover,
        { strong: 1.5, healthy: 0.8, watch: 0.4 }, true,
        "≥ 0.8× healthy (industry-dependent)",
        "revenue ÷ total assets",
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
  // The arithmetic, spelled from the reader's own coefficients rather than
  // re-typed here, so a re-weighted model moves the printed formula with
  // the number it produced.
  const formula =
    `6.56 × (working capital ÷ total assets) + 3.26 × (retained earnings ÷ total assets) ` +
    `+ 6.72 × (EBIT ÷ total assets) + 1.05 × (book equity ÷ total liabilities) ` +
    `— ${a.variant} emerging-markets variant, computed by ${credit.model}`;
  if (a.score === null || a.zone === null) {
    return {
      key: ALTMAN_RATIO_KEY,
      label,
      formula,
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
    formula,
    value: a.score,
    unit: "ratio",
    verdict: a.zone === "safe" ? "healthy" : a.zone === "grey" ? "watch" : "critical",
    benchmark,
    commentary: `${credit.components[0]?.read ?? ""} · ${credit.modelLabel}`.trim(),
    // The reader's OWN thresholds — the same two numbers `benchmark`
    // above spells and `a.zone` was decided by, so the distance-to-rung
    // model quotes the model's ladder rather than a second copy of it.
    ladder: {
      bands: { healthy: a.thresholds.safe, watch: a.thresholds.distress },
      higherIsBetter: true,
    },
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

// ── THE ENGINE'S ASSEMBLED KEY SPACES ───────────────────────────────────────
//
// `statements.assembled_bs` / `assembled_pl` / `assembled_cf` are the ENGINE's
// canonical views, and their key space is a DIFFERENT vocabulary from the
// `PeriodFacts` shape the rule registry reads. Every name below is one the
// served envelope really carries; anything else is a lookup that returns
// `undefined` at runtime and reads as a hard-coded fallback forever.
//
// The arrays are the runtime half of the guard —
// `frontend/lib/__tests__/envelopeKeySpace.test.ts` asserts each entry against
// the keys of the four committed firm books, so a name that typechecks but
// does not exist reds a gate instead of silently zeroing a fact. Adding a key
// here is deliberate, which is the point.
export const CANONICAL_BS_KEYS = [
  "ap",
  "ap_dividends",
  "ar_intercompany",
  "ar_net",
  "cash",
  "cash_fx_component",
  "ppe_investment_net",
  "ppe_net",
  "retained_earnings",
  "revaluation_reserves",
  "share_capital",
  "total_debt",
] as const;
export type CanonicalBsKey = (typeof CANONICAL_BS_KEYS)[number];

export const CANONICAL_PL_KEYS = [
  "capitalized_own_work_memo",
  "depreciation",
  "ebit",
  "ebitda_cash",
  "ebitda_statutory",
  "financial_expense",
  "financial_expense_total",
  "financial_income",
  "financial_income_other",
  "fx_gain",
  "fx_loss",
  "interest_expense",
  "net_financial_result",
  "net_income_operational",
  "net_income_reconciliation_to_121",
  "net_income_statutory",
  "operating_ebit",
  "pretax",
  "revenue",
  "tax",
  "total_operating_revenue",
] as const;
export type CanonicalPlKey = (typeof CANONICAL_PL_KEYS)[number];

export const CANONICAL_CF_KEYS = ["capex_real", "cash_from_operating"] as const;
export type CanonicalCfKey = (typeof CANONICAL_CF_KEYS)[number];

// Inline import avoids the periodFacts ↔ financialReport circular
// dependency. detectConditions consumes a PeriodFacts-shaped object;
// we build a minimal one in-place from canonical statement fields when
// they're present, falling back to legacy derivation only as a safety
// net. The function NEVER goes through deriveTotals(s).ebitda directly
// — that's the operational view that produced the 3 false-alarm cards.
import { detectConditions, severityRank } from "./recommendationRules";

/**
 * The industry KEY a profile-gated rule may be scoped on — or null.
 *
 * Two measured defects live behind this one function (both on the four
 * committed books, 2026-09-07):
 *
 *   · `detectConditions` scopes on the key `real_estate_residential`,
 *     while `Statements.industry` is the display label "Real estate ·
 *     residential rental". They never matched, so a correctly-set CRE
 *     workspace never saw a CRE finding.
 *   · Nothing checked the setting against the book, so the setting was
 *     the only vote. `industry_signal.block_sector_content` is the
 *     engine's verdict that the account mix and the setting are in
 *     different families; while that stands, the profile is NOT
 *     established and no rule scoped on one may fire.
 *
 * Returning null makes every `industries:`-scoped rule silent — the
 * unscoped rules, which carry no sector calibration, still fire. Silence
 * about a sector this book may not belong to is the correct output; a
 * confident CRE card on a food factory is not.
 */
function resolveIndustryKey(s: Statements): string | null {
  const signal = readIndustrySignal(s.industry_signal);
  if (blocksSectorContent(signal)) return null;
  const key = signal?.workspace.industry_key;
  return key && key.length > 0 ? key : null;
}

export function generateRecommendations(
  s: Statements,
  // ── THE RATIOS THE DOCUMENT PRINTS, not a second arithmetic ─────────
  //
  // This parameter existed and was ignored (`_ratios`), so the rules ran
  // on a DSCR this function computed for itself:
  //
  //   EBITDA ÷ (interest + max(10% of debt, depreciation))
  //
  // while the Debt Coverage card three pages above printed the engine's
  //
  //   EBITDA ÷ (interest + short-term debt)
  //
  // On agras that is 5.70× in every recommendation against 7.43× in the
  // ratio table — one concept, two values, in one document, and the
  // reader has no way to know which one the covenant advice was written
  // against. Passing the bundle in is not a convenience: it is the only
  // way a recommendation can cite a figure the report also states.
  ratios?: RatioBundle,
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
  // ── THE ENGINE'S KEY SPACE, NAMED, SO A MISS IS A COMPILE ERROR ─────
  //
  // `ab` / `ap` / `ac` were typed `Record<string, number>`, which accepts
  // ANY string. `assembled_bs` and `BSFacts` are two vocabularies for one
  // balance sheet — `ar_intercompany` there is `intercompany_loans` here,
  // `ap` is `suppliers`, `ppe_investment_net` is `investment_property_net`
  // — so a `BSFacts` name typechecked clean and then missed on every
  // lookup, forever, with nothing raised. Measured on the four committed
  // firm books, this line
  //
  //     const intercompany = pick(ab.intercompany_loans, 0);
  //
  // read 0 on every one of them while the envelope carried
  // `ar_intercompany` = 7,692,202.74 on agras — 32.15% of that book's
  // equity — so the rule that grades related-party exposure could not
  // clear its own floor and the printed report never mentioned it.
  // `periodFacts.ts:278` had already met this exact trap and documented
  // it; the repair was never carried across to this entry point.
  //
  // Naming the engine's key space makes the miss a compile error. The
  // runtime arrays are the second half: `envelopeKeySpace.test.ts` asserts
  // every name below is a key the served envelope really carries, so a
  // name that compiles but does not exist reds a gate rather than
  // silently reading `undefined`.
  const abNum = (k: CanonicalBsKey): number | undefined => ab[k];
  const apNum = (k: CanonicalPlKey): number | undefined => ap[k];
  const acNum = (k: CanonicalCfKey): number | undefined => ac[k];
  const pick = (canon: number | undefined, legacy: number): number =>
    typeof canon === "number" ? canon : legacy;
  // Build the minimal PeriodFacts the rule registry reads. We populate
  // every field the rules touch — extra fields they don't read are fine
  // to omit. STATUTORY values come from `assembled_*` when present.
  const ebitdaStatutory = pick(apNum("ebitda_statutory"), t.ebitda);
  const niStatutory = pick(apNum("net_income_statutory"), t.netIncome);
  const cfo = pick(acNum("cash_from_operating"), niStatutory + pick(apNum("depreciation"), s.incomeStatement.depreciationAmortization));
  const capexReal = pick(acNum("capex_real"), -(apNum("capitalized_own_work_memo") ?? 0));
  const bankDebt = pick(abNum("total_debt"), t.totalDebt);
  const totalAssets = sf.totalAssets();
  const totalEquity = sf.totalEquity();
  const cash = pick(abNum("cash"), s.balanceSheet.cash);
  const cashFx = pick(abNum("cash_fx_component"), 0);
  const apDividends = pick(abNum("ap_dividends"), 0);
  // THE KEY THE ENGINE ACTUALLY SERVES. `ab.intercompany_loans` is the
  // `BSFacts` spelling and exists in no envelope; `ar_intercompany` is
  // the one that does. Same field, same concept, same number as
  // `periodFacts.ts:396` — so the screen and the printed document grade
  // one exposure once.
  const intercompany = pick(abNum("ar_intercompany"), 0);
  // ONE CONCEPT, TWO VALUES ACROSS SURFACES - FLAGGED, NOT FIXED HERE.
  //
  // `investment_property_net` is fed the WHOLE property, plant and
  // equipment book. The engine serves investment property as its own
  // bucket, `ppe_investment_net`, and that bucket is 0.00 on all four
  // committed firm books - the `realestate` book carries its property in
  // 211 (land, 10,876,204.38) and 212 (buildings, 1,466,658.75) with no
  // account 215 at all. `periodFacts.ts:397` reads the investment bucket
  // and therefore answers 0.00 for the same field on the same book, so
  // the SCREEN and the PRINTED EXPORT disagree about what this company's
  // investment property is by 6,613,498.11.
  //
  // Redirecting this read to `ppe_investment_net` was tried and reverted:
  // `recommendationRules.property_tax_reassessment_provision` reads
  // `f.bs.investment_property_net` against a 5,000,000 floor, so the
  // redirect silences the only CRE-scoped card that fires on the
  // committed corpus and takes `industryBlockExport.test.ts`'s
  // non-vacuity proof with it. The rule's own condition is about a
  // property BOOK a Romanian municipality can revalue - which does not
  // depend on whether the accountant booked it to 212 or 215 - so the
  // repair belongs in the rule (read `ppe_net`, rename the cited fact),
  // and `recommendationRules.ts` is not this lane's to edit.
  const investmentProp = pick(abNum("ppe_net"), s.balanceSheet.propertyPlantEquipment);
  const ppeNet = investmentProp;
  const interest = pick(apNum("interest_expense"), s.incomeStatement.interestExpense);
  const depreciation = pick(apNum("depreciation"), s.incomeStatement.depreciationAmortization);
  const tax = pick(apNum("tax"), s.incomeStatement.taxExpense);
  const rentalRevenue = pick(apNum("revenue"), s.incomeStatement.revenue);
  const capitalized = pick(apNum("capitalized_own_work_memo"), 0);
  // APPROXIMATION — annual principal estimated at 10% of debt (a trial
  // balance carries no amortization schedule). Legacy fallback path only;
  // engine periodFacts carry the real figure when available.
  const principalProxy = bankDebt * 0.1;
  const dscr = ebitdaStatutory > 0
    ? ebitdaStatutory / Math.max(interest + Math.max(principalProxy, depreciation), 1)
    : 0;
  const dteAdj = bankDebt > 0 && ebitdaStatutory > 0
    ? bankDebt / (ebitdaStatutory + pick(apNum("financial_income_other"), 0))
    : 0;
  /** The value the DOCUMENT states for a ratio, or null when it refuses
   *  to state one. A rule reading null keeps its absent-ratio discipline
   *  (`has()` / `fx()` in recommendationRules) and prints "not reported"
   *  instead of inventing a figure the report does not carry.
   *
   *  ── AN UNGRADED ROW IS NULL HERE, AND THAT IS NOT THE SAME AS THE
   *     ROW HIDING IT ────────────────────────────────────────────────
   *  A row banded `ungraded` prints its FIGURE and withholds its VERDICT,
   *  because the figure is a true statement about the book and the ladder
   *  is not a scale it sits on (a negative denominator, or a disputed
   *  sector). A RULE, though, reads these as quantities with a meaning —
   *  `debt_to_ebitda` means "years of EBITDA to repay", and −0.64 is not
   *  a number of years. `periodFacts.ts:545` already answers null in
   *  exactly that case; this makes the export's fact feed agree with it,
   *  so one exposure is not graded twice by two surfaces. */
  const stated = (key: string): number | null => {
    if (!ratios) return null;
    const found = [
      ratios.liquidity,
      ratios.profitability,
      ratios.leverage,
      ratios.coverage,
      ratios.efficiency,
    ]
      .flat()
      .find((x) => x.key === key);
    if (found === undefined || found.verdict === "ungraded") return null;
    return found.value;
  };
  /** `Ratio` emits percentages as 0-100; `PeriodFacts.ratios` carries
   *  them as decimals. One conversion, at the boundary. */
  const statedFraction = (key: string): number | null => {
    const v = stated(key);
    return v === null ? null : v / 100;
  };

  const safeFacts = {
    period_id: "legacy",
    entity: s.companyName ?? "Entity",
    // THE KEY, OR NOTHING. `detectConditions` scopes on the key
    // (`real_estate_residential`); `s.industry` is the display label
    // ("Real estate · residential rental"), so the two never matched —
    // a correctly-set CRE workspace lost its CRE findings. And when the
    // account mix disagrees with the setting, the profile is not
    // established, so every scoped rule stays silent. See
    // `resolveIndustryKey`.
    industry: resolveIndustryKey(s),
    currency: s.currency,
    computed_at: new Date().toISOString(),
    pipeline_version: "legacy",
    pl: {
      rental_revenue: rentalRevenue,
      capitalized_own_work_memo: capitalized,
      revenue: pick(apNum("total_operating_revenue"), rentalRevenue + capitalized),
      ebitda: ebitdaStatutory,
      ebitda_excl_capitalized: ebitdaStatutory - capitalized,
      depreciation,
      ebit: pick(apNum("operating_ebit"), ebitdaStatutory - depreciation),
      interest_expense: interest,
      // 7651 − 6651, the same difference `periodFacts.ts:268` builds out
      // of line items. The envelope carries both legs, so the printed
      // report no longer tells the rules this book has no FX movement:
      // on agras that zero stood in front of +157,000.88 / −65,946.65.
      fx_result: pick(apNum("fx_gain"), 0) - pick(apNum("fx_loss"), 0),
      dividend_income: pick(apNum("financial_income_other"), 0),
      // WAS `0` ON EVERY BOOK while the envelope served the figure —
      // agras +112,507.14, realestate −1,290,360.82, retail +2,418,632.79.
      // A rule reading it could not tell "this company earns and pays
      // nothing below the operating line" from "nobody plumbed the field",
      // which is why `recommendationRules.belowOperatingLine` had to
      // bracket the same span out of two other operands.
      net_financial_result: pick(apNum("net_financial_result"), 0),
      profit_before_tax: pick(apNum("pretax"), ebitdaStatutory - depreciation - interest),
      tax,
      net_profit: niStatutory,
    },
    bs: {
      cash,
      cash_fx_component: cashFx,
      ar_net: pick(abNum("ar_net"), s.balanceSheet.accountsReceivable),
      intercompany_loans: intercompany,
      prepayments: 0,
      current_assets: sf.currentAssets(),
      investment_property_net: investmentProp,
      ppe_net: ppeNet,
      non_current_assets: sf.nonCurrentAssets(),
      total_assets: totalAssets,
      suppliers: pick(abNum("ap"), s.balanceSheet.accountsPayable),
      dividends_payable: apDividends,
      bank_debt_total: bankDebt,
      short_term_liabilities: sf.currentLiabilities(),
      total_liabilities: sf.totalLiabilities(),
      share_capital: pick(abNum("share_capital"), s.balanceSheet.shareCapital),
      revaluation_reserves: pick(abNum("revaluation_reserves"), 0),
      retained_earnings: pick(abNum("retained_earnings"), s.balanceSheet.retainedEarnings),
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
    // ── THE ONE BLOCK THAT STAYS ON THE LOCAL PROXY, AND WHY ──────────
    //
    // The census above wired every fact the envelope carries the exact
    // concept for. `assembled_cf` carries all four of these
    // (`cash_used_in_financing` −3,968,831.97 on agras,
    // `net_change_in_cash` +5,987,892.24, `closing_cash_actual`
    // 1,168,047.04) — and they are NOT measurements. The block declares
    // itself: `is_approximated: true`, with `approximation_notes` saying
    // working-capital movements are "estimated at 5% of current balances"
    // and financing detail is "approximated from typical Romanian payout
    // ratios". Reading opening cash back out of them (closing − net
    // change) yields RON −4,819,845 on agras — a negative cash balance,
    // which is an artefact of the estimate, not a fact about the company.
    //
    // So these four keep the local proxy, `periodFacts.ts:428` keeps the
    // same one, and no rule reads any of them today. Wiring an
    // approximation into a fact feed under a name that reads as measured
    // would be the same defect as the zeros above, pointing the other way.
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
      // Every ratio a rule reads comes from the bundle the document
      // renders, so a figure quoted in a recommendation is the figure the
      // ratio table states. The local arithmetic below each `??` is the
      // legacy fallback for a caller that passes no bundle — and it is
      // the arithmetic that produced the 5.70× / 7.43× split.
      //
      // ── `?? 0` WAS THE SAME DEFECT AS `intercompany_loans` ──────────
      //
      // Every field of `RatioFacts` is `number | null` and every rule
      // guards with `has()`, precisely so a ratio the document REFUSED
      // reaches them as an absence. These `?? 0`s converted each refusal
      // into a confident zero on the way in: a refused `cash_ratio`
      // arrived as "this company holds no cash against its current
      // liabilities", a refused `debt_to_ebitda` as "this company has no
      // leverage" — the reading `periodFacts.ts:545` spells out as the
      // opposite of what a loss-making book means. The trailing zero is
      // gone; where a genuine legacy-path arithmetic exists it stays.
      current_ratio: stated("current_ratio"),
      quick_ratio: stated("quick_ratio"),
      cash_ratio: stated("cash_ratio"),
      debt_to_equity: stated("debt_to_equity"),
      debt_to_assets: statedFraction("ltv"),
      equity_ratio: statedFraction("equity_ratio"),
      // NOT PLUMBED, AND SAID SO. The document prints interest coverage
      // on an EBITDA basis; the EBIT basis is a different number on every
      // levered book (55.64× against 66.28× on agras) and no row states
      // it, so there is nothing here for a rule to quote.
      interest_coverage_ebit: null,
      ebitda_to_interest:
        stated("interest_coverage") ?? (interest > 0 ? ebitdaStatutory / interest : null),
      dscr: stated("dscr") ?? (ebitdaStatutory > 0 ? dscr : null),
      debt_to_ebitda:
        stated("debt_to_ebitda") ?? (ebitdaStatutory > 0 ? bankDebt / ebitdaStatutory : null),
      // `debt_to_ebitda_adjusted` adds participation dividends to the
      // denominator, a concept the document does not state as a row. It
      // equals `debt_to_ebitda` exactly whenever that income is zero
      // (all four firm books), and where it is not, it is the one figure
      // a recommendation cites that the report does not print — flagged,
      // not silently reconciled.
      debt_to_ebitda_adjusted:
        pick(apNum("financial_income_other"), 0) === 0
          ? stated("debt_to_ebitda") ?? (ebitdaStatutory > 0 ? dteAdj : null)
          : (ebitdaStatutory > 0 ? dteAdj : null),
      // Two margin bases this document does not print as rows. A rule
      // that wants one has to say so and get it plumbed; until then the
      // honest answer is that nobody measured it here, not that it is 0%.
      ebitda_margin_gross: null, ebitda_margin_clean: null,
      net_margin: statedFraction("net_margin"),
      roe: statedFraction("roe"),
      roa: statedFraction("roa"),
      property_yield: null,
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
    // ── "NO RULE FIRED" IS NOT "NOTHING IS WRONG" ─────────────────────
    //
    // This placeholder said "Financials are in healthy range across all
    // dimensions / No critical or high-priority items detected." on ANY
    // book where the registry happened to match nothing. Measured on the
    // committed `carniprod` export, 2026-09-07, it printed that sentence
    // in a document whose own ratio cards read Net Margin 1.4% CRITICAL,
    // ROA 1.1% CRITICAL, ROE 1.3% CRITICAL and ROIC 4.6% CRITICAL — the
    // card contradicted four cards on its own page, which is D2's defect
    // one section lower.
    //
    // The registry is a finite list of rules. When none matches a book
    // that is grading badly, the honest statement is about the REGISTRY,
    // not about the company — and it names what it did not cover, so a
    // reader is sent to the cards rather than reassured past them.
    const flat = ratios
      ? [ratios.liquidity, ratios.profitability, ratios.leverage, ratios.coverage, ratios.efficiency].flat()
      : [];
    const uncovered = flat.filter((x) => x.verdict === "critical" || x.verdict === "watch");
    const worst = uncovered.filter((x) => x.verdict === "critical");
    if (uncovered.length === 0) {
      out.push({
        id: "all_healthy",
        priority: "info",
        title: "Financials are in healthy range across all dimensions",
        rationale: `No rule in the registry fired, and none of the ${flat.filter((x) => x.verdict !== "unknown" && x.verdict !== "ungraded").length} graded ratios in this document reads below healthy.`,
        action:
          "Maintain current discipline. Consider strategic capital deployment: growth investment, dividend, or buyback.",
      });
    } else {
      out.push({
        id: "no_rule_fired",
        priority: worst.length > 0 ? "high" : "info",
        title:
          worst.length > 0
            ? `No recommendation covers the ${worst.length} ratio${worst.length === 1 ? "" : "s"} grading critical on this page`
            : `No recommendation covers the ${uncovered.length} ratio${uncovered.length === 1 ? "" : "s"} asking for attention on this page`,
        rationale:
          `The rule registry matched nothing on this book. That is a statement about the ` +
          `registry, not about the company: ${uncovered
            .map((x) => `${x.label} ${formatRatio(x)} ${verdictLabel(x.verdict).toLowerCase()}`)
            .join("; ")}.`,
        action:
          "Read those cards directly — each states its own ladder and the accounts behind it. " +
          "If this pattern recurs, the registry is missing a rule for it.",
      });
    }
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
    case "ungraded":
      // Neutral, not red. A ratio nobody could compute is not a bad
      // ratio, and neither is one whose ladder was withheld; colouring
      // either like one is the grading defect in another costume.
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
          : v === "ungraded"
            ? "Not graded"
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
/**
 * THE CHARTS, BUILT ONCE — for the document AND for the workbook.
 *
 * R7 asks that the same figure read the same in every format. The only
 * way to mean that is for the formats to share the construction, not to
 * be compared afterwards and patched when they differ: two builders that
 * agree today are two builders, and one of them will be edited alone.
 * `renderReportHtml` and `buildExcelWorkbook` both call this, so a chart
 * row's `printed` string is one string in both files.
 */
export function reportChartBlocks(
  s: Statements,
  credit: CreditScoreResult,
  metricsByName?: Record<string, number | null>,
): ChartBlock[] {
  const ratios = computeRatios(s, undefined, metricsByName);
  const signal = readIndustrySignal(s.industry_signal);
  return allChartBlocks({
    s,
    ratios,
    credit,
    money: (v) => money(v, s.currency),
    sectorBlocked: blocksSectorContent(signal),
  });
}

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
  // ── ONE RATIO, ONE PRINTING ─────────────────────────────────────────
  // The executive strip used to build its own margin strings with
  // `(safeDiv(a, b) * 100).toFixed(1)` while §Profitability rendered the
  // SAME concept through `formatRatio` off the engine's metric. Two
  // arithmetics and two rounding paths for one number: on agras the
  // strip printed "6.4% margin" beside a Net Margin card reading "6.3%",
  // three pages apart in one document. The strip now reads the ratio
  // objects the ratio cards render, so a divergence is not expressible.
  const ratioNamed = (key: string): Ratio | undefined =>
    [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency]
      .flat()
      .find((x) => x.key === key);
  const printedRatio = (key: string): string => {
    const rt = ratioNamed(key);
    return rt === undefined ? UNREPORTED_WORD : formatRatio(rt);
  };
  const recs = generateRecommendations(s, r);
  // THE ONE ALTMAN, and the letter that travels with it.
  const altman = altmanRatio(credit);

  // ── THE INDUSTRY LINE ───────────────────────────────────────────────
  // This header printed `Industry: <workspace setting>` as a plain fact.
  // On the Agras Dec-2025 export that read "Real estate · residential
  // rental" over a trial balance carrying 301 raw materials, 341/345
  // own-produced stock and 70.5M of cost of sales. The setting is a user
  // choice; the engine now reads the account mix as a second opinion and
  // serves its verdict. When the two are in different families the line
  // stops asserting the setting and states the disagreement instead —
  // naming BOTH, so a reader can settle it. Nothing else in this
  // document is recalculated: the withheld part is the profile-gated
  // recommendations, which go silent through `resolveIndustryKey`.
  const industrySignal = readIndustrySignal(s.industry_signal);
  const industryDisputed = blocksSectorContent(industrySignal);
  const industryHeaderClause = industryDisputed
    ? ` &nbsp;·&nbsp; Industry: <strong>unconfirmed</strong>`
    : s.industry
      ? ` &nbsp;·&nbsp; Industry: ${escapeHtml(s.industry)}`
      : "";
  const industryDisputeNote = industryDisputed && industrySignal
    ? `<p>The account mix looks like ${escapeHtml(industrySignal.display ?? "")}; this workspace is set to ${escapeHtml(industrySignal.workspace.display ?? "")} — confirm which is right. Until then no sector benchmark, and no recommendation scoped to a sector, is included below; every figure that does not depend on the sector is unchanged.</p>`
    : "";

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
  // Same typed key space as `generateRecommendations` — see
  // `CANONICAL_PL_KEYS`. A name outside it is a compile error here too,
  // so the renderer cannot acquire the miss the fact feed just lost.
  const apNum = (k: CanonicalPlKey): number | undefined => ap[k];
  const pick = (canon: number | undefined, legacy: number): number =>
    typeof canon === "number" ? canon : legacy;

  // ── ABSENT IS NOT ZERO, AND THIS BLOCK USED TO SAY IT WAS ───────────
  //
  // `provenance-census` counted a FOURTH absent-to-zero substitution in
  // this file against a declared 3 and a ceiling that only falls. It was
  // right, and the fabrications were here: three legacy fallbacks written
  // `s.incomeStatement.<field> ?? 0`.
  //
  // They fire in exactly one situation — the canonical `assembled_pl` key
  // is absent AND the statement field is absent — which is to say, when
  // the source told us NOTHING about that line. On a current book the
  // canonical key is always there, so this never fired in the four
  // committed fixtures and nothing caught it. On an older payload it
  // would have printed "Financial income RON 0" and "Capitalized own work
  // RON 0", which are claims: they say the company earned no financial
  // income and capitalised no work. The truth was that the source did not
  // report it, and `money()` already knows how to say that — it returns
  // "not reported" for null.
  //
  // So the fallbacks now yield NULL and the refusal propagates through the
  // arithmetic. A subtotal built on an unreported component is itself
  // unreported; it does not quietly become the sum of the parts that
  // happened to be present.
  const pickOrNull = (
    canon: number | undefined,
    legacy: number | null | undefined,
  ): number | null =>
    typeof canon === "number" ? canon : (typeof legacy === "number" ? legacy : null);
  /** Null-propagating arithmetic: any absent operand makes the result absent. */
  const nsum = (...xs: Array<number | null>): number | null =>
    xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0);
  const nneg = (x: number | null): number | null => (x === null ? null : -x);

  const capOwnWork = pickOrNull(
    apNum("capitalized_own_work_memo"),
    s.incomeStatement.capitalizedOwnWork,
  );
  const operatingRevenue = pickOrNull(
    apNum("total_operating_revenue"),
    // Revenue itself is always present; only the 722 memo can be absent,
    // and for the OPERATING REVENUE SUBTOTAL "none reported" is materially
    // different from "none". Refuse rather than cast the gap away.
    nsum(s.incomeStatement.revenue, capOwnWork),
  );
  const ebitdaStatutory = pick(apNum("ebitda_statutory"), t.ebitda);
  const ebitdaCash = pick(apNum("ebitda_cash"), t.ebitda);
  const netIncomeStatutory = pick(apNum("net_income_statutory"), t.netIncome);
  // ── EBIT: THE ONE THAT FOOTS ────────────────────────────────────────
  // `operating_ebit` and `ebit` are two served figures and they are not
  // the same number: on the retail book they differ by the discounts
  // received (767) the engine folds into the operating view —
  // −1,254,751.03 against −1,256,674.81, 1,923.78 apart. Only `ebit` is
  // `ebitda_statutory − depreciation`, and only `ebit + net_financial
  // _result` reaches `pretax`. Printing `operating_ebit` in a column
  // whose neighbours are built from `ebit` is one concept wearing two
  // values two rows apart; G3 (exportPlFoots) reds on it.
  const ebitStatutory = pick(apNum("ebit"), ebitdaStatutory - s.incomeStatement.depreciationAmortization);
  // The financial block, in full. The table used to step EBIT → PBT
  // through interest expense ALONE, so the printed column missed
  // financial income and the non-interest financial expense the same
  // envelope carries, and PBT did not foot on any of the four books.
  const financialIncome = pickOrNull(
    apNum("financial_income"),
    s.incomeStatement.financialIncome,
  );
  const interestExpense = pick(apNum("interest_expense"), s.incomeStatement.interestExpense);
  // `financial_expense` is the NON-interest half (`financial_expense_total`
  // = interest + this, verified on all four books). A source that carries
  // only the total gives the remainder; one that carries neither gives 0.
  const otherFinancialExpense = pickOrNull(
    apNum("financial_expense"),
    typeof apNum("financial_expense_total") === "number"
      ? (apNum("financial_expense_total") as number) - interestExpense
      : s.incomeStatement.financialExpense,
  );
  const pretaxStatutory = pickOrNull(
    apNum("pretax"),
    nsum(ebitStatutory, financialIncome, -interestExpense, nneg(otherFinancialExpense)),
  );
  // ── THE RECONSTRUCTION, AND THE BRIDGE TO WHAT WAS FILED ────────────
  // `pretax − tax` is the class-6/7 RECONSTRUCTION. The figure the memo
  // ends on is account 121 — what the company filed. On three of the four
  // firm books they differ, by 2.0M to 29.6M, and the reconciling amount
  // is SERVED (`net_income_reconciliation_to_121`). It was the row that
  // was missing, never the number.
  const reconstructedNetIncome = pickOrNull(
    apNum("net_income_operational"),
    nsum(pretaxStatutory, -s.incomeStatement.taxExpense),
  );
  const bridgeTo121 = pickOrNull(
    apNum("net_income_reconciliation_to_121"),
    nsum(netIncomeStatutory, nneg(reconstructedNetIncome)),
  );
  // A bridge that cannot be computed is not a bridge of zero. Both of
  // these now read false when the input is absent, so the report omits
  // the row rather than asserting "no reconciling difference" or "no
  // capitalised own work" on a source that never said.
  const hasBridge = bridgeTo121 !== null && Math.abs(bridgeTo121) > 0.005;
  const has722 = capOwnWork !== null && Math.abs(capOwnWork) > 1;

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
    /* THE ARITHMETIC, printed under the figure it produced. A ratio a
       reader cannot check is a claim, not a measurement. */
    .ratio-card .formula {
      font-size: 8pt;
      color: var(--ink-mute);
      margin-top: 4px;
      line-height: 1.4;
      font-style: italic;
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

    /* ── FINDINGS ──────────────────────────────────────────────────────
       One card per finding, and every card carries the four things that
       make it checkable: the level WITH the basis it was scaled against,
       the claim, the arithmetic in words, and the accounts that fed it.
       No fill, no colour-coded panel — the severity chip is the only
       tinted element, and it borrows the badge palette already defined
       above so a high finding and a critical ratio do not disagree
       about what red means. */
    .insight-card {
      border-top: 1px solid var(--rule);
      padding: 12px 0 6px;
      margin: 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .insight-card + .insight-card { margin-top: 4px; }
    .insight-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin: 0 0 6px;
    }
    .insight-rank {
      font-family: var(--sans);
      font-size: 8.5pt;
      color: var(--ink-mute);
      font-variant-numeric: tabular-nums lining-nums;
    }
    .insight-title {
      font-family: var(--serif);
      font-size: 11.5pt;
      font-weight: 600;
      color: var(--ink);
      margin: 0;
    }
    .insight-severity {
      font-family: var(--sans);
      font-size: 8pt;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 7px;
      border: 1px solid var(--rule);
      color: var(--ink-soft);
      white-space: nowrap;
    }
    /* ⚠ THE CHIP DOES NOT BORROW .badge.v-* . The first draft mapped an
       insight graded high onto v-watch — which in this stylesheet is
       byte-identical to v-healthy, the calm teal. Five findings the
       engine had graded HIGH would have printed in the same colour the
       document uses for "this is fine". Attention (critical and high)
       and context (medium, low, info) get two states, and the LEVEL IS
       ALWAYS SPELLED OUT in the chip text besides, so the colour is
       never the only thing carrying it. */
    .insight-severity[data-level="critical"],
    .insight-severity[data-level="high"] {
      background: #F4E8E8; /* design-lint-allow-hex standalone generated report doc */
      color: #7A1F1F; /* design-lint-allow-hex standalone generated report doc */
      border-color: #C7A6A6; /* design-lint-allow-hex standalone generated report doc */
    }
    .insight-severity[data-level="critical"] { font-weight: 700; }
    .insight-claim {
      font-family: var(--serif);
      font-size: 10.5pt;
      line-height: 1.5;
      color: var(--ink);
      margin: 4px 0 8px;
    }
    .insight-formula,
    .insight-basis,
    .insight-explanation,
    .insight-so-what,
    .insight-narrative-source {
      font-size: 9.25pt;
      line-height: 1.5;
      color: var(--ink-soft);
      margin: 4px 0;
    }
    .insight-formula { font-family: var(--mono, var(--sans)); }
    .insight-card table.fin { margin: 8px 0 10px; font-size: 9pt; }
    .insight-card table.fin th { font-size: 8pt; }
    .insight-cols {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 18px;
      align-items: start;
    }
    table.fin tr.measure-clash td {
      font-size: 8.5pt;
      color: var(--ink-soft);
      background: var(--bg-soft);
      line-height: 1.45;
    }
    .insight-ladder td.active {
      font-weight: 600;
      color: var(--ink);
    }
    .insight-not-fired { margin-top: 14px; }
    .insight-not-fired ul { margin: 6px 0 0; padding-left: 16px; }
    .insight-not-fired li {
      font-size: 9.25pt;
      color: var(--ink-soft);
      margin: 3px 0;
      line-height: 1.45;
    }
    /* The variance strip on page one: values the document already prints,
       and — on every book this product serves today — the STATED absence
       of anything to compare them against. */
    .comparatives-note {
      font-size: 9.5pt;
      color: var(--ink-soft);
      line-height: 1.5;
      margin: 6px 0 10px;
    }
    table.fin td.nocmp {
      color: var(--ink-mute);
      font-style: italic;
      text-align: right;
    }
    .verdict-facts { margin: 8px 0 14px; }
    ul.summary-insights { margin: 6px 0 14px; padding-left: 0; list-style: none; }
    ul.summary-insights li {
      font-size: 9.75pt;
      line-height: 1.5;
      color: var(--ink-soft);
      margin: 6px 0;
      padding-left: 0;
      border-left: 2px solid var(--rule);
      padding: 4px 0 4px 10px;
      break-inside: avoid;
    }
    ul.summary-insights li strong { color: var(--ink); }
    table.fin tr.active-rung td { background: var(--bg-soft); }

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
    /* A MEMO stands beside the column and is never added into it. The
       class is what tells a reader — and the footing gate — which rows
       are steps; italic + muted is how the page says the same thing. */
    table.fin tr.memo td {
      font-style: italic;
      color: var(--ink-mute);
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
    ${chartCss()}
    ${shellCss()}
  `;

  const today = new Date().toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // ── THE TOP LINE READS THE WHOLE PAGE, NOT ONE THIRD OF IT ──────────
  //
  // `overallVerdict` counted RECOMMENDATION PRIORITIES and nothing else,
  // so it could be talked out of a warning by a change to the rule
  // registry alone. Measured on the agras export, HEAD vs the working
  // tree of 2026-09-07 — demoting one debt card PROMOTED the top line:
  //
  //   HEAD          "Generally healthy with 1 priority area to strengthen."
  //   working tree  "Financials in healthy range across all dimensions."
  //
  // on a document that also prints Cash Ratio 0.09× CRITICAL, Quick
  // Ratio Watch, Net Margin Watch, DPO Watch, and "Letter grade: not
  // reported". `carniprod` printed the same all-clear over Net Margin
  // 1.4% CRITICAL, ROA 1.1% CRITICAL, ROE 1.3% CRITICAL and ROIC 4.6%
  // CRITICAL. An all-clear contradicted four cards down its own page is
  // not a summary of the page; it is a summary of one section of it.
  //
  // So the verdict now reads the three things this document actually
  // grades — the ratio badges, the insight severities and the
  // recommendation priorities — and NAMES what drove it, so a reader can
  // check the sentence against the cards rather than trust it. The
  // all-clear states what was scanned to earn it, which is what makes it
  // falsifiable: `execVerdictNoContradiction.test.ts` reds, naming the
  // contradicting card, if any of the three grades below healthy while
  // this line reads clear.
  //
  // `readInsights` is the same pure reader `insightsBlock` calls below on
  // the same `s`; two calls cannot disagree. It is read here because the
  // verdict is composed before that block is built.
  const verdictInsights = readInsights(s);
  const allRatios: Ratio[] = [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency]
    .flat()
    .concat([altman]);
  /** Everything on this page that grades below healthy, worst first, each
   *  named the way the card that carries it is named. */
  const gradedBelowHealthy = (
    level: "critical" | "attention",
  ): string[] => {
    const ratioHit = level === "critical" ? "critical" : "watch";
    const insightHit =
      level === "critical" ? ["critical"] : ["high", "medium"];
    const recHit = level === "critical" ? "critical" : "high";
    return [
      ...allRatios.filter((x) => x.verdict === ratioHit).map((x) => x.label),
      ...(verdictInsights?.insights ?? [])
        .filter((i) => insightHit.includes(i.severity.level))
        .map((i) => i.title),
      ...recs.filter((x) => x.priority === recHit).map((x) => x.title),
    ];
  };
  /** At most four names, then a count — a cover line, not an inventory. */
  const nameList = (names: string[]): string => {
    if (names.length <= 4) return names.join("; ");
    return `${names.slice(0, 4).join("; ")}; and ${names.length - 4} more`;
  };
  const verdictCritical = gradedBelowHealthy("critical");
  const verdictAttention = gradedBelowHealthy("attention");
  /** The denominator of the claim — how many things this line looked at.
   *  Without it "4 items grade critical" is a bare count, and a reader
   *  cannot tell a book with 4 of 23 from one with 4 of 5. */
  const verdictScanned =
    allRatios.filter((x) => x.verdict !== "unknown" && x.verdict !== "ungraded").length +
    (verdictInsights?.insights ?? []).length +
    recs.filter((x) => x.priority !== "info").length;
  const overallVerdict =
    verdictCritical.length > 0
      ? `Action required — ${verdictCritical.length} of ${verdictScanned} graded items in this document ${
          verdictCritical.length === 1 ? "reads" : "read"
        } critical: ${nameList(verdictCritical)}.`
      : verdictAttention.length > 0
        ? `No item reads critical; ${verdictAttention.length} of ${verdictScanned} ask for attention: ${nameList(
            verdictAttention,
          )}.`
        : `Financials in healthy range across all dimensions — all ${verdictScanned} graded items in this document read healthy or strong.`;

  // ─ Per-section renderers ──────────────────────────────────────────────────
  // Verdict is rendered via scoped `.badge.v-<verdict>` class (CSS-driven)
  // rather than the shared `verdictColor()` palette — keeps the report's
  // restrained institutional tones independent of the live UI's colours.
  // THE BAND POSITION, ON THE CARD. A verdict word says which bucket a
  // ratio fell in and stops there; the chip below says how far into it.
  // Same served bands, same construction (`zonesForKey`) as the full
  // track in §Leverage, so the card and the track cannot place one ratio
  // in two places. No numerals in it — the figure is already the biggest
  // thing on the card.
  //
  // ⚠ THE CHIP IS BUILT FROM THE ROW'S OWN LADDER, NOT FROM A SECOND
  // COPY OF THE BANDS. It used to be built from `assembled_bands` while
  // the badge two lines above it was banded from `Ratio.ladder`, and the
  // two objects are not in the same units for a percentage ratio: the
  // engine serves `net_margin.healthy = 0.08` (a fraction) and the row
  // bands a value of `6.35` (a percent). Measured on the rendered export,
  // 2026-09-07, fourteen cards across the four books drew a chip that
  // contradicted the badge printed directly above it —
  //
  //   retail   EBITDA Margin  0.28%   badge Critical   chip drawn in the STRONG zone
  //   agras    Net Margin     6.35%   badge Watch      chip drawn in the STRONG zone
  //
  // — because every percent sails past a ladder written in fractions.
  // Two more (`ccc`, `asset_turnover`) disagreed on the rungs themselves
  // rather than on the units. Feeding `zonesForKey` the row's OWN ladder
  // makes card and badge the same object by construction, which is the
  // only form of this fix that cannot come apart again.
  //
  // A row with NO LADDER (refused, sector-withheld) draws no chip, and
  // neither does one whose ladder declares no critical rung: the track's
  // zone vocabulary always names a critical zone, and drawing one for a
  // scale that cannot award it is the same contradiction in the other
  // direction.
  const servedBandsForCards = readBands(s);
  const cardTrack = (rt: Ratio): string => {
    if (!servedBandsForCards) return "";
    if (industryDisputed && servedBandsForCards.source !== null && servedBandsForCards.source !== "general_sme_fallback") return "";
    if (!rt.ladder || rt.ladder.bands.watch === undefined) return "";
    const ownLadder: ServedBands = {
      bands: {
        [rt.key]: {
          direction: rt.ladder.higherIsBetter ? "higher" : "lower",
          watch: rt.ladder.bands.watch,
          healthy: rt.ladder.bands.healthy,
          strong: rt.ladder.bands.strong,
        },
      },
      source: servedBandsForCards.source,
      disclosure: servedBandsForCards.disclosure,
    };
    const built = zonesForKey(ownLadder, rt.key, rt.value);
    if (!built) return "";
    return miniTrack(`band-${rt.key}`, built.zones, rt.value, rt.verdict === "critical", rt.label).replace(
      'class="chart"',
      'class="chart mini"',
    );
  };

  const ratioCard = (rt: Ratio): string => `
      <div class="ratio-card">
        <div class="label">${escapeHtml(rt.label)}</div>
        <div class="value${rt.value === null ? " unreported" : ""}" ${provAttrs({
          label: rt.label,
          value: formatRatio(rt),
          formula: rt.formula,
          method: rt.value === null ? rt.commentary : rt.benchmark,
          snapshot: `${s.companyName} · ${s.periodLabel}`,
        })}>${escapeHtml(formatRatio(rt))}</div>
        <div class="meta">
          <span class="badge v-${rt.verdict}">${escapeHtml(verdictLabel(rt.verdict))}</span>
          &nbsp;${escapeHtml(rt.value === null ? rt.commentary : rt.benchmark)}
        </div>
        ${cardTrack(rt)}
        <div class="formula" data-ratio-formula="${escapeHtml(rt.key)}">${escapeHtml(rt.formula)}</div>
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

  // ── THE FINDINGS, PRINTED ───────────────────────────────────────────
  //
  // `src/engine/insights/` has run eight detectors over this book since
  // the wire landed, and `statements.insights` has been on the served
  // envelope since then. NOTHING RENDERED IT: `insights.ts` was imported
  // by `executiveSummary.ts` and `recommendationRules.ts` and by no
  // renderer at all, so this document was byte-identical with and
  // without the block — 133,472 bytes either way on agras, measured on
  // 2026-09-07 — while printing "Financials in healthy range across all
  // dimensions" over a book the engine had graded five findings `high`.
  //
  // THE RULES THIS SECTION IS BUILT UNDER:
  //   · an ABSENT block renders NOTHING. Not an empty section, not a "no
  //     findings" line — a period served before the engine emitted the
  //     block was never read, and a clean bill of health is a claim.
  //   · `formatMeasure` is the only formatter, and it prints `null` as
  //     "not reported". There is no `?? 0` anywhere below.
  //   · the severity chip prints its BASIS beside the level. "High"
  //     alone is a bare threshold claim — high against what?
  //   · every card shows the accounts it read WITH their balances, and
  //     the ladder it was banded against (TC-10: the cutoffs render from
  //     the same table the verdict used, never as prose).
  //   · the ranking is `src/engine/insights/rank.py`'s, consumed in the
  //     order the block arrives in. This renderer never re-sorts.
  const insightsBlock: InsightsBlock | null = readInsights(s);
  const insightCurrency = insightsBlock?.currency || s.currency;

  // ── ONE NAME, TWO VALUES — NOW THAT BOTH SURFACES ARE IN ONE FILE ───
  //
  // The ratio table and the detectors do not always compute a
  // same-named figure the same way, and until this section existed they
  // never met on one page. They do now. Measured on agras: the ratio
  // card reads "Days Payables Outstanding (on total operating cost)
  // 27 days" and `trade_float` reports "Days payables outstanding
  // 37.2 days" — one name, two values, four pages apart, which is
  // exactly the defect this wave was called in for.
  //
  // The renderer cannot reconcile the two arithmetics and must not
  // pretend to. What it CAN do is refuse to let the contradiction be
  // silent: where a measure's name collides with a ratio this document
  // also prints, and the two figures differ, the card says so and names
  // both formulas. The disambiguating parenthetical some card labels
  // carry is stripped before matching — a suffix that hides a collision
  // from a matcher does not hide it from a reader.
  const nameKey = (label: string): string =>
    label
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const printedRatiosByName = new Map<string, Ratio>();
  for (const rt of [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency].flat().concat([altman])) {
    const key = nameKey(rt.label);
    if (!printedRatiosByName.has(key)) printedRatiosByName.set(key, rt);
  }
  /** The measure's value expressed in the ratio card's own unit, or null
   *  when the two units are not the same quantity and no comparison is
   *  honest. */
  const measureInRatioUnit = (m: { value: number | null; unit: string }, unit: Ratio["unit"]): number | null => {
    if (m.value === null) return null;
    if (unit === "days") return m.unit === "days" ? m.value : null;
    if (unit === "x") return m.unit === "multiple" || m.unit === "ratio" ? m.value : null;
    if (unit === "%") return m.unit === "ratio" ? m.value * 100 : m.unit === "pct" ? m.value : null;
    return null;
  };
  const clashNote = (i: Insight, m: Insight["measures"][number]): string => {
    const rt = printedRatiosByName.get(nameKey(m.label));
    if (!rt || rt.value === null) return "";
    const mine = measureInRatioUnit(m, rt.unit);
    if (mine === null) return "";
    const scale = Math.max(Math.abs(rt.value), 1e-9);
    if (Math.abs(mine - rt.value) / scale <= 0.005) return "";
    return (
      `<tr class="measure-clash" data-clash="${escapeHtml(nameKey(m.label))}"><td colspan="2">` +
      `This document also prints <strong>&ldquo;${escapeHtml(rt.label)}&rdquo; ${escapeHtml(
        formatRatio(rt),
      )}</strong>. Two arithmetics, not two books: that card computes ${escapeHtml(
        rt.formula,
      )}; this finding computes ${escapeHtml(i.formula)}.` +
      `</td></tr>`
    );
  };

  const insightMeasureRows = (i: Insight): string =>
    i.measures
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.label)}</td><td class="num">${escapeHtml(
            formatMeasure(m, insightCurrency),
          )}</td></tr>` + clashNote(i, m),
      )
      .join("");

  const insightAccountRows = (i: Insight): string =>
    i.accounts
      .map(
        (a) =>
          `<tr><td>${escapeHtml(a.code)}</td><td>${escapeHtml(a.name)}</td>` +
          `<td class="num">${escapeHtml(formatAmount(a.amount, insightCurrency))}</td>` +
          `<td>${escapeHtml(a.role.replace(/_/g, " "))}</td></tr>`,
      )
      .join("");

  const insightLadderRows = (i: Insight): string =>
    severityLadder(i)
      .map(
        (rung) =>
          `<tr${rung.active ? ' class="active-rung"' : ""}>` +
          `<td class="${rung.active ? "active" : ""}">${escapeHtml(rung.label)}</td>` +
          `<td class="num ${rung.active ? "active" : ""}">${rung.active ? "this book" : ""}</td></tr>`,
      )
      .join("");

  const insightCard = (i: Insight): string => {
    const sev = i.severity;
    const basisLine =
      `Scaled against ${escapeHtml(sev.basis_label || sev.basis || "no stated basis")}` +
      ` ${escapeHtml(formatAmount(sev.basis_value, insightCurrency))}` +
      ` &middot; magnitude ${escapeHtml(formatAmount(sev.magnitude, insightCurrency))}` +
      ` &middot; ${escapeHtml(
        formatMeasure({ value: sev.materiality, unit: "ratio" }, insightCurrency),
      )} of it.` +
      (sev.why ? ` ${escapeHtml(sev.why)}` : "");
    // The narrative halves are ABSENT-CAPABLE: a lane that did not run
    // says so, in its own words, instead of leaving a silent gap that
    // reads as "nothing to say about this".
    const narrative =
      i.narrative.explanation === null && i.narrative.so_what === null
        ? `<p class="insight-explanation">No written explanation accompanies this finding${
            i.narrative.reason ? ` — ${escapeHtml(i.narrative.reason)}` : ""
          }. The claim, the formula, the ladder and the accounts above are the whole of it.</p>`
        : `${
            i.narrative.explanation
              ? `<p class="insight-explanation">${escapeHtml(i.narrative.explanation)}</p>`
              : ""
          }${
            i.narrative.so_what
              ? `<p class="insight-so-what"><strong>So what:</strong> ${escapeHtml(i.narrative.so_what)}</p>`
              : ""
          }`;
    return `
      <div class="insight-card" data-insight-id="${escapeHtml(i.id)}" data-severity="${escapeHtml(
        i.severity.level,
      )}" data-rank="${i.rank}"${i.in_summary ? ' data-in-summary="1"' : ""}>
        <div class="insight-head">
          <span class="insight-rank">${i.rank}</span>
          <span class="insight-severity" data-level="${escapeHtml(
            i.severity.level,
          )}">${escapeHtml(severityCaption(i))}</span>
          <span class="insight-title">${escapeHtml(i.title)}</span>
        </div>
        <p class="insight-claim">${escapeHtml(i.claim)}</p>
        <p class="insight-formula"><strong>Formula:</strong> ${escapeHtml(i.formula)}</p>
        <p class="insight-basis">${basisLine}</p>
        <div class="insight-cols">
          <table class="fin insight-measures">
            <thead><tr><th>What was measured</th><th class="num">Value</th></tr></thead>
            <tbody>${insightMeasureRows(i)}</tbody>
          </table>
          <table class="fin insight-ladder">
            <thead><tr><th>Severity ladder actually applied</th><th class="num"></th></tr></thead>
            <tbody>${insightLadderRows(i)}</tbody>
          </table>
        </div>
        <table class="fin insight-accounts">
          <thead><tr><th>Account</th><th>Name</th><th class="num">Balance</th><th>Role</th></tr></thead>
          <tbody>${insightAccountRows(i)}</tbody>
        </table>
        ${narrative}
        ${
          i.narrative.source === "deterministic"
            ? `<p class="insight-narrative-source">Wording above is the engine's own deterministic template${
                i.narrative.reason ? ` — ${escapeHtml(i.narrative.reason)}` : ""
              }; no figure in it was authored by anything but the detector.</p>`
            : ""
        }
      </div>`;
  };

  const insightsSection = (): string => {
    if (insightsBlock === null) return "";
    const block = insightsBlock;
    const rankBasis = block.insights[0]?.rank_basis ?? "";
    const counted = SEVERITY_ORDER.map((level) => ({
      level,
      n: block.insights.filter((i) => i.severity.level === level).length,
    })).filter((c) => c.n > 0);
    const tally =
      counted.length === 0
        ? "No detector fired on this book."
        : counted
            .map((c) => `${c.n} ${escapeHtml(SEVERITY_LABEL[c.level].toLowerCase())}`)
            .join(" &middot; ");
    const notFired =
      block.not_fired.length === 0
        ? ""
        : `<div class="insight-not-fired">
            <h3>Checked and clear</h3>
            <p class="insight-basis">These detectors ran on this book and did not fire. Each states why — a check that found nothing is a result, not an absence.</p>
            <ul>${block.not_fired
              .map(
                (n) =>
                  `<li data-insight-id="${escapeHtml(n.id)}"><strong>${escapeHtml(
                    n.title,
                  )}</strong> &mdash; ${escapeHtml(n.reason)}</li>`,
              )
              .join("")}</ul>
          </div>`;
    return section(
      "insights",
      "What the numbers say",
      `
  <div class="commentary">
    <strong>${tally}.</strong> Each finding below carries the claim, the arithmetic in words, the accounts it read with their balances, and the severity ladder it was banded against &mdash; so a reader who disagrees with a level can check it without leaving the page. ${escapeHtml(
      rankBasis,
    )}
  </div>
  ${block.insights.map(insightCard).join("")}
  ${notFired}
  `,
    );
  };

  // ── PAGE ONE'S MODEL ────────────────────────────────────────────────
  //
  // THE OVERRIDES ARE THE POINT. `buildComparatives` builds its own
  // current-period figures from `deriveTotals`, and on these books that
  // is not what this document prints: agras nets 14,106,102.03
  // reconstructed against the 7,533,676.02 account-121 close on the card
  // three inches above, and retail's revenue differs by 1,923.78. A
  // strip built without these overrides would print a second value under
  // the same name on the same page — R1, in a KPI table. Every figure
  // passed here is the one the document already resolved and prints.
  const summaryOverrides: Record<string, number | null> = {
    revenue: operatingRevenue,
    ebitda: ebitdaStatutory,
    net_income: netIncomeStatutory,
    total_assets: sf.totalAssets(),
    total_equity: sf.totalEquity(),
    equity_ratio: ratioNamed("equity_ratio")?.value ?? null,
  };
  const summary: ExecutiveSummary = buildExecutiveSummary(
    s,
    r,
    credit,
    [altman],
    5,
    summaryOverrides,
  );

  const tileFigure = (line: ComparativeLine | null, value: number | null): string => {
    if (value === null || !Number.isFinite(value)) return UNREPORTED_WORD;
    const unit = line?.unit ?? "money";
    if (unit === "pct") return `${formatNumber(value, 1)}%`;
    if (unit === "x") return `${formatNumber(value, 2)}×`;
    return money(value, s.currency);
  };

  /** The KPI strip, and — on every book this product serves today — the
   *  stated absence of anything to compare it against. Never a dash and
   *  never a zero in the comparison column: both read as "no change",
   *  which is a claim about a period nobody supplied. */
  const comparativesBlock = (): string => {
    const c: Comparatives = summary.comparatives;
    const headings = c.available
      ? c.periods.map((p) => `<th class="num">${escapeHtml(p.heading)}</th>`).join("")
      : `<th class="num">Change</th>`;
    // THE REASON TRAVELS WITH THE CELL. "no prior period" in a column
    // headed "Change" is already better than a dash, but a reader
    // hovering it (or a gate reading it) must be able to get the whole
    // sentence — the module's own words for why this particular line
    // cannot be compared, which is not always the same reason twice.
    const noCell = (why: string): string =>
      `<td class="nocmp" title="${escapeHtml(why)}">${escapeHtml(NO_COMPARATIVE_CELL)}</td>`;
    const cell = (line: ComparativeLine, kind: "prior_period" | "prior_year"): string => {
      const v = line.vs[kind];
      if (v.absolute === null) return noCell(v.unavailable ?? c.degradedReason ?? "");
      return `<td class="num">${escapeHtml(formatVariance(v, line.unit))}</td>`;
    };
    const rows = summary.tiles
      .map((tile) => {
        const line = tile.line;
        const label = tile.key === "revenue" ? "Operating revenue" : tile.label;
        const noReason =
          line?.vs.prior_period.unavailable ?? c.degradedReason ?? "no comparison period reached this document";
        const cells = c.available
          ? c.periods.map((p) => (line ? cell(line, p.kind) : noCell(noReason))).join("")
          : noCell(noReason);
        return `<tr data-tile="${escapeHtml(tile.key)}"><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(
          tileFigure(line, tile.value),
        )}</td>${cells}</tr>`;
      })
      .join("");
    const note = c.available
      ? `<p class="comparatives-note">Comparison periods: ${c.periods
          .map((p) => `${escapeHtml(p.heading)} (${escapeHtml(p.periodLabel)})`)
          .join(" &middot; ")}.</p>`
      : `<p class="comparatives-note"><strong>${escapeHtml(c.degradedNote)}.</strong> ${escapeHtml(
          c.degradedReason ?? "",
        )}, so every figure in this document is a position at ${escapeHtml(
          s.periodLabel,
        )} rather than a movement. Nothing here is up or down against anything, and the column below says so on every line instead of showing a dash or a zero &mdash; both of which read as &ldquo;no change&rdquo;.</p>`;
    return `
    <h3>Headline figures</h3>
    ${note}
    <table class="fin comparatives">
      <thead><tr><th>Figure</th><th class="num">${escapeHtml(s.periodLabel)}</th>${headings}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  /** WHY THIS VERDICT — the letter, the model that said it, and the two
   *  or three graded facts behind it, worst first. A reader who
   *  disagrees with the grade needs the evidence, and the evidence that
   *  matters is what is failing. */
  const verdictFactsBlock = (): string => {
    const v = summary.verdict;
    const head =
      v.letter === null
        ? `<strong>Letter grade: ${escapeHtml(UNREPORTED_WORD)}.</strong> ${escapeHtml(v.unavailable ?? "")}`
        : `<strong>${escapeHtml(v.letter)}</strong>${
            v.score === null ? "" : ` &middot; composite ${escapeHtml(formatNumber(v.score, 1))}`
          } &middot; ${escapeHtml(v.model)}`;
    const facts =
      v.facts.length === 0
        ? `<p class="insight-basis">No graded ratio on this book carries both a value and a band, so there is no evidence to quote for the grade.</p>`
        : `<table class="fin verdict-facts-table">
            <thead><tr><th>What produced it</th><th class="num">This book</th><th>Verdict</th><th>Band</th></tr></thead>
            <tbody>${v.facts
              .map(
                (f) =>
                  `<tr data-verdict-fact="${escapeHtml(f.key)}"><td>${escapeHtml(f.label)}</td>` +
                  `<td class="num">${escapeHtml(f.printed)}</td>` +
                  `<td><span class="badge v-${f.verdict}">${escapeHtml(verdictLabel(f.verdict))}</span></td>` +
                  `<td>${escapeHtml(f.benchmark)}</td></tr>`,
              )
              .join("")}</tbody>
          </table>`;
    return `<div class="verdict-facts"><h3>Why this verdict</h3><p class="comparatives-note">${head}</p>${facts}</div>`;
  };

  /** THE TOP FIVE, ON PAGE ONE — the same objects §What the numbers say
   *  prints in full, in the engine's own rank order. Absent block: this
   *  returns "" and page one gains nothing, rather than asserting that
   *  nothing was found. */
  const summaryInsightsBlock = (): string => {
    if (summary.insights.length === 0) {
      return insightsBlock === null
        ? ""
        : `<div class="commentary"><strong>Findings.</strong> ${escapeHtml(
            summary.insightsAbsence ?? "",
          )}</div>`;
    }
    return `
    <h3>What the numbers say</h3>
    <p class="comparatives-note">The ${
      summary.insights.length
    } findings the engine ranked highest on this book. Each is printed in full &mdash; claim, formula, accounts and ladder &mdash; in <a href="#insights">What the numbers say</a>.</p>
    <ul class="summary-insights">${summary.insights
      .map(
        (i) =>
          `<li data-insight-id="${escapeHtml(i.id)}" data-severity="${escapeHtml(
            i.severity.level,
          )}"><span class="insight-severity" data-level="${escapeHtml(
            i.severity.level,
          )}">${escapeHtml(severityCaption(i))}</span> <strong>${escapeHtml(
            i.title,
          )}</strong> &mdash; ${escapeHtml(i.claim)}</li>`,
      )
      .join("")}</ul>`;
  };

  /** WHAT WOULD CHANGE THE VERDICT — the rungs this book is nearest to
   *  crossing, each with its distance, rendered from the SAME ladder
   *  object each badge above was decided by (TC-10). */
  // ── A ROW THAT DOES NOT FOOT IS A ROW A READER CANNOT CHECK ─────────
  //
  // `rungFigure` exists to print a CUTOFF without rounding it away, and
  // it picks its precision from the magnitude of the number in front of
  // it. Three numbers that each pick their own precision do not subtract:
  // measured on the first draft of this table, agras printed
  // "31 d · 30 d · 1.07 d" and retail "56.6 · 30 · 26.5652" — rows whose
  // own three cells contradict each other. The decimals are therefore
  // chosen ONCE PER ROW, from the distance, wide enough that the rounding
  // of the two operands cannot exceed 2% of the gap between them.
  const wouldChangeDecimals = (distance: number): number => {
    const gap = Math.abs(distance);
    if (!Number.isFinite(gap) || gap === 0) return 2;
    return Math.min(6, Math.max(0, Math.ceil(Math.log10(50 / gap))));
  };
  const wouldChangeFigure = (v: number, unit: Ratio["unit"], decimals: number): string => {
    const shown = v.toFixed(decimals);
    return unit === "x" ? `${shown}×` : unit === "%" ? `${shown}%` : unit === "days" ? `${shown} d` : shown;
  };

  const wouldChangeBlock = (): string => {
    if (summary.wouldChange.length === 0) {
      return `<div class="commentary"><strong>What would change the verdict.</strong> ${escapeHtml(
        summary.wouldChangeAbsence ?? "",
      )}</div>`;
    }
    return `
    <h3>What would change the verdict</h3>
    <p class="comparatives-note">${escapeHtml(summary.wouldChangeBasis)} Each row prints at the precision its own subtraction needs, so Now &minus; Rung equals Distance on every line; the cards above round the same values to the document&rsquo;s display precision, which is why a figure here can carry more decimals than the card it came from. It is the same value, not a second one.</p>
    <table class="fin would-change">
      <thead><tr><th>Ratio</th><th class="num">Now</th><th class="num">Rung</th><th class="num">Distance</th><th>Crossing it</th></tr></thead>
      <tbody>${summary.wouldChange
        .map((d) => ({ d, dp: wouldChangeDecimals(d.distance) }))
        .map(
          ({ d, dp }) =>
            `<tr data-would-change="${escapeHtml(d.ratioKey)}" data-to-verdict="${escapeHtml(
              d.toVerdict,
            )}"><td>${escapeHtml(d.ratioLabel)}</td>` +
            `<td class="num">${escapeHtml(wouldChangeFigure(d.value, d.unit, dp))}</td>` +
            `<td class="num">${escapeHtml(wouldChangeFigure(d.threshold, d.unit, dp))}</td>` +
            `<td class="num">${escapeHtml(wouldChangeFigure(d.distance, d.unit, dp))}</td>` +
            `<td>${d.move === "improve" ? "would move it up to" : "would drop it to"} <span class="badge v-${
              d.toVerdict
            }">${escapeHtml(verdictLabel(d.toVerdict))}</span></td></tr>`,
        )
        .join("")}</tbody>
    </table>`;
  };

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
          ${has722 ? `<tr class="indent memo"><td>EBITDA (cash view, excl. 722) — memo</td><td class="num">${money(ebitdaCash, s.currency)}</td></tr>` : ""}
          <tr class="indent"><td>Depreciation & amortization</td><td class="num">(${money(is.depreciationAmortization, s.currency)})</td></tr>
          <tr class="subtotal"><td>EBIT</td><td class="num">${money(ebitStatutory, s.currency)}</td></tr>
          <tr class="indent"><td>Financial income</td><td class="num">${money(financialIncome, s.currency)}</td></tr>
          <tr class="indent"><td>Interest expense</td><td class="num">(${money(interestExpense, s.currency)})</td></tr>
          <tr class="indent"><td>Other financial expense</td><td class="num">(${money(otherFinancialExpense, s.currency)})</td></tr>
          <tr class="subtotal"><td>Profit Before Tax</td><td class="num">${money(pretaxStatutory, s.currency)}</td></tr>
          <tr class="indent"><td>Tax expense</td><td class="num">(${money(is.taxExpense, s.currency)})</td></tr>
          ${
            hasBridge
              ? `<tr class="subtotal"><td>Net profit — reconstructed (class 6/7 movements)</td><td class="num">${money(reconstructedNetIncome, s.currency)}</td></tr>
          <tr class="indent"><td>&plusmn; Reconciliation to account 121 — the class 6/7 movements do not sum to the filed close</td><td class="num">${money(bridgeTo121, s.currency)}</td></tr>`
              : ""
          }
          <tr class="total"><td>Net Income (account 121, as filed)</td><td class="num">${money(netIncomeStatutory, s.currency)}</td></tr>
        </tbody>
      </table>
      ${
        hasBridge
          ? `<div class="commentary" data-report-pl-bridge><strong>Reconstruction &rarr; filed accounts.</strong> The column above rebuilds the P&amp;L from the trial balance&rsquo;s class 6 and class 7 movements; it ends on account 121&rsquo;s closing balance (${money(netIncomeStatutory, s.currency)}) &mdash; the figure the company filed, and the one every ratio in this document is built on. The ${money(bridgeTo121, s.currency)} step is <strong>not explained</strong> by any line on this statement: the class-6/7 movements this extract carries do not sum to what account 121 closed at. It is printed with its amount rather than folded into a plug, because a build-up that foots on an invented component is worse than one that names its gap. Reconciling the two needs the source ledger, not this extract.</div>`
          : ""
      }
    `;
  };

  // ── THE CHARTS ──────────────────────────────────────────────────────
  //
  // Built here, from the served envelope, the ratio bundle this document
  // already prints and the credit reader that minted the letter — never
  // from a second arithmetic. `allChartBlocks` returns a block per chart
  // with BOTH halves (the SVG and its table) or, when the envelope did
  // not carry the inputs, the gap card and no table. `renderChartBlock`
  // writes both or neither, which is R5 made structural rather than
  // remembered.
  const charts: ChartBlock[] = reportChartBlocks(s, credit, metricsByName);
  const chartById = (id: string): string => {
    const b = charts.find((c) => c.id === id);
    return b ? renderChartBlock(b) : "";
  };

  // ── THE TOGGLES ─────────────────────────────────────────────────────
  //
  // Two ship working, two ship as a STATED absence. A toggle that
  // switches four figures and leaves ninety unswitched is worse than one
  // that is not there: the reader believes the whole document moved.
  //
  // Working, because both states are figures the ENGINE emitted:
  //   • P&L basis — the filed close (account 121) against the class-6/7
  //     reconstruction, both served, both already printed in the P&L.
  //   • Voice — two authored spellings of the same sentence, no figure
  //     changes at all.
  //
  // Stated absent, with the reason on the control:
  //   • Currency — this export is not handed a display currency or an FX
  //     rate (`buildReportHtml` takes none today; the Excel path takes an
  //     `ExportCurrencyContext` and the page passes `undefined` there
  //     too). Converting inside the document would mint a rate.
  //   • Intercompany — the envelope carries `subAggregates.ar_intercompany`,
  //     a single carve-out, and no ex-intercompany totals, ratios or
  //     statements. Netting one line and leaving the ratios built on the
  //     gross one is a document that contradicts itself.
  const toggles: ToggleSpec[] = [
    hasBridge
      ? {
          attr: "pl-view",
          label: "Reconciliation to 121",
          options: [
            { value: "filed", label: "Filed close", hint: "The headline figure is account 121's closing balance — what the company filed, and what every ratio here is built on. It does not change." },
            { value: "reconstructed", label: "Show reconstruction", hint: "Also state the class-6/7 movement reconstruction beside it. Both figures are served and they differ on this book; neither is recomputed here." },
          ],
        }
      : {
          attr: "pl-view",
          label: "Reconciliation to 121",
          options: [],
          unavailableReason: "nothing to reconcile — the class-6/7 reconstruction equals the filed close on this book",
        },
    {
      attr: "voice",
      label: "Language",
      options: [
        { value: "pro", label: "Pro", hint: "Lender register: the terms a credit committee uses." },
        { value: "simple", label: "Simple", hint: "The same finding in plain words. No figure changes." },
      ],
    },
    {
      attr: "ccy",
      label: "Currency",
      options: [],
      unavailableReason: `${s.currency} only — no display currency or FX rate was handed to this export`,
    },
    {
      attr: "ic",
      label: "Intercompany",
      options: [],
      unavailableReason: "not restatable — the envelope carries one carve-out, not an ex-intercompany book",
    },
  ];

  const SECTIONS: ShellSection[] = [
    { id: "sec-exec", title: "Executive summary" },
    { id: "sec-statements", title: "Financial statements" },
    { id: "sec-cash", title: "Cash and net debt" },
    { id: "sec-liquidity", title: "Liquidity and working capital" },
    { id: "sec-profit", title: "Profitability" },
    { id: "sec-leverage", title: "Leverage and coverage" },
    { id: "sec-credit", title: "Credit and distress" },
    // Listed only when the block is there to link to. A contents entry
    // pointing at a section this document does not carry is a dead
    // anchor in the rail AND a page-number row in the printed contents
    // — and it would assert a findings section on a period that was
    // served before the engine emitted one.
    ...(insightsBlock === null
      ? []
      : [{ id: "insights", title: "What the numbers say" }]),
    { id: "sec-recs", title: "Recommendations" },
    { id: "sec-basis", title: "Basis of preparation" },
  ];
  const section = (id: string, title: string, bodyHtml: string): string =>
    `<section class="rsec" id="${id}" data-collapsed="0"><h2>${escapeHtml(title)}</h2><div class="rsec-body">${bodyHtml}</div></section>`;

  // Both voices, both in the document. The toggle shows one.
  const voiced = (pro: string, simple: string, cls = "commentary"): string =>
    `<div class="${cls}" data-variant="voice-pro">${pro}</div>` +
    `<div class="${cls}" data-variant="voice-simple">${simple}</div>`;

  const bsStatusLine = (() => {
    const p2 = sf.presentStatus(s.currency);
    return p2.exportHeadline;
  })();

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
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(s.companyName)} — Financial Analysis ${escapeHtml(s.periodLabel)}</title>
  <style>${css}</style>
</head>
<body data-pl-view="filed" data-voice="pro" data-ccy="base" data-ic="with">
  ${toggleBar(toggles)}
  ${contentsRail(SECTIONS)}

  ${coverPage({
    company: s.companyName,
    period: s.periodLabel,
    currency: s.currency,
    industryLine: industryDisputed
      ? `unconfirmed — the account mix and the workspace setting disagree`
      : s.industry ?? "not stated",
    verdict: overallVerdict,
    generated: today,
    statusLine: bsStatusLine,
  })}

  ${contentsPage(SECTIONS)}

  <div class="running-header">
    <span class="org">${escapeHtml(s.companyName)}</span>
    <span class="meta">Financial Analysis &nbsp;·&nbsp; ${escapeHtml(s.periodLabel)}</span>
  </div>

  <div class="header-info">
    <p><strong>Comprehensive Financial Analysis</strong></p>
    <p>Period: ${escapeHtml(s.periodLabel)} &nbsp;·&nbsp; Currency: ${escapeHtml(s.currency)}${industryHeaderClause}</p>
    <p>Report generated: ${escapeHtml(today)}</p>
    ${industryDisputeNote}
  </div>

  ${section(
    "sec-exec",
    "Executive Summary",
    `
  <div class="insight">
    <strong>Overall verdict:</strong> ${escapeHtml(overallVerdict)}
  </div>
  ${voiced(
    `<strong>How to read this document.</strong> Every figure is traceable: hover any ratio for its formula, the accounts behind it and the snapshot it came from. Charts never carry a number their own table does not print, and a figure the filing did not report is stated as a gap rather than shown as zero.`,
    `<strong>How to read this.</strong> Every number here comes from your own books, and you can check any of them: hover a number to see the sum behind it. If something is missing from the filing, we say so instead of putting a zero in its place.`,
  )}
  <div class="grid grid-4">
    <div class="ratio-card">
      <div class="label">Operating revenue</div>
      <div class="value" ${provAttrs({
        label: "Operating revenue",
        value: money(operatingRevenue, s.currency),
        formula: "class 70 credit movements + capitalized own work (722)",
        accounts: "70x, 722",
        method: "assembled_pl.total_operating_revenue",
        snapshot: `${s.companyName} · ${s.periodLabel}`,
      })}>${money(operatingRevenue, s.currency)}</div>
      ${has722 ? `<div class="meta">incl. 722 ${money(capOwnWork, s.currency)}</div>` : ""}
    </div>
    <div class="ratio-card">
      <div class="label">EBITDA${has722 ? " (statutory)" : ""}</div>
      <div class="value" ${provAttrs({
        label: `EBITDA${has722 ? " (statutory)" : ""}`,
        value: money(ebitdaStatutory, s.currency),
        formula: "operating revenue − operating expense, before depreciation",
        accounts: "70x/72x − 60x/61x/62x/63x/64x/65x",
        method: "assembled_pl.ebitda_statutory",
        snapshot: `${s.companyName} · ${s.periodLabel}`,
      })}>${money(ebitdaStatutory, s.currency)}</div>
      <div class="meta">${escapeHtml(printedRatio("ebitda_margin"))} margin</div>
    </div>
    <div class="ratio-card">
      <div class="label">Net Income (account 121, as filed)</div>
      <div class="value" ${provAttrs({
        label: "Net income (account 121, as filed)",
        value: money(netIncomeStatutory, s.currency),
        formula: "account 121 closing balance",
        accounts: "121",
        method: "assembled_pl.net_income_statutory",
        snapshot: `${s.companyName} · ${s.periodLabel}`,
      })}>${money(netIncomeStatutory, s.currency)}</div>
      ${
        hasBridge
          ? `<div class="meta"><span data-variant="pl-filed">account 121, as filed &mdash; ${escapeHtml(printedRatio("net_margin"))} margin</span><span data-variant="pl-reconstructed">reconstructed from class 6/7: ${money(reconstructedNetIncome, s.currency)} &mdash; <span class="no-variant">margin not restated; the served margin is built on the filed close</span></span></div>`
          : `<div class="meta">account 121, as filed &mdash; ${escapeHtml(printedRatio("net_margin"))} margin</div>`
      }
    </div>
    <div class="ratio-card">
      <div class="label">Total Debt</div>
      <div class="value" ${provAttrs({
        label: "Total debt",
        value: money(t.totalDebt, s.currency),
        formula: "short-term debt + long-term debt",
        accounts: "519, 162, 167, 168",
        method: "derived from the served balance sheet",
        snapshot: `${s.companyName} · ${s.periodLabel}`,
      })}>${money(t.totalDebt, s.currency)}</div>
      <div class="meta">${escapeHtml(printedRatio("debt_to_ebitda"))} EBITDA</div>
    </div>
  </div>
  ${comparativesBlock()}
  ${verdictFactsBlock()}
  ${summaryInsightsBlock()}
  ${wouldChangeBlock()}
  ${chartById("chart-ebitda-bridge")}
  ${chartById("chart-revenue-trend")}
  `,
  )}

  ${section(
    "sec-statements",
    "Financial Statements",
    `
  ${balanceSheetTable()}
  ${chartById("chart-bs-composition")}
  ${incomeStatementTable()}
  `,
  )}

  ${section(
    "sec-cash",
    "Cash and Net Debt",
    `
  ${chartById("chart-cash-walk")}
  ${chartById("chart-net-debt-walk")}
  `,
  )}

  ${section(
    "sec-liquidity",
    "Liquidity & Working Capital",
    `
  ${ratioGroup("Liquidity", r.liquidity)}
  ${ratioGroup("Working Capital Cycle", r.efficiency)}
  ${chartById("chart-wc-cycle")}
  `,
  )}

  ${section("sec-profit", "Profitability", ratioGroup("Margin & Returns", r.profitability))}

  ${section(
    "sec-leverage",
    "Leverage & Coverage",
    `
  ${ratioGroup("Capital Structure", r.leverage)}
  ${ratioGroup("Debt Coverage", r.coverage)}
  ${chartById("chart-band-tracks")}
  ${chartById("chart-covenant-headroom")}
  `,
  )}

  ${section(
    "sec-credit",
    "Credit & Distress",
    `
  ${creditSection()}
  ${chartById("chart-credit-contrib")}
  ${chartById("chart-asset-age")}
  `,
  )}

  ${insightsSection()}

  ${section("sec-recs", "Recommendations", recs.map(recommendationCard).join(""))}

  ${section(
    "sec-basis",
    "Basis of Preparation",
    `
  <aside class="basis-note">
    <strong>Basis of preparation</strong>
    Figures reflect the period&rsquo;s statutory financial statements as ingested by the CFO AI engine. Ratios follow standard lender conventions (Altman Z-Score, DSCR, debt-to-EBITDA, etc.); benchmarks are indicative and industry-dependent. Where the underlying trial-balance reconciliation gap exceeds tolerance, the affected figure is annotated in the relevant statement above. This document is AI-assisted; final analytical judgement and any onward decisions remain with management.${provenanceNote}
  </aside>
  ${voiced(
    `<strong>Charts.</strong> Every chart is generated with this document, from the same served figures the statements above print, and carries its own table &mdash; no chart is the only place a number appears. A chart whose inputs the filing did not carry is replaced by a card naming the missing input, never by an empty axis.`,
    `<strong>About the charts.</strong> Each chart comes with the table of numbers behind it, so nothing is only in a picture. If we did not have the data for a chart, we say what is missing instead of drawing an empty one.`,
  )}
  `,
  )}

  ${provenanceCard()}

  <footer class="footer">
    <span class="lhs"><strong>CFO AI</strong> &nbsp;·&nbsp; Financial Statement Intelligence</span>
    <span class="rhs">Generated ${escapeHtml(today)} &nbsp;·&nbsp; Confidential &mdash; for internal use only</span>
  </footer>
  <script>${shellScript()}</script>
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
