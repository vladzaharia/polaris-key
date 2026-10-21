import * as React from "react";
import { Check, ChevronRight, X } from "lucide-react";
import type { PlatformReadyDto, PlatformReadyRow } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { Button } from "../../../../ui/Button.js";
import { IconButton } from "../../../../ui/IconButton.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

/** Where each row's fix lives (the worker names a Platform page; the console owns the address). */
const TARGETS: Record<string, (store?: string) => string> = {
  settings: r.platformSettings,
  status: r.platformOperations,
  // The Store connections page (not the sign-in providers'); one missing store opens it on that
  // store.
  connections: (store) =>
    store
      ? `${r.platformStores()}?store=${encodeURIComponent(store)}`
      : r.platformStores(),
  packages: r.platformFeeds,
};

/** The dismiss control: named, a 24 px target on a console, larger on touch. */
function Dismiss({ onDismiss }: { onDismiss: () => void }): React.ReactElement {
  return (
    <IconButton
      label="Hide Platform ready"
      icon={<X />}
      size="xs"
      data-dismiss-guide=""
      className="shrink-0 text-fg-muted pointer-coarse:-my-2 pointer-coarse:size-11"
      onClick={onDismiss}
    />
  );
}

/**
 * Platform ready (UX-67): the first-run checklist, shown to platform admins on Home. While a row
 * is open it is a card: the head is the title and the meter (and the dismiss control), open rows
 * come first each with its one fix, and the done rows fold into one disclosure at every size.
 * Once every row is done it is one quiet line with "Show steps". The operator can hide it
 * (`onDismiss`); Home keeps that per operator.
 */
export function PlatformReady({
  ready,
  className,
  onDismiss,
}: {
  ready: PlatformReadyDto;
  className?: string;
  onDismiss?: () => void;
}): React.ReactElement | null {
  const [showDone, setShowDone] = React.useState(false);
  const titleId = React.useId();
  const listId = React.useId();
  if (ready.done >= ready.total)
    return (
      <section
        aria-labelledby={titleId}
        data-platform-ready="done"
        className={cn(
          // A chip, not a bar: it is as wide as its three words, and a pill until its steps open.
          "w-fit max-w-full border border-border bg-surface-raised px-4 py-1 light:shadow-elevation-1",
          showDone ? "rounded-xl" : "rounded-full",
          className,
        )}
      >
        <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
          <Check aria-hidden className="size-4 shrink-0 text-success" />
          <h2
            id={titleId}
            tabIndex={-1}
            className="text-sm font-medium text-fg-strong outline-hidden"
          >
            Platform ready
          </h2>
          <button
            type="button"
            aria-expanded={showDone}
            aria-controls={listId}
            onClick={() => setShowDone((v) => !v)}
            className="inline-flex min-h-6 items-center gap-1 rounded-sm text-sm text-fg-muted hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-4 transition-transform",
                showDone && "rotate-90",
              )}
            />
            {showDone ? "Hide steps" : "Show steps"}
          </button>
          {onDismiss ? (
            <span className="ml-2">
              <Dismiss onDismiss={onDismiss} />
            </span>
          ) : null}
        </div>
        <ul
          id={listId}
          hidden={!showDone}
          className="space-y-1.5 pb-2 pt-1 text-sm text-fg-muted"
        >
          {ready.rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3">
              <Check
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-success"
              />
              <span>{row.title}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  const open = ready.rows.filter((row) => !row.done);
  const done = ready.rows.filter((row) => row.done);
  return (
    <section
      aria-labelledby={titleId}
      data-platform-ready=""
      className={cn(
        "@container rounded-xl border border-border bg-surface-raised light:shadow-elevation-1",
        className,
      )}
    >
      <div
        data-card-header=""
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3"
      >
        <h2
          id={titleId}
          tabIndex={-1}
          className="order-1 text-lg font-semibold leading-6 text-fg-strong outline-hidden"
        >
          Platform ready
        </h2>
        {onDismiss ? (
          <span className="order-2 ml-auto @[36rem]:order-3">
            <Dismiss onDismiss={onDismiss} />
          </span>
        ) : null}
        {/* The meter sits on the head line once the card is wide; narrow, it runs under the title. */}
        <div className="order-3 flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 @[36rem]:order-2 @[36rem]:basis-0 @[36rem]:flex-1 @[36rem]:flex-nowrap">
          <span className="shrink-0 text-sm tabular-nums text-fg-muted">
            {ready.done} of {ready.total} done
          </span>
          <progress
            value={ready.done}
            max={ready.total}
            aria-label="Platform ready progress"
            className="block h-1.5 min-w-[min(8rem,100%)] flex-1 appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-success [&::-webkit-progress-bar]:bg-surface-sunken [&::-webkit-progress-value]:bg-success"
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
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-5 py-3 @[36rem]:grid-cols-[1.75rem_minmax(0,1fr)_auto]">
      <span aria-hidden className="grid size-7 place-items-center self-start">
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
      </div>
      {row.action && to ? (
        <Button
          variant="outline"
          size="sm"
          asChild
          className="col-start-2 h-auto min-h-8 max-w-full justify-self-start whitespace-normal text-left @[36rem]:col-start-3 @[36rem]:row-start-1 @[36rem]:justify-self-end"
        >
          <Link to={to}>{row.action.label}</Link>
        </Button>
      ) : null}
    </li>
  );
}
