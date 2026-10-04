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
//    otherIncome carries the 781 reversals). So every mapped row is
//    guarded at render time: the row's own amount must equal the engine
//    column's `current` to the cent, or the cells stay blank with a
//    reason. A mapping mistake can never paint a prior figure beside a
//    number built a different way. A row on THE ONE EBITDA (EBITDA, EBIT,
//    profit before tax, the stock variation, own work capitalised) is held,
//    before that, to the definition guard: the prior's served block must be
//    on the same EBITDA definition as the current's
//    (PL_ROW_ONE_EBITDA_KEYS).
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

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { PeriodLineItem } from "@/lib/activePeriod";
import { authOrgHeaders } from "@/lib/apiHeaders";
import { useCompanyPeriods, type CompanyPeriods, type OrgPeriod } from "@/lib/orgPeriods";
import { ROUNDED_MONEY_ZERO_FLOOR, type ChangeKind } from "@/lib/changeKind";
import { moneyLocaleFor } from "@/lib/money";
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
  | "incomparable"
  // engine STATUS_REFUSED (owner ruling 2026-09-26): the assembly refused
  // the figure (the one EBITDA when the stock variation cannot be measured);
  // no movement, the note carries the reason.
  | "refused";

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
  /** `message` is the engine's diagnostic line — it can carry a raw period
   *  id and is never printed: every surface prints the sentence for `code`
   *  (lib/comparisonRefusal.ts). */
  | { kind: "refused"; code: string; message: string }
  | { kind: "error"; status: number };

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

/**
 * The engine's comparison of two periods of ONE company. `orgId` is that
 * company, sent as X-Org-Id: the route requires both periods to live in it
 * (and validates the caller's membership). It used to be the active workspace
 * read at request time — which, mid-switch, is the NEXT company.
 */
