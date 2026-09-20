// comparatives.ts — two periods of one workspace, side by side, on screen.
//
// THE DATA is the engine's: `GET /api/period/{id}/comparatives?prior=`
// (src/engine/api/_comparatives.py) computes the column model, common
// size in percentage POINTS, the three variance bridges and the movers
// over exactly the envelopes the dashboard renders. This module fetches
// that document, picks a sensible default prior, and hands the statement
// views the cells they may paint — and only those.
//
// THREE RULES THE VIEWS INHERIT FROM HERE.
//
// 1. A CELL RENDERS ONLY ON A ROW WHOSE DEFINITION IS THE ENGINE'S. The
//    P&L views build their rows from persisted buckets; the engine's
//    comparative lines are assembled fields. On the real analytic book
//    revenue, cogs, operating expenses, D&A and tax agree to the cent and
//    "other operating income" / the financial rows do not (the persisted
//    otherIncome carries the 711 memo and 781 reversals). So every mapped
//    row is guarded at render time: the row's own amount must equal the
//    engine column's `current` to the cent, or the cells stay blank with a
//    reason. A mapping mistake can never paint a prior figure beside a
//    number built a different way.
//
// 2. ABSENT IS NOT ZERO. `absent_prior` renders "new", `absent_current`
//    renders "no longer present", `not_disclosed_at_this_detail_level`
//    says so. None of them renders a delta, a percentage, or a share
//    change.
//
// 3. THE PERCENTAGE COLUMN IS THE ENGINE'S. The FE never divides two
//    numbers to make a Δ%; it prints `delta_pct` or the engine's reason
//    for withholding it (a zero base has none).
//
// 4. A SIGN FLIP IS WORDS (plan_contract_v2 section 7, B1). The engine's
//    columns carry `change_kind` from the one classifier; a move from
//    zero, to zero or across sign has no `delta_pct` and the cell renders
//    "turned negative" / "from zero" / … beside the Δ amount — never a
//    percent and never a multiplier (defect 0.4).

import { useQuery } from "@tanstack/react-query";

import type { PeriodLineItem } from "@/lib/activePeriod";
import type { OrgPeriod } from "@/lib/orgPeriods";
import { ROUNDED_MONEY_ZERO_FLOOR, type ChangeKind } from "@/lib/changeKind";
import type { ExportComparisonState, Statements } from "@/lib/financialReport";
import type { RatioComparisonV1 } from "@/lib/ratioTable";
import { currentOrgId, getSupabase } from "@/lib/supabase";

// ── Engine document (mirrors src/engine/api/_comparatives.py) ─────────

export type DetailLevelName = "synthetic" | "analytic" | "mixed" | "indeterminate";

export interface DetailLevelDto {
  level: DetailLevelName;
  modal_depth: number | null;
  reason: string;
  signals: Record<string, unknown>;
}

export interface ComparativePeriodDto {
  period_id: string;
  period_end: string | null;
  period_start: string | null;
  currency: string | null;
  label: string;
  company_name: string | null;
  detail_level: DetailLevelDto;
}

export type ComparativeStatus =
  | "compared"
  | "compared_no_base"
  | "absent_prior"
  | "absent_current"
  | "absent_both"
  | "not_disclosed_at_this_detail_level"
  | "incomparable";

export interface ComparativeColumnDto {
  key: string;
  statement: "PL" | "BS";
  label: string;
  unit: string;
  requires: string;
  current: number | null;
  prior: number | null;
  delta: number | null;
  delta_pct: number | null;
  current_disclosure: string;
  prior_disclosure: string;
  status: ComparativeStatus;
  note: string;
  /** engine.serving.change_kind: set only on compared / compared_no_base. */
  change_kind?: ChangeKind | null;
}

export interface CommonSizeRowDto {
  key: string;
  statement: "PL" | "BS";
  base_key: string;
  current_share: number | null;
  prior_share: number | null;
  /** Percentage POINTS. */
  delta_pts: number | null;
  status: string;
  note: string;
}

export interface BridgeStepDto {
  key: string;
  label: string;
  amount: number;
  current: number | null;
  prior: number | null;
  status: "delta" | "new" | "gone" | "none";
}

