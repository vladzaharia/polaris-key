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
    /** What a loading row draws in this column (default: one bar), at the row's real height. */
    skeleton?: React.ReactNode;
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
  /**
   * Draw the options as counted toggle chips in the filter band (see `FilterBarFacet.counted`).
   * `counts` are the page's own totals (a server count over all rows); a value it lacks keeps
   * the count over the loaded rows.
   */
  counted?: {
    icons?: Record<string, React.ReactNode>;
    counts?: Record<string, number | undefined>;
    pending?: boolean;
  };
  /** Folded into one "More" menu after the other facet menus (see `FilterBarFacet.secondary`). */
  secondary?: boolean;
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
      /**
       * Search, facets, sort and Export run over the rows loaded so far (the server only pages).
       * Without it the server does all of them and the table only draws `data`.
       */
      local?: boolean;
      /** The last Load more failed: the rows stay and the footer offers Try again. */
      loadError?: boolean;
      /** Load every page still waiting; the filtered-empty state offers it. */
      onSearchAll?: () => void;
      searchingAll?: boolean;
      /** Stop the walk after the page in flight; offered while `searchingAll`. */
      onStopSearchAll?: () => void;
      /** Facet ids the server already applied before paging (they are not "searching the loaded"). */
      serverFacets?: string[];
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
  search?: { placeholder: string; label?: string; columns?: string[] };
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
  /** Replaces the no-results title, description and action for a search the page understands (a support code). */
  noResults?: {
    title: string;
    description?: React.ReactNode;
    action?: React.ReactNode;
  };
  /**
   * With `mobile="cards"`: the card's body, replacing the primary cell and the label/value list.
   * It receives the primary cell (the row's link) to place.
   */
  mobileCard?: (row: T, primary: React.ReactNode) => React.ReactNode;
  /** Below 1024 px: `cards` draws each row as a card; `scroll` keeps the table (it must fit). */
  mobile?: "cards" | "scroll";
  /**
   * With `mobile="cards"`: the width, in root-font rems, below which the rows stack (default:
   * the 1023 px media query). In rems the stacked rows also take over at 200 % text.
   */
  cardsBelowRem?: number;
  /** With `mobile="cards"`: the rows are not cards: no border or fill, a rule between them (Members). */
  flatCards?: boolean;
  /** Below `sm` the filter bar stays on one row that scrolls sideways. */
  filtersOneRow?: boolean;
  /** Extra controls at the end of the filter bar (Export, a date range). */
  toolbarActions?: React.ReactNode;
  /** The page's own filters, first on the toolbar's row (one band, not a second toolbar). */
  toolbarLead?: React.ReactNode;
  /**
   * `compact`: the workbench band stays on one row. Columns (quiet) and Export become icon-only
   * buttons, each with a tooltip and an aria-label, below 1600 px, and the density toggle is not
   * drawn. Default `full`.
   */
  toolbarMode?: "full" | "compact";
  /**
   * Names the rows for a failed load: "{errorThing} didn't load" with a centred Retry and a quiet
   * Copy details. Without it the error is one inline line with `errorCopy`'s wording.
   */
  errorThing?: string;
  /** Offer "Export CSV" (client mode only). Default true in client mode. */
  exportCsv?: boolean;
  /**
   * The table chrome. `full` always offers Columns and density; `minimal` never does (a small
   * reference table inside a card). Default `auto`: minimal below 10 rows in client mode.
   */
  chrome?: "auto" | "full" | "minimal";
  className?: string;
}
