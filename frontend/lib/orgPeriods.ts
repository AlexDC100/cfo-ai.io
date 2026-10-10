// orgPeriods.ts — the active workspace's uploaded periods ("months").
//
// 2026-07-24: one trial balance per month is the operating model — every
// upload creates a period row (period_end = the month it covers) scoped
// to the workspace (organization). This module is the shared reader for
// that list: the Workspace tab's month switcher and any other surface
// that needs "which months exist here" consume it, sharing the
// ["periods-with-documents"] React Query cache with DocsPanel.
//
// Unlike DocsPanel's private fetcher, this one sends X-Org-Id (resolved
// from the active workspace) so a multi-workspace user gets the months
// of the workspace they have OPEN, not their oldest membership (the
// backend's fallback when the header is absent).

import { useQuery } from "@tanstack/react-query";

import { getSupabase } from "@/lib/supabase";
import { getActiveOrgId } from "@/lib/activeOrg";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

export interface OrgPeriodDocument {
  id: string;
  filename?: string | null;
  is_active?: boolean;
  status?: string | null;
  uploaded_at?: string | null;
  /** 'financial' (trial balance) or 'sku' (Products dataset). */
  scope?: string | null;
}

export interface OrgPeriod {
  period_id: string;
  period_label: string;
  period_start: string | null;
  period_end: string | null;
  is_active?: boolean;
  documents: OrgPeriodDocument[];
}

export interface OrgPeriodsPayload {
  active_period_id: string | null;
  periods: OrgPeriod[];
}

export async function fetchOrgPeriods(): Promise<OrgPeriodsPayload | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const orgId = getActiveOrgId(data.session?.user?.id ?? null);
  if (orgId) headers["X-Org-Id"] = orgId;
  const res = await fetch(`${API_URL}/api/org/periods-with-documents`, { headers });
  if (!res.ok) return null;
  return (await res.json()) as OrgPeriodsPayload;
}

/** Like fetchOrgPeriods, but for a SPECIFIC workspace (org) rather than the
 *  active one — used to show each workspace card's month pills. The backend
 *  validates X-Org-Id membership, so this only resolves the user's own orgs. */
export async function fetchOrgPeriodsFor(orgId: string): Promise<OrgPeriodsPayload | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const res = await fetch(`${API_URL}/api/org/periods-with-documents`, {
    headers: { Authorization: `Bearer ${token}`, "X-Org-Id": orgId },
  });
  if (!res.ok) return null;
  return (await res.json()) as OrgPeriodsPayload;
}

// ── Direct Supabase period layer (2026-07-26) ────────────────────────────
// Periods are independent CONTAINERS; files are their contents. The engine's
// /periods-with-documents feed deliberately skips doc-less periods (it drives
// the analysis surfaces, where an empty period has nothing to show) — so the
// Workspace management tab reads `financial_periods` directly instead. RLS
// (`financial_periods member *`, phase3.sql) scopes every call to the user's
// own memberships; no service role involved.
//
// This also fixes a long-standing display bug: the engine feed emits
// `display_name`/`original_filename` but the UI read `d.filename`, a field
// that never existed in that payload — so every file in a period card
// rendered as "Untitled file". The direct fetcher normalizes to `filename`.

/** What the Workspace tab reads of a period row. `staged_rerun` is the
 *  marker of a re-run's STAGED row, read alone out of the envelope (never
 *  the envelope itself) — the same alias the engine selects
 *  (src/engine/api/_staged_rerun.py MARKER_SELECT). */
export const WORKSPACE_PERIODS_SELECT =
  "id, period_start, period_end, currency, created_at, source_document_id, staged_rerun:assembled_canonical_v1->staged_rerun";

/** Is this `financial_periods` row the STAGED row of a re-run — not a
 *  period? The engine's rule (`_staged_rerun.marker_of`): it names NO source
 *  document AND its envelope carries the marker object. An EMPTY container
 *  (no source, no marker) is a period and stays. */
export function isStagedRerunRow(row: Record<string, unknown>): boolean {
  const marker = row.staged_rerun;
  return (
    (row.source_document_id === null || row.source_document_id === undefined) &&
    marker !== null &&
    typeof marker === "object" &&
    !Array.isArray(marker)
  );
}

/** ALL of a workspace's periods — including ones with no files yet — with
 *  their live (non-deleted) documents, newest month first. A re-run's staged
 *  row is not one of them. */
