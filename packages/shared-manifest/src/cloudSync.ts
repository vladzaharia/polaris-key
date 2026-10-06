/**
 * Cloud Sync declarations (S-17 §5.3; plans/U-01.md §3): the catalog's `user` blocks and
 * `cloudSync` block in `.pkey/schema` (the data shape) and `.pkey/product`'s `cloudSync` block
 * (limits and access policy, persisted as settings).
 *
 * Every code below has a mutation-table entry in `test/schema-parity.test.ts` (AGENTS rule 9),
 * which sweeps this file's source for codes. The shape codes (`invalid_user_setting`,
 * `invalid_cloud_sync`) and rules 1, 2 and 4 are expressed by the JSON Schemas too; the rest are
 * cross-references (a tier, a flag, a declared key), arithmetic (ceilings) or schema-of-a-schema
 * checks, and are validator-only.
 *
 * It imports only a type from `./index.js` (which calls it), so there is no runtime cycle.
 */

import {
  CLOUD_SYNC_ACCESS,
  CLOUD_SYNC_CEILINGS,
  CLOUD_SYNC_COLLECTION_PATTERN,
  CLOUD_SYNC_DEFAULTS,
  CLOUD_SYNC_LIMIT_MEMBERS,
  CLOUD_SYNC_MAX_MERGE_MEMBERS,
  CLOUD_SYNC_SAVE_LIMIT_MEMBERS,
  CLOUD_SYNC_TRUST_LEVELS,
  COLLECTION_CONFLICTS,
  COLLECTION_ON_ATTACH,
  SAVE_CONFLICT_POLICIES,
  USER_SETTING_SYNC_SCOPES,
  userSettingIssues,
  mergeMembersOverLimit,
} from "@polaris-key/catalog";
import type { ValidationMessage } from "./index.js";

/** What the Cloud Sync checks need from the rest of the manifest. */
export interface CloudSyncContext {
  /** The schema document's entries (raw), or `null` when there is no usable catalog. */
  entries: readonly unknown[] | null;
  /** The schema document's raw `cloudSync` block (`undefined` when absent). */
  catalogCloudSync: unknown;
  /** `.pkey/product`'s raw `cloudSync` block (`undefined` when absent). */
  productCloudSync: unknown;
  /** Whether the catalog's content is validated at all (Config on, as `validateCatalogShape`). */
  catalogChecked: boolean;
  /** Declared tier ids. */
  tierIds: ReadonlySet<string>;
  /** Whether the `sync` service is enabled. */
  syncEnabled: boolean;
}

const COLLECTION_RE = new RegExp(CLOUD_SYNC_COLLECTION_PATTERN);

const CATALOG_MEMBERS = new Set(["collections", "open", "saves", "migrations"]);
const COLLECTION_MEMBERS = new Set([
  "name",
  "access",
  "conflict",
  "schema",
  "onAttach",
]);
const SAVES_MEMBERS = new Set([
  "conflict",
  "requiresFlag",
  "metadata",
  "thumbnail",
  "format",
]);
const MIGRATION_MEMBERS = new Set([
  "toSchemaVersion",
  "rename",
  "mapValues",
  "drop",
]);
const PRODUCT_MEMBERS = new Set(["limits", "unlicensed", "writes"]);
const LIMIT_MEMBERS = new Set([
  ...CLOUD_SYNC_LIMIT_MEMBERS.map((m) => m.member),
  "saves",
]);
const SAVE_LIMIT_MEMBERS = new Set(
  CLOUD_SYNC_SAVE_LIMIT_MEMBERS.map((m) => m.member),
);
const BY_ENTITLEMENT_MEMBERS = new Set(["totalBytes", "saveSlots"]);

