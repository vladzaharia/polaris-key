/**
 * Core's reads (components.md §7): one `queryOptions` factory per key family. A page calls
 * `useQuery(factory(slug))`, spreads it to add `enabled`, `select` or `placeholderData`, or reads
 * imperatively with `queryClient.fetchQuery(factory(slug))`.
 */

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  api,
  type ActivityFilters,
  type ActivityPage,
  type ProductDevicePage,
  type ProductDeviceQuery,
  type ProductUsersPage,
} from "../../../api.js";
import { qk } from "../../data/queries.js";

// core A

/** The product's integration read model (Overview's launch standing, the Integration page). */
export const integrationQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.integration(slug),
    queryFn: () => api.integration(slug),
  });

/** The licence list Overview's tiles count. */
export const licensesQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.licenses(slug),
    queryFn: () => api.licenses(slug),
  });

/** The product's portal settings, as the Overview tile reads them. */
export const portalSettingsQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.portal(slug),
    queryFn: () => api.portalSettings(slug).then((r) => r.settings),
  });

export const deviceSummaryQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.devicesSummary(slug),
    queryFn: () => api.productDeviceSummary(slug),
  });

/** One page of the device table for a server query, paged by cursor. */
export const devicesQuery = (slug: string, query: ProductDeviceQuery) =>
  infiniteQueryOptions({
    queryKey: [...qk.devices(slug), "list", JSON.stringify(query)],
    queryFn: ({ pageParam }) =>
      api.productDevices(slug, { ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ProductDevicePage) => last.nextCursor ?? undefined,
  });

const USERS_PAGE_SIZE = 50;

export const usersQuery = (slug: string, q: string) =>
  infiniteQueryOptions({
    queryKey: [...qk.users(slug), "list", q],
    queryFn: ({ pageParam }) =>
      api.productUsers(slug, {
        ...(q ? { q } : {}),
        limit: USERS_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ProductUsersPage) => last.nextCursor ?? undefined,
  });

export const userQuery = (slug: string, subject: string) =>
  queryOptions({
    queryKey: qk.user(slug, subject),
    queryFn: () => api.productUser(slug, subject),
  });

/** The data-export document of one user (an imperative read: `fetchQuery`). */
export const userExportQuery = (slug: string, subject: string) =>
  queryOptions({
    queryKey: qk.userExport(slug, subject),
    queryFn: () => api.productUserExport(slug, subject),
    staleTime: 0,
    gcTime: 0,
  });

const ACTIVITY_PAGE_SIZE = 50;

/** The activity feed for one filter set, paged by cursor. */
export const activityQuery = (slug: string, filters: ActivityFilters) =>
  infiniteQueryOptions({
    queryKey: [...qk.activity(slug), JSON.stringify(filters)],
    queryFn: ({ pageParam }) =>
      api.activity(slug, pageParam, ACTIVITY_PAGE_SIZE, filters),
    initialPageParam: null as ActivityPage["nextCursor"],
    getNextPageParam: (last: ActivityPage) => last.nextCursor ?? undefined,
  });

export const hostedAssetsQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.hostedAssets(slug),
    queryFn: () => api.hostedAssets(slug).then((r) => r.assets),
  });

export const assetUsageQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.assetUsage(slug),
    queryFn: () => api.assetUsage(slug),
  });
