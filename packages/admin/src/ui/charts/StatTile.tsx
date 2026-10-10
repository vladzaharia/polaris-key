import * as React from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { formatCount } from "../../lib/format.js";
import { Button } from "../Button.js";
import { useCountUp, useReducedMotion } from "../motion/index.js";
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
  /**
   * The headline value, already formatted ("1,284"). A whole count (a number, or a string that is
   * exactly `formatCount` of one) counts up from 0 the first time it appears; anything else
   * ("0.4 %", "3 of 5", "in 3 min") shows as it is.
   */
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

/** The whole count a headline value shows, or null when it is not one (MO-09). */
export function headlineCount(value: React.ReactNode): number | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/\d/.test(value)) return null;
  const n = Number(value.replace(/\D/g, ""));
  return Number.isSafeInteger(n) && formatCount(n) === value ? n : null;
}

/**
 * The number to draw while a headline count counts up from 0, once, the first time the tile has a
 * value (notes/S-23 §6.1 "count"; MO-09). A refetch that changes the value swaps it at once:
 * only the first load counts. Null when nothing is counting (the value draws as it is).
 */
function useFirstCount(target: number | null): number | null {
  const reduced = useReducedMotion();
  const [first, setFirst] = React.useState(target);
  const [moved, setMoved] = React.useState(false);
  if (first === null && target !== null) setFirst(target);
  if (!moved && first !== null && target !== null && target !== first)
    setMoved(true);
  const shown = useCountUp(target ?? first ?? 0, {
    from: reduced ? undefined : 0,
    duration: moved || reduced ? 0 : undefined,
  });
  return !reduced && !moved && target !== null && shown !== target
    ? shown
    : null;
}

/**
 * One KPI (components.md §6.13, template T1): label, a tabular 2xl/700 value, an optional delta
 * and sparkline. Each tile is an independent query, so loading and error are per tile.
 *
 * Motion (notes/S-23 §6.1; MO-09): loading is a shaped `pk-skeleton` (its sheen and 150 ms grace);
 * the content that replaces it fades in; a whole-count value counts up on first load, its digits
 * `aria-hidden` while a visually hidden twin holds the final value, so it is announced once.
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
  const count = headlineCount(value);
  const counting = useFirstCount(loading || error ? null : count);
  // Content that replaces this tile's own skeleton fades in once.
  const [sawLoading, setSawLoading] = React.useState(loading);
  if (loading && !sawLoading) setSawLoading(true);
  const fade = sawLoading && "pk-content-in";
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
        <div aria-hidden className="pk-skeleton-group mt-1 space-y-2">
          <div className="pk-skeleton h-7 w-24 rounded-md" />
          <div className="pk-skeleton h-3 w-32 rounded-md" />
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
          <div className={cn("flex items-end justify-between gap-3", fade)}>
            <p className="text-2xl font-semibold tabular-nums text-fg-strong">
              {counting === null ? (
                // A number reads as formatCount draws it, counting or not.
                typeof value === "number" ? (
                  formatCount(value)
                ) : (
                  value
                )
              ) : (
                <>
                  <span aria-hidden="true">{formatCount(counting)}</span>
                  <span className="sr-only">
                    {typeof value === "number" ? formatCount(value) : value}
                  </span>
                </>
              )}
            </p>
            {sparkline ? (
              <Sparkline values={sparkline} className="mb-1" />
            ) : null}
          </div>
          {delta && Icon ? (
            <p
              className={cn(
                "flex items-center gap-1 text-xs text-fg-muted",
                fade,
              )}
            >
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
            <p className={cn("text-xs text-fg-muted", fade)}>{secondary}</p>
          ) : null}
        </>
      )}
      {loading ? <span className="sr-only">Loading {label}</span> : null}
    </section>
  );
}
