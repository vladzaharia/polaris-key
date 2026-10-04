import * as React from "react";
import { formatDuration, type FormatOptions } from "../lib/format.js";

/** A span of time as a phrase: `until` → "in 2 days", `for` → "for 14 days" (components.md §6.10). */
export function Duration({
  ms,
  mode = "for",
  className,
  locale,
}: { ms: number; mode?: "until" | "for"; className?: string } & Pick<
  FormatOptions,
  "locale"
>): React.ReactElement {
  return (
    <span className={className}>{formatDuration(ms, mode, { locale })}</span>
  );
}
