import * as React from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../Button.js";
import { Popover } from "../Popover.js";
import { Presence, reducedMotion } from "../motion/index.js";
import type { FacetOption } from "./types.js";

/** How long the search field waits after the last keystroke (components.md §6.1). */
export const SEARCH_DEBOUNCE_MS = 150;

export interface FilterBarFacet {
  id: string;
  label: string;
  options: (FacetOption & { count?: number })[];
  selected: string[];
  /**
   * The values drawn as chips (default `selected`). DataTable passes the selection it is still
   * showing while a list transition holds the old view, so the chip row changes inside the
   * transition; the menu and each chip's remove button still act on `selected`.
   */
  chips?: string[];
  onChange: (next: string[]) => void;
  /**
   * Draw the options as counted toggle chips in the band (Licenses' holder states) instead of a
   * menu: each is a pressed/unpressed button with its `count`, and a selected one needs no chip
   * in the filter row. `pending` shows a skeleton where a count is not yet known.
   */
  counted?: { icons?: Record<string, React.ReactNode>; pending?: boolean };
  /**
   * Fold this facet's menu into the one "More filters" menu at the end of the facet row, so a
   * band with many facets stays on one row. Its chip row and counts are unchanged.
   */
  secondary?: boolean;
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
  /** Below `sm` the search field takes a row of its own, full width (Home). */
  stackSearch?: boolean;
  /**
   * The page's own filters, drawn first on the bar's row, so a page that filters above its table
   * keeps one band (Home's Table view) instead of stacking a second toolbar.
   */
  lead?: React.ReactNode;
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

function toggleIn(facet: FilterBarFacet, value: string, on: boolean): void {
  facet.onChange(
    on ? [...facet.selected, value] : facet.selected.filter((v) => v !== value),
  );
}

/** One facet's checkboxes, as a fieldset. */
function FacetOptions({
  facet,
  legend = true,
}: {
  facet: FilterBarFacet;
  legend?: boolean;
}): React.ReactElement {
  return (
    <fieldset>
      <legend
        className={cn(
          "px-2 pb-1 text-xs font-semibold text-fg-muted",
          !legend && "sr-only",
        )}
      >
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
                  onChange={(e) => toggleIn(facet, o.value, e.target.checked)}
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
  );
}

function FacetMenu({ facet }: { facet: FilterBarFacet }): React.ReactElement {
  const count = facet.selected.length;
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
            <span className="rounded-full bg-accent-subtle px-1.5 text-xs font-medium text-fg-strong tabular-nums">
              {count}
            </span>
          ) : null}
        </Button>
      }
      className="w-64 p-2"
    >
      <FacetOptions facet={facet} />
    </Popover>
  );
}

/** The secondary facets in one menu: each facet's options under its own heading. */
function MoreFilters({
  facets,
}: {
  facets: FilterBarFacet[];
}): React.ReactElement {
  const count = facets.reduce((n, f) => n + f.selected.length, 0);
  return (
    <Popover
      label="More filters"
      trigger={
        <Button
          variant="outline"
          size="sm"
          iconEnd={<ChevronDown aria-hidden />}
          aria-label={
            count ? `More filters: ${count} selected` : "More filters"
          }
        >
          More
          {count ? (
            <span className="rounded-full bg-accent-subtle px-1.5 text-xs font-medium text-fg-strong tabular-nums">
              {count}
            </span>
          ) : null}
        </Button>
      }
      align="end"
      className="max-h-96 w-64 space-y-2 overflow-y-auto p-2"
    >
      {facets.map((f) => (
        <FacetOptions key={f.id} facet={f} />
      ))}
    </Popover>
  );
}

/** The counted chips of one facet: toggle buttons, a count on each. */
function CountedChips({
  facet,
}: {
  facet: FilterBarFacet;
}): React.ReactElement {
  const toggle = (value: string, on: boolean): void =>
    facet.onChange(
      on
        ? [...facet.selected, value]
        : facet.selected.filter((v) => v !== value),
    );
  return (
    <>
      {facet.options.map((o) => {
        const on = facet.selected.includes(o.value);
        const count = o.count === undefined ? null : o.count.toLocaleString();
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            aria-label={
              count === null
                ? `${facet.label}: ${o.label}`
                : `${facet.label}: ${o.label}, ${count}`
            }
            onClick={() => toggle(o.value, !on)}
            className={cn(
              "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border px-3 py-0.5 text-start text-sm text-fg",
              "hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
              "[&_svg]:size-3.5 [&_svg]:shrink-0",
              on
                ? "border-accent-fg bg-accent-subtle text-fg-strong"
                : "border-border-strong bg-transparent",
            )}
          >
            {facet.counted?.icons?.[o.value]}
            {o.label}
            {count !== null ? (
              <span className="rounded-full bg-surface-sunken px-1.5 text-xs text-fg-muted tabular-nums">
                {count}
              </span>
            ) : facet.counted?.pending ? (
              <span
                aria-hidden
                className="pk-skeleton inline-block h-3 w-6 rounded-full bg-hover"
              />
            ) : null}
          </button>
        );
      })}
    </>
  );
}

