import * as React from "react";
import { cn } from "../../lib/cn.js";

/**
 * A stored key, masked (§4.17): `pkey_` and the separator in `text-fg-subtle`, the slug in
 * `text-accent-fg`, then the ellipsis and the last 4 in `text-fg-strong`. Mono.
 */
export function KeyMask({
  slug,
  last4,
  className,
}: {
  slug: string;
  last4?: string | null;
  className?: string;
}): React.ReactElement {
  return (
    <span
      aria-label={
        last4 ? `License key ending ${last4}` : `License key for ${slug}`
      }
      role="img"
      className={cn("font-mono text-sm", className)}
    >
      <span aria-hidden className="text-fg-subtle">
        pkey_
      </span>
      <span aria-hidden className="font-medium text-accent-fg">
        {slug}
      </span>
      <span aria-hidden className="text-fg-subtle">
        _
      </span>
      <span aria-hidden className="text-fg-strong">
        …{last4 ?? ""}
      </span>
    </span>
  );
}
