// Cloud Sync's catalog vocabulary, limits, ceilings, record templates and the one derivation of a
// client's setting routes (plans/U-01b.md §3.1). ONE source of truth: the manifest validator
// (`@polaris-key/manifest`) checks declarations against these, the Worker's settings registry and
// the console import the same constants, and `syncedSettings` is what the mirrors, the Worker's
// push classifier, the console and every SDK host call. Nothing here is product-specific
// (AGENTS rule 5): a product declares its collections in `.pkey/schema`, and its quota is the
// `pkey.cloudSync.bytes` entitlement a tier, a licence or an add-on sets.

import type {
  CloudSyncAccess,
  CloudSyncCollection,
  CloudSyncTemplate,
  ConfigEntry,
  JsonSchema,
  ProductCatalog,
  SyncConflict,
  UserSettingConflict,
  UserSettingSync,
} from "./types.js";

/** `user.sync` values, in the order the docs list them. */
export const USER_SETTING_SYNC_SCOPES: readonly UserSettingSync[] = [
  "user",
  "platform",
  "local",
];

/** `user.conflict` values. `union` and `revision` are record policies (validator rule 4). */
export const USER_SETTING_CONFLICTS: readonly UserSettingConflict[] = [
  "lastWrite",
  "max",
  "min",
  "merge",
];

/** The one conflict vocabulary of both stores (§2.2): a collection's `conflict` is any of these. */
export const SYNC_CONFLICTS: readonly SyncConflict[] = [
  "lastWrite",
  "max",
  "min",
  "merge",
  "union",
  "revision",
];

/** Collection `access` values. Only `owner` in v1 (D7). */
export const CLOUD_SYNC_ACCESS: readonly CloudSyncAccess[] = ["owner"];

/** Record template names. */
export const CLOUD_SYNC_TEMPLATE_NAMES: readonly CloudSyncTemplate[] = [
  "saves",
  "session",
];

/** A Cloud Sync key, record id, slot or collection name (S-17 §5.7). */
export const CLOUD_SYNC_KEY_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";

/** A collection name, or a `prefix.*` pattern of them. */
export const CLOUD_SYNC_COLLECTION_PATTERN =
  "^[A-Za-z0-9._:-]{1,126}(?:\\.\\*)?$";

/** The most top-level members a `merge` setting or collection may declare (rule 5). */
export const CLOUD_SYNC_MAX_MERGE_MEMBERS = 256;

/** The longest canonical JSON of one `union` element, in bytes (rule 6). */
export const CLOUD_SYNC_MAX_UNION_ELEMENT_BYTES = 1024;

/** Save slots per person, a platform constant: no declaration or entitlement raises it (D7). */
export const CLOUD_SYNC_SAVE_SLOTS = 16;

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/**
 * Platform ceilings (S-17 §5.7, owner-confirmed). `perPerson.bytes` clamps every quota a tier, a
 * licence, an add-on or the platform default resolves to; `perPerson.fileBytes` holds every
 * collection's `files.maxBytes` (validator rule 10). `perProduct` are the operator's cost
 * controls: `bytes` is the `cloudSync.ceiling.bytes` setting's default, and `users` and
 * `pushesPerSecond` are constants.
 */
export const CLOUD_SYNC_CEILINGS = {
  perPerson: {
    /** About 1.06 GiB: the owner-confirmed per-person total (settings, records and files). */
    bytes: 256 * KiB + 64 * MiB + 1 * GiB,
    /** One file. */
    fileBytes: 1 * GiB,
  },
  perProduct: {
    bytes: 50 * GiB,
    users: 100_000,
    pushesPerSecond: 2_000,
  },
} as const;

/** The platform's Cloud Sync defaults (D3, D5, D7). */
export const CLOUD_SYNC_DEFAULTS = {
  /** A person's quota when nothing sets `pkey.cloudSync.bytes` (the `cloudSync.quota.defaultBytes`
   *  setting's default). */
  quotaBytes: 256 * MiB,
  /** A signed-in person with no usable licence, on a product with no Anonymous devices tier:
   *  1 MiB, and files are refused. */
  unlicensedQuotaBytes: 1 * MiB,
  /** Declared and open settings share one budget (D3). `maxValueBytes` bounds an open setting. */
  settings: { maxKeys: 256, maxValueBytes: 8 * KiB, maxBytes: 64 * KiB },
  records: { maxRecordBytes: 64 * KiB, maxRecords: 10_000, maxCollections: 32 },
  files: { maxBytes: 32 * MiB, keepRevisions: 5 },
  push: { maxMutations: 100, maxBytes: 256 * KiB, perMinutePerDevice: 60 },
  fileTransfersPerHour: 30,
} as const;

