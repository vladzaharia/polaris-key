import * as React from "react";
import { cn } from "../lib/cn.js";
import {
  formatDate,
  formatDateTime,
  formatIso,
  formatRelative,
  formatTableTime,
  type FormatOptions,
} from "../lib/format.js";
import { Tooltip } from "./Tooltip.js";

export type TimestampFormat =
  | "relative"
  | "absolute"
  | "date"
  | "table"
  | "detail";

export interface TimestampProps extends FormatOptions {
  /** The instant, in epoch milliseconds (convert API seconds with `fromSeconds`). */
  at: number;
  /**
   * - `table` (default): relative under 7 days, else the date; the absolute instant in a tooltip
   *   and an sr-only span.
   * - `detail`: the absolute instant (zone shown) visibly, then the relative.
   * - `relative`, `absolute`, `date`: just that rendering.
   */
  format?: TimestampFormat;
  /** "Now", for tests and stable stories. */
  now?: number;
  className?: string;
}

/**
 * A point in time (components.md §6.10, ADMIN.md §5.9). Renders `<time dateTime>` and is never
 * focusable itself (fixes ACT-4); in tables the absolute value is in the accessible text, so the
 * tooltip is a convenience, not the only home of the fact.
 */
export function Timestamp({
  at,
  format = "table",
  now,
  className,
  locale,
  timeZone,
}: TimestampProps): React.ReactElement {
  const opts = { locale, timeZone };
  const current = now ?? Date.now();
  const iso = formatIso(at);
  const absolute = formatDateTime(at, opts);

  if (format === "detail") {
    return (
      <time dateTime={iso} className={cn("text-fg", className)}>
        {absolute}
        <span className="text-fg-muted">
          {" "}
          · {formatRelative(at, current, opts)}
        </span>
      </time>
    );
  }
  if (format === "table") {
    const shown = formatTableTime(at, current, opts);
    return (
      <Tooltip content={absolute}>
        <time
          dateTime={iso}
          className={cn(
            "whitespace-nowrap tabular-nums text-fg-muted",
            className,
          )}
        >
          <span aria-hidden>{shown}</span>
          <span className="sr-only">
            {shown}, {absolute}
          </span>
        </time>
      </Tooltip>
    );
  }
  const text =
    format === "relative"
      ? formatRelative(at, current, opts)
      : format === "date"
        ? formatDate(at, opts)
        : absolute;
  return (
    <time
      dateTime={iso}
      className={cn("whitespace-nowrap tabular-nums", className)}
    >
      {text}
    </time>
  );
}
