/**
 * Cloud Sync's catalog reads, shared by the Data page and the Overview tile. Kept apart from the
 * page so the Overview (Core's chunk) does not pull the Cloud Sync chunk in.
 */

import {
  CLOUD_SYNC_CEILINGS,
  syncedSettings,
  type SettingRoute,
} from "@polaris-key/catalog";
import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "../../data/queries.js";
import { reads } from "../../data/reads.js";
import {
  api,
  HttpError,
  type ProductCatalog,
  type ProductSetting,
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
  e instanceof HttpError && e.status === 404;

/** The Editable keys that stay on each device (`user.sync: "local"`), in catalog order. */
export function localSettings(catalog: ProductCatalog | null): string[] {
  return syncedSettings({ entries: catalog?.entries ?? [] })
    .filter((r) => r.route === "local")
    .map((r) => r.key);
}

export const syncUsageQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.syncUsage(slug),
    queryFn: () => api.syncUsage(slug),
    retry: false,
  });

/** The Cloud Sync usage read: tiers with their bytes, the default, and the aggregate. */
export function useSyncUsage(slug: string): UseQueryResult<SyncUsageResponse> {
  return useQuery(syncUsageQuery(slug));
}

/**
 * One person's Cloud Sync data (the user record's Data tab; U-11a). The server audits every load,
 * so a refocused window does not read it again; it is read again after the tab is left for a
 * minute, and after a write that empties the person's data.
 */
export const syncSubjectQuery = (slug: string, subject: string) =>
  queryOptions({
    queryKey: qk.syncSubject(slug, subject),
    queryFn: () => api.syncSubject(slug, subject),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

/** The area the product's Cloud Sync limits are listed under (`cloudSync.ceiling.bytes`). */
export const CEILING_AREA = "cloudSync.limits";

/** The product's limits settings (one read, shared by Setup and the Usage tab). */
export function useProductCeilingSetting(
  slug: string,
): UseQueryResult<{ settings: ProductSetting[] }> {
  const area = CEILING_AREA;
  return useQuery({ ...reads.productSettings(slug, area), retry: false });
}

/**
 * The most a product may hold in Cloud Sync: the value of the `cloudSync.ceiling.bytes` setting
 * (the platform default until the operator sets one), so the Usage tile and Setup agree. The
 * catalog's default while the setting has not loaded.
 */
export function useProductCeilingBytes(slug: string): number {
  const read = useProductCeilingSetting(slug);
  const row = read.data?.settings.find(
    (x) => x.key === "cloudSync.ceiling.bytes",
  );
  const value = Number(row?.value);
  return row && Number.isFinite(value)
    ? value
    : CLOUD_SYNC_CEILINGS.perProduct.bytes;
}