/** The resolved members of a collection: its declaration over its template over the defaults. */
export interface ResolvedCollection {
  name: string;
  label: string;
  template: CloudSyncTemplate | null;
  access: CloudSyncAccess;
  conflict: SyncConflict;
  conflictField: string | null;
  schema: JsonSchema | null;
  maxRecords: number;
  files: { maxBytes: number; keepRevisions: number };
  requires: string | null;
}

/** What a template supplies. */
export interface CloudSyncTemplateDef {
  label: string;
  conflict: SyncConflict;
  maxRecords: number;
  files: { maxBytes: number; keepRevisions: number };
  schema?: JsonSchema;
}

/**
 * The `saves` thumbnail: base64, at most 43,692 characters (32 KiB decoded), so a save's
 * metadata stays inside the 64 KiB record bound and a pull of 16 slots stays near 1 MiB (R3).
 * A thumbnail is a field, not a second file: a record carries one file.
 */
export const CLOUD_SYNC_THUMBNAIL_MAX_CHARS = 4 * Math.ceil((32 * KiB) / 3);

/** The record templates (§3.1, R3). A declaration's own members override these, except a
 *  `saves` collection's `maxRecords`, which is pinned to `CLOUD_SYNC_SAVE_SLOTS`. */
export const CLOUD_SYNC_TEMPLATES: Readonly<
  Record<CloudSyncTemplate, CloudSyncTemplateDef>
> = {
  saves: {
    label: "Saves",
    conflict: "revision",
    maxRecords: CLOUD_SYNC_SAVE_SLOTS,
    files: {
      maxBytes: CLOUD_SYNC_DEFAULTS.files.maxBytes,
      keepRevisions: CLOUD_SYNC_DEFAULTS.files.keepRevisions,
    },
    schema: {
      type: "object",
      properties: {
        playtime: { type: "number", minimum: 0 },
        progress: { type: "number", minimum: 0, maximum: 1 },
        chapter: { type: "string", maxLength: 128 },
        formatVersion: { type: "integer" },
        thumbnail: {
          type: "string",
          contentEncoding: "base64",
          maxLength: CLOUD_SYNC_THUMBNAIL_MAX_CHARS,
        },
      },
    },
  },
  session: {
    label: "Session",
    conflict: "lastWrite",
    maxRecords: 16,
    files: { maxBytes: 8 * MiB, keepRevisions: 1 },
  },
};

/** A collection's effective members (the declaration over its template over the defaults). */
export function resolveCollection(c: CloudSyncCollection): ResolvedCollection {
  const t = c.template ? CLOUD_SYNC_TEMPLATES[c.template] : undefined;
  return {
    name: c.name,
    label: c.label ?? t?.label ?? c.name,
    template: c.template ?? null,
    access: c.access ?? "owner",
    conflict: c.conflict ?? t?.conflict ?? "revision",
    conflictField: c.conflictField ?? null,
    schema: c.schema ?? t?.schema ?? null,
    maxRecords:
      c.template === "saves"
        ? CLOUD_SYNC_SAVE_SLOTS
        : (c.maxRecords ??
          t?.maxRecords ??
          CLOUD_SYNC_DEFAULTS.records.maxRecords),
    files: {
      maxBytes:
        c.files?.maxBytes ??
        t?.files.maxBytes ??
        CLOUD_SYNC_DEFAULTS.files.maxBytes,
      keepRevisions:
        c.files?.keepRevisions ??
        t?.files.keepRevisions ??
        CLOUD_SYNC_DEFAULTS.files.keepRevisions,
    },
    requires: c.requires ?? null,
  };
}

// ── Setting routes (§2.5, §3.1) ─────────────────────────────────────────────────────────────

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
    }
  | { key: string; route: "local" | "locked" | "refused" };

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
  catalog: Pick<ProductCatalog, "entries">,
): SettingRoute[] {
  return catalog.entries.map(settingRoute);
}

// ── The `user` block rules (shape, 1–5), shared by every checker ─────────────────────────────

/** One problem with a config entry's `user` block. `at` says where it points: the block itself,
 *  one of its members, or the entry's schema (rule 5). Codes are the manifest validator's. A
 *  `warning` never blocks a publish: rule 2's block on a locked key is a no-op. */
export interface UserSettingIssue {
  code:
    | "invalid_user_setting"
    | "user_setting_wrong_kind"
    | "user_setting_locked_default"
    | "user_conflict_type_mismatch"
    | "user_conflict_union"
    | "merge_members_over_limit";
  severity: "error" | "warning";
  at:
    | "user"
    | "user.sync"
    | "user.conflict"
    | "user.listed"
    | "schema"
    | `user.${string}`;
  message: string;
}