interface Chip {
  key: string;
  facet: FilterBarFacet;
  value: string;
  label: string;
}

/** A chip on screen: a current one (`added` after the bar mounted), or one still leaving. */
interface ShownChip extends Chip {
  added: boolean;
  leaving: boolean;
}

/**
 * The chips to draw (notes/S-23 §6.1; MO-09): a chip added after the bar mounted pops in; a
 * removed one stays where it was, inert, while it fades out, then goes. Chips present on the
 * first render (a URL with filters, Back) do not pop. When the last chip goes, the row goes with
 * it at once: a row that collapsed only after the fade would move the table after a list
 * transition had already captured it. Under reduced motion a removed chip goes at once. Counts
 * are never animated.
 */
function useChipPresence(chips: Chip[]): [ShownChip[], (key: string) => void] {
  const keys = chips.map((c) => c.key).join("\n");
  const [prev, setPrev] = React.useState({ keys, chips });
  const [initial, setInitial] = React.useState(
    () => new Set(chips.map((c) => c.key)),
  );
  const [leaving, setLeaving] = React.useState<
    Array<{ chip: Chip; index: number }>
  >([]);
  if (prev.keys !== keys) {
    const now = new Set(chips.map((c) => c.key));
    const gone =
      reducedMotion() || now.size === 0
        ? []
        : prev.chips.flatMap((chip, index) =>
            now.has(chip.key) ? [] : [{ chip, index }],
          );
    setPrev({ keys, chips });
    setLeaving((l) =>
      now.size === 0
        ? []
        : [
            ...l.filter((x) => !now.has(x.chip.key)),
            ...gone.filter((g) => !l.some((x) => x.chip.key === g.chip.key)),
          ],
    );
    // A chip removed since the first render pops when it comes back.
    if ([...initial].some((k) => !now.has(k)))
      setInitial(new Set([...initial].filter((k) => now.has(k))));
  }
  const shown: ShownChip[] = chips.map((c) => ({
    ...c,
    added: !initial.has(c.key),
    leaving: false,
  }));
  for (const { chip, index } of [...leaving].sort((a, b) => a.index - b.index))
    if (!shown.some((c) => c.key === chip.key))
      shown.splice(Math.min(index, shown.length), 0, {
        ...chip,
        added: false,
        leaving: true,
      });
  const drop = React.useCallback(
    (key: string) => setLeaving((l) => l.filter((x) => x.chip.key !== key)),
    [],
  );
  return [shown, drop];
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
  stackSearch,
  lead,
}: FilterBarProps): React.ReactElement {
  const [q, setQ] = useDebouncedField(
    search?.value ?? "",
    search?.onChange ?? (() => undefined),
  );
  const chips: Chip[] = facets.flatMap((f) =>
    f.counted
      ? []
      : (f.chips ?? f.selected).map((v) => ({
          key: `${f.id}:${v}`,
          facet: f,
          value: v,
          label: f.options.find((o) => o.value === v)?.label ?? v,
        })),
  );
  const [shownChips, dropChip] = useChipPresence(chips);
  const filtered = chips.length > 0 || (search?.value ?? "") !== "";

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {lead}
        {search ? (
          <label
            className={cn(
              "relative flex min-w-[min(12rem,100%)] flex-1 basis-[min(12rem,100%)] items-center sm:max-w-sm",
              stackSearch && "max-sm:basis-full",
            )}
          >
            <span className="sr-only">
              {search.label ?? search.placeholder}
            </span>
            <Search
              aria-hidden
              className="pointer-events-none absolute start-2.5 size-4 text-fg-subtle"
            />
            <input
              type="search"
              value={q}
              placeholder={search.placeholder}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 w-full rounded-md border border-border-strong bg-surface-sunken ps-8 pe-2 text-sm text-fg"
            />
          </label>
        ) : null}
        {facets
          .filter((f) => f.counted)
          .map((f) => (
            <CountedChips key={f.id} facet={f} />
          ))}
        {facets
          .filter((f) => !f.counted && !f.secondary)
          .map((f) => (
            <FacetMenu key={f.id} facet={f} />
          ))}
        {facets.some((f) => !f.counted && f.secondary) ? (
          <MoreFilters
            facets={facets.filter((f) => !f.counted && f.secondary)}
          />
        ) : null}
        {dateRange}
        {actions ? (
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {shownChips.length > 0 ? (
        <ul
          aria-label="Active filters"
          className="flex flex-wrap items-center gap-1.5"
        >
          {shownChips.map((c) => (
            <Presence
              key={c.key}
              open={!c.leaving}
              onExited={() => dropChip(c.key)}
            >
              <li
                inert={c.leaving || undefined}
                aria-hidden={c.leaving || undefined}
                className={cn(
                  c.added && "pk-pop-in",
                  "data-[state=closed]:animate-pk-fade-out motion-reduce:animate-none",
                )}
              >
                <span className="inline-flex h-7 items-center gap-1 rounded-full border border-accent-fg bg-accent-subtle ps-2.5 pe-1 text-xs text-fg-strong">
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
            </Presence>
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
