// RouteFallback — the placeholder shown while a lazy-loaded page chunk
// fetches. Used by the <Suspense> boundary that wraps the app's
// <Routes /> in App.tsx after the 2026-05-26 perf pass converted
// every auth-gated route to React.lazy().
//
// Design intent
// -------------
// 2026-08-04 (global-perf pass): a MINIMAL skeleton returned. The
// 2026-07-25 removal targeted the page-shaped "phantom content"
// silhouettes that morphed into real data — those stay gone. On fast
// connections the chunk lands in ~80-300ms and this barely paints; on
// slow 3G the old blank screen read as a hang for multiple seconds.
// Three abstract shimmer bars communicate "loading" without pretending
// to be content.
//
// A11y
// ----
// `role="status"` + visually-hidden text exposes the loading state to
// screen readers. `aria-busy="true"` lets assistive tech know the
// content is in flight. Bars are aria-hidden decoration.

export function RouteFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading page"
      data-testid="route-fallback"
      className="min-h-screen w-full bg-bg dark:bg-bg"
    >
      <div aria-hidden className="max-w-[720px] mx-auto px-6 pt-28 space-y-4">
        <div className="h-7 w-2/5 rounded-lg bg-bg-2/80 animate-pulse" />
        <div className="h-4 w-4/5 rounded bg-bg-2/60 animate-pulse [animation-delay:120ms]" />
        <div className="h-4 w-3/5 rounded bg-bg-2/60 animate-pulse [animation-delay:240ms]" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
