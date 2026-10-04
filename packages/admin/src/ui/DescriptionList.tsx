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
  className,
}: {
  items: DescriptionItem[];
  columns?: 1 | 2 | 3;
  className?: string;
}): React.ReactElement {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-4",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {items.map((item, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs text-fg-muted">{item.term}</dt>
          <dd className="mt-0.5 min-w-0 break-words text-sm text-fg">
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
