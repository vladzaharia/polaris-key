/// <reference types="@cloudflare/workers-types" />

/**
 * What the object frees from R2, and when (U-10.10; plans/U-10-U-11a-slices.md §2.6, WIRE-CONTRACT-V5
 * §13.8.2): the alarm's collection of expired uploads and dead files, and the two ways an object's
 * files leave R2 with it - an erasure and a merge's delete.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────────────────────────
 *
 *   - The R2 key of an object always comes from a row of this object (`files.object_key`) or from
 *     `fileObjectKey(pin, uploadId)` for a session of its own. Nothing here reads a key from a
 *     request.
 *   - The alarm deletes only what nothing points at: an expired session's object (never a `done`
 *     session's: that object is the file), and the object of a `dead` file whose key no row that is
 *     not dead names. A live file, a kept revision and a parked file are never touched.
 *   - A row goes only after its object did. If R2 fails, the row stays and the alarm tries again
 *     (`GC_RETRY_MS`); a person's quota was given back when the file died, so a stuck delete costs
 *     them nothing, and costs the operator only the stored bytes.
 *   - An erasure shreds the SSE-C keys first (the bytes are unreadable from then on, whatever
 *     happens to R2), then deletes every object the rows name, then sweeps the person's prefix and
 *     the prefix of each subject merged into it (`absorbed_from`): a merge moves rows, not bytes.
 *   - An object an account merge absorbed owns nothing: its files are the survivor's now. Its
 *     delete clears only what does not move (open uploads and dead files), and an erasure of a
 *     merged-away subject touches no R2 object at all.
 */

import type { UploadRow } from "../engine/types.js";
import { fileObjectKey } from "../engine/files.js";
import { discard, FILES_USED, type FileHost } from "./fileOps.js";
import type { DoPin } from "./protocol.js";

/** Expired sessions collected per alarm. */
export const GC_UPLOAD_BATCH = 50;
/** Dead files collected per alarm (one R2 `delete` call). */
export const GC_DEAD_BATCH = 100;
/** Unreferenced, unpinned chunks collected per alarm (one R2 `delete` call). */
export const GC_CHUNK_BATCH = 100;
/** The wait after an alarm that could not finish (R2 failed), ms. */
export const GC_RETRY_MS = 60_000;
/** The wait when there is work and no file store is bound, ms. */
export const GC_NO_STORE_RETRY_MS = 3_600_000;
/** R2 deletes at most this many keys in one call. */
const DELETE_BATCH = 1000;
/** `meta`: subjects earlier merges folded into this object (JSON array). */
export const ABSORBED_FROM = "absorbed_from";

/** The subjects whose R2 prefixes hold files this object owns. */
export function absorbedFrom(host: FileHost): string[] {
  const raw = host.store.getMeta(ABSORBED_FROM);
  if (raw === undefined) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list)
      ? list.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

/** Remembers `subjects` as folded into this object (union, order kept). Needs the schema. */
export function noteAbsorbed(
  host: FileHost,
  subjects: readonly string[],
): void {
  const have = absorbedFrom(host);
  const next = [...have];
  for (const s of subjects) if (!next.includes(s)) next.push(s);
  if (next.length !== have.length)
    host.store.setMeta(ABSORBED_FROM, JSON.stringify(next));
}

/** Deletes keys from R2 in calls of at most 1,000. */
async function deleteKeys(bucket: R2Bucket, keys: readonly string[]) {
  for (let i = 0; i < keys.length; i += DELETE_BATCH)
    await bucket.delete(keys.slice(i, i + DELETE_BATCH));
}

