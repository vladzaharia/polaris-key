/**
 * What the Worker decides about each mutation before the object sees it (U-05.13;
 * WIRE-CONTRACT-V4 §13.3). The object decides nothing about the catalog; it applies the
 * `Classification` it is handed, parallel to the batch.
 *
 * ── THE FIVE ANSWERS ─────────────────────────────────────────────────────────────────────────
 *
 *   synced   an Editable `config` key: accepted with the route's scope and policy, its value (or a
 *            merge member's value) checked against the entry's schema (`valueInvalid`).
 *   open     an undeclared key: accepted as a schema-less `lastWrite` setting at scope `user`,
 *            its value at most 8 KiB of canonical JSON (`valueInvalid` beyond; a value no signed
 *            document could carry is `valueInvalid` too).
 *   local, locked, refused, or any non-`config` kind: `setting_not_synced`. The client never sends
 *            one; this is the backstop.
 *   record   a record target: `collection_unknown` until U-09 declares collections.
 *   dropped  a key the catalog's migrations dropped: classified `setting_not_synced`, but the
 *            engine answers `dropped: true` first and never reads it.
 *
 * The scope is the engine's to compare (`target.scope !== route.scope` is `setting_not_synced`), so
 * a synced key pushed under another scope, and an open key pushed with `platform`, are refused
 * there. The platform family a `platform` row lands in is the DEVICE ROW's (`platformFamily`), sent
 * by the handler; a request never names one.
 *
 * A key is classified AFTER the catalog's rename: an old build's key is judged as its new name.
 * The catalog's key map is a `Map`, so a key named `__proto__` is just an undeclared key.
 */

import {
  prepareSchema,
  representabilityIssue,
  settingRoute,
  validatePrepared,
  type Catalog,
  type ConfigEntry,
  type SettingRoute,
} from "@polaris-key/catalog";
import {
  SYNC_MAX_VALUE_BYTES,
  type SyncJson,
  type SyncMutation,
} from "@polaris-key/protocol/sync";
import { resolveKey } from "../engine/migrations.js";
import type { CatalogMigrations, Classification } from "../engine/types.js";
import { valueBytes } from "../engine/usage.js";

const NOT_SYNCED: Classification = {
  verdict: "reject",
  code: "setting_not_synced",
};
const COLLECTION_UNKNOWN: Classification = {
  verdict: "reject",
  code: "collection_unknown",
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The catalog's declared keys: entry and route, by key. Empty for a product with no catalog. */
export interface DeclaredKeys {
  entries: ReadonlyMap<string, ConfigEntry>;
  routes: ReadonlyMap<string, SettingRoute>;
}

export function declaredKeys(catalog: Catalog | null): DeclaredKeys {
  const entries = new Map<string, ConfigEntry>();
  const routes = new Map<string, SettingRoute>();
  for (const entry of catalog?.entries ?? []) {
    entries.set(entry.key, entry);
    routes.set(entry.key, settingRoute(entry));
  }
  return { entries, routes };
}

/** True when `value` fails `schema` (a schema that cannot be interpreted refuses everything). */
function failsSchema(schema: unknown, value: unknown): boolean {
  try {
    return validatePrepared(prepareSchema(schema), value).length > 0;
  } catch {
    return true;
  }
}

/**
 * A merge member's value, against the entry's schema for that member: its `properties` entry,
 * else a schema-valued `additionalProperties`; `additionalProperties: false` admits no other
 * member; otherwise the schema says nothing about it.
 */
function memberInvalid(entry: ConfigEntry, member: string, value: unknown) {
  const issue = representabilityIssue(value);
  if (issue) return true;
  const schema: unknown = entry.schema;
  if (!isObject(schema)) return false;
  const props = schema.properties;
  if (isObject(props) && Object.hasOwn(props, member))
    return failsSchema(props[member], value);
  const extra = schema.additionalProperties;
  if (extra === false) return true;
  if (isObject(extra)) return failsSchema(extra, value);
  return false;
}

function syncedInvalid(
  catalog: Catalog,
  entry: ConfigEntry,
  m: SyncMutation,
): boolean {
  if (m.op === "set") return !catalog.validateEntryValue(entry, m.value).ok;
  if (m.op === "setMember")
    return memberInvalid(entry, m.member as string, m.value);
  return false;
}

function openInvalid(m: SyncMutation): boolean {
  if (m.op !== "set") return false;
  if (representabilityIssue(m.value)) return true;
  return valueBytes(m.value as SyncJson) > SYNC_MAX_VALUE_BYTES;
}

/** One classification per mutation, in order. */
export function classifyMutations(
  mutations: readonly SyncMutation[],
  catalog: Catalog | null,
  migrations: CatalogMigrations,
): Classification[] {
  const declared = declaredKeys(catalog);
  return mutations.map((m): Classification => {
    if (!("setting" in m.target)) return COLLECTION_UNKNOWN;
    const resolved = resolveKey(m.target.setting, migrations);
    if (resolved.kind === "dropped") return NOT_SYNCED;
    const key = resolved.kind === "renamed" ? resolved.to : m.target.setting;
    const route = declared.routes.get(key);
    if (route === undefined)
      return {
        verdict: "accept",
        scope: "user",
        policy: "lastWrite",
        open: true,
        ...(openInvalid(m) ? { valueInvalid: true } : {}),
      };
    if (route.route !== "synced") return NOT_SYNCED;
    const entry = declared.entries.get(key) as ConfigEntry;
    return {
      verdict: "accept",
      scope: route.scope,
      policy: route.policy,
      ...(catalog && syncedInvalid(catalog, entry, m)
        ? { valueInvalid: true }
        : {}),
    };
  });
}
