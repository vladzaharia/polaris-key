import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Input } from "./Input.js";
import { Skeleton } from "./Skeleton.js";
import { EmptyState } from "./EmptyState.js";

export interface ColumnDef<T> {
  /** Stable column id. */
  id: string;
  header: React.ReactNode;
  /** Render the cell. */
  cell: (row: T) => React.ReactNode;
  /** Pull a sortable/filterable scalar from the row. Enables sort + global filter. */
  accessor?: (row: T) => string | number | null | undefined;
  sortable?: boolean;
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Show a global text filter input (filters over all `accessor` columns). */
  filterable?: boolean;
  filterPlaceholder?: string;
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  onRowClickLabel?: (row: T) => string;
  /**
   * Content for a full-width row rendered under `row`, or null for none. The caller owns the
   * open/closed state (and the toggle, usually a button cell), so sorting keeps it attached.
   */
  expanded?: (row: T) => React.ReactNode | null;
  className?: string;
}

type SortState = { id: string; dir: "asc" | "desc" } | null;

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * A presentational data grid with client-side sort + a global text filter. Pass `ColumnDef`s
 * with an `accessor` to make a column sortable/filterable; columns without one are render-only.
 * Pagination is intentionally NOT baked in — pair with `useKeysetPagination` for keyset feeds.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  filterable = false,
  filterPlaceholder = "Filter…",
  empty,
  onRowClick,
  onRowClickLabel,
  expanded,
  className,
}: DataTableProps<T>): React.ReactElement {
  const [sort, setSort] = React.useState<SortState>(null);
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.trim().toLowerCase();
    const accessors = columns.filter((c) => c.accessor).map((c) => c.accessor!);
    return rows.filter((row) =>
      accessors.some((acc) =>
        String(acc(row) ?? "")
          .toLowerCase()
          .includes(q),
      ),
    );
  }, [rows, columns, query]);

  const sorted = React.useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.accessor) return filtered;
    const acc = col.accessor;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => compare(acc(a), acc(b)) * dir);
  }, [filtered, sort, columns]);

  const toggleSort = (id: string): void =>
    setSort((prev) =>
      prev?.id !== id
        ? { id, dir: "asc" }
        : prev.dir === "asc"
          ? { id, dir: "desc" }
          : null,
    );

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {filterable ? (
        <div className="relative max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={filterPlaceholder}
            aria-label="Filter rows"
            className="pl-8"
          />
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full caption-bottom text-sm">
          <thead className="border-b border-border bg-muted/40">
            <tr>
              {columns.map((col) => {
                const isSorted = sort?.id === col.id;
                const canSort = col.sortable && col.accessor;
                return (
                  <th
                    key={col.id}
                    scope="col"
                    aria-sort={
                      isSorted
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className={cn(
                      "h-10 px-3 text-left align-middle font-medium text-muted-foreground",
                      col.headerClassName,
                    )}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.id)}
                        className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {col.header}
                        {isSorted ? (
                          sort.dir === "asc" ? (
                            <ArrowUp className="size-3.5" />
                          ) : (
                            <ArrowDown className="size-3.5" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3.5 opacity-50" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr
                  key={`sk-${i}`}
                  className="border-b border-border last:border-0"
                >
                  {columns.map((col) => (
                    <td key={col.id} className="px-3 py-3">
                      <Skeleton className="h-4 w-24" />
                    </td>
                  ))}
                </tr>
              ))
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  {empty ?? (
                    <EmptyState
                      title="No results"
                      className="rounded-none border-0"
                    />
                  )}
                </td>
              </tr>
            ) : (
              sorted.map((row) => {
                const click = onRowClick ? () => onRowClick(row) : undefined;
                const detail = expanded?.(row) ?? null;
                return (
                  <React.Fragment key={rowKey(row)}>
                    <tr
                      role={onRowClick ? "button" : undefined}
                      tabIndex={onRowClick ? 0 : undefined}
                      aria-label={onRowClickLabel?.(row)}
                      onClick={click}
                      onKeyDown={
                        onRowClick
                          ? (e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              onRowClick(row);
                            }
                          : undefined
                      }
                      className={cn(
                        "border-b border-border transition-colors last:border-0 hover:bg-muted/40",
                        onRowClick &&
                          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      )}
                    >
                      {columns.map((col) => (
                        <td
                          key={col.id}
                          className={cn(
                            "px-3 py-2.5 align-middle",
                            col.className,
                          )}
                        >
                          {col.cell(row)}
                        </td>
                      ))}
                    </tr>
                    {detail !== null ? (
                      <tr className="border-b border-border bg-muted/20 last:border-0">
                        <td colSpan={columns.length} className="px-3 py-3">
                          {detail}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface KeysetCursor {
  beforeAt: number;
  beforeId: string;
}

export interface KeysetPage<T> {
  items: T[];
  nextCursor: KeysetCursor | null;
}

export interface UseKeysetPagination<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reset: () => void;
}

/**
 * Accumulating keyset (cursor) pagination for the activity feed and similar `nextCursor`
 * endpoints. `fetchPage(cursor)` resolves `{ items, nextCursor }`; `loadMore()` appends the
 * next page. The first page loads on mount; `reset()` clears and reloads from the head.
 */
export function useKeysetPagination<T>(
  fetchPage: (cursor: KeysetCursor | null) => Promise<KeysetPage<T>>,
  deps: React.DependencyList = [],
): UseKeysetPagination<T> {
  const [items, setItems] = React.useState<T[]>([]);
  const [cursor, setCursor] = React.useState<KeysetCursor | null>(null);
  const [hasMore, setHasMore] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fetchRef = React.useRef(fetchPage);
  fetchRef.current = fetchPage;

  const load = React.useCallback(
    (next: KeysetCursor | null, append: boolean) => {
      setLoading(true);
      setError(null);
      fetchRef
        .current(next)
        .then((page) => {
          setItems((prev) => (append ? [...prev, ...page.items] : page.items));
          setCursor(page.nextCursor);
          setHasMore(page.nextCursor != null);
        })
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : "Request failed."),
        )
        .finally(() => setLoading(false));
    },
    [],
  );

  const reset = React.useCallback(() => {
    setItems([]);
    setCursor(null);
    setHasMore(true);
    load(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  React.useEffect(() => {
    load(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const loadMore = React.useCallback(() => {
    if (!loading && hasMore) load(cursor, true);
  }, [load, cursor, hasMore, loading]);

  return { items, loading, error, hasMore, loadMore, reset };
}
