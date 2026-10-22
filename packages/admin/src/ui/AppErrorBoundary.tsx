import * as React from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";

/**
 * The app's last line (P4): a page that throws while rendering shows the house error state, not a
 * blank window. It names what happened in words, offers Reload, and copies the details a report
 * needs (the message, the component stack and the page). Pages with their own `ErrorState` for a
 * failed load never reach it; this catches the render bug nobody planned for.
 */
interface State {
  error: unknown;
  stack: string;
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  override state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error("Unknown error") };
  }

  override componentDidCatch(_error: unknown, info: React.ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? "" });
  }

  override render(): React.ReactNode {
    const { error, stack } = this.state;
    if (error === null) return this.props.children;
    const details = {
      message: error instanceof Error ? error.message : String(error),
      page: typeof window === "undefined" ? "" : window.location.hash,
      stack: stack.trim().split("\n").slice(0, 12),
    };
    return (
      <main
        role="alert"
        aria-labelledby="app-error-title"
        className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      >
        <AlertTriangle aria-hidden className="size-8 text-danger" />
        <div className="space-y-1">
          <h1
            id="app-error-title"
            className="text-base font-semibold text-fg-strong"
          >
            Something went wrong
          </h1>
          <p className="text-sm text-fg-muted">
            The console hit a problem it could not recover from. Reload to start
            again; nothing you had open was saved.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            iconStart={<RotateCw />}
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
          <CopyButton
            value={JSON.stringify(details, null, 2)}
            label="Copy details"
            showLabel
            size="sm"
            text="Copy details"
          />
        </div>
      </main>
    );
  }
}
