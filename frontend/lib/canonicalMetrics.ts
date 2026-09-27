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
//   Reported EBITDA      = assembled_pl.ebitda             (THE ONE EBITDA —
//                          owner ruling 2026-09-26: the stock variation 711
//                          and own work capitalised 72x inside; NULL with
//                          the engine's reason when it refused it)
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
//   reconstructed  = pretax − tax on the one definition (the result built from the accounts)
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
import { plLevelsOf, readRefusal, type ServedRefusal } from "./servedOneEbitda";

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
  legacyValue: number | null,
): number | null {
  // A REFUSED served EBITDA stays refused: the methodology block is not
  // a way around the engine's refusal (it refuses the same way).
  if (legacyValue === null) return null;
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
  /** THE ONE EBITDA as served (`assembled_pl.ebitda`: 711 and 72x inside,
   *  767 financial). NULL when the engine refused it — `refusal` says
   *  why; never a zero standing in for the refusal. */
  reported: number | null;
  /** Core / normalized EBITDA = reported − Σ adjustments (758 / 781),
   *  on the one EBITDA; null with it. */
  core: number | null;
  /** The engine's typed refusal of EBITDA, when it refused it. */
  refusal: ServedRefusal | null;
  /** Net 711 ("Variația stocurilor de produse") and net 72x as served —
   *  the two non-cash lines inside EBITDA; null when refused / absent. */
  inventory_variation: number | null;
  capitalized_own_work: number | null;
  /** Which basis valuation should default to. Always `"core"` for
   *  operating companies; the FE Valuation tab can toggle to
   *  `"reported"` as a cross-check. */
  basis_for_valuation: "core" | "reported";
  /** Itemized adjustments — drives the Reconciliation panel on the
   *  Dashboard. Each entry is subtracted from `reported` to get
   *  `core`. Empty when no non-core items are present. */
  adjustments: CanonicalEbitdaAdjustment[];
  /** Reported margin = reported ÷ NET TURNOVER × 100, in percentage
   *  points (owner ruling 2026-09-26: every margin divides by turnover —
   *  it used to divide by total operating revenue, so the report's §1 tile
   *  and its §5 ratio printed two EBITDA margins). Null when turnover is
   *  zero. */
  reported_margin_pct: number | null;
  /** Core margin = core ÷ net turnover × 100. */
  core_margin_pct: number | null;
}

export interface CanonicalNetProfit {
  /** Closing C balance of account 121 — the legally filed number.
   *  Always the headline. NULL when the engine REFUSED the net result
   *  (no account 121 and a refused net 711 — `refusal` says why). */
  statutory_account_121: number | null;
  /** Bottom-up reconstruction from class 6 / 7 movements. Should
   *  match statutory within ±2% per the methodology. Null with the
   *  refusal (the build-up lacks the unmeasured stock variation). */
  reconstructed: number | null;
  /** `reconstructed − statutory_account_121`. Surfaced honestly so
   *  any drift is visible, not hidden. Null when either side is. */
  reconciliation_gap: number | null;
  /** The engine's reason for a refused net result, or null. */
  refusal: ServedRefusal | null;
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
    /** NET TURNOVER (70x − 709) — every margin's denominator. The
     *  retired `total_operating_revenue` added 72x to it. */
    revenue: number;
    /** The operating result on the one definition; null when refused. */
    ebit: number | null;
    depreciation: number;
    tax: number;
    interest_expense: number;
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
  // F3.16-3b.6 — the canonical envelope's methodology.ebitda.reported
  // (the YAML layer) when the cutover flag is on; since the one-EBITDA
  // ruling it IS the one EBITDA (F4.2-PARITY holds it to assembled_pl).
  const canonicalMethodology = (
    period.statements as unknown as {
      assembled_canonical_v1?: { methodology?: { ebitda?: { reported?: number } } };
    }
  ).assembled_canonical_v1?.methodology?.ebitda;
  return assemble({
    apl: (period.statements as unknown as { assembled_pl?: Record<string, unknown> }).assembled_pl,
    abs: (period.statements as unknown as { assembled_bs?: Record<string, number> }).assembled_bs,
    methodologyReported: canonicalMethodology?.reported,
    lineItems: period.lineItems ?? [],
    provenance: {
      source: period.source,
      company: period.statements.companyName ?? null,
      period: period.label,
      period_id: period.id,
    },
  });
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
   *  over `assembled_pl.ebitda`. */
  assembled_canonical_v1?: {
    methodology?: { ebitda?: { reported?: number } };
    [key: string]: unknown;
  };
}): CanonicalMetrics | null {
  if (!input.period_id) return null;
  return assemble({
    apl: input.assembled_pl,
    abs: input.assembled_bs,
    methodologyReported: input.assembled_canonical_v1?.methodology?.ebitda?.reported,
    lineItems: input.line_items ?? [],
    provenance: {
      source: input.source ?? null,
      company: input.company ?? null,
      period: input.period ?? null,
      period_id: input.period_id,
    },
  });
}