/** Validate every Cloud Sync declaration of one manifest. */
export function validateCloudSync(
  errors: ValidationMessage[],
  warnings: ValidationMessage[],
  ctx: CloudSyncContext,
): void {
  const flags = flagEntries(ctx.entries);
  const keys = declaredKeys(ctx.entries);
  let declaresSync = false;

  if (ctx.catalogChecked && ctx.entries) {
    for (const [i, raw] of ctx.entries.entries()) {
      if (!isRecord(raw) || raw.user === undefined) continue;
      if (validateUserBlock(errors, raw, `/entries/${i}/user`)) {
        if ((raw.user as Record<string, unknown>).sync !== "local")
          declaresSync = true;
      }
    }
  }
  if (ctx.catalogChecked && ctx.catalogCloudSync !== undefined) {
    declaresSync = true;
    validateCatalogBlock(errors, ctx.catalogCloudSync, flags, keys);
  }
  if (ctx.productCloudSync !== undefined) {
    declaresSync = true;
    validateProductBlock(errors, ctx.productCloudSync, ctx.tierIds, flags);
  }
  if (declaresSync && !ctx.syncEnabled) {
    add(
      warnings,
      "product",
      "/modules/sync",
      "cloud_sync_block_without_service",
      "The manifest declares synced user settings or a cloudSync block, but the Cloud Sync service is off; settings stay on the device until it is enabled.",
    );
  }
}

// ── The catalog's `user` blocks ──────────────────────────────────────────────────────────────

/** Returns whether the block is well-formed enough to read `sync` from. The rules themselves
 *  live in `@polaris-key/catalog` (`userSettingIssues`), shared with the Worker's catalog publish
 *  and the console's catalog editor; the codes below are listed for the rule-9 source sweep:
 *  `"invalid_user_setting"`, `"user_setting_wrong_kind"`, `"user_setting_locked_default"`,
 *  `"user_conflict_type_mismatch"`, `"user_conflict_union"`, `"merge_members_over_limit"`. */
function validateUserBlock(
  errors: ValidationMessage[],
  entry: Record<string, unknown>,
  path: string,
): boolean {
  const issues = userSettingIssues(entry);
  for (const issue of issues) {
    const where =
      issue.at === "schema"
        ? path.replace(/\/user$/, "/schema")
        : issue.at === "user"
          ? path
          : `${path}/${issue.at.slice("user.".length)}`;
    add(errors, "schema", where, issue.code, issue.message);
  }
  return (
    isRecord(entry.user) &&
    isOneOf(entry.user.sync, USER_SETTING_SYNC_SCOPES) &&
    !issues.some(
      (i) =>
        i.code === "invalid_user_setting" &&
        i.at !== "user.listed" &&
        i.at !== "user.conflict",
    )
  );
}

/** Rule 5 for collections (the setting side is in `userSettingIssues`). */
function mergeMemberLimit(
  errors: ValidationMessage[],
  schema: Record<string, unknown>,
  path: string,
): void {
  if (mergeMembersOverLimit(schema))
    add(
      errors,
      "schema",
      path,
      "merge_members_over_limit",
      `A merged value has at most ${CLOUD_SYNC_MAX_MERGE_MEMBERS} top-level members (maxProperties and declared properties).`,
    );
}

// ── The catalog's `cloudSync` block ──────────────────────────────────────────────────────────

function validateCatalogBlock(
  errors: ValidationMessage[],
  block: unknown,
  flags: ReadonlyMap<string, Record<string, unknown>>,
  keys: ReadonlySet<string>,
): void {
  const base = "/cloudSync";
  if (!isRecord(block)) {
    shape(errors, "schema", base, "cloudSync must be an object.");
    return;
  }
  unknownMembers(errors, "schema", block, CATALOG_MEMBERS, base);
  if (block.open !== undefined && typeof block.open !== "boolean") {
    shape(
      errors,
      "schema",
      `${base}/open`,
      "cloudSync.open must be a boolean.",
    );
  }

  if (block.collections !== undefined) {
    if (
      !Array.isArray(block.collections) ||
      block.collections.length > CLOUD_SYNC_DEFAULTS.collections.maxDeclared
    ) {
      shape(
        errors,
        "schema",
        `${base}/collections`,
        `cloudSync.collections must be a list of at most ${CLOUD_SYNC_DEFAULTS.collections.maxDeclared} collections.`,
      );
    } else {
      validateCollections(errors, block.collections, `${base}/collections`);
    }
  }

  if (block.saves !== undefined) {
    validateSaves(errors, block.saves, flags, `${base}/saves`);
  }

  if (block.migrations !== undefined) {
    if (!Array.isArray(block.migrations)) {
      shape(
        errors,
        "schema",
        `${base}/migrations`,
        "cloudSync.migrations must be a list.",
      );
    } else {
      for (const [i, m] of block.migrations.entries()) {
        validateMigration(errors, m, keys, `${base}/migrations/${i}`);
      }
    }
  }
}

