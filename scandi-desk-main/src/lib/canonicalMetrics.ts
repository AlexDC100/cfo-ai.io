// Canonical dual-basis metric object — single source of truth for
// EBITDA and net-profit across every surface (Dashboard KPI tile,
// ComprehensiveReport KPI grid, Opus briefing display, Valuation,
// Chat workspace snapshot, Export report).
//
// PROBLEM IT SOLVES
// =================
// Before this module, the same Scandia period showed EBITDA as
// 42.77M on one tile, 54.4M on another, and Net Profit as 22.93M /
// 34.57M on different screens. Root cause: at least 5 surfaces
// independently derived EBITDA / net-profit (some via deriveTotals,
// some via buildPlStatement, some directly from assembled_pl with
// different field choices). Every divergence is a bug.
//
// THE FIX
// =======
// One module assembles a canonical, dual-basis metric object from the
// values the engine already emits. Every consumer reads from this
// object. The engine math is NOT touched — `_ro_coa.py`'s aggregations
// are reused verbatim. We add ONE thing here: an explicit, itemized
// bridge from Reported EBITDA → Core EBITDA via accounts 758 and 781,
// extracted from the per-account `lineItems` array on the API
// response.
//
// THE BRIDGE
// ==========
//   Reported EBITDA      = assembled_pl.ebitda_statutory  (legal view,
//                                                          ties to acct 121)
//   − Account 758        Other operating income           (non-core)
//   − Account 781        Provision reversals              (non-core)
//   = Core EBITDA                                          (valuation basis)
//
// Accounts 758/781 are read from the per-account `lineItems` list
// already shipped on the `/api/period/{id}` response. NO engine
// recompute — we sum two account-line-item amounts.
//
// THE NET-PROFIT ANCHOR
// =====================
//   statutory      = assembled_pl.net_income_statutory  (account 121 closing C — the legally filed number)
//   reconstructed  = derived from class 6/7 movements   (engine's bottom-up calc)
//   gap            = reconstructed − statutory          (should be within ±2% per the methodology)
//
// ABSOLUTE-VALUE STRICTNESS
// =========================
// Per the spec: this module reports the engine's REAL computed values.
// We do not hardcode the Scandia oracle. If the engine is wrong, the
// canonical object will show wrong figures, and the user can use the
// itemized bridge + the engine trace to find the discrepancy. Honest
// over silently-correct.

import type { ActivePeriod, PeriodLineItem } from "./activePeriod";
import { F36_CUTOVER_METRICS_HUB } from "@/config/features";

/**
 * F3.16-3b.6 cutover helper — resolves the Reported EBITDA value
 * preferring the YAML methodology layer over the legacy in-code field.
 *
 * Per ADR Lock #8 Reference Appendix, F4.2-PARITY HARD-locks the
 * methodology field byte-identical to the legacy field (24/24 fixture-
 * variant cells matched to the cent post-3b.6-B). When the flag is on
 * (default), we read from the canonical envelope; when off, we revert
 * to the legacy field. Both branches return the same number today.
 *
 * The branch exists because F4.7 (2026-11-23) deletes the legacy field
 * — at that horizon, the fallback becomes unreachable and the flag is
 * removed alongside the legacy code path.
 */
function _resolveReportedEbitda(
  canonicalMethodologyValue: number | undefined,
  legacyValue: number,
): number {
  if (F36_CUTOVER_METRICS_HUB && typeof canonicalMethodologyValue === "number") {
    return canonicalMethodologyValue;
  }
  return legacyValue;
}

// ─── Types ──────────────────────────────────────────────────────────

export interface CanonicalEbitdaAdjustment {
  /** RO account code, e.g. "758", "781". */
  account: string;
  /** Human-readable label. */
  label: string;
  /** Engine-emitted amount for this account (positive value, the
   *  bridge subtracts it from Reported to reach Core). */
  amount: number;
}

