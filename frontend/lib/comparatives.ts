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
//    number built a different way. A row whose figure folds in more than
//    its engine line — "Total operating revenue" is net turnover plus 722
//    — is held, before that, to the definition guard: the extra components
//    must be zero in BOTH periods (PL_ROW_DEFINITION_FOLDS).
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
import { servedPlAmount } from "@/lib/plStructure";
import type {
  ExportComparisonState,
  PriorServedFigures,
  Statements,
} from "@/lib/financialReport";
import type { RatioComparisonV1 } from "@/lib/ratioTable";
// Runtime import, measured cycle-free: nothing servedFacts reaches at
// runtime imports this module (servedFacts ⇄ financialReport is the one
// pre-existing, call-time-only cycle, and this edge does not join it).
import { factsFrom } from "@/lib/servedFacts";
import { currentOrgId, getSupabase } from "@/lib/supabase";

// ── Engine document (mirrors src/engine/api/_comparatives.py) ─────────

export type DetailLevelName = "synthetic" | "analytic" | "mixed" | "indeterminate";

export interface DetailLevelDto {
  level: DetailLevelName;
  modal_depth: number | null;
  reason: string;
  signals: Record<string, unknown>;
}

/** The document a period's figures were read from — served beside the
 *  period so a compare column can be traced to the file it compares
 *  against. `null` on an engine that predates the field. */
export interface ComparativeSourceDocumentDto {
  id: string | null;
  filename: string | null;
  detected_type: string | null;
}

export interface ComparativePeriodDto {
  period_id: string;
  period_end: string | null;
  period_start: string | null;
  currency: string | null;
  label: string;
  company_name: string | null;
  detail_level: DetailLevelDto;
  source_document?: ComparativeSourceDocumentDto | null;
}

/**
 * The one line that names WHICH BOOK a compare column holds: the source
 * document's filename, or nothing. Shown as the column header's title.
 *
 * Why it exists: a period is a slot in a workspace, and the file in that
 * slot can change — `stage_persist`'s same-month replace re-points a
 * month at whatever was uploaded for it last. When it does, the compare
 * column faithfully prints the new file's figures under the old month
 * label, and nothing on screen said which file that was (2026-09-23:
 * another company's balanță served as "Dec 2025" beside this company's
 * Dec 2024). The filename is not an identity check — that is the
 * workspace lane's — but it is the fact a reader can verify.
 */
export function sourceDocumentLine(period: ComparativePeriodDto | null | undefined): string | undefined {
  const name = period?.source_document?.filename;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
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
    // The file behind each column, as the served document names it
    // (`sourceDocumentLine`): the report's and the workbook's column
    // headers carry it as their title, exactly as the dashboard's compare
    // headers do. Null, never invented, when the engine served none.
    sourceDocument: sourceDocumentLine(doc.current) ?? statements.sourceDocument ?? null,
    prior: {
      periodLabel: doc.prior.label,
      sourceDocument: sourceDocumentLine(doc.prior) ?? null,
      balanceSheet: ps.balanceSheet,
      incomeStatement: ps.incomeStatement,
      // The served prior P&L rides along so the workbook's "account 121,
      // as filed" prior cell can read the FILED prior profit. The prior's
      // `assembled_bs` / `canonical_bs` deliberately do NOT: the prior's
      // balance-sheet figures travel only as the resolved `served` totals
      // below, so no consumer grows a second prior-BS read path.
      ...(isPlainRecord(ps.assembled_pl) ? { assembled_pl: ps.assembled_pl } : {}),
      served: priorServedFiguresOf(ps),
    },
    comparatives: doc,
    comparison: { kind: "served" },
  };
}

