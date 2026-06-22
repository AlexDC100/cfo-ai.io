// Single TanStack Query client used across the entire app.
//
// Extracted from App.tsx so non-component modules (auth context, navigation
// helpers) can call `queryClient.clear()` directly without prop-drilling or
// piping the client through React Context. The previous home of this object
// (a top-level const inside App.tsx) made that impossible — auth.tsx is
// imported BY App.tsx, so it can't import App.tsx back without a circular
// dependency.
//
// Tuning rationale (preserved verbatim from the App.tsx site):
//
//   · staleTime 5min — period analyses don't change unless the user
//     re-uploads, so navigating Dashboard → Cash → Dashboard should pull
//     from cache, not the network.
//   · gcTime 30min — keep cached payloads warm for half an hour after the
//     last subscriber unmounts, so tabbing away then coming back is instant.
//   · refetchOnWindowFocus true — background refresh on tab focus picks
//     up new data without blocking the user.
//   · refetchOnMount false — critical to prevent re-mounting a page from
//     re-fetching every query it depends on. The cache is the source of
//     truth between explicit refetches.
//   · retry 1 — one bounce-back attempt on transient failures; beyond
//     that we let the page render its empty/error state.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: true,
      refetchOnMount: false,
      retry: 1,
    },
  },
});
