/**
 * The shell's data hooks (components.md §7). One query each, over the factories in `./reads.ts`:
 * the five inline `product:<slug>` fetchers collapse into `useProduct`, and `me` is a query like
 * any other, so a product create or delete refreshes the switcher and Home (fixes SH-1).
 */

import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  AttentionItemDto,
  Me,
  PlatformIdentity,
  PlatformReadyDto,
  ProductDetail,
} from "../../api.js";
import type { ServiceState } from "../nav.js";
import { qk } from "./queries.js";
import { reads } from "./reads.js";

export {
  fetchAttention,
  fetchMe,
  fetchPlatformVersion,
  fetchProduct,
  fetchProducts,
  fetchSecrets,
} from "./reads.js";

export function useMe(): UseQueryResult<Me> {
  return useQuery(reads.me());
}

export function useProducts(): UseQueryResult<ProductDetail[]> {
  return useQuery(reads.products());
}

/**
 * What needs the operator across every product (`GET /manage/api/attention`): one server read,
 * already filtered to the products the member sees and the fixes they can open. Home's list and
 * the switcher's per-product badge read it.
 */
export function useAttention(): UseQueryResult<AttentionItemDto[]> {
  return useQuery(reads.attention());
}

/** Platform ready (`GET /manage/api/platform/ready`); `enabled` is the member's Platform area. */
export function usePlatformReady(
  enabled = true,
): UseQueryResult<PlatformReadyDto> {
  return useQuery({ ...reads.platformReady(), enabled });
}

/**
 * One product's detail. While it loads, the registry row (when the list is cached) stands in, so
 * the shell can draw the product's sections without waiting on a second round trip.
 */
export function useProduct(slug: string | null): UseQueryResult<ProductDetail> {
  const queryClient = useQueryClient();
  return useQuery({
    ...reads.product(slug ?? ""),
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

/**
 * The running build (A-11), for the account menu's version chip. It changes only on a deploy, so
 * it is not refetched on every focus; a failure hides the chip rather than reporting anything.
 */
export function usePlatformVersion(
  enabled = true,
): UseQueryResult<PlatformIdentity> {
  // ST-29: the build identity is the Platform area's; a member without it never asks.
  return useQuery({ ...reads.platformVersion(), enabled });
}
