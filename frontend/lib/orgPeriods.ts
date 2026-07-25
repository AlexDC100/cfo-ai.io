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

/** "Mar 2026" from a period_end date string; null when unparseable. */
export function formatPeriodMonth(periodEnd: string | null | undefined): string | null {
  if (!periodEnd) return null;
  const d = new Date(periodEnd);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}
