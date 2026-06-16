// RouteFallback — the skeleton shown while a lazy-loaded page chunk
// fetches. Used by the <Suspense> boundary that wraps the app's
// <Routes /> in App.tsx after the 2026-05-26 perf pass converted
// every auth-gated route to React.lazy().
//
// Design intent
// -------------
// Skeletons feel ~2× faster than spinners even when the actual load
// time is identical — they say "this is what will be here" instead of
// "something is happening". The shape below approximates the AppShell
// silhouette: a sidebar column on the left, a content area with a
// top header band + 4 KPI tiles + a content card on the right. That
// way the transition from /dashboard to /products doesn't flash an
// empty page; the user sees a layout-matched placeholder for the
// ~80-300ms it takes to fetch the next chunk on a typical connection.
//
// Animation
// ---------
// CSS-only `animate-pulse` (Tailwind built-in). No Framer Motion —
// adding a JS animation runtime to the fallback would defeat the
// purpose: the skeleton needs to render instantly without waiting on
// the page chunk it's standing in for.
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
      className="
        min-h-screen w-full
        bg-bg dark:bg-bg
        flex
      "
    >
      <span className="sr-only">Loading…</span>

      {/* Sidebar silhouette — fixed width matches AppShell's 240px
          sidebar on desktop; collapses on mobile to keep the content
          area honest at narrow viewports. */}
      <aside
        aria-hidden
        className="
          hidden md:flex
          w-[240px] shrink-0
          border-r border-rule
          bg-bg-2/40
          flex-col gap-2 p-4
        "
      >
        <div className="h-8 w-32 rounded-md bg-bg-2 animate-pulse" />
        <div className="h-px bg-rule my-2" />
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="h-7 w-full rounded-md bg-bg-2/70 animate-pulse"
            style={{ animationDelay: `${i * 60}ms` }}
          />
        ))}
      </aside>

      {/* Main content silhouette */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Top header band — matches AppShell's TopHeader height */}
        <div className="h-14 border-b border-rule bg-bg-2/40 flex items-center justify-between px-4 sm:px-6">
          <div className="h-7 w-44 rounded-md bg-bg-2 animate-pulse" />
          <div className="flex items-center gap-2">
            <div className="h-7 w-20 rounded-full bg-bg-2 animate-pulse" />
            <div className="h-7 w-7 rounded-full bg-bg-2 animate-pulse" />
          </div>
        </div>

        {/* Body — 4 KPI tiles + a wide content card. The proportions
            mirror what the user sees on Dashboard/Products/Markets so
            this works as a generic placeholder for any lazy route. */}
        <div className="p-4 sm:p-6 flex-1 space-y-4">
          {/* Page title row */}
          <div className="flex items-center gap-3">
            <div className="h-8 w-56 rounded-md bg-bg-2 animate-pulse" />
            <div className="h-7 w-24 rounded-full bg-bg-2/60 animate-pulse" />
          </div>

          {/* KPI tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="
                  h-24 rounded-2xl
                  border border-rule bg-bg-2/30
                  animate-pulse
                "
                style={{ animationDelay: `${i * 80}ms` }}
              />
            ))}
          </div>

          {/* Main content card */}
          <div
            className="
              rounded-2xl border border-rule bg-bg-2/20
              h-[480px] animate-pulse
            "
            style={{ animationDelay: "260ms" }}
          />
        </div>
      </main>
    </div>
  );
}