/** ONE assembler for both entry points (they used to be two copies of
 *  the same body, each with its own `?? 0`). EBITDA / core / EBIT are
 *  the served one-definition figures or null with the engine's refusal;
 *  margins divide NET TURNOVER. */
function assemble(args: {
  apl: Record<string, unknown> | undefined;
  abs: Record<string, number> | undefined;
  methodologyReported: number | undefined;
  lineItems: PeriodLineItem[];
  provenance: CanonicalProvenance;
}): CanonicalMetrics {
  const apl = args.apl ?? {};
  const abs = args.abs ?? {};
  const levels = plLevelsOf({ assembled_pl: args.apl ?? {}, incomeStatement: null });
  const reported = _resolveReportedEbitda(args.methodologyReported, levels.ebitda);
  const revenue = levels.turnover;
  const ebit = levels.ebit;
  const depreciation = num(apl.depreciation) ?? 0;
  const tax = num(apl.tax) ?? 0;
  const interestExpense = num(apl.interest_expense) ?? 0;
  // A net result the engine REFUSED (no account 121, net 711 refused) is
  // null with its reason — never the `?? 0` below standing in for it.
  const netProfitRefusal = readRefusal(apl.net_income_refusal);
  const statutoryNetProfit: number | null = netProfitRefusal ? null : num(apl.net_income_statutory) ?? 0;
  // The result BUILT from the accounts on the one definition (pretax −
  // tax); the pre-ruling `net_income_operational` left 711 out of it.
  const reconstructedNetProfit: number | null = netProfitRefusal ? null : levels.netIncome ?? statutoryNetProfit;

  // Extract 758 / 781 from the per-account line items. These are
  // already aggregated into `other_inc` in `_ro_coa.py`; we don't
  // change that math, we just SURFACE them as separate entries so
  // the bridge is auditable.
  const adjustments = extractAdjustments(args.lineItems);
  const adjustmentSum = adjustments.reduce((acc, a) => acc + a.amount, 0);
  const core = reported === null ? null : reported - adjustmentSum;

  const totalAssets = num(abs.total_assets) ?? 0;
  const totalEquity = num(abs.total_equity) ?? 0;
  const totalDebt = num(abs.total_debt) ?? 0;
  const cash = num(abs.cash) ?? 0;
  const netDebt = totalDebt - cash;

  return {
    ebitda: {
      reported,
      core,
      refusal: reported === null ? levels.refusal : null,
      inventory_variation: levels.inventoryVariation,
      capitalized_own_work: levels.capitalizedOwnWork,
      basis_for_valuation: "core",
      adjustments,
      reported_margin_pct: reported !== null && revenue > 0 ? (reported / revenue) * 100 : null,
      core_margin_pct: core !== null && revenue > 0 ? (core / revenue) * 100 : null,
    },
    netProfit: {
      statutory_account_121: statutoryNetProfit,
      reconstructed: reconstructedNetProfit,
      reconciliation_gap:
        reconstructedNetProfit === null || statutoryNetProfit === null
          ? null
          : reconstructedNetProfit - statutoryNetProfit,
      gap_pct: reconstructedNetProfit !== null && statutoryNetProfit !== null && statutoryNetProfit !== 0
        ? ((reconstructedNetProfit - statutoryNetProfit) / Math.abs(statutoryNetProfit)) * 100
        : null,
      refusal: netProfitRefusal,
      anchor: "statutory_account_121",
    },
    balance: {
      total_assets: totalAssets,
      equity: totalEquity,
      total_debt: totalDebt,
      cash,
      net_debt: netDebt,
    },
    provenance: args.provenance,
    headline: {
      revenue,
      ebit,
      depreciation,
      tax,
      interest_expense: interestExpense,
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
