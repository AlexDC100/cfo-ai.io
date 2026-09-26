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

import { useCallback, useEffect, useRef, useState } from "react";
import { useMatch, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { useActivePeriod } from "@/lib/activePeriod";
import { companyDashboardHref } from "@/lib/dashboardHref";
import { useActiveOrg, type Organization } from "@/lib/org";
import { useWorkspaceV2 } from "@/lib/previewFeatures";
import { fetchCompanyYears } from "@/lib/uploadsApi";
import { useWorkspaceName, writeWorkspaceName } from "@/lib/workspaceName";

export { companyDashboardHref, periodDashboardHref } from "@/lib/dashboardHref";

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

// ── A hold asks, it does not insist ─────────────────────────────────────
//
// Defence in depth (2026-09-26, the auth-lock flood). A hold makes the screen
// agree with its page — switching the active company, or re-writing the
// header's name — whenever the two disagree, and every switch remounts
// content and re-reads preferences through Supabase, whose auth Web Lock
// every tab of the origin shares. Two authorities disagreeing (a company page
// and the shell's dashboard hold; two tabs through a shared header name) did
// that in turn, forever. Those causes are fixed at the source; this bounds
// the NEXT one: within HOLD_ASK_WINDOW_MS a hold asks for the same company at
// most HOLD_ASK_BUDGET times, and at most HOLD_ASK_TOTAL times for any
// companies (a hold whose own wish flips — `?org=` against the period's
// company — is bounded too), then waits the window out before it looks again
// — never a storm.
export const HOLD_ASK_BUDGET = 3;
export const HOLD_ASK_TOTAL = 12;
export const HOLD_ASK_WINDOW_MS = 10_000;

function useHoldAsk(switchOrg: (orgId: string) => Promise<void>): {
  /** Make the screen name `target`: switch to it, or — already active —
   *  re-write the header's name. */
  ask: (target: Pick<Organization, "id" | "name">, activeId: string | null) => void;
  /** Bumped when a withheld ask may be retried — a dependency of the hold. */
  retry: number;
} {
  /** When this hold asked, and for which company — the window's worth. */
  const asked = useRef<Array<{ id: string; at: number }>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const ask = useCallback(
    (target: Pick<Organization, "id" | "name">, activeId: string | null) => {
      const now = Date.now();
      const recent = asked.current.filter((a) => now - a.at < HOLD_ASK_WINDOW_MS);
      asked.current = recent;
      const forTarget = recent.filter((a) => a.id === target.id);
      if (forTarget.length >= HOLD_ASK_BUDGET || recent.length >= HOLD_ASK_TOTAL) {
        if (!timer.current) {
          const oldest = (forTarget.length >= HOLD_ASK_BUDGET ? forTarget : recent)[0]!.at;
          console.warn(
            `[companyOnScreen] the screen keeps moving away from ${target.id}; ` +
              `not asking again for ${Math.round(HOLD_ASK_WINDOW_MS / 1000)} s`,
          );
          timer.current = setTimeout(() => {
            timer.current = null;
            setRetry((n) => n + 1);
          }, HOLD_ASK_WINDOW_MS - (now - oldest));
        }
        return;
      }
      recent.push({ id: target.id, at: now });
      if (activeId !== target.id) void switchOrg(target.id);
      else writeWorkspaceName(target.name);
    },
    [switchOrg],
  );
  return { ask, retry };
}

export function useCompanyOnScreen(orgId: string | null): CompanyOnScreen {
  const { org: active, orgs, loading, refresh, switchOrg } = useActiveOrg();
  const headerName = useWorkspaceName();
  const target = orgId ? orgs.find((o) => o.id === orgId) ?? null : null;
  const { ask, retry } = useHoldAsk(switchOrg);

  // Switch to the page's company (switchOrg writes the header name first) —
  // or, the same company with a stale name cache (renamed on another device,
  // first paint from an old cache), re-write the name: the header must read
  // the page's company.
  useEffect(() => {
    if (!target) return;
    if (active?.id !== target.id || headerName.trim() !== target.name.trim()) {
      ask(target, active?.id ?? null);
    }
  }, [target, active?.id, headerName, ask, retry]);

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
 * The sidebar's Dashboard row while a company page (/workspace/<orgId>) is on
 * screen, under the redesign: that company's dashboard
 * (`companyDashboardHref`, lib/dashboardHref). Null on every other screen,
 * and with the redesign off — the row then keeps its `?period=`-preserving
 * link. Shares the company page's own `["company-years", orgId]` read.
 */
export function useCompanyPageDashboardHref(): string | null {
  const workspaceV2 = useWorkspaceV2();
  const match = useMatch("/workspace/:orgId");
  const orgId = workspaceV2 && match?.params.orgId ? match.params.orgId : null;
  const yearsQ = useQuery({
    queryKey: ["company-years", orgId],
    queryFn: () => fetchCompanyYears(orgId as string),
    enabled: !!orgId,
    staleTime: 30_000,
  });
  if (!orgId) return null;
  return companyDashboardHref(orgId, yearsQ.data ?? null);
}

/**
 * The company a dashboard is ABOUT — the period's own company once its
 * payload lands, else `?org=<orgId>` on a redesign link (a year tile, the
 * bell, a toast, "Already uploaded — open it"). When that company is not the
 * active one — a stale link, Back, a reload on another device — the shell
 * switches to it and HOLDS the page until the header names it. Returns true
 * while holding. An `org` the user is not a member of is ignored (the page's
 * own fetch refuses it); nothing wanted, nothing to hold.
 */
export function useOrgParamHold(enabled: boolean, wanted: string | null): boolean {
  const { org: active, orgs, loading, switchOrg } = useActiveOrg();
  const headerName = useWorkspaceName();
  const target = enabled && wanted ? orgs.find((o) => o.id === wanted) ?? null : null;
  const { ask, retry } = useHoldAsk(switchOrg);

  useEffect(() => {
    if (!target) return;
    if (active?.id !== target.id || headerName.trim() !== target.name.trim()) {
      ask(target, active?.id ?? null);
    }
  }, [target, active?.id, headerName, ask, retry]);

  if (!enabled || !wanted) return false;
  if (!target) return loading;
  return !headerAgrees(target, active?.id ?? null, headerName);
}

/**
 * The shell's hold for the dashboard family: the company the current page
 * is about is the PERIOD's own company once its payload lands (the engine
 * says which company a period belongs to — a stale link, Back, or a period
 * remembered from another company all carry `?period=` alone), else the
 * `?org=` a redesign link pins. Switch to it and hold until the header names
 * it (`useOrgParamHold`). Rule (G6): navigating to a period of another
 * company switches the active company first.
 */
export function useDashboardCompanyHold(enabled: boolean, settling = false): boolean {
  const [params] = useSearchParams();
  const period = useActivePeriod();
  const holding = useOrgParamHold(enabled, period.organizationId ?? params.get("org"));
  // `?period=` alone: hold while its company is not known yet (the payload
  // is out), and — on a full page load — while it is not yet known whether
  // the redesign is on at all (`settling`: the registry still answering).
  // The header names the company that was active; the page shows nothing
  // of another one meanwhile. Once settled with the redesign off, the old
  // dashboard renders as before; nothing is switched under an unknown flag.
  const barePeriod = !!params.get("period") && !params.get("org");
  const pending = barePeriod && (settling || (enabled && !period.organizationId && period.isLoading));
  return holding || pending;
}