export async function fetchComparatives(periodId: string, priorId: string, orgId: string): Promise<ComparativesFetch> {
  const headers = await authOrgHeaders();
  if (!headers) return { kind: "error", status: 401 };
  headers["X-Org-Id"] = orgId;
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

/** The company is in the key: one company's comparison is never served
 *  from another company's cache entry. */
export const comparativesQueryKey = (orgId: string, periodId: string, priorId: string) =>
  ["comparatives", orgId, periodId, priorId] as const;

/** The comparison of `periodId` with `priorId`, both of company `orgId` —
 *  requested only when all three are known and the two periods differ. */
export function useComparatives(periodId: string | null, priorId: string | null, orgId: string | null) {
  return useQuery({
    queryKey: comparativesQueryKey(orgId ?? "", periodId ?? "", priorId ?? ""),
    queryFn: () => fetchComparatives(periodId!, priorId!, orgId!),
    enabled: !!orgId && !!periodId && !!priorId && periodId !== priorId,
    staleTime: 5 * 60_000,
  });
}

// ── Which prior: ONLY one of the current company's own periods ────────

/** What the page compares the period on screen with, and among what. */
export interface ComparisonChoice {
  /** The company both periods belong to; null while that is not known —
   *  and then nothing is requested. */
  companyId: string | null;
  /** That company's analysed periods, newest first (the picker's list). */
  periods: OrgPeriod[];
  /** What AUTO resolves to right now. */
  autoPick: OrgPeriod | null;
  /** The prior to request, or null: none, comparisons off, or not yet known. */
  priorId: string | null;
}

export interface ComparisonChoiceInput {
  /** The period on screen, and its end date. */
  currentId: string | null;
  currentEnd: string | null;
  /** The company the period on screen belongs to (the served payload's
   *  `organization.id`). */
  currentOrgId: string | null;
  /** The company open now. */
  activeOrgId: string | null;
  /** The reader's stored choice for the company open now: a period id, null
   *  (AUTO) or "none" (comparisons off). */
  stored: string | null | "none";
}

/**
 * THE RULE (2026-09-26, the live walkthrough: EEI's Overview printed "No
 * comparison: period '<uuid>' is not in this workspace" — a period of
 * Scandia's, carried over from the dashboard opened before). The prior is
 * chosen ONLY among the periods of the company the period on screen belongs
 * to:
 *   · the company is known, and is the company open now — otherwise no
 *     comparison is requested at all (a switch is still settling);
 *   · the candidate list is THAT company's (`company.orgId` must name it);
 *   · a stored choice that is not one of them is ignored silently, and AUTO
 *     applies — the previous fiscal year-end of the same company;
 *   · a company with one period has no prior: no request, no error.
 * Pure: `company` is what `useCompanyPeriods(companyId)` answered.
 */
export function comparisonChoiceOf(
  input: ComparisonChoiceInput,
  company: CompanyPeriods | null | undefined,
): ComparisonChoice {
  const companyId =
    input.currentOrgId && input.currentOrgId === input.activeOrgId ? input.currentOrgId : null;
  const none: ComparisonChoice = { companyId, periods: [], autoPick: null, priorId: null };
  if (!companyId || !company || company.orgId !== companyId) return none;
  const periods = company.periods;
  const autoPick = pickDefaultPrior(periods, input.currentId, input.currentEnd);
  if (!input.currentId || input.stored === "none") return { companyId, periods, autoPick, priorId: null };
  const stored =
    typeof input.stored === "string" && input.stored !== input.currentId
      ? periods.find((p) => p.period_id === input.stored) ?? null
      : null;
  return { companyId, periods, autoPick, priorId: (stored ?? autoPick)?.period_id ?? null };
}

/** `comparisonChoiceOf` over the current company's own period list (keyed
 *  by that company). */
export function useComparisonChoice(input: ComparisonChoiceInput): ComparisonChoice {
  const companyId =
    input.currentOrgId && input.currentOrgId === input.activeOrgId ? input.currentOrgId : null;
  const { data } = useCompanyPeriods(companyId);
  const { currentId, currentEnd, currentOrgId, activeOrgId, stored } = input;
  return useMemo(
    () => comparisonChoiceOf({ currentId, currentEnd, currentOrgId, activeOrgId, stored }, data ?? null),
    [currentId, currentEnd, currentOrgId, activeOrgId, stored, data],
  );
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

// ── Default prior: the same company's previous period of the same length ─

/** "MM-DD" of an ISO date, with every month's last day read as "MM-end" —
 *  28 February 2025 and 29 February 2024 close the same month. */
function cutOf(iso: string | null | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(5, 7)}-${d === last ? "end" : iso.slice(8, 10)}`;
}

/**
 * The period a reader means by "last year" (owner rule, 2026-09-26: the
 * dashboard compares every period BY DEFAULT with the same company's
 * immediately preceding period of the SAME LENGTH, when one exists): the
 * nearest EARLIER period that closes on the same month/day — a Dec-2024 close
 * for a Dec-2025 close, an Aug-2024 year-to-date for an Aug-2025 one — and,
 * when both starts are known, opens on the same month/day too. A Romanian
 * balance is cumulative, so a Nov-2025 close is eleven months, not the year
 * before a December: a period of another length is never the default (it is
 * still one pick away in "Compare with"). Never the current period, never a
 * later one; null when no such period exists. Deterministic over the list.
 */
export function pickDefaultPrior(
  periods: readonly OrgPeriod[],
  currentId: string | null,
  currentEnd: string | null,
): OrgPeriod | null {
  if (!currentId || !currentEnd) return null;
  const endCut = cutOf(currentEnd);
  if (!endCut) return null;
  const startCut = cutOf(periods.find((p) => p.period_id === currentId)?.period_start ?? null);
  const sameLength = (p: OrgPeriod) => {
    if (cutOf(p.period_end) !== endCut) return false;
    const start = cutOf(p.period_start ?? null);
    return !startCut || !start || start === startCut;
  };
  const earlier = periods
    .filter((p) => p.period_id !== currentId && !!p.period_end && p.period_end < currentEnd && sameLength(p))
    .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));
  return earlier[0] ?? null;
}

/**
 * The close a reader means by "the previous year" for a period closing on
 * `currentEnd`: the same month, one year earlier — a month's last day stays
 * the month's last day (28 Feb 2025 → 29 Feb 2024). Null for a date that
 * cannot be read.
 *
 * It names the period AUTO looked for when `pickDefaultPrior` found none
 * (2026-10-04, production: a company whose earliest period was on screen —
 * the picker said "Previous year (auto)", the four column boxes were ticked,
 * and the statements showed one column with no word about why). The picker
 * and its notice say which balance is missing; they never pick another
 * period in its place.
 */
export function previousYearEnd(currentEnd: string | null | undefined): string | null {
  if (!currentEnd || !/^\d{4}-\d{2}-\d{2}/.test(currentEnd)) return null;
  const y = Number(currentEnd.slice(0, 4));
  const m = Number(currentEnd.slice(5, 7));
  const d = Number(currentEnd.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const lastOf = (year: number) => new Date(Date.UTC(year, m, 0)).getUTCDate();
  if (d > lastOf(y)) return null;
  const day = d === lastOf(y) ? lastOf(y - 1) : Math.min(d, lastOf(y - 1));
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(y - 1, 4)}-${pad(m, 2)}-${pad(day, 2)}`;
}

/**
 * A comparison that is ON and compares nothing: the reader did not turn
 * comparisons off, and no prior resolves (AUTO found no earlier period
 * of the same length, and no usable stored choice stands in). The page says so in words and offers the next step — it never leaves
 * the picker and the column boxes implying a comparison that is not there.
 */
export function comparisonHasNoPrior(stored: string | null | "none", priorId: string | null): boolean {
  return stored !== "none" && !priorId;
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
 * equal to the cent, or (the 758 rows, whose bucket also holds the 781
 * reversals on that book) refused by the guard; plCompareSubtotals.test.tsx
 * holds both builders to their keys. The render-time parity guard below is
 * what makes a wrong entry harmless rather than wrong.
 *
 * Keys are the `bucket` a P&L row carries (items) or the section's
 * `subtotalBucket` (subtotals). Both builders stamp these; `interestIncome`
 * and `opexThirdParty` only the line-item builder, which alone shows 766
 * and 628 on rows of their own, and `financialIncomeTotal` only the
 * aggregates builder, whose financial-income row is the whole 76x family.
 *
 * THE ONE EBITDA (owner ruling 2026-09-26): "Total net turnover" IS the
 * engine's net turnover — 72x and 767 are no longer folded into it, so it
 * carries `pl.revenue` on its own figure. The stock variation (711) and own
 * work capitalised (72x) rows carry the engine's `pl.inventory_variation`
 * and `pl.capitalized_own_work` columns — their prior sides are the PRIOR
 * period's own measured figures (the engine assembles both periods on the
 * one definition). The closing line is account 121 as filed, `pl.net_income`.
 *
 * DELIBERATELY UNKEYED (no engine line is the same figure by definition):
 * the line-item builder's per-family turnover rows, its per-account
 * operating costs other than 628, its dividend, FX-gain, discounts-received
 * and FX-loss rows, and every "not itemised by account" remainder;
 * "Total operating expenses" on both paths (cost of goods sold PLUS
 * operating expenses — the engine serves the two separately); the net
 * result built from the accounts where it differs from account 121, and
 * the part "not explained by the accounts" (no engine column); and the
 * aggregates "FX losses & other financial expense" row, which excludes
 * interest while the engine's `pl.financial_expense` includes it.
 */
export const PL_ROW_TO_KEY: Readonly<Record<string, string>> = {
  revenueTurnover: "pl.revenue",
  // "Total net turnover" — net turnover and nothing else.
  revenue: "pl.revenue",
  otherOperatingIncome: "pl.other_operating_income",
  otherOperatingIncomeTotal: "pl.other_operating_income",
  capitalizedOwnWork: "pl.capitalized_own_work",
  cogs: "pl.cogs",
  inventoryVariation: "pl.inventory_variation",
  opexTotal: "pl.opex_total",
  opexThirdParty: "pl.opex_third_party",
  depreciationAmortization: "pl.depreciation",
  // R2 (2026-09-28): the net of the ruled provision charges and reversals.
  netProvisions: "pl.net_provisions",
  ebitda: "pl.ebitda",
  ebit: "pl.ebit",
  financialIncomeTotal: "pl.financial_income",
  interestIncome: "pl.interest_income",
  interestExpense: "pl.interest_expense",
  netFinancialResult: "pl.net_financial_result",
  pretax: "pl.pretax",
  taxExpense: "pl.tax",
  netIncomeStatutory: "pl.net_income",
};

/**
 * THE ENGINE LINES ON THE ONE EBITDA DEFINITION. Their figures moved with
 * the owner's rulings of 2026-09-26 (711 and 72x inside, 767 financial) and
 * 2026-09-28 (provisions symmetric outside EBITDA, 7411 in turnover), so
 * a prior assembled under another definition is not the same line: such a
 * row carries the engine's cells only while the PRIOR's served block —
 * `prior_statements.assembled_pl.ebitda_definition`, read off the served
 * comparatives document — names the SAME definition the current period is
 * served on. A prior with no stamp, or another one, is refused ("the
 * definition differs"): never a prior EBITDA beside a current one built
 * another way.
 */
export const PL_ROW_ONE_EBITDA_KEYS: ReadonlySet<string> = new Set([
  "pl.ebitda",
  "pl.ebit",
  "pl.pretax",
  "pl.gross_profit",
  "pl.inventory_variation",
  "pl.capitalized_own_work",
  // The owner's R2 ruling of 2026-09-28 moved these too: the 6812 / 6814
  // charges out of D&A, onto their own net-provisions line with the 7812 /
  // 7814 reversals. A prior stamped with the previous definition carries
  // them under the same names, built another way. (`pl.other_operating_
  // income` is the 758 leaves alone — the ruling did not move it. Net
  // turnover moved by R3 only on a book that posts 7411 — none is known —
  // and a prior's stamp cannot say whether it did, so it is not held: see
  // the comparatives law "net turnover … never held to it".)
  "pl.depreciation",
  "pl.net_provisions",
]);

/** What the definition guard reads for one row: the EBITDA definition the
 *  CURRENT period is served on (`assembled_pl.ebitda_definition`, null for
 *  a payload the engine did not assemble), and the served comparatives
 *  document's `prior_statements` — the block the PRIOR's stamp is read
 *  from. */
export interface RowDefinition {
  currentDefinition?: string | null;
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

/** The EBITDA definition a served `statements` block is assembled on. */
export function servedEbitdaDefinition(statements: unknown): string | null {
  const apl = isPlainRecord(statements) ? (statements as Record<string, unknown>).assembled_pl : undefined;
  const v = isPlainRecord(apl) ? (apl as Record<string, unknown>).ebitda_definition : undefined;
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * THE PARITY GUARD. A row may carry the engine's cells only if the number
 * the row shows IS the engine's current figure for that line. Otherwise
 * the cells stay blank and say why — never a prior beside a differently
 * built current.
 *
 * Ahead of it, THE DEFINITION GUARD (PL_ROW_ONE_EBITDA_KEYS): a row on the
 * one EBITDA carries the cells only while the prior's served block names
 * the definition the current period is served on. When the caller states
 * no current definition (a payload the engine did not assemble) there is
 * nothing to hold the prior to, and the parity guard alone decides.
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
  const current = definition?.currentDefinition ?? null;
  if (current !== null && PL_ROW_ONE_EBITDA_KEYS.has(key)) {
    if (servedEbitdaDefinition(definition?.priorStatements) !== current) {
      return {
        kind: "definition_differs",
        rowAmount: typeof rowAmount === "number" && Number.isFinite(rowAmount) ? rowAmount : null,
        engineCurrent: cell.current,
        key,
      };
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

// EVERY FIGURE IN THE READER'S LANGUAGE (§26). The three printers below take
// the UI language: a Romanian reader gets the decimal comma and "p.p." (the
// ratio table's word), not "0.1%" / "+0.2 pp" beside money printed "1.234,56".
// The locale comes from the ONE mapping, `moneyLocaleFor`. The digits are the
// same — only the decimal mark and the unit word follow the language. With
// no language the bytes are the English ones (the command bar localises its
// own copy; the report is English by contract).
const isRomanian = (language?: string | null): boolean => moneyLocaleFor(language) === "ro-RO";
const decimalMark = (fixed: string, language?: string | null): string =>
  isRomanian(language) ? fixed.replace(".", ",") : fixed;

/** Δ% as the engine gave it, or null (the caller prints the reason). */
export function formatDeltaPct(v: number | null, language?: string | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  const pct = v * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${decimalMark(pct.toFixed(1), language)}%`;
}

export function formatShare(v: number | null, language?: string | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  return `${decimalMark((v * 100).toFixed(1), language)}%`;
}

export function formatPts(v: number | null, language?: string | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  const sign = v > 0 ? "+" : "";
  return `${sign}${decimalMark(v.toFixed(1), language)} ${isRomanian(language) ? "p.p." : "pp"}`;
}

export function detailLevelLabelKey(level: DetailLevelName | string): string {
  switch (level) {
    case "synthetic": return "statements.cmp.levelSynthetic";
    case "analytic": return "statements.cmp.levelAnalytic";
    case "mixed": return "statements.cmp.levelMixed";
    default: return "statements.cmp.levelIndeterminate";
  }
}
