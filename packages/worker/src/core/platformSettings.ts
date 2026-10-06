/**
 * The platform settings store (A-13, notes/S-13 §6): instance-wide runtime values for the few
 * deploy settings that are safe to change from the console without a deploy.
 *
 * `PLATFORM_SETTINGS` below is the ONLY list of editable keys. A `platform_settings` row whose key
 * is not in it is ignored; a row whose value fails the entry's validator is never applied. Nothing
 * that is an origin, the privilege root, the admin identity provider, a security gate, key
 * material, a session length, a rate limit, a retention period or a bucket name may ever be
 * declared here: `test/platformSettings.test.ts` holds a deny-list, and THREAT-MODEL §3 "Platform
 * settings and operations" gives the reason (AT-2: a runtime knob that widens what a session can do
 * turns a time-bounded session compromise into a persistent one).
 *
 * Two precedence modes:
 *
 *   - `runtime` (tunables): a valid D1 row, else a valid `[vars]` value, else the code default.
 *   - `ceiling` (kill switches): `[vars]` = `off` is a HARD off that no D1 row can override (the
 *     deploy-time break-glass that survives a compromised console session). So is any other
 *     string that is neither a recognised value (`on`, `off`) nor `runtime` (`false`, `0`,
 *     `disabled`): an operator who typed one meant "off", and a typo must never read as "the
 *     console may turn it on". Otherwise the same order as `runtime`. The committed `[vars]`
 *     value is `"runtime"`, which is not a value at all: it means "the console decides", and with
 *     no row the code default applies. An unreadable
 *     store resolves a kill switch to its off value (fail safe), and a tunable to `[vars]` or the
 *     default.
 *
 * Every reader goes through `platformSetting` / `platformSettings` with the Worker's raw env and a
 * database: there is no pre-resolved env, so a path that forgets the store cannot see a value the
 * deploy did not allow. Rows are memoised per isolate for 30 s (`SETTINGS_CACHE_MS`), keyed by the
 * D1 binding; the cron handler and the consumer refresh at the start of each invocation, and a
 * console write drops the writing isolate's copy. Other isolates converge within 30 s.
 *
 * Product-less, Core-owned, no outbound call.
 */

import type {
  ReservedDisplayNamesMode,
  ReservedNamesMode,
} from "@polaris-key/manifest";
import type { Db, DbStatement } from "../db/types.js";
import { PLATFORM_SLICE } from "./settings/platform.js";
import type { SettingDef } from "./settings/types.js";

/** How long an isolate trusts its copy of the table (notes/S-13 §6.3: "within 30 seconds"). */
export const SETTINGS_CACHE_MS = 30_000;

export {
  LAZY_DELTA_MAX_BYTES_CEILING,
  LAZY_DELTA_MAX_BYTES_FLOOR,
} from "./settings/platform.js";

export type PlatformSettingKey =
  | "LAZY_DELTAS"
  | "LAZY_DELTA_MAX_BYTES"
  | "BLOB_GC_MODE"
  | "BLOB_GC_GRACE_DAYS"
  | "LICENSING_RESERVED_NAMES"
  | "IDENTITY_RESERVED_DISPLAY_NAMES"
  | "KEYENTRY_REFUSALS";

/** The typed value each setting resolves to. */
export interface PlatformSettingValues {
  LAZY_DELTAS: "on" | "off";
  LAZY_DELTA_MAX_BYTES: number;
  BLOB_GC_MODE: "on" | "off";
  BLOB_GC_GRACE_DAYS: number;
  LICENSING_RESERVED_NAMES: ReservedNamesMode;
  IDENTITY_RESERVED_DISPLAY_NAMES: ReservedDisplayNamesMode;
  KEYENTRY_REFUSALS: "on" | "off";
}

export type Precedence = "runtime" | "ceiling";
/** ADMIN.md §5.2 destructive levels. L2 and above require `{ confirm: "<key>" }` on a write. */
export type ConfirmLevel = "L0" | "L1" | "L2" | "L3";
/** The Worker scripts that read a setting. */
export type SettingScript = "main" | "deltas";

