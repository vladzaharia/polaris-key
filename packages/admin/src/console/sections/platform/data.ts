/**
 * The Platform section's reads: one `queryOptions` factory per key family (components.md §7).
 * Reads another section shares (settings, operations, connections) are in `data/reads.ts`.
 */

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  api,
  type PlatformActivityFilters,
  type PlatformActivityItem,
  type PlatformCursor,
  type PlatformStore,
  type PlatformStoreApps,
} from "../../../api.js";
import { qk } from "../../data/queries.js";

export function fetchPlatformDeployment(cursor?: PlatformCursor | null) {
  return api.platformDeployment(cursor);
}

export function fetchPlatformActivity() {
  return api.platformActivity();
}

export function fetchPlatformStores() {
  return api.platformStoreConnections().then((r) => r.stores);
}

/**
 * One store's apps. A Re-check marks the next fetch of that store as a refresh (`?refresh=1`),
 * so the store is read again and the result lands in the same cache entry and states.
 */
const refreshNext = new Set<string>();

const storeAppsKey = (store: PlatformStore, tracks: boolean): string =>
  `${store}:${tracks ? "tracks" : "plain"}`;

export function markStoreRefresh(store: PlatformStore, tracks: boolean): void {
  refreshNext.add(storeAppsKey(store, tracks));
}

export function fetchPlatformStoreApps(
  store: PlatformStore,
  tracks: boolean,
): Promise<PlatformStoreApps> {
  const refresh = refreshNext.delete(storeAppsKey(store, tracks));
  return api.platformStoreApps(store, { refresh, tracks });
}

const SETTING_ACTIONS = new Set([
  "platform.setting.set",
  "platform.setting.revert",
]);

export interface HistoryPage {
  items: PlatformActivityItem[];
  nextCursor: PlatformCursor | null;
}

/** Pages read per fetch before showing what was found: the trail holds other actions too. */
const HISTORY_PAGE_BUDGET = 5;
const HISTORY_TARGET = 10;

/** The settings writes of the platform trail, from `cursor` on, filtered client-side. */
export async function fetchSettingsHistory(
  cursor: PlatformCursor | null = null,
): Promise<HistoryPage> {
  const items: PlatformActivityItem[] = [];
  let next = cursor;
  for (let i = 0; i < HISTORY_PAGE_BUDGET; i++) {
    const page = await api.platformActivity(next);
    items.push(...page.items.filter((a) => SETTING_ACTIONS.has(a.action)));
    next = page.nextCursor;
    if (!next || items.length >= HISTORY_TARGET) break;
  }
  return { items, nextCursor: next };
}

export function fetchPlatformKek() {
  return api.platformKek();
}

export function fetchPlatformReservedNames() {
  return api.platformReservedNames();
}

export function fetchConnectionTestResult(state: string, draftId: string) {
  return api.connectionTestResult(state, draftId);
}

export const platformReads = {
  stores: () =>
    queryOptions({
      queryKey: qk.platformStores(),
      queryFn: fetchPlatformStores,
    }),
  storeApps: (store: PlatformStore, tracks: boolean) =>
    queryOptions({
      queryKey: qk.platformStoreApps(store, tracks),
      queryFn: () => fetchPlatformStoreApps(store, tracks),
    }),
  activityFeed: (filters: PlatformActivityFilters, pageSize: number) =>
    infiniteQueryOptions({
      queryKey: qk.platformActivityFeed(JSON.stringify(filters)),
      queryFn: ({ pageParam }) =>
        api.platformActivity(pageParam, filters, pageSize),
      initialPageParam: null as PlatformCursor | null,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  activityEvent: (id: string | undefined) =>
    queryOptions({
      queryKey: qk.platformActivityEvent(id ?? ""),
      queryFn: () => api.platformActivity(null, { product: "all", id }, 1),
    }),
  connection: (id: string) =>
    queryOptions({
      queryKey: qk.platformConnection(id),
      queryFn: () => api.platformConnection(id).then((x) => x.connection),
    }),
  settingsHistory: () =>
    queryOptions({
      queryKey: qk.platformSettingsHistory(),
      queryFn: () => fetchSettingsHistory(null),
    }),
  kek: () =>
    queryOptions({ queryKey: qk.platformKek(), queryFn: fetchPlatformKek }),
  reservedNames: () =>
    queryOptions({
      queryKey: qk.platformReservedNames(),
      queryFn: fetchPlatformReservedNames,
    }),
  reach: (key: string, value: number | undefined) =>
    queryOptions({
      queryKey: qk.platformReach(key, value),
      queryFn: () => api.platformSettingReach(key, value),
    }),
  deployment: () =>
    queryOptions({
      queryKey: qk.platformDeployment(),
      queryFn: () => fetchPlatformDeployment(),
    }),
  members: () =>
    queryOptions({ queryKey: qk.members(), queryFn: () => api.members() }),
  accessRules: () =>
    queryOptions({
      queryKey: qk.accessRules(),
      queryFn: () => api.accessRules(),
    }),
};
