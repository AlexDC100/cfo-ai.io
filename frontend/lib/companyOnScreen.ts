// companyOnScreen.ts — a page for company X renders only under a header that
// names X.
//
// Owner rule (workspace redesign, 2026-09-21): "the header ALWAYS names the
// company on screen — a Scandia page never shows another workspace in the
// header". The header names the ACTIVE workspace (lib/workspaceName, written
// by lib/org.ts on every switch). So a page that is ABOUT a company — the
// company page `/workspace/<orgId>`, a dashboard opened with `?org=<orgId>` —
// switches the active workspace to that company and holds its content until
// both halves agree:
//
//   · the active workspace id is the page's company, and
//   · the header's name cache holds that company's name.
//
// Until then the page renders a neutral hold, never the company's content.
// Gate G6 (pages/cfo/__tests__/companyHeaderSync.test.tsx) renders a company
// page while another workspace is active and reds if the page's title ever
// shows under a header naming a different company.

import { useEffect, useRef, useState } from "react";

import { useActiveOrg, type Organization } from "@/lib/org";
import { useWorkspaceName, writeWorkspaceName } from "@/lib/workspaceName";

export type CompanyOnScreen =
  | { status: "loading"; org: null }
  | { status: "missing"; org: null }
  | { status: "syncing"; org: Organization }
  | { status: "ready"; org: Organization };

/** Pure agreement check, exported for tests: does the header name `org`? */
export function headerAgrees(
  org: Pick<Organization, "id" | "name"> | null,
  activeOrgId: string | null,
  headerName: string,
): boolean {
  if (!org) return false;
  return activeOrgId === org.id && headerName.trim() === org.name.trim();
}

export function useCompanyOnScreen(orgId: string | null): CompanyOnScreen {
  const { org: active, orgs, loading, refresh, switchOrg } = useActiveOrg();
  const headerName = useWorkspaceName();
  const target = orgId ? orgs.find((o) => o.id === orgId) ?? null : null;

  // Switch to the page's company. switchOrg writes the header name first.
  useEffect(() => {
    if (!target) return;
    if (active?.id !== target.id) {
      void switchOrg(target.id);
    } else if (headerName.trim() !== target.name.trim()) {
      // Same company, stale name cache (renamed on another device, first
      // paint from an old cache): the header must read the page's company.
      writeWorkspaceName(target.name);
    }
  }, [target, active?.id, headerName, switchOrg]);

  // A company created a moment ago (the upload flow's "New company") can be
  // missing from a list loaded before it existed. Re-read the list ONCE per
  // id before calling it missing — never flash "not in your list" at a
  // company the user just made.
  const refreshedFor = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!orgId || loading || target || refreshedFor.current === orgId) return;
    refreshedFor.current = orgId;
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  }, [orgId, loading, target, refresh]);

  if (!target) {
    if (loading || refreshing || (orgId && refreshedFor.current !== orgId)) {
      return { status: "loading", org: null };
    }
    return { status: "missing", org: null };
  }
  if (!headerAgrees(target, active?.id ?? null, headerName)) {
    return { status: "syncing", org: target };
  }
  return { status: "ready", org: target };
}

/**
 * Dashboard links from the redesign carry `?org=<orgId>` (a year tile, the
 * bell, a toast, "Already uploaded — open it"). When that company is not the
 * active one — a reload on another device, a shared link — the shell switches
 * to it and HOLDS the page until the header names it. Returns true while
 * holding. An `org` the user is not a member of is ignored (the page's own
 * fetch refuses it); no param, nothing to hold.
 */
export function useOrgParamHold(enabled: boolean, wanted: string | null): boolean {
  const { org: active, orgs, loading, switchOrg } = useActiveOrg();
  const headerName = useWorkspaceName();
  const target = enabled && wanted ? orgs.find((o) => o.id === wanted) ?? null : null;

  useEffect(() => {
    if (!target) return;
    if (active?.id !== target.id) void switchOrg(target.id);
    else if (headerName.trim() !== target.name.trim()) writeWorkspaceName(target.name);
  }, [target, active?.id, headerName, switchOrg]);

  if (!enabled || !wanted) return false;
  if (!target) return loading;
  return !headerAgrees(target, active?.id ?? null, headerName);
}
