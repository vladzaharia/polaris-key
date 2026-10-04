import * as React from "react";
import { cn } from "../lib/cn.js";
import { endOfLocalDay, formatDateTime, localDayOf } from "../lib/format.js";
import { CONTROL_INPUT } from "./inputBase.js";

export interface DateInputProps {
  /** Epoch milliseconds (the end of the chosen day), or `null` for none. */
  value: number | null | undefined;
  onChange?: (value: number | null) => void;
  /** The verb before the resolved instant: "Expires 30 Sep 2026, 23:59 CEST". */
  resolvedLabel?: string;
  /** Pin the zone (tests, or a product-zone field). Default: the operator's. */
  timeZone?: string;
  locale?: string;
  /** Earliest and latest selectable days, "YYYY-MM-DD". */
  min?: string;
  max?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  onBlur?: () => void;
  ref?: React.Ref<HTMLInputElement>;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
  "aria-label"?: string;
}

/**
 * A calendar date in the **operator's local zone** (components.md §3.3, fixes LIC-5): the chosen
 * day is stored as its last second, local time, as epoch ms, and the resolved instant is always
 * shown with its zone, so "30 Sep" never silently means midnight UTC.
 */
export function DateInput({
  value,
  onChange,
  resolvedLabel = "Ends",
  timeZone,
  locale,
  min,
  max,
  className,
  "aria-describedby": describedBy,
  ...props
}: DateInputProps): React.ReactElement {
  const reactId = React.useId();
  const resolvedId = `date-${reactId.replace(/:/g, "")}-resolved`;
  const day =
    value === null || value === undefined
      ? ""
      : localDayOf(value, { timeZone });
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <input
        type="date"
        value={day}
        min={min}
        max={max}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange?.(null);
          const ms = endOfLocalDay(raw, { timeZone });
          if (ms !== null) onChange?.(ms);
        }}
        className={cn(CONTROL_INPUT, "w-auto min-w-44 tabular-nums")}
        aria-describedby={[describedBy, resolvedId].filter(Boolean).join(" ")}
        {...props}
      />
      <p id={resolvedId} className="text-xs text-fg-muted">
        {value === null || value === undefined
          ? "No date set."
          : `${resolvedLabel} ${formatDateTime(value, { timeZone, locale })}`}
      </p>
    </div>
  );
}
