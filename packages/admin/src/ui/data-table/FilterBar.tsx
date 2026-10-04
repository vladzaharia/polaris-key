import * as React from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../Button.js";
import { Popover } from "../Popover.js";
import type { FacetOption } from "./types.js";

/** How long the search field waits after the last keystroke (components.md §6.1). */
export const SEARCH_DEBOUNCE_MS = 150;

export interface FilterBarFacet {
  id: string;
  label: string;
  options: (FacetOption & { count?: number })[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export interface FilterBarProps {
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    /** The field's accessible name. Default: the placeholder. */
    label?: string;
  };
  facets?: FilterBarFacet[];
  /** Clears search and every facet. Shown when anything is filtered. */
  onClearAll?: () => void;
  dateRange?: React.ReactNode;
  /** Trailing controls: Columns, density, Export CSV. */
  actions?: React.ReactNode;
  className?: string;
}

/** A debounced text value that follows outside changes (Back restoring `?q=`). */
function useDebouncedField(
  value: string,
  onChange: (v: string) => void,
): [string, (v: string) => void] {
  const [local, setLocal] = React.useState(value);
  const pending = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = React.useRef(onChange);
  latest.current = onChange;
  React.useEffect(() => {
    if (pending.current === null) setLocal(value);
  }, [value]);
  React.useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  const set = (v: string): void => {
    setLocal(v);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      latest.current(v);
    }, SEARCH_DEBOUNCE_MS);
  };
  return [local, set];
}

function FacetMenu({ facet }: { facet: FilterBarFacet }): React.ReactElement {
  const count = facet.selected.length;
  const toggle = (value: string, on: boolean): void =>
    facet.onChange(
      on
        ? [...facet.selected, value]
        : facet.selected.filter((v) => v !== value),
    );
  return (
    <Popover
      label={`Filter by ${facet.label.toLowerCase()}`}
      trigger={
        <Button
          variant="outline"
          size="sm"
          iconEnd={<ChevronDown aria-hidden />}
          aria-label={
            count
              ? `${facet.label}: ${count} selected`
              : `Filter by ${facet.label.toLowerCase()}`
          }
        >
          {facet.label}
          {count ? (
            <span className="rounded-full bg-accent-subtle px-1.5 text-xs font-bold text-fg-strong tabular-nums">
              {count}
            </span>
          ) : null}
        </Button>
      }
      className="w-64 p-2"
    >
      <fieldset>
        <legend className="px-2 pb-1 text-xs font-bold text-fg-muted">
          {facet.label}
        </legend>
        <ul className="max-h-72 overflow-y-auto pk-scroll">
          {facet.options.map((o) => {
            const checked = facet.selected.includes(o.value);
            return (
              <li key={o.value}>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-fg hover:bg-hover">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={checked}
                    onChange={(e) => toggle(o.value, e.target.checked)}
                  />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.count !== undefined ? (
                    <span className="text-xs text-fg-subtle tabular-nums">
                      {o.count}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </Popover>
  );
}

/**
 * Search, facet menus and removable filter chips over a collection (components.md §6.2). It
 * holds no filter state of its own: the values live in the URL (`useTableUrlState`), so Back
 * restores them. `DataTable` composes it; a page may also use it on its own (a Timeline).
 */
export function FilterBar({
  search,
  facets = [],
  onClearAll,
  dateRange,
  actions,
  className,
}: FilterBarProps): React.ReactElement {
  const [q, setQ] = useDebouncedField(
    search?.value ?? "",
    search?.onChange ?? (() => undefined),
  );
  const chips = facets.flatMap((f) =>
    f.selected.map((v) => ({
      facet: f,
      value: v,
      label: f.options.find((o) => o.value === v)?.label ?? v,
    })),
  );
  const filtered = chips.length > 0 || (search?.value ?? "") !== "";

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {search ? (
          <label className="relative flex min-w-48 flex-1 items-center sm:max-w-sm">
            <span className="sr-only">
              {search.label ?? search.placeholder}
            </span>
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 size-4 text-fg-subtle"
            />
            <input
              type="search"
              value={q}
              placeholder={search.placeholder}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 w-full rounded-md border border-border-strong bg-surface-sunken pl-8 pr-2 text-sm text-fg"
            />
          </label>
        ) : null}
        {facets.map((f) => (
          <FacetMenu key={f.id} facet={f} />
        ))}
        {dateRange}
        {actions ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {chips.length > 0 ? (
        <ul
          aria-label="Active filters"
          className="flex flex-wrap items-center gap-1.5"
        >
          {chips.map((c) => (
            <li key={`${c.facet.id}:${c.value}`}>
              <span className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface-raised pl-2.5 pr-1 text-xs text-fg">
                {c.facet.label}: {c.label}
                <button
                  type="button"
                  aria-label={`Remove filter ${c.facet.label}: ${c.label}`}
                  onClick={() =>
                    c.facet.onChange(
                      c.facet.selected.filter((v) => v !== c.value),
                    )
                  }
                  className="inline-flex size-5 items-center justify-center rounded-full text-fg-muted hover:bg-hover hover:text-fg-strong"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
          {onClearAll && filtered ? (
            <li>
              <Button variant="link" size="xs" onClick={onClearAll}>
                Clear filters
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
