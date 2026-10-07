/**
 * Hosting quotas (HA-10; notes/S-20 §6.10, owner decision 9): how many bytes of Polaris Key's own
 * copies a product holds, and the guard that keeps every write within its quota.
 *
 * ── WHAT IS COUNTED ─────────────────────────────────────────────────────────────────────────
 *
 * Bytes HELD, not bytes stored: the sum of `blob_objects.size` over the DISTINCT storage keys the
 * product holds a ref to, per class. The store is content-addressed and shared, so the same bytes
 * in two slots (`presentation.icon` and `listing.icon`) count once, and bytes another product
 * also holds count for each product that holds them (each earned its ref by proving it has them).
 *
 *   media     `hosted-asset` refs of every slot but a release file: originals and their WebP
 *             sizes (HA-01, HA-03), whichever way they came in (a pull, an upload, a CI push)
 *   release   `hosted-asset` refs of `release-file*` slots and `release-artifact` refs: the
 *             release files HA-08 mirrored
 *
 * Release files a product publishes to R2 itself (CI's `artifact` refs) and pack objects are not
 * hosted copies and count against neither.
 *
 * ── WHERE IT IS ENFORCED ────────────────────────────────────────────────────────────────────
 *
 * Wherever a product gains a ref to bytes: `ingest` (every way in: HA-05's pulls, HA-06's uploads
 * and CI pushes, HA-08's mirror) and `rebuildLadder` (`core/hostedAssets.ts`). Each checks the
 * quota before it stores anything (`usageAfter`, so bytes past the quota are not even put), and
 * the batch that writes the row and the refs carries `quotaGuardSql` on every statement: the
 * whole batch applies only while the product's usage AFTER it is within the quota, so two writes
 * racing cannot both pass. A refused ingest writes no ref and changes no copy: the slot keeps the
 * copy it had (`ingest`'s `fail`), and the image host keeps serving it. Over the release quota,
 * mirroring stops (`services/release/mirror.ts`) and GitHub keeps serving the file.
 *
 * The guard is the same SQL before, during and after the batch it guards: it leaves out every ref
 * the slot being written holds (the batch drops and adds only those) and adds the slot's new keys
 * from a bound list, so each statement of the batch evaluates it to the same answer.
 */

import type { Db, DbParam } from "../db/types.js";
import type { SettingsEnv } from "./platformSettings.js";
import {
  assetSettingsRegistry,
  MEDIA_QUOTA_KEY,
  productAssetSettings,
  RELEASE_QUOTA_KEY,
} from "./assetSettings.js";

/** The two things a quota counts. */
export type QuotaClass = "media" | "release";

/** The ref kind of a mirrored release file's `r2` location (`services/release/mirror.ts`). */
export const RELEASE_ARTIFACT_REF_KIND = "release-artifact";

/** The refs each class counts, as SQL over `blob_refs r` (code constants only). */
const HELD: Record<QuotaClass, string> = {
  media: `(r.ref_kind = 'hosted-asset' AND r.ref_id NOT GLOB 'release-file*')`,
  release: `((r.ref_kind = 'hosted-asset' AND r.ref_id GLOB 'release-file*')
             OR r.ref_kind = '${RELEASE_ARTIFACT_REF_KIND}')`,
};

/** The class a slot's bytes count against. */
export function quotaClassOf(slot: string): QuotaClass {
  return slot === "release-file" || slot.startsWith("release-file:")
    ? "release"
    : "media";
}

/** One storage key a write would hold, with its size. */
export interface QuotaKey {
  key: string;
  size: number;
}

/**
 * SQL: the bytes `product` would hold in `cls` once the slot whose `hosted-asset` ref id is
 * `refId` holds exactly `keys`. Binds `product, refId, keysJson` (`quotaParams`). Each key counts
 * once, whether it is already held, already stored, or new.
 */