export interface BridgeDto {
  statement: "PL" | "BS";
  from_label: string;
  to_label: string;
  prior_total: number | null;
  current_total: number | null;
  steps: BridgeStepDto[];
  residual: number | null;
  closes: boolean;
  reason: string;
}

export interface MoverDto {
  key: string;
  statement: "PL" | "BS";
  label: string;
  current: number | null;
  prior: number | null;
  delta: number | null;
  delta_pct: number | null;
  materiality: number;
  base_key: string;
  favorable: "up" | "down" | null;
  verdict: "improved" | "deteriorated" | null;
  status: ComparativeStatus;
}

export interface MoversDto {
  materiality_floor: number;
  bases: Record<string, [string, number | null]>;
  top: MoverDto[];
  improved: MoverDto[];
  deteriorated: MoverDto[];
  below_floor: number;
}

export interface PriorCanonicalBsDto {
  rows: Record<string, { amount: number | null; section: string | null; label: string | null }>;
  sections: Record<string, number | null>;
  /** Totals as the engine's serving gateway serves them (never raw canonical_bs totals). */
  facts: { assets?: number; equity_plus_liabilities?: number };
  status: string | null;
}

export interface ComparativesResponse {
  current: ComparativePeriodDto;
  prior: ComparativePeriodDto;
  comparability: {
    comparable: boolean;
    level: string | null;
    current_level: string;
    prior_level: string;
    statement_lines: boolean;
    analytic_detail: boolean;
    reason: string;
  };
  coverage_source: { current: string; prior: string };
  columns: ComparativeColumnDto[];
  common_size: CommonSizeRowDto[];
  bridges: { pl: BridgeDto; bs_assets: BridgeDto; bs_liabilities_equity: BridgeDto };
  movers: MoversDto;
  prior_canonical_bs: PriorCanonicalBsDto | null;
  /** The prior period's served `statements` block, verbatim. */
  prior_statements: Record<string, unknown>;
  prior_line_items: PeriodLineItem[];
  prior_metrics: { name: string; value: number | null }[];
  /** The two-period ratio block (src/engine/comparatives/ratio_compare.py):
   *  both periods' ratios, bands, changes, band movements and credit
   *  composites. Optional at this boundary because an engine that predates
   *  the block serves none; `readRatioComparison` (ratioCompareView.ts)
   *  shape-checks it and the Ratios tab states its absence. */
  ratios?: RatioComparisonV1 | null;
}

export type ComparativesFetch =
  | { kind: "ok"; data: ComparativesResponse }
  | { kind: "refused"; code: string; message: string }
  | { kind: "error"; status: number };

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

export async function fetchComparatives(periodId: string, priorId: string): Promise<ComparativesFetch> {
  const supabase = getSupabase();
  if (!supabase) return { kind: "error", status: 0 };
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { kind: "error", status: 401 };
  // The route resolves the caller's ACTIVE workspace from this header and
  // requires both periods to live in it. Without the header the engine
  // falls back to the oldest membership — wrong for anyone with two
  // workspaces — so it is always sent.
  const orgId = await currentOrgId();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (orgId) headers["X-Org-Id"] = orgId;
  const url = `${API_URL}/api/period/${encodeURIComponent(periodId)}/comparatives?prior=${encodeURIComponent(priorId)}`;
  try {
    const res = await fetch(url, { headers });
    if (res.ok) return { kind: "ok", data: (await res.json()) as ComparativesResponse };
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    const detail = (body as { detail?: { code?: string; message?: string } } | null)?.detail;
    if (detail && typeof detail === "object" && typeof detail.code === "string") {
      return { kind: "refused", code: detail.code, message: detail.message ?? detail.code };
    }
    return { kind: "error", status: res.status };
  } catch {
    return { kind: "error", status: 0 };
  }
}

export const comparativesQueryKey = (periodId: string, priorId: string) =>
  ["comparatives", periodId, priorId] as const;

export function useComparatives(periodId: string | null, priorId: string | null) {
  return useQuery({
    queryKey: comparativesQueryKey(periodId ?? "", priorId ?? ""),
    queryFn: () => fetchComparatives(periodId!, priorId!),
    enabled: !!periodId && !!priorId && periodId !== priorId,
    staleTime: 5 * 60_000,
  });
}

// ── What the exports receive ─────────────────────────────────────────

