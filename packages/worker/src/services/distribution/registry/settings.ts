/**
 * The registry feed settings, read per isolate through a 30-second cache (F-02, plans/F-01.md
 * §6.4, §6.6 and §6.7).
 *
 * Three rows decide whether a feed answers at all, and how strictly:
 *   - `dist_registry_policy` (per ecosystem): the platform kill switch;
 *   - `dist_registry_owners` (per product): the operator-owned `packageFeeds` sub-capability;
 *   - `dist_registry_feeds` (per product and ecosystem): the feed's `enabled`, `access_mode`,
 *     namespace and per-ecosystem extensions.
 *
 * F-03 owns those tables and their migration (§6.4, `0058_d_registry.sql`). A database without
 * them (an unapplied migration) still reads each missing table as "no row": every check fails
 * closed, so the host answers the not-found for every feed. Nothing here writes them.
 *
 * THE CACHE (§6.7): settings are held per isolate for `REGISTRY_SETTINGS_TTL_SECONDS`, so a
 * read costs no D1 query in the steady state, and a disabled feed, a turned-off `packageFeeds`
 * or a tightened access mode takes effect everywhere within that window. Because
 * `authorizeFeedRead` runs before the Cache API lookup, that bound holds even for bytes the
 * edge holds for a year. A write on this isolate drops its own entries at once
 * (`forgetRegistrySettings`).
 */

import type { ReleaseAccess } from "@polaris-key/protocol/release";
import { parseJsonObject, type Db } from "../../../core/platform.js";
import { accessModeOf, entitlementOf, isAccessMode } from "../access.js";

/** How long an isolate keeps a settings answer, in seconds. */
export const REGISTRY_SETTINGS_TTL_SECONDS = 30;

/** The most entries one isolate keeps; past it the cache starts over. */
const MAX_ENTRIES = 2_000;

export interface RegistryPolicy {
  readonly ecosystem: string;
  readonly enabled: boolean;
  readonly maxPackageBytesCeiling: number;
}

export interface RegistryOwner {
  readonly product: string;
  readonly enabled: boolean;
}

export interface RegistryFeed {
  readonly product: string;
  readonly ecosystem: string;
  readonly enabled: boolean;
  /** Read fail-closed: a value outside the ladder is `entitled`. */
  readonly accessMode: ReleaseAccess;
  readonly namespace: Readonly<Record<string, unknown>>;
  readonly maxPackageBytes: number;
  readonly ext: Readonly<Record<string, unknown>>;
  readonly version: number;
}

/** The three rows for one (product, ecosystem); `null` = no row. */
export interface RegistrySettings {
  /** The owner's `products.status` (`null` = no row). Absent only from a test fake that does
   *  not model it; the D1 source always sets it, and anything but `active` refuses the read. */
  readonly productStatus?: string | null;
  readonly policy: RegistryPolicy | null;
  readonly owner: RegistryOwner | null;
  readonly feed: RegistryFeed | null;
}

/** Where settings come from. F-02 ships the D1 source; tests pass fakes. */
export interface RegistrySettingsSource {
  settings(product: string, ecosystem: string): Promise<RegistrySettings>;
  /** The delivery access mode of one deliverable (`dist_access`, `access.ts`). */
  accessMode(product: string, deliverableId: string): Promise<ReleaseAccess>;
  /** The delivery gate of one deliverable (`dist_access.entitlement`), read only for an
   *  `entitled` read by a licence-bound token (F-21). Absent from a fake = no gate (refuse). */
  entitlement?(product: string, deliverableId: string): Promise<string | null>;
}

const NONE: RegistrySettings = { policy: null, owner: null, feed: null };

/** Is `err` D1's (or SQLite's) "no such table"? Only that error reads as "no row". */
function missingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

interface FeedRow {
  enabled: number;
  access_mode: string;
  namespace_json: string;
  max_package_bytes: number;
  ext_json: string;
  version: number;
}

/**
 * The D1 source over F-03's tables (plans/F-01.md §6.4 column names). Three point reads on
 * primary keys. A table that does not exist yet reads as no row (fail closed); any other error
 * propagates and becomes the host's JSON 500.
 */
