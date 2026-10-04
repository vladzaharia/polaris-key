import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button, EmptyState } from "../../components/ui/index.js";

/**
 * A page that throws while rendering takes only itself down, never the shell: the sidebar, the
 * switcher and the palette stay usable, so the operator can go somewhere that works. Keyed on the
 * route by its parent, so navigating away resets it.
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
          className="text-2xl font-bold tracking-tight text-fg-strong outline-hidden"
        >
          This page failed to load
        </h1>
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Something on this page broke while it was drawing."
          description={
            this.state.error.message || "An unexpected error occurred."
          }
          action={
            <Button onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        />
      </section>
    );
  }
}
