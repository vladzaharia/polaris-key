/**
 * SDK sightings (ST-40, OB-04): which SDKs have made a 2xx request to a product, on which
 * platform, and which route namespaces have answered them. The console's Integration page reads
 * them as its Verified facts.
 *
 * Input is the `X-PKey-SDK`, `-SDK-Version`, `-Platform` and `-Arch` headers every SDK already
 * sends (WIRE-CONTRACT-V4 §5.2): no wire field is added, and an SDK that sends none is simply
 * never seen. Nothing identifying is stored: no IP, device id, licence or user (docs/PRIVACY.md).
 *
 * Writes go through `waitUntil` after the response and are throttled: one write per
 * (product, sdk, platform, arch, namespace) per isolate per `SIGHTING_WRITE_INTERVAL_SECONDS`.
 * Values outside the registry (an unknown SDK id, a platform the wire does not list) record
 * nothing, so an unauthenticated route cannot grow the table: at most 10 SDK ids x 9 platforms
 * x 6 architectures per product.
 */

import {
  ARCH_SPELLINGS,
  HEADER_ARCH,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  PLATFORM_SPELLINGS,
} from "@polaris-key/protocol/core";
import type { Db } from "../../db/types.js";
import {
  normalizeArchHeader,
  normalizePlatformHeader,
  normalizeSdkHeader,
} from "../clientMetadata.js";

/** `conformance/parity/enums.json` `sdkId`: the SDK ids a sighting accepts. */
export const SIGHTING_SDK_IDS: ReadonlySet<string> = new Set([
  "node",
  "react",
  "python",
  "swift",
  "godot",
  "kotlin",
  "node-server",
  "python-server",
  "swift-server",
  "kotlin-server",
]);

/**
 * The `services_ok` bits. Fixed numbers, never derived from the service table's order: they are
 * stored, so adding a service must not move another's bit (a test pins every service to a bit).
 * `commerce` (`/distribution/commerce/*`) and `packs` (`/distribution/packs/*`) are namespaces of
 * Distribution with a bit of their own; `trust` is the trust-manifest fetch, which a server
 * core makes (its `*-server` sighting is the server lane's Verified).
 */
export const SIGHTING_BITS = {
  license: 1,
  config: 2,
  release: 4,
  distribution: 8,
  update: 16,
  identity: 32,
  sync: 64,
  commerce: 128,
  packs: 256,
  trust: 512,
} as const;
export type SightingNamespace = keyof typeof SIGHTING_BITS;

/** One write per key per isolate per this many seconds. */
export const SIGHTING_WRITE_INTERVAL_SECONDS = 300;
/** Rows older than this (by `last_seen`) are pruned. */
export const SIGHTING_RETENTION_SECONDS = 90 * 24 * 60 * 60;

const PLATFORMS: ReadonlySet<string> = new Set(
  Object.values(PLATFORM_SPELLINGS),
);
const ARCHES: ReadonlySet<string> = new Set(Object.values(ARCH_SPELLINGS));

/** The namespace a product route answered in, or null for a route that is no feature's. */
export function sightingNamespace(
  route:
    | { kind: "service"; slug: string; rest: readonly string[] }
    | { kind: "trustManifest" }
    | { kind: string },
): SightingNamespace | null {
  if (route.kind === "trustManifest") return "trust";
  if (route.kind !== "service" || !("slug" in route)) return null;
  if (route.slug === "distribution") {
    if (route.rest[0] === "commerce") return "commerce";
    if (route.rest[0] === "packs") return "packs";
  }
  return Object.prototype.hasOwnProperty.call(SIGHTING_BITS, route.slug)
    ? (route.slug as SightingNamespace)
    : null;
}

export interface SightingKey {
  sdk: string;
  platform: string;
  arch: string;
  version: string | null;
}

