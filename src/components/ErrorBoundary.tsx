import React from 'react';

/**
 * v1.4.2 — React error boundary.
 *
 * Without this, ANY uncaught render-time exception anywhere in the wrapped
 * subtree unmounts the entire tree (React's default behaviour since React 16),
 * leaving a blank `<div id="root"></div>` with no way to recover except a
 * manual hard reload. This is the root structural cause of "the whole portal
 * turns into a blank white page" — it doesn't matter which specific line
 * throws; without a boundary, EVERY render exception is a full-page crash.
 *
 * Two boundary granularities are used in App.tsx:
 *  - One top-level boundary around the whole app (the final backstop).
 *  - Narrower boundaries around ResultsDrawer / MapView / FloatingAssistant
 *    so a crash in one panel (e.g. malformed result data) doesn't take down
 *    chrome the user needs to recover (sidebar, chat input, nav) — only that
 *    panel shows a fallback, and the rest of the app stays usable.
 */

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Short label identifying which part of the UI this boundary guards —
   * shown in the fallback and included in the logged error for triage. */
  section: string;
  /** Called once when a render error is caught — use this to reset any
   * app-level state (e.g. unlock the chat input, clear a stuck job) that
   * caused or is downstream of the crash, so retrying doesn't immediately
   * re-trigger the same failure. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** Compact inline fallback instead of the full-panel card. */
  compact?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Structured log — surfaced in the console instead of silently going
    // blank, and grep-able by section so a crash report points at the
    // actual broken panel (results / map / chat) rather than "the app".
    // eslint-disable-next-line no-console
    console.error(
      `[Stratageo] Render error in "${this.props.section}":`,
      error,
      '\nComponent stack:', info.componentStack,
    );
    try {
      this.props.onError?.(error, info);
    } catch (handlerErr) {
      // The recovery handler itself must never throw — that would re-crash
      // the boundary that's actively trying to recover.
      // eslint-disable-next-line no-console
      console.error('[Stratageo] ErrorBoundary onError handler threw:', handlerErr);
    }
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.compact) {
        return (
          <div className="error-boundary-compact">
            <span>This section hit an unexpected error.</span>
            <button onClick={this.reset}>Retry</button>
          </div>
        );
      }
      return (
        <div className="error-boundary-panel">
          <div className="error-boundary-title">Something went wrong in {this.props.section}.</div>
          <p className="error-boundary-detail">
            {this.state.error.message || 'An unexpected error occurred while rendering this section.'}
          </p>
          <div className="error-boundary-actions">
            <button onClick={this.reset} className="error-boundary-retry">Try again</button>
            <button onClick={() => window.location.reload()} className="error-boundary-reload">
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
