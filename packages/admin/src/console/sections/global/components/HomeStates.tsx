import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "../../../../ui/Button.js";

/**
 * A Home read that failed keeps its card in its slot and says so, with one way to ask again:
 * a failed read never draws as an all-clear (nothing on screen would tell the operator the list
 * is missing).
 */
export function LoadFailedCard({
  title,
  message,
  onRetry,
  className,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  className?: string;
}): React.ReactElement {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      data-load-failed=""
      className={`rounded-xl border border-border bg-surface-raised light:shadow-elevation-1 ${className ?? ""}`}
    >
      <div data-card-header="" className="border-b border-border px-5 py-3">
        <h2
          id={id}
          tabIndex={-1}
          className="text-lg font-semibold leading-6 text-fg-strong outline-hidden forced-colors:outline-none"
        >
          {title}
        </h2>
      </div>
      <div role="alert" className="space-y-3 px-5 py-4">
        <p className="text-sm text-fg">{message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </section>
  );
}

/** A card-shaped skeleton in the slot a read will fill, so nothing jumps when it arrives. */
export function CardSkeleton({
  label,
  rows,
  className,
}: {
  label: string;
  rows: number;
  className?: string;
}): React.ReactElement {
  return (
    <section
      aria-busy
      aria-label={`Loading ${label}`}
      className={`pk-skeleton-group rounded-xl border border-border bg-surface-raised ${className ?? ""}`}
    >
      <div className="border-b border-border px-5 py-3">
        <div className="pk-skeleton h-6 w-40 rounded" />
      </div>
      <div className="space-y-3 px-5 py-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="pk-skeleton h-6 w-full rounded" />
        ))}
      </div>
    </section>
  );
}

/** The quiet one-line all-clear: nothing is broken. */
export function AllClear(): React.ReactElement {
  return (
    <p
      data-all-clear=""
      tabIndex={-1}
      className="flex items-center gap-2 text-sm text-fg-muted outline-hidden focus-visible:outline-2 focus-visible:outline-focus"
    >
      <Check aria-hidden className="size-4 text-success" />
      Nothing needs attention.
    </p>
  );
}
