/**
 * The Release section's queries (ADMIN.md §6.3). One fetcher per key family: the
 * `queryFactories` guard compares every reader of a family by source text, so every Release page
 * reads through these hooks rather than writing its own `queryFn`.
 *
 * Writes go through `mutate()` (`console/data/mutations.ts`), whose table invalidates these keys:
 * channel policy, yank and unyank refresh `release.*`, `release.compat.*` (the simulator lives
 * under it) and `distribution.matrix.*` (the overlay lives under it).
 */

import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  api,
  type CiReadiness,
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
  type SetupPullRequestState,
  type SimulateParams,
  type SimulateResponse,
} from "../../../api.js";
import { qk } from "../../data/queries.js";

/** Compatibility rows per page: app releases, with the pack releases relevant to them. */
export const COMPAT_PAGE = 10;
/** Distribution's matrix maximum: the overlay knows its newest this many app releases. */
export const MATRIX_WINDOW = 50;

/** The release truth store: releases, the sync's channel map and the rollback floors. */
export const releaseStoreQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.releases(slug),
    queryFn: () => api.releases(slug),
  });

export function useReleaseStore(
  slug: string,
): UseQueryResult<ReleaseStoreResponse> {
  return useQuery(releaseStoreQuery(slug));
}

/** Every deliverable's channels: policy, source and per-platform resolution. */
export const releaseChannelsQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.channels(slug),
    queryFn: () => api.releaseChannels(slug),
  });

export function useReleaseChannels(
  slug: string,
): UseQueryResult<ReleaseChannelsResponse> {
  return useQuery(releaseChannelsQuery(slug));
}

/** The repo-sync health checks (GitHub access, the latest release's artifacts, Sparkle). */
export const releaseHealthQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.releaseHealth(slug),
    queryFn: () => api.releaseHealth(slug).then((r) => r.health),
  });

export function useReleaseHealth(slug: string): UseQueryResult<ReleaseHealth> {
  return useQuery(releaseHealthQuery(slug));
}

/** What stands between the repository and a publishing tag (A-32.3). */
export const ciReadinessQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.ciReadiness(slug),
    queryFn: () => api.ciReadiness(slug),
  });

export function useCiReadiness(slug: string): UseQueryResult<CiReadiness> {
  return useQuery(ciReadinessQuery(slug));
}

/** The open setup pull request (A-32.5). */
export const setupPullRequestQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.setupPullRequest(slug),
    queryFn: () => api.setupPullRequest(slug),
  });

export function useSetupPullRequest(
  slug: string,
): UseQueryResult<SetupPullRequestState> {
  return useQuery(setupPullRequestQuery(slug));
}

/** The app and every pack, with declaration, gate and latest release. */
export const deliverablesQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.deliverables(slug),
    queryFn: () => api.deliverables(slug),
  });

export function useDeliverables(
  slug: string,
): UseQueryResult<DeliverablesResponse> {
  return useQuery(deliverablesQuery(slug));
}

/** One pack's releases, newest first, each with the app releases that pin it. */
export const packReleasesQuery = (slug: string, id: string) =>
  queryOptions({
    queryKey: qk.packReleases(slug, id),
    queryFn: () => api.packReleases(slug, id),
  });

export function usePackReleases(
  slug: string,
  deliverable: string | null,
): UseQueryResult<PackReleasesResponse> {
  return useQuery({
    ...packReleasesQuery(slug, deliverable ?? ""),
    enabled: deliverable !== null,
  });
}

/** One variant's files index. */
export const packFilesQuery = (
  slug: string,
  deliverable: string,
  releaseId: string,
  variant: string,
) =>
  queryOptions({
    queryKey: qk.packFiles(slug, deliverable, releaseId, variant),
    queryFn: () => api.packFiles(slug, deliverable, releaseId, variant),
  });

/** One variant's files index (cached: an index never changes for a published release). */
export function usePackFiles(
  slug: string,
  target: { deliverable: string; releaseId: string; variant: string } | null,
): UseQueryResult<PackFilesResponse> {
  const t = target ?? { deliverable: "", releaseId: "", variant: "" };
  return useQuery({
    ...packFilesQuery(slug, t.deliverable, t.releaseId, t.variant),
    enabled: target !== null,
    staleTime: Infinity,
  });
}

/** The delegated content keys, read-only. */
export const delegationsQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.delegations(slug),
    queryFn: () => api.delegations(slug),
  });

export function useDelegations(
  slug: string,
): UseQueryResult<DelegationsResponse> {
  return useQuery(delegationsQuery(slug));
}

/** One page of the compatibility matrix. */
export const compatQuery = (slug: string, offset: number) =>
  queryOptions({
    queryKey: qk.compat(slug, offset),
    queryFn: () => api.releaseCompat(slug, { limit: COMPAT_PAGE, offset }),
  });

export function useCompat(
  slug: string,
  offset: number,
): UseQueryResult<CompatResponse> {
  return useQuery({
    ...compatQuery(slug, offset),
    placeholderData: (previous) => previous,
  });
}

export const matrixOverlayQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.matrixOverlay(slug),
    queryFn: () =>
      api.distributionMatrix(slug, {
        deliverable: "app",
        limit: MATRIX_WINDOW,
      }),
  });

/**
 * Distribution's matrix of the app's newest releases: the Compatibility overlay and a release
 * record's Distribution tab. Off when Distribution is not enabled (the worker would 404).
 */
export function useMatrixOverlay(
  slug: string,
  enabled: boolean,
): UseQueryResult<DistributionMatrix> {
  return useQuery({ ...matrixOverlayQuery(slug), enabled });
}

/** Delivery access per deliverable (Distribution's `dist_access`). */
export const deliveryAccessQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.access(slug),
    queryFn: () => api.deliveryAccess(slug),
  });

export function useDeliveryAccess(
  slug: string,
  enabled: boolean,
): UseQueryResult<DeliveryAccess> {
  return useQuery({ ...deliveryAccessQuery(slug), enabled });
}

/** The simulator inputs as one stable key string (sorted, blanks dropped). */
export function simulateKey(params: SimulateParams): string {
  return Object.entries(params)
    .filter(([, v]) => typeof v === "string" && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v as string}`)
    .join("&");
}

export const simulationQuery = (slug: string, params: SimulateParams) =>
  queryOptions({
    queryKey: qk.simulate(slug, simulateKey(params)),
    queryFn: () => api.simulateUpdate(slug, params),
  });

/** One simulation; runs whenever `params` is set (the submitted inputs in the URL). */
export function useSimulation(
  slug: string,
  params: SimulateParams | null,
): UseQueryResult<SimulateResponse> {
  const p = params ?? { appRelease: "", platform: "" };
  return useQuery({ ...simulationQuery(slug, p), enabled: params !== null });
}
