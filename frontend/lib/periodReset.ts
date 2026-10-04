// periodReset.ts — A PERIOD'S BOOK CHANGED UNDER THE SAME PERIOD ID.
//
// A period is a slot in a workspace: a re-upload for the same month, an
// adopted empty period, a rename onto another month, an undone
// reconciliation, a re-extraction — each leaves the id and changes what the
// engine serves under it. Every such path reset the PERIOD query
// (`periodQueryKey(id)`), and nothing reset the COMPARISONS that name the
// period: the comparatives document of (period, prior) stayed in the cache
// for its five-minute staleTime, describing the previous book.
//
// Measured 2026-10-04 (the pre-deploy review), with the app's own query
// defaults and two books served under one id: one comparatives request in
// total, two period requests, and 47 of 51 balance-sheet share cells printed
// the PREVIOUS book's share beside the new book's amount ("70.1% +17.5 pp"
// on a row whose own share is 0.2%).
//
// One function, used by every path that resets a period: the period's own
// answer and every comparison with the period on EITHER side are reset
// together. `resetQueries`, not `invalidateQueries`: the app's client does
// not refetch a stale query on mount (lib/queryClient.ts), so an invalidated
// comparison no page has mounted would come back, unasked, the next time its
// pair is opened; a reset one has no answer until the engine gives a new one.
// (`useComparatives` keeps no placeholder: until then the page shows the
// period on its own.)

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { periodQueryKey } from "@/lib/activePeriod";
import { COMPARATIVES_QUERY_ROOT } from "@/lib/comparatives";

/** A comparison's query key — `[root, orgId, periodId, priorId]`
 *  (`comparativesQueryKey`) — names `periodId` on either side. */
export function comparisonNamesPeriod(queryKey: QueryKey, periodId: string): boolean {
  return queryKey[0] === COMPARATIVES_QUERY_ROOT && (queryKey[2] === periodId || queryKey[3] === periodId);
}

/** Everything the engine answered about `periodId` is asked again: the
 *  period itself, and every comparison that has it as its current or its
 *  comparison period. */
export function resetPeriodAnswers(client: QueryClient, periodId: string): void {
  void client.resetQueries({ queryKey: periodQueryKey(periodId) });
  void client.resetQueries({ predicate: (query) => comparisonNamesPeriod(query.queryKey, periodId) });
}
