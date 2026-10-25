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
  children,
  below,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  danger?: boolean;
  children?: React.ReactNode;
  below?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3 bigtext:max-sm:flex-col">
          <span
            aria-hidden
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken [&_svg]:size-5",
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
          <div className={cn("ms-12 bigtext:max-sm:ms-0 sm:ms-0 sm:shrink-0")}>
            {children}
          </div>
        ) : null}
      </div>
      {/* In the text column (icon 2.5 rem + gap 0.75 rem), on a phone as on a desk (B-088). */}
      {below ? <div className="ms-12 bigtext:max-sm:ms-0">{below}</div> : null}
    </div>
  );
}
