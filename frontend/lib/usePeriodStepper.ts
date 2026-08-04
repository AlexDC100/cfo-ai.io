// usePeriodStepper — shared period-stepping state for the TopHeader
// breadcrumb and the Sidebar rail label.
//
// Extracted from SidebarMonthStepper (2026-08-04) when the month
// breadcrumb moved back into the header: both surfaces need the same
// merged period list, the same `?period=<id>`-wins selection rule and
// the same looping prev/next targets, and duplicating the resolution
// logic is exactly how the header and the rail previously drifted apart.

import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { useActivePeriod } from "@/lib/activePeriod";
import { useActiveOrg } from "@/lib/org";
import {
  fetchWorkspacePeriodsDirect,
  formatPeriodMonth,
  formatPeriodYear,
  useOrgPeriods,
  type OrgPeriod,
} from "@/lib/orgPeriods";
import { startPeriodSwitch } from "@/lib/periodSwitch";
import { blockedByScan } from "@/lib/scanGuard";

export interface PeriodStepper {
  /** Merged, newest-first period list (engine feed + direct Supabase feed). */
  periods: OrgPeriod[];
  /** The selected period's end date (or null when nothing resolvable). */
  selectedEnd: string | null;
  /** "Dec 2025"-style label for the selection; null when nothing loaded. */
  selectedMonth: string | null;
  /** "2025"-style label for the selection; null when nothing loaded. */
  selectedYear: string | null;
  /** Older / newer step targets (looping at the ends). Null with <2 periods. */
  prevTarget: OrgPeriod | null;
  nextTarget: OrgPeriod | null;
  /** True when there are ≥2 periods to step between. */
  showStepper: boolean;
  /** Navigate to a period id (guards against in-flight scans). */
  goToPeriod: (periodId: string) => void;
}

export function usePeriodStepper(): PeriodStepper {
  const period = useActivePeriod();
  const [params, setParams] = useSearchParams();
  const { data: periodsData } = useOrgPeriods();
  // Empty periods too — the engine feed only knows analyzed periods, so a
  // container created in the Workspace tab with no file yet would be
  // invisible. Merge in the direct Supabase feed (same ["org-periods",
  // orgId] cache the Workspace tab populates).
  const { org } = useActiveOrg();
  const { data: directData } = useQuery({
    queryKey: ["org-periods", org?.id],
    queryFn: () => fetchWorkspacePeriodsDirect(org!.id),
    enabled: !!org?.id,
    staleTime: 60_000,
  });
  const periods = useMemo<OrgPeriod[]>(() => {
    const engine = periodsData?.periods ?? [];
    const seen = new Set(engine.map((p) => p.period_id));
    const extras = (directData?.periods ?? []).filter((p) => !seen.has(p.period_id));
    return [...engine, ...extras].sort((a, b) =>
      (b.period_end ?? "").localeCompare(a.period_end ?? ""),
    );
  }, [periodsData, directData]);

  // `?period=<id>` is the app-wide SELECTION key, so it wins; the resolved
  // analysis period is only the fallback for a bare URL.
  const selectedId = params.get("period") ?? period.id ?? null;
  const listMatch = selectedId
    ? periods.find((p) => p.period_id === selectedId) ?? null
    : null;
  const selectedEnd = listMatch
    ? listMatch.period_end
    // Not in the list (a sample/demo id, or the list hasn't loaded yet) — the
    // resolved period can still name it, but only when it IS the selected one.
    : selectedId && period.id === selectedId
      ? period.periodEnd
      // A selected id we can't resolve names no month: better the caller's
      // current-month fallback than another period's date.
      : selectedId
        ? null
        : periods[0]?.period_end ?? null;

  const periodIdx = selectedId
    ? periods.findIndex((p) => p.period_id === selectedId)
    : -1;
  // Newest-first ordering: the OLDER month is further down the list.
  const olderPeriod = periodIdx >= 0 && periodIdx < periods.length - 1 ? periods[periodIdx + 1] : null;
  const newerPeriod = periodIdx > 0 ? periods[periodIdx - 1] : null;
  const prevTarget = olderPeriod ?? periods[0] ?? null;
  const nextTarget = newerPeriod ?? periods[periods.length - 1] ?? null;
  const showStepper = periods.length >= 2;

  function goToPeriod(periodId: string) {
    // Not while an analysis is running — see lib/scanGuard.
    if (blockedByScan("period")) return;
    const target = periods.find((p) => p.period_id === periodId);
    startPeriodSwitch(formatPeriodMonth(target?.period_end) ?? undefined);
    const sp = new URLSearchParams(params);
    sp.set("period", periodId);
    // Replace, not push — month stepping is substitution; Back should leave
    // the page rather than replay every month stepped through.
    setParams(sp, { replace: true });
  }

  return {
    periods,
    selectedEnd,
    selectedMonth: formatPeriodMonth(selectedEnd),
    selectedYear: formatPeriodYear(selectedEnd),
    prevTarget: showStepper ? prevTarget : null,
    nextTarget: showStepper ? nextTarget : null,
    showStepper,
    goToPeriod,
  };
}
