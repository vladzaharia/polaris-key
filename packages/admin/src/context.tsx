import React, { createContext, useCallback, useContext } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import type { Me } from "./api.js";
import { queryClient } from "./console/data/queryClient.js";
import { useProduct } from "./console/data/hooks.js";
import type { ServiceState } from "./console/nav.js";
// Installs the mutation → invalidation table on the API client (ADMIN.md §5.4). Imported here
// because every legacy view imports this module, including in tests that render a view alone.
import "./console/data/mutations.js";

/**
 * TEMPORARY ADAPTER (docs/design/ADMIN.md §7.2 chunk 2; deleted in chunk 11).
 *
 * The legacy views were written against a hand-rolled resource cache (`useResource(key,
 * fetcher)` + `invalidate(prefix)`). Chunk 2 moves the data layer to TanStack Query; rather than
 * rewrite every view at once, `useResource` now reads through the one query client, keyed by the
 * structured keys in `console/data/queries.ts`, so the views keep their shape until their area
 * chunk rebuilds them on `useQuery` directly. Writes no longer invalidate by hand: every write goes
 * through `mutate()`, which runs the write's declared invalidation (`console/data/mutations.ts`).
 *
 * `useAdmin` stays for the two views that read the session from context.
 */
export interface AdminContextValue {
  me: Me;
  product: string;
  setProduct: (slug: string) => void;
}

const AdminCtx = createContext<AdminContextValue | null>(null);

export function AdminProvider({
  value,
  children,
}: {
  value: AdminContextValue;
  children: React.ReactNode;
}): React.ReactElement {
  return <AdminCtx.Provider value={value}>{children}</AdminCtx.Provider>;
}

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminCtx);
  if (!ctx) throw new Error("useAdmin used outside AdminProvider");
  return ctx;
}

export interface ResourceState<T> {
  data: T | null;
  /** True until the first answer (or error) arrives. A background refetch keeps the old data. */
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** The legacy resource hook, over TanStack Query. `key` comes from `qk.*`. */
export function useResource<T>(
  key: QueryKey,
  fetcher: () => Promise<T>,
): ResourceState<T> {
  const query = useQuery<T>({ queryKey: key, queryFn: fetcher }, queryClient);
  const { refetch } = query;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  const err = query.error;
  return {
    data: query.data ?? null,
    loading: query.isPending && query.fetchStatus !== "idle",
    error: err
      ? err instanceof Error
        ? err.message
        : "Request failed."
      : null,
    reload,
  };
}

/**
 * Which services a product runs (D-15): the sidebar's filter and the router's enablement gate.
 * `null` means "not loaded, or a row that predates `services_json`", and every caller treats it as
 * SHOW EVERYTHING (see `isSectionEnabled` in `console/nav.ts`).
 */
export function useProductServices(slug: string): ServiceState {
  const { data } = useProduct(slug || null);
  return data?.services ?? null;
}

/**
 * Refetch everything under a key prefix, outside any write: the few places a view refreshes after
 * a FAILED write (a 409 means the server's copy moved, so show it). A successful write never needs
 * this; `mutate` invalidates what the write declared.
 */
export function invalidate(key: QueryKey): void {
  void queryClient.invalidateQueries({ queryKey: key });
}

/** Reset the query cache: tests use it to isolate renders. */
export function resetCache(): void {
  queryClient.clear();
}
