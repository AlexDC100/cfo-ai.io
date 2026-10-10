// useCmdbarData — ONE resolver for "which company and which period is the
// command bar searching", and the cached documents it reads.
//
// THE DESYNC IT CLOSES. The header pill named the active workspace plus the
// stepper's month, while the palette's facts came from `useActivePeriod`,
// which reads only the URL — so on /settings (no ?period) the header said
// "Company · month" over a bar that held no facts, and a stale link could
// put one company's month under another's name. Here the header line, the
// empty state and every typed answer come from the SAME (org, period):
//
//   period  the URL's ?period, else the newest analysed period of the
//           active company (its own list, which names the company);
//   org     the period's own company once its body lands — and when that
//           is not the company open now, the bar says so and searches
//           nothing in it (the companyOnScreen rule).
//
// EVERY DOCUMENT IS THE ANSWER FOR (org, period), OR IT IS NOTHING. The
// app's query client keeps the PREVIOUS key's data on screen while a new key
// loads (`placeholderData: keepPreviousData`, lib/queryClient.ts) — right for
// a page that repaints the same company, wrong here: across a company or a
// period switch it handed the bar the company left behind's "Ce contează
// acum", its sector figures and its period body under the new header, and a
// placeholder body named "ready" asked the engine to compare one company's
// period with another's (`/api/period/<Agras>/comparatives?prior=<Scandia>`
// under Scandia's X-Org-Id — workspace-v2 G6). So: a placeholder is never
// read (`isPlaceholderData`), and each document must NAME the (org, period)
// it is read for (`period.id`, `organization.id`, the attention document's
// `period.org_id`, the comparison's two period ids, the sector document's
// `period.id`). A switch in flight — the workspace holder (lib/activeOrg,
// written FIRST, before the cache is cleared) naming another company than
// this hook's `useActiveOrg()`, which re-resolves later — is "loading": the
// bar asks for nothing and paints nothing until both agree.
//
// Mounted twice with one cache: <CommandBarPrefetch/> in AppShell keeps the
// documents warm on every (org, period) change; the palette reads them.
// A keystroke never reaches this hook — it only re-renders on data.

import { useMemo, useSyncExternalStore } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import {
  fetchPeriodFromApi,
  periodQueryKey,
  type PeriodApiResponse,
  type PeriodFetchResult,
} from "@/lib/activePeriod";
import { getActiveOrgId, subscribeActiveOrg } from "@/lib/activeOrg";
import { useAttention, type AttentionDoc, type AttentionPrior } from "@/lib/attention";
import { useAuth } from "@/lib/auth";
import { comparisonChoiceOf, useComparatives, type ComparativesResponse } from "@/lib/comparatives";
import { useActiveOrg, type Organization } from "@/lib/org";
import { formatPeriodMonth, useCompanyPeriods, type OrgPeriod } from "@/lib/orgPeriods";
import { fetchCompanyYears, type CompanyYear } from "@/lib/uploadsApi";
import { fetchSectorBenchmark, type SectorBenchmarkDoc } from "@/lib/sectorBenchmark";
import { readComparativesView } from "@/stores/comparativesView";

import type { SourceState } from "./cmdbarViews";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bar's sector document: keyed by the company AND the period, and
 *  asked of that company (X-Org-Id named, never the ambient workspace) —
 *  like the attention and comparatives documents beside it. */
export const cmdbarSectorQueryKey = (orgId: string, periodId: string) =>
  ["sector-benchmark", "company", orgId, periodId] as const;

export type ScopeStatus =
  | "no_company"      // nobody signed in to a workspace yet
  | "no_period"       // the company has no analysed period
  | "loading"         // the period body is in flight, or a company switch is settling
  | "ready"           // facts are the period's, of the company open now
  | "other_company"   // the period belongs to another company
  | "unreadable";     // 404 / transport error / an empty container

export interface CmdbarScope {
  status: ScopeStatus;
  orgId: string | null;
  companyName: string | null;
  periodId: string | null;
  periodEnd: string | null;
}

export interface CmdbarData {
  scope: CmdbarScope;
  /** The served period body, only when `scope.status === "ready"`. */
  body: PeriodApiResponse | null;
  comparatives: SourceState<ComparativesResponse>;
  sector: SourceState<SectorBenchmarkDoc>;
  attention: SourceState<AttentionDoc>;
  /** The comparison the documents are composed against. */
  prior: AttentionPrior;
  companies: Organization[];
  /** Each company's analysed years, keyed by org id (read when open). */
  years: Record<string, CompanyYear[] | undefined>;
}

