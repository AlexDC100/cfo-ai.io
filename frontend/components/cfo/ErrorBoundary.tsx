// App-level error boundary.
//
// Catches any thrown render error so the user sees a styled fallback instead
// of a blank page. In dev we surface the message + stack so debugging is fast;
// in prod we hide the stack and offer "Reload" / "Go home" actions.

import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCw, Home } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to the console so we have the full stack in dev tools even if
    // the styled fallback hides it from the visible UI.
    // eslint-disable-next-line no-console
    console.error("Unhandled render error:", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  goHome = () => {
    window.location.assign("/");
  };

  reload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      const isDev = import.meta.env.DEV;
      return (
        <div className="min-h-screen bg-bg text-ink flex items-center justify-center px-6 py-12">
          <div className="max-w-[560px] w-full rounded-2xl border border-rule bg-surface p-7 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-alert/10 text-alert flex items-center justify-center mb-4">
              <AlertTriangle size={22} strokeWidth={1.75} />
            </div>
            {/* design-lint-allow-serif: empty-state voice — one serif line per the brief */}
          <h1 className="font-serif text-[26px] text-ink leading-tight">Something went wrong</h1>
            <p className="text-[13.5px] text-ink-soft mt-2">
              The page hit an unexpected error. Your data is safe — try
              reloading, or head back to the dashboard.
            </p>
            {isDev && (
              <pre className="mt-4 text-left text-[11px] font-mono text-alert bg-alert/5 border border-alert/20 rounded-lg p-3 overflow-auto max-h-[180px]">
                {this.state.error.message}
                {"\n"}
                {this.state.error.stack?.slice(0, 1500)}
              </pre>
            )}
            <div className="mt-5 flex items-center justify-center gap-2">
              <button
                onClick={this.reload}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-brand text-paper text-[13px] font-medium hover:bg-brand-d transition-colors"
              >
                <RotateCw size={14} strokeWidth={2} />
                Reload page
              </button>
              <button
                onClick={this.goHome}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-rule text-[13px] text-ink hover:bg-bg-2 transition-colors"
              >
                <Home size={14} strokeWidth={2} />
                Go home
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
