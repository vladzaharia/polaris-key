/**
 * Cloud Sync's catalog reads, shared by the Data page and the Overview tile. Kept apart from the
 * page so the Overview (Core's chunk) does not pull the Cloud Sync chunk in.
 */

import {
  CLOUD_SYNC_CEILINGS,
  syncedSettings,
  type SettingRoute,
} from "@polaris-key/catalog";
import { ApiError, type ProductCatalog } from "../../../api.js";

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

/**
 * The most a product may hold in Cloud Sync, the figure Setup shows ("Each product holds up to…").
 * One place, so the Usage tile and Setup agree; U-05.21 swaps it for the `cloudSync.ceiling.bytes`
 * setting here.
 */
export function productCeilingBytes(): number {
  return CLOUD_SYNC_CEILINGS.perProduct.bytes;
}
