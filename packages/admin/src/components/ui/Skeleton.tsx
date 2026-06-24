import * as React from "react";
import { cn } from "../../lib/cn.js";

/** A shimmering placeholder block for loading states. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
