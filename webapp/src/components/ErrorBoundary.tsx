import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Render error catcher. If a route/hook crashes, keep the whole app from
 * dropping to a white screen - on the bridge, losing telemetry is unacceptable.
 * The error is logged and the user is offered recovery (reload / home). In
 * React, an error boundary must still be a class component (no hook equivalent).
 */
type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No remote log service in production; at least write to the console.
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-6 text-center">
        <span className="t-section">This screen stopped responding.</span>
        <p className="text-sm opacity-70 max-w-xs">
          The screen hit an unexpected error. Reload the page; if it keeps
          happening, close and reopen the app.
        </p>
        <code className="text-xs opacity-50 max-w-xs break-words">{this.state.error.message}</code>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 border border-current"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              window.location.assign("/");
            }}
            className="px-4 py-2 border border-current opacity-70"
          >
            Home
          </button>
        </div>
      </div>
    );
  }
}
