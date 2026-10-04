import * as React from "react";
import { cn } from "../../lib/cn.js";

/**
 * An inline 80×24 trend (components.md §6.13). Decorative: `aria-hidden`, with the value it
 * summarises in visible text beside it. One 2 px line in the section accent, no axes.
 */
export function Sparkline({
  values,
  width = 80,
  height = 24,
  className,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
}): React.ReactElement | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const points = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (width - 2 * pad);
      const y = pad + (1 - (v - min) / span) * (height - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points.split(" ").pop()!.split(",");
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible", className)}
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-accent"
      />
      <circle cx={last[0]} cy={last[1]} r={2.5} className="fill-accent" />
    </svg>
  );
}