function validateCollections(
  errors: ValidationMessage[],
  collections: unknown[],
  base: string,
): void {
  const names: { name: string; index: number }[] = [];
  for (const [i, raw] of collections.entries()) {
    const path = `${base}/${i}`;
    if (!isRecord(raw)) {
      shape(errors, "schema", path, "A collection must be an object.");
      continue;
    }
    unknownMembers(errors, "schema", raw, COLLECTION_MEMBERS, path);
    if (!isOneOf(raw.access, CLOUD_SYNC_ACCESS)) {
      shape(
        errors,
        "schema",
        `${path}/access`,
        "A collection's access is required and must be owner, ownerRead or server.",
      );
    }
    if (
      raw.conflict !== undefined &&
      !isOneOf(raw.conflict, COLLECTION_CONFLICTS)
    ) {
      shape(
        errors,
        "schema",
        `${path}/conflict`,
        "A collection's conflict must be revision, lastWrite, merge or union.",
      );
    }
    if (
      raw.onAttach !== undefined &&
      !isOneOf(raw.onAttach, COLLECTION_ON_ATTACH)
    ) {
      shape(
        errors,
        "schema",
        `${path}/onAttach`,
        "A collection's onAttach must be keepCloud, keepLocal, merge or prompt.",
      );
    }
    if (raw.schema !== undefined && !isRecord(raw.schema)) {
      shape(
        errors,
        "schema",
        `${path}/schema`,
        "A collection's schema must be an object.",
      );
    }
    const schema = isRecord(raw.schema) ? raw.schema : {};
    // Rule 6: a union record is a set, so its schema says so.
    if (
      raw.conflict === "union" &&
      !(schemaTypeIs(schema, ["array"]) && schema.uniqueItems === true)
    ) {
      add(
        errors,
        "schema",
        `${path}/schema`,
        "union_collection_schema",
        "A union collection needs a schema of type array with uniqueItems: true.",
      );
    }
    // Rule 5, for collections.
    if (raw.conflict === "merge") {
      mergeMemberLimit(errors, schema, `${path}/schema`);
    }
    // Rule 9: data the device never holds cannot be kept from the device.
    if (raw.access === "server" && raw.onAttach === "keepLocal") {
      add(
        errors,
        "schema",
        `${path}/onAttach`,
        "on_attach_keep_local_forbidden",
        "A server collection is never on a device, so it cannot set onAttach: keepLocal.",
      );
    }
    // Rule 7: unique names, disjoint patterns, the key charset.
    if (typeof raw.name !== "string" || !COLLECTION_RE.test(raw.name)) {
      add(
        errors,
        "schema",
        `${path}/name`,
        "collection_name_conflict",
        "A collection name uses [A-Za-z0-9._:-] (at most 128 characters), optionally ending in .* for a pattern.",
      );
      continue;
    }
    for (const other of names) {
      if (namesOverlap(other.name, raw.name)) {
        add(
          errors,
          "schema",
          `${path}/name`,
          "collection_name_conflict",
          `Collection ${raw.name} overlaps collection ${other.name} (entry ${other.index}).`,
        );
      }
    }
    names.push({ name: raw.name, index: i });
  }
}

