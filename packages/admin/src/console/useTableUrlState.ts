import * as React from "react";
import type { SortRule, TableState } from "../ui/data-table/types.js";
import { navigate, useLocation } from "./router.js";

/**
 * A collection table's state in the hash query (ADMIN.md §5.7, components.md §7):
 *
 * | Key           | Meaning                                              |
 * | ------------- | ---------------------------------------------------- |
 * | `q`           | search                                               |
 * | `sort`        | `expires,-name`: comma list, `-` prefix = descending |
 * | `<facet id>`  | comma list of selected values (`status=active,expired`) |
 * | `cursor`      | cursor pagination position                           |
 * | `offset`      | offset pagination position                           |
 *
 * **Namespacing.** A page with ONE table uses the bare keys above, so URLs stay short and match
 * the documented scheme. A page that holds two or more tables passes `namespace: true` to every
 * one of them; the keys then become `<id>.q`, `<id>.sort`, `<id>.<facet>`… so the tables cannot
 * overwrite each other.
 *
 * Writes replace the history entry (a filter change is not a page to go Back through) and never
 * remount the page; a page navigation keeps its own query, so Back to the page restores filters.
 */
export interface TableUrlOptions {
  /** The facet ids this table filters by: each is a query key. */
  facets?: readonly string[];
  /** Prefix every key with `<id>.` (only when the page holds 2+ tables). */
  namespace?: boolean;
}

export function parseSort(raw: string | null): SortRule[] {
  if (!raw) return [];
  return raw
    .split(",")
    .filter((s) => s !== "" && s !== "-")
    .map((s) =>
      s.startsWith("-")
        ? { id: s.slice(1), desc: true }
        : { id: s, desc: false },
    );
}

export function formatSort(sort: SortRule[]): string | null {
  return sort.length === 0
    ? null
    : sort.map((s) => `${s.desc ? "-" : ""}${s.id}`).join(",");
}

/** Read a table's state from a query. */
export function readTableState(
  query: URLSearchParams,
  id: string,
  opts: TableUrlOptions = {},
): TableState {
  const key = (k: string) => (opts.namespace ? `${id}.${k}` : k);
  const filters: Record<string, string[]> = {};
  for (const f of opts.facets ?? []) {
    const raw = query.get(key(f));
    const values = raw ? raw.split(",").filter((v) => v !== "") : [];
    if (values.length) filters[f] = values;
  }
  const offsetRaw = query.get(key("offset"));
  return {
    q: query.get(key("q")) ?? "",
    sort: parseSort(query.get(key("sort"))),
    filters,
    cursor: query.get(key("cursor")),
    offset: offsetRaw && /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : 0,
  };
}

/** A copy of `query` with the table's state written (defaults dropped, other keys kept). */
export function writeTableState(
  query: URLSearchParams,
  id: string,
  state: TableState,
  opts: TableUrlOptions = {},
): URLSearchParams {
  const key = (k: string) => (opts.namespace ? `${id}.${k}` : k);
  const next = new URLSearchParams(query);
  const set = (k: string, v: string | null | undefined): void => {
    if (v === null || v === undefined || v === "") next.delete(key(k));
    else next.set(key(k), v);
  };
  set("q", state.q.trim() === "" ? null : state.q);
  set("sort", formatSort(state.sort));
  for (const f of opts.facets ?? []) {
    const values = state.filters[f] ?? [];
    set(f, values.length ? values.join(",") : null);
  }
  set("cursor", state.cursor ?? null);
  set("offset", state.offset ? String(state.offset) : null);
  return next;
}

/** `[state, setState]` for a `DataTable`, backed by the hash query. */
export function useTableUrlState(
  id: string,
  opts: TableUrlOptions = {},
): [TableState, (next: TableState) => void] {
  const { route, hash } = useLocation();
  const facetKey = (opts.facets ?? []).join(",");
  const queryString = route.query.toString();
  const state = React.useMemo(
    () => readTableState(new URLSearchParams(queryString), id, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryString, id, facetKey, opts.namespace],
  );
  const set = React.useCallback(
    (next: TableState) => {
      const q = hash.indexOf("?");
      const path = q === -1 ? hash : hash.slice(0, q);
      const query = writeTableState(
        new URLSearchParams(queryString),
        id,
        next,
        opts,
      ).toString();
      navigate(`${path || "#/"}${query ? `?${query}` : ""}`, { replace: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hash, queryString, id, facetKey, opts.namespace],
  );
  return [state, set];
}
