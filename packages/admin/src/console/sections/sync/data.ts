/**
 * Cloud Sync's catalog reads, shared by the Data page and the Overview tile. Kept apart from the
 * page so the Overview (Core's chunk) does not pull the Cloud Sync chunk in.
 */

import { syncedSettings, type SettingRoute } from "@polaris-key/catalog";
import {
  useQuery,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ProductCatalog,
  type SyncUsageResponse,
} from "../../../api.js";

/** One synced setting's route (plans/U-01b.md §2.5): its scope, policy and whether it is listed. */
export type SyncedSettingRow = Extract<SettingRoute, { route: "synced" }>;

/**
 * The catalog's synced settings, in catalog order: every Editable `config` key, with or without a
 * `user` block (plans/U-01b.md D2), read through the one derivation every client uses
 * (`syncedSettings`). Keys routed `local`, locked keys, secrets and flags are not among them.
 */
export function userSettings(
  catalog: ProductCatalog | null,
): SyncedSettingRow[] {
  return syncedSettings({ entries: catalog?.entries ?? [] }).filter(
    (r): r is SyncedSettingRow => r.route === "synced",
  );
}

/** Whether the catalog declares a collection on the `saves` template. */
export function declaresSaves(catalog: ProductCatalog | null): boolean {
  return (catalog?.cloudSync?.collections ?? []).some(
    (c) => c.template === "saves",
  );
}

/** The catalog route answers 404 before the first publish: nothing is declared yet. */
export const noCatalog = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 404;

/** The Editable keys that stay on each device (`user.sync: "local"`), in catalog order. */
export function localSettings(catalog: ProductCatalog | null): string[] {
  return syncedSettings({ entries: catalog?.entries ?? [] })
    .filter((r) => r.route === "local")
    .map((r) => r.key);
}

/** The key of the usage read (`GET …/sync/usage`); under the product's Cloud Sync area. */
export const syncUsageKey = (slug: string): QueryKey => [
  "product",
  slug,
  "sync",
  "usage",
];

/** The Cloud Sync usage read: tiers with their bytes, the default, and the aggregate. */
export function useSyncUsage(slug: string): UseQueryResult<SyncUsageResponse> {
  return useQuery({
    queryKey: syncUsageKey(slug),
    queryFn: () => api.syncUsage(slug),
    retry: false,
  });
}