export interface CanonicalEbitda {
  /** Reported (statutory) EBITDA — the legally filed view that ties
   *  to the rest of the engine's reconciliation. Sourced from
   *  `assembled_pl.ebitda_statutory`. */
  reported: number;
  /** Core / normalized EBITDA = reported − Σ adjustments. The basis
   *  for valuation in non-RE companies (repeatable earnings, not
   *  provision reversals). */
  core: number;
  /** Which basis valuation should default to. Always `"core"` for
   *  operating companies; the FE Valuation tab can toggle to
   *  `"reported"` as a cross-check. */
  basis_for_valuation: "core" | "reported";
  /** Itemized adjustments — drives the Reconciliation panel on the
   *  Dashboard. Each entry is subtracted from `reported` to get
   *  `core`. Empty when no non-core items are present. */
  adjustments: CanonicalEbitdaAdjustment[];
  /** Reported margin = reported ÷ total operating revenue × 100,
   *  in percentage points. Null when revenue is zero. */
  reported_margin_pct: number | null;
  /** Core margin = core ÷ total operating revenue × 100. */
  core_margin_pct: number | null;
}

export interface CanonicalNetProfit {
  /** Closing C balance of account 121 — the legally filed number.
   *  Always the headline. */
  statutory_account_121: number;
  /** Bottom-up reconstruction from class 6 / 7 movements. Should
   *  match statutory within ±2% per the methodology. */
  reconstructed: number;
  /** `reconstructed − statutory_account_121`. Surfaced honestly so
   *  any drift is visible, not hidden. */
  reconciliation_gap: number;
  /** Gap as a percentage of `statutory_account_121`. Null when
   *  statutory is zero. */
  gap_pct: number | null;
  /** Always `"statutory_account_121"` — the anchor convention. */
  anchor: "statutory_account_121";
}

export interface CanonicalBalance {
  total_assets: number;
  equity: number;
  total_debt: number;
  cash: number;
  /** `total_debt − cash`. Net of cash, the figure lenders care about. */
  net_debt: number;
}

export interface CanonicalProvenance {
  /** Where this period was sourced from — see API. */
  source: string | null;
  /** Company name (when known). */
  company: string | null;
  /** Period label (e.g. "FY 2025"). */
  period: string | null;
  /** Period UUID — the lookup key. */
  period_id: string | null;
}

export interface CanonicalMetrics {
  ebitda: CanonicalEbitda;
  netProfit: CanonicalNetProfit;
  balance: CanonicalBalance;
  provenance: CanonicalProvenance;
  /** Auxiliary headline numbers needed by some surfaces. Sourced
   *  directly from `assembled_pl` — no recompute. */
  headline: {
    revenue: number;
    total_operating_revenue: number;
    ebit: number;
    depreciation: number;
    tax: number;
    interest_expense: number;
    capitalized_own_work_memo: number;
  };
}

// ─── Account adjustment table ───────────────────────────────────────
// The accounts that, when present, are subtracted from Reported
// EBITDA to reach Core EBITDA. Each entry's `account` field is matched
// against `PeriodLineItem.ro_account_code` via `startsWith` so
// sub-account variants (e.g. "7588", "7811") are captured.

interface AdjustmentRule {
  /** Account-code prefix the rule matches. */
  prefix: string;
  /** Human-readable label rendered in the Reconciliation panel. */
  label: string;
}

const CORE_EBITDA_ADJUSTMENTS: AdjustmentRule[] = [
  { prefix: "758", label: "Other operating income" },
  { prefix: "781", label: "Provision reversals" },
];

// ─── Assembler ──────────────────────────────────────────────────────

/**
 * Build the canonical metric object from an ActivePeriod.
 *
 * Returns `null` when the period has no statements yet (the empty /
 * pre-upload state — no figures to canonicalise). Surfaces should
 * fall through to their existing empty-state rendering in that case.
 *
 * NEVER mutates the input. Pure read + assembly.
 */
