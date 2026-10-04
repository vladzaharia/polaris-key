import * as React from "react";
import { cn } from "../../lib/cn.js";
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
      ? "border-accent font-bold text-fg-strong"
      : "border-transparent text-fg-muted hover:border-border-strong hover:text-fg-strong",
  );

function TabLabel({ tab }: { tab: PageTab }): React.ReactElement {
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

  if (routed) {
    return (
      <nav aria-label={label} className="pk-scroll -mb-px overflow-x-auto">
        <ul className="flex gap-6">
          {items.map((t) => (
            <li key={t.value}>
              <Link
                to={t.to!}
                aria-current={t.value === value ? "page" : undefined}
                className={tabClass(t.value === value)}
              >
                <TabLabel tab={t} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  const move = (from: number, delta: number) => {
    const next = (from + delta + items.length) % items.length;
    refs.current[next]?.focus();
    onChange?.(items[next]!.value);
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
            onClick={() => onChange?.(t.value)}
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
            <TabLabel tab={t} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A panel for panel tabs. Inactive panels unmount unless `dirty`, in which case they stay
 * mounted and `hidden`, so a draft survives switching tabs (UI-8 `forceMount`).
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
      className={cn("pt-4 focus-visible:outline-hidden", className)}
    >
      {children}
    </div>
  );
}