/** Two collection names overlap when they are equal or one pattern matches the other. */
function namesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const prefix = (n: string) => (n.endsWith(".*") ? n.slice(0, -1) : null);
  const pa = prefix(a);
  const pb = prefix(b);
  if (pa && b.startsWith(pa)) return true;
  if (pb && a.startsWith(pb)) return true;
  return false;
}

function validateSaves(
  errors: ValidationMessage[],
  saves: unknown,
  flags: ReadonlyMap<string, Record<string, unknown>>,
  path: string,
): void {
  if (!isRecord(saves)) {
    shape(errors, "schema", path, "cloudSync.saves must be an object.");
    return;
  }
  unknownMembers(errors, "schema", saves, SAVES_MEMBERS, path);
  if (
    saves.conflict !== undefined &&
    !isOneOf(saves.conflict, SAVE_CONFLICT_POLICIES)
  ) {
    shape(
      errors,
      "schema",
      `${path}/conflict`,
      "cloudSync.saves.conflict must be prompt, mostRecent, longestPlaytime or highestProgress.",
    );
  }
  if (saves.requiresFlag !== undefined) {
    if (typeof saves.requiresFlag !== "string") {
      shape(
        errors,
        "schema",
        `${path}/requiresFlag`,
        "cloudSync.saves.requiresFlag must name a catalog flag.",
      );
    } else if (!flags.has(saves.requiresFlag)) {
      // Rule 8.
      add(
        errors,
        "schema",
        `${path}/requiresFlag`,
        "cloud_sync_unknown_flag",
        `cloudSync.saves.requiresFlag names ${saves.requiresFlag}, which is not a flag in the catalog.`,
      );
    }
  }
  if (saves.metadata !== undefined) {
    const md = saves.metadata;
    if (
      !isRecord(md) ||
      Object.keys(md).some(
        (k) => !["schema", "playtimeField", "progressField"].includes(k),
      ) ||
      (md.schema !== undefined && !isRecord(md.schema)) ||
      (md.playtimeField !== undefined &&
        typeof md.playtimeField !== "string") ||
      (md.progressField !== undefined && typeof md.progressField !== "string")
    ) {
      shape(
        errors,
        "schema",
        `${path}/metadata`,
        "cloudSync.saves.metadata has schema (an object), playtimeField and progressField (strings).",
      );
    }
  }
  if (saves.thumbnail !== undefined) {
    const t = saves.thumbnail;
    if (
      !isRecord(t) ||
      Object.keys(t).some((k) => k !== "maxBytes") ||
      (t.maxBytes !== undefined && !nonNegativeInteger(t.maxBytes))
    ) {
      shape(
        errors,
        "schema",
        `${path}/thumbnail`,
        "cloudSync.saves.thumbnail has maxBytes (a non-negative integer).",
      );
    }
  }
  if (saves.format !== undefined) {
    const f = saves.format;
    if (
      !isRecord(f) ||
      Object.keys(f).some((k) => k !== "refuseNewer") ||
      (f.refuseNewer !== undefined && typeof f.refuseNewer !== "boolean")
    ) {
      shape(
        errors,
        "schema",
        `${path}/format`,
        "cloudSync.saves.format has refuseNewer (a boolean).",
      );
    }
  }
}

