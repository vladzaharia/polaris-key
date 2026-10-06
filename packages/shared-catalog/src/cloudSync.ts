// Cloud Sync's catalog vocabulary, limits and platform ceilings (S-17 §5.3, §5.7; plans/U-01.md
// §3, §6.5). ONE source of truth: the manifest validator (`@polaris-key/manifest`) checks
// declarations against these, the Worker's settings registry imports the same constants (U-05),
// and `tools/gen-mirrors.ts` reads the `user` vocabulary. Nothing here is product-specific
// (AGENTS rule 5): a product declares its own limits in `.pkey/product` `cloudSync`, and these
// are only the defaults and the ceilings those declarations are clamped by.

import type {
  CloudSyncAccess,
  CollectionConflict,
  CollectionOnAttach,
  SaveConflictPolicy,
  UserSettingConflict,
  UserSettingSync,
} from "./types.js";

/** `user.sync` values, in the order the docs list them. */
export const USER_SETTING_SYNC_SCOPES: readonly UserSettingSync[] = [
  "user",
  "platform",
  "device",
  "local",
];

/** `user.conflict` values. `union` is deliberately absent (validator rule 4). */
export const USER_SETTING_CONFLICTS: readonly UserSettingConflict[] = [
  "lastWrite",
  "max",
  "min",
  "merge",
];

/** Collection `access` values. `public` is reserved for U-17 and refused until then. */
export const CLOUD_SYNC_ACCESS: readonly CloudSyncAccess[] = [
  "owner",
  "ownerRead",
  "server",
];

/** Collection `conflict` values. */
export const COLLECTION_CONFLICTS: readonly CollectionConflict[] = [
  "revision",
  "lastWrite",
  "merge",
  "union",
];

/** Collection `onAttach` values. */
export const COLLECTION_ON_ATTACH: readonly CollectionOnAttach[] = [
  "keepCloud",
  "keepLocal",
  "merge",
  "prompt",
];

/** Save `conflict` values. */
export const SAVE_CONFLICT_POLICIES: readonly SaveConflictPolicy[] = [
  "prompt",
  "mostRecent",
  "longestPlaytime",
  "highestProgress",
];

/** Device trust levels `cloudSync.writes.minTrust` may require (Core's `deviceTrust.ts`). */
export const CLOUD_SYNC_TRUST_LEVELS = ["basic", "attested"] as const;

/** A Cloud Sync key, record id, slot or collection name (S-17 §5.7). */
export const CLOUD_SYNC_KEY_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";

/** A collection name, or a `prefix.*` pattern of them. */
export const CLOUD_SYNC_COLLECTION_PATTERN =
  "^[A-Za-z0-9._:-]{1,126}(?:\\.\\*)?$";

/** The most top-level members a `merge` setting or collection may declare (rule 5). */
export const CLOUD_SYNC_MAX_MERGE_MEMBERS = 256;

/** The longest canonical JSON of one `union` element, in bytes (rule 6). */
export const CLOUD_SYNC_MAX_UNION_ELEMENT_BYTES = 1024;

/** Save-slot limits. */
export interface CloudSyncSaveLimits {
  slots?: number;
  /** Per slot, compressed. */
  maxBytes?: number;
  keepRevisions?: number;
}

/** Per-person limits (a product's `cloudSync.limits`, a `byTier` entry, `unlicensed.limits`). */
export interface CloudSyncLimits {
  /** All Cloud Sync data of one person on the product. */
  totalBytes?: number;
  /** User settings. */
  settingsBytes?: number;
  /** Records across every collection. */
  records?: number;
  /** Record bytes across every collection. */
  collectionBytes?: number;
  saves?: CloudSyncSaveLimits;
}

/** `cloudSync.limits` in `.pkey/product`: the licensed limits, plus raises by tier and by a
 *  numeric entitlement (S-19 decision 19, `combine: max`). */
