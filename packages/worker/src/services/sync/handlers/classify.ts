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
 *   record   a record target (U-09): matched to the catalog's collections by `matchCollection` and
 *            checked in the order of §13.3, see `classifyRecord`.
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
  matchCollection,
  prepareSchema,
  representabilityIssue,
  settingRoute,
  validatePrepared,
  type Catalog,
  type ConfigEntry,
  type SettingRoute,
} from "@polaris-key/catalog";
import {
  SYNC_E2E_OVERHEAD_BYTES,
  SYNC_MAX_RECORD_BYTES,
  SYNC_MAX_SETTINGS_BYTES,
  SYNC_MAX_UNION_ELEMENT_BYTES,
  SYNC_MAX_VALUE_BYTES,
  type SyncEncryptionMode,
  type SyncJson,
  type SyncMutation,
} from "@polaris-key/protocol/sync";
import { resolveKey } from "../engine/migrations.js";
import { envelopeBytes, isBlinded } from "../engine/sealed.js";
import type { CatalogMigrations, Classification } from "../engine/types.js";
import { utf8Length, valueBytes } from "../engine/usage.js";

const NOT_SYNCED: Classification = {
  verdict: "reject",
  code: "setting_not_synced",
};
const MISMATCH: Classification = {
  verdict: "reject",
  code: "encryption_mismatch",
};
const COLLECTION_UNKNOWN: Classification = {
  verdict: "reject",
  code: "collection_unknown",
};
const ENTITLEMENT_REQUIRED: Classification = {
  verdict: "reject",
  code: "entitlement_required",
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
  return propertyInvalid(entry.schema, member, value);
}

