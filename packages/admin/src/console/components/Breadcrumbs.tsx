import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "../router.js";

export interface Crumb {
  label: React.ReactNode;
  /** A console hash (`r.*`). The last crumb is the current page and takes no link. */
  to?: string;
}

/**
 * Breadcrumbs (components.md §1.8): `nav[aria-label="Breadcrumb"]` with an `ol`; the last item is
 * `aria-current="page"`. Shown on detail, editor and wizard pages only.
 */
export function Breadcrumbs({ items }: { items: Crumb[] }): React.ReactElement {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-fg-muted">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1">
              {last || !c.to ? (
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "text-fg" : undefined}
                >
                  {c.label}
                </span>
              ) : (
                <Link
                  to={c.to}
                  className="rounded-xs text-accent-fg underline-offset-4 hover:underline"
                >
                  {c.label}
                </Link>
              )}
              {last ? null : (
                <ChevronRight aria-hidden className="size-3.5 text-fg-subtle" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
