import * as React from "react";
import { navigate, useLocation } from "../../../router.js";

/**
 * A page's filters as plain hash-query strings (ADMIN.md §5.7). `set` patches several keys in
 * one history replacement (a blank or `null` value removes the key), so "Clear filters" and a
 * filter that resets another never race each other through two navigations.
 */
export function useQueryParams<K extends string>(
  keys: readonly K[],
): [Record<K, string>, (patch: Partial<Record<K, string | null>>) => void] {
  const { route, hash } = useLocation();
  const qs = route.query.toString();
  const values = React.useMemo(() => {
    const q = new URLSearchParams(qs);
    return Object.fromEntries(keys.map((k) => [k, q.get(k) ?? ""])) as Record<
      K,
      string
    >;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, keys.join(",")]);
  const set = React.useCallback(
    (patch: Partial<Record<K, string | null>>) => {
      const q = new URLSearchParams(qs);
      for (const [k, v] of Object.entries(patch) as [K, string | null][]) {
        if (v === null || v === undefined || v === "") q.delete(k);
        else q.set(k, v);
      }
      const at = hash.indexOf("?");
      const path = at === -1 ? hash : hash.slice(0, at);
      const s = q.toString();
      navigate(`${path || "#/"}${s ? `?${s}` : ""}`, { replace: true });
    },
    [hash, qs],
  );
  return [values, set];
}