interface BaseDef {
  /** The `platform_settings` row key: the registry entry's alias (`storage.storedAs`). */
  key: PlatformSettingKey;
  /** The settings-registry key this entry is derived from (ST-03), e.g. `deltas.lazy.mode`. */
  registryKey: string;
  area: "background-jobs" | "licensing" | "identity";
  label: string;
  description: string;
  /** The `[vars]` name read as the deploy-time value (the same name as the key today). */
  varName: string;
  scripts: readonly SettingScript[];
  precedence: Precedence;
}

export interface SwitchSettingDef extends BaseDef {
  kind: "switch";
  defaultValue: "on" | "off";
  /** Confirm level for turning it on and for turning it off. */
  confirm: { on: ConfirmLevel; off: ConfirmLevel };
}

export interface IntegerSettingDef extends BaseDef {
  kind: "integer";
  unit: "bytes" | "days";
  defaultValue: number;
  /** Inclusive bounds on a stored (runtime) value. */
  min: number;
  max: number;
  /**
   * Parses the `[vars]` string. Deploy-time values are reviewed in the repo, so this keeps each
   * setting's pre-A-13 parsing rather than the runtime bounds.
   */
  parseVar(raw: string): number | undefined;
  confirm: { raise: ConfirmLevel; lower: ConfirmLevel };
}

/** One of a short, fixed list of string values (a segmented control in the console). */
export interface ChoiceSettingDef extends BaseDef {
  kind: "choice";
  options: readonly { value: string; label: string }[];
  defaultValue: string;
  /** Confirm level for changing TO each value. */
  confirm: Readonly<Record<string, ConfirmLevel>>;
}

export type PlatformSettingDef =
  | SwitchSettingDef
  | IntegerSettingDef
  | ChoiceSettingDef;