export function buildCanonicalMetrics(period: ActivePeriod): CanonicalMetrics | null {
  if (!period.id || !period.statements) return null;

  // The engine's canonical P&L / BS / CF blobs. These are the same
  // assemblies the rest of the app reads from — we ARE the
  // consolidator, not a recomputer.
  const apl = (period.statements as unknown as { assembled_pl?: Record<string, number> }).assembled_pl ?? {};
  const abs = (period.statements as unknown as { assembled_bs?: Record<string, number> }).assembled_bs ?? {};
  // F3.16-3b.6 — pull the canonical envelope's methodology.ebitda.reported
  // (the YAML layer) when the cutover flag is on. F4.2-PARITY guarantees
  // this equals apl.ebitda_statutory ±1 RON across every fixture.
  const canonicalMethodology = (
    period.statements as unknown as {
      assembled_canonical_v1?: { methodology?: { ebitda?: { reported?: number } } };
    }
  ).assembled_canonical_v1?.methodology?.ebitda;
  const legacyReported = num(apl.ebitda_statutory) ?? num(apl.ebitda) ?? 0;
  const reported = _resolveReportedEbitda(canonicalMethodology?.reported, legacyReported);
  const revenue = num(apl.revenue) ?? 0;
  const totalOpRev = num(apl.total_operating_revenue) ?? revenue;
  const ebit = num(apl.ebit) ?? 0;
  const depreciation = num(apl.depreciation) ?? 0;
  const tax = num(apl.tax) ?? 0;
  const interestExpense = num(apl.interest_expense) ?? 0;
  const capitalizedOwnWork = num(apl.capitalized_own_work_memo) ?? 0;
  const statutoryNetProfit = num(apl.net_income_statutory) ?? 0;
  const reconstructedNetProfit = num(apl.net_income_operational) ?? num(apl.net_income) ?? statutoryNetProfit;

  // Extract 758 / 781 from the per-account line items. These are
  // already aggregated into `other_inc` in `_ro_coa.py`; we don't
  // change that math, we just SURFACE them as separate entries so
  // the bridge is auditable.
  const adjustments = extractAdjustments(period.lineItems ?? []);
  const adjustmentSum = adjustments.reduce((acc, a) => acc + a.amount, 0);
  const core = reported - adjustmentSum;

  const totalAssets = num(abs.total_assets) ?? 0;
  const totalEquity = num(abs.total_equity) ?? 0;
  const totalDebt = num(abs.total_debt) ?? 0;
  const cash = num(abs.cash) ?? 0;
  const netDebt = totalDebt - cash;

  return {
    ebitda: {
      reported,
      core,
      basis_for_valuation: "core",
      adjustments,
      reported_margin_pct: totalOpRev > 0 ? (reported / totalOpRev) * 100 : null,
      core_margin_pct: totalOpRev > 0 ? (core / totalOpRev) * 100 : null,
    },
    netProfit: {
      statutory_account_121: statutoryNetProfit,
      reconstructed: reconstructedNetProfit,
      reconciliation_gap: reconstructedNetProfit - statutoryNetProfit,
      gap_pct: statutoryNetProfit !== 0
        ? ((reconstructedNetProfit - statutoryNetProfit) / Math.abs(statutoryNetProfit)) * 100
        : null,
      anchor: "statutory_account_121",
    },
    balance: {
      total_assets: totalAssets,
      equity: totalEquity,
      total_debt: totalDebt,
      cash,
      net_debt: netDebt,
    },
    provenance: {
      source: period.source,
      company: period.statements.companyName ?? null,
      period: period.label,
      period_id: period.id,
    },
    headline: {
      revenue,
      total_operating_revenue: totalOpRev,
      ebit,
      depreciation,
      tax,
      interest_expense: interestExpense,
      capitalized_own_work_memo: capitalizedOwnWork,
    },
  };
}

/**
 * Convenience sibling — accepts the bare `/api/period/{id}` response
 * (the shape `ComprehensiveReport` already receives) and assembles the
 * canonical metrics without round-tripping through `useActivePeriod`.
 *
 * Useful for any surface that has the raw API response in hand.
 */
