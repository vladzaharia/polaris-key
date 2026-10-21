import * as React from "react";
import { cn } from "../../../../lib/cn.js";

/**
 * One of a feature's own settings, nested under its row (products.features, `.feature-subs`): the
 * title and one fact per line on the left, the control flush right, an inline error below.
 */
export function FeatureSubRow({
  title,
  htmlFor,
  lines = [],
  control,
  footer,
  stack = false,
  lockedBy,
  lockedId,
  className,
}: {
  title: React.ReactNode;
  /** The control's id: the title labels it. */
  htmlFor?: string;
  /** One fact per line, each its own `description`. */
  lines?: React.ReactNode[];
  control: React.ReactNode;
  footer?: React.ReactNode;
  /** A wide control (a segmented choice) drops under the text on a phone; a switch stays flush right. */
  stack?: boolean;
  /**
   * The feature this row waits on. An off feature's rows all look the same: visible, muted, one
   * line "Turns on with <feature>", the control disabled. `lines` is not shown.
   */
  lockedBy?: string;
  /** The id of the "Turns on with" line, for the control's `aria-describedby`. */
  lockedId?: string;
  className?: string;
}): React.ReactElement {
  const shown = lockedBy
    ? [
        <span key="locked" id={lockedId}>
          Turns on with {lockedBy}
        </span>,
      ]
    : lines;
  return (
    <div
      data-locked={lockedBy ? "" : undefined}
      className={cn("px-4 py-3", className)}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-4",
          stack && "max-sm:flex-wrap",
        )}
      >
        <div className="min-w-0 max-w-[72ch]">
          {htmlFor ? (
            <label
              htmlFor={htmlFor}
              className={cn(
                "block text-sm font-medium",
                lockedBy ? "text-fg-muted" : "text-fg-strong",
              )}
            >
              {title}
            </label>
          ) : (
            <p
              className={cn(
                "text-sm font-medium",
                lockedBy ? "text-fg-muted" : "text-fg-strong",
              )}
            >
              {title}
            </p>
          )}
          {shown.map((line, i) => (
            <p key={i} className="text-sm text-fg-muted">
              {line}
            </p>
          ))}
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center",
            stack && "max-sm:w-full max-sm:min-w-0 max-sm:justify-start",
          )}
        >
          {control}
        </div>
      </div>
      {footer}
    </div>
  );
}