/** The sighting a request's headers describe, or null when it carries no known SDK id. */
export function sightingFromHeaders(headers: Headers): SightingKey | null {
  const sdk = normalizeSdkHeader(headers.get(HEADER_SDK_NAME));
  if (sdk === null || !SIGHTING_SDK_IDS.has(sdk)) return null;
  const platform = normalizePlatformHeader(headers.get(HEADER_PLATFORM));
  const arch = normalizeArchHeader(headers.get(HEADER_ARCH));
  const version = headers.get(HEADER_SDK_VERSION);
  return {
    sdk,
    platform: platform !== null && PLATFORMS.has(platform) ? platform : "",
    arch: arch !== null && ARCHES.has(arch) ? arch : "",
    version: version ? version.slice(0, 64) : null,
  };
}

// The isolate's last write per key. Bounded: past the cap it starts over, which only costs an
// early write.
const LAST_WRITE = new Map<string, number>();
const LAST_WRITE_CAP = 4096;

/** Test seam: forget every throttle entry. */
export function resetSightingThrottle(): void {
  LAST_WRITE.clear();
}

/** True when this key is due a write, and records that it is taking it. */
function due(key: string, now: number): boolean {
  const last = LAST_WRITE.get(key);
  if (last !== undefined && now - last < SIGHTING_WRITE_INTERVAL_SECONDS)
    return false;
  if (LAST_WRITE.size >= LAST_WRITE_CAP) LAST_WRITE.clear();
  LAST_WRITE.set(key, now);
  return true;
}

/**
 * Record a 2xx answer, if the request carried a known SDK and this key is due. Returns the
 * promise of the write (the caller hands it to `waitUntil`) or null when nothing is due. A failed
 * write is swallowed and the key retried on the next request.
 */
export function recordSighting(
  db: Db,
  product: string,
  headers: Headers,
  namespace: SightingNamespace | null,
  now: number,
): Promise<void> | null {
  if (namespace === null) return null;
  const s = sightingFromHeaders(headers);
  if (!s) return null;
  const key = `${product}|${s.sdk}|${s.platform}|${s.arch}|${namespace}`;
  if (!due(key, now)) return null;
  return db
    .run(
      `INSERT INTO sdk_sightings
         (product, sdk, platform, arch, first_seen, last_seen, sdk_version, services_ok, last_ok_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (product, sdk, platform, arch) DO UPDATE SET
         last_seen = excluded.last_seen,
         sdk_version = COALESCE(excluded.sdk_version, sdk_sightings.sdk_version),
         services_ok = sdk_sightings.services_ok | excluded.services_ok,
         last_ok_at = excluded.last_ok_at`,
      product,
      s.sdk,
      s.platform,
      s.arch,
      now,
      now,
      s.version,
      SIGHTING_BITS[namespace],
      now,
    )
    .catch(() => {
      LAST_WRITE.delete(key);
    });
}

export interface SightingRow {
  sdk: string;
  platform: string;
  arch: string;
  firstSeenAt: number;
  lastSeenAt: number;
  sdkVersion: string | null;
  servicesOk: number;
  lastOkAt: number | null;
}

/** Every sighting a product holds, most recently seen first. */
export async function listSightings(
  db: Db,
  product: string,
): Promise<SightingRow[]> {
  const rows = await db.all<{
    sdk: string;
    platform: string;
    arch: string;
    first_seen: number;
    last_seen: number;
    sdk_version: string | null;
    services_ok: number;
    last_ok_at: number | null;
  }>(
    `SELECT sdk, platform, arch, first_seen, last_seen, sdk_version, services_ok, last_ok_at
       FROM sdk_sightings WHERE product = ? ORDER BY last_seen DESC, sdk, platform, arch`,
    product,
  );
  return rows.map((r) => ({
    sdk: r.sdk,
    platform: r.platform,
    arch: r.arch,
    firstSeenAt: Number(r.first_seen),
    lastSeenAt: Number(r.last_seen),
    sdkVersion: r.sdk_version,
    servicesOk: Number(r.services_ok),
    lastOkAt: r.last_ok_at === null ? null : Number(r.last_ok_at),
  }));
}

/** Delete up to `limit` of one product's sightings last seen before `cutoff`. */
export async function pruneSightings(
  db: Db,
  product: string,
  cutoff: number,
  limit: number,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM sdk_sightings
      WHERE rowid IN (
        SELECT rowid FROM sdk_sightings WHERE product = ? AND last_seen < ? LIMIT ?
      )`,
    product,
    cutoff,
    limit,
  );
}