export interface CloudSyncProductLimits extends CloudSyncLimits {
  /** Tier id → limits; the tier of the highest-`rank` contributing licence applies. */
  byTier?: Record<string, CloudSyncLimits>;
  /** Limit → the numeric catalog flag that raises it (e.g. `sync.storageBytes`). */
  byEntitlement?: { totalBytes?: string; saveSlots?: string };
}

/** `.pkey/product`'s `cloudSync` block — limits and access policy, persisted as claimable
 *  `product_settings` rows through the settings registry (plans/U-01.md §3, Q5). */
export interface CloudSyncProductSettings {
  limits?: CloudSyncProductLimits;
  /** Signed-in people with no usable licence for the product. Saves are off unless `saves`. */
  unlicensed?: { limits?: CloudSyncLimits; saves?: boolean };
  writes?: {
    requireLicense?: boolean;
    minTrust?: (typeof CLOUD_SYNC_TRUST_LEVELS)[number] | null;
  };
}

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/**
 * Platform ceilings (S-17 §5.7, owner-confirmed). A product's declared limits — licensed, by
 * tier, and unlicensed — may never exceed `perPerson` (validator rule 10). `perProduct` are the
 * operator's cost controls, set per product in the console, never by `.pkey/`.
 */
export const CLOUD_SYNC_CEILINGS = {
  perPerson: {
    settingsBytes: 256 * KiB,
    collectionBytes: 64 * MiB,
    /** One record. */
    recordBytes: 1 * MiB,
    /** All saves of one person, and so also any one slot. */
    saveBytes: 1 * GiB,
    totalBytes: 256 * KiB + 64 * MiB + 1 * GiB,
  },
  perProduct: {
    bytes: 50 * GiB,
    users: 100_000,
    pushesPerSecond: 2_000,
  },
} as const;

/** The licensed and unlicensed per-person defaults (S-17 §5.7; plans/U-01.md §6.5). */
export const CLOUD_SYNC_DEFAULTS = {
  licensed: {
    totalBytes: 256 * MiB,
    settingsBytes: 64 * KiB,
    records: 10_000,
    collectionBytes: 5 * MiB,
    saves: { slots: 16, maxBytes: 32 * MiB, keepRevisions: 5 },
  },
  unlicensed: {
    totalBytes: 1 * MiB,
    settingsBytes: 64 * KiB,
    records: 1_000,
    collectionBytes: 512 * KiB,
    saves: { slots: 1, maxBytes: 8 * MiB, keepRevisions: 1 },
  },
  /** Saves are off for an unlicensed person unless the product sets `unlicensed.saves`. */
  unlicensedSaves: false,
  settings: { maxKeys: 256, maxValueBytes: 8 * KiB },
  collections: { maxDeclared: 32, maxRecordBytes: 64 * KiB },
  push: { maxMutations: 100, maxBytes: 256 * KiB, perMinutePerDevice: 60 },
  saveTransfersPerHour: 30,
} as const satisfies {
  licensed: Required<CloudSyncLimits>;
  unlicensed: Required<CloudSyncLimits>;
  [k: string]: unknown;
};

/** The byte- and count-valued members of `CloudSyncLimits`, with the ceiling each is held to
 *  (`null`: no platform ceiling beyond the byte limits). Saves are listed separately. */
export const CLOUD_SYNC_LIMIT_MEMBERS: readonly {
  member: Exclude<keyof CloudSyncLimits, "saves">;
  ceiling: number | null;
}[] = [
  { member: "totalBytes", ceiling: CLOUD_SYNC_CEILINGS.perPerson.totalBytes },
  {
    member: "settingsBytes",
    ceiling: CLOUD_SYNC_CEILINGS.perPerson.settingsBytes,
  },
  { member: "records", ceiling: null },
  {
    member: "collectionBytes",
    ceiling: CLOUD_SYNC_CEILINGS.perPerson.collectionBytes,
  },
];

/** The save members of `CloudSyncSaveLimits`, with their ceilings. */
export const CLOUD_SYNC_SAVE_LIMIT_MEMBERS: readonly {
  member: keyof CloudSyncSaveLimits;
  ceiling: number | null;
}[] = [
  { member: "slots", ceiling: null },
  { member: "maxBytes", ceiling: CLOUD_SYNC_CEILINGS.perPerson.saveBytes },
  { member: "keepRevisions", ceiling: null },
];