export async function fetchWorkspacePeriodsDirect(
  orgId: string,
): Promise<OrgPeriodsPayload | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: rows, error } = await sb
    .from("financial_periods")
    .select(WORKSPACE_PERIODS_SELECT)
    .eq("org_id", orgId)
    .order("period_end", { ascending: false })
    .order("created_at", { ascending: false });
  if (error || !rows) return null;
  // A re-run's STAGED row is not a period (see isStagedRerunRow): shown, it
  // would be a second, empty card for the month while "Re-run analysis" is
  // going — or until the row a dead run left is cleaned up.
  const periods = (rows as unknown as Array<Record<string, unknown>>).filter((p) => !isStagedRerunRow(p));

  const ids = periods.map((p) => p.id as string);
  let docs: Array<Record<string, unknown>> = [];
  if (ids.length > 0) {
    const { data } = await sb
      .from("documents")
      .select("id, original_filename, display_name, status, period_id, created_at, scope")
      .in("period_id", ids)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    docs = (data ?? []) as Array<Record<string, unknown>>;
  }
  const byPeriod = new Map<string, OrgPeriodDocument[]>();
  for (const d of docs) {
    const pid = d.period_id as string;
    const list = byPeriod.get(pid) ?? [];
    list.push({
      id: d.id as string,
      filename: (d.display_name as string | null) ?? (d.original_filename as string | null),
      status: (d.status as string | null) ?? null,
      uploaded_at: (d.created_at as string | null) ?? null,
      scope: (d.scope as string | null) ?? null,
    });
    byPeriod.set(pid, list);
  }

  return {
    active_period_id: null, // management view — the app's active period is not this list's concern
    periods: periods.map((p) => ({
      period_id: p.id as string,
      period_label: (p.period_end as string | null) ?? "Period",
      period_start: (p.period_start as string | null) ?? null,
      period_end: (p.period_end as string | null) ?? null,
      documents: byPeriod.get(p.id as string) ?? [],
    })),
  };
}

// `createEmptyPeriod` was DELETED 2026-09-21 (G4): a `financial_periods`
// row exists only once an analysed source document backs it, and the only
// writer is the engine's `stage_persist`. Uploading with `periodEndHint`
// alone files the analysis under the confirmed month — no container first.
// tests/engine/test_no_empty_period_creators.py reds on any client-side
// insert into financial_periods.

/** Move an (empty) period to a different month — a direct update of
 *  period_end/period_start under the user's own RLS. Used by the pre-scan
 *  confirm dialog's "change the period to match the file" choice: renaming
 *  the container FIRST means the upload's periodEndHint then finds this same
 *  row by (org_id, period_end) and adopts it, instead of leaving the old
 *  month dangling empty and creating a sibling. */
export async function updatePeriodEnd(
  periodId: string,
  periodEnd: string,
): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return "Not signed in.";
  const { error } = await sb
    .from("financial_periods")
    .update({ period_end: periodEnd, period_start: periodEnd })
    .eq("id", periodId);
  return error ? error.message : null;
}

/** Delete a period that has NO documents. Direct row delete under the user's
 *  own RLS — derivatives cascade (statement_line_items etc. are FK CASCADE),
 *  and with no docs there is nothing to soft-delete. Periods WITH documents
 *  must go through the engine's DELETE /api/period/{id}, which soft-deletes
 *  the files into Recently deleted first. */
export async function deleteEmptyPeriod(periodId: string): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return "Not signed in.";
  const { error } = await sb.from("financial_periods").delete().eq("id", periodId);
  return error ? error.message : null;
}

/** One company's analysed periods, newest month first — and WHOSE they are. */
export interface CompanyPeriods {
  orgId: string;
  periods: OrgPeriod[];
}

/** The cache key of one company's periods. Under the `periods-with-documents`
 *  prefix, so every invalidation of that family refreshes it too. */
export const companyPeriodsQueryKey = (orgId: string) =>
  ["periods-with-documents", "company", orgId] as const;

/**
 * THE PERIODS OF ONE NAMED COMPANY — not "the active workspace's" at whatever
 * moment the request happens to fire. The company is in the cache key and in
 * the request (`fetchOrgPeriodsFor` sends it as X-Org-Id, which the engine
 * validates), and the answer carries it, so a reader can hold the list to the
 * company it is about. The comparison picker reads its candidates from here
 * (2026-09-26: a prior chosen on one company's dashboard was requested on the
 * next company's). Non-empty periods only, newest month first.
 */
export function useCompanyPeriods(orgId: string | null) {
  return useQuery({
    queryKey: companyPeriodsQueryKey(orgId ?? ""),
    queryFn: async (): Promise<CompanyPeriods | null> => {
      const payload = await fetchOrgPeriodsFor(orgId as string);
      if (!payload) return null;
      const periods = payload.periods
        .filter((p) => p.documents.length > 0)
        .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));
      return { orgId: orgId as string, periods };
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
  });
}