function validateMigration(
  errors: ValidationMessage[],
  m: unknown,
  keys: ReadonlySet<string>,
  path: string,
): void {
  if (!isRecord(m)) {
    shape(errors, "schema", path, "A migration must be an object.");
    return;
  }
  unknownMembers(errors, "schema", m, MIGRATION_MEMBERS, path);
  if (!nonNegativeInteger(m.toSchemaVersion)) {
    shape(
      errors,
      "schema",
      `${path}/toSchemaVersion`,
      "A migration's toSchemaVersion is required and must be a non-negative integer.",
    );
  }
  const rename = m.rename;
  if (
    rename !== undefined &&
    (!isRecord(rename) ||
      Object.values(rename).some((v) => typeof v !== "string"))
  ) {
    shape(
      errors,
      "schema",
      `${path}/rename`,
      "A migration's rename maps old keys to new keys (strings).",
    );
  }
  const mapValues = m.mapValues;
  if (
    mapValues !== undefined &&
    (!isRecord(mapValues) || Object.values(mapValues).some((v) => !isRecord(v)))
  ) {
    shape(
      errors,
      "schema",
      `${path}/mapValues`,
      "A migration's mapValues maps each key to an object of old value to new value.",
    );
  }
  const drop = m.drop;
  if (
    drop !== undefined &&
    (!Array.isArray(drop) || drop.some((v) => typeof v !== "string"))
  ) {
    shape(
      errors,
      "schema",
      `${path}/drop`,
      "A migration's drop is a list of keys.",
    );
  }
  // Rule 11.
  const dropped = new Set(Array.isArray(drop) ? drop : []);
  if (isRecord(rename)) {
    for (const [from, to] of Object.entries(rename)) {
      if (typeof to === "string" && !keys.has(to)) {
        add(
          errors,
          "schema",
          `${path}/rename/${escapePointer(from)}`,
          "invalid_cloud_sync_migration",
          `rename target ${to} is not a key in the catalog.`,
        );
      }
      if (dropped.has(from)) {
        add(
          errors,
          "schema",
          `${path}/rename/${escapePointer(from)}`,
          "invalid_cloud_sync_migration",
          `${from} is both renamed and dropped.`,
        );
      }
    }
  }
}

// ── `.pkey/product`'s `cloudSync` block ──────────────────────────────────────────────────────

function validateProductBlock(
  errors: ValidationMessage[],
  block: unknown,
  tierIds: ReadonlySet<string>,
  flags: ReadonlyMap<string, Record<string, unknown>>,
): void {
  const base = "/cloudSync";
  if (!isRecord(block)) {
    shape(errors, "product", base, "cloudSync must be an object.");
    return;
  }
  unknownMembers(errors, "product", block, PRODUCT_MEMBERS, base);

  let licensed: Record<string, unknown> = {};
  if (block.limits !== undefined) {
    const limits = block.limits;
    if (!isRecord(limits)) {
      shape(
        errors,
        "product",
        `${base}/limits`,
        "cloudSync.limits must be an object.",
      );
    } else {
      licensed = limits;
      const extra = new Set([...LIMIT_MEMBERS, "byTier", "byEntitlement"]);
      limitsBlock(errors, limits, `${base}/limits`, extra);
      if (limits.byTier !== undefined) {
        if (!isRecord(limits.byTier)) {
          shape(
            errors,
            "product",
            `${base}/limits/byTier`,
            "cloudSync.limits.byTier maps tier ids to limits.",
          );
        } else {
          for (const [tier, tierLimits] of Object.entries(limits.byTier)) {
            const path = `${base}/limits/byTier/${escapePointer(tier)}`;
            // Rule 8.
            if (!tierIds.has(tier)) {
              add(
                errors,
                "product",
                path,
                "cloud_sync_unknown_tier",
                `cloudSync.limits.byTier names ${tier}, which is not a declared tier.`,
              );
            }
            if (!isRecord(tierLimits)) {
              shape(
                errors,
                "product",
                path,
                "A tier's limits must be an object.",
              );
            } else {
              limitsBlock(errors, tierLimits, path, LIMIT_MEMBERS);
            }
          }
        }
      }
      if (limits.byEntitlement !== undefined) {
        byEntitlement(
          errors,
          limits.byEntitlement,
          flags,
          `${base}/limits/byEntitlement`,
        );
      }
    }
  }

  if (block.unlicensed !== undefined) {
    const u = block.unlicensed;
    const path = `${base}/unlicensed`;
    if (!isRecord(u)) {
      shape(errors, "product", path, "cloudSync.unlicensed must be an object.");
    } else {
      unknownMembers(errors, "product", u, new Set(["limits", "saves"]), path);
      if (u.saves !== undefined && typeof u.saves !== "boolean") {
        shape(
          errors,
          "product",
          `${path}/saves`,
          "cloudSync.unlicensed.saves must be a boolean.",
        );
      }
      if (u.limits !== undefined) {
        if (!isRecord(u.limits)) {
          shape(
            errors,
            "product",
            `${path}/limits`,
            "cloudSync.unlicensed.limits must be an object.",
          );
        } else {
          limitsBlock(errors, u.limits, `${path}/limits`, LIMIT_MEMBERS);
          unlicensedWithinLicensed(
            errors,
            u.limits,
            licensed,
            `${path}/limits`,
          );
        }
      }
    }
  }

  if (block.writes !== undefined) {
    const w = block.writes;
    const path = `${base}/writes`;
    if (
      !isRecord(w) ||
      Object.keys(w).some((k) => k !== "requireLicense" && k !== "minTrust") ||
      (w.requireLicense !== undefined &&
        typeof w.requireLicense !== "boolean") ||
      (w.minTrust !== undefined &&
        w.minTrust !== null &&
        !isOneOf(w.minTrust, CLOUD_SYNC_TRUST_LEVELS))
    ) {
      shape(
        errors,
        "product",
        path,
        "cloudSync.writes has requireLicense (a boolean) and minTrust (null, basic or attested).",
      );
    }
  }
}

