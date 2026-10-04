import * as React from "react";
import { cn } from "../lib/cn.js";
import { truncateMiddle } from "../lib/format.js";
import { CopyButton } from "./CopyButton.js";
import { Popover } from "./Popover.js";

/** The value displays' copy control: the shared `CopyButton` at extra-small size. */
export function ValueCopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}): React.ReactElement {
  return (
    <CopyButton value={value} label={label} size="xs" className={className} />
  );
}

export interface IdChipProps {
  value: string;
  /** Characters kept at the start (default 8) and end (default 4). */
  head?: number;
  tail?: number;
  /** What the id is, for the copy and popover labels ("license id"). */
  noun?: string;
  className?: string;
}

/**
 * An id, mono and truncated in the middle, with copy (components.md §6.9). The full value is in a
 * popover behind the truncated text (never only a `title`), and in an sr-only span so a screen
 * reader hears the whole id.
 */
export function IdChip({
  value,
  head = 8,
  tail = 4,
  noun = "id",
  className,
}: IdChipProps): React.ReactElement {
  const short = truncateMiddle(value, head, tail);
  const truncated = short !== value;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 rounded-sm bg-surface-sunken pl-1.5 font-mono text-xs text-fg",
        className,
      )}
    >
      {truncated ? (
        <Popover
          label={`Full ${noun}`}
          trigger={
            <button
              type="button"
              className="rounded-xs text-left hover:text-fg-strong"
              aria-label={`${value}, show full ${noun}`}
            >
              <span aria-hidden>{short}</span>
            </button>
          }
        >
          <p className="mb-1 text-xs text-fg-muted">Full {noun}</p>
          <code className="break-all font-mono text-xs text-fg-strong">
            {value}
          </code>
        </Popover>
      ) : (
        <span>{value}</span>
      )}
      <ValueCopyButton value={value} label={`Copy ${noun}`} />
    </span>
  );
}
