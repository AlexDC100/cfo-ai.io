// RouteFallback — the placeholder shown while a lazy-loaded page chunk
// fetches. Used by the <Suspense> boundary that wraps the app's
// <Routes /> in App.tsx after the 2026-05-26 perf pass converted
// every auth-gated route to React.lazy().
//
// Design intent
// -------------
// Loading skeletons were removed app-wide (2026-07-25) — the pulsing
// silhouette that morphed into the real page read as phantom content.
// This is now a neutral, still placeholder: it just holds the space
// (bg only) for the ~80-300ms it takes to fetch the next chunk. No
// pulse, no layout-shaped bones.
//
// A11y
// ----
// `role="status"` + visually-hidden text exposes the loading state to
// screen readers. `aria-busy="true"` lets assistive tech know the
// content is in flight.

export function RouteFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading page"
      data-testid="route-fallback"
      className="min-h-screen w-full bg-bg dark:bg-bg"
    >
      <span className="sr-only">Loading…</span>
    </div>
  );
}
