/**
 * Cloud Sync's catalog reads, shared by the Data page and the Overview tile. Kept apart from the
 * page so the Overview (Core's chunk) does not pull the Cloud Sync chunk in.
 */

import { syncedSettings, type SettingRoute } from "@polaris-key/catalog";
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