const USER_BLOCK_MEMBERS = new Set(["sync", "conflict", "listed"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T =>
  typeof v === "string" && (values as readonly string[]).includes(v);

function schemaTypeIn(
  schema: Record<string, unknown>,
  types: readonly string[],
): boolean {
  const t = schema.type;
  if (typeof t === "string") return types.includes(t);
  if (Array.isArray(t) && t.length > 0)
    return t.every((v) => typeof v === "string" && types.includes(v));
  return false;
}

/** Rule 5: a `merge` value (a setting or a collection's record) merges at most
 *  `CLOUD_SYNC_MAX_MERGE_MEMBERS` top-level members, by `maxProperties` and declared properties. */
export function mergeMembersOverLimit(
  schema: Record<string, unknown>,
): boolean {
  const max = schema.maxProperties;
  const declared = isPlainObject(schema.properties)
    ? Object.keys(schema.properties).length
    : 0;
  return (
    (typeof max === "number" && max > CLOUD_SYNC_MAX_MERGE_MEMBERS) ||
    declared > CLOUD_SYNC_MAX_MERGE_MEMBERS
  );
}

/**
 * Every problem with `entry.user` (S-17 §5.3 rules 1–5 and the block's shape), or `[]` when the
 * entry has no `user` block or a valid one. The manifest validator, the Worker's catalog publish
 * and the console's catalog editor all call this, so a draft the console accepts publishes. Only
 * `severity: "error"` issues block; rule 2 is a warning.
 */
export function userSettingIssues(
  entry: Record<string, unknown>,
): UserSettingIssue[] {
  const user = entry.user;
  if (user === undefined) return [];
  const out: UserSettingIssue[] = [];
  const error = (
    code: UserSettingIssue["code"],
    at: UserSettingIssue["at"],
    message: string,
  ): void => {
    out.push({ code, severity: "error", at, message });
  };
  if (!isPlainObject(user)) {
    error(
      "invalid_user_setting",
      "user",
      "user must be an object with optional sync (user, platform or local), conflict and listed.",
    );
    return out;
  }
  for (const member of Object.keys(user)) {
    if (!USER_BLOCK_MEMBERS.has(member))
      error(
        "invalid_user_setting",
        `user.${member}`,
        `user.${member} is not a synced-setting member (sync, conflict, listed).`,
      );
  }
  if (user.sync === "device")
    error(
      "invalid_user_setting",
      "user.sync",
      "user.sync device is retired: a reinstall gets a new device id, so the value could not survive it. Use local to keep a value on the device.",
    );
  else if (
    user.sync !== undefined &&
    !oneOf(user.sync, USER_SETTING_SYNC_SCOPES)
  )
    error(
      "invalid_user_setting",
      "user.sync",
      "user.sync must be user, platform or local.",
    );
  if (user.listed !== undefined && typeof user.listed !== "boolean")
    error(
      "invalid_user_setting",
      "user.listed",
      "user.listed must be a boolean.",
    );
  // Rule 4: a setting that holds a set is an object of booleans with `conflict: merge`.
  if (user.conflict === "union") {
    error(
      "user_conflict_union",
      "user.conflict",
      "user.conflict cannot be union; hold a set as an object of booleans with conflict: merge.",
    );
  } else if (
    user.conflict !== undefined &&
    !oneOf(user.conflict, USER_SETTING_CONFLICTS)
  ) {
    error(
      "invalid_user_setting",
      "user.conflict",
      "user.conflict must be lastWrite, max, min or merge.",
    );
  }
  // Rule 1: only a config key is a setting a person chooses.
  if (entry.kind !== "config")
    error(
      "user_setting_wrong_kind",
      "user",
      "user is only valid on config entries.",
    );
  // Rule 2: a value the operator locks is not the person's to choose, so the block does nothing.
  if (
    entry.managementDefault === "enforced" ||
    entry.managementDefault === "hidden"
  )
    out.push({
      code: "user_setting_locked_default",
      severity: "warning",
      at: "user",
      message:
        "user has no effect on a key whose managementDefault is enforced or hidden: the key is locked, so it never syncs.",
    });
  const schema = isPlainObject(entry.schema) ? entry.schema : {};
  // Rule 3: `max`/`min` compare numbers; `merge` merges an object's members.
  if (
    (user.conflict === "max" || user.conflict === "min") &&
    !schemaTypeIn(schema, ["number", "integer"])
  )
    error(
      "user_conflict_type_mismatch",
      "user.conflict",
      `user.conflict ${String(user.conflict)} needs a number schema.`,
    );
  if (user.conflict === "merge") {
    if (!schemaTypeIn(schema, ["object"])) {
      error(
        "user_conflict_type_mismatch",
        "user.conflict",
        "user.conflict merge needs an object schema; a set is an object of booleans.",
      );
    } else if (mergeMembersOverLimit(schema)) {
      error(
        "merge_members_over_limit",
        "schema",
        `A merged value has at most ${CLOUD_SYNC_MAX_MERGE_MEMBERS} top-level members (maxProperties and declared properties).`,
      );
    }
  }
  return out;
}
