/**
 * The shell's data hooks (components.md §7). One query each: the five inline `product:<slug>`
 * fetchers collapse into `useProduct`, and `me` is a query like any other, so a product create or
 * delete refreshes the switcher and Home (fixes SH-1).
 */

import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  api,
  setCsrf,
  type AdminSummary,
  type Me,
  type PlatformIdentity,
  type ProductDetail,
} from "../../api.js";
import type { ServiceState } from "../nav.js";
import { qk } from "./queries.js";

/** Fetch the session and arm the CSRF token every write echoes. */
export async function fetchMe(): Promise<Me> {
  const me = await api.me();
  setCsrf(me.csrf);
  return me;
}

export function useMe(): UseQueryResult<Me> {
  return useQuery({ queryKey: qk.me(), queryFn: fetchMe });
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
  return useQuery({ queryKey: qk.products(), queryFn: fetchProducts });
}

export function fetchSummary(): Promise<AdminSummary> {
  return api.summary().then((r) => ({ products: r?.products ?? {} }));
}

/**
 * Every product's per-service facts (`GET /manage/api/summary`) in one read. Home's product card
 * showed them until the owner polish of 2026-10-07 simplified it to its services' icons; nothing
 * reads them now, and the read is kept for the fleet facts A-8 plans (ADMIN.md §6.1).
 */
export function useSummary(): UseQueryResult<AdminSummary> {
  return useQuery({ queryKey: qk.summary(), queryFn: fetchSummary, retry: 1 });
}

export function fetchProduct(slug: string): Promise<ProductDetail> {
  return api.product(slug).then((r) => r.product);
}

/**
 * One product's detail. While it loads, the registry row (when the list is cached) stands in, so
 * the shell can draw the product's sections without waiting on a second round trip.
 */
export function useProduct(slug: string | null): UseQueryResult<ProductDetail> {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: qk.product(slug ?? ""),
    queryFn: () => fetchProduct(slug!),
    enabled: !!slug,
    placeholderData: () =>
      queryClient
        .getQueryData<ProductDetail[]>(qk.products())
        ?.find((p) => p.slug === slug),
  });
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

export function fetchPlatformVersion(): Promise<PlatformIdentity> {
  return api.platformVersion();
}

/**
 * The running build (A-11), for the account menu's version chip. It changes only on a deploy, so
 * it is not refetched on every focus; a failure hides the chip rather than reporting anything.
 */
export function usePlatformVersion(): UseQueryResult<PlatformIdentity> {
  return useQuery({
    queryKey: qk.platformVersion(),
    queryFn: fetchPlatformVersion,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
