import * as React from "react";
import { flushSync } from "react-dom";
import { cn } from "../../lib/cn.js";
import { viewTransition } from "../../ui/motion/viewTransition.js";
import { Link } from "../router.js";

export interface PageTab {
  value: string;
  label: string;
  /** Route tabs: the tab's hash. Omit for panel tabs. */
  to?: string;
  count?: number | string;
  /** The tab holds a dirty form: a dot, and its panel stays mounted (`TabPanel`). */
  dirty?: boolean;
}

const tabClass = (active: boolean) =>
  cn(
    "relative inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-1 text-sm",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
    active
      ? "border-transparent font-medium text-fg-strong"
      : "border-transparent text-fg-muted hover:border-border-strong hover:text-fg-strong",
  );

/**
 * The active tab's underline (S-23 §6.1 morph). It lies exactly over the tab's own 2 px bottom
 * border, so the tab looks as it always has; being its own element, it is named `pk-indicator`
 * during a `tab` (or `route`) View Transition and slides to the next tab. A border, not a fill, so
 * forced-colors mode keeps it.
 */
function Indicator(): React.ReactElement {
  return (
    <span
      aria-hidden
      data-tab-indicator=""
      className="pk-vt-indicator pointer-events-none absolute inset-x-0 -bottom-[2px] border-b-2 border-accent"
    />
  );
}

function TabLabel({
  tab,
  active,
}: {
  tab: PageTab;
  active: boolean;
}): React.ReactElement {
  return (
    <>
      {tab.label}
      {tab.count !== undefined ? (
        <span className="rounded-full bg-surface-sunken px-1.5 text-xs font-normal tabular-nums text-fg-muted">
          {tab.count}
        </span>
      ) : null}
      {tab.dirty ? (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
          <span className="sr-only">(unsaved changes)</span>
        </>
      ) : null}
      {active ? <Indicator /> : null}
    </>
  );
}

/**
 * Page tabs (components.md §1.7), underline style.
 *
 * - **Route tabs** (the default: every tab has `to`) are a `nav` of links with `aria-current`, so
 *   the tab is in the URL (`/licenses/:id/keys`, fixes LDT-4).
 * - **Panel tabs** (no `to`) are WAI-ARIA tabs with arrow-key movement; pair each with a
 *   `TabPanel`, which keeps a dirty panel mounted while hidden.
 *
 * Motion (S-23 §6.1, MO-04): a switch is a `tab` View Transition. The underline slides to the new
 * tab (`pk-vt-indicator`) and the panel fades through (`pk-vt-tabpanel`: `TabPanel`, or the
 * record's own panel for route tabs); the header and the chrome stay still. Route tabs get it from
 * the router, panel tabs here. Under reduced motion the switch is an instant swap.
 */
export function PageTabs({
  items,
  value,
  onChange,
  label,
  idPrefix = "tab",
}: {
  items: PageTab[];
  value: string;
  onChange?: (value: string) => void;
  label: string;
  idPrefix?: string;
}): React.ReactElement {
  const routed = items.every((t) => t.to !== undefined);
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  /** The tab a running transition is about to select: `value` until its update lands. */
  const pending = React.useRef<string | null>(null);

  if (routed) {
    return (
      <nav aria-label={label} className="pk-scroll -mb-px overflow-x-auto">
        <ul className="flex gap-6">
          {items.map((t) => (
            <li key={t.value}>
              <Link
                to={t.to!}
                transition="tab"
                aria-current={t.value === value ? "page" : undefined}
                className={tabClass(t.value === value)}
              >
                <TabLabel tab={t} active={t.value === value} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  // The new tab's state lands inside the transition (flushSync), so the browser captures the
  // finished panel. Focus has already moved, on the live page: the tab order is unchanged. Two keys
  // inside one transition (ArrowRight, ArrowLeft) are measured against the tab still pending, and
  // every update selects the latest one, so focus and selection always end on the same tab.
  const select = (next: string): void => {
    if (!onChange) return;
    const current = pending.current ?? value;
    if (next === current) {
      if (pending.current === null) onChange(next);
      return;
    }
    pending.current = next;
    viewTransition(
      () =>
        flushSync(() => {
          const target = pending.current;
          pending.current = null;
          if (target !== null) onChange(target);
        }),
      { type: "tab" },
    );
  };

  const move = (from: number, delta: number) => {
    const next = (from + delta + items.length) % items.length;
    refs.current[next]?.focus();
    select(items[next]!.value);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className="pk-scroll -mb-px flex gap-6 overflow-x-auto"
    >
      {items.map((t, i) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${t.value}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${t.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => select(t.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") move(i, 1);
              else if (e.key === "ArrowLeft") move(i, -1);
              else if (e.key === "Home") move(i, -i);
              else if (e.key === "End") move(i, items.length - 1 - i);
              else return;
              e.preventDefault();
            }}
            className={tabClass(active)}
          >
            <TabLabel tab={t} active={active} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A panel for panel tabs. Inactive panels unmount unless `dirty`, in which case they stay
 * mounted and `hidden`, so a draft survives switching tabs (UI-8 `forceMount`). The visible panel
 * fades through on a switch (`pk-vt-tabpanel`); a hidden one is not rendered, so it takes no part.
 */
export function TabPanel({
  value,
  current,
  dirty,
  idPrefix = "tab",
  children,
  className,
}: {
  value: string;
  current: string;
  dirty?: boolean;
  idPrefix?: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement | null {
  const active = value === current;
  if (!active && !dirty) return null;
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${value}`}
      aria-labelledby={`${idPrefix}-${value}`}
      hidden={!active}
      tabIndex={0}
      className={cn(
        "pk-vt-tabpanel pt-4 focus-visible:outline-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}
