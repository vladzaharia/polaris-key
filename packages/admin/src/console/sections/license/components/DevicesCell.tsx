import * as React from "react";
import { cn } from "../../../../lib/cn.js";
import { FillRect } from "../../../../ui/charts/FillRect.js";
import { CellStack, SubLine } from "./LicenseListParts.js";

/** Devices: "n of limit" over a 4 px bar; a full license turns both warning, nothing more. */
export function DevicesCell({
  count,
  limit,
  from,
}: {
  count: number;
  limit: number | null;
  /** Where the limit comes from, for the tooltip. */
  from: string;
}): React.ReactElement {
  if (limit === null)
    return (
      <CellStack>
        <span className="tabular-nums" title={from}>
          {count}
        </span>
        <SubLine>No limit</SubLine>
      </CellStack>
    );
  const full = count >= limit;
  const ratio = Math.min(1, Math.max(0, count / limit));
  return (
    <span
      role="meter"
      aria-label="Devices"
      aria-valuenow={count}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuetext={`${count} of ${limit} devices`}
      title={from}
      className="flex w-24 flex-col gap-1.5"
    >
      <span className={cn("tabular-nums", full && "text-warning")}>
        {count} of {limit}
      </span>
      {/* The 4 px bar draws its share by transform like every meter (FillRect, S-23 §6.1). */}
      <svg
        aria-hidden
        width="100%"
        height="4"
        className="block forced-color-adjust-none"
      >
        <rect
          width="100%"
          height="4"
          rx="2"
          className="fill-border forced-colors:fill-[Canvas] forced-colors:stroke-[CanvasText]"
        />
        <FillRect
          ratio={ratio}
          height={4}
          rx={2}
          className={cn(
            full ? "fill-warning" : "fill-accent",
            "forced-colors:fill-[Highlight]",
          )}
        />
      </svg>
    </span>
  );
}
