import * as React from "react";
import { cn } from "../lib/cn.js";
import { truncateMiddle } from "../lib/format.js";
import { ValueCopyButton } from "./IdChip.js";
import { Popover } from "./Popover.js";

export interface HashProps {
  value: string;
  /** Characters kept at the start (default 6); the end always keeps 4. */
  chars?: number;
  /** What the hash is ("SHA-256"), for labels. */
  label?: string;
  className?: string;
}

/**
 * A long hash as "3f9a1c…8d02" plus copy (components.md §6.9, ADMIN.md §5.9). The full value is
 * in a popover, never only a `title`.
 */
export function Hash({
  value,
  chars = 6,
  label = "hash",
  className,
}: HashProps): React.ReactElement {
  const short = truncateMiddle(value, chars, 4);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono text-xs text-fg",
        className,
      )}
    >
      <Popover
        label={`Full ${label}`}
        trigger={
          <button
            type="button"
            className="rounded-xs hover:text-fg-strong"
            aria-label={`${label} ${short}, show full value`}
          >
            <span aria-hidden>{short}</span>
          </button>
        }
      >
        <p className="mb-1 text-xs text-fg-muted">Full {label}</p>
        <code className="break-all font-mono text-xs text-fg-strong">
          {value}
        </code>
      </Popover>
      <ValueCopyButton value={value} label={`Copy ${label}`} />
    </span>
  );
}
