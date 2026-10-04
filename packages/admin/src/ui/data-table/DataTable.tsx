import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Cell,
  type Column,
  type Row,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  observeElementRect,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Columns3,
  Download,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { formatCount } from "../../lib/format.js";
import { ActionMenu } from "../ActionMenu.js";
import { Button } from "../Button.js";
import { EmptyState } from "../EmptyState.js";
import { ErrorState } from "../ErrorState.js";
import { announce, LiveRegion } from "../LiveRegion.js";
import { Popover } from "../Popover.js";
import { Skeleton } from "../Skeleton.js";
import { csvValue, downloadCsv, toCsv } from "./csv.js";
import { FilterBar, type FilterBarFacet } from "./FilterBar.js";
import {
  EMPTY_TABLE_STATE,
  type DataColumn,
  type DataTableProps,
  type Density,
  type Facet,
  type RowActionItem,
  type TableState,
} from "./types.js";

/** Client mode virtualizes above this many rows (components.md §6.1). */
export const VIRTUALIZE_ABOVE = 200;

const ROW_HEIGHT: Record<Density, number> = { comfortable: 44, compact: 36 };
const DENSITY_KEY = "pk-table-density";
const columnsKey = (id: string) => `pk-table-columns:${id}`;

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the preference lasts for the session
  }
}

