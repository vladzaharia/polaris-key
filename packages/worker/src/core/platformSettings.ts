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
 *     deploy-time break-glass that survives a compromised console session). Otherwise the same
 *     order as `runtime`. The committed `[vars]` value is `"runtime"`, which is not a value at all:
 *     it means "the console decides", and with no row the code default applies. An unreadable
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

import type { Db } from "../db/types.js";

/** How long an isolate trusts its copy of the table (notes/S-13 §6.3: "within 30 seconds"). */
export const SETTINGS_CACHE_MS = 30_000;

/**
 * The lazy-delta consumer's per-side ceiling: 32 MiB, measured (notes/S-08 §4.2) against the
 * consumer's 128 MB isolate. A runtime value may only lower it.
 */
export const LAZY_DELTA_MAX_BYTES_CEILING = 33_554_432;
/** The lowest runtime per-side cap (1 MiB): below it no delta could save `MIN_SAVING_BYTES`. */
export const LAZY_DELTA_MAX_BYTES_FLOOR = 1_048_576;

export type PlatformSettingKey =
  | "LAZY_DELTAS"
  | "LAZY_DELTA_MAX_BYTES"
  | "BLOB_GC_MODE"
  | "BLOB_GC_GRACE_DAYS";

/** The typed value each setting resolves to. */
export interface PlatformSettingValues {
  LAZY_DELTAS: "on" | "off";
  LAZY_DELTA_MAX_BYTES: number;
  BLOB_GC_MODE: "on" | "off";
  BLOB_GC_GRACE_DAYS: number;
}

export type Precedence = "runtime" | "ceiling";
/** ADMIN.md §5.2 destructive levels. L2 and above require `{ confirm: "<key>" }` on a write. */
export type ConfirmLevel = "L0" | "L1" | "L2" | "L3";
/** The Worker scripts that read a setting. */
export type SettingScript = "main" | "deltas";

interface BaseDef {
  key: PlatformSettingKey;
  area: "background-jobs";
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

export type PlatformSettingDef = SwitchSettingDef | IntegerSettingDef;

function positiveInteger(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * THE registry. Adding an entry is a THREAT-MODEL §9 review trigger, as is moving one from
 * `ceiling` to `runtime`.
 */
export const PLATFORM_SETTINGS: readonly PlatformSettingDef[] = [
  {
    key: "LAZY_DELTAS",
    area: "background-jobs",
    kind: "switch",
    label: "Lazy deltas",
    description:
      "Lets products opted in to lazy hot-pair deltas count demand and generate deltas. Off stops the subsystem in both Worker scripts.",
    varName: "LAZY_DELTAS",
    scripts: ["main", "deltas"],
    precedence: "ceiling",
    defaultValue: "off",
    confirm: { on: "L1", off: "L0" },
  },
  {
    key: "LAZY_DELTA_MAX_BYTES",
    area: "background-jobs",
    kind: "integer",
    unit: "bytes",
    label: "Lazy delta size cap",
    description:
      "The largest payload, on either side of a pair, the delta consumer will encode. It can only be lowered below the measured 32 MiB ceiling.",
    varName: "LAZY_DELTA_MAX_BYTES",
    scripts: ["main", "deltas"],
    precedence: "runtime",
    defaultValue: LAZY_DELTA_MAX_BYTES_CEILING,
    min: LAZY_DELTA_MAX_BYTES_FLOOR,
    max: LAZY_DELTA_MAX_BYTES_CEILING,
    parseVar: positiveInteger,
    confirm: { raise: "L1", lower: "L0" },
  },
  {
    key: "BLOB_GC_MODE",
    area: "background-jobs",
    kind: "switch",
    label: "Blob collector",
    description:
      "Runs the nightly collector that deletes blob-store objects nothing has referenced for the grace period. Off only costs storage.",
    varName: "BLOB_GC_MODE",
    scripts: ["main"],
    precedence: "ceiling",
    defaultValue: "on",
    confirm: { on: "L1", off: "L0" },
  },
  {
    key: "BLOB_GC_GRACE_DAYS",
    area: "background-jobs",
    kind: "integer",
    unit: "days",
    label: "Blob collector grace period",
    description:
      "How long an object stays unreferenced before the collector may delete it. The bucket's 180-day age lock still bounds every deletion.",
    varName: "BLOB_GC_GRACE_DAYS",
    scripts: ["main"],
    precedence: "runtime",
    defaultValue: 30,
    min: 1,
    max: 365,
    parseVar: (raw) => {
      const n = Number(raw.trim());
      return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
    },
    confirm: { raise: "L0", lower: "L1" },
  },
];

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

/** Validates a stored or submitted value against the entry; `undefined` when it is not valid. */
export function validateSettingValue(
  def: PlatformSettingDef,
  value: unknown,
): string | number | undefined {
  if (def.kind === "switch")
    return value === "on" || value === "off" ? value : undefined;
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
  return Number(after) > Number(before) ? def.confirm.raise : def.confirm.lower;
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────

export interface StoredSetting {
  /** The parsed `value_json` (`undefined` when it is not JSON at all). */
  value: unknown;
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
    const out = new Map<string, StoredSetting>();
    for (const r of rows) {
      if (!BY_KEY.has(r.key)) continue;
      let value: unknown;
      try {
        value = JSON.parse(r.value_json) as unknown;
      } catch {
        value = undefined;
      }
      out.set(r.key, {
        value,
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
  /** The stored row, if any, and whether its value is applicable. */
  stored: (StoredSetting & { valid: boolean }) | null;
  /** The raw `[vars]` string, `null` when unset. Never a secret: no secret is in the registry. */
  deployValue: string | null;
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
  const storedValid =
    row !== undefined && validateSettingValue(def, row.value) !== undefined;
  const stored = row ? { ...row, valid: storedValid } : null;
  const base = { key: def.key, stored, deployValue };
  if (def.precedence === "ceiling" && fromVar === "off")
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
  if (
    def.precedence === "ceiling" &&
    parseVarValue(def, env[def.varName]) === "off"
  )
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
 * Store `value` for `key` if the row is still at `expectedVersion` (0: no row). One conditional
 * statement, so two concurrent writers cannot both succeed.
 */
export async function writePlatformSetting(
  db: Db,
  key: PlatformSettingKey,
  value: string | number,
  expectedVersion: number,
  now: number,
  by: string,
): Promise<SettingWrite> {
  const json = JSON.stringify(value);
  const changed =
    expectedVersion === 0
      ? await db.runChanges(
          `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
             VALUES (?, ?, 1, ?, ?) ON CONFLICT(key) DO NOTHING`,
          key,
          json,
          now,
          by,
        )
      : await db.runChanges(
          `UPDATE platform_settings
              SET value_json = ?, version = version + 1, updated_at = ?, updated_by = ?
            WHERE key = ? AND version = ?`,
          json,
          now,
          by,
          key,
          expectedVersion,
        );
  if (changed === 1) return { ok: true, version: expectedVersion + 1 };
  return { ok: false, currentVersion: await currentVersion(db, key) };
}

/** Delete `key`'s row if it is still at `expectedVersion`, reverting to `[vars]` or the default. */
export async function deletePlatformSetting(
  db: Db,
  key: PlatformSettingKey,
  expectedVersion: number,
): Promise<SettingWrite> {
  const changed = await db.runChanges(
    "DELETE FROM platform_settings WHERE key = ? AND version = ?",
    key,
    expectedVersion,
  );
  if (changed === 1) return { ok: true, version: 0 };
  return { ok: false, currentVersion: await currentVersion(db, key) };
}
