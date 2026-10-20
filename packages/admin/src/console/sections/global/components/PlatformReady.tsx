import * as React from "react";
import { Check, ChevronRight } from "lucide-react";
import type { PlatformReadyDto, PlatformReadyRow } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { Button } from "../../../../ui/Button.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

/** Where each row's fix lives (the worker names a Platform page; the console owns the address). */
const TARGETS: Record<string, (store?: string) => string> = {
  settings: r.platformSettings,
  status: r.platformOperations,
  // Store accounts are the Store connections page's (not the sign-in providers'); one missing
  // store opens it on that store.
  connections: (store) =>
    store
      ? `${r.platformStores()}?store=${encodeURIComponent(store)}`
      : r.platformStores(),
  packages: r.platformFeeds,
};

/**
 * Platform ready (UX-67): the first-run checklist, shown to platform admins on Home only while a
 * row is open. The head is the title and the meter, nothing else. Open rows come first, each with
 * its one fix; the done rows fold into one disclosure at every size, so the card reads as the
 * work left.
 */
export function PlatformReady({
  ready,
  className,
}: {
  ready: PlatformReadyDto;
  className?: string;
}): React.ReactElement | null {
  const [showDone, setShowDone] = React.useState(false);
  const titleId = React.useId();
  const listId = React.useId();
  if (ready.done >= ready.total) return null;
  const open = ready.rows.filter((row) => !row.done);
  const done = ready.rows.filter((row) => row.done);
  return (
    <section
      aria-labelledby={titleId}
      data-platform-ready=""
      className={cn(
        "rounded-xl border border-border bg-surface-raised light:shadow-elevation-1",
        className,
      )}
    >
      <div
        data-card-header=""
        className="space-y-2 border-b border-border px-5 py-3"
      >
        <h2
          id={titleId}
          tabIndex={-1}
          className="text-lg font-semibold leading-6 text-fg-strong outline-hidden"
        >
          Platform ready
        </h2>
        {/* The meter runs the card's full width under the title. */}
        <div className="space-y-1">
          <span className="block text-sm tabular-nums text-fg-muted">
            {ready.done} of {ready.total} done
          </span>
          <progress
            value={ready.done}
            max={ready.total}
            aria-label="Platform ready progress"
            className="block h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-success [&::-webkit-progress-bar]:bg-surface-sunken [&::-webkit-progress-value]:bg-success"
          />
        </div>
      </div>
      <ul className="divide-y divide-border">
        {open.map((row) => (
          <Task key={row.id} row={row} />
        ))}
      </ul>
      {done.length > 0 ? (
        <div className="border-t border-border px-5 py-2">
          <button
            type="button"
            aria-expanded={showDone}
            aria-controls={listId}
            onClick={() => setShowDone((v) => !v)}
            className="grid min-h-6 w-full grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-3 rounded-sm text-left text-sm text-fg-muted hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "mx-auto size-4 transition-transform",
                showDone && "rotate-90",
              )}
            />
            <span>{showDone ? "Hide done steps" : "Show done steps"}</span>
          </button>
          <ul
            id={listId}
            hidden={!showDone}
            className="mt-2 space-y-1.5 text-sm text-fg-muted"
          >
            {done.map((row) => (
              <li
                key={row.id}
                className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-3"
              >
                <Check
                  aria-hidden
                  className="mx-auto mt-0.5 size-4 text-success"
                />
                <span>{row.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Task({ row }: { row: PlatformReadyRow }): React.ReactElement {
  const to = row.action
    ? TARGETS[row.action.to]?.(row.action.store)
    : undefined;
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 px-5 py-3">
      <span aria-hidden className="mt-0.5 grid size-7 place-items-center">
        <span className="size-5 rounded-full border-2 border-border-strong" />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-fg-strong">
          {row.title}
          <span className="sr-only"> (to do)</span>
        </p>
        {row.detail ? (
          <p className="text-sm text-fg-muted">{row.detail}</p>
        ) : null}
        {row.action && to ? (
          <Button
            variant="outline"
            size="sm"
            asChild
            className="mt-1 h-auto min-h-8 max-w-full whitespace-normal text-left"
          >
            <Link to={to}>{row.action.label}</Link>
          </Button>
        ) : null}
      </div>
    </li>
  );
}