/** A media query as state; `false` where matchMedia does not exist (jsdom). */
export function useMediaQuery(query: string): boolean {
  const get = (): boolean =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = React.useState(get);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const on = (): void => setMatches(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** A column's id: its `id`, else its `accessorKey`. */
export function columnId<T>(col: DataColumn<T>): string {
  const c = col as { id?: string; accessorKey?: string };
  return c.id ?? String(c.accessorKey ?? "");
}

/** A column's plain-text name: `meta.label`, else a string `header`, else the id. */
export function columnLabel<T>(col: DataColumn<T>): string {
  if (col.meta?.label) return col.meta.label;
  return typeof col.header === "string" ? col.header : columnId(col);
}

/** A column's raw value for a row (its accessor), or `undefined` for a display column. */
export function columnValue<T>(
  col: DataColumn<T>,
  row: T,
  index: number,
): unknown {
  const c = col as {
    accessorKey?: string;
    accessorFn?: (row: T, index: number) => unknown;
  };
  if (c.accessorFn) return c.accessorFn(row, index);
  if (c.accessorKey !== undefined) {
    return String(c.accessorKey)
      .split(".")
      .reduce<unknown>(
        (v, k) =>
          v && typeof v === "object"
            ? (v as Record<string, unknown>)[k]
            : undefined,
        row,
      );
  }
  return undefined;
}

function facetValues<T>(
  facet: Facet<T>,
  columns: DataColumn<T>[],
  row: T,
  index: number,
): string[] {
  const raw = facet.accessor
    ? facet.accessor(row)
    : (() => {
        const col = columns.find((c) => columnId(c) === facet.id);
        return col ? columnValue(col, row, index) : undefined;
      })();
  if (raw === null || raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function matchesSearch<T>(
  row: T,
  index: number,
  q: string,
  cols: DataColumn<T>[],
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return cols.some((c) =>
    csvValue(columnValue(c, row, index))
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * Apply search and facets (client mode). `skipFacet` leaves one facet out, for its own counts.
 * Exported for tests and for pages that need the filtered rows (CSV, a summary strip).
 */
export function filterRows<T>(
  data: T[],
  columns: DataColumn<T>[],
  state: TableState,
  facets: Facet<T>[] = [],
  searchColumns?: string[],
  skipFacet?: string,
): T[] {
  const searchCols = searchColumns
    ? columns.filter((c) => searchColumns.includes(columnId(c)))
    : columns;
  return data.filter((row, i) => {
    if (!matchesSearch(row, i, state.q, searchCols)) return false;
    for (const f of facets) {
      if (f.id === skipFacet) continue;
      const selected = state.filters[f.id] ?? [];
      if (selected.length === 0) continue;
      const values = facetValues(f, columns, row, i);
      if (!values.some((v) => selected.includes(v))) return false;
    }
    return true;
  });
}

/** The CSV of `rows` over the visible `columns` (header row first). */
export function tableCsv<T>(rows: T[], columns: DataColumn<T>[]): string {
  return toCsv(
    columns.map(columnLabel),
    rows.map((row, i) =>
      columns.map((c) =>
        c.meta?.csv ? c.meta.csv(row) : csvValue(columnValue(c, row, i)),
      ),
    ),
  );
}

/** A row's action menu; none at all when the row has no valid action (a deauthorized device). */
function RowMenu({
  label,
  items,
}: {
  label: string;
  items: RowActionItem[];
}): React.ReactElement | null {
  if (!items.some((i) => !("type" in i && i.type === "separator"))) return null;
  return (
    <ActionMenu
      label={`Actions for ${label}`}
      items={items}
      size="sm"
      align="end"
    />
  );
}

const ROW_LINK = "a[data-row-link], [data-row-link-wrap] a";

const INTERACTIVE =
  "a,button,input,select,textarea,label,summary,[role=menuitem],[role=checkbox],[role=button],[contenteditable=true]";

/** A checkbox with a real tri-state (`indeterminate` is a DOM property, not an attribute). */
function TriCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}): React.ReactElement {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      aria-checked={indeterminate ? "mixed" : checked}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 cursor-pointer accent-accent align-middle"
    />
  );
}

function SortIcon({
  dir,
}: {
  dir: false | "asc" | "desc";
}): React.ReactElement {
  if (dir === "asc") return <ArrowUp aria-hidden className="size-3.5" />;
  if (dir === "desc") return <ArrowDown aria-hidden className="size-3.5" />;
  return <ChevronsUpDown aria-hidden className="size-3.5 opacity-50" />;
}

function alignClass(align: "start" | "center" | "end" | undefined): string {
  return align === "end"
    ? "text-right"
    : align === "center"
      ? "text-center"
      : "text-left";
}

// ── The table ──────────────────────────────────────────────────────────────────────────────────

/**
 * The console's collection table (components.md §6.1, ADMIN.md T2), on TanStack Table v8 with
 * TanStack Virtual above 200 rows in client mode.
 *
 * - **State** (`q`, `sort`, facet filters, cursor/offset) is controlled by `useTableUrlState`, so
 *   it lives in the URL and Back restores it; without `state` the table keeps its own.
 * - **The row is not a button** (UI-12): the primary cell is a real link to `rowHref`. A click
 *   elsewhere on the row (not on a control) follows that link as a pointer-only enhancement;
 *   keyboard users use the link, or `j`/`k` to move between rows and `Enter` to open, `x` to
 *   toggle selection.
 * - **Server paging**: in `cursor` mode (and `offset` with a `total`), `data` is what the server
 *   returned for the current state; the table does not search, filter or sort it again.
 * - Column visibility and density are viewer preferences in localStorage, never in the URL.
 */
export function DataTable<T>(props: DataTableProps<T>): React.ReactElement {
  const {
    id,
    data,
    columns,
    getRowId,
    caption,
    facets = [],
    search,
    selection,
    rowHref,
    rowLabel,
    rowActions,
    linkComponent: LinkComponent,
    pagination = { mode: "client" },
    loading = false,
    error,
    onRetry,
    empty,
    mobile = "scroll",
    toolbarActions,
    chrome = "auto",
    className,
  } = props;

  // State: controlled, or the table's own.
  const [ownState, setOwnState] = React.useState<TableState>(EMPTY_TABLE_STATE);
  const state = props.state ?? ownState;
  const setState = (next: TableState): void => {
    if (!props.state) setOwnState(next);
    props.onStateChange?.(next);
  };
  /** A filter, search or sort change starts again from the first page. */
  const update = (patch: Partial<TableState>): void =>
    setState({ ...state, cursor: null, offset: 0, ...patch });

  // Density: controlled, or a persisted viewer preference.
  const [ownDensity, setOwnDensity] = React.useState<Density>(() =>
    readStorage(DENSITY_KEY) === "compact" ? "compact" : "comfortable",
  );
  const density = props.density ?? ownDensity;
  const setDensity = (d: Density): void => {
    setOwnDensity(d);
    writeStorage(DENSITY_KEY, d);
    props.onDensityChange?.(d);
  };

  // Column visibility: persisted per table id; `defaultHidden` columns, and priority 3 below
  // 1280 px, start hidden.
  const hasMatchMedia =
    typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [hidden, setHidden] = React.useState<string[]>(() => {
    const stored = readStorage(columnsKey(id));
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // a corrupt preference falls back to the default
      }
    }
    const narrow =
      hasMatchMedia && !window.matchMedia("(min-width: 1280px)").matches;
    return columns
      .filter(
        (c) => c.meta?.defaultHidden || (narrow && c.meta?.priority === 3),
      )
      .map(columnId);
  });
  const setColumnHidden = (colId: string, hide: boolean): void => {
    const next = hide
      ? [...hidden.filter((h) => h !== colId), colId]
      : hidden.filter((h) => h !== colId);
    setHidden(next);
    writeStorage(columnsKey(id), JSON.stringify(next));
  };

  const isPhone = useMediaQuery("(max-width: 767px)");
  const isMobileCards = isPhone && mobile === "cards";

  const serverSide =
    pagination.mode === "cursor" ||
    (pagination.mode === "offset" && pagination.total !== undefined);

  // Search and facets (client side unless the server pages).
  const filteredData = React.useMemo(
    () =>
      serverSide
        ? data
        : filterRows(data, columns, state, facets, search?.columns),
    [serverSide, data, columns, state, facets, search?.columns],
  );

  const isFiltered =
    state.q.trim() !== "" ||
    Object.values(state.filters).some((v) => v.length > 0);

  // Selection.
  const [rowSelection, setRowSelection] = React.useState<
    Record<string, boolean>
  >({});
  const [allMatching, setAllMatching] = React.useState(false);

  // Stable references: react-table memoizes its row models on these, and a fresh array every
  // render would recompute the sorted model on every render.
  const sorting: SortingState = React.useMemo(
    () => state.sort.map((s) => ({ id: s.id, desc: s.desc })),
    [state.sort],
  );
  const columnVisibility: VisibilityState = React.useMemo(
    () => Object.fromEntries(hidden.map((h) => [h, false])),
    [hidden],
  );

  const table = useReactTable<T>({
    data: filteredData,
    columns,
    getRowId: (row) => getRowId(row),
    state: { sorting, columnVisibility, rowSelection },
    onRowSelectionChange: (u) => {
      setAllMatching(false);
      setRowSelection((prev) => (typeof u === "function" ? u(prev) : u));
    },
    enableRowSelection: Boolean(selection),
    manualSorting: serverSide,
    // The table pages itself (state.offset/cursor), never through react-table's pagination. Its
    // auto-reset queues resetPageIndex() after every row-model recompute: a state change that
    // re-renders, recomputes and queues again, an endless render loop.
    autoResetAll: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Drop selections of rows that are no longer present.
  const presentIds = React.useMemo(
    () => new Set(data.map(getRowId)),
    [data, getRowId],
  );
  React.useEffect(() => {
    setRowSelection((prev) => {
      const kept = Object.fromEntries(
        Object.entries(prev).filter(([k, v]) => v && presentIds.has(k)),
      );
      return Object.keys(kept).length === Object.keys(prev).length
        ? prev
        : kept;
    });
  }, [presentIds]);

  const allRows = table.getRowModel().rows;
  const offset = state.offset ?? 0;
  const pageRows =
    pagination.mode === "offset" && pagination.total === undefined
      ? allRows.slice(offset, offset + pagination.pageSize)
      : allRows;

  const visibleColumns = table.getVisibleLeafColumns();
  const primaryId = (
    visibleColumns.find((c) => c.columnDef.meta?.primary) ?? visibleColumns[0]
  )?.id;
  const selectedRows = table.getSelectedRowModel().rows;
  const selectedCount = selectedRows.length;

  // Live row count after a filter change (not on first render).
  const filterKey = `${state.q}\u0000${JSON.stringify(state.filters)}`;
  const firstFilter = React.useRef(true);
  React.useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    if (loading) return;
    const n = serverSide ? data.length : filteredData.length;
    announce(`${formatCount(n)} ${n === 1 ? "row" : "rows"}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, loading]);

  // Virtualization (client mode, many rows).
  const virtual =
    pagination.mode === "client" && pageRows.length > VIRTUALIZE_ABOVE;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: virtual ? pageRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT[density],
    overscan: 10,
    initialRect: { width: 1024, height: 640 },
    // Where layout reports no height (jsdom, a hidden tab) assume a 640 px window, so the table
    // still renders a window of rows rather than none.
    observeElementRect: (
      instance: Virtualizer<HTMLDivElement, HTMLTableRowElement>,
      cb,
    ) =>
      observeElementRect(instance, (rect) =>
        cb(rect.height > 0 ? rect : { width: rect.width || 1024, height: 640 }),
      ),
  });

  // ── Sorting ──────────────────────────────────────────────────────────────────────────────────
  const onSort = (colId: string, multi: boolean): void => {
    const existing = state.sort.find((s) => s.id === colId);
    const rule = !existing
      ? { id: colId, desc: false }
      : !existing.desc
        ? { id: colId, desc: true }
        : null;
    let next;
    if (multi) {
      next = existing
        ? state.sort.flatMap((s) =>
            s.id === colId ? (rule ? [rule] : []) : [s],
          )
        : [...state.sort, ...(rule ? [rule] : [])];
    } else {
      next = rule ? [rule] : [];
    }
    update({ sort: next });
  };

  // ── Rows ────────────────────────────────────────────────────────────────────────────────────
  const labelOf = (row: T): string =>
    rowLabel ? rowLabel(row) : getRowId(row);

  const followRow = (e: React.MouseEvent<HTMLElement>): void => {
    if (!rowHref) return;
    const target = e.target as Element;
    if (target.closest(INTERACTIVE)) return;
    if (window.getSelection?.()?.toString()) return;
    e.currentTarget.querySelector<HTMLAnchorElement>(ROW_LINK)?.click();
  };

  const renderLink = (row: T, children: React.ReactNode): React.ReactNode => {
    if (!rowHref) return children;
    const href = rowHref(row);
    // A block, so a truncating cell inside it gets a bounded width (phone cards especially).
    const cls =
      "block min-w-0 max-w-full font-bold text-fg-strong underline-offset-2 hover:text-accent-fg hover:underline";
    if (LinkComponent) {
      return (
        <span data-row-link-wrap className="block min-w-0">
          <LinkComponent to={href} className={cls}>
            {children}
          </LinkComponent>
        </span>
      );
    }
    return (
      <a href={href} data-row-link className={cls}>
        {children}
      </a>
    );
  };

  const cellContent = (cell: Cell<T, unknown>): React.ReactNode => {
    const content = flexRender(cell.column.columnDef.cell, cell.getContext());
    return cell.column.id === primaryId
      ? renderLink(cell.row.original, content)
      : content;
  };

  const cellClass = (col: Column<T, unknown>): string => {
    const meta = col.columnDef.meta;
    return cn(
      "px-3 align-middle",
      alignClass(meta?.numeric ? "end" : meta?.align),
      meta?.numeric && "tabular-nums",
      meta?.mono && "font-mono text-xs",
    );
  };

  const stickyPrimary = (col: Column<T, unknown>): string =>
    col.id === primaryId && visibleColumns[0]?.id === primaryId
      ? cn("sticky z-[1] bg-inherit", selection ? "left-10" : "left-0")
      : "";

  const rowHeight = density === "compact" ? "h-9" : "h-11";

  const renderRow = (row: Row<T>, extraClass?: string): React.ReactElement => {
    const label = labelOf(row.original);
    const selected = row.getIsSelected();
    return (
      <tr
        key={row.id}
        data-row-id={row.id}
        data-selected={selected || undefined}
        tabIndex={-1}
        onClick={followRow}
        className={cn(
          rowHeight,
          "border-b border-border bg-surface-raised text-sm text-fg outline-hidden",
          "hover:bg-surface-overlay focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
          "data-[selected]:bg-accent-subtle",
          rowHref && "cursor-pointer",
          extraClass,
        )}
      >
        {selection ? (
          <td className="sticky left-0 z-[1] w-10 bg-inherit px-3">
            <TriCheckbox
              checked={selected}
              onChange={(v) => row.toggleSelected(v)}
              label={`Select ${label}`}
            />
          </td>
        ) : null}
        {row.getVisibleCells().map((cell) => (
          <td
            key={cell.id}
            className={cn(cellClass(cell.column), stickyPrimary(cell.column))}
          >
            {cellContent(cell)}
          </td>
        ))}
        {rowActions ? (
          <td className="w-12 px-2 text-right">
            <RowMenu label={label} items={rowActions(row.original)} />
          </td>
        ) : null}
      </tr>
    );
  };

  const colSpan =
    visibleColumns.length + (selection ? 1 : 0) + (rowActions ? 1 : 0);

  const clearFilters = (): void => update({ q: "", filters: {} });

  // ── Keyboard: j/k move row focus, Enter opens, x toggles selection ─────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (
      target.closest(
        "input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=true],[role=menu],[role=dialog]",
      )
    )
      return;
    const rows = Array.from(
      e.currentTarget.querySelectorAll<HTMLTableRowElement>(
        "tbody tr[data-row-id]",
      ),
    );
    if (rows.length === 0) return;
    const current = target.closest<HTMLTableRowElement>("tr[data-row-id]");
    const index = current ? rows.indexOf(current) : -1;
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      const next =
        e.key === "j"
          ? Math.min(rows.length - 1, index + 1)
          : Math.max(0, index === -1 ? 0 : index - 1);
      rows[next]?.focus();
      rows[next]?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (!current || target !== current) return;
    if (e.key === "Enter") {
      e.preventDefault();
      current.querySelector<HTMLAnchorElement>(ROW_LINK)?.click();
    } else if (e.key === "x" && selection) {
      e.preventDefault();
      table.getRow(current.dataset.rowId!)?.toggleSelected();
    }
  };

  // ── Toolbar ─────────────────────────────────────────────────────────────────────────────────
  const facetCounts = (facet: Facet<T>): Map<string, number> | null => {
    if (serverSide) return null;
    const base = filterRows(
      data,
      columns,
      state,
      facets,
      search?.columns,
      facet.id,
    );
    const counts = new Map<string, number>();
    base.forEach((row, i) => {
      for (const v of facetValues(facet, columns, row, i))
        counts.set(v, (counts.get(v) ?? 0) + 1);
    });
    return counts;
  };

  const barFacets: FilterBarFacet[] = facets.map((f) => {
    const counts = facetCounts(f);
    return {
      id: f.id,
      label: f.label,
      options: f.options.map((o) => ({
        ...o,
        count: counts ? (counts.get(o.value) ?? 0) : undefined,
      })),
      selected: state.filters[f.id] ?? [],
      onChange: (next) =>
        update({ filters: { ...state.filters, [f.id]: next } }),
    };
  });

  const hideable = table
    .getAllLeafColumns()
    .filter((c) => !c.columnDef.meta?.alwaysVisible && c.id !== primaryId);

  const csvEnabled = (props.exportCsv ?? true) && pagination.mode === "client";
  // Columns and density earn their row only on a table big enough to tune, and never on a phone
  // (cards or a scrolled table: a phone is no place to tune a table).
  // A table with a hidden column keeps Columns, or that column could never come back.
  const minimalChrome =
    chrome === "minimal" ||
    (chrome === "auto" &&
      pagination.mode === "client" &&
      data.length < 10 &&
      hidden.length === 0);
  const showViewControls = !minimalChrome && !isPhone;
  const exportCsv = (): void => {
    const visibleDefs = columns.filter((c) => !hidden.includes(columnId(c)));
    const sorted = allRows.map((r) => r.original);
    downloadCsv(`${id}.csv`, tableCsv(sorted, visibleDefs));
  };

  const toolbar =
    selectedCount > 0 && selection ? (
      <div className="flex min-h-10 flex-wrap items-center gap-2 rounded-md border border-border bg-accent-subtle px-3 py-1.5">
        <span className="text-sm font-bold text-fg-strong tabular-nums">
          {allMatching && pagination.mode === "cursor" && pagination.total
            ? `All ${formatCount(pagination.total)} selected`
            : `${formatCount(selectedCount)} selected`}
        </span>
        {pagination.mode === "cursor" &&
        pagination.total !== undefined &&
        !allMatching &&
        table.getIsAllRowsSelected() &&
        pagination.total > data.length ? (
          <Button variant="link" size="xs" onClick={() => setAllMatching(true)}>
            Select all {formatCount(pagination.total)} matching
          </Button>
        ) : null}
        <span aria-hidden className="text-fg-subtle">
          ·
        </span>
        {selection.bulkActions.map((a) => (
          <Button
            key={a.label}
            size="sm"
            variant={a.tone === "danger" ? "danger" : "outline"}
            onClick={() =>
              a.onSelect(
                selectedRows.map((r) => r.original),
                { allMatching },
              )
            }
          >
            {a.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            setAllMatching(false);
            setRowSelection({});
          }}
        >
          Clear selection
        </Button>
      </div>
    ) : (
      <FilterBar
        search={
          search
            ? {
                value: state.q,
                onChange: (q) => update({ q }),
                placeholder: search.placeholder,
              }
            : undefined
        }
        facets={barFacets}
        onClearAll={clearFilters}
        actions={
          <>
            {toolbarActions}
            {showViewControls && hideable.length > 0 ? (
              <Popover
                label="Columns"
                trigger={
                  <Button
                    variant="outline"
                    size="sm"
                    iconStart={<Columns3 aria-hidden />}
                  >
                    Columns
                  </Button>
                }
                align="end"
                className="w-56 p-2"
              >
                <fieldset>
                  <legend className="px-2 pb-1 text-xs font-bold text-fg-muted">
                    Show columns
                  </legend>
                  {hideable.map((c) => (
                    <label
                      key={c.id}
                      className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-fg hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-accent"
                        checked={c.getIsVisible()}
                        onChange={(e) =>
                          setColumnHidden(c.id, !e.target.checked)
                        }
                      />
                      {columnLabel(c.columnDef as DataColumn<T>)}
                    </label>
                  ))}
                </fieldset>
              </Popover>
            ) : null}
            {showViewControls ? (
              <div
                role="group"
                aria-label="Row density"
                className="inline-flex rounded-md border border-border-strong p-0.5"
              >
                {(["comfortable", "compact"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={density === d}
                    onClick={() => setDensity(d)}
                    className={cn(
                      "h-7 rounded-sm px-2 text-xs capitalize text-fg-muted",
                      density === d && "bg-hover font-bold text-fg-strong",
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            ) : null}
            {csvEnabled ? (
              <Button
                variant="outline"
                size="sm"
                iconStart={<Download aria-hidden />}
                onClick={exportCsv}
                disabledReason={
                  allRows.length === 0
                    ? "There are no rows to export."
                    : undefined
                }
              >
                Export CSV
              </Button>
            ) : null}
          </>
        }
      />
    );

  // ── Body ────────────────────────────────────────────────────────────────────────────────────
  const fullRow = (content: React.ReactNode): React.ReactElement => (
    <tr>
      <td colSpan={colSpan} className="p-4">
        {content}
      </td>
    </tr>
  );

  const showSkeleton = loading && data.length === 0 && !error;
  const noResults = !loading && !error && pageRows.length === 0;
  // First run: nothing exists yet and nothing is filtered. The empty state stands alone, with no
  // toolbar, header row or table border around it.
  const firstRun = noResults && data.length === 0 && !isFiltered;

  const noResultsState = isFiltered ? (
    <EmptyState
      kind="no-results"
      title={`No ${caption.toLowerCase()} match these filters`}
      filters={describeFilters(state, facets)}
      onClearFilters={clearFilters}
    />
  ) : (
    (empty ?? (
      <EmptyState kind="first-run" title={`No ${caption.toLowerCase()}`} />
    ))
  );

  let body: React.ReactNode;
  if (error) {
    body = fullRow(<ErrorState error={error} onRetry={onRetry} compact />);
  } else if (showSkeleton) {
    body = Array.from({ length: 5 }, (_, i) => (
      <tr
        key={`sk-${i}`}
        aria-hidden
        className={cn(rowHeight, "border-b border-border")}
      >
        {selection ? <td className="w-10 px-3" /> : null}
        {visibleColumns.map((c) => (
          <td key={c.id} className="px-3">
            <Skeleton
              className={cn(
                "h-4",
                c.columnDef.meta?.numeric ? "ml-auto w-12" : "w-3/4",
              )}
            />
          </td>
        ))}
        {rowActions ? <td className="w-12" /> : null}
      </tr>
    ));
  } else if (noResults) {
    body = fullRow(noResultsState);
  } else if (virtual) {
    const items = virtualizer.getVirtualItems();
    const top = items[0]?.start ?? 0;
    const bottom =
      virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0);
    body = (
      <>
        {top > 0 ? (
          <tr aria-hidden>
            {/* Spacer: React applies the height through CSSOM, which the CSP allows. */}
            <td colSpan={colSpan} style={{ height: top, padding: 0 }} />
          </tr>
        ) : null}
        {items.map((item) => renderRow(pageRows[item.index]!))}
        {bottom > 0 ? (
          <tr aria-hidden>
            <td colSpan={colSpan} style={{ height: bottom, padding: 0 }} />
          </tr>
        ) : null}
      </>
    );
  } else {
    body = pageRows.map((row) => renderRow(row));
  }

  const headerAllChecked = table.getIsAllRowsSelected();
  const headerSome = table.getIsSomeRowsSelected();

  const tableEl = (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="sticky top-0 z-[2] bg-surface-raised">
        <tr className="border-b border-border">
          {selection ? (
            <th
              scope="col"
              className="sticky left-0 z-[3] w-10 bg-surface-raised px-3 text-left"
            >
              <TriCheckbox
                checked={headerAllChecked}
                indeterminate={!headerAllChecked && headerSome}
                onChange={(v) => table.toggleAllRowsSelected(v)}
                label={`Select all ${caption.toLowerCase()}`}
              />
            </th>
          ) : null}
          {(table.getHeaderGroups()[0]?.headers ?? []).map((header) => {
            const col = header.column;
            const meta = col.columnDef.meta;
            const sortRule = state.sort.find((s) => s.id === col.id);
            const dir = sortRule ? (sortRule.desc ? "desc" : "asc") : false;
            const canSort = col.getCanSort();
            const label = header.isPlaceholder
              ? null
              : flexRender(col.columnDef.header, header.getContext());
            return (
              <th
                key={header.id}
                scope="col"
                aria-sort={
                  dir === "asc"
                    ? "ascending"
                    : dir === "desc"
                      ? "descending"
                      : undefined
                }
                className={cn(
                  "h-9 px-3 align-middle text-xs leading-4 font-bold whitespace-nowrap text-fg-muted",
                  alignClass(meta?.numeric ? "end" : meta?.align),
                  stickyPrimary(col) &&
                    cn(stickyPrimary(col), "z-[3] bg-surface-raised"),
                )}
              >
                {canSort ? (
                  <button
                    type="button"
                    onClick={(e) => onSort(col.id, e.shiftKey)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm align-middle leading-4 hover:text-fg-strong",
                      meta?.numeric && "flex-row-reverse",
                    )}
                  >
                    {label}
                    <SortIcon dir={dir} />
                  </button>
                ) : (
                  label
                )}
              </th>
            );
          })}
          {rowActions ? (
            <th scope="col" className="w-12 px-2">
              <span className="sr-only">Actions</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  );

  const cards = (
    <ul aria-label={caption} className="space-y-2">
      {pageRows.map((row) => {
        const label = labelOf(row.original);
        const cells = row.getVisibleCells();
        const primary = cells.find((c) => c.column.id === primaryId);
        const rest = cells.filter(
          (c) =>
            c.column.id !== primaryId &&
            (c.column.columnDef.meta?.priority ?? 2) === 1,
        );
        return (
          <li
            key={row.id}
            data-row-id={row.id}
            data-selected={row.getIsSelected() || undefined}
            onClick={followRow}
            className={cn(
              "rounded-lg border border-border bg-surface-raised p-3 data-[selected]:bg-accent-subtle",
              rowHref && "cursor-pointer",
            )}
          >
            <div className="flex items-start gap-2">
              {selection ? (
                <TriCheckbox
                  checked={row.getIsSelected()}
                  onChange={(v) => row.toggleSelected(v)}
                  label={`Select ${label}`}
                />
              ) : null}
              <div className="min-w-0 flex-1 text-sm">
                {primary ? cellContent(primary) : label}
              </div>
              {rowActions ? (
                <RowMenu label={label} items={rowActions(row.original)} />
              ) : null}
            </div>
            {rest.length > 0 ? (
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                {rest.map((c) => (
                  <React.Fragment key={c.id}>
                    <dt className="text-fg-muted">
                      {columnLabel(c.column.columnDef as DataColumn<T>)}
                    </dt>
                    <dd
                      className={cn(
                        "min-w-0 text-fg",
                        c.column.columnDef.meta?.mono && "font-mono",
                      )}
                    >
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  // ── Footer ──────────────────────────────────────────────────────────────────────────────────
  let footer: React.ReactNode = null;
  if (!error && !showSkeleton && pageRows.length > 0) {
    if (pagination.mode === "client") {
      // Unfiltered, the count only repeats what the rows show, unless the rows are virtualized
      // and never all on screen.
      footer = isFiltered ? (
        <p className="text-xs text-fg-muted tabular-nums">
          {`Showing ${formatCount(allRows.length)} of ${formatCount(data.length)}`}
        </p>
      ) : virtual ? (
        <p className="text-xs text-fg-muted tabular-nums">
          {`Showing ${formatCount(allRows.length)}`}
        </p>
      ) : null;
    } else if (pagination.mode === "cursor") {
      footer = (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-fg-muted tabular-nums">
            Showing {formatCount(data.length)}
            {pagination.total !== undefined
              ? ` of ${formatCount(pagination.total)}`
              : ""}
          </p>
          {pagination.hasMore ? (
            <Button
              variant="outline"
              size="sm"
              loading={pagination.loadingMore}
              onClick={pagination.onLoadMore}
            >
              Load more
            </Button>
          ) : null}
        </div>
      );
    } else {
      const total = pagination.total ?? allRows.length;
      const size = pagination.pageSize;
      const from = Math.min(total, offset + 1);
      const to = Math.min(
        total,
        offset + (pagination.total !== undefined ? data.length : size),
      );
      footer = (
        <nav
          aria-label="Pagination"
          className="flex flex-wrap items-center gap-3"
        >
          <p className="text-xs text-fg-muted tabular-nums">
            Showing {formatCount(from)}–{formatCount(to)} of{" "}
            {formatCount(total)}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {pagination.pageSizeOptions && pagination.onPageSizeChange ? (
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                Rows per page
                <select
                  value={size}
                  onChange={(e) => {
                    pagination.onPageSizeChange?.(Number(e.target.value));
                    setState({ ...state, offset: 0 });
                  }}
                  className="h-8 rounded-md border border-border-strong bg-surface-sunken px-2 text-sm text-fg"
                >
                  {pagination.pageSizeOptions.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() =>
                setState({ ...state, offset: Math.max(0, offset - size) })
              }
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + size >= total}
              onClick={() => setState({ ...state, offset: offset + size })}
            >
              Next
            </Button>
          </div>
        </nav>
      );
    }
  }

  if (firstRun) {
    return (
      <div className={cn("space-y-3", className)} data-table-id={id}>
        {noResultsState}
      </div>
    );
  }

  const hasToolbar =
    (selectedCount > 0 && selection) ||
    Boolean(search) ||
    facets.length > 0 ||
    Boolean(toolbarActions) ||
    csvEnabled ||
    showViewControls;

  return (
    <div className={cn("space-y-3", className)} data-table-id={id}>
      {hasToolbar ? toolbar : null}
      {/* The keyboard handler serves j/k/Enter/x on the rows inside; it is not itself a control. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div onKeyDown={onKeyDown}>
        {isMobileCards && !error && !showSkeleton && !noResults ? (
          cards
        ) : (
          <div
            ref={scrollRef}
            className={cn(
              "relative overflow-auto rounded-lg border border-border bg-surface-raised pk-scroll",
              virtual && "max-h-[70vh]",
            )}
          >
            {tableEl}
          </div>
        )}
      </div>
      {footer}
      <LiveRegion
        message={showSkeleton ? `Loading ${caption.toLowerCase()}…` : ""}
      />
    </div>
  );
}

/** "status: expired, active · tier: pro" for the no-results copy. */
export function describeFilters<T>(
  state: TableState,
  facets: Facet<T>[],
): string {
  const parts = facets
    .filter((f) => (state.filters[f.id] ?? []).length > 0)
    .map(
      (f) =>
        `${f.label.toLowerCase()}: ${(state.filters[f.id] ?? [])
          .map((v) => f.options.find((o) => o.value === v)?.label ?? v)
          .join(", ")}`,
    );
  if (state.q.trim()) parts.unshift(`“${state.q.trim()}”`);
  return parts.join(" · ");
}
