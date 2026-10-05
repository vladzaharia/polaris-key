import * as React from "react";
import { cn } from "../../lib/cn.js";

/** Initials from a display name, else from the email's local part. */
export function initialsOf(name: string, email: string): string {
  const source = name.trim() && name.trim() !== email ? name.trim() : "";
  if (source) {
    const words = source.split(/\s+/).filter(Boolean);
    const first = words[0]?.[0] ?? "";
    const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase();
  }
  return (email.trim()[0] ?? "?").toUpperCase();
}

/**
 * The one avatar (PORTAL.md §5.2). Until profiles land (G32, PX-22) it is always the initials
 * fallback: no picture is ever loaded from another origin.
 */
export function Avatar({
  name,
  email,
  size = 32,
  className,
}: {
  name: string;
  email: string;
  size?: 32 | 40 | 56;
  className?: string;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-accent-subtle font-bold text-accent-fg",
        size === 32 && "size-8 text-xs",
        size === 40 && "size-10 text-sm",
        size === 56 && "size-14 text-lg",
        className,
      )}
    >
      {initialsOf(name, email)}
    </span>
  );
}
