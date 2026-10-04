import * as React from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../Button.js";
import { Sparkline } from "./Sparkline.js";

export interface StatTileDelta {
  /** "+12", "−3 %". */
  value: string;
  /** Good, bad or neutral; picks the icon and the status colour of the icon only. */
  tone: "success" | "danger" | "neutral";
  /** What the delta compares against ("vs last week"). */
  label?: string;
}

export interface StatTileProps {
  label: string;
  /** The headline value, already formatted ("1,284"). */
  value?: React.ReactNode;
  secondary?: React.ReactNode;
  delta?: StatTileDelta;
  /** A small trend beside the value (aria-hidden; the value says it). */
  sparkline?: readonly number[];
  /** Makes the label a link (the whole tile is never a button). */
  href?: string;
  loading?: boolean;
  /** A failed query: the tile shows its own error and Retry, never blanking the dashboard. */
  error?: boolean | string;
  onRetry?: () => void;
  className?: string;
}

const DELTA_ICON = {
  success: ArrowUpRight,
  danger: ArrowDownRight,
  neutral: Minus,
} as const;

/**
 * One KPI (components.md §6.13, template T1): label, a tabular 2xl/700 value, an optional delta
 * and sparkline. Each tile is an independent query, so loading and error are per tile.
 */
export function StatTile({
  label,
  value,
  secondary,
  delta,
  sparkline,
  href,
  loading = false,
  error,
  onRetry,
  className,
}: StatTileProps): React.ReactElement {
  const labelId = React.useId();
  const Icon = delta ? DELTA_ICON[delta.tone] : null;
  return (
    <section
      aria-labelledby={labelId}
      aria-busy={loading || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface-raised p-3 sm:p-4",
        className,
      )}
    >
      <p id={labelId} className="text-sm text-fg-muted">
        {href ? (
          <a href={href} className="hover:text-fg-strong hover:underline">
            {label}
          </a>
        ) : (
          label
        )}
      </p>
      {loading ? (
        <div aria-hidden className="mt-1 space-y-2">
          <div className="h-7 w-24 animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none" />
          <div className="h-3 w-32 animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none" />
        </div>
      ) : error ? (
        <div className="mt-1 space-y-2">
          <p className="flex items-center gap-1.5 text-sm text-fg">
            <AlertTriangle aria-hidden className="size-4 text-danger" />
            {typeof error === "string" ? error : "Couldn't load this figure."}
          </p>
          {onRetry ? (
            <Button size="xs" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <p className="text-2xl font-bold tabular-nums text-fg-strong">
              {value}
            </p>
            {sparkline ? (
              <Sparkline values={sparkline} className="mb-1" />
            ) : null}
          </div>
          {delta && Icon ? (
            <p className="flex items-center gap-1 text-xs text-fg-muted">
              <Icon
                aria-hidden
                className={cn(
                  "size-3.5",
                  delta.tone === "success" && "text-success",
                  delta.tone === "danger" && "text-danger",
                )}
              />
              <span className="tabular-nums text-fg">{delta.value}</span>
              {delta.label ? <span>{delta.label}</span> : null}
            </p>
          ) : null}
          {secondary ? (
            <p className="text-xs text-fg-muted">{secondary}</p>
          ) : null}
        </>
      )}
      {loading ? <span className="sr-only">Loading {label}</span> : null}
    </section>
  );
}
