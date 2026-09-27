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
//           active company (the stepper's own fallback);
//   org     the period's own company once its body lands — and when that
//           is not the company open now, the bar says so and searches
//           nothing in it (the companyOnScreen rule).
//
// Mounted twice with one cache: <CommandBarPrefetch/> in AppShell keeps the
// documents warm on every (org, period) change; the palette reads them.
// A keystroke never reaches this hook — it only re-renders on data.

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import {
  fetchPeriodFromApi,
  periodQueryKey,
  type PeriodApiResponse,
  type PeriodFetchResult,
} from "@/lib/activePeriod";
import { useAttention, type AttentionDoc, type AttentionPrior } from "@/lib/attention";
import { comparisonChoiceOf, useComparatives, type ComparativesResponse } from "@/lib/comparatives";
import { useActiveOrg, type Organization } from "@/lib/org";
import { formatPeriodMonth, useCompanyPeriods } from "@/lib/orgPeriods";
import { fetchCompanyYears, type CompanyYear } from "@/lib/uploadsApi";
import { usePeriodStepper } from "@/lib/usePeriodStepper";
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
  | "loading"         // the period body is in flight
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

export function useCmdbarData(opts: { open: boolean }): CmdbarData {
  const [params] = useSearchParams();
  const { org, orgs } = useActiveOrg();
  const { periods } = usePeriodStepper();

  const urlPeriod = params.get("period");
  const periodId =
    urlPeriod && UUID.test(urlPeriod) ? urlPeriod : (periods[0]?.period_id ?? null);

  // THE SAME cache entry `useActivePeriod` reads — one fetch per period.
  const periodQ = useQuery({
    queryKey: periodId ? periodQueryKey(periodId) : ["period", "__noop__"],
    queryFn: () => fetchPeriodFromApi(periodId!),
    enabled: !!periodId && UUID.test(periodId),
  });
  const result: PeriodFetchResult | undefined = periodQ.data;
  const payload = result?.kind === "ok" ? result.data : null;

  const scope = useMemo<CmdbarScope>(() => {
    if (!org) return { status: "no_company", orgId: null, companyName: null, periodId: null, periodEnd: null };
    const base = { orgId: org.id, companyName: org.name, periodId, periodEnd: null as string | null };
    if (!periodId) return { ...base, status: "no_period" };
    const listed = periods.find((p) => p.period_id === periodId);
    const end = payload?.period?.period_end ?? listed?.period_end ?? null;
    // No answer yet: the period body is in flight (or queued behind the
    // workspace list) — the header names the month, the facts say "loading".
    if (!result) return { ...base, periodEnd: end, status: "loading" };
    if (result.kind !== "ok") return { ...base, periodEnd: end, status: "unreadable" };
    const bodyOrg = payload?.organization?.id ?? null;
    if (bodyOrg && bodyOrg !== org.id) return { ...base, periodEnd: end, status: "other_company" };
    const empty = (payload?.line_items?.length ?? 0) === 0 && (payload?.metrics?.length ?? 0) === 0;
    if (empty) return { ...base, periodEnd: end, status: "unreadable" };
    return { ...base, periodEnd: end, status: "ready" };
  }, [org, periodId, periods, payload, result]);

  const ready = scope.status === "ready";
  const companyId = ready ? scope.orgId : null;

  // The reader's comparison choice for THIS company (stored per company),
  // resolved only against the company's own periods (lib/comparatives).
  const stored = readComparativesView(companyId).priorPeriodId;
  const companyPeriods = useCompanyPeriods(companyId);
  const choice = comparisonChoiceOf(
    {
      currentId: ready ? periodId : null,
      currentEnd: scope.periodEnd,
      currentOrgId: companyId,
      activeOrgId: org?.id ?? null,
      stored,
    },
    companyPeriods.data ?? null,
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

  const comparatives: SourceState<ComparativesResponse> = !ready
    ? { state: "none", reason: "no_period" }
    : stored === "none"
      ? { state: "none", reason: "off" }
      : companyPeriods.isLoading
        ? { state: "pending" }
        : !choice.priorId
          ? { state: "none", reason: "no_prior" }
          : cmpQ.data === undefined
            ? { state: "pending" }
            : cmpQ.data.kind === "ok"
              ? { state: "ok", data: cmpQ.data.data }
              : { state: "none", reason: cmpQ.data.kind === "refused" ? "refused" : "error" };

  const sector: SourceState<SectorBenchmarkDoc> = !ready
    ? { state: "none", reason: "no_period" }
    : sectorQ.data === undefined
      ? (sectorQ.isError ? { state: "none", reason: "error" } : { state: "pending" })
      : sectorQ.data === null
        ? { state: "none", reason: "error" }
        : sectorQ.data.status === "ok"
          ? { state: "ok", data: sectorQ.data }
          : { state: "none", reason: "refused" };

  const attention: SourceState<AttentionDoc> = !ready
    ? { state: "none", reason: "no_period" }
    : attentionQ.data === undefined
      ? { state: "pending" }
      : attentionQ.data.kind === "ok"
        ? { state: "ok", data: attentionQ.data.data }
        : { state: "none", reason: attentionQ.data.kind === "refused" ? "refused" : "error" };

  // Company × year: the active company's years always (warm), every other
  // company's only while the bar is open — never on a keystroke.
  const yearOrgs = useMemo(
    () => (opts.open ? orgs.map((o) => o.id) : org ? [org.id] : []),
    [opts.open, orgs, org],
  );
  const yearQs = useQueries({
    queries: yearOrgs.map((id) => ({
      queryKey: ["company-years", id],
      queryFn: () => fetchCompanyYears(id),
      staleTime: 30_000,
    })),
  });
  const years: Record<string, CompanyYear[] | undefined> = {};
  yearOrgs.forEach((id, i) => { years[id] = yearQs[i]?.data; });

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
export function scopeMonth(scope: CmdbarScope, locale?: string): string | null {
  return formatPeriodMonth(scope.periodEnd, locale) ?? null;
}

/** Mounted once in AppShell: keeps the bar's documents warm on every
 *  (org, period) change, so opening ⌘K paints from cache. Renders nothing. */
export function CommandBarPrefetch(): null {
  useCmdbarData({ open: false });
  return null;
}
