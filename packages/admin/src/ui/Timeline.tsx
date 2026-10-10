import * as React from "react";
import { ChevronRight, Server } from "lucide-react";
import { cn } from "../lib/cn.js";
import {
  formatDate,
  formatDateTime,
  formatIso,
  localDayOf,
  type FormatOptions,
} from "../lib/format.js";
import { Button } from "./Button.js";

export interface TimelineProps<T> extends FormatOptions {
  items: T[];
  /** The item's instant, epoch ms. */
  getTime: (item: T) => number;
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** The list's accessible name ("Activity for DJDL"). */
  label: string;
  /** `day` groups items under Today / Yesterday / a date; `none` is a flat list. */
  groupBy?: "day" | "none";
  /** The level of the day headings (default 3). */
  headingLevel?: 2 | 3 | 4;
  loadMore?: { onLoadMore: () => void; hasMore: boolean; loading?: boolean };
  /** "Now", for tests and stable stories. */
  now?: number;
  className?: string;
}

function dayHeading(
  day: string,
  sample: number,
  now: number,
  opts: FormatOptions,
): string {
  if (day === localDayOf(now, opts)) return "Today";
  if (day === localDayOf(now - 24 * 3600 * 1000, opts)) return "Yesterday";
  return formatDate(sample, opts);
}

/**
 * A vertical event list with day separators (components.md §6.12): Activity, the record History
 * tabs (filtered Activity) and rollout history in the matrix drawer. An `ol` with an
 * `aria-label`; each day is a heading over its own list. Items arrive newest first.
 */
export function Timeline<T>({
  items,
  getTime,
  getKey,
  renderItem,
  label,
  groupBy = "day",
  headingLevel = 3,
  loadMore,
  now,
  className,
  locale,
  timeZone,
}: TimelineProps<T>): React.ReactElement {
  const opts = { locale, timeZone };
  const current = now ?? Date.now();
  const Heading = `h${headingLevel}` as "h3";

  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = groupBy === "day" ? localDayOf(getTime(item), opts) : "";
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }

  const list = (group: T[], ariaLabel?: string) => (
    <ol
      aria-label={ariaLabel}
      className="relative space-y-1 border-l border-border pl-4"
    >
      {group.map((item) => (
        <li key={getKey(item)} className="relative">
          <span
            aria-hidden
            className="absolute -left-[1.3125rem] top-3 size-2 rounded-full border border-border-strong bg-surface-page"
          />
          {renderItem(item)}
        </li>
      ))}
    </ol>
  );

  return (
    <div className={cn("space-y-4", className)}>
      {groupBy === "none" ? (
        list(items, label)
      ) : (
        <ol aria-label={label} className="space-y-5">
          {groups.map((g) => (
            <li key={g.day} className="space-y-2">
              <Heading className="text-xs font-semibold text-fg-muted">
                {dayHeading(g.day, getTime(g.items[0]!), current, opts)}
              </Heading>
              {list(g.items)}
            </li>
          ))}
        </ol>
      )}
      {loadMore?.hasMore ? (
        <Button
          variant="outline"
          size="sm"
          loading={loadMore.loading}
          onClick={loadMore.onLoadMore}
        >
          Load older
        </Button>
      ) : null}
    </div>
  );
}

export interface TimelineItemProps extends FormatOptions {
  /** A person, or `"system"` for runtime rows (no actor): shown as Polaris Key. */
  actor: { name: string; initials?: string } | "system";
  /** The verb phrase: "disabled license". */
  verb: React.ReactNode;
  /** The target, usually an `EntityLink`. */
  target?: React.ReactNode;
  /** Epoch ms. */
  at: number;
  /** An expandable detail (the audit summary, the raw action code). */
  summary?: React.ReactNode;
  /** Label of the disclosure (default "Details"). */
  summaryLabel?: string;
  className?: string;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? `${parts[0]![0]}${parts[parts.length - 1]![0]}`
      : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * One timeline row: avatar (initials) or the system glyph, "**Ada** disabled license **Studio
 * Pro**", the time, and an expandable summary. The time is plain text with the full instant for
 * assistive tech; nothing here is focusable but the target link and the disclosure (ACT-4).
 */
export function TimelineItem({
  actor,
  verb,
  target,
  at,
  summary,
  summaryLabel = "Details",
  className,
  locale,
  timeZone,
}: TimelineItemProps): React.ReactElement {
  const opts = { locale, timeZone };
  const name = actor === "system" ? "Polaris Key" : actor.name;
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(at);
  return (
    <div className={cn("flex gap-3 py-1.5 text-sm", className)}>
      <span
        aria-hidden
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs font-medium text-fg-muted"
      >
        {actor === "system" ? (
          <Server className="size-3.5" />
        ) : (
          (actor.initials ?? initialsOf(actor.name))
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-fg">
          <time
            dateTime={formatIso(at)}
            className="mr-2 text-xs text-fg-subtle tabular-nums"
          >
            <span aria-hidden>{time}</span>
            <span className="sr-only">{formatDateTime(at, opts)}</span>
          </time>
          <span className="font-medium text-fg-strong">{name}</span> {verb}
          {target ? <> {target}</> : null}
        </p>
        {summary ? (
          <details className="group mt-0.5">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-fg-muted hover:text-fg-strong [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-3.5 transition-transform duration-(--pk-duration-fast) group-open:rotate-90"
              />
              {summaryLabel}
            </summary>
            <div className="mt-1 text-xs text-fg-muted">{summary}</div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
