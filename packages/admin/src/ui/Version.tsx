import * as React from "react";
import { Ban } from "lucide-react";
import { cn } from "../lib/cn.js";
import { StatusPill } from "./StatusPill.js";

export interface VersionProps {
  value: string;
  /** Yanked releases get a line-through AND a "Yanked" pill. */
  yanked?: boolean;
  /** A channel shown after the version ("stable"). */
  channel?: string;
  className?: string;
}

/** A release or pack version, mono (components.md §6.10). */
export function Version({
  value,
  yanked = false,
  channel,
  className,
}: VersionProps): React.ReactElement {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        className={cn(
          "font-mono text-xs text-fg-strong",
          yanked && "text-fg-muted line-through",
        )}
      >
        {value}
      </span>
      {yanked ? (
        <StatusPill tone="neutral" icon={Ban}>
          Yanked
        </StatusPill>
      ) : null}
      {channel ? (
        <span className="text-xs text-fg-muted">{channel}</span>
      ) : null}
    </span>
  );
}
