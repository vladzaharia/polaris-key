import * as React from "react";
import { formatCount, formatPercent } from "../../lib/format.js";
import { ChartFrame } from "./ChartTable.js";

export interface FunnelStep {
  label: string;
  value: number;
}

export interface FunnelProps {
  /** The ordered steps, widest first (offered → downloaded → applied → confirmed). */
  steps: readonly FunnelStep[];
  /** Losses shown apart as danger bars (reverted, pack failed, boot rollback). */
  failures?: readonly FunnelStep[];
  /** The figure caption ("2.4.0 on stable, last 24 h"). */
  label: string;
  /** The caption is for AT only (the caller shows the same title above the figure). */
  labelHidden?: boolean;
  description?: React.ReactNode;
  className?: string;
}

/** Step conversion as a fraction of the previous step (null for the first or a zero base). */
export function conversions(steps: readonly FunnelStep[]): (number | null)[] {
  return steps.map((s, i) => {
    const prev = steps[i - 1];
    return i === 0 || !prev || prev.value === 0 ? null : s.value / prev.value;
  });
}

function Bar({
  value,
  base,
  danger,
}: {
  value: number;
  base: number;
  danger?: boolean;
}): React.ReactElement {
  const ratio = base > 0 ? Math.min(value / base, 1) : 0;
  return (
    <svg aria-hidden width="100%" height="12" className="block">
      <rect width="100%" height="12" rx="2" className="fill-border" />
      {ratio > 0 ? (
        <rect
          width={`${Math.max(ratio * 100, 0.5)}%`}
          height="12"
          rx="2"
          className={danger ? "fill-danger" : "fill-accent"}
        />
      ) : null}
    </svg>
  );
}

/**
 * The update-health funnel (components.md §6.13, fixes UHL-1): one bar per step scaled to the
 * first step, the step conversion between bars, and the failure counts as separate danger bars.
 * A figure with a caption and the "Show as table" toggle.
 */
export function Funnel({
  steps,
  failures = [],
  label,
  labelHidden = false,
  description,
  className,
}: FunnelProps): React.ReactElement {
  const base = steps[0]?.value ?? 0;
  const conv = conversions(steps);
  const table = {
    columns: ["Step", "Devices", "From previous step"],
    rows: [
      ...steps.map((s, i) => [
        s.label,
        formatCount(s.value),
        conv[i] === null ? "—" : formatPercent(conv[i]!, 1),
      ]),
      ...failures.map((f) => [f.label, formatCount(f.value), "—"]),
    ],
  };
  return (
    <ChartFrame
      title={label}
      titleHidden={labelHidden}
      description={description}
      table={table}
      className={className}
    >
      {base === 0 ? (
        <p className="text-sm text-fg-muted">
          No devices were offered this update in the window.
        </p>
      ) : (
        <ol className="space-y-1">
          {steps.map((s, i) => (
            <li key={s.label}>
              {conv[i] !== null ? (
                <p className="py-0.5 pl-2 text-xs text-fg-subtle">
                  <span aria-hidden>↓ </span>
                  {formatPercent(conv[i]!, 1)} of the previous step
                </p>
              ) : null}
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-fg">{s.label}</span>
                <span className="tabular-nums text-fg-strong">
                  {formatCount(s.value)}
                </span>
              </div>
              <Bar value={s.value} base={base} />
            </li>
          ))}
        </ol>
      )}
      {failures.length ? (
        <div className="mt-3 space-y-1 border-t border-border pt-3">
          <p className="text-xs font-bold text-fg-muted">Failures</p>
          <ul className="space-y-1">
            {failures.map((f) => (
              <li key={f.label}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-fg">{f.label}</span>
                  <span className="tabular-nums text-danger">
                    {formatCount(f.value)}
                  </span>
                </div>
                <Bar value={f.value} base={base} danger />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ChartFrame>
  );
}
