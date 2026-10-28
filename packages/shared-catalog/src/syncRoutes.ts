// The one derivation of a client's setting routes (plans/U-01b.md section 3.1), in a module of its
// own so a host that loads it on demand (the browser's Cloud Sync host) does not drag the rest of
// the Cloud Sync vocabulary into an initial bundle that never syncs.

import { cloudSyncEncryption } from "./cloudSync.js";
import type {
  CloudSyncEncryption,
  ConfigEntry,
  JsonSchema,
  ProductCatalog,
  UserSettingConflict,
} from "./types.js";

/**
 * How a client treats one declared catalog key. `synced`: an Editable `config` key, pushed with
 * its scope and resolved by its policy. `local`: settable, kept on the device, never pushed.
 * `locked`: the catalog locks it (`managementDefault` `enforced` or `hidden`), so `config.set`
 * refuses with `managed_by_admin`. `refused`: a `secret` or `flag`, which `config.set` refuses
 * with `bad_request` while Cloud Sync is on. A key with no route is an open setting (D3).
 */
export type SettingRoute =
  | {
      key: string;
      route: "synced";
      scope: "user" | "platform";
      policy: UserSettingConflict;
      listed: boolean;
      schema?: JsonSchema;
      encryption?: CloudSyncEncryption;
    }
  | {
      key: string;
      route: "local" | "locked" | "refused";
      encryption?: CloudSyncEncryption;
    };

/** Whether a `config` entry is Editable: the catalog sets no `managementDefault` that locks it. */
export function isEditable(
  entry: Pick<ConfigEntry, "managementDefault">,
): boolean {
  return (
    entry.managementDefault !== "enforced" &&
    entry.managementDefault !== "hidden"
  );
}

/** One entry's route (see `syncedSettings`). */
export function settingRoute(entry: ConfigEntry): SettingRoute {
  if (entry.kind !== "config") return { key: entry.key, route: "refused" };
  if (!isEditable(entry)) return { key: entry.key, route: "locked" };
  const user = entry.user ?? {};
  const sync = user.sync ?? "user";
  if (sync === "local") return { key: entry.key, route: "local" };
  return {
    key: entry.key,
    route: "synced",
    scope: sync,
    policy: user.conflict ?? "lastWrite",
    listed: user.listed ?? true,
    ...(entry.schema !== undefined ? { schema: entry.schema } : {}),
  };
}

/**
 * The one derivation of a client's setting routes (§3.1): one route per declared key, in catalog
 * order. The mirrors, the Worker's push classifier, the console and every SDK host call it; the
 * hosts hand the result to `client-core`'s machine as its `SettingRoute[]`, and the SDK ports
 * re-implement it, proven by `sync-scenarios.json`'s `settingCases`.
 */
export function syncedSettings(
  catalog: Pick<ProductCatalog, "entries" | "cloudSync">,
): SettingRoute[] {
  const routes = catalog.entries.map(settingRoute);
  // A caller that hands over the catalog's `cloudSync` block gets the mode on every route; one
  // that hands over entries only gets the routes alone (the `settingCases` shape).
  if (catalog.cloudSync === undefined) return routes;
  const encryption = cloudSyncEncryption(catalog);
  return routes.map((r) => ({ ...r, encryption }));
}