/** The same rule for a `merge` record's field, against the collection's schema. */
function propertyInvalid(
  schema: unknown,
  member: string,
  value: unknown,
): boolean {
  const issue = representabilityIssue(value);
  if (issue) return true;
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

/**
 * The sealed value of an end-to-end mutation: a well-shaped envelope (§13.10.4) under the cap.
 * `limit` is the value cap the key's kind carries (8 KiB for an open setting), charged on
 * `envelopeBytes - 113`. Nothing else about the value is checked; the server never decodes it.
 */
function sealedInvalid(m: SyncMutation, limit: number): boolean {
  if (m.op !== "set" && m.op !== "setMember") return false;
  const n = envelopeBytes(m.ct);
  return n === null || n - SYNC_E2E_OVERHEAD_BYTES > limit;
}

/** Whether an entitlement the catalog's `requires` names is granted (a flag set to `true`). */
const granted = (
  entitlements: Readonly<Record<string, unknown>>,
  name: string,
): boolean => Object.hasOwn(entitlements, name) && entitlements[name] === true;

/** The members a `delete` must not carry (§13.3 check 4). */
const DELETE_STRAYS = [
  "value",
  "ct",
  "field",
  "element",
  "observedSeq",
] as const;

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * A record mutation, against the first check that fails, in the order of §13.3. The object adds
 * the checks that read stored state and check 5, the policy's operations.
 *
 *   1  no declaration matches the collection (`matchCollection`): `collection_unknown`
 *   2  the declaration's `requires` is not granted: `entitlement_required` (a `delete` passes)
 *   3  E2E: an id, field or element that is not blinded, or `value` where `ct` is expected, or the
 *      reverse (a `delete` expects neither): `encryption_mismatch`
 *   4  the request-only causes of `value_invalid`, collected into one flag (they share one code,
 *      so their order among themselves is not observable)
 */
function classifyRecord(
  m: SyncMutation,
  catalog: Catalog | null,
  e2e: boolean,
  entitlements: Readonly<Record<string, unknown>>,
): Classification {
  const [collection, id] = (m.target as { record: [string, string] }).record;
  const decl = matchCollection(catalog, collection);
  if (decl === null) return COLLECTION_UNKNOWN;
  if (m.op !== "delete" && decl.requires !== null) {
    if (!granted(entitlements, decl.requires)) return ENTITLEMENT_REQUIRED;
  }
  if (e2e) {
    if (!isBlinded(id)) return MISMATCH;
    if (m.op !== "delete" && "value" in m) return MISMATCH;
    if ((m.op === "setField" || m.op === "removeField") && !isBlinded(m.field))
      return MISMATCH;
    if ((m.op === "add" || m.op === "remove") && !isBlinded(m.element))
      return MISMATCH;
  } else if (m.op !== "delete" && "ct" in m) return MISMATCH;

  let invalid = false;
  // Any mode: the mutation's own members.
  if (
    m.baseVersion !== undefined &&
    m.baseVersion !== "*" &&
    !isCount(m.baseVersion)
  )
    invalid = true;
  if (m.op === "delete") {
    if (DELETE_STRAYS.some((k) => k in m)) invalid = true;
    // An E2E max or min record's delete is decided by `editedHlc` alone (§13.3, the register).
    if (
      e2e &&
      (decl.conflict === "max" || decl.conflict === "min") &&
      m.baseVersion !== undefined
    )
      invalid = true;
  }
  if (m.op === "remove" && !isCount(m.observedSeq)) invalid = true;
  // A field name is client text kept as a cell key, and a removal is never refused for quota, so
  // the name is bounded as a merge setting's member is (SR-1 B1).
  if (
    !e2e &&
    (m.op === "setField" || m.op === "removeField") &&
    (typeof m.field !== "string" ||
      m.field === "" ||
      utf8Length(m.field) > SYNC_MAX_UNION_ELEMENT_BYTES)
  )
    invalid = true;
  if (e2e) {
    // A sealed entry: a well-shaped envelope, charged on `envelopeBytes - 113` (+ 45 for the
    // blinded name of a field or element) against the record's 64 KiB.
    if (m.op === "set" || m.op === "setField" || m.op === "add") {
      const n = envelopeBytes(m.ct);
      const name = m.op === "set" ? 0 : 45;
      if (
        n === null ||
        Math.max(n - SYNC_E2E_OVERHEAD_BYTES, 0) + name > SYNC_MAX_RECORD_BYTES
      )
        invalid = true;
    }
  } else if (m.op === "set") {
    if (
      !("value" in m) ||
      representabilityIssue(m.value) ||
      valueBytes(m.value as SyncJson) > SYNC_MAX_RECORD_BYTES ||
      (decl.schema !== null && failsSchema(decl.schema, m.value))
    )
      invalid = true;
  } else if (m.op === "setField") {
    if (
      !("value" in m) ||
      valueBytes(m.value as SyncJson) > SYNC_MAX_RECORD_BYTES ||
      propertyInvalid(decl.schema, m.field as string, m.value)
    )
      invalid = true;
  } else if (m.op === "add" || m.op === "remove") {
    const el = m.element;
    if (
      !("element" in m) ||
      representabilityIssue(el) ||
      valueBytes(el as SyncJson) > SYNC_MAX_UNION_ELEMENT_BYTES
    )
      invalid = true;
    else if (m.op === "add" && isObject(decl.schema)) {
      const items = decl.schema.items;
      if (isObject(items) && failsSchema(items, el)) invalid = true;
    }
  }
  const field = decl.conflict === "max" || decl.conflict === "min";
  return {
    verdict: "record",
    policy: decl.conflict,
    maxRecords: decl.maxRecords,
    ...(!e2e && field && decl.conflictField !== null
      ? { conflictField: decl.conflictField }
      : {}),
    ...(invalid ? { valueInvalid: true } : {}),
    ...(e2e ? { sealed: true } : {}),
  };
}

/**
 * One classification per mutation, in order. `mode` is the mode the request is served in
 * (`common.ts` `syncMode`): in `e2e` a mutation carries `ct` and blinded names (§13.3, §13.10); in
 * `server` it carries `value`. The wrong one, or a name that would leak, is `encryption_mismatch`.
 */
export function classifyMutations(
  mutations: readonly SyncMutation[],
  catalog: Catalog | null,
  migrations: CatalogMigrations,
  mode: SyncEncryptionMode = "server",
  /** The anchor licence's entitlement values (`syncAccess`), for a collection's `requires`. */
  entitlements: Readonly<Record<string, unknown>> = {},
): Classification[] {
  const declared = declaredKeys(catalog);
  const e2e = mode === "e2e";
  return mutations.map((m): Classification => {
    if (!("setting" in m.target))
      return classifyRecord(m, catalog, e2e, entitlements);
    // The wrong payload for the product's mode, before anything else is looked at.
    if (e2e ? "value" in m : "ct" in m) return MISMATCH;
    const resolved = resolveKey(m.target.setting, migrations);
    if (resolved.kind === "dropped") return NOT_SYNCED;
    const key = resolved.kind === "renamed" ? resolved.to : m.target.setting;
    const route = declared.routes.get(key);
    if (route === undefined) {
      // An open setting's key is a person-chosen name: in E2E it must arrive blinded.
      if (e2e && !isBlinded(m.target.setting)) return MISMATCH;
      return {
        verdict: "accept",
        scope: "user",
        policy: "lastWrite",
        open: true,
        ...(e2e ? { sealed: true } : {}),
        ...((e2e ? sealedInvalid(m, SYNC_MAX_VALUE_BYTES) : openInvalid(m))
          ? { valueInvalid: true }
          : {}),
      };
    }
    if (route.route !== "synced") return NOT_SYNCED;
    const entry = declared.entries.get(key) as ConfigEntry;
    if (e2e) {
      // A merge member's name is a person-chosen name too.
      if (
        (m.op === "setMember" || m.op === "removeMember") &&
        !isBlinded(m.member)
      )
        return MISMATCH;
      return {
        verdict: "accept",
        scope: route.scope,
        policy: route.policy,
        sealed: true,
        ...(sealedInvalid(m, SYNC_MAX_SETTINGS_BYTES)
          ? { valueInvalid: true }
          : {}),
      };
    }
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
