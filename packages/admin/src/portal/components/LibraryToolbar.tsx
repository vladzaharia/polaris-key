import { t } from "../../lib/copy.js";
import * as React from "react";
import { LayoutGrid, List, Search } from "lucide-react";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { Kbd } from "../../ui/Kbd.js";
import { cn } from "../../lib/cn.js";
import type {
  LibraryFilter,
  LibrarySort,
  LibraryViewMode,
} from "../model/libraryView.js";

/**
 * The library toolbar (§4.15), from 8 products: search (`/` focuses it), filter chips with
 * counts (a zero-count chip is hidden), sort and the Grid/List toggle. Every control writes the
 * URL; the page reads it back.
 *
 * The controls are in the order they are read and tabbed to, with no CSS `order` (WCAG 2.4.3,
 * B-076): search on a row of its own below `wide`, then the chips and sort, then the toggle, which
 * wraps to the row below them when they fill theirs; from `wide` all of them share one row.
 */
export function LibraryToolbar({
  total,
  q,
  filter,
  sort,
  mode,
  attentionCount,
  onChange,
  onMode,
}: {
  total: number;
  q: string;
  filter: LibraryFilter;
  sort: LibrarySort;
  mode: LibraryViewMode;
  attentionCount: number;
  onChange: (patch: {
    q?: string;
    filter?: LibraryFilter;
    sort?: LibrarySort;
  }) => void;
  onMode: (mode: LibraryViewMode) => void;
}): React.ReactElement {
  const searchRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // ⌘K / Ctrl K focuses and selects the search here (App's palette yields while it is on
      // screen); "/" is the alias, and not while typing in a field.
      const k =
        (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k";
      if (k) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const chips: {
    id: LibraryFilter;
    label: string;
    count: number;
    dot?: boolean;
  }[] = [
    { id: "all", label: t("locker.library.all"), count: total },
    {
      id: "attention",
      label: t("locker.library.needsYou"),
      count: attentionCount,
      dot: true,
    },
  ];
  const label = t("locker.library.search");

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="relative flex h-11 min-w-0 basis-full items-center rounded-md border border-border-strong bg-surface-page wide:w-80 wide:flex-none wide:basis-auto">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 size-4 text-fg-muted"
        />
        <input
          ref={searchRef}
          data-library-search=""
          type="search"
          aria-label={label}
          placeholder={label}
          value={q}
          onChange={(e) => onChange({ q: e.target.value })}
          className="h-full w-full min-w-0 bg-transparent pl-10 pr-10 text-md text-fg-strong outline-none placeholder:text-fg-subtle focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <Kbd
          keys={
            typeof navigator !== "undefined" &&
            /Mac|iPhone|iPad/.test(navigator.userAgent)
              ? "⌘K"
              : "Ctrl K"
          }
          className="absolute right-3 hidden desk:flex"
        />
      </label>
      <div className="flex min-w-0 flex-1 basis-72 flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t("locker.library.filter")}
          className="flex flex-wrap gap-2"
        >
          {chips
            .filter((c) => c.count > 0)
            .map((c) => {
              const on = filter === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange({ filter: c.id })}
                  className={cn(
                    "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-md",
                    on
                      ? "border-fg-strong bg-fg-strong font-medium text-surface-page"
                      : "border-border-strong text-fg-strong hover:bg-hover",
                  )}
                >
                  {c.dot ? (
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full bg-warning"
                    />
                  ) : null}
                  {c.label}
                  <span className={cn("text-xs", on ? "" : "text-fg-muted")}>
                    {c.count}
                  </span>
                </button>
              );
            })}
        </div>
        <label className="ml-auto flex items-center">
          <span className="sr-only">{t("locker.library.sort")}</span>
          <select
            value={sort}
            onChange={(e) => onChange({ sort: e.target.value as LibrarySort })}
            className="h-10 rounded-md border border-border-strong bg-surface-page px-3 text-md text-fg-strong"
          >
            <option value="recent">{t("locker.library.sortRecent")}</option>
            <option value="name">{t("locker.library.sortName")}</option>
          </select>
        </label>
      </div>
      <SegmentedControl
        aria-label={t("locker.library.view")}
        className="h-11 shrink-0 pointer-coarse:h-[3.125rem] pointer-coarse:[&>[role=radio]]:h-11"
        value={mode}
        onChange={onMode}
        options={[
          {
            value: "grid",
            label: (
              <span className="flex items-center gap-2">
                <LayoutGrid aria-hidden className="size-4" />
                <span className="sr-only sm:not-sr-only">
                  {t("locker.library.grid")}
                </span>
              </span>
            ),
          },
          {
            value: "list",
            label: (
              <span className="flex items-center gap-2">
                <List aria-hidden className="size-4" />
                <span className="sr-only sm:not-sr-only">
                  {t("locker.library.list")}
                </span>
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
