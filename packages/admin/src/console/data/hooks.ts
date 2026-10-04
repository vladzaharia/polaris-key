/**
 * The shell's data hooks (components.md §7). One query each: the five inline `product:<slug>`
 * fetchers collapse into `useProduct`, and `me` is a query like any other, so a product create or
 * delete refreshes the switcher and Home (fixes SH-1).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, setCsrf, type Me, type ProductDetail } from "../../api.js";
import { qk } from "./queries.js";
import { queryClient } from "./queryClient.js";

/** Fetch the session and arm the CSRF token every write echoes. */
export async function fetchMe(): Promise<Me> {
  const me = await api.me();
  setCsrf(me.csrf);
  return me;
}

export function useMe(): UseQueryResult<Me> {
  return useQuery({ queryKey: qk.me(), queryFn: fetchMe }, queryClient);
}

export function useProducts(): UseQueryResult<ProductDetail[]> {
  return useQuery(
    {
      queryKey: qk.products(),
      queryFn: () => api.products().then((r) => r.products),
    },
    queryClient,
  );
}

export function fetchProduct(slug: string): Promise<ProductDetail> {
  return api.product(slug).then((r) => r.product);
}

/**
 * One product's detail. While it loads, the registry row (when the list is cached) stands in, so
 * the shell can draw the product's sections without waiting on a second round trip.
 */
export function useProduct(slug: string | null): UseQueryResult<ProductDetail> {
  return useQuery(
    {
      queryKey: qk.product(slug ?? ""),
      queryFn: () => fetchProduct(slug!),
      enabled: !!slug,
      placeholderData: () =>
        queryClient
          .getQueryData<ProductDetail[]>(qk.products())
          ?.find((p) => p.slug === slug),
    },
    queryClient,
  );
}
