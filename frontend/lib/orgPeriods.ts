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

/** ALL of a workspace's periods — including ones with no files yet — with
 *  their live (non-deleted) documents, newest month first. */
export async function fetchWorkspacePeriodsDirect(
  orgId: string,
): Promise<OrgPeriodsPayload | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: periods, error } = await sb
    .from("financial_periods")
    .select("id, period_start, period_end, currency, created_at")
    .eq("org_id", orgId)
    .order("period_end", { ascending: false })
    .order("created_at", { ascending: false });
  if (error || !periods) return null;

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

/** Create an EMPTY period (a container with no file yet). `periodEnd` must be
 *  the last day of the month, ISO. The pipeline later ADOPTS this row when a
 *  trial balance for the same month is uploaded (stage_persist's replace
 *  branch matches on (org_id, period_end) and takes over source_document_id),
 *  so pre-creating never produces a duplicate month.
 *
 *  Caller must guard against months that already exist: the DB's UNIQUE
 *  (org_id, period_end, source_document_id) can't — source_document_id is
 *  NULL here, and NULLs never collide in Postgres unique constraints. */
export async function createEmptyPeriod(
  orgId: string,
  periodEnd: string,
): Promise<{ id: string } | { error: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Not signed in." };
  const { data, error } = await sb
    .from("financial_periods")
    .insert({ org_id: orgId, period_start: periodEnd, period_end: periodEnd })
    .select("id")
    .single();
  if (error) return { error: error.message };
  return { id: data.id as string };
}

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
// Every workspace always has a period for the CURRENT month and year, and
// that one can't be deleted (2026-07-26 per operator). It's the always-there
// landing spot: the month you'd file today's trial balance into, guaranteed to
// exist and to be selectable even in a brand-new workspace with no uploads.
// `useEnsureCurrentPeriod` creates it; the Workspace page refuses to delete it.

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

/** "Mar 2026" from a period_end date string; null when unparseable.
 *  UTC-pinned: period_end is a date-only string, so local-time parsing
 *  shifted it a day back (and sometimes a month) west of Greenwich. */
export function formatPeriodMonth(
  periodEnd: string | null | undefined,
  locale: string = "en-GB",
): string | null {
  if (!periodEnd) return null;
  const d = new Date(periodEnd);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "2026" from a period_end date string; null when unparseable. The sidebar
 *  rail label shows the year alone (2026-08-04 per operator) — the month
 *  detail stays in the stepper arrow tooltips. */
export function formatPeriodYear(periodEnd: string | null | undefined): string | null {
  if (!periodEnd) return null;
  const d = new Date(periodEnd);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getUTCFullYear());
}
