import type { ColumnDef, RowData } from "@tanstack/react-table";
import type * as React from "react";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /**
     * 1: always shown, and the fields of a mobile card. 2: shown by default. 3: hidden by default
     * below 1440 px (the operator can show it from "Columns").
     */
    priority?: 1 | 2 | 3;
    /** Hidden until the operator shows it from "Columns", at every width (Licenses' Channels, Deliverables' low-value detail). */
    defaultHidden?: boolean;
    align?: "start" | "center" | "end";
    /** Ids, keys, hashes, versions: mono xs. */
    mono?: boolean;
    /** Right-aligned tabular figures. */
    numeric?: boolean;
    /** The column's plain-text name, when `header` is not a string (menus, chips, cards, CSV). */
    label?: string;
    /** The primary column: its cell becomes the row link (`rowHref`). Default: the first column. */
    primary?: boolean;
    /** The CSV value of a cell (default: the accessor value, stringified). */
    csv?: (row: TData) => string;
    /** The column cannot be hidden from the Columns menu. */
    alwaysVisible?: boolean;
    /**
     * The cell shows nothing a reader needs for this row (a healthy state: pills mean attention,
     * ADMIN.md §5.11). A mobile card leaves the field out rather than print a bare label.
     */
    quiet?: (row: TData) => boolean;
  }
}

/** A column: TanStack Table's ColumnDef with the console's `meta` (above). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataColumn<T> = ColumnDef<T, any>;

export interface SortRule {
  id: string;
  desc: boolean;
}

/**
 * A table's URL-backed state (ADMIN.md §5.7): `q`, `sort` (`-` prefix for descending in the URL),
 * one comma-list per facet, and the pagination position.
 */
export interface TableState {
  q: string;
  sort: SortRule[];
  filters: Record<string, string[]>;
  cursor?: string | null;
  offset?: number;
}

export const EMPTY_TABLE_STATE: TableState = {
  q: "",
  sort: [],
  filters: {},
  cursor: null,
  offset: 0,
};

export interface FacetOption {
  value: string;
  label: string;
}

export interface Facet<T> {
  id: string;
  label: string;
  options: FacetOption[];
  /** The row's value(s) for this facet (default: the column with the same id). */
  accessor?: (row: T) => string | string[] | null | undefined;
}

export interface BulkAction<T> {
  label: string;
  tone?: "danger";
  onSelect: (rows: T[], ctx: { allMatching: boolean }) => void;
  /** Why the action is unavailable for this selection; the button stays visible, with the reason. */
  disabledReason?: (rows: T[]) => string | undefined;
}

export interface RowAction {
  label: string;
  onSelect: () => void;
  tone?: "danger";
  disabledReason?: string;
}

export type RowActionItem = RowAction | { type: "separator" };

export type PaginationConfig =
  | { mode: "client" }
  | {
      mode: "cursor";
      onLoadMore: () => void;
      hasMore: boolean;
      loadingMore?: boolean;
      /** The server's total, when known: enables "Select all N matching". */
      total?: number;
    }
  | {
      mode: "offset";
      pageSize: number;
      /**
       * The server's total. When set, `data` is the current page (server paging); otherwise the
       * table pages `data` itself.
       */
      total?: number;
      pageSizeOptions?: number[];
      onPageSizeChange?: (size: number) => void;
    };

export type Density = "comfortable" | "compact";

export interface DataTableProps<T> {
  /** Namespaces the persisted column and density preferences. */
  id: string;
  data: T[];
  columns: DataColumn<T>[];
  getRowId: (row: T) => string;
  /** The table's label: an sr-only caption, and the bulk bar's and live region's noun. */
  caption: string;
  /** Controlled state (from `useTableUrlState`). Omitted: the table keeps its own. */
  state?: TableState;
  onStateChange?: (next: TableState) => void;
  facets?: Facet<T>[];
  search?: { placeholder: string; columns?: string[] };
  selection?: { mode: "multi"; bulkActions: BulkAction<T>[] };
  /** The record a row opens. The primary cell renders as a real link to it. */
  rowHref?: (row: T) => string;
  /** The row's name for its action menu ("Actions for {name}"). Default: the row id. */
  rowLabel?: (row: T) => string;
  rowActions?: (row: T) => RowActionItem[];
  /** Renders the primary link; pass the router's `Link` to honour navigation guards. */
  linkComponent?: React.ComponentType<{
    to: string;
    className?: string;
    children: React.ReactNode;
  }>;
  pagination?: PaginationConfig;
  density?: Density;
  onDensityChange?: (d: Density) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** The first-run state, shown when there are no rows and no filters. */
  empty?: React.ReactNode;
  /** Below 1024 px: `cards` draws each row as a card; `scroll` keeps the table (it must fit). */
  mobile?: "cards" | "scroll";
  /** Extra controls at the end of the filter bar (Export, a date range). */
  toolbarActions?: React.ReactNode;
  /** Offer "Export CSV" (client mode only). Default true in client mode. */
  exportCsv?: boolean;
  /**
   * The table chrome. `full` always offers Columns and density; `minimal` never does (a small
   * reference table inside a card). Default `auto`: minimal below 10 rows in client mode.
   */
  chrome?: "auto" | "full" | "minimal";
  className?: string;
}