/** Shape-check one limits object and hold every member to the platform ceiling (rule 10). */
function limitsBlock(
  errors: ValidationMessage[],
  limits: Record<string, unknown>,
  path: string,
  allowed: ReadonlySet<string>,
): void {
  unknownMembers(errors, "product", limits, allowed, path);
  for (const { member, ceiling } of CLOUD_SYNC_LIMIT_MEMBERS) {
    ceilingCheck(errors, limits[member], ceiling, `${path}/${member}`);
  }
  if (limits.saves !== undefined) {
    if (!isRecord(limits.saves)) {
      shape(
        errors,
        "product",
        `${path}/saves`,
        "saves limits must be an object.",
      );
      return;
    }
    unknownMembers(
      errors,
      "product",
      limits.saves,
      SAVE_LIMIT_MEMBERS,
      `${path}/saves`,
    );
    for (const { member, ceiling } of CLOUD_SYNC_SAVE_LIMIT_MEMBERS) {
      ceilingCheck(
        errors,
        limits.saves[member],
        ceiling,
        `${path}/saves/${member}`,
      );
    }
  }
}

function ceilingCheck(
  errors: ValidationMessage[],
  value: unknown,
  ceiling: number | null,
  path: string,
): void {
  if (value === undefined) return;
  if (!nonNegativeInteger(value)) {
    shape(errors, "product", path, "A limit must be a non-negative integer.");
    return;
  }
  if (ceiling !== null && value > ceiling) {
    add(
      errors,
      "product",
      path,
      "cloud_sync_limit_over_ceiling",
      `${path.slice(1).replaceAll("/", ".")} is ${value}, above the platform ceiling of ${ceiling}.`,
    );
  }
}

/** Rule 10's second half: an unlicensed person never gets more than a licensed one. */
function unlicensedWithinLicensed(
  errors: ValidationMessage[],
  unlicensed: Record<string, unknown>,
  licensed: Record<string, unknown>,
  path: string,
): void {
  const defaults = CLOUD_SYNC_DEFAULTS.licensed;
  for (const { member } of CLOUD_SYNC_LIMIT_MEMBERS) {
    const own = licensed[member];
    over(
      errors,
      unlicensed[member],
      nonNegativeInteger(own) ? own : defaults[member],
      `${path}/${member}`,
    );
  }
  if (isRecord(unlicensed.saves)) {
    const ls = isRecord(licensed.saves) ? licensed.saves : {};
    for (const { member } of CLOUD_SYNC_SAVE_LIMIT_MEMBERS) {
      const own = ls[member];
      over(
        errors,
        unlicensed.saves[member],
        nonNegativeInteger(own) ? own : defaults.saves[member],
        `${path}/saves/${member}`,
      );
    }
  }
}

