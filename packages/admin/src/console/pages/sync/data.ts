/**
 * Cloud Sync's catalog reads, shared by the Data page and the Overview tile. Kept apart from the
 * page so the Overview (Core's chunk) does not pull the Cloud Sync chunk in.
 */

import type { ConfigEntry } from "@polaris-key/catalog";
import { ApiError, type ProductCatalog } from "../../../api.js";

export type UserSettingEntry = ConfigEntry & {
  user: NonNullable<ConfigEntry["user"]>;
};

/** The catalog's user settings (`config` entries with a `user` block), in catalog order. */
export function userSettings(
  catalog: ProductCatalog | null,
): UserSettingEntry[] {
  return (catalog?.entries ?? []).filter(
    (e): e is UserSettingEntry => e.kind === "config" && e.user !== undefined,
  );
}

/** The catalog route answers 404 before the first publish: nothing is declared yet. */
export const noCatalog = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 404;
