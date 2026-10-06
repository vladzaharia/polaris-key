import * as React from "react";
import { cn } from "../../lib/cn.js";
import { formatBytes, formatCount, formatPercent } from "../../lib/format.js";
import { ChartFrame } from "./ChartTable.js";
import { FillRect } from "./FillRect.js";

export interface BarListItem {
  label: string;
  value: number;
  /** A hash link for the label (e.g. Devices filtered to that platform). */
  href?: string;
}

export interface BarListProps {
  items: readonly BarListItem[];
  /** The figure caption ("Devices by platform"). */
  label: string;
  description?: React.ReactNode;
  format?: "count" | "bytes" | "share";
  /** Rows shown before "Show all" (default 8). */
  limit?: number;
  className?: string;
}

/**
 * Horizontal labelled bars, largest first (components.md §6.13): devices by platform, app version,
 * SDK. Direct labels and values on every row; bars in the section accent, scaled to the largest.
 * A changed value moves its bar by transform (`FillRect`, S-23 §6.1 "meter").
 */
export function BarList({
  items,
  label,
  description,
  format = "count",
  limit = 8,
  className,
}: BarListProps): React.ReactElement {
  const [all, setAll] = React.useState(false);
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((n, i) => n + i.value, 0);
  const max = sorted[0]?.value ?? 0;
  const fmt = (v: number) =>
    format === "bytes"
      ? formatBytes(v)
      : format === "share"
        ? formatPercent(total ? v / total : 0, 1)
        : formatCount(v);
  const shown = all ? sorted : sorted.slice(0, limit);
  return (
    <ChartFrame
      title={label}
      description={description}
      className={className}
      table={{
        columns: ["Item", format === "share" ? "Share" : "Value"],
        rows: sorted.map((i) => [i.label, fmt(i.value)]),
      }}
    >
      {sorted.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing to show yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((i) => (
            <li key={i.label}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                {i.href ? (
                  <a
                    href={i.href}
                    className="truncate text-accent-fg hover:underline"
                  >
                    {i.label}
                  </a>
                ) : (
                  <span className="truncate text-fg">{i.label}</span>
                )}
                <span className="tabular-nums text-fg-strong">
                  {fmt(i.value)}
                </span>
              </div>
              <svg aria-hidden width="100%" height="8" className="block">
                <FillRect
                  ratio={
                    max > 0 && i.value > 0 ? Math.max(i.value / max, 0.005) : 0
                  }
                  height={8}
                  rx={2}
                  className="fill-accent"
                />
              </svg>
            </li>
          ))}
        </ul>
      )}
      {sorted.length > limit ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className={cn("mt-2 text-xs text-accent-fg hover:underline")}
        >
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      ) : null}
    </ChartFrame>
  );
}