/** The statements the Export tab hands the report and the workbook. */
export type StatementsForExport = Statements & {
  /** The SERVED comparatives document, verbatim (null without a
   *  comparison): the exports print its ratio rows instead of rebuilding a
   *  prior of their own. */
  comparatives: ComparativesResponse | null;
  /** The comparison request's outcome — served, refused, failed, pending
   *  or none — so an export built while the engine refused or the request
   *  failed states THAT, not "no prior period was supplied". */
  comparison: ExportComparisonState;
};

/**
 * `statements.prior` (the prior's statements, read by reportComparatives
 * and financialExports) is set only when a comparison is loaded, so a
 * single-period report still says "no prior period" in words; the served
 * document rides along as `comparatives` either way (null without one).
 */
export function statementsForExportOf(
  statements: Statements | null,
  doc: ComparativesResponse | null,
  /** The outcome when no document is served (refused / failed / pending);
   *  `none` when omitted. Ignored when a document is served. */
  outcome: ExportComparisonState | null = null,
): StatementsForExport | null {
  if (!statements) return null;
  const ps = doc?.prior_statements as unknown as Statements | undefined;
  if (!doc || !ps || !ps.incomeStatement || !ps.balanceSheet) {
    return { ...statements, comparatives: null, comparison: outcome ?? { kind: "none" } };
  }
  return {
    ...statements,
    prior: {
      periodLabel: doc.prior.label,
      balanceSheet: ps.balanceSheet,
      incomeStatement: ps.incomeStatement,
    },
    comparatives: doc,
    comparison: { kind: "served" },
  };
}

// ── Default prior: the previous fiscal year-end ──────────────────────

/**
 * The period a reader means by "last year": the nearest EARLIER period
 * that closes on the same month/day (a Dec-2024 close for a Dec-2025
 * close). Failing that, the nearest earlier period of any kind. Never the
 * current period, never a later one. Deterministic over the list order.
 */
export function pickDefaultPrior(
  periods: readonly OrgPeriod[],
  currentId: string | null,
  currentEnd: string | null,
): OrgPeriod | null {
  if (!currentId || !currentEnd) return null;
  const earlier = periods
    .filter((p) => p.period_id !== currentId && !!p.period_end && p.period_end < currentEnd)
    .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));
  if (earlier.length === 0) return null;
  const cut = currentEnd.slice(5); // "MM-DD"
  return earlier.find((p) => (p.period_end ?? "").slice(5) === cut) ?? earlier[0];
}

// ── Cells the views may paint ────────────────────────────────────────

export interface ComparativeCell {
  key: string;
  status: ComparativeStatus;
  current: number | null;
  prior: number | null;
  delta: number | null;
  deltaPct: number | null;
  /** The classifier's kind, as the engine served it (null on a refusal). */
  changeKind?: ChangeKind | null;
  /** Share of the statement base (revenue / total assets), current and prior. */
  currentShare: number | null;
  priorShare: number | null;
  /** Change in percentage POINTS. */
  deltaPts: number | null;
  note: string;
}

/** Index the engine document by line key. */
export function indexCells(doc: ComparativesResponse): Map<string, ComparativeCell> {
  const shares = new Map(doc.common_size.map((r) => [r.key, r]));
  const out = new Map<string, ComparativeCell>();
  for (const c of doc.columns) {
    const s = shares.get(c.key);
    out.set(c.key, {
      key: c.key,
      status: c.status,
      current: c.current,
      prior: c.prior,
      delta: c.delta,
      deltaPct: c.delta_pct,
      changeKind: c.change_kind ?? null,
      currentShare: s?.current_share ?? null,
      priorShare: s?.prior_share ?? null,
      deltaPts: s?.delta_pts ?? null,
      note: c.note,
    });
  }
  return out;
}

/**
 * P&L rows → engine keys. Every entry here was MEASURED equal to the cent
 * on the real analytic book (frontend/lib/__tests__/comparatives.test.ts
 * keeps it measured); the render-time parity guard below is what makes
 * a wrong entry harmless rather than wrong.
 *
 * Keys are the `bucket` a P&L row carries (items) or the section's
 * `subtotalBucket` (subtotals). The aggregates builder stamps these.
 */
