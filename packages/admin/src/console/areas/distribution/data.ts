/**
 * The Distribution and Update pages' reads (ADMIN.md §6.4, chunk 9): one fetcher per query key
 * family, so every reader of a key caches the same shape (`test/queryKeyShapes.test.ts`).
 *
 * Writes go through `mutate()` (`console/data/mutations.ts`), which runs each write's declared
 * invalidation; nothing here invalidates by hand.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  api,
  type ConnectorsResponse,
  type DeliverablesResponse,
  type DeliveryAccess,
  type DistributionKeysResponse,
  type DistributionMatrix,
  type OutletCredentialsResponse,
  type OutletsResponse,
  type ReleaseStoreResponse,
  type RolloutsResponse,
  type UpdateHealthResponse,
  type UpdateSettings,
} from "../../../api.js";
import type { ProductCatalog } from "@polaris-key/catalog";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { navigate } from "../../router.js";
import { codecs, type QueryCodec } from "../../routes.js";

// ── Page state in the URL (ADMIN.md §5.7) ─────────────────────────────────────────────────────

export const MATRIX_VIEWS = ["availability", "rollouts", "readiness"] as const;
export type MatrixView = (typeof MATRIX_VIEWS)[number];

/** Rows per matrix page: the server's default and its cap. */
export const MATRIX_LIMITS = [20, 50] as const;

/** The Health window choices, in hours (filtered to the server's `maxWindowHours`). */
export const HEALTH_WINDOWS = [1, 6, 24, 72] as const;

/** Module-level codecs: `useSearchParam` memoises on the codec's identity. */
export const QUERY = {
  deliverable: codecs.string("app"),
  view: codecs.oneOf(MATRIX_VIEWS, "availability"),
  channel: codecs.string(""),
  cell: codecs.string(""),
  outlet: codecs.string(""),
  limit: {
    parse: (raw: string | null): number =>
      raw === "50" ? 50 : MATRIX_LIMITS[0],
    format: (v: number): string | null =>
      v === MATRIX_LIMITS[0] ? null : String(v),
  } satisfies QueryCodec<number>,
  window: codecs.int(24),
};

/**
 * Patch several query parameters at once (`null` or `""` removes one). `useSearchParam` setters
 * each read the hash they rendered with, so two in a row would overwrite each other.
 *
 * `push` adds a history entry (opening a drawer, so Back closes it); the default replaces it.
 */
export function patchQuery(
  patch: Record<string, string | null | undefined>,
  opts: { push?: boolean } = {},
): void {
  navigate(hrefWithQuery(patch), { replace: !opts.push });
}

/** The current hash with `patch` applied to its query (for a link that opens a drawer). */
export function hrefWithQuery(
  patch: Record<string, string | null | undefined>,
): string {
  const hash = window.location.hash || "#/";
  const i = hash.indexOf("?");
  const path = i === -1 ? hash : hash.slice(0, i);
  const query = new URLSearchParams(i === -1 ? "" : hash.slice(i + 1));
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") query.delete(k);
    else query.set(k, v);
  }
  const s = query.toString();
  return `${path}${s ? `?${s}` : ""}`;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────

/** The matrix of one deliverable's newest `limit` releases. */
export function fetchMatrix(
  slug: string,
  deliverable: string,
  limit: number,
): Promise<DistributionMatrix> {
  return api.distributionMatrix(slug, { deliverable, limit });
}

export function useMatrix(
  slug: string,
  deliverable: string,
  limit: number,
): UseQueryResult<DistributionMatrix> {
  return useQuery(
    {
      queryKey: qk.matrix(slug, `${deliverable}:${limit}`),
      queryFn: () => fetchMatrix(slug, deliverable, limit),
    },
    queryClient,
  );
}

export function useRollouts(slug: string): UseQueryResult<RolloutsResponse> {
  return useQuery(
    { queryKey: qk.rollouts(slug), queryFn: () => api.rollouts(slug) },
    queryClient,
  );
}

export function useHealth(
  slug: string,
  windowHours: number,
): UseQueryResult<UpdateHealthResponse> {
  return useQuery(
    {
      queryKey: qk.health(slug, windowHours),
      queryFn: () => api.updateHealth(slug, windowHours),
      // A window change keeps the last reading on screen while the next loads.
      placeholderData: (prev) => prev,
    },
    queryClient,
  );
}

export function useAccess(slug: string): UseQueryResult<DeliveryAccess> {
  return useQuery(
    { queryKey: qk.access(slug), queryFn: () => api.deliveryAccess(slug) },
    queryClient,
  );
}

export function useCredentials(
  slug: string,
): UseQueryResult<OutletCredentialsResponse> {
  return useQuery(
    {
      queryKey: qk.credentials(slug),
      queryFn: () => api.outletCredentials(slug),
    },
    queryClient,
  );
}

export function useOutlets(slug: string): UseQueryResult<OutletsResponse> {
  return useQuery(
    {
      queryKey: qk.outlets(slug),
      queryFn: () => api.distributionOutlets(slug),
    },
    queryClient,
  );
}

export function useDistributionKeys(
  slug: string,
): UseQueryResult<DistributionKeysResponse> {
  return useQuery(
    {
      queryKey: qk.distributionKeys(slug),
      queryFn: () => api.distributionKeys(slug),
    },
    queryClient,
  );
}

export function useConnectors(
  slug: string,
): UseQueryResult<ConnectorsResponse> {
  return useQuery(
    { queryKey: qk.connectors(slug), queryFn: () => api.connectors(slug) },
    queryClient,
  );
}

/** Release's deliverables (the same fetcher as the Release pages). */
export function useDeliverables(
  slug: string,
): UseQueryResult<DeliverablesResponse> {
  return useQuery(
    { queryKey: qk.deliverables(slug), queryFn: () => api.deliverables(slug) },
    queryClient,
  );
}

/** Release's store: releases and channel pointers (the same fetcher as the Release pages). */
export function useReleaseStore(
  slug: string,
): UseQueryResult<ReleaseStoreResponse> {
  return useQuery(
    { queryKey: qk.releases(slug), queryFn: () => api.releases(slug) },
    queryClient,
  );
}

/** The config catalog (the same fetcher as the Config pages): the pack gates' flags. */
export function useCatalog(
  slug: string,
  enabled = true,
): UseQueryResult<ProductCatalog> {
  return useQuery(
    {
      queryKey: qk.catalog(slug),
      queryFn: () => api.schema(slug),
      enabled,
    },
    queryClient,
  );
}

export function useFeed(slug: string): UseQueryResult<UpdateSettings> {
  return useQuery(
    { queryKey: qk.feed(slug), queryFn: () => api.updateSettings(slug) },
    queryClient,
  );
}

/** The epoch-ms instant a query last answered (for the T1 freshness line). */
export function updatedAt(q: { dataUpdatedAt: number }): number {
  return q.dataUpdatedAt || Date.now();
}