export function usageAfterSql(cls: QuotaClass): string {
  return `(SELECT COALESCE(SUM(u.size), 0) FROM (
      SELECT k, MAX(size) AS size FROM (
        SELECT o.storage_key AS k, o.size AS size FROM blob_objects o
         WHERE o.storage_key IN (
           SELECT r.storage_key FROM blob_refs r
            WHERE r.product = ? AND ${HELD[cls]}
              AND NOT (r.ref_kind = 'hosted-asset' AND r.ref_id = ?))
        UNION ALL
        SELECT json_extract(j.value, '$.k'), json_extract(j.value, '$.s') FROM json_each(?) j
      ) GROUP BY k) u)`;
}

/** The parameters `usageAfterSql` binds. */
export function quotaParams(
  product: string,
  refId: string,
  keys: readonly QuotaKey[],
): DbParam[] {
  return [
    product,
    refId,
    JSON.stringify(keys.map((k) => ({ k: k.key, s: k.size }))),
  ];
}

/** A guard for a batch: the usage after it stays within `limit` (see the file comment). */
export function quotaGuardSql(cls: QuotaClass): string {
  return `${usageAfterSql(cls)} <= ?`;
}

/** The bytes `product` would hold in `cls` after the change (see `usageAfterSql`). */
export async function usageAfter(
  db: Db,
  cls: QuotaClass,
  product: string,
  refId: string,
  keys: readonly QuotaKey[],
): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT ${usageAfterSql(cls)} AS n`,
    ...quotaParams(product, refId, keys),
  );
  return row?.n ?? 0;
}

/** What a product holds now, per class. */
export interface AssetUsage {
  media: { bytes: number; files: number };
  release: { bytes: number; files: number };
}

/** `product`'s usage now: bytes and distinct files held, per class. Two indexed reads. */
export async function assetUsage(db: Db, product: string): Promise<AssetUsage> {
  const of = async (cls: QuotaClass) => {
    const row = await db.first<{ bytes: number | null; files: number }>(
      `SELECT COALESCE(SUM(o.size), 0) AS bytes, COUNT(*) AS files FROM blob_objects o
        WHERE o.storage_key IN (SELECT r.storage_key FROM blob_refs r
                                 WHERE r.product = ? AND ${HELD[cls]})`,
      product,
    );
    return { bytes: row?.bytes ?? 0, files: row?.files ?? 0 };
  };
  return { media: await of("media"), release: await of("release") };
}

/**
 * `product`'s quota for `cls` in bytes: its own `assets.quota.*`, else the platform default, else
 * the code default (also for a product that does not exist).
 */
export async function quotaLimit(
  env: SettingsEnv,
  db: Db,
  product: string,
  cls: QuotaClass,
): Promise<number> {
  const s = await productAssetSettings(env, db, product);
  if (s) return cls === "media" ? s.mediaQuota : s.releaseQuota;
  const key = cls === "media" ? MEDIA_QUOTA_KEY : RELEASE_QUOTA_KEY;
  return assetSettingsRegistry().get(key, "product")!.defaultValue as number;
}

/**
 * Would `product` stay within its `cls` quota if the slot `refId` held exactly `keys`? A check
 * before anything is stored; the batch's guard (`quotaGuardSql`) is what decides.
 */
export async function withinQuota(
  db: Db,
  cls: QuotaClass,
  product: string,
  refId: string,
  keys: readonly QuotaKey[],
  limit: number,
): Promise<boolean> {
  return (await usageAfter(db, cls, product, refId, keys)) <= limit;
}

/**
 * Is `product` at or past its `cls` quota now (no room for one byte more)? What the release-file
 * producers ask before they queue anything (`services/release/mirror.ts`): over the quota,
 * mirroring stops and GitHub keeps serving.
 */
export async function quotaFull(
  env: SettingsEnv,
  db: Db,
  product: string,
  cls: QuotaClass,
): Promise<boolean> {
  const limit = await quotaLimit(env, db, product, cls);
  return (await usageAfter(db, cls, product, "", [])) >= limit;
}