/** The workspace's periods, non-empty ones only, newest month first. */
export function useOrgPeriods() {
  return useQuery({
    queryKey: ["periods-with-documents"],
    queryFn: fetchOrgPeriods,
    staleTime: 60 * 1000,
    select: (payload: OrgPeriodsPayload | null) => {
      if (!payload) return null;
      const periods = payload.periods
        .filter((p) => p.documents.length > 0)
        .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));
      return { ...payload, periods };
    },
  });
}

// ── The current month is permanent ─────────────────────────────────────
//
// The current month used to be created, empty, in every workspace
// (useEnsureCurrentPeriod — deleted 2026-09-21, G4: no period without an
// analysed file). The helpers below still recognise a current-month row so
// the surfaces that read one keep working on the rows that already exist.

/** Last day of the current month, as YYYY-MM-DD. UTC so the boundary doesn't
 *  shift a period into the neighbouring month for users west of Greenwich. */
export function currentMonthEnd(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-based
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** True when `periodEnd` falls in the current calendar month — i.e. this is
 *  the permanent, non-deletable period. Compares year+month rather than the
 *  exact date so a row stored mid-month (or with a slightly different last
 *  day) still counts. */
export function isCurrentMonthPeriod(periodEnd: string | null | undefined): boolean {
  if (!periodEnd) return false;
  const d = new Date(periodEnd);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth()
  );
}

/** Bad date-detection has produced periods like "5309-03-31" and
 *  "2050-12-31" in real workspaces (from Excel serials / account codes
 *  misread as dates). A label formatter must never surface those —
 *  treat anything outside a sane financial-reporting window as
 *  unparseable so callers fall back to their placeholder. */
function saneYear(d: Date): boolean {
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2035;
}

/** The dates the engine serves: `YYYY-MM-DD`, with or without a time.
 *  The month formatters read nothing else. `new Date()` is far more
 *  willing: V8 reads the LABEL "FY 2025" as 1 January 2025 in the viewer's
 *  timezone and "Decembrie 2025" as 1 December — which, pinned to UTC, the
 *  dashboard's header then printed as "Dec 2024" and "Nov 2025" for a
 *  viewer east of Greenwich. A label is not a date: the caller keeps it as
 *  written. */
const SERVED_DATE = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/;

/** "Mar 2026" from a period_end date string; null when unparseable or
 *  implausible. UTC-pinned: period_end is a date-only string, so
 *  local-time parsing shifted it a day back (and sometimes a month)
 *  west of Greenwich.
 *
 *  `locale` is REQUIRED — the reader's (lib/locale `useActiveLocale` in a
 *  component, `activeLocale` in a plain module). It used to default to
 *  "en-GB", and every caller that forgot it printed an English month in a
 *  Romanian interface: the dashboard's header said "Dec 2024" beside a
 *  breadcrumb saying "dec. 2024". A default is how the argument gets
 *  forgotten (gate period-month-locale). */
export function formatPeriodMonth(
  periodEnd: string | null | undefined,
  locale: string,
): string | null {
  if (!periodEnd || !SERVED_DATE.test(periodEnd)) return null;
  const d = new Date(periodEnd);
  if (Number.isNaN(d.getTime()) || !saneYear(d)) return null;
  return d.toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "2026" from a period_end date string; null when unparseable or
 *  implausible. The sidebar rail label shows the year alone (2026-08-04
 *  per operator) — the month detail stays in the stepper arrow tooltips. */
export function formatPeriodYear(periodEnd: string | null | undefined): string | null {
  if (!periodEnd) return null;
  const d = new Date(periodEnd);
  if (Number.isNaN(d.getTime()) || !saneYear(d)) return null;
  return String(d.getUTCFullYear());
}

/** LOOSE month formatter — formats any parseable date, implausible years
 *  included. For LIST surfaces (Workspace months, Docs panel, delete
 *  dialogs) where a corrupt row must still be readable so the user can
 *  find and delete it: "Dec 2050" beats a raw "2050-12-31". Ambient
 *  labels (sidebar year, header) keep the strict formatter above. The
 *  locale is required, as above. */
export function formatPeriodMonthLoose(
  periodEnd: string | null | undefined,
  locale: string,
): string | null {
  if (!periodEnd || !SERVED_DATE.test(periodEnd)) return null;
  const d = new Date(periodEnd);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** True when the period's date parses but sits outside the plausible
 *  reporting window — list surfaces show a "check date" warning chip. */
export function isImplausiblePeriod(periodEnd: string | null | undefined): boolean {
  if (!periodEnd) return false;
  const d = new Date(periodEnd);
  return !Number.isNaN(d.getTime()) && !saneYear(d);
}
