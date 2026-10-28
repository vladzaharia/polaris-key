/** Cloud Connect's console reads (CC-16.W), one factory each, as `sections/sync/data.ts`. */

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, type ConnectPeoplePage } from "../../../api.js";
import { qk } from "../../data/queries.js";

/** Days shown and totalled. */
export const USAGE_DAYS = 30;
/** Days read: enough to cover the current UTC month, whatever its length. */
export const USAGE_READ_DAYS = 31;

/** People with linked devices, paged by subject; the cursor is the last subject of a page. */
export const connectPeopleQuery = (slug: string) =>
  infiniteQueryOptions({
    queryKey: [...qk.connectPeople(slug), "list"],
    queryFn: ({ pageParam }) => api.connectPeople(slug, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ConnectPeoplePage) =>
      last.enabled ? (last.nextCursor ?? undefined) : undefined,
    retry: false,
  });

export const connectUsageQuery = (slug: string) =>
  queryOptions({
    queryKey: [...qk.connectUsage(slug), USAGE_READ_DAYS],
    queryFn: () => api.connectUsage(slug, USAGE_READ_DAYS),
    retry: false,
  });
