/**
 * The shell's data hooks (components.md §7). One query each: the five inline `product:<slug>`
 * fetchers collapse into `useProduct`, and `me` is a query like any other, so a product create or
 * delete refreshes the switcher and Home (fixes SH-1).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  api,
  setCsrf,
  type Me,
  type PlatformIdentity,
  type ProductDetail,
} from "../../api.js";
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

/**
 * The registry list, as cached under `qk.products()`. Every reader of that key must fetch through
 * this function: the cache holds one shape per key, and a view that stored the raw response
 * (`{ products }`) under the same key broke the shell's switcher and the Products page in turn.
 */
export function fetchProducts(): Promise<ProductDetail[]> {
  // The system product (F-03) is the platform's own (the package-feeds owner of our SDKs): it is
  // reached from Platform, never listed beside registered products or offered by the switcher.
  return api.products().then((r) => r.products.filter((p) => !p.system));
}

export function useProducts(): UseQueryResult<ProductDetail[]> {
  return useQuery(
    { queryKey: qk.products(), queryFn: fetchProducts },
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

export function fetchPlatformVersion(): Promise<PlatformIdentity> {
  return api.platformVersion();
}

/**
 * The running build (A-11), for the account menu's version chip. It changes only on a deploy, so
 * it is not refetched on every focus; a failure hides the chip rather than reporting anything.
 */
export function usePlatformVersion(): UseQueryResult<PlatformIdentity> {
  return useQuery(
    {
      queryKey: qk.platformVersion(),
      queryFn: fetchPlatformVersion,
      staleTime: 5 * 60_000,
      retry: false,
    },
    queryClient,
  );
}
