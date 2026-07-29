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
//   · staleTime 30min — period analyses don't change unless the user
//     re-uploads, so within a working session the cache is treated as fresh:
//     navigating between tabs pulls from cache with ZERO refetch, so data
//     appears instantly and no loader flashes.
//   · gcTime 2h — keep cached payloads warm long after the last subscriber
//     unmounts, so tabbing away then coming back (even much later) is instant.
//   · refetchOnWindowFocus false — a background refetch on focus can repaint
//     a page the user is reading; with the long staleTime the cache is the
//     source of truth and explicit refetch/invalidate handles freshness.
//   · refetchOnMount false — critical to prevent re-mounting a page from
//     re-fetching every query it depends on. The cache is the source of
//     truth between explicit refetches.
//   · retry 1 — one bounce-back attempt on transient failures; beyond
//     that we let the page render its empty/error state.
//   · placeholderData keepPreviousData — when a query key changes (e.g. the
//     active period switches) keep showing the previous result until the new
//     one arrives, so the page never blanks to a loader mid-navigation.

import { QueryClient, keepPreviousData } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 60 * 1000,
      gcTime: 2 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      placeholderData: keepPreviousData,
      retry: 1,
    },
  },
});
