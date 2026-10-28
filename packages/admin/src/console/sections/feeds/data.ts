/**
 * The Feeds area's queries (F-11). One fetcher per key family (`test/queryFactories.test.ts`),
 * keyed by scope so the platform's and a product's views of one feed are separate entries; the
 * write table (`data/mutations.ts`) invalidates both.
 */

import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import {
  api,
  type FeedEcosystem,
  type FeedPackagesPage,
  type FeedScope,
  type FeedsOverviewDto,
} from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";

export function fetchFeedsOverview(scope: FeedScope) {
  return api.feedsOverview(scope);
}

export const feedsOverviewQuery = (scope: FeedScope) =>
  queryOptions({
    queryKey: qk.pkgFeeds(scope),
    queryFn: () => fetchFeedsOverview(scope),
  });

/** The package-feeds switch (the owner row and its version), shared by the on and off views. */
export const packageFeedsSwitchQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.packageFeedsSwitch(slug),
    queryFn: () => api.packageFeeds(slug),
  });

/** One scope's registry tokens (a licence's, or the product's when `licenseId` is empty). */
export const registryTokensQuery = (scope: FeedScope, licenseId?: string) =>
  queryOptions({
    queryKey: qk.pkgFeedTokens(scope, licenseId ?? ""),
    queryFn: () => api.registryTokens(scope, licenseId),
  });

/** The cleanup setting and its notice (F-36), read for the Packages callout. */
export const feedRetentionQuery = (scope: FeedScope) =>
  queryOptions({
    queryKey: qk.pkgFeedRetention(scope),
    queryFn: () => api.feedRetention(scope),
  });

/** The cleanup dry run (F-38a): a POST that stores nothing, read like a query. */
export const feedPruneQuery = (scope: FeedScope) =>
  queryOptions({
    queryKey: qk.pkgFeedPrune(scope),
    queryFn: () => mutate("previewFeedPrune", scope),
  });

export function useFeedsOverview(
  scope: FeedScope,
  enabled = true,
  /** Re-read on this interval while it returns a number (a feed waiting for its first package). */
  poll?: (data: FeedsOverviewDto | undefined) => number | false,
) {
  return useQuery({
    ...feedsOverviewQuery(scope),
    enabled,
    refetchInterval: poll ? (q) => poll(q.state.data) : false,
  });
}

export function fetchFeedDetail(scope: FeedScope, eco: FeedEcosystem) {
  return api.feedDetail(scope, eco);
}

export const feedDetailQuery = (scope: FeedScope, eco: FeedEcosystem) =>
  queryOptions({
    queryKey: qk.pkgFeed(scope, eco),
    queryFn: () => fetchFeedDetail(scope, eco),
  });

export function useFeedDetail(scope: FeedScope, eco: FeedEcosystem) {
  return useQuery(feedDetailQuery(scope, eco));
}

/** The packages list, a page at a time (`Load more`). */
export const feedPackagesQuery = (
  scope: FeedScope,
  eco: FeedEcosystem,
  q: string,
  owner: string,
) =>
  infiniteQueryOptions<
    FeedPackagesPage,
    Error,
    { pages: FeedPackagesPage[] },
    readonly unknown[],
    string | null
  >({
    queryKey: qk.pkgFeedPackages(scope, eco, q, owner),
    queryFn: ({ pageParam }) =>
      api.feedPackages(scope, eco, { q, owner, cursor: pageParam }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });

export function useFeedPackages(
  scope: FeedScope,
  eco: FeedEcosystem,
  q: string,
  owner: string,
) {
  return useInfiniteQuery(feedPackagesQuery(scope, eco, q, owner));
}

export function fetchFeedPackage(
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
) {
  return api.feedPackage(scope, eco, owner, name);
}

export const feedPackageQuery = (
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
) =>
  queryOptions({
    queryKey: qk.pkgFeedPackage(scope, eco, owner, name),
    queryFn: () => fetchFeedPackage(scope, eco, owner, name),
  });

export function useFeedPackage(
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
) {
  return useQuery(feedPackageQuery(scope, eco, owner, name));
}

export function fetchFeedActivity(scope: FeedScope, eco: FeedEcosystem) {
  return api.feedActivity(scope, eco);
}

export const feedActivityQuery = (scope: FeedScope, eco: FeedEcosystem) =>
  queryOptions({
    queryKey: qk.pkgFeedActivity(scope, eco),
    queryFn: () => fetchFeedActivity(scope, eco),
  });

export function useFeedActivity(scope: FeedScope, eco: FeedEcosystem) {
  return useQuery(feedActivityQuery(scope, eco));
}
