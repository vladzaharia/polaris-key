import * as React from "react";
import { ErrorState } from "../../ui/ErrorState.js";

/**
 * A page that throws while rendering takes only itself down, never the shell: the sidebar, the
 * switcher and the palette stay usable, so the operator can go somewhere that works. Keyed on the
 * route by its parent, so navigating away resets it. The failure is the shared `ErrorState`
 * (EXPERIENCE.md §9): what happened, Retry, and Copy details for a bug report.
 */
export class PageErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <section className="space-y-6">
        <h1
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight text-fg-strong outline-hidden"
        >
          This page failed to load
        </h1>
        <ErrorState
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      </section>
    );
  }
}
