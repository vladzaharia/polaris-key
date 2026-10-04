import * as React from "react";
import { cn } from "../../lib/cn.js";
import {
  formatBasisPoints,
  formatBytes,
  formatCount,
  formatPercent,
} from "../../lib/format.js";

export type MeterFormat = "count" | "percent" | "bp" | "bytes";
export type MeterTone = "accent" | "success" | "warning" | "danger";

export interface MeterProps {
  value: number;
  max: number;
  /** Names the meter ("Seats", "Rollout"). Shown unless `hideLabel`. */
  label: string;
  hideLabel?: boolean;
  /**
   * How the value reads: `count` "3 of 5" (default), `percent` "60 %" of max, `bp` basis points
   * ("25 %", max 10 000), `bytes` "1.2 GB of 5 GB".
   */
  format?: MeterFormat;
  tone?: MeterTone;
  className?: string;
}

const FILL: Record<MeterTone, string> = {
  accent: "fill-accent",
  success: "fill-success",
  warning: "fill-warning",
  danger: "fill-danger",
};

export function meterText(
  value: number,
  max: number,
  format: MeterFormat,
): string {
  switch (format) {
    case "percent":
      return formatPercent(max > 0 ? value / max : 0, 1);
    case "bp":
      return formatBasisPoints(value);
    case "bytes":
      return `${formatBytes(value)} of ${formatBytes(max)}`;
    default:
      return `${formatCount(value)} of ${formatCount(max)}`;
  }
}

/**
 * A bounded quantity (components.md §6.13): seats "3 of 5", rollout progress, storage. A
 * `role="meter"` with the numbers in `aria-value*` and the reading as visible text, so the bar
 * itself is never the only carrier. Over-full values clamp the bar, not the text.
 */
export function Meter({
  value,
  max,
  label,
  hideLabel = false,
  format = "count",
  tone = "accent",
  className,
}: MeterProps): React.ReactElement {
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const text = meterText(value, max, format);
  const labelId = React.useId();
  return (
    <div
      role="meter"
      aria-labelledby={labelId}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuetext={text}
      className={cn("min-w-24 space-y-1", className)}
    >
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span
          id={labelId}
          className={cn("text-fg-muted", hideLabel && "sr-only")}
        >
          {label}
        </span>
        <span className="tabular-nums text-fg">{text}</span>
      </div>
      <svg aria-hidden width="100%" height="6" className="block">
        <rect width="100%" height="6" rx="3" className="fill-border" />
        {ratio > 0 ? (
          <rect
            width={`${ratio * 100}%`}
            height="6"
            rx="3"
            className={FILL[tone]}
          />
        ) : null}
      </svg>
    </div>
  );
}
