import * as React from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { cn } from "../lib/cn.js";
import { errorCopy, type ErrorContext } from "../lib/errorCopy.js";
import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";

/**
 * A failed load, rendered through `errorCopy` (components.md §5.5): what went wrong in words, and
 * the next step. Never `EmptyState` with a warning icon (UI-14), never "api 422". The retry label
 * is always "Retry". `compact` is one inline line for a table body, a card or a tile (no Copy
 * details there; the full state offers it).
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
  if (compact) {
    // Inside a tile, a card or a table body: one line, so a failure never stretches its row.
    return (
      <div
        role="alert"
        aria-labelledby={titleId}
        data-error-action={copy.action}
        className={cn(
          "flex flex-wrap items-start gap-x-2 gap-y-1 px-1 py-2 text-sm",
          className,
        )}
      >
        <AlertTriangle
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-danger"
        />
        <p className="min-w-0 flex-1">
          <span id={titleId} className="font-semibold text-fg-strong">
            {copy.title}.
          </span>{" "}
          <span className="text-fg-muted">{copy.description}</span>
        </p>
        <Actions copy={copy} onRetry={onRetry} context={context} compact />
      </div>
    );
  }
  return (
    <div
      role="alert"
      aria-labelledby={titleId}
      data-error-action={copy.action}
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-raised px-6 py-12 text-center",
        className,
      )}
    >
      <AlertTriangle aria-hidden className="size-8 text-danger" />
      <div className="max-w-md space-y-1">
        <p id={titleId} className="text-base font-semibold text-fg-strong">
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
      <Actions copy={copy} onRetry={onRetry} context={context} />
    </div>
  );
}

function Actions({
  copy,
  onRetry,
  context,
  compact = false,
}: {
  copy: ReturnType<typeof errorCopy>;
  onRetry?: () => void;
  context?: ErrorContext;
  compact?: boolean;
}): React.ReactElement {
  const variant = compact ? "ghost" : "outline";
  const size = compact ? "xs" : "sm";
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {onRetry ? (
        <Button
          size={size}
          variant={variant}
          iconStart={<RotateCw />}
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : null}
      {copy.action === "reload" ? (
        <Button
          size={size}
          variant={variant}
          onClick={() => window.location.reload()}
        >
          Reload the page
        </Button>
      ) : null}
      {copy.action === "sign-in" ? (
        <Button size={size} asChild>
          <a
            href={`/manage/login?returnTo=${encodeURIComponent(window.location.hash)}`}
          >
            Sign in
          </a>
        </Button>
      ) : null}
      {copy.action === "platform" ? (
        <Button size={size} variant={variant} asChild>
          <a href="#/platform">Open Platform</a>
        </Button>
      ) : null}
      {copy.action === "none" && context?.collectionHref ? (
        <Button size={size} variant={variant} asChild>
          <a href={context.collectionHref}>Back to the list</a>
        </Button>
      ) : null}
      {copy.action === "copy-details" && !compact ? (
        <CopyButton
          value={JSON.stringify(copy.details, null, 2)}
          label="Copy details"
          showLabel
        />
      ) : null}
    </div>
  );
}
