import * as React from "react";
import { cn } from "../../lib/cn.js";

/** Up to this many seats draw one segment each; more draw one continuous bar. */
const MAX_SEGMENTS = 10;

/**
 * A licence's seats as a meter (PORTAL.md §4.20, §4.25, §9.3): one segment per seat, used ones
 * filled in violet, all of them red once the limit is reached. `role="img"` with the reading as
 * its name ("2 of 3 devices in use"), so the bar is never the only carrier; callers show the
 * same words as visible text. CSP-safe: widths are whole segments or a fixed set of classes,
 * never an inline style.
 */
export function SeatMeter({
  inUse,
  limit,
  className,
}: {
  inUse: number;
  limit: number;
  className?: string;
}): React.ReactElement | null {
  if (!(limit > 0)) return null;
  const full = inUse >= limit;
  const label = `${Math.min(inUse, limit)} of ${limit} ${limit === 1 ? "device" : "devices"} in use`;
  const fill = full ? "bg-danger" : "bg-accent";
  if (limit <= MAX_SEGMENTS) {
    return (
      <div
        role="img"
        aria-label={label}
        className={cn("flex gap-1", className)}
      >
        {Array.from({ length: limit }, (_, i) => (
          <span
            key={i}
            data-used={i < inUse ? "" : undefined}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i < inUse
                ? fill
                : "bg-surface-sunken ring-1 ring-inset ring-border",
            )}
          />
        ))}
      </div>
    );
  }
  // A continuous bar in tenths: a fixed class per step keeps the stylesheet static.
  const tenths = Math.min(10, Math.round((inUse / limit) * 10));
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        "h-1.5 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border",
        className,
      )}
    >
      <span className={cn("block h-full rounded-full", fill, WIDTH[tenths])} />
    </div>
  );
}

const WIDTH = [
  "w-0",
  "w-[10%]",
  "w-[20%]",
  "w-[30%]",
  "w-[40%]",
  "w-[50%]",
  "w-[60%]",
  "w-[70%]",
  "w-[80%]",
  "w-[90%]",
  "w-full",
] as const;