function positiveInteger(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Each A-13 key's deploy-time parser. Deploy-time values are reviewed in the repo, so these keep
 * each setting's pre-A-13 parsing rather than the runtime bounds.
 */
const VAR_PARSERS: Record<string, (raw: string) => number | undefined> = {
  LAZY_DELTA_MAX_BYTES: positiveInteger,
  BLOB_GC_GRACE_DAYS: (raw) => {
    const n = Number(raw.trim());
    return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
  },
};

/** Each A-13 choice key's option labels, in the registry's enum order (LX-05). */
const CHOICE_LABELS: Record<string, Readonly<Record<string, string>>> = {
  LICENSING_RESERVED_NAMES: { warn: "Warn", error: "Refuse" },
  IDENTITY_RESERVED_DISPLAY_NAMES: { warn: "Warn", error: "Refuse" },
};

/** The A-13 store's view of one settings-registry entry (`core/settings/platform.ts`). */
function fromRegistry(def: SettingDef): PlatformSettingDef {
  const storedAs =
    def.storage.kind === "scalar" ? def.storage.storedAs : undefined;
  if (
    !storedAs ||
    !def.varName ||
    !def.precedence ||
    (def.area !== "background-jobs" &&
      def.area !== "licensing" &&
      def.area !== "identity")
  )
    throw new Error(`${def.key} is not an A-13 store entry`);
  const base = {
    key: storedAs as PlatformSettingKey,
    registryKey: def.key,
    area: def.area as "background-jobs" | "licensing" | "identity",
    label: def.label,
    description: def.description,
    varName: def.varName,
    scripts: def.readers.some((r) =>
      r.startsWith("services/release/packs/deltas/"),
    )
      ? (["main", "deltas"] as const)
      : (["main"] as const),
    precedence: def.precedence,
  };
  if (def.value.kind === "switch" && "on" in def.confirm)
    return {
      ...base,
      kind: "switch",
      defaultValue: def.defaultValue as "on" | "off",
      confirm: def.confirm,
    };
  if (def.value.kind === "integer" && "up" in def.confirm) {
    const parseVar = VAR_PARSERS[storedAs];
    if (!parseVar) throw new Error(`${storedAs} has no deploy-time parser`);
    return {
      ...base,
      kind: "integer",
      unit: def.value.unit as "bytes" | "days",
      defaultValue: def.defaultValue as number,
      min: def.value.min,
      max: def.value.max,
      parseVar,
      confirm: { raise: def.confirm.up, lower: def.confirm.down },
    };
  }
  if (def.value.kind === "enum" && "up" in def.confirm) {
    const labels = CHOICE_LABELS[storedAs];
    if (!labels) throw new Error(`${storedAs} has no option labels`);
    // An ordered enum: `up` confirms a change toward the last value, `down` toward the first.
    const values = def.value.values;
    const { up, down } = def.confirm;
    return {
      ...base,
      kind: "choice",
      options: values.map((value) => ({
        value,
        label: labels[value] ?? value,
      })),
      defaultValue: def.defaultValue as string,
      confirm: Object.fromEntries(
        values.map((v, i) => [v, i === 0 ? down : up]),
      ),
    };
  }
  throw new Error(`${def.key} has a value kind the A-13 store cannot hold`);
}

/**
 * THE editable list, derived from the settings registry's platform slice (ST-03): every live
 * entry stored in `platform_settings` under an A-13 row key (`storage.storedAs`). Adding an entry
 * is a THREAT-MODEL §9 review trigger, as is moving one from `ceiling` to `runtime`.
 */
export const PLATFORM_SETTINGS: readonly PlatformSettingDef[] =
  PLATFORM_SLICE.filter(
    (d) =>
      !d.pending &&
      d.storage.kind === "scalar" &&
      d.storage.storedAs !== undefined,
  ).map(fromRegistry);

const BY_KEY: ReadonlyMap<string, PlatformSettingDef> = new Map(
  PLATFORM_SETTINGS.map((d) => [d.key, d]),
);

/** The registry entry for `key`, or `undefined` for anything that is not editable. */
export function platformSettingDef(
  key: string,
): PlatformSettingDef | undefined {
  return BY_KEY.get(key);
}

function parseSwitch(raw: string): "on" | "off" | undefined {
  const v = raw.trim().toLowerCase();
  return v === "on" || v === "off" ? v : undefined;
}

function isChoice(def: ChoiceSettingDef, value: unknown): value is string {
  return (
    typeof value === "string" && def.options.some((o) => o.value === value)
  );
}

/** Validates a stored or submitted value against the entry; `undefined` when it is not valid. */
export function validateSettingValue(
  def: PlatformSettingDef,
  value: unknown,
): string | number | undefined {
  if (def.kind === "switch")
    return value === "on" || value === "off" ? value : undefined;
  if (def.kind === "choice") return isChoice(def, value) ? value : undefined;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= def.min &&
    value <= def.max
    ? value
    : undefined;
}

function parseVarValue(
  def: PlatformSettingDef,
  raw: unknown,
): string | number | undefined {
  if (typeof raw !== "string") return undefined;
  if (def.kind === "choice") {
    const v = raw.trim().toLowerCase();
    return isChoice(def, v) ? v : undefined;
  }
  return def.kind === "switch" ? parseSwitch(raw) : def.parseVar(raw);
}

/** The confirm level a change from `before` to `after` needs (ADMIN.md §5.2). */
export function settingConfirmLevel(
  def: PlatformSettingDef,
  before: string | number,
  after: string | number,
): ConfirmLevel {
  if (before === after) return "L0";
  if (def.kind === "switch")
    return after === "on" ? def.confirm.on : def.confirm.off;
  if (def.kind === "choice") return def.confirm[String(after)] ?? "L1";
  return Number(after) > Number(before) ? def.confirm.raise : def.confirm.lower;
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────

/**
 * The `value_json` of a tombstone: what `DELETE` leaves behind so the row's `version` keeps
 * counting up. A reuse of version numbers after a delete would let a stale `expectedVersion` from
 * before the delete pass. `null` is never a valid stored value, so no validator can accept it.
 */
export const TOMBSTONE_JSON = "null";

export interface StoredSetting {
  /** The parsed `value_json` (`undefined` when it is not JSON at all). */
  value: unknown;
  /** A tombstone: the runtime value was removed, only the version survives. */
  deleted?: boolean;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

interface StoreRead {
  /** False when the table could not be read (a D1 error, a database without the migration). */
  ok: boolean;
  rows: ReadonlyMap<string, StoredSetting>;
}

interface CacheEntry {
  at: number;
  read: StoreRead;
}

const cache = new WeakMap<object, CacheEntry>();

/**
 * The cache key: the D1 binding when the env carries one (stable for the isolate's life, while the
 * `Db` wrapper is rebuilt per request), else the `Db` itself (the Node test lane).
 */
function cacheKey(env: SettingsEnv, db: Db): object {
  const binding = env.DB;
  return binding !== null && typeof binding === "object" ? binding : db;
}

/** Anything carrying the `[vars]` (and, in a Worker, the `DB` binding): `Env` or a `Pick` of it. */
export type SettingsEnv = Readonly<Record<string, unknown>>;

async function readStore(db: Db): Promise<StoreRead> {
  try {
    const rows = await db.all<{
      key: string;
      value_json: string;
      version: number;
      updated_at: number;
      updated_by: string;
    }>(
      "SELECT key, value_json, version, updated_at, updated_by FROM platform_settings",
    );
    // Every row, not only A-13's keys: the settings resolver (ST-04, `settings/resolve.ts`) reads
    // the registry's other platform keys (stored under their registry key) through this same
    // 30-second cache. A-13's own readers still look up only the keys `PLATFORM_SETTINGS` lists.
    const out = new Map<string, StoredSetting>();
    for (const r of rows) {
      let value: unknown;
      try {
        value = JSON.parse(r.value_json) as unknown;
      } catch {
        value = undefined;
      }
      out.set(r.key, {
        value,
        deleted: r.value_json === TOMBSTONE_JSON,
        version: r.version,
        updatedAt: r.updated_at,
        updatedBy: r.updated_by,
      });
    }
    return { ok: true, rows: out };
  } catch {
    return { ok: false, rows: new Map() };
  }
}

async function loadStore(
  env: SettingsEnv,
  db: Db,
  opts: { fresh?: boolean } = {},
): Promise<StoreRead> {
  const key = cacheKey(env, db);
  const now = Date.now();
  const hit = cache.get(key);
  if (!opts.fresh && hit && now - hit.at < SETTINGS_CACHE_MS) return hit.read;
  const read = await readStore(db);
  // A failed read is not cached: the next reader tries again.
  if (read.ok) cache.set(key, { at: now, read });
  else cache.delete(key);
  return read;
}

/**
 * Every `platform_settings` row, from this isolate's 30-second copy (ST-04): what the settings
 * resolver reads for any platform-scope key. `ok` is false when the table could not be read.
 */
export async function platformStoreRows(
  env: SettingsEnv,
  db: Db,
  opts: { fresh?: boolean } = {},
): Promise<{ ok: boolean; rows: ReadonlyMap<string, StoredSetting> }> {
  return loadStore(env, db, opts);
}

/** Each A-13 key's deploy-time parser, by `[vars]` name (the resolver keeps A-13's parsing). */
export function deployVarParser(
  varName: string,
): ((raw: string) => number | undefined) | undefined {
  return VAR_PARSERS[varName];
}

/** Re-read the table now (the cron handler and the consumer, at the start of an invocation). */
export async function refreshPlatformSettings(
  env: SettingsEnv,
  db: Db,
): Promise<void> {
  await loadStore(env, db, { fresh: true });
}

/** Drop this isolate's copy (after a console write, so the writer sees its own change). */
export function invalidatePlatformSettings(env: SettingsEnv, db: Db): void {
  cache.delete(cacheKey(env, db));
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────

/** Where an effective value came from. `failsafe`: the store was unreadable, so a kill switch is off. */
export type SettingSource = "runtime" | "deploy" | "default" | "failsafe";

export interface ResolvedSetting {
  key: PlatformSettingKey;
  value: string | number;
  source: SettingSource;
  /** A `ceiling` setting whose `[vars]` value is `off`: no runtime value can turn it on. */
  forcedOff: boolean;
  /** The stored row, if any, and whether its value is applicable. `null` for a tombstone. */
  stored: (StoredSetting & { valid: boolean }) | null;
  /**
   * The `expectedVersion` the next write must carry: the row's version, a tombstone's included,
   * and 0 only when the key never had a row.
   */
  version: number;
  /** The raw `[vars]` string, `null` when unset. Never a secret: no secret is in the registry. */
  deployValue: string | null;
}

/**
 * A ceiling setting's `[vars]` value is a hard off when it is `off`, or a string that is neither a
 * recognised value nor `runtime` (`false`, `0`, `disabled`, a typo). Unset is not an off.
 */
export function isHardOffVar(
  def: PlatformSettingDef,
  varRaw: unknown,
): boolean {
  if (def.precedence !== "ceiling" || typeof varRaw !== "string") return false;
  const parsed = parseVarValue(def, varRaw);
  if (parsed === "off") return true;
  return parsed === undefined && varRaw.trim().toLowerCase() !== "runtime";
}

/** Ceiling settings whose `[vars]` value is an unrecognised string (a hard off), for the inventory. */
export function unrecognisedCeilingVars(env: SettingsEnv): string[] {
  return PLATFORM_SETTINGS.filter((d) => {
    const raw = env[d.varName];
    return (
      isHardOffVar(d, raw) &&
      typeof raw === "string" &&
      parseVarValue(d, raw) === undefined
    );
  }).map((d) => d.varName);
}

/** Resolve one setting from its `[vars]` value and its stored row (pure; exported for tests). */
export function resolveSetting(
  def: PlatformSettingDef,
  varRaw: unknown,
  row: StoredSetting | undefined,
  storeOk: boolean,
): ResolvedSetting {
  const deployValue = typeof varRaw === "string" ? varRaw : null;
  const fromVar = parseVarValue(def, varRaw);
  const version = row?.version ?? 0;
  if (row?.deleted) row = undefined;
  const storedValid =
    row !== undefined && validateSettingValue(def, row.value) !== undefined;
  const stored = row ? { ...row, valid: storedValid } : null;
  const base = { key: def.key, stored, deployValue, version };
  if (isHardOffVar(def, varRaw))
    return { ...base, value: "off", source: "deploy", forcedOff: true };
  if (def.precedence === "ceiling" && !storeOk)
    return { ...base, value: "off", source: "failsafe", forcedOff: false };
  if (row && storedValid)
    return {
      ...base,
      value: row.value as string | number,
      source: "runtime",
      forcedOff: false,
    };
  if (fromVar !== undefined)
    return { ...base, value: fromVar, source: "deploy", forcedOff: false };
  return {
    ...base,
    value: def.defaultValue,
    source: "default",
    forcedOff: false,
  };
}

/** Every registered setting, resolved. */
export async function platformSettings(
  env: SettingsEnv,
  db: Db,
  opts: { fresh?: boolean } = {},
): Promise<Record<PlatformSettingKey, ResolvedSetting>> {
  const read = await loadStore(env, db, opts);
  const out = {} as Record<PlatformSettingKey, ResolvedSetting>;
  for (const def of PLATFORM_SETTINGS)
    out[def.key] = resolveSetting(
      def,
      env[def.varName],
      read.rows.get(def.key),
      read.ok,
    );
  return out;
}

/**
 * One setting's effective value. A `ceiling` setting whose `[vars]` value is `off` answers without
 * touching the database.
 */
export async function platformSetting<K extends PlatformSettingKey>(
  env: SettingsEnv,
  db: Db,
  key: K,
): Promise<PlatformSettingValues[K]> {
  const def = BY_KEY.get(key)!;
  if (isHardOffVar(def, env[def.varName]))
    return "off" as PlatformSettingValues[K];
  const read = await loadStore(env, db);
  return resolveSetting(def, env[def.varName], read.rows.get(key), read.ok)
    .value as PlatformSettingValues[K];
}

// ── Writes (the console, `admin/handlers/platformSettings.ts`) ──────────────────────────────

export type SettingWrite =
  | { ok: true; version: number }
  | { ok: false; currentVersion: number };

async function currentVersion(db: Db, key: string): Promise<number> {
  const row = await db.first<{ version: number }>(
    "SELECT version FROM platform_settings WHERE key = ?",
    key,
  );
  return row?.version ?? 0;
}

/**
 * Run one guarded settings statement and, when given, its audit statement in ONE batch: the audit
 * insert only fires after a change (`changes()`), and if it fails the write rolls back with it.
 * Answers whether the guarded statement changed its row.
 */
async function applyGuarded(
  db: Db,
  guarded: DbStatement,
  audit: DbStatement | undefined,
): Promise<boolean> {
  if (!audit)
    return (await db.runChanges(guarded.sql, ...guarded.params)) === 1;
  if (db.batchChanges)
    return (await db.batchChanges([guarded, audit]))[0] === 1;
  // A database without per-statement counts (a test double): the write, then its audit row.
  const changed = await db.runChanges(guarded.sql, ...guarded.params);
  if (changed === 1) await db.run(audit.sql, ...audit.params);
  return changed === 1;
}

/**
 * Turn an `INSERT ... VALUES (...)` audit statement into one that only inserts when the statement
 * just before it in the batch changed a row (`changes()`).
 */
export function onlyAfterAChange(stmt: DbStatement): DbStatement {
  return {
    sql: stmt.sql.replace(
      /VALUES\s*\(([^)]*)\)\s*$/,
      "SELECT $1 WHERE changes() > 0",
    ),
    params: stmt.params,
  };
}

/**
 * Store `value` for `key` if the row is still at `expectedVersion` (0: no row at all; a tombstone
 * is a row). One conditional statement, so two concurrent writers cannot both succeed; `audit`
 * (an INSERT of the `platform_audit` row) commits or rolls back with it.
 */
export async function writePlatformSetting(
  db: Db,
  key: PlatformSettingKey,
  value: string | number,
  expectedVersion: number,
  now: number,
  by: string,
  audit?: DbStatement,
): Promise<SettingWrite> {
  const json = JSON.stringify(value);
  const guarded: DbStatement =
    expectedVersion === 0
      ? {
          sql: `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
             VALUES (?, ?, 1, ?, ?) ON CONFLICT(key) DO NOTHING`,
          params: [key, json, now, by],
        }
      : {
          sql: `UPDATE platform_settings
              SET value_json = ?, version = version + 1, updated_at = ?, updated_by = ?
            WHERE key = ? AND version = ?`,
          params: [json, now, by, key, expectedVersion],
        };
  if (await applyGuarded(db, guarded, audit && onlyAfterAChange(audit)))
    return { ok: true, version: expectedVersion + 1 };
  return { ok: false, currentVersion: await currentVersion(db, key) };
}

/**
 * Remove `key`'s runtime value if the row is still at `expectedVersion`, reverting to `[vars]` or
 * the default. The row stays as a tombstone (`TOMBSTONE_JSON`) with the version bumped, so the
 * version never goes backwards and an `expectedVersion` from before the delete cannot pass.
 */
export async function deletePlatformSetting(
  db: Db,
  key: PlatformSettingKey,
  expectedVersion: number,
  now: number,
  by: string,
  audit?: DbStatement,
): Promise<SettingWrite> {
  const guarded: DbStatement = {
    sql: `UPDATE platform_settings
             SET value_json = ?, version = version + 1, updated_at = ?, updated_by = ?
           WHERE key = ? AND version = ? AND value_json <> ?`,
    params: [TOMBSTONE_JSON, now, by, key, expectedVersion, TOMBSTONE_JSON],
  };
  if (await applyGuarded(db, guarded, audit && onlyAfterAChange(audit)))
    return { ok: true, version: expectedVersion + 1 };
  return { ok: false, currentVersion: await currentVersion(db, key) };
}