/** Deletes every object under a prefix, a page at a time. */
async function sweepPrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (let cursor: string | undefined; ; ) {
    const page = await bucket.list({
      prefix,
      limit: DELETE_BATCH,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (page.objects.length > 0)
      await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
    cursor = page.cursor;
  }
}

/** Aborts an open multipart upload; one that is gone already is not a failure. */
async function abortMultipart(
  bucket: R2Bucket,
  key: string,
  u: UploadRow,
): Promise<void> {
  if (u.multipartId !== null)
    await bucket
      .resumeMultipartUpload(key, u.multipartId)
      .abort()
      .catch(() => undefined);
}

const inFlight = (u: UploadRow): boolean =>
  u.state === "open" || u.state === "finalizing";

/** What one alarm pass left undone: `retryAt` is when to try again, absent when it finished. */
export interface GcOutcome {
  retryAt?: number;
}

/**
 * The alarm's pass over files: expired sessions, then dead files. Never throws: a failure is a
 * `retryAt`. Without a bound file store it does nothing and asks to be woken in an hour only if
 * there is something it cannot do.
 */
export async function collectFileGarbage(
  host: FileHost,
  pin: DoPin,
  nowMs: number,
): Promise<GcOutcome> {
  try {
    const store = host.store;
    const expired = store.expiredUploads(nowMs, GC_UPLOAD_BATCH);
    const dead = store.filesWithStatus("dead", GC_DEAD_BATCH);
    if (
      expired.length === 0 &&
      dead.length === 0 &&
      !hasCollectableChunks(store)
    )
      return {};
    if (!host.bucket) return { retryAt: nowMs + GC_NO_STORE_RETRY_MS };
    let failed = false;

    // Sessions past their 24 hours: an unfinished one gives back its object and its reservation;
    // a finished one's object is the file's, so only the row goes.
    for (const u of expired) {
      if (inFlight(u) && !(await discard(host, pin, u))) {
        failed = true;
        continue;
      }
      store.transaction(() => store.deleteUpload(u.uploadId));
    }

    // Files nothing points at. An object another live row still names stays.
    if (dead.length > 0) {
      const doomed = [
        ...new Set(
          dead
            .filter((f) => !store.fileKeyInUse(f.objectKey))
            .map((f) => f.objectKey),
        ),
      ];
      try {
        if (doomed.length > 0) await deleteKeys(host.bucket, doomed);
        store.transaction(() => {
          for (const f of dead)
            store.deleteFile(f.collection, f.recordId, f.version);
        });
      } catch {
        failed = true;
      }
    }

    // Chunks no file references and no open upload pins (D-7). Taken after the expired sessions
    // above, whose pins they may have been. An object another row still names stays.
    if (!(await collectChunks(host, host.bucket))) failed = true;
    return failed ? { retryAt: nowMs + GC_RETRY_MS } : {};
  } catch {
    return { retryAt: nowMs + GC_RETRY_MS };
  }
}

/** Whether the collector has a chunk to delete. */
export const hasCollectableChunks = (store: FileHost["store"]): boolean =>
  store.collectableChunks(1).length > 0;

/**
 * Deletes one batch of collectable chunks: the objects first, then the rows, in one go with no
 * interleaving request (the alarm holds the object's concurrency). A row whose object could not be
 * deleted stays, and the alarm tries again. The rows are re-read before they go, so a chunk that
 * gained a reference or a pin meanwhile is kept.
 */
async function collectChunks(
  host: FileHost,
  bucket: R2Bucket,
): Promise<boolean> {
  const store = host.store;
  const batch = store.collectableChunks(GC_CHUNK_BATCH);
  if (batch.length === 0) return true;
  try {
    await deleteKeys(bucket, [...new Set(batch.map((c) => c.objectKey))]);
    store.transaction(() => {
      for (const c of batch) {
        const now = store.getChunk(c.collection, c.chunkId);
        if (
          now &&
          now.refs === 0 &&
          !store.chunkPinned(c.collection, c.chunkId)
        )
          store.deleteChunk(c.collection, c.chunkId);
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether this object has ever held an upload or a file (so its R2 prefix may hold objects). */
function hasFileActivity(host: FileHost): boolean {
  const s = host.store;
  return (
    s.getMeta(FILES_USED) !== undefined ||
    s.getMeta(ABSORBED_FROM) !== undefined ||
    s.allFiles().length > 0 ||
    s.allChunks().length > 0 ||
    s.allUploads().length > 0
  );
}

/**
 * An erasure (a plain `deleteAll`): every object of the person's leaves R2. The SSE-C keys go
 * first, so the bytes are unreadable whatever happens next; then the objects the rows name, then
 * the prefix sweep. `false` when R2 could not finish (the caller keeps the rows and answers a
 * retryable error, so the erasure is repeated). An object merged away owns nothing.
 */
export async function eraseFileObjects(
  host: FileHost,
  pin: DoPin,
): Promise<boolean> {
  host.store.prepare(false);
  if (host.store.getMeta("absorbed_into") !== undefined) return true;
  if (!hasFileActivity(host)) return true;
  const bucket = host.bucket;
  if (!bucket) return false;
  try {
    host.store.transaction(() => {
      for (const [kid] of host.store.allSsecKeys())
        host.store.deleteSsecKey(kid);
    });
    const keys = new Set<string>();
    for (const f of host.store.allFiles()) keys.add(f.objectKey);
    for (const c of host.store.allChunks()) keys.add(c.objectKey);
    for (const u of host.store.allUploads()) {
      const key = fileObjectKey(pin, u.uploadId);
      if (inFlight(u)) await abortMultipart(bucket, key, u);
      keys.add(key);
    }
    await deleteKeys(bucket, [...keys]);
    for (const subject of [pin.subject, ...absorbedFrom(host)])
      await sweepPrefix(bucket, `u/${pin.product}/${subject}/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The delete that ends an absorbed object (an account merge): the survivor holds its live files,
 * revisions and parked files now, so those objects stay. What does not move is cleared: open
 * uploads (their objects and multipart uploads) and dead files. `false` when R2 could not finish.
 */
export async function releaseForMerge(
  host: FileHost,
  pin: DoPin,
): Promise<boolean> {
  host.store.prepare(false);
  const store = host.store;
  const uploads = store.allUploads().filter(inFlight);
  const dead = store.filesWithStatus("dead", Number.MAX_SAFE_INTEGER);
  // A chunk some file references moves to the survivor with that file; the rest does not.
  const loose = store.allChunks().filter((c) => c.refs === 0);
  if (uploads.length === 0 && dead.length === 0 && loose.length === 0)
    return true;
  const bucket = host.bucket;
  if (!bucket) return false;
  try {
    const keys: string[] = [];
    for (const u of uploads) {
      const key = fileObjectKey(pin, u.uploadId);
      await abortMultipart(bucket, key, u);
      keys.push(key);
    }
    for (const f of dead)
      if (!store.fileKeyInUse(f.objectKey)) keys.push(f.objectKey);
    for (const c of loose) keys.push(c.objectKey);
    await deleteKeys(bucket, keys);
    return true;
  } catch {
    return false;
  }
}
