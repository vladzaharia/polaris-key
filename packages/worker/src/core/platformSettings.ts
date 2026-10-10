/**
 * The platform settings store cache (A-13, notes/S-13 §6): the `platform_settings` rows an isolate
 * holds, shared by every reader and writer of a platform-scope setting.
 *
 * ST-05a: this module holds NO setting definitions, validation, resolution or writes. The one
 * definition list is the settings registry's platform slice (`core/settings/platform.ts`), the one
 * read is `resolvePlatformSetting()` (`core/settings/resolve.ts`, through the typed readers in
 * `core/settings/platformRead.ts`) and the one write is `writeSetting()` (`core/settings/write.ts`).
 * What stays here is the rows themselves and their 30-second per-isolate copy.
 *
 * Rows are memoised per isolate for 30 s (`SETTINGS_CACHE_MS`), keyed by the D1 binding; the cron
 * handler and the consumer refresh at the start of each invocation, and a write drops the writing
 * isolate's copy. Other isolates converge within 30 s. An unreadable table is `ok: false`, which
 * the resolver reads as the fail-safe for a kill switch.
 *
 * Product-less, Core-owned, no outbound call.
 */

import type { Db } from "../db/types.js";

/** How long an isolate trusts its copy of the table (notes/S-13 §6.3: "within 30 seconds"). */
export const SETTINGS_CACHE_MS = 30_000;

export {
  LAZY_DELTA_MAX_BYTES_CEILING,
  LAZY_DELTA_MAX_BYTES_FLOOR,
} from "./settings/platform.js";

/**
 * The `value_json` of a tombstone: what a reset leaves behind so the row's `version` keeps
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
 * Every `platform_settings` row, from this isolate's 30-second copy: what the settings resolver
 * reads for any platform-scope key. `ok` is false when the table could not be read.
 */
export async function platformStoreRows(
  env: SettingsEnv,
  db: Db,
  opts: { fresh?: boolean } = {},
): Promise<{ ok: boolean; rows: ReadonlyMap<string, StoredSetting> }> {
  return loadStore(env, db, opts);
}

/** Re-read the table now (the cron handler and the consumer, at the start of an invocation). */
export async function refreshPlatformSettings(
  env: SettingsEnv,
  db: Db,
): Promise<void> {
  await loadStore(env, db, { fresh: true });
}

/** Drop this isolate's copy (after a write, so the writer sees its own change). */
export function invalidatePlatformSettings(env: SettingsEnv, db: Db): void {
  cache.delete(cacheKey(env, db));
}