export const PL_ROW_TO_KEY: Readonly<Record<string, string>> = {
  revenue706: "pl.revenue",
  cogs: "pl.cogs",
  opexTotal: "pl.opex_total",
  depreciationAmortization: "pl.depreciation",
  ebitda: "pl.ebitda",
  ebit: "pl.ebit",
  netFinancialResult: "pl.net_financial_result",
  pretax: "pl.pretax",
  taxExpense: "pl.tax",
  netIncomeOperational: "pl.net_income_operational",
  netIncomeStatutory: "pl.net_income",
};

/** Half a cent — the engine's own zero floor, the same meaning here
 *  (packs/serving/change_kind.yaml#rounded_money_zero_floor, which the
 *  engine test holds equal to comparatives' PCT_BASE_FLOOR). */
export const PARITY_FLOOR = ROUNDED_MONEY_ZERO_FLOOR;

export type CellOutcome =
  | { kind: "cell"; cell: ComparativeCell }
  | { kind: "definition_differs"; rowAmount: number; engineCurrent: number | null; key: string }
  | { kind: "unmapped" };

/**
 * THE PARITY GUARD. A row may carry the engine's cells only if the number
 * the row shows IS the engine's current figure for that line. Otherwise
 * the cells stay blank and say why — never a prior beside a differently
 * built current.
 */
export function cellForRow(
  cells: Map<string, ComparativeCell> | null,
  rowKey: string | undefined,
  rowAmount: number | null | undefined,
): CellOutcome {
  if (!cells || !rowKey) return { kind: "unmapped" };
  const key = PL_ROW_TO_KEY[rowKey] ?? (rowKey.includes(".") ? rowKey : undefined);
  if (!key) return { kind: "unmapped" };
  const cell = cells.get(key);
  if (!cell) return { kind: "unmapped" };
  if (typeof rowAmount !== "number" || !Number.isFinite(rowAmount)) {
    return { kind: "cell", cell };
  }
  if (cell.current === null) {
    // The engine reports the current side absent; a row that shows a
    // number for it is built another way.
    return Math.abs(rowAmount) < PARITY_FLOOR
      ? { kind: "cell", cell }
      : { kind: "definition_differs", rowAmount, engineCurrent: null, key };
  }
  if (Math.abs(Math.abs(rowAmount) - Math.abs(cell.current)) >= PARITY_FLOOR) {
    return { kind: "definition_differs", rowAmount, engineCurrent: cell.current, key };
  }
  return { kind: "cell", cell };
}

// ── Balance sheet: opening column from the prior canonical rows ──────

export interface BsOpeningFill {
  /** row id → prior closing amount. */
  rows: Map<string, number>;
  /** section id → prior subtotal. */
  sections: Map<string, number>;
  totalAssets: number | null;
  totalEquityLiab: number | null;
  /** Row ids present in the current period only (absent prior) — the
   *  view keeps them blank; this is for the reader's note. */
  priorLabel: string;
}

export function bsOpeningFill(doc: ComparativesResponse): BsOpeningFill | null {
  const pcb = doc.prior_canonical_bs;
  if (!pcb) return null;
  const rows = new Map<string, number>();
  for (const [id, r] of Object.entries(pcb.rows)) {
    if (typeof r.amount === "number" && Number.isFinite(r.amount)) rows.set(id, r.amount);
  }
  const sections = new Map<string, number>();
  for (const [id, v] of Object.entries(pcb.sections)) {
    if (typeof v === "number" && Number.isFinite(v)) sections.set(id, v);
  }
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    rows,
    sections,
    totalAssets: num(pcb.facts.assets),
    totalEquityLiab: num(pcb.facts.equity_plus_liabilities),
    priorLabel: doc.prior.label,
  };
}

// ── Formatting ───────────────────────────────────────────────────────

/** Δ% as the engine gave it, or null (the caller prints the reason). */
export function formatDeltaPct(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  const pct = v * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function formatShare(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  return `${(v * 100).toFixed(1)}%`;
}

export function formatPts(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)} pp`;
}

export function detailLevelLabelKey(level: DetailLevelName | string): string {
  switch (level) {
    case "synthetic": return "statements.cmp.levelSynthetic";
    case "analytic": return "statements.cmp.levelAnalytic";
    case "mixed": return "statements.cmp.levelMixed";
    default: return "statements.cmp.levelIndeterminate";
  }
}
