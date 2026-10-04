/**
 * The Feeds area's queries (F-11). One fetcher per key family (`test/queryKeyShapes.test.ts`),
 * keyed by scope so the platform's and a product's views of one feed are separate entries; the
 * write table (`data/mutations.ts`) invalidates both.
 */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  api,
  type FeedEcosystem,
  type FeedPackagesPage,
  type FeedScope,
} from "../../../api.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";

export function fetchFeedsOverview(scope: FeedScope) {
  return api.feedsOverview(scope);
}

export function useFeedsOverview(scope: FeedScope) {
  return useQuery(
    { queryKey: qk.pkgFeeds(scope), queryFn: () => fetchFeedsOverview(scope) },
    queryClient,
  );
}

export function fetchFeedDetail(scope: FeedScope, eco: FeedEcosystem) {
  return api.feedDetail(scope, eco);
}

export function useFeedDetail(scope: FeedScope, eco: FeedEcosystem) {
  return useQuery(
    {
      queryKey: qk.pkgFeed(scope, eco),
      queryFn: () => fetchFeedDetail(scope, eco),
    },
    queryClient,
  );
}

/** The packages list, a page at a time (`Load more`). */
export function useFeedPackages(
  scope: FeedScope,
  eco: FeedEcosystem,
  q: string,
  owner: string,
) {
  return useInfiniteQuery<
    FeedPackagesPage,
    Error,
    { pages: FeedPackagesPage[] },
    readonly unknown[],
    string | null
  >(
    {
      queryKey: qk.pkgFeedPackages(scope, eco, q, owner),
      queryFn: ({ pageParam }) =>
        api.feedPackages(scope, eco, { q, owner, cursor: pageParam }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    },
    queryClient,
  );
}

export function fetchFeedPackage(
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
) {
  return api.feedPackage(scope, eco, owner, name);
}

export function useFeedPackage(
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
) {
  return useQuery(
    {
      queryKey: qk.pkgFeedPackage(scope, eco, owner, name),
      queryFn: () => fetchFeedPackage(scope, eco, owner, name),
    },
    queryClient,
  );
}

export function fetchFeedActivity(scope: FeedScope, eco: FeedEcosystem) {
  return api.feedActivity(scope, eco);
}

export function useFeedActivity(scope: FeedScope, eco: FeedEcosystem) {
  return useQuery(
    {
      queryKey: qk.pkgFeedActivity(scope, eco),
      queryFn: () => fetchFeedActivity(scope, eco),
    },
    queryClient,
  );
}