function isPlainRecord(v: unknown): v is Record<string, number> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * THE PRIOR'S HEADLINE FIGURES, THROUGH THE CURRENT PERIOD'S AUTHORITIES.
 *
 * Live, on Scandia Dec 2025 vs Dec 2024, the CFO Report's "vs prior
 * period" strip printed net income +7,511,697 (+25.7%) and total assets
 * +7,031,375 (+2.5%) — the prior side read `deriveTotals` over the prior's
 * legacy buckets: the class-6/7 RECONSTRUCTION of profit (29,275,655.32)
 * under a line whose current side is account 121 as filed, and a bucket
 * sum (285,875,010) that drops the prior's 216,194.00 "Unclassified —
 * debit side" row. The dashboard's own bridges already quoted the filed
 * 32,108,059.51 and the served 286,091,204.09. The current side of that
 * strip is `assembled_pl.net_income_statutory` and `factsFrom(s)`; this
 * resolves the prior through exactly those, so the subtraction is
 * like-for-like.
 */
export function priorServedFiguresOf(ps: Statements): PriorServedFigures {
  const sf = factsFrom(ps);
  return {
    net_income: finiteOrNull(
      (ps.assembled_pl as Record<string, unknown> | undefined)?.net_income_statutory,
    ),
    total_assets: finiteOrNull(sf.totalAssets()),
    total_equity: finiteOrNull(sf.totalEquity()),
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
 * P&L rows → engine keys. An entry names the engine line that IS the row's
 * figure BY DEFINITION. frontend/lib/__tests__/comparatives.test.ts
 * measures every aggregates-path entry against the real analytic book —
 * equal to the cent, or (the FE-composed rows, and the two 758 rows, whose
 * bucket also holds the 781 reversals on that book) refused by the guard;
 * plCompareSubtotals.test.tsx holds both builders to their keys. The
 * render-time parity guard below is what makes a wrong entry harmless
 * rather than wrong.
 *
 * Keys are the `bucket` a P&L row carries (items) or the section's
 * `subtotalBucket` (subtotals). Both builders stamp these; `interestIncome`
 * and `opexThirdParty` only the line-item builder, which alone shows 766
 * and 628 on rows of their own, and `financialIncomeTotal` only the
 * aggregates builder, whose financial-income row is the whole 76x family.
 *
 * DELIBERATELY UNKEYED (no engine line is the same figure by definition):
 * the 722 capitalized-own-work line (no engine line); the line-item
 * builder's 706 / 708 / 767 revenue lines, its per-account operating
 * costs other than 628, its dividend, FX-gain and FX-loss rows (no engine
 * line of their own); "Total operating expenses (cash)" on both paths
 * (cost of goods sold PLUS operating expenses — the engine serves the two
 * separately); and the aggregates "FX losses & other financial expense"
 * row, which excludes interest while the engine's `pl.financial_expense`
 * includes it.
 */
export const PL_ROW_TO_KEY: Readonly<Record<string, string>> = {
  revenueTurnover: "pl.revenue",
  // "Total operating revenue" — held to PL_ROW_DEFINITION_FOLDS as well.
  revenue: "pl.revenue",
  otherOperatingIncome: "pl.other_operating_income",
  otherOperatingIncomeTotal: "pl.other_operating_income",
  cogs: "pl.cogs",
  opexTotal: "pl.opex_total",
  opexThirdParty: "pl.opex_third_party",
  depreciationAmortization: "pl.depreciation",
  ebitda: "pl.ebitda",
  ebit: "pl.ebit",
  financialIncomeTotal: "pl.financial_income",
  interestIncome: "pl.interest_income",
  interestExpense: "pl.interest_expense",
  netFinancialResult: "pl.net_financial_result",
  pretax: "pl.pretax",
  taxExpense: "pl.tax",
  netIncomeOperational: "pl.net_income_operational",
  netIncomeStatutory: "pl.net_income",
};

/**
 * ROWS WHOSE FIGURE FOLDS IN MORE THAN THEIR ENGINE LINE. "Total operating
 * revenue" is net turnover PLUS capitalized own work (722) — and, on the
 * line-item path, discounts received (767), which that builder declares on
 * its section (`PLSection.subtotalFolds`). Its figure can equal the
 * engine's net turnover to the cent in the current period while the prior
 * period's total held 722: the prior cell would then print net turnover
 * under a total that includes 722. So such a row carries the engine's
 * cells only while EVERY component — those listed here, which are
 * required, and any its builder declares — is zero in BOTH periods: the
 * current's as the builder states it, the prior's as the served
 * comparatives document carries it (`prior_statements.assembled_pl`, read
 * under the served contract, `servedPlAmount`). Otherwise the cells say
 * the definition differs.
 *
 * Keyed like PL_ROW_TO_KEY; the components are served `assembled_pl`
 * fields.
 */
export const PL_ROW_DEFINITION_FOLDS: Readonly<Record<string, readonly string[]>> = {
  revenue: ["capitalized_own_work_memo"],
};

/** What the definition guard reads for one row: the components the row
 *  folds in, as its builder states them for the CURRENT period
 *  (`PLSection.subtotalFolds`), and the served comparatives document's
 *  `prior_statements` — the block the PRIOR's amounts are read from. */
export interface RowDefinition {
  folds?: Readonly<Record<string, number | null>> | null;
  priorStatements?: unknown;
}

/** Half a cent — the engine's own zero floor, the same meaning here
 *  (packs/serving/change_kind.yaml#rounded_money_zero_floor, which the
 *  engine test holds equal to comparatives' PCT_BASE_FLOOR). */
export const PARITY_FLOOR = ROUNDED_MONEY_ZERO_FLOOR;

export type CellOutcome =
  | { kind: "cell"; cell: ComparativeCell }
  /** `rowAmount` is null only when a row with no readable figure is
   *  refused by the definition guard. */
  | { kind: "definition_differs"; rowAmount: number | null; engineCurrent: number | null; key: string }
  | { kind: "unmapped" };

/** Half a cent or more, or unreadable (null): the component is carried. */
function carriesComponent(amount: number | null | undefined): boolean {
  return typeof amount !== "number" || !Number.isFinite(amount) || Math.abs(amount) >= PARITY_FLOOR;
}

/**
 * THE PARITY GUARD. A row may carry the engine's cells only if the number
 * the row shows IS the engine's current figure for that line. Otherwise
 * the cells stay blank and say why — never a prior beside a differently
 * built current.
 *
 * Ahead of it, THE DEFINITION GUARD (PL_ROW_DEFINITION_FOLDS): a row whose
 * figure folds in components beyond its engine line carries the cells
 * only while every such component is zero in both periods. A component
 * the builder did not state for the current period is unreadable, and so
 * is carried.
 */
export function cellForRow(
  cells: Map<string, ComparativeCell> | null,
  rowKey: string | undefined,
  rowAmount: number | null | undefined,
  definition?: RowDefinition | null,
): CellOutcome {
  if (!cells || !rowKey) return { kind: "unmapped" };
  const key = PL_ROW_TO_KEY[rowKey] ?? (rowKey.includes(".") ? rowKey : undefined);
  if (!key) return { kind: "unmapped" };
  const cell = cells.get(key);
  if (!cell) return { kind: "unmapped" };
  const folds = definition?.folds ?? null;
  const components = new Set([...(PL_ROW_DEFINITION_FOLDS[rowKey] ?? []), ...Object.keys(folds ?? {})]);
  if (components.size > 0) {
    const priorPl = isPlainRecord(definition?.priorStatements)
      ? (definition!.priorStatements as Record<string, unknown>).assembled_pl
      : undefined;
    for (const component of components) {
      const current = folds?.[component];
      if (carriesComponent(current) || carriesComponent(servedPlAmount(priorPl, component))) {
        return {
          kind: "definition_differs",
          rowAmount: typeof rowAmount === "number" && Number.isFinite(rowAmount) ? rowAmount : null,
          engineCurrent: cell.current,
          key,
        };
      }
    }
  }
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
