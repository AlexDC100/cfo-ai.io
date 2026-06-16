// Tiny inline ErrorBoundary for surgical wrapping of crash-prone render
// regions.
//
// Distinct from RouteErrorBoundary (full-route fallback) and the top-level
// ErrorBoundary (whole-app fallback): this one catches a render error
// INSIDE a single section so the surrounding page stays alive.
//
// The canonical use case is the dashboard's in-flight upload overlay
// (see FinancialStatements.tsx). The RouteErrorBoundary comment block
// already documents the throw-loop class — when a render path throws
// while consuming the persisted `cfo-upload-current` upload state,
// every reload rehydrates the same stuck state and re-throws, leaving
// the user with reload buttons that don't escape. Granular boundaries
// stop the throw from propagating past the section that owns the
// crashing render.
//
// Fallback UI is intentionally compact — this is meant to land
// underneath the user's primary task, not take over the screen. The
// `onReset` callback (when provided) lets the parent clear whatever
// state was producing the crash and re-mount cleanly.

import { Component, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Label for the fallback card. Defaults to "This section failed to load." */
  label?: string;
  /** Optional callback wired to the "Reset" button in the fallback. When
   *  not provided, the button is hidden. */
  onReset?: () => void;
  /** Optional tag in the console error for debugging. Useful when several
   *  InlineErrorBoundaries are on screen at once. */
  tag?: string;
}

interface State {
  error: Error | null;
}

export class InlineErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const tag = this.props.tag ?? "InlineErrorBoundary";
    // eslint-disable-next-line no-console
    console.error(`[${tag}]`, error, info.componentStack);

    // Persist last caught error to localStorage so it survives page
    // refresh + navigation. Lets the operator (or agent inspecting on
    // their behalf) read the error message AFTER the crash, even if
    // console history was lost. Keyed per-tag so multiple boundaries
    // don't clobber each other. 60 KB cap on stack to stay well inside
    // localStorage quotas.
    try {
      const payload = {
        tag,
        timestamp: new Date().toISOString(),
        message: error.message,
        name: error.name,
        stack: (error.stack ?? "").slice(0, 60_000),
        componentStack: (info.componentStack ?? "").slice(0, 60_000),
      };
      localStorage.setItem(
        `cfo-error-boundary-${tag}`,
        JSON.stringify(payload),
      );
    } catch {
      // Storage quota / private mode — silent. The console log above is
      // the always-on path; localStorage is the nice-to-have.
    }
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const label = this.props.label ?? "This section failed to load.";
    const err = this.state.error;
    // First non-empty line of the stack — usually the actual file:line.
    const firstStackLine = (err.stack ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .find((s) => s.startsWith("at ")) ?? "";

    const copyDetails = () => {
      try {
        const text = [
          `[${this.props.tag ?? "InlineErrorBoundary"}]`,
          `${err.name}: ${err.message}`,
          "",
          err.stack ?? "(no stack)",
        ].join("\n");
        navigator.clipboard.writeText(text);
      } catch {
        // Best-effort — older browsers / no permission. The text is
        // visible in the card itself either way.
      }
    };

    return (
      <div
        role="alert"
        data-testid="inline-error-boundary-fallback"
        className="
          rounded-2xl border border-alert/30 bg-alert/5
          px-4 py-3 text-[12.5px] text-alert
          flex items-start gap-2.5
        "
      >
        <AlertCircle size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div>{label}</div>

          {/* Surface the error message + first stack frame INLINE so the
              operator (or an agent reading their screenshot) can root-
              cause without DevTools. This is the difference between
              "the upload card crashed" and "TypeError: Cannot read
              properties of null (reading 'foo') at line 2933". The
              former is useless, the latter is the fix. */}
          <details className="text-[11px] text-alert/90 font-mono">
            <summary className="cursor-pointer select-none hover:underline">
              Show error details
            </summary>
            <div className="mt-1.5 space-y-1 break-words">
              <div>
                <span className="opacity-70">[{this.props.tag ?? "boundary"}] </span>
                <strong>{err.name}: {err.message}</strong>
              </div>
              {firstStackLine && (
                <div className="opacity-80">{firstStackLine}</div>
              )}
            </div>
          </details>

          <div className="flex items-center gap-2 flex-wrap">
            {this.props.onReset && (
              <button
                type="button"
                onClick={this.reset}
                className="
                  inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md
                  border border-alert/40 bg-surface
                  text-[11.5px] font-medium text-alert
                  hover:bg-alert/10 transition-colors
                "
                data-testid="inline-error-boundary-reset"
              >
                Reset
              </button>
            )}
            <button
              type="button"
              onClick={copyDetails}
              className="
                inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md
                border border-alert/30 bg-surface
                text-[11.5px] font-medium text-alert/80
                hover:bg-alert/10 transition-colors
              "
              data-testid="inline-error-boundary-copy"
            >
              Copy error
            </button>
          </div>
        </div>
      </div>
    );
  }
}