// ── The `user` block rules (shape, 1–5), shared by every checker ─────────────────────────────

/** One problem with a config entry's `user` block. `at` says where it points: the block itself,
 *  one of its members, or the entry's schema (rule 5). Codes are the manifest validator's. */
export interface UserSettingIssue {
  code:
    | "invalid_user_setting"
    | "user_setting_wrong_kind"
    | "user_setting_locked_default"
    | "user_conflict_type_mismatch"
    | "user_conflict_union"
    | "merge_members_over_limit";
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
 * and the console's catalog editor all call this, so a draft the console accepts publishes.
 */
export function userSettingIssues(
  entry: Record<string, unknown>,
): UserSettingIssue[] {
  const user = entry.user;
  if (user === undefined) return [];
  const out: UserSettingIssue[] = [];
  if (!isPlainObject(user)) {
    out.push({
      code: "invalid_user_setting",
      at: "user",
      message:
        "user must be an object with sync (user, platform, device or local), and optionally conflict and listed.",
    });
    return out;
  }
  for (const member of Object.keys(user)) {
    if (!USER_BLOCK_MEMBERS.has(member))
      out.push({
        code: "invalid_user_setting",
        at: `user.${member}`,
        message: `user.${member} is not a user-setting member (sync, conflict, listed).`,
      });
  }
  if (!oneOf(user.sync, USER_SETTING_SYNC_SCOPES))
    out.push({
      code: "invalid_user_setting",
      at: "user.sync",
      message:
        "user.sync is required and must be user, platform, device or local.",
    });
  if (user.listed !== undefined && typeof user.listed !== "boolean")
    out.push({
      code: "invalid_user_setting",
      at: "user.listed",
      message: "user.listed must be a boolean.",
    });
  // Rule 4: a setting that holds a set is an object of booleans with `conflict: merge`.
  if (user.conflict === "union") {
    out.push({
      code: "user_conflict_union",
      at: "user.conflict",
      message:
        "user.conflict cannot be union; hold a set as an object of booleans with conflict: merge.",
    });
  } else if (
    user.conflict !== undefined &&
    !oneOf(user.conflict, USER_SETTING_CONFLICTS)
  ) {
    out.push({
      code: "invalid_user_setting",
      at: "user.conflict",
      message: "user.conflict must be lastWrite, max, min or merge.",
    });
  }
  // Rule 1: only a config key is a setting a person chooses.
  if (entry.kind !== "config")
    out.push({
      code: "user_setting_wrong_kind",
      at: "user",
      message: "user is only valid on config entries.",
    });
  // Rule 2: a value the operator locks is not the person's to choose.
  if (
    entry.managementDefault === "enforced" ||
    entry.managementDefault === "hidden"
  )
    out.push({
      code: "user_setting_locked_default",
      at: "user",
      message:
        "user is not allowed on a key whose managementDefault is enforced or hidden.",
    });
  const schema = isPlainObject(entry.schema) ? entry.schema : {};
  // Rule 3: `max`/`min` compare numbers; `merge` merges an object's members.
  if (
    (user.conflict === "max" || user.conflict === "min") &&
    !schemaTypeIn(schema, ["number", "integer"])
  )
    out.push({
      code: "user_conflict_type_mismatch",
      at: "user.conflict",
      message: `user.conflict ${String(user.conflict)} needs a number schema.`,
    });
  if (user.conflict === "merge") {
    if (!schemaTypeIn(schema, ["object"])) {
      out.push({
        code: "user_conflict_type_mismatch",
        at: "user.conflict",
        message: "user.conflict merge needs an object schema.",
      });
    } else {
      if (mergeMembersOverLimit(schema))
        out.push({
          code: "merge_members_over_limit",
          at: "schema",
          message: `A merged value has at most ${CLOUD_SYNC_MAX_MERGE_MEMBERS} top-level members (maxProperties and declared properties).`,
        });
    }
  }
  return out;
}
