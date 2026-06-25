import * as React from "react";
import { cn } from "../../lib/cn.js";

/** An accessible inline loading spinner (a spinning ring, no text). */
export function Spinner({
  className,
  label = "Loading",
}: {
  className?: string;
  label?: string;
}): React.ReactElement {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block size-4 animate-pk-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em]",
        className,
      )}
    >
      <span className="pk-sr-only">{label}</span>
    </span>
  );
}
