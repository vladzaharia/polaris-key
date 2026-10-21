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
        // A 2 px ring with a quarter gap, drawn as a masked conic fill (a border here would be a
        // heavy border on a control, which the border rule of the modernity lint bans).
        // Forced colours drop a non-url background image, so the ring is the system text colour as a
        // full ring there (the quarter gap is a conic stop that does not survive).
        "forced-colors:[background-color:currentColor]",
        "inline-block size-4 shrink-0 animate-pk-spin rounded-full align-[-0.125em] bg-[conic-gradient(currentColor_0_75%,transparent_0)] [mask:radial-gradient(farthest-side,transparent_calc(100%-2px),#000_calc(100%-1.5px))]",
        className,
      )}
    />
  );
}