export function d1RegistrySettings(db: Db): RegistrySettingsSource {
  async function read<T>(sql: string, ...params: string[]): Promise<T | null> {
    try {
      return await db.first<T>(sql, ...params);
    } catch (err) {
      if (missingTable(err)) return null;
      throw err;
    }
  }
  return {
    async settings(product, ecosystem) {
      const product_ = await read<{ status: string }>(
        "SELECT COALESCE(status, 'active') AS status FROM products WHERE slug = ?",
        product,
      );
      const policy = await read<{
        enabled: number;
        max_package_bytes_ceiling: number;
      }>(
        "SELECT enabled, max_package_bytes_ceiling FROM dist_registry_policy WHERE ecosystem = ?",
        ecosystem,
      );
      const owner = await read<{ enabled: number }>(
        "SELECT enabled FROM dist_registry_owners WHERE product = ?",
        product,
      );
      const feed = await read<FeedRow>(
        `SELECT enabled, access_mode, namespace_json, max_package_bytes, ext_json, version
           FROM dist_registry_feeds WHERE product = ? AND ecosystem = ?`,
        product,
        ecosystem,
      );
      return {
        productStatus: product_ ? product_.status : null,
        policy: policy && {
          ecosystem,
          enabled: policy.enabled === 1,
          maxPackageBytesCeiling: policy.max_package_bytes_ceiling,
        },
        owner: owner && { product, enabled: owner.enabled === 1 },
        feed: feed && {
          product,
          ecosystem,
          enabled: feed.enabled === 1,
          accessMode: isAccessMode(feed.access_mode)
            ? feed.access_mode
            : "entitled",
          namespace: parseJsonObject(feed.namespace_json) ?? {},
          maxPackageBytes: feed.max_package_bytes,
          ext: parseJsonObject(feed.ext_json) ?? {},
          version: feed.version,
        },
      };
    },
    accessMode: (product, deliverableId) =>
      accessModeOf(db, product, deliverableId),
    entitlement: (product, deliverableId) =>
      entitlementOf(db, product, deliverableId),
  };
}

interface Entry<T> {
  value: T;
  until: number;
}

const settingsCache = new Map<string, Entry<RegistrySettings>>();
const modeCache = new Map<string, Entry<ReleaseAccess>>();
const gateCache = new Map<string, Entry<string | null>>();

function remember<T>(
  map: Map<string, Entry<T>>,
  key: string,
  value: T,
  nowMs: number,
): T {
  if (map.size >= MAX_ENTRIES) map.clear();
  map.set(key, { value, until: nowMs + REGISTRY_SETTINGS_TTL_SECONDS * 1000 });
  return value;
}

function fresh<T>(
  map: Map<string, Entry<T>>,
  key: string,
  nowMs: number,
): T | undefined {
  const hit = map.get(key);
  if (hit === undefined) return undefined;
  if (hit.until > nowMs) return hit.value;
  map.delete(key);
  return undefined;
}

/** One (product, ecosystem)'s settings, from this isolate's cache when it is fresh. */
export async function cachedRegistrySettings(
  source: RegistrySettingsSource,
  product: string,
  ecosystem: string,
  nowMs: number = Date.now(),
): Promise<RegistrySettings> {
  const key = `${product}\u0000${ecosystem}`;
  const hit = fresh(settingsCache, key, nowMs);
  if (hit !== undefined) return hit;
  const value = (await source.settings(product, ecosystem)) ?? NONE;
  return remember(settingsCache, key, value, nowMs);
}

/** One deliverable's access mode, from this isolate's cache when it is fresh. */
export async function cachedAccessMode(
  source: RegistrySettingsSource,
  product: string,
  deliverableId: string,
  nowMs: number = Date.now(),
): Promise<ReleaseAccess> {
  const key = `${product}\u0000${deliverableId}`;
  const hit = fresh(modeCache, key, nowMs);
  if (hit !== undefined) return hit;
  return remember(
    modeCache,
    key,
    await source.accessMode(product, deliverableId),
    nowMs,
  );
}

/** One deliverable's delivery gate flag (`null` = none), from this isolate's cache. */
export async function cachedEntitlement(
  source: RegistrySettingsSource,
  product: string,
  deliverableId: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const key = `${product}\u0000${deliverableId}`;
  const hit = fresh(gateCache, key, nowMs);
  if (hit !== undefined) return hit;
  return remember(
    gateCache,
    key,
    source.entitlement
      ? await source.entitlement(product, deliverableId)
      : null,
    nowMs,
  );
}

/**
 * Drop this isolate's cached settings for `product` (every ecosystem and deliverable), or all
 * of them. A settings write calls it so its own isolate sees the change at once; other isolates
 * follow within the TTL.
 */
export function forgetRegistrySettings(product?: string): void {
  if (product === undefined) {
    settingsCache.clear();
    modeCache.clear();
    gateCache.clear();
    return;
  }
  const prefix = `${product}\u0000`;
  for (const map of [settingsCache, modeCache, gateCache] as Map<
    string,
    unknown
  >[])
    for (const key of [...map.keys()])
      if (key.startsWith(prefix)) map.delete(key);
}
