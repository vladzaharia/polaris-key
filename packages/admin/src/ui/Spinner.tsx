import * as React from "react";
import { cn } from "../lib/cn.js";

/**
 * A neutral loading ring (BRAND.md §7.5: loaders are a ring or a bar, never the mark). With a
 * `label` it is a `status` with that name; with `label=""` it is decorative (the control around it
 * already says it is busy, e.g. a button's `aria-busy`). Under reduced motion (the OS setting or
 * html[data-motion="reduce"]) it is a still ring: motion.css stops `animate-pk-spin`.
 */
export function Spinner({
  className,
  label = "Loading",
}: {
  className?: string;
  label?: string;
}): React.ReactElement {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={cn(
        "inline-block size-4 shrink-0 animate-pk-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em]",
        className,
      )}
    />
  );
}
