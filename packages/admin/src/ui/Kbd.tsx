import * as React from "react";
import { cn } from "../lib/cn.js";

/** A keyboard hint, e.g. `⌘K` or `g o`. Decorative: the action's name carries the meaning. */
export function Kbd({
  keys,
  className,
}: {
  keys: string;
  className?: string;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn("ml-auto flex shrink-0 items-center gap-1", className)}
    >
      {keys.split(" ").map((k, i) => (
        <kbd
          key={i}
          className="rounded-xs border border-border bg-surface-sunken px-1.5 font-sans text-[0.6875rem] leading-4 text-fg-muted"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
