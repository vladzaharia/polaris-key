/**
 * The Release section's queries (ADMIN.md §6.3). One fetcher per key family: the
 * `queryKeyShapes` guard compares every reader of a family by source text, so every Release page
 * reads through these hooks rather than writing its own `queryFn`.
 *
 * Writes go through `mutate()` (`console/data/mutations.ts`), whose table invalidates these keys:
 * channel policy, yank and unyank refresh `release.*`, `release.compat.*` (the simulator lives
 * under it) and `distribution.matrix.*` (the overlay lives under it).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  api,
  type CompatResponse,
  type DelegationsResponse,
  type DeliverablesResponse,
  type DeliveryAccess,
  type DistributionMatrix,
  type PackFilesResponse,
  type PackReleasesResponse,
  type ReleaseChannelsResponse,
  type ReleaseHealth,
  type ReleaseStoreResponse,
  type SimulateParams,
  type SimulateResponse,
} from "../../../api.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";

/** Compatibility rows per page: app releases, with the pack releases relevant to them. */
export const COMPAT_PAGE = 10;
/** Distribution's matrix maximum: the overlay knows its newest this many app releases. */
export const MATRIX_WINDOW = 50;

/** The release truth store: releases, the sync's channel map and the rollback floors. */
export function useReleaseStore(
  slug: string,
): UseQueryResult<ReleaseStoreResponse> {
  return useQuery(
    { queryKey: qk.releases(slug), queryFn: () => api.releases(slug) },
    queryClient,
  );
}

/** Every deliverable's channels: policy, source and per-platform resolution. */
export function useReleaseChannels(
  slug: string,
): UseQueryResult<ReleaseChannelsResponse> {
  return useQuery(
    {
      queryKey: qk.channels(slug),
      queryFn: () => api.releaseChannels(slug),
    },
    queryClient,
  );
}

/** The repo-sync health checks (GitHub access, the latest release's artifacts, Sparkle). */
export function useReleaseHealth(slug: string): UseQueryResult<ReleaseHealth> {
  return useQuery(
    {
      queryKey: qk.releaseHealth(slug),
      queryFn: () => api.releaseHealth(slug).then((r) => r.health),
    },
    queryClient,
  );
}

/** The app and every pack, with declaration, gate and latest release. */
export function useDeliverables(
  slug: string,
): UseQueryResult<DeliverablesResponse> {
  return useQuery(
    {
      queryKey: qk.deliverables(slug),
      queryFn: () => api.deliverables(slug),
    },
    queryClient,
  );
}

/** One pack's releases, newest first, each with the app releases that pin it. */
export function usePackReleases(
  slug: string,
  deliverable: string | null,
): UseQueryResult<PackReleasesResponse> {
  const id = deliverable ?? "";
  return useQuery(
    {
      queryKey: qk.packReleases(slug, id),
      queryFn: () => api.packReleases(slug, id),
      enabled: deliverable !== null,
    },
    queryClient,
  );
}

/** One variant's files index (cached: an index never changes for a published release). */
export function usePackFiles(
  slug: string,
  target: { deliverable: string; releaseId: string; variant: string } | null,
): UseQueryResult<PackFilesResponse> {
  const t = target ?? { deliverable: "", releaseId: "", variant: "" };
  return useQuery(
    {
      queryKey: qk.packFiles(slug, t.deliverable, t.releaseId, t.variant),
      queryFn: () => api.packFiles(slug, t.deliverable, t.releaseId, t.variant),
      enabled: target !== null,
      staleTime: Infinity,
    },
    queryClient,
  );
}

/** The delegated content keys, read-only. */
export function useDelegations(
  slug: string,
): UseQueryResult<DelegationsResponse> {
  return useQuery(
    {
      queryKey: qk.delegations(slug),
      queryFn: () => api.delegations(slug),
    },
    queryClient,
  );
}

/** One page of the compatibility matrix. */
export function useCompat(
  slug: string,
  offset: number,
): UseQueryResult<CompatResponse> {
  return useQuery(
    {
      queryKey: qk.compat(slug, offset),
      queryFn: () => api.releaseCompat(slug, { limit: COMPAT_PAGE, offset }),
      placeholderData: (previous) => previous,
    },
    queryClient,
  );
}

/**
 * Distribution's matrix of the app's newest releases: the Compatibility overlay and a release
 * record's Distribution tab. Off when Distribution is not enabled (the worker would 404).
 */
export function useMatrixOverlay(
  slug: string,
  enabled: boolean,
): UseQueryResult<DistributionMatrix> {
  return useQuery(
    {
      queryKey: qk.matrixOverlay(slug),
      queryFn: () =>
        api.distributionMatrix(slug, {
          deliverable: "app",
          limit: MATRIX_WINDOW,
        }),
      enabled,
    },
    queryClient,
  );
}

/** Delivery access per deliverable (Distribution's `dist_access`). */
export function useDeliveryAccess(
  slug: string,
  enabled: boolean,
): UseQueryResult<DeliveryAccess> {
  return useQuery(
    {
      queryKey: qk.access(slug),
      queryFn: () => api.deliveryAccess(slug),
      enabled,
    },
    queryClient,
  );
}

/** The simulator inputs as one stable key string (sorted, blanks dropped). */
export function simulateKey(params: SimulateParams): string {
  return Object.entries(params)
    .filter(([, v]) => typeof v === "string" && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v as string}`)
    .join("&");
}

/** One simulation; runs whenever `params` is set (the submitted inputs in the URL). */
export function useSimulation(
  slug: string,
  params: SimulateParams | null,
): UseQueryResult<SimulateResponse> {
  const p = params ?? { appRelease: "", platform: "" };
  return useQuery(
    {
      queryKey: qk.simulate(slug, simulateKey(p)),
      queryFn: () => api.simulateUpdate(slug, p),
      enabled: params !== null,
    },
    queryClient,
  );
}
