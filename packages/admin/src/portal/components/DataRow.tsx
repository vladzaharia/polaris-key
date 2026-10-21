import * as React from "react";
import { cn } from "../../lib/cn.js";

/**
 * One row of a Your data card: an icon tile, a title and one line, and the action at the right
 * (under the text on a phone). `below` spans the row: an inline refusal or the step-up prompt.
 */
export function DataRow({
  icon,
  title,
  description,
  danger = false,
  flush = false,
  children,
  below,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  danger?: boolean;
  /** The action starts at the row's left edge on a phone (a long value needs the width). */
  flush?: boolean;
  children?: React.ReactNode;
  below?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken [&_svg]:size-5",
              danger ? "text-danger" : "text-fg-muted",
            )}
          >
            {icon}
          </span>
          <div className="min-w-0 space-y-0.5">
            <p className="break-words font-medium text-fg-strong">{title}</p>
            <p className="break-words text-sm text-fg-muted">{description}</p>
          </div>
        </div>
        {children ? (
          <div className={cn(flush ? "" : "ml-13", "sm:ml-0 sm:shrink-0")}>
            {children}
          </div>
        ) : null}
      </div>
      {below ? <div className="sm:ml-14">{below}</div> : null}
    </div>
  );
}