/** A query's data only when it is the answer to THIS key — never the
 *  previous key's result the app-wide `keepPreviousData` keeps on screen. */
function own<T>(q: { data: T | undefined; isPlaceholderData: boolean }): T | undefined {
  return q.isPlaceholderData ? undefined : q.data;
}

/** Does a served document name the (org, period) it is read for? An id the
 *  engine did not serve (null) is not a contradiction; a different one is. */
const names = (served: string | null | undefined, wanted: string | null) =>
  served == null || served === wanted;

export function useCmdbarData(opts: { open: boolean }): CmdbarData {
  const [params] = useSearchParams();
  const { org, orgs } = useActiveOrg();
  const { user } = useAuth();

  // The workspace holder is written FIRST on a switch (lib/org.ts:
  // setActiveOrgId, then queryClient.clear(), then the remote write, then
  // every useActiveOrg re-resolves). While it names another company than
  // this hook's `org`, the switch is in flight: nothing is asked, nothing is
  // painted — a request here would name the company being left.
  const heldOrgId = useSyncExternalStore(
    subscribeActiveOrg,
    () => getActiveOrgId(user?.id ?? null),
    () => null,
  );
  const switchingTo = org && heldOrgId && heldOrgId !== org.id ? heldOrgId : null;
  const activeId = org && !switchingTo ? org.id : null;

  // The active company's own analysed periods — keyed by the company, and
  // the answer names it (`orgId`), so a list kept from the company left
  // behind is never read as this one's.
  const ownListQ = useCompanyPeriods(activeId);
  const ownListData = own(ownListQ);
  const ownList: OrgPeriod[] | null =
    ownListData && activeId && ownListData.orgId === activeId ? ownListData.periods : null;
  const ownListSettling = !ownList && (ownListQ.isPending || ownListQ.isFetching || ownListQ.isPlaceholderData);

  const urlPeriod = params.get("period");
  const periodId =
    urlPeriod && UUID.test(urlPeriod) ? urlPeriod : (ownList?.[0]?.period_id ?? null);

  // THE SAME cache entry `useActivePeriod` reads — one fetch per period.
  const periodQ = useQuery({
    queryKey: periodId ? periodQueryKey(periodId) : ["period", "__noop__"],
    queryFn: () => fetchPeriodFromApi(periodId!),
    enabled: !!activeId && !!periodId && UUID.test(periodId),
  });
  // Only the answer for THIS period: not a placeholder, and naming it.
  const result: PeriodFetchResult | undefined = own(periodQ);
  const payload =
    result?.kind === "ok" && names(result.data?.period?.id, periodId) ? result.data : null;

  const scope = useMemo<CmdbarScope>(() => {
    if (!org) return { status: "no_company", orgId: null, companyName: null, periodId: null, periodEnd: null };
    if (switchingTo) {
      const to = orgs.find((o) => o.id === switchingTo) ?? null;
      return { status: "loading", orgId: switchingTo, companyName: to?.name ?? null, periodId: null, periodEnd: null };
    }
    const base = { orgId: org.id, companyName: org.name, periodId, periodEnd: null as string | null };
    // No ?period and the company's own list not read yet: loading, not "none".
    if (!periodId) return { ...base, status: ownListSettling ? "loading" : "no_period" };
    const listed = ownList?.find((p) => p.period_id === periodId);
    const end = payload?.period?.period_end ?? listed?.period_end ?? null;
    // No answer for this period yet: the body is in flight (or a previous
    // period's body is still on screen) — the header names the month, the
    // facts say "loading".
    if (!result) return { ...base, periodEnd: end, status: "loading" };
    if (result.kind !== "ok" || !payload) return { ...base, periodEnd: end, status: "unreadable" };
    const bodyOrg = payload.organization?.id ?? null;
    if (bodyOrg && bodyOrg !== org.id) return { ...base, periodEnd: end, status: "other_company" };
    const empty = (payload.line_items?.length ?? 0) === 0 && (payload.metrics?.length ?? 0) === 0;
    if (empty) return { ...base, periodEnd: end, status: "unreadable" };
    return { ...base, periodEnd: end, status: "ready" };
  }, [org, orgs, switchingTo, periodId, ownList, ownListSettling, payload, result]);

  const ready = scope.status === "ready";
  const companyId = ready ? scope.orgId : null;

  // The reader's comparison choice for THIS company (stored per company),
  // resolved only against the company's own periods (lib/comparatives).
  const stored = readComparativesView(companyId).priorPeriodId;
  const choice = comparisonChoiceOf(
    {
      currentId: ready ? periodId : null,
      currentEnd: scope.periodEnd,
      currentOrgId: companyId,
      activeOrgId: activeId,
      stored,
    },
    ownList && activeId ? { orgId: activeId, periods: ownList } : null,
  );
  // The attention document: "auto" is the engine's own same-length prior;
  // a stored explicit choice that is not AUTO's pick is passed through.
  const prior: AttentionPrior =
    stored === "none"
      ? "none"
      : choice.priorId && choice.autoPick && choice.priorId !== choice.autoPick.period_id
        ? choice.priorId
        : "auto";

  const cmpQ = useComparatives(ready ? periodId : null, ready ? choice.priorId : null, companyId);
  const sectorQ = useQuery({
    queryKey: cmdbarSectorQueryKey(companyId ?? "", ready ? periodId ?? "" : ""),
    enabled: ready && !!periodId && !!companyId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SectorBenchmarkDoc | null> => {
      const res = await fetchSectorBenchmark(periodId!, companyId!);
      return res.kind === "ok" ? res.data : null;
    },
  });
  const attentionQ = useAttention(ready ? periodId : null, companyId, prior);

  const cmp = own(cmpQ);
  const comparatives: SourceState<ComparativesResponse> = !ready
    ? { state: "none", reason: "no_period" }
    : stored === "none"
      ? { state: "none", reason: "off" }
      : !ownList
        ? (ownListSettling ? { state: "pending" } : { state: "none", reason: "no_prior" })
        : !choice.priorId
          ? { state: "none", reason: "no_prior" }
          : cmp === undefined
            ? { state: "pending" }
            : cmp.kind === "ok"
              ? (cmp.data.current?.period_id === periodId && cmp.data.prior?.period_id === choice.priorId
                  ? { state: "ok", data: cmp.data }
                  : { state: "none", reason: "error" })
              : { state: "none", reason: cmp.kind === "refused" ? "refused" : "error" };

  const sectorDoc = own(sectorQ);
  const sector: SourceState<SectorBenchmarkDoc> = !ready
    ? { state: "none", reason: "no_period" }
    : sectorDoc === undefined
      ? (sectorQ.isError ? { state: "none", reason: "error" } : { state: "pending" })
      : sectorDoc === null || !names(sectorDoc.period?.id, periodId)
        ? { state: "none", reason: "error" }
        : sectorDoc.status === "ok"
          ? { state: "ok", data: sectorDoc }
          : { state: "none", reason: "refused" };

  const att = own(attentionQ);
  const attention: SourceState<AttentionDoc> = !ready
    ? { state: "none", reason: "no_period" }
    : att === undefined
      ? { state: "pending" }
      : att.kind === "ok"
        ? (names(att.data.period?.id, periodId) && names(att.data.period?.org_id, companyId)
            ? { state: "ok", data: att.data }
            : { state: "none", reason: "error" })
        : { state: "none", reason: att.kind === "refused" ? "refused" : "error" };

  // Company × year: the active company's years always (warm), every other
  // company's only while the bar is open — never on a keystroke, never
  // while a switch is in flight. Each list is keyed by its company and read
  // only as the answer for that key.
  const yearOrgs = useMemo(
    () => (!activeId ? [] : opts.open ? orgs.map((o) => o.id) : [activeId]),
    [opts.open, orgs, activeId],
  );
  const yearQs = useQueries({
    queries: yearOrgs.map((id) => ({
      queryKey: ["company-years", id],
      queryFn: () => fetchCompanyYears(id),
      staleTime: 30_000,
    })),
  });
  const years: Record<string, CompanyYear[] | undefined> = {};
  yearOrgs.forEach((id, i) => { years[id] = yearQs[i] ? own(yearQs[i]) : undefined; });

  return {
    scope,
    body: ready ? payload : null,
    comparatives,
    sector,
    attention,
    prior,
    companies: orgs,
    years,
  };
}

/** The month the header line names for the scope (the stepper's format). */
export function scopeMonth(scope: CmdbarScope, locale: string): string | null {
  return formatPeriodMonth(scope.periodEnd, locale) ?? null;
}

/** Mounted once in AppShell: keeps the bar's documents warm on every
 *  (org, period) change, so opening ⌘K paints from cache. Renders nothing. */
export function CommandBarPrefetch(): null {
  useCmdbarData({ open: false });
  return null;
}