function over(
  errors: ValidationMessage[],
  value: unknown,
  licensed: number,
  path: string,
): void {
  if (nonNegativeInteger(value) && value > licensed) {
    add(
      errors,
      "product",
      path,
      "cloud_sync_limit_over_ceiling",
      `${path.slice(1).replaceAll("/", ".")} is ${value}, above the licensed limit of ${licensed}.`,
    );
  }
}

/** `byEntitlement` (S-19 decision 19): each value names a numeric catalog flag combined by max. */
function byEntitlement(
  errors: ValidationMessage[],
  raw: unknown,
  flags: ReadonlyMap<string, Record<string, unknown>>,
  path: string,
): void {
  if (!isRecord(raw)) {
    shape(
      errors,
      "product",
      path,
      "cloudSync.limits.byEntitlement maps totalBytes and saveSlots to flag keys.",
    );
    return;
  }
  unknownMembers(errors, "product", raw, BY_ENTITLEMENT_MEMBERS, path);
  for (const [member, flag] of Object.entries(raw)) {
    if (!BY_ENTITLEMENT_MEMBERS.has(member)) continue;
    const at = `${path}/${member}`;
    if (typeof flag !== "string") {
      shape(
        errors,
        "product",
        at,
        "A byEntitlement value must name a catalog flag.",
      );
      continue;
    }
    const entry = flags.get(flag);
    // Rule 8.
    if (!entry) {
      add(
        errors,
        "product",
        at,
        "cloud_sync_unknown_flag",
        `cloudSync.limits.byEntitlement.${member} names ${flag}, which is not a flag in the catalog.`,
      );
      continue;
    }
    // Rule 8b: a limit is raised by the largest grant, so the flag is a number combined by max
    // (explicitly, or by its type's default rule).
    const schema = isRecord(entry.schema) ? entry.schema : {};
    const combine = entry.combine;
    if (
      !schemaTypeIs(schema, ["number", "integer"]) ||
      (combine !== undefined && combine !== "max")
    ) {
      add(
        errors,
        "product",
        at,
        "cloud_sync_entitlement_not_max",
        `Flag ${flag} must be a number combined by max to raise a Cloud Sync limit.`,
      );
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

function flagEntries(
  entries: readonly unknown[] | null,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const e of entries ?? []) {
    if (isRecord(e) && e.kind === "flag" && typeof e.key === "string")
      out.set(e.key, e);
  }
  return out;
}

function declaredKeys(entries: readonly unknown[] | null): Set<string> {
  const out = new Set<string>();
  for (const e of entries ?? []) {
    if (isRecord(e) && typeof e.key === "string") out.add(e.key);
  }
  return out;
}

/** Whether a schema's `type` is (only) one of `types`. */
function schemaTypeIs(
  schema: Record<string, unknown>,
  types: readonly string[],
): boolean {
  const t = schema.type;
  if (typeof t === "string") return types.includes(t);
  if (Array.isArray(t) && t.length > 0)
    return t.every((v) => typeof v === "string" && types.includes(v));
  return false;
}

function unknownMembers(
  errors: ValidationMessage[],
  file: ValidationMessage["file"],
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      shape(
        errors,
        file,
        `${path}/${escapePointer(k)}`,
        `${k} is not a member here.`,
      );
    }
  }
}

function shape(
  errors: ValidationMessage[],
  file: ValidationMessage["file"],
  path: string,
  message: string,
): void {
  add(errors, file, path, "invalid_cloud_sync", message);
}

function escapePointer(s: string): string {
  return s.replaceAll("~", "~0").replaceAll("/", "~1");
}

function nonNegativeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isOneOf<T extends string>(v: unknown, values: readonly T[]): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function add(
  list: ValidationMessage[],
  file: ValidationMessage["file"],
  path: string,
  code: string,
  message: string,
): void {
  list.push({ file, path, code, message });
}