export function buildCanonicalMetricsFromInputs(input: {
  assembled_pl?: Record<string, number>;
  assembled_bs?: Record<string, number>;
  line_items?: PeriodLineItem[];
  company?: string | null;
  period?: string | null;
  period_id?: string | null;
  source?: string | null;
  /** F3.16-3b.6 — optional canonical envelope; when present and the
   *  cutover flag is on, `methodology.ebitda.reported` is preferred
   *  over `assembled_pl.ebitda_statutory`. */
  assembled_canonical_v1?: {
    methodology?: { ebitda?: { reported?: number } };
    [key: string]: unknown;
  };
}): CanonicalMetrics | null {
  if (!input.period_id) return null;
  const apl = input.assembled_pl ?? {};
  const abs = input.assembled_bs ?? {};
  const canonicalMethodology = input.assembled_canonical_v1?.methodology?.ebitda;

  const legacyReported = num(apl.ebitda_statutory) ?? num(apl.ebitda) ?? 0;
  const reported = _resolveReportedEbitda(canonicalMethodology?.reported, legacyReported);
  const revenue = num(apl.revenue) ?? 0;
  const totalOpRev = num(apl.total_operating_revenue) ?? revenue;
  const ebit = num(apl.ebit) ?? 0;
  const depreciation = num(apl.depreciation) ?? 0;
  const tax = num(apl.tax) ?? 0;
  const interestExpense = num(apl.interest_expense) ?? 0;
  const capitalizedOwnWork = num(apl.capitalized_own_work_memo) ?? 0;
  const statutoryNetProfit = num(apl.net_income_statutory) ?? 0;
  const reconstructedNetProfit = num(apl.net_income_operational) ?? num(apl.net_income) ?? statutoryNetProfit;

  const adjustments = extractAdjustments(input.line_items ?? []);
  const adjustmentSum = adjustments.reduce((acc, a) => acc + a.amount, 0);
  const core = reported - adjustmentSum;

  const totalAssets = num(abs.total_assets) ?? 0;
  const totalEquity = num(abs.total_equity) ?? 0;
  const totalDebt = num(abs.total_debt) ?? 0;
  const cash = num(abs.cash) ?? 0;
  const netDebt = totalDebt - cash;

  return {
    ebitda: {
      reported,
      core,
      basis_for_valuation: "core",
      adjustments,
      reported_margin_pct: totalOpRev > 0 ? (reported / totalOpRev) * 100 : null,
      core_margin_pct: totalOpRev > 0 ? (core / totalOpRev) * 100 : null,
    },
    netProfit: {
      statutory_account_121: statutoryNetProfit,
      reconstructed: reconstructedNetProfit,
      reconciliation_gap: reconstructedNetProfit - statutoryNetProfit,
      gap_pct: statutoryNetProfit !== 0
        ? ((reconstructedNetProfit - statutoryNetProfit) / Math.abs(statutoryNetProfit)) * 100
        : null,
      anchor: "statutory_account_121",
    },
    balance: {
      total_assets: totalAssets,
      equity: totalEquity,
      total_debt: totalDebt,
      cash,
      net_debt: netDebt,
    },
    provenance: {
      source: input.source ?? null,
      company: input.company ?? null,
      period: input.period ?? null,
      period_id: input.period_id,
    },
    headline: {
      revenue,
      total_operating_revenue: totalOpRev,
      ebit,
      depreciation,
      tax,
      interest_expense: interestExpense,
      capitalized_own_work_memo: capitalizedOwnWork,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  return v;
}

function extractAdjustments(lineItems: PeriodLineItem[]): CanonicalEbitdaAdjustment[] {
  const out: CanonicalEbitdaAdjustment[] = [];
  for (const rule of CORE_EBITDA_ADJUSTMENTS) {
    let sum = 0;
    let hit = false;
    for (const li of lineItems) {
      if (li.statement !== "PL") continue;
      if (!li.ro_account_code) continue;
      // `startsWith` captures 758/7581/7588/etc and 781/7811/7814/etc.
      // Same convention `_ro_coa.py` uses for its own prefix sums.
      if (li.ro_account_code.startsWith(rule.prefix)) {
        sum += li.amount;
        hit = true;
      }
    }
    if (hit && Math.abs(sum) > 0.5) {
      out.push({ account: rule.prefix, label: rule.label, amount: sum });
    }
  }
  return out;
}

// ─── Lightweight formatters (kept here for canonical-aware surfaces) ─

/** Format a RON value in compact M / K notation for KPI tiles. */
export function formatCanonicalCompact(n: number, currency = "RON"): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${currency} ${(n / 1_000).toFixed(0)}K`;
  return `${currency} ${Math.round(n)}`;
}

/** Format a RON value with thousands separators for tables. */
export function formatCanonicalFull(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

/** Format a percentage with one decimal. Null returns "—". */
export function formatCanonicalPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  return `${pct.toFixed(1)}%`;
}
