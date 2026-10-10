/**
 * Cloud Sync declarations (S-17 §5.3; plans/U-01b.md §3.2): the catalog's `user` blocks and
 * `cloudSync` block in `.pkey/schema` (the data shape of the product's records). A person's
 * quota is the `pkey.cloudSync.bytes` entitlement, so `.pkey/product` carries no `cloudSync`
 * block: the validator refuses one, naming the entitlement.
 *
 * Every code below has a mutation-table entry in `test/schema-parity.test.ts` (AGENTS rule 9),
 * which sweeps this file's source for codes. The shape code (`invalid_cloud_sync`,
 * `invalid_user_setting`) and rules 1 and 4 are expressed by the JSON Schemas too; the rest are
 * cross-references (a flag, a reserved key, a declared key, a schema property), arithmetic
 * (ceilings) or schema-of-a-schema checks, and are validator-only. Rule 2 is a warning.
 *
 * Retired members are refused with no alias and no warning period, each message naming its
 * replacement: `user.sync: device` (use `local`), a collection's `onAttach` (none: the first
 * sign-in is an ordinary sync), `access` other than `owner`, `cloudSync.saves` (a collection with
 * `template: "saves"`), `cloudSync.open`, and `.pkey/product`'s `cloudSync` (`pkey.cloudSync.bytes`).
 *
 * It imports only a type from `./index.js` (which calls it), so there is no runtime cycle.
 */

import {
  CLOUD_SYNC_ACCESS,
  CLOUD_SYNC_CEILINGS,
  CLOUD_SYNC_COLLECTION_PATTERN,
  CLOUD_SYNC_DEFAULTS,
  CLOUD_SYNC_MAX_MERGE_MEMBERS,
  CLOUD_SYNC_SAVE_SLOTS,
  CLOUD_SYNC_TEMPLATE_NAMES,
  CLOUD_SYNC_TEMPLATES,
  SYNC_CONFLICTS,
  userSettingIssues,
  mergeMembersOverLimit,
} from "@polaris-key/catalog";
import type { ValidationMessage } from "./index.js";
import { RESERVED_ENTITLEMENT_KEYS } from "./reservedNames.js";

/** What the Cloud Sync checks need from the rest of the manifest. */
export interface CloudSyncContext {
  /** The schema document's entries (raw), or `null` when there is no usable catalog. */
  entries: readonly unknown[] | null;
  /** The schema document's raw `cloudSync` block (`undefined` when absent). */
  catalogCloudSync: unknown;
  /** `.pkey/product`'s raw `cloudSync` block (`undefined` when absent). Retired: always refused. */
  productCloudSync: unknown;
  /** Whether the catalog's content is validated at all (Config on, as `validateCatalogShape`). */
  catalogChecked: boolean;
  /** Whether the `sync` service is enabled. */
  syncEnabled: boolean;
}

const COLLECTION_RE = new RegExp(CLOUD_SYNC_COLLECTION_PATTERN);

const CATALOG_MEMBERS = new Set(["collections", "migrations"]);
const COLLECTION_MEMBERS = new Set([
  "name",
  "label",
  "template",
  "access",
  "conflict",
  "conflictField",
  "schema",
  "maxRecords",
  "files",
  "requires",
]);
const FILES_MEMBERS = new Set(["maxBytes", "keepRevisions"]);
const MIGRATION_MEMBERS = new Set([
  "toSchemaVersion",
  "rename",
  "mapValues",
  "drop",
]);
/** The system keys a collection's `requires` may name besides the catalog's own flags. */
const SYSTEM_KEYS: ReadonlySet<string> = new Set(
  RESERVED_ENTITLEMENT_KEYS.map((k) => k.key),
);

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
      if (validateUserBlock(errors, warnings, raw, `/entries/${i}/user`)) {
        // An absent `sync` is `user`: only an explicit `local` keeps the key off Cloud Sync.
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
    shape(
      errors,
      "product",
      "/cloudSync",
      "The cloudSync block in .pkey/product is retired. A person's Cloud Sync quota is the pkey.cloudSync.bytes entitlement: set it on a tier, a licence override or an add-on. Collections belong in .pkey/schema's cloudSync block.",
    );
  }
  if (declaresSync && !ctx.syncEnabled) {
    add(
      warnings,
      "product",
      "/modules/sync",
      "cloud_sync_block_without_service",
      "The manifest declares synced settings or a cloudSync block, but the Cloud Sync service is off; settings stay on the device until it is enabled.",
    );
  }
}

