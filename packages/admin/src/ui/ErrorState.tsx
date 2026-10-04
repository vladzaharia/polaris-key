import * as React from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { cn } from "../lib/cn.js";
import { errorCopy, type ErrorContext } from "../lib/errorCopy.js";
import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";

/**
 * A failed load, rendered through `errorCopy` (components.md §5.5): what went wrong in words, and
 * the next step. Never `EmptyState` with a warning icon (UI-14), never "api 422". The retry label
 * is always "Retry". `compact` fits inside a table body or a tile.
 */
export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  context?: ErrorContext;
  compact?: boolean;
  className?: string;
}

export function ErrorState({
  error,
  onRetry,
  context,
  compact = false,
  className,
}: ErrorStateProps): React.ReactElement {
  const copy = errorCopy(error, context);
  const titleId = React.useId();
  return (
    <div
      role="alert"
      aria-labelledby={titleId}
      data-error-action={copy.action}
      className={cn(
        "flex flex-col items-center gap-3 text-center",
        compact
          ? "px-4 py-6"
          : "rounded-lg border border-border bg-surface-raised px-6 py-12",
        className,
      )}
    >
      <AlertTriangle
        aria-hidden
        className={cn("text-danger", compact ? "size-5" : "size-8")}
      />
      <div className="max-w-md space-y-1">
        <p id={titleId} className="text-sm font-bold text-fg-strong">
          {copy.title}
        </p>
        <p className="text-sm text-fg-muted">{copy.description}</p>
        {copy.lines?.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-left text-sm text-fg">
            {copy.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
        {copy.references?.length ? (
          <ul className="mt-2 space-y-1 text-left text-sm text-fg">
            {copy.references.map((r) => (
              <li key={r} className="font-mono text-xs">
                {r}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button
            size="sm"
            variant="outline"
            iconStart={<RotateCw />}
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : null}
        {copy.action === "reload" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.location.reload()}
          >
            Reload the page
          </Button>
        ) : null}
        {copy.action === "sign-in" ? (
          <Button size="sm" asChild>
            <a
              href={`/manage/login?returnTo=${encodeURIComponent(window.location.hash)}`}
            >
              Sign in
            </a>
          </Button>
        ) : null}
        {copy.action === "platform" ? (
          <Button size="sm" variant="outline" asChild>
            <a href="#/platform">Open Platform</a>
          </Button>
        ) : null}
        {copy.action === "none" && context?.collectionHref ? (
          <Button size="sm" variant="outline" asChild>
            <a href={context.collectionHref}>Back to the list</a>
          </Button>
        ) : null}
        {copy.action === "copy-details" ? (
          <CopyButton
            value={JSON.stringify(copy.details, null, 2)}
            label="Copy details"
            showLabel
          />
        ) : null}
      </div>
    </div>
  );
}
