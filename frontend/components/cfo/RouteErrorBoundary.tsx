// Route-scoped error boundary.
//
// Two-tier ErrorBoundary stack: the top-level `<ErrorBoundary>` (rendered
// outside the entire ThemeProvider/QueryClient/AuthProvider stack in App.tsx)
// catches catastrophic failures — anything that breaks before React even gets
// to render the route tree. It's a last-resort full-screen fallback.
//
// This boundary is the route-scoped layer that sits INSIDE the providers but
// AROUND the lazy-loaded route element. Two consequences:
//
//   1. If Dashboard.tsx throws on render (bad data shape, missing key, etc.),
//      the user sees a styled in-page error instead of being booted to a full-
//      screen takeover. The AuthProvider stays mounted (session preserved),
//      the QueryClient stays mounted (cached payloads preserved), and the
//      next click on a sidebar link navigates away cleanly.
//
//   2. The boundary auto-resets on navigation because `useLocation()` causes
//      a re-mount when `pathname` changes — we use `key={pathname}` upstream.
//      That means clicking "Go to dashboard" from the fallback genuinely
//      recovers; we don't need explicit reset state plumbing.
//
// Distinct from the top-level `<ErrorBoundary>` (src/components/cfo/ErrorBoundary.tsx):
//
//   · Top-level: full-screen, used when EVERYTHING is broken (theme/router/auth).
//   · This one:  in-card, in-content-area, used when a single route is broken.
//
// The fallback is intentionally smaller + less dramatic — most route errors
// are recoverable (stale cache, fresh deploy chunk-load failure, transient
// network error rehydrating a query). Burning a full-screen takeover for
// "the SKU table got a malformed row" overcorrects.

import { Component, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RotateCw, Home } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to the console with the React component stack so dev tools
    // show the failing component hierarchy, not just the JS stack.
    console.error("[RouteErrorBoundary]", error, info.componentStack);
  }

  reload = () => {
    window.location.reload();
  };

  /** Last-resort escape: clear known client-side caches that can hold a
   *  page in a throw loop across reloads, then hard-reload + navigate to
   *  /dashboard. The most common offender is `cfo-upload-current` —
   *  the persisted in-flight upload state (see `lib/uploadStore.ts`).
   *  When a render path throws while consuming that state, every reload
   *  rehydrates the same stuck state and re-throws, leaving the user
   *  with "Reload" / "Dashboard" buttons that don't actually escape.
   *  This handler:
   *    1. Removes the persisted upload-in-flight record.
   *    2. Removes the accuracy-banner dismissal so they see telemetry
   *       again on the fresh load.
   *    3. Removes the currency-display pref so they fall back to the
   *       default (eliminates a stale currency that's been blamed for
   *       throws in the past).
   *    4. Hard-redirects to /dashboard?reset=1 — the query string
   *       differentiates a recovery reload from a normal one in case
   *       any consumer wants to log/diagnose it.
   *  Local/session storage failures (private mode, quota) are silently
   *  swallowed — we still complete the redirect either way. */
  clearAndRestart = () => {
    try {
      localStorage.removeItem("cfo-upload-current");
      localStorage.removeItem("accuracy_banner_dismissed");
      localStorage.removeItem("cfo:currency-display:v1");
      sessionStorage.removeItem("cfoai.parsed");
      sessionStorage.removeItem("cfo-ai:dismissed-inflight-ids:v1");
    } catch {
      /* private-mode / quota — proceed with redirect anyway */
    }
    window.location.href = "/dashboard?reset=1";
  };

  render() {
    if (this.state.error) {
      const isDev = import.meta.env.DEV;
      // ChunkLoadError fires when a lazy() chunk fails to fetch — almost
      // always because a deploy invalidated the chunk hash while the user
      // had an old index.html tab open. Hard-reload is the only recovery.
      // We surface this with a different message so the user isn't confused
      // about why "the page broke" right after a deploy.
      const isChunkLoadError =
        this.state.error.name === "ChunkLoadError" ||
        /Loading chunk \d+ failed/.test(this.state.error.message) ||
        /Failed to fetch dynamically imported module/.test(
          this.state.error.message,
        );

      return (
        <div className="min-h-[calc(100dvh-8rem)] flex flex-col items-center justify-center px-6 py-12">
          <div className="w-full text-center">
            <div className="mx-auto h-11 w-11 rounded-full bg-alert/10 text-alert flex items-center justify-center mb-3">
              <AlertTriangle size={20} strokeWidth={1.75} />
            </div>
            <h2 className="font-serif text-[20px] text-ink leading-tight">
              {isChunkLoadError
                ? "This page needs a refresh"
                : "This page hit an error"}
            </h2>
            <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
              {isChunkLoadError
                ? "We just shipped an update — your browser is loading an older version. Reload to pick up the new code."
                : "Your session is still active and your data is safe. Reload this page or head back to the dashboard."}
            </p>
            {isDev && !isChunkLoadError && (
              <pre className="mt-4 w-full text-left text-[11px] font-mono text-alert bg-alert/5 border border-alert/20 rounded-lg p-3 overflow-auto max-h-[55vh]">
                {this.state.error.message}
                {"\n"}
                {this.state.error.stack?.slice(0, 1200)}
              </pre>
            )}
            <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
              <button
                onClick={this.reload}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-brand text-primary-foreground text-[13px] font-medium hover:bg-brand/90 transition-colors"
              >
                <RotateCw size={14} strokeWidth={2} />
                Reload
              </button>
              <Link
                to="/dashboard"
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-rule text-[13px] text-ink hover:bg-bg-2 transition-colors"
              >
                <Home size={14} strokeWidth={2} />
                Dashboard
              </Link>
              {/* Last-resort escape — only meaningful when Reload + Dashboard
                  fail (the page re-throws on every render because some
                  persisted client state is the cause). Nukes upload state
                  + currency pref + dismissed-banner state and redirects
                  to /dashboard?reset=1. See `clearAndRestart`. */}
              <button
                onClick={this.clearAndRestart}
                data-testid="route-error-clear-restart"
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-alert/40 text-[13px] text-alert hover:bg-alert/5 transition-colors"
              >
                Clear &amp; restart
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
