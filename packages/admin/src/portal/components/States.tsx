import * as React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { StationaryStar } from "../../ui/EmptyState.js";
import { cn } from "../../lib/cn.js";
import { portalErrorCopy } from "../errors.js";

/**
 * A failed load, in the person's words with a Retry (PORTAL.md §4.28, §6.4). Never the HTTP
 * status. `asPage` makes the title the screen's `h1`.
 */
export function ErrorPanel({
  error,
  onRetry,
  asPage = false,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  asPage?: boolean;
  className?: string;
}): React.ReactElement {
  const copy = portalErrorCopy(error);
  const Title = asPage ? "h1" : "h2";
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-xl border border-border bg-surface-raised p-6",
        className,
      )}
    >
      <AlertCircle aria-hidden className="size-6 text-danger" />
      <Title className="text-lg font-semibold text-fg-strong">
        {copy.title}
      </Title>
      <p className="text-fg-muted">{copy.description}</p>
      {onRetry && copy.retry ? (
        <Button
          variant="outline"
          iconStart={<RefreshCw aria-hidden />}
          onClick={onRetry}
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** A centred screen with the stationary star: boot, network errors and other no-context states. */
export function StarScreen({
  title,
  children,
  busy,
}: {
  title: string;
  children?: React.ReactNode;
  busy?: boolean;
}): React.ReactElement {
  return (
    <main
      aria-busy={busy || undefined}
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-page px-4 text-center text-fg"
    >
      <StationaryStar />
      <h1 className="text-xl font-semibold text-fg-strong">{title}</h1>
      {children}
    </main>
  );
}