// ── The catalog's `user` blocks ──────────────────────────────────────────────────────────────

/** Returns whether the block is well-formed enough to read `sync` from. The rules themselves
 *  live in `@polaris-key/catalog` (`userSettingIssues`), shared with the Worker's catalog publish
 *  and the console's catalog editor; each issue lands in errors or warnings by its `severity`.
 *  The codes below are listed for the rule-9 source sweep: `"invalid_user_setting"`,
 *  `"user_setting_wrong_kind"`, `"user_setting_locked_default"` (a warning),
 *  `"user_conflict_type_mismatch"`, `"user_conflict_union"`, `"merge_members_over_limit"`. */
function validateUserBlock(
  errors: ValidationMessage[],
  warnings: ValidationMessage[],
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
    add(
      issue.severity === "warning" ? warnings : errors,
      "schema",
      where,
      issue.code,
      issue.message,
    );
  }
  return (
    isRecord(entry.user) &&
    !issues.some(
      (i) =>
        i.severity === "error" &&
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
  for (const k of Object.keys(block)) {
    if (CATALOG_MEMBERS.has(k)) continue;
    const at = `${base}/${escapePointer(k)}`;
    if (k === "saves")
      shape(
        errors,
        "schema",
        at,
        'cloudSync.saves is retired: declare a collection with template: "saves" in cloudSync.collections. A save is a record that may carry one file, and its conflict policy is the collection\'s.',
      );
    else if (k === "open")
      shape(
        errors,
        "schema",
        at,
        "cloudSync.open is retired: every collection is declared in cloudSync.collections. Undeclared settings sync as open settings without it.",
      );
    else shape(errors, "schema", at, `${k} is not a member here.`);
  }

  if (block.collections !== undefined) {
    const max = CLOUD_SYNC_DEFAULTS.records.maxCollections;
    if (!Array.isArray(block.collections) || block.collections.length > max) {
      shape(
        errors,
        "schema",
        `${base}/collections`,
        `cloudSync.collections must be a list of at most ${max} collections.`,
      );
    } else {
      validateCollections(
        errors,
        block.collections,
        flags,
        `${base}/collections`,
      );
    }
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
  flags: ReadonlyMap<string, Record<string, unknown>>,
  base: string,
): void {
  const names: { name: string; index: number }[] = [];
  for (const [i, raw] of collections.entries()) {
    const path = `${base}/${i}`;
    if (!isRecord(raw)) {
      shape(errors, "schema", path, "A collection must be an object.");
      continue;
    }
    for (const k of Object.keys(raw)) {
      if (COLLECTION_MEMBERS.has(k)) continue;
      if (k === "onAttach")
        shape(
          errors,
          "schema",
          `${path}/onAttach`,
          "onAttach is retired with no replacement: the first sign-in is an ordinary sync, and records the device made before it are pushed create-only.",
        );
      else
        shape(
          errors,
          "schema",
          `${path}/${escapePointer(k)}`,
          `${k} is not a member here.`,
        );
    }
    if (raw.access !== undefined && !isOneOf(raw.access, CLOUD_SYNC_ACCESS)) {
      shape(
        errors,
        "schema",
        `${path}/access`,
        "A collection's access is owner, the only value (the signed-in person's devices read and write it); omit access. ownerRead, server and public collections are not supported.",
      );
    }
    if (
      raw.label !== undefined &&
      (typeof raw.label !== "string" || raw.label === "")
    ) {
      shape(
        errors,
        "schema",
        `${path}/label`,
        "A collection's label must be a non-empty string.",
      );
    }
    const template =
      raw.template === undefined
        ? undefined
        : isOneOf(raw.template, CLOUD_SYNC_TEMPLATE_NAMES)
          ? raw.template
          : null;
    if (template === null) {
      shape(
        errors,
        "schema",
        `${path}/template`,
        `A collection's template must be one of ${CLOUD_SYNC_TEMPLATE_NAMES.join(", ")}.`,
      );
    }
    const t = template ? CLOUD_SYNC_TEMPLATES[template] : undefined;
    if (raw.conflict !== undefined && !isOneOf(raw.conflict, SYNC_CONFLICTS)) {
      shape(
        errors,
        "schema",
        `${path}/conflict`,
        `A collection's conflict must be one of ${SYNC_CONFLICTS.join(", ")}.`,
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
    if (
      raw.conflictField !== undefined &&
      typeof raw.conflictField !== "string"
    ) {
      shape(
        errors,
        "schema",
        `${path}/conflictField`,
        "A collection's conflictField must name a property of its schema.",
      );
    }
    if (raw.requires !== undefined && typeof raw.requires !== "string") {
      shape(
        errors,
        "schema",
        `${path}/requires`,
        "A collection's requires must name an entitlement.",
      );
    }
    // The effective members: the declaration over its template over the defaults.
    const conflict = isOneOf(raw.conflict, SYNC_CONFLICTS)
      ? raw.conflict
      : (t?.conflict ?? "revision");
    const schema = isRecord(raw.schema) ? raw.schema : (t?.schema ?? {});

    // D7: a saves collection's slots are a platform constant.
    if (raw.maxRecords !== undefined) {
      if (template === "saves") {
        shape(
          errors,
          "schema",
          `${path}/maxRecords`,
          `A saves collection keeps ${CLOUD_SYNC_SAVE_SLOTS} slots per person, a platform constant; remove maxRecords.`,
        );
      } else if (!positiveInteger(raw.maxRecords)) {
        shape(
          errors,
          "schema",
          `${path}/maxRecords`,
          "A collection's maxRecords must be a positive integer.",
        );
      } else {
        // Rule 10.
        ceilingCheck(
          errors,
          raw.maxRecords,
          CLOUD_SYNC_DEFAULTS.records.maxRecords,
          `${path}/maxRecords`,
        );
      }
    }
    if (raw.files !== undefined) {
      const f = raw.files;
      if (
        !isRecord(f) ||
        Object.keys(f).some((k) => !FILES_MEMBERS.has(k)) ||
        (f.maxBytes !== undefined && !nonNegativeInteger(f.maxBytes)) ||
        (f.keepRevisions !== undefined && !nonNegativeInteger(f.keepRevisions))
      ) {
        shape(
          errors,
          "schema",
          `${path}/files`,
          "A collection's files has maxBytes and keepRevisions (non-negative integers).",
        );
      } else {
        // Rule 10.
        ceilingCheck(
          errors,
          f.maxBytes,
          CLOUD_SYNC_CEILINGS.perPerson.fileBytes,
          `${path}/files/maxBytes`,
        );
      }
    }

    // Rule 8: `requires` names a flag the catalog declares, or a system key.
    if (
      typeof raw.requires === "string" &&
      !flags.has(raw.requires) &&
      !SYSTEM_KEYS.has(raw.requires)
    ) {
      add(
        errors,
        "schema",
        `${path}/requires`,
        "cloud_sync_unknown_entitlement",
        `requires names ${raw.requires}, which is neither a flag in the catalog nor a system entitlement.`,
      );
    }

    // max and min compare one number property of the record (D4).
    if (conflict === "max" || conflict === "min") {
      const field =
        typeof raw.conflictField === "string" ? raw.conflictField : undefined;
      const props = isRecord(schema.properties) ? schema.properties : {};
      const prop = field === undefined ? undefined : props[field];
      if (
        raw.conflictField === undefined ||
        (field !== undefined &&
          !(isRecord(prop) && schemaTypeIs(prop, ["number", "integer"])))
      ) {
        add(
          errors,
          "schema",
          `${path}/conflictField`,
          "collection_conflict_field",
          `A ${conflict} collection needs conflictField naming a number property of its schema; the server keeps the record whose field is ${conflict === "max" ? "larger" : "smaller"}.`,
        );
      }
    } else if (raw.conflictField !== undefined) {
      add(
        errors,
        "schema",
        `${path}/conflictField`,
        "collection_conflict_field",
        "conflictField is only for a max or min collection.",
      );
    }

    // Rule 6: a union record is a set, so its schema says so.
    if (
      conflict === "union" &&
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
    if (conflict === "merge") {
      mergeMemberLimit(errors, schema, `${path}/schema`);
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

/** Rule 10: a declared limit above its platform ceiling. */
function ceilingCheck(
  errors: ValidationMessage[],
  value: unknown,
  ceiling: number,
  path: string,
): void {
  if (!nonNegativeInteger(value) || value <= ceiling) return;
  add(
    errors,
    "schema",
    path,
    "cloud_sync_limit_over_ceiling",
    `${path.slice(1).replaceAll("/", ".")} is ${value}, above the platform ceiling of ${ceiling}.`,
  );
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

function positiveInteger(v: unknown): v is number {
  return nonNegativeInteger(v) && v >= 1;
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
