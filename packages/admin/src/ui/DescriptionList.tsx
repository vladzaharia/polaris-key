import * as React from "react";
import { cn } from "../lib/cn.js";

export interface DescriptionItem {
  term: React.ReactNode;
  detail: React.ReactNode;
  /** A short explanation under the detail. */
  help?: React.ReactNode;
}

/**
 * A `<dl>` of facts (components.md §6.3): the record Overview tab, drawers, the T4 read-outs.
 * Collapses to one column below 640 px. Replaces the 4 hand-rolled copies.
 */
export function DescriptionList({
  items,
  columns = 1,
  rows = false,
  className,
}: {
  items: DescriptionItem[];
  columns?: 1 | 2 | 3;
  /**
   * A label column and a flush-right value column with a rule between rows, from 640 px up (a drawer's facts);
   * below that each fact stacks.
   */
  rows?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <dl
      className={cn(
        rows ? "divide-y divide-border" : "grid gap-x-6 gap-y-4",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {items.map((item, i) => (
        <div
          key={i}
          className={cn(
            "min-w-0",
            rows &&
              "py-3 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-x-4",
          )}
        >
          <dt className={cn("text-xs text-fg-muted", rows && "sm:pt-0.5")}>
            {item.term}
          </dt>
          <dd
            className={cn(
              "min-w-0 break-words text-sm text-fg",
              !rows && "mt-0.5",
              rows && "mt-0.5 sm:mt-0 sm:text-end",
            )}
          >
            {item.detail}
            {item.help ? (
              <p className="mt-0.5 text-xs text-fg-subtle">{item.help}</p>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
