// useEnsureCurrentPeriod — the current month always exists, in every workspace.
//
// "No period" is not a state the app can sit in (2026-07-26 per operator), and
// the guaranteed month is specifically the CURRENT month and year: the one
// you'd file today's trial balance into. It is created on demand and can never
// be deleted (the Workspace page refuses — see `isCurrentMonthPeriod`), so
// every surface always has a month to show, name and upload into.
//
// Originally this only fired when the period list was EMPTY. Now it also fills
// in the current month for a workspace that has older months but nothing for
// today — otherwise a workspace whose last upload was December would offer no
// place to put January's file without the user creating one by hand.
//
// The period is a container only — no document, no statements. The dashboard
// therefore still shows its dropzone (State A) for it; what changes is that
// the month exists, is selectable, and a file dropped anywhere lands in it.
//
// Mounted ONCE (AppShell), not per page: two surfaces racing to create the
// same month would insert two rows for it.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveOrg } from "@/lib/org";
import {
  createEmptyPeriod,
  currentMonthEnd,
  fetchWorkspacePeriodsDirect,
  isCurrentMonthPeriod,
} from "@/lib/orgPeriods";

// Orgs we've already tried this session, keyed by org + month. Without it a
// failing insert (RLS, offline, a unique-violation from another tab) would be
// retried on every render of every page for as long as the month is missing.
// The month is part of the key so the attempt is retried after a month rolls
// over in a long-lived session.
const attempted = new Set<string>();

export function useEnsureCurrentPeriod(): void {
  const { org } = useActiveOrg();
  const orgId = org?.id ?? null;
  const qc = useQueryClient();

  // Same key the Workspace months list and the sidebar stepper read, so the
  // created period appears everywhere off one invalidation.
  const { data: payload } = useQuery({
    queryKey: ["org-periods", orgId],
    queryFn: () => fetchWorkspacePeriodsDirect(orgId as string),
    enabled: !!orgId,
  });

  useEffect(() => {
    // `null` = the fetch failed (not signed in / offline). Only a real payload
    // tells us anything about which months this workspace has.
    if (!orgId || !payload) return;
    if (payload.periods.some((p) => isCurrentMonthPeriod(p.period_end))) return;

    const monthEnd = currentMonthEnd();
    const attemptKey = `${orgId}:${monthEnd}`;
    if (attempted.has(attemptKey)) return;
    attempted.add(attemptKey);

    void (async () => {
      // Re-read from the SERVER before inserting. The cached payload above is
      // not proof: the query cache is persisted to localStorage with a
      // 30-minute staleTime and refetchOnMount off, so a reload can hydrate a
      // stale snapshot and serve it without ever hitting the network — which
      // is exactly how this created a duplicate period on every refresh
      // (operator-reported, 5 rows for the same month). This read costs one
      // request on the rare missing-month path.
      const fresh = await fetchWorkspacePeriodsDirect(orgId);
      if (!fresh) return;                      // fetch failed — try again next session
      if (fresh.periods.some((p) => isCurrentMonthPeriod(p.period_end))) {
        // The cache lied. Repair it so nothing else acts on the stale copy.
        qc.setQueryData(["org-periods", orgId], fresh);
        return;
      }
      const res = await createEmptyPeriod(orgId, monthEnd);
      if ("error" in res) {
        console.warn("[periods] auto-create for current month failed:", res.error);
        return;
      }
      void qc.invalidateQueries({ queryKey: ["org-periods", orgId] });
      void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    })();
  }, [orgId, payload, qc]);
}
